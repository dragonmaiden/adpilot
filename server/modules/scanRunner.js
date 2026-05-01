const config = require('../config');
const meta = require('./metaClient');
const imweb = require('./imwebClient');
const scanStore = require('./scanStore');
const snapshotRepository = require('./snapshotRepository');
const { validateMetaCampaigns, validateMetaInsights, validateImwebOrders, logValidation } = require('../validation/vendorSchemas');
const cogsClient = require('./cogsClient');
const transforms = require('../transforms/charts');
const { calcROAS } = require('../domain/metrics');
const { getTodayInTimeZone, shiftDate } = require('../domain/time');
const runtimeSettings = require('../runtime/runtimeSettings');
const { buildEconomicsLedger } = require('../services/economicsLedgerService');
const cogsAutofillService = require('../services/cogsAutofillService');
const orderNotificationService = require('../services/orderNotificationService');
const observabilityService = require('../services/observabilityService');
const fxService = require('../services/fxService');
const financialLedgerRepository = require('../db/financialLedgerRepository');
const {
  buildSourceExtractionAudit,
  summarizeImwebOrders,
  summarizeMetaInsights,
  summarizeCogsData,
} = require('../services/sourceExtractionAuditService');

const META_AD_INSIGHTS_LOOKBACK_DAYS = 45;

function nowIso() {
  return new Date().toISOString();
}

function pushStep(scanResult, payload) {
  scanResult.steps.push(payload);
}

function pushError(scanResult, step, err) {
  scanResult.errors.push({ step, error: err.message });
}

