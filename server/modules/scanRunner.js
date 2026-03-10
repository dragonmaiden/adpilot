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
  };

  let campaigns = [];
  let adSets = [];
  let ads = [];
  let campaignInsights = [];
  let adSetInsights = [];
  let adInsights = [];

  try {
    console.log('[SCHEDULER] Step 1: Fetching Meta Ads campaigns, ad sets, ads...');
    [campaigns, adSets, ads] = await Promise.all([
      meta.getCampaigns(),
      meta.getAdSets(),
      meta.getAds(),
    ]);

    const campValid = validateMetaCampaigns(campaigns);
    logValidation(campValid, 'Meta campaigns');

    scanStore.patchLatestData({ campaigns, adSets, ads });
    scanResult.steps.push({
      step: 'meta_structure',
      campaigns: campaigns.length,
      adSets: adSets.length,
      ads: ads.length,
      validation: { campaigns: campValid.valid },
    });
    console.log(`[SCHEDULER]   → ${campaigns.length} campaigns, ${adSets.length} ad sets, ${ads.length} ads`);

    console.log('[SCHEDULER] Step 2: Fetching Meta Ads insights (full history)...');
    const since = config.business.startDate;
    const until = getTodayInTimeZone();
    [campaignInsights, adSetInsights, adInsights] = await Promise.all([
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

    scanStore.patchLatestData({
      campaignInsights,
      adSetInsights,
      adInsights,
    });
    scanResult.steps.push({
      step: 'meta_insights',
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

    console.log('[SCHEDULER] Step 3: Fetching Imweb orders...');
    try {
      const orders = await imweb.getAllOrders();
      const ordersValid = validateImwebOrders(orders);
      logValidation(ordersValid, 'Imweb orders');

      const revenueData = imweb.processOrders(orders);
      scanStore.patchLatestData({ orders, revenueData });
      scanResult.steps.push({
        step: 'imweb_orders',
        totalOrders: orders.length,
        revenue: revenueData.totalRevenue,
        refunded: revenueData.totalRefunded,
        netRevenue: revenueData.netRevenue,
        validation: { orders: ordersValid.valid },
      });
      console.log(`[SCHEDULER]   → ${orders.length} orders, ₩${revenueData.netRevenue.toLocaleString()} net revenue`);
    } catch (err) {
      console.error('[SCHEDULER]   ⚠ Imweb fetch failed:', err.message);
      scanResult.errors.push({ step: 'imweb_orders', error: err.message });
    }

    console.log('[SCHEDULER] Step 3b: Fetching COGS from Google Sheets...');
    try {
      const cogsData = await cogsClient.fetchAllCOGS();
      scanStore.patchLatestData({ cogsData });
      scanResult.steps.push({
        step: 'cogs_sheets',
        totalCOGS: cogsData.totalCOGS,
        totalShipping: cogsData.totalShipping,
        itemCount: cogsData.itemCount,
        orderCount: cogsData.orderCount,
      });
      console.log(`[SCHEDULER]   → ₩${cogsData.totalCOGS.toLocaleString()} COGS + ₩${cogsData.totalShipping.toLocaleString()} shipping (${cogsData.itemCount} items)`);
    } catch (err) {
      console.error('[SCHEDULER]   ⚠ COGS fetch failed:', err.message);
      scanResult.errors.push({ step: 'cogs_sheets', error: err.message });
    }

    console.log('[SCHEDULER] Step 4: Running optimization engine...');
    const latestData = scanStore.getLatestData();
    const optimizer = new OptimizationEngine();
    const optimizations = await optimizer.analyze(
      campaigns,
      adSets,
      ads,
      campaignInsights,
      adSetInsights,
      adInsights,
      latestData.revenueData
    );
    scanResult.optimizations = optimizations;
    scanResult.steps.push({ step: 'optimizer', totalOptimizations: optimizations.length });
    console.log(`[SCHEDULER]   → ${optimizations.length} optimizations generated`);

    await telegram.sendScanSummary(scanResult);

    const byType = {};
    const byPriority = {};
    for (const opt of optimizations) {
      byType[opt.type] = (byType[opt.type] || 0) + 1;
      byPriority[opt.priority] = (byPriority[opt.priority] || 0) + 1;
    }
    console.log(`[SCHEDULER]   Types: ${JSON.stringify(byType)}`);
    console.log(`[SCHEDULER]   Priority: ${JSON.stringify(byPriority)}`);

    if (runtimeSettings.getRules().autonomousMode) {
      console.log('[SCHEDULER] Step 5: Executing high-priority optimizations...');
      const executed = await optimizer.executeHighPriority();
      scanResult.steps.push({
        step: 'execution',
        attempted: executed.length,
        succeeded: executed.filter(action => action.executed).length,
        failed: executed.filter(action => !action.executed).length,
      });
      console.log(`[SCHEDULER]   → ${executed.filter(action => action.executed).length} executed, ${executed.filter(action => !action.executed).length} failed`);
    } else {
      console.log('[SCHEDULER] Step 5: Autonomous mode OFF — suggestions only');
      scanResult.steps.push({ step: 'execution', note: 'Autonomous mode disabled' });
    }

    scanStore.appendOptimizations(optimizations);

    try {
      snapshotRepository.saveSnapshot(scanId, {
        campaigns,
        adSets,
        ads,
        campaignInsights,
        adSetInsights,
        adInsights,
        orders: latestData.orders,
        revenueData: latestData.revenueData,
        cogsData: latestData.cogsData,
      });
      console.log(`[SCHEDULER]   → Snapshot ${scanId} saved`);
    } catch (err) {
      console.warn('[SCHEDULER]   ⚠ Snapshot save failed:', err.message);
    }

    const dailyMerged = transforms.buildDailyMerged(
      latestData.revenueData?.dailyRevenue,
      campaignInsights,
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
      activeCampaigns: campaigns.filter(c => c.status === 'ACTIVE').length,
      activeAds: ads.filter(a => a.effective_status === 'ACTIVE').length,
      roas: trailingSevenDays.length > 0 ? calcROAS(totalNetRevenue7d, totalSpend7d).toFixed(2) + 'x' : 'N/A',
    };
  } catch (err) {
    console.error('[SCHEDULER] SCAN FAILED:', err.message);
    scanResult.errors.push({ step: 'fatal', error: err.message });
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
