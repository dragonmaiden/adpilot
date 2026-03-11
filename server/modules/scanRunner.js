const config = require('../config');
const meta = require('./metaClient');
const imweb = require('./imwebClient');
const OptimizationEngine = require('./optimizer');
const telegram = require('./telegram');
const scanStore = require('./scanStore');
const snapshotRepository = require('./snapshotRepository');
const { validateMetaCampaigns, validateMetaInsights, validateImwebOrders, logValidation } = require('../validation/vendorSchemas');
const cogsClient = require('./cogsClient');
const transforms = require('../transforms/charts');
const { calcROAS } = require('../domain/metrics');
const { getTodayInTimeZone, shiftDate } = require('../domain/time');
const runtimeSettings = require('../runtime/runtimeSettings');

function nowIso() {
  return new Date().toISOString();
}

function pushStep(scanResult, payload) {
  scanResult.steps.push(payload);
}

function pushError(scanResult, step, err) {
  scanResult.errors.push({ step, error: err.message });
}

function markSourceSuccess(sourceKey, attemptedAt, { hasData = false } = {}) {
  scanStore.updateSourceHealth(sourceKey, {
    status: 'connected',
    stale: false,
    hasData: Boolean(hasData),
    lastAttemptAt: attemptedAt,
    lastSuccessAt: nowIso(),
    lastError: null,
  });
}

function markSourceFailure(sourceKey, attemptedAt, err, { hasData = false } = {}) {
  scanStore.updateSourceHealth(sourceKey, {
    status: 'error',
    stale: Boolean(hasData),
    hasData: Boolean(hasData),
    lastAttemptAt: attemptedAt,
    lastError: err.message,
  });
}

async function fetchMetaStructure(scanResult) {
  console.log('[SCHEDULER] Step 1: Fetching Meta Ads campaigns, ad sets, ads...');
  const attemptedAt = nowIso();

  try {
    const [campaigns, adSets, ads] = await Promise.all([
      meta.getCampaigns(),
      meta.getAdSets(),
      meta.getAds(),
    ]);

    const campaignsValidation = validateMetaCampaigns(campaigns);
    logValidation(campaignsValidation, 'Meta campaigns');

    scanStore.patchLatestData({ campaigns, adSets, ads });
    markSourceSuccess('metaStructure', attemptedAt, {
      hasData: campaigns.length > 0 || adSets.length > 0 || ads.length > 0,
    });
    scanStore.saveLatestData();

    pushStep(scanResult, {
      step: 'meta_structure',
      status: 'ok',
      campaigns: campaigns.length,
      adSets: adSets.length,
      ads: ads.length,
      validation: { campaigns: campaignsValidation.valid },
    });
    console.log(`[SCHEDULER]   → ${campaigns.length} campaigns, ${adSets.length} ad sets, ${ads.length} ads`);

    return { ok: true, campaigns, adSets, ads };
  } catch (err) {
    console.error('[SCHEDULER]   ⚠ Meta structure fetch failed:', err.message);
    pushError(scanResult, 'meta_structure', err);
    pushStep(scanResult, { step: 'meta_structure', status: 'failed' });
    const latestData = scanStore.getLatestData();
    markSourceFailure('metaStructure', attemptedAt, err, {
      hasData: (latestData.campaigns || []).length > 0 || (latestData.adSets || []).length > 0 || (latestData.ads || []).length > 0,
    });
    scanStore.saveLatestData();
    return { ok: false };
  }
}