function formatCogsAutofillErrorSummary(errors) {
  const counts = new Map();

  for (const entry of Array.isArray(errors) ? errors : []) {
    const message = String(entry?.error || 'unknown error').trim() || 'unknown error';
    counts.set(message, (counts.get(message) || 0) + 1);
  }

  const uniqueErrors = Array.from(counts.entries());
  const visibleErrors = uniqueErrors
    .slice(0, 3)
    .map(([message, count]) => (count > 1 ? `${count}x ${message}` : message));

  if (uniqueErrors.length > visibleErrors.length) {
    visibleErrors.push(`+${uniqueErrors.length - visibleErrors.length} more`);
  }

  return visibleErrors.join(' | ');
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

async function refreshFxRate(scanResult) {
  console.log('[SCHEDULER] Step 3c: Refreshing USD/KRW FX rate...');

  try {
    const fx = await fxService.getLatestUsdToKrwRate();
    const storedFx = {
      ...fx,
      stale: false,
    };
    scanStore.patchLatestData({ fx: storedFx });
    scanStore.saveLatestData();
    pushStep(scanResult, {
      step: 'fx_rate',
      status: 'ok',
      source: storedFx.source,
      rateDate: storedFx.rateDate,
      usdToKrwRate: storedFx.usdToKrwRate,
    });
    console.log(`[SCHEDULER]   → USD/KRW ${storedFx.usdToKrwRate} (${storedFx.rateDate})`);
    return storedFx;
  } catch (err) {
    const latestFx = scanStore.getLatestData().fx;
    const fallbackRate = Number(latestFx?.usdToKrwRate || config.currency.usdToKrw);
    const fallbackFx = {
      base: latestFx?.base || 'USD',
      quote: latestFx?.quote || 'KRW',
      source: latestFx?.source || 'static-config',
      usdToKrwRate: fallbackRate,
      rateDate: latestFx?.rateDate || null,
      fetchedAt: latestFx?.fetchedAt || null,
      stale: true,
      lastError: err.message,
    };
    scanStore.patchLatestData({ fx: fallbackFx });
    scanStore.saveLatestData();
    pushError(scanResult, 'fx_rate', err);
    pushStep(scanResult, {
      step: 'fx_rate',
      status: 'failed',
      usingFallback: true,
      usdToKrwRate: fallbackFx.usdToKrwRate,
    });
    console.warn('[SCHEDULER]   ⚠ FX refresh failed; using fallback USD/KRW rate:', err.message);
    return fallbackFx;
  }
}

function buildScanStats(latestData, until) {
  const usdToKrwRate = Number(latestData?.fx?.usdToKrwRate || config.currency.usdToKrw);
  const dailyMerged = transforms.buildDailyMerged(
    latestData?.revenueData?.dailyRevenue,
    latestData?.campaignInsights,
    latestData?.cogsData?.dailyCOGS,
    { usdToKrwRate }
  );
  const trailingSevenDays = dailyMerged.filter(day => day.date >= shiftDate(until, -6));
  const totalSpend7d = trailingSevenDays.reduce((sum, day) => sum + (day.spend || 0), 0);
  const totalPurchases7d = trailingSevenDays.reduce((sum, day) => sum + (day.purchases || 0), 0);
  const totalNetRevenue7d = trailingSevenDays.reduce((sum, day) => sum + (day.netRevenue || 0), 0);
  const avgCPA7d = totalPurchases7d > 0 ? totalSpend7d / totalPurchases7d : null;

  return {
    totalSpend7d: totalSpend7d.toFixed(2),
    totalPurchases7d,
    avgCPA7d: avgCPA7d != null ? avgCPA7d.toFixed(2) : 'N/A',
    activeCampaigns: (latestData?.campaigns || [])
      .filter(campaign => String(campaign?.status || '').toUpperCase() === 'ACTIVE')
      .length,
    activeAds: (latestData?.ads || [])
      .filter(ad => String(ad?.effective_status || ad?.status || '').toUpperCase() === 'ACTIVE')
      .length,
    roas: trailingSevenDays.length > 0 ? calcROAS(totalNetRevenue7d, totalSpend7d, usdToKrwRate).toFixed(2) + 'x' : 'N/A',
  };
}

function resolveAdInsightsSince(since, until, lookbackDays = META_AD_INSIGHTS_LOOKBACK_DAYS) {
  const rollingSince = shiftDate(until, -(Math.max(lookbackDays, 1) - 1));
  return rollingSince > since ? rollingSince : since;
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
    logValidation(campaignsValidation, 'Meta campaigns', true);

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

    return {
      ok: true,
      campaigns,
      adSets,
      ads,
      validation: campaignsValidation,
      received: {
        campaignRows: campaigns.length,
        adSetRows: adSets.length,
        adRows: ads.length,
      },
      acceptedRows: campaigns.length,
    };
  } catch (err) {
    console.error('[SCHEDULER]   ⚠ Meta structure fetch failed:', err.message);
    pushError(scanResult, 'meta_structure', err);
    pushStep(scanResult, { step: 'meta_structure', status: 'failed' });
    const latestData = scanStore.getLatestData();
    markSourceFailure('metaStructure', attemptedAt, err, {
      hasData: (latestData.campaigns || []).length > 0 || (latestData.adSets || []).length > 0 || (latestData.ads || []).length > 0,
    });
    scanStore.saveLatestData();
    return { ok: false, error: err.message };
  }
}

async function fetchMetaInsights(scanResult, since, until) {
  const adSince = resolveAdInsightsSince(since, until);
  console.log('[SCHEDULER] Step 2: Fetching Meta Ads insights...');
  const attemptedAt = nowIso();

  try {
    const [campaignInsights, adInsights] = await Promise.all([
      meta.getAllCampaignInsights(since, until),
      meta.getAllAdInsights(adSince, until),
    ]);

    const campaignInsightsValid = validateMetaInsights(campaignInsights, 'campaign');
    const adInsightsValid = validateMetaInsights(adInsights, 'ad');
    logValidation(campaignInsightsValid, 'Meta campaign insights', true);
    logValidation(adInsightsValid, 'Meta ad insights', true);

    scanStore.patchLatestData({ campaignInsights, adInsights });
    markSourceSuccess('metaInsights', attemptedAt, {
      hasData: campaignInsights.length > 0 || adInsights.length > 0,
    });
    scanStore.saveLatestData();

    pushStep(scanResult, {
      step: 'meta_insights',
      status: 'ok',
      period: `${since} to ${until}`,
      adPeriod: `${adSince} to ${until}`,
      mode: adSince === since ? 'full_history' : 'ad_recent_window',
      campaignRows: campaignInsights.length,
      adRows: adInsights.length,
      validation: {
        campaigns: campaignInsightsValid.valid,
        ads: adInsightsValid.valid,
      },
    });
    console.log(`[SCHEDULER]   → ${campaignInsights.length} campaign rows (${since} → ${until}) and ${adInsights.length} ad rows (${adSince} → ${until})`);

    return {
      ok: true,
      campaignInsights,
      adInsights,
      adSince,
      validation: {
        valid: campaignInsightsValid.valid && adInsightsValid.valid,
        warnings: [
          ...campaignInsightsValid.warnings,
          ...adInsightsValid.warnings,
        ],
        errors: [
          ...campaignInsightsValid.errors,
          ...adInsightsValid.errors,
        ],
      },
      received: summarizeMetaInsights(campaignInsights, adInsights),
      acceptedRows: campaignInsights.length,
    };
  } catch (err) {
    console.error('[SCHEDULER]   ⚠ Meta insights fetch failed:', err.message);
    pushError(scanResult, 'meta_insights', err);
    pushStep(scanResult, {
      step: 'meta_insights',
      status: 'failed',
      period: `${since} to ${until}`,
      adPeriod: `${adSince} to ${until}`,
      mode: adSince === since ? 'full_history' : 'ad_recent_window',
    });
    const latestData = scanStore.getLatestData();
    markSourceFailure('metaInsights', attemptedAt, err, {
      hasData: (latestData.campaignInsights || []).length > 0 || (latestData.adInsights || []).length > 0,
    });
    scanStore.saveLatestData();
    return { ok: false, error: err.message, adSince };
  }
}

async function fetchImwebOrders(scanResult) {
  console.log('[SCHEDULER] Step 3: Fetching Imweb orders...');
  const attemptedAt = nowIso();

  try {
    const orders = await imweb.getAllOrders();
    const ordersValid = validateImwebOrders(orders);
    logValidation(ordersValid, 'Imweb orders', true);

    const revenueData = imweb.processOrders(orders);
    scanStore.patchLatestData({ orders, revenueData });
    scanStore.saveLastSuccessfulImwebData({ orders, revenueData });
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

    return {
      ok: true,
      orders,
      revenueData,
      validation: ordersValid,
      received: summarizeImwebOrders(orders),
      acceptedRows: orders.length,
    };
  } catch (err) {
    console.error('[SCHEDULER]   ⚠ Imweb fetch failed:', err.message);
    pushError(scanResult, 'imweb_orders', err);
    pushStep(scanResult, { step: 'imweb_orders', status: 'failed' });
    const latestData = scanStore.getLatestData();
    markSourceFailure('imweb', attemptedAt, err, {
      hasData: Boolean(latestData.revenueData) || (latestData.orders || []).length > 0,
    });
    scanStore.saveLatestData();
    return { ok: false, error: err.message };
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

    return {
      ok: true,
      cogsData,
      validation: cogsData.validation || null,
      received: summarizeCogsData(cogsData),
      acceptedRows: Array.isArray(cogsData.orders) ? cogsData.orders.length : 0,
    };
  } catch (err) {
    console.error('[SCHEDULER]   ⚠ COGS fetch failed:', err.message);
    pushError(scanResult, 'cogs_sheets', err);
    pushStep(scanResult, { step: 'cogs_sheets', status: 'failed' });
    const latestData = scanStore.getLatestData();
    markSourceFailure('cogs', attemptedAt, err, {
      hasData: Boolean(latestData.cogsData),
    });
    scanStore.saveLatestData();
    return { ok: false, error: err.message };
  }
}