async function fetchMetaInsights(scanResult, since, until) {
  console.log('[SCHEDULER] Step 2: Fetching Meta Ads insights (full history)...');
  const attemptedAt = nowIso();

  try {
    const [campaignInsights, adSetInsights, adInsights] = await Promise.all([
      meta.getAllCampaignInsights(since, until),
      meta.getAllAdSetInsights(since, until),
      meta.getAllAdInsights(since, until),
    ]);

    const campaignInsightsValid = validateMetaInsights(campaignInsights, 'campaign');
    const adSetInsightsValid = validateMetaInsights(adSetInsights, 'adset');
    const adInsightsValid = validateMetaInsights(adInsights, 'ad');
    logValidation(campaignInsightsValid, 'Meta campaign insights');
    logValidation(adSetInsightsValid, 'Meta adset insights');
    logValidation(adInsightsValid, 'Meta ad insights');

    scanStore.patchLatestData({ campaignInsights, adSetInsights, adInsights });
    markSourceSuccess('metaInsights', attemptedAt, {
      hasData: campaignInsights.length > 0 || adSetInsights.length > 0 || adInsights.length > 0,
    });
    scanStore.saveLatestData();

    pushStep(scanResult, {
      step: 'meta_insights',
      status: 'ok',
      period: `${since} to ${until}`,
      campaignRows: campaignInsights.length,
      adSetRows: adSetInsights.length,
      adRows: adInsights.length,
      validation: {
        campaigns: campaignInsightsValid.valid,
        adSets: adSetInsightsValid.valid,
        ads: adInsightsValid.valid,
      },
    });
    console.log(`[SCHEDULER]   → ${campaignInsights.length} campaign, ${adSetInsights.length} ad set, ${adInsights.length} ad insight rows`);

    return { ok: true, campaignInsights, adSetInsights, adInsights };
  } catch (err) {
    console.error('[SCHEDULER]   ⚠ Meta insights fetch failed:', err.message);
    pushError(scanResult, 'meta_insights', err);
    pushStep(scanResult, { step: 'meta_insights', status: 'failed', period: `${since} to ${until}` });
    const latestData = scanStore.getLatestData();
    markSourceFailure('metaInsights', attemptedAt, err, {
      hasData: (latestData.campaignInsights || []).length > 0 || (latestData.adSetInsights || []).length > 0 || (latestData.adInsights || []).length > 0,
    });
    scanStore.saveLatestData();
    return { ok: false };
  }
}

async function fetchImwebOrders(scanResult) {
  console.log('[SCHEDULER] Step 3: Fetching Imweb orders...');
  const attemptedAt = nowIso();

  try {
    const orders = await imweb.getAllOrders();
    const ordersValid = validateImwebOrders(orders);
    logValidation(ordersValid, 'Imweb orders');

    const revenueData = imweb.processOrders(orders);
    scanStore.patchLatestData({ orders, revenueData });
    markSourceSuccess('imweb', attemptedAt, {
      hasData: Boolean(revenueData) || orders.length > 0,
    });
    scanStore.saveLatestData();

    pushStep(scanResult, {
      step: 'imweb_orders',
      status: 'ok',
      totalOrders: orders.length,
      revenue: revenueData.totalRevenue,
      refunded: revenueData.totalRefunded,
      netRevenue: revenueData.netRevenue,
      validation: { orders: ordersValid.valid },
    });
    console.log(`[SCHEDULER]   → ${orders.length} orders, ₩${revenueData.netRevenue.toLocaleString()} net revenue`);

    return { ok: true, orders, revenueData };
  } catch (err) {
    console.error('[SCHEDULER]   ⚠ Imweb fetch failed:', err.message);
    pushError(scanResult, 'imweb_orders', err);
    pushStep(scanResult, { step: 'imweb_orders', status: 'failed' });
    const latestData = scanStore.getLatestData();
    markSourceFailure('imweb', attemptedAt, err, {
      hasData: Boolean(latestData.revenueData) || (latestData.orders || []).length > 0,
    });
    scanStore.saveLatestData();
    return { ok: false };
  }
}

async function fetchCogs(scanResult) {
  console.log('[SCHEDULER] Step 3b: Fetching COGS from Google Sheets...');
  const attemptedAt = nowIso();

  try {
    const cogsData = await cogsClient.fetchAllCOGS();
    scanStore.patchLatestData({ cogsData });
    markSourceSuccess('cogs', attemptedAt, {
      hasData: Boolean(cogsData),
    });
    scanStore.saveLatestData();

    pushStep(scanResult, {
      step: 'cogs_sheets',
      status: 'ok',
      totalCOGS: cogsData.totalCOGS,
      totalShipping: cogsData.totalShipping,
      itemCount: cogsData.itemCount,
      orderCount: cogsData.orderCount,
    });
    console.log(`[SCHEDULER]   → ₩${cogsData.totalCOGS.toLocaleString()} COGS + ₩${cogsData.totalShipping.toLocaleString()} shipping (${cogsData.itemCount} items)`);

    return { ok: true, cogsData };
  } catch (err) {
    console.error('[SCHEDULER]   ⚠ COGS fetch failed:', err.message);
    pushError(scanResult, 'cogs_sheets', err);
    pushStep(scanResult, { step: 'cogs_sheets', status: 'failed' });
    const latestData = scanStore.getLatestData();
    markSourceFailure('cogs', attemptedAt, err, {
      hasData: Boolean(latestData.cogsData),
    });
    scanStore.saveLatestData();
    return { ok: false };
  }
}

async function runScan(manual = false) {
  if (scanStore.getIsScanning()) {
    console.log('[SCHEDULER] Scan already in progress, skipping');
    return { status: 'skipped', reason: 'Scan already in progress' };
  }

  scanStore.setIsScanning(true);
  const scanStart = Date.now();
  const scanId = scanStart;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[SCHEDULER] ${manual ? 'MANUAL' : 'SCHEDULED'} SCAN #${scanId}`);
  console.log(`[SCHEDULER] Started at ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(60)}\n`);

  const scanResult = {
    scanId,
    startTime: new Date().toISOString(),
    endTime: null,
    manual,
    steps: [],
    optimizations: [],
    errors: [],
    stats: {},
    status: 'running',
  };

  const since = config.business.startDate;
  const until = getTodayInTimeZone();

  const sourceStatus = {
    metaStructure: false,
    metaInsights: false,
    imweb: false,
    cogs: false,
  };

  try {
    const metaStructureResult = await fetchMetaStructure(scanResult);
    sourceStatus.metaStructure = metaStructureResult.ok;

    const metaInsightsResult = await fetchMetaInsights(scanResult, since, until);
    sourceStatus.metaInsights = metaInsightsResult.ok;

    const imwebResult = await fetchImwebOrders(scanResult);
    sourceStatus.imweb = imwebResult.ok;

    const cogsResult = await fetchCogs(scanResult);
    sourceStatus.cogs = cogsResult.ok;

    if (sourceStatus.metaStructure && sourceStatus.metaInsights) {
      console.log('[SCHEDULER] Step 4: Running optimization engine...');
      const latestData = scanStore.getLatestData();
      const optimizer = new OptimizationEngine(scanId);
      const optimizations = await optimizer.analyze(
        metaStructureResult.campaigns,
        metaStructureResult.adSets,
        metaStructureResult.ads,
        metaInsightsResult.campaignInsights,
        metaInsightsResult.adSetInsights,
        metaInsightsResult.adInsights,
        latestData.revenueData,
        latestData.sources?.imweb || null
      );

      scanResult.optimizations = optimizations;
      pushStep(scanResult, { step: 'optimizer', status: 'ok', totalOptimizations: optimizations.length });
      console.log(`[SCHEDULER]   → ${optimizations.length} optimizations generated`);

      await telegram.sendScanSummary(scanResult);

      const byType = {};
      const byPriority = {};
      for (const optimization of optimizations) {
        byType[optimization.type] = (byType[optimization.type] || 0) + 1;
        byPriority[optimization.priority] = (byPriority[optimization.priority] || 0) + 1;
      }
      console.log(`[SCHEDULER]   Types: ${JSON.stringify(byType)}`);
      console.log(`[SCHEDULER]   Priority: ${JSON.stringify(byPriority)}`);

      if (runtimeSettings.getRules().autonomousMode) {
        console.log('[SCHEDULER] Step 5: Executing high-priority optimizations...');
        const executed = await optimizer.executeHighPriority();
        pushStep(scanResult, {
          step: 'execution',
          status: 'ok',
          attempted: executed.length,
          succeeded: executed.filter(action => action.executed).length,
          failed: executed.filter(action => !action.executed).length,
        });
        console.log(`[SCHEDULER]   → ${executed.filter(action => action.executed).length} executed, ${executed.filter(action => !action.executed).length} failed`);
      } else {
        console.log('[SCHEDULER] Step 5: Autonomous mode OFF — suggestions only');
        pushStep(scanResult, { step: 'execution', status: 'skipped', note: 'Autonomous mode disabled' });
      }

      scanStore.appendOptimizations(optimizations);
    } else {
      console.log('[SCHEDULER] Step 4: Skipping optimizer — Meta refresh incomplete');
      pushStep(scanResult, {
        step: 'optimizer',
        status: 'skipped',
        note: 'Meta structure and insight refresh are both required before optimization can run',
      });
      pushStep(scanResult, {
        step: 'execution',
        status: 'skipped',
        note: 'Optimizer did not run',
      });
    }

    const latestData = scanStore.getLatestData();
    const anySourceUpdated = Object.values(sourceStatus).some(Boolean);

    if (anySourceUpdated) {
      try {
        snapshotRepository.saveSnapshot(scanId, {
          ...(sourceStatus.metaStructure ? {
            campaigns: latestData.campaigns,
            adSets: latestData.adSets,
            ads: latestData.ads,
          } : {}),
          ...(sourceStatus.metaInsights ? {
            campaignInsights: latestData.campaignInsights,
            adSetInsights: latestData.adSetInsights,
            adInsights: latestData.adInsights,
          } : {}),
          ...(sourceStatus.imweb ? {
            orders: latestData.orders,
            revenueData: latestData.revenueData,
          } : {}),
          ...(sourceStatus.cogs ? {
            cogsData: latestData.cogsData,
          } : {}),
        });
        console.log(`[SCHEDULER]   → Snapshot ${scanId} saved`);
      } catch (err) {
        console.warn('[SCHEDULER]   ⚠ Snapshot save failed:', err.message);
      }
    }

    const dailyMerged = transforms.buildDailyMerged(
      latestData.revenueData?.dailyRevenue,
      latestData.campaignInsights,
      latestData.cogsData?.dailyCOGS
    );
    const trailingSevenDays = dailyMerged.filter(day => day.date >= shiftDate(until, -6));
    const totalSpend7d = trailingSevenDays.reduce((sum, day) => sum + (day.spend || 0), 0);
    const totalPurchases7d = trailingSevenDays.reduce((sum, day) => sum + (day.purchases || 0), 0);
    const totalNetRevenue7d = trailingSevenDays.reduce((sum, day) => sum + (day.netRevenue || 0), 0);
    const avgCPA7d = totalPurchases7d > 0 ? totalSpend7d / totalPurchases7d : null;

    scanResult.stats = {
      totalSpend7d: totalSpend7d.toFixed(2),
      totalPurchases7d,
      avgCPA7d: avgCPA7d != null ? avgCPA7d.toFixed(2) : 'N/A',
      activeCampaigns: (latestData.campaigns || []).filter(campaign => campaign.status === 'ACTIVE').length,
      activeAds: (latestData.ads || []).filter(ad => ad.effective_status === 'ACTIVE').length,
      roas: trailingSevenDays.length > 0 ? calcROAS(totalNetRevenue7d, totalSpend7d).toFixed(2) + 'x' : 'N/A',
    };
    scanResult.sourceHealth = scanStore.getSourceHealth();
  } catch (err) {
    console.error('[SCHEDULER] SCAN FAILED:', err.message);
    pushError(scanResult, 'fatal', err);
  } finally {
    scanResult.endTime = new Date().toISOString();
    scanResult.durationMs = Date.now() - scanStart;

    const completedAt = new Date();
    scanStore.setLastScanTime(completedAt);
    scanStore.setLastScanResult(scanResult);
    scanStore.addScanHistory({
      scanId,
      time: completedAt.toISOString(),
      optimizations: scanResult.optimizations.length,
      errors: scanResult.errors.length,
    });

    scanResult.status = scanResult.errors.length === 0
      ? 'success'
      : scanResult.steps.some(step => step.status === 'ok')
      ? 'partial'
      : 'failed';

    try {
      scanStore.saveLatestArtifacts(scanResult);
    } catch (err) {
      console.warn('[SCHEDULER]   ⚠ Failed to persist latest scan artifacts:', err.message);
    }

    scanStore.setIsScanning(false);
  }

  console.log(`\n[SCHEDULER] Scan complete in ${scanResult.durationMs}ms`);
  console.log(`[SCHEDULER] ${scanResult.optimizations.length} optimizations, ${scanResult.errors.length} errors\n`);

  return scanResult;
}

module.exports = {
  runScan,
};