function resolveRecentImwebWindowStart(previousScanTime) {
  const intervalMinutes = runtimeSettings.getSchedulerSettings().scanIntervalMinutes;
  const graceMinutes = 10;
  const fallbackWindowStart = new Date(Date.now() - (Math.max(intervalMinutes * 2, intervalMinutes + 15) * 60 * 1000));

  // Use the last successful Imweb fetch rather than the last scan time.
  // If Imweb was down for hours, the scan timer keeps advancing but no
  // orders were fetched. On recovery the window must reach back to the
  // last time we actually got good data, otherwise orders placed during
  // the outage are permanently missed.
  const imwebHealth = scanStore.getSourceHealth().imweb || {};
  const lastImwebSuccess = imwebHealth.lastSuccessAt
    ? new Date(imwebHealth.lastSuccessAt)
    : null;

  const anchor = lastImwebSuccess && !Number.isNaN(lastImwebSuccess.getTime())
    ? lastImwebSuccess
    : previousScanTime;

  if (!anchor) {
    return fallbackWindowStart;
  }

  return new Date(Math.max(
    anchor.getTime() - (graceMinutes * 60 * 1000),
    fallbackWindowStart.getTime()
  ));
}

async function backfillRecentNewOrderNotifications(scanResult, orders) {
  console.log('[SCHEDULER] Step 3a: Backfilling missed new-order Telegram alerts...');

  try {
    const scanWindowStart = resolveRecentImwebWindowStart(scanStore.getLastScanTime());
    const result = await cogsAutofillService.collectRecentNewOrderNotifications(orders, {
      sinceTime: scanWindowStart,
    });

    let deliveredAlerts = 0;
    let failedAlerts = 0;

    for (const pending of result.pending) {
      const delivery = await orderNotificationService.deliverNewOrderNotification(pending);
      if (delivery?.publicMessage?.ok) {
        deliveredAlerts += 1;
      } else {
        failedAlerts += 1;
        pushError(scanResult, 'new_order_notification_backstop', new Error(`Failed to deliver new-order alert for ${pending.orderNo || 'unknown order'}`));
      }
    }

    pushStep(scanResult, {
      step: 'new_order_notification_backstop',
      status: failedAlerts > 0 && deliveredAlerts === 0 && result.pending.length > 0 ? 'failed' : 'ok',
      windowStartAt: result.windowStartAt,
      eligibleOrders: result.eligibleOrders,
      deliveredAlerts,
      failedAlerts,
    });
    console.log(
      `[SCHEDULER]   → ${deliveredAlerts} backfilled alert${deliveredAlerts === 1 ? '' : 's'}, `
      + `${failedAlerts} failed `
      + `(${result.eligibleOrders} candidate order${result.eligibleOrders === 1 ? '' : 's'} checked since ${result.windowStartAt || 'startup'})`
    );

    return { ok: failedAlerts === 0, result };
  } catch (err) {
    console.error('[SCHEDULER]   ⚠ New-order alert backfill failed:', err.message);
    pushError(scanResult, 'new_order_notification_backstop', err);
    pushStep(scanResult, { step: 'new_order_notification_backstop', status: 'failed' });
    return { ok: false, result: null };
  }
}

async function reconcileClosedOrderNotifications(scanResult, orders) {
  console.log('[SCHEDULER] Step 3b: Reconciling closed Imweb order alerts...');

  try {
    const result = await cogsAutofillService.collectRecentClosedOrderNotifications(orders);
    let updatedAlerts = 0;
    let skippedWithoutEdit = 0;
    let failedAlerts = 0;

    for (const pending of result.pending) {
      const delivery = await orderNotificationService.deliverClosedOrderNotification(pending);
      if (delivery?.updated) {
        updatedAlerts += 1;
      } else if (delivery?.reason === 'marked_closed_without_message' || delivery?.reason === 'already_closed' || delivery?.reason === 'already_completed') {
        skippedWithoutEdit += 1;
      } else if (delivery?.reason) {
        failedAlerts += 1;
        pushError(scanResult, 'closed_order_notification_reconcile', new Error(`Failed to reconcile closed-order alert for ${pending.orderNo || 'unknown order'} (${delivery.reason})`));
      }
    }

    pushStep(scanResult, {
      step: 'closed_order_notification_reconcile',
      status: failedAlerts > 0 && updatedAlerts === 0 && result.pending.length > 0 ? 'failed' : 'ok',
      eligibleOrders: result.eligibleOrders,
      updatedAlerts,
      skippedWithoutEdit,
      failedAlerts,
    });
    console.log(
      `[SCHEDULER]   → ${updatedAlerts} closed alert${updatedAlerts === 1 ? '' : 's'} updated, `
      + `${skippedWithoutEdit} skipped without edit${skippedWithoutEdit === 1 ? '' : 's'}, `
      + `${failedAlerts} failed`
    );

    return { ok: failedAlerts === 0, result };
  } catch (err) {
    console.error('[SCHEDULER]   ⚠ Closed-order alert reconcile failed:', err.message);
    pushError(scanResult, 'closed_order_notification_reconcile', err);
    pushStep(scanResult, { step: 'closed_order_notification_reconcile', status: 'failed' });
    return { ok: false, result: null };
  }
}

async function reconcileRecentImwebOrdersToCogs(scanResult, freshOrders) {
  // Resolve order data: prefer live Imweb orders, fall back to last
  // successful backup so COGS autofill keeps running during Imweb outages.
  let orders = Array.isArray(freshOrders) && freshOrders.length > 0 ? freshOrders : null;
  let orderSource = 'live';

  if (!orders) {
    const backup = scanStore.loadLastSuccessfulImwebBackup();
    if (backup.orders.length > 0) {
      orders = backup.orders;
      orderSource = 'backup';
      console.log(
        `[SCHEDULER]   ℹ Imweb unavailable — using backup order data`
        + ` (${backup.orders.length} orders from ${backup.timestamp || 'unknown'})`
      );
    }
  }

  if (!orders || orders.length === 0) {
    pushStep(scanResult, {
      step: 'cogs_autofill',
      status: 'skipped',
      reason: 'no_orders',
    });
    console.log('[SCHEDULER]   → COGS autofill skipped: no order data available (Imweb down, no backup)');
    return { ok: false, skipped: true, result: null };
  }

  console.log(`[SCHEDULER] Step 3c: Reconciling recent paid Imweb orders into the COGS sheet (${orderSource} data)...`);

  if (!cogsAutofillService.isConfigured()) {
    pushStep(scanResult, {
      step: 'cogs_autofill',
      status: 'skipped',
      reason: 'disabled',
    });
    console.log('[SCHEDULER]   → skipped (COGS autofill is not configured)');
    return { ok: false, skipped: true, result: null };
  }

  try {
    // Let the autofill service use its own default lookback window (7 days).
    // The previous narrow scan-interval window (≈25 min) silently missed
    // orders placed during Imweb outages, because the window cap was tighter
    // than the outage duration.  The autofill service already deduplicates
    // against the sheet, so a wider window costs only cheap in-memory checks.
    const result = await cogsAutofillService.syncRecentOrdersToCogs(orders);

    pushStep(scanResult, {
      step: 'cogs_autofill',
      status: 'ok',
      orderSource,
      windowStartAt: result.windowStartAt,
      eligibleOrders: result.eligibleOrders,
      appendedOrders: result.appended.length,
      duplicateOrders: result.duplicates.length,
      skippedOrders: result.skipped.length,
      failedOrders: result.errors.length,
    });
    console.log(
      `[SCHEDULER]   → ${result.appended.length} appended, `
      + `${result.duplicates.length} duplicates, `
      + `${result.skipped.length} skipped, `
      + `${result.errors.length} failed `
      + `(${result.eligibleOrders} paid order${result.eligibleOrders === 1 ? '' : 's'} checked, source: ${orderSource})`
    );
    if (result.errors.length > 0) {
      console.warn(`[SCHEDULER]   ⚠ COGS autofill error summary: ${formatCogsAutofillErrorSummary(result.errors)}`);
    }

    for (const failure of result.errors) {
      pushError(scanResult, 'cogs_autofill_order', new Error(`${failure.orderNo || 'unknown order'}: ${failure.error}`));
    }

    for (const appended of result.appended) {
      await orderNotificationService.deliverPaidOrderNotification(appended);
    }

    for (const duplicate of result.duplicates) {
      if (duplicate?.alreadyNotified) {
        await orderNotificationService.deliverPaidOrderNotification(duplicate);
      }
    }

    return { ok: true, result };
  } catch (err) {
    console.error('[SCHEDULER]   ⚠ COGS autofill reconciliation failed:', err.message);
    pushError(scanResult, 'cogs_autofill', err);
    pushStep(scanResult, { step: 'cogs_autofill', status: 'failed' });
    return { ok: false, result: null };
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

    if (imwebResult.ok) {
      await backfillRecentNewOrderNotifications(scanResult, imwebResult.orders);
      await reconcileClosedOrderNotifications(scanResult, imwebResult.orders);
    }

    // COGS autofill runs independently of Imweb — falls back to backup
    // order data when Imweb is unavailable so sheets keep updating.
    await reconcileRecentImwebOrdersToCogs(scanResult, imwebResult.ok ? imwebResult.orders : null);

    const cogsResult = await fetchCogs(scanResult);
    sourceStatus.cogs = cogsResult.ok;

    const fx = await refreshFxRate(scanResult);

    console.log('[SCHEDULER] Step 3d: Building economics ledger...');
    try {
      const latestData = scanStore.getLatestData();
      const economicsLedger = buildEconomicsLedger({
        orders: latestData.orders,
        cogsData: latestData.cogsData,
        campaignInsights: latestData.campaignInsights,
        campaigns: latestData.campaigns,
        usdToKrwRate: fx.usdToKrwRate,
      });
      scanStore.patchLatestData({ economicsLedger });
      scanStore.saveLatestData();
      pushStep(scanResult, {
        step: 'economics_ledger',
        status: 'ok',
        rows: economicsLedger.summary.totalRows,
        recognizedOrders: economicsLedger.summary.recognizedOrders,
        matchedOrdersToCogs: economicsLedger.summary.matchedOrdersToCogs,
        fallbackMatchedOrdersToCogs: economicsLedger.summary.fallbackMatchedOrdersToCogs,
        unmatchedCogsOrders: economicsLedger.summary.unmatchedCogsOrders,
      });
      console.log(
        `[SCHEDULER]   → ${economicsLedger.summary.totalRows} ledger rows, `
        + `${economicsLedger.summary.matchedOrdersToCogs}/${economicsLedger.summary.recognizedOrders} orders linked to COGS`
        + (economicsLedger.summary.fallbackMatchedOrdersToCogs > 0
          ? ` (${economicsLedger.summary.fallbackMatchedOrdersToCogs} via conservative fallback matching)`
          : '')
      );
    } catch (err) {
      console.warn('[SCHEDULER]   ⚠ Economics ledger build failed:', err.message);
      pushError(scanResult, 'economics_ledger', err);
      pushStep(scanResult, { step: 'economics_ledger', status: 'failed' });
    }

    console.log('[SCHEDULER] Step 3e: Auditing source extraction and projection reconciliation...');
    try {
      const latestData = scanStore.getLatestData();
      const sourceAudit = buildSourceExtractionAudit({
        scanId,
        since,
        until,
        sourceResults: {
          metaStructure: metaStructureResult,
          metaInsights: metaInsightsResult,
          imweb: imwebResult,
          cogs: cogsResult,
        },
        latestData,
      });
      scanStore.patchLatestData({ sourceAudit });
      scanStore.saveLatestData();
      scanResult.sourceAudit = {
        status: sourceAudit.status,
        summary: sourceAudit.summary,
        reconciliation: {
          status: sourceAudit.reconciliation.status,
          failedChecks: sourceAudit.reconciliation.failedChecks,
        },
      };
      pushStep(scanResult, {
        step: 'source_audit',
        status: sourceAudit.reconciliation.status === 'reconciled' ? 'ok' : 'failed',
        auditStatus: sourceAudit.status,
        failedChecks: sourceAudit.reconciliation.failedChecks,
      });
      if (sourceAudit.reconciliation.status === 'reconciled') {
        console.log(`[SCHEDULER]   → source projection reconciled (${sourceAudit.summary.passedChecks} checks)`);
      } else {
        console.warn(`[SCHEDULER]   ⚠ source projection mismatch: ${sourceAudit.reconciliation.failedChecks.join(', ')}`);
      }
    } catch (err) {
      console.warn('[SCHEDULER]   ⚠ Source audit failed:', err.message);
      pushError(scanResult, 'source_audit', err);
      pushStep(scanResult, { step: 'source_audit', status: 'failed' });
    }

    scanResult.stats = buildScanStats(scanStore.getLatestData(), until);

    const latestData = scanStore.getLatestData();
    const anySourceUpdated = Object.values(sourceStatus).some(Boolean);

    if (anySourceUpdated) {
      try {
        snapshotRepository.saveSnapshot(scanId, {
          campaigns: latestData.campaigns,
          adSets: latestData.adSets,
          ads: latestData.ads,
          campaignInsights: latestData.campaignInsights,
          adInsights: latestData.adInsights,
          orders: latestData.orders,
          revenueData: latestData.revenueData,
          cogsData: latestData.cogsData,
          economicsLedger: latestData.economicsLedger,
          fx: latestData.fx,
          sourceAudit: latestData.sourceAudit,
          sources: latestData.sources,
        });
        console.log(`[SCHEDULER]   → Snapshot ${scanId} saved`);
      } catch (err) {
        console.warn('[SCHEDULER]   ⚠ Snapshot save failed:', err.message);
      }
    }

    scanResult.stats = buildScanStats(latestData, until);
    scanResult.sourceHealth = scanStore.getSourceHealth();
  } catch (err) {
    console.error('[SCHEDULER] SCAN FAILED:', err.message);
    observabilityService.captureException(err, {
      category: 'scan.error',
      title: 'Scheduled scan failed',
      tags: {
        scan_id: scanId,
        manual: manual ? 'true' : 'false',
      },
    });
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

    try {
      const ledgerResult = await financialLedgerRepository.persistScanLedger({
        scanResult,
        latestData: scanStore.getLatestData(),
      });
      if (ledgerResult?.ok) {
        console.log(
          `[SCHEDULER]   → Postgres ledger persisted (${ledgerResult.imwebOrders} Imweb orders, ${ledgerResult.dailySnapshots} daily snapshots)`
        );
      }
    } catch (err) {
      console.warn('[SCHEDULER]   ⚠ Postgres ledger persist failed:', err.message);
    }

    scanStore.setIsScanning(false);
  }

  console.log(`\n[SCHEDULER] Scan complete in ${scanResult.durationMs}ms`);
  console.log(`[SCHEDULER] ${scanResult.optimizations.length} optimizations, ${scanResult.errors.length} errors\n`);
  observabilityService.captureMessage(
    `Scan ${scanId} completed with ${scanResult.optimizations.length} optimizations`,
    scanResult.errors.length > 0 ? 'warning' : 'info',
    {
      category: 'scan.complete',
      title: 'Scan completed',
      tags: {
        scan_id: scanId,
        manual: manual ? 'true' : 'false',
        status: scanResult.status,
      },
      data: {
        optimizationCount: scanResult.optimizations.length,
        errorCount: scanResult.errors.length,
      },
    }
  );

  return scanResult;
}

module.exports = {
  runScan,
  __private: {
    resolveAdInsightsSince,
  },
};
