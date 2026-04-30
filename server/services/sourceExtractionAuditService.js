const { getOrderCashTotals } = require('../domain/imwebPayments');
const { formatDateInTimeZone } = require('../domain/time');
const { buildFinancialProjection } = require('./financialProjectionService');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value) {
  return Math.round(toNumber(value));
}

function normalizeAmount(value, precision = 0) {
  const factor = 10 ** precision;
  return Math.round(toNumber(value) * factor) / factor;
}

function dateRangeFromKeys(keys) {
  const dates = asArray(keys).filter(Boolean).sort();
  return {
    firstDate: dates[0] || null,
    lastDate: dates[dates.length - 1] || null,
    dayCount: dates.length,
  };
}

function normalizeValidation(validation) {
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) {
    return { valid: null, warnings: [], errors: [] };
  }

  return {
    valid: validation.valid === undefined ? null : Boolean(validation.valid),
    warnings: asArray(validation.warnings).map(String),
    errors: asArray(validation.errors).map(String),
  };
}

function summarizeImwebOrders(orders) {
  const totals = {
    rowCount: 0,
    recognizedOrders: 0,
    grossRevenue: 0,
    refundedAmount: 0,
    netRevenue: 0,
    firstDate: null,
    lastDate: null,
  };
  const dates = [];

  for (const order of asArray(orders)) {
    totals.rowCount += 1;
    const cash = getOrderCashTotals(order);
    if (cash.hasRecognizedCash) totals.recognizedOrders += 1;
    totals.grossRevenue += cash.approvedAmount;
    totals.refundedAmount += cash.refundedAmount;
    totals.netRevenue += cash.netPaidAmount;

    if (order?.wtime) {
      const date = new Date(order.wtime);
      if (!Number.isNaN(date.getTime())) {
        dates.push(formatDateInTimeZone(date));
      }
    }
  }

  return {
    ...totals,
    grossRevenue: round(totals.grossRevenue),
    refundedAmount: round(totals.refundedAmount),
    netRevenue: round(totals.netRevenue),
    ...dateRangeFromKeys(dates),
  };
}

function summarizeRevenueData(revenueData) {
  const dailyRevenue = revenueData?.dailyRevenue && typeof revenueData.dailyRevenue === 'object'
    ? revenueData.dailyRevenue
    : {};

  return {
    rowCount: Object.keys(dailyRevenue).length,
    recognizedOrders: round(revenueData?.totalOrders),
    grossRevenue: round(revenueData?.totalRevenue),
    refundedAmount: round(revenueData?.totalRefunded),
    netRevenue: round(revenueData?.netRevenue),
    ...dateRangeFromKeys(Object.keys(dailyRevenue)),
  };
}

function summarizeMetaInsights(campaignInsights, adInsights) {
  const campaignRows = asArray(campaignInsights);
  const adRows = asArray(adInsights);
  const dates = campaignRows.map(row => row?.date_start).filter(Boolean);
  const spendUsd = campaignRows.reduce((sum, row) => sum + toNumber(row?.spend), 0);

  return {
    campaignRows: campaignRows.length,
    adRows: adRows.length,
    spendUsd: Number(spendUsd.toFixed(2)),
    ...dateRangeFromKeys(dates),
  };
}

function summarizeCogsData(cogsData) {
  const dailyCOGS = cogsData?.dailyCOGS && typeof cogsData.dailyCOGS === 'object'
    ? cogsData.dailyCOGS
    : {};

  return {
    rowCount: asArray(cogsData?.orders).length,
    itemCount: round(cogsData?.itemCount),
    orderCount: round(cogsData?.orderCount),
    totalCOGS: round(cogsData?.totalCOGS),
    totalShipping: round(cogsData?.totalShipping),
    totalCOGSWithShipping: round(cogsData?.totalCOGSWithShipping),
    incompletePurchaseCount: round(cogsData?.incompletePurchaseCount),
    missingCostItemCount: round(cogsData?.missingCostItemCount),
    pendingRecoveryItemCount: round(cogsData?.pendingRecoveryItemCount),
    ...dateRangeFromKeys(Object.keys(dailyCOGS)),
  };
}

function compareAmounts(name, sourceValue, projectionValue, tolerance = 0, precision = 0) {
  const source = normalizeAmount(sourceValue, precision);
  const projection = normalizeAmount(projectionValue, precision);
  const delta = normalizeAmount(projection - source, precision);
  return {
    name,
    status: Math.abs(delta) <= tolerance ? 'pass' : 'fail',
    source,
    projection,
    delta,
    tolerance,
  };
}

function sumRows(rows, selector) {
  return asArray(rows).reduce((sum, row) => sum + toNumber(selector(row)), 0);
}

function buildProjectionReconciliation(latestData = {}, projection = buildFinancialProjection(latestData)) {
  const orderTotals = summarizeImwebOrders(latestData.orders);
  const revenueTotals = summarizeRevenueData(latestData.revenueData);
  const cogsTotals = summarizeCogsData(latestData.cogsData);
  const dailyMerged = projection.dailyMerged;
  const waterfall = projection.profitWaterfall;
  const metaTotals = summarizeMetaInsights(latestData.campaignInsights, latestData.adInsights);
  const roundingTolerance = Math.max(2, waterfall.length * 2);

  const checks = [
    compareAmounts('imweb_orders_to_revenue_gross', orderTotals.grossRevenue, revenueTotals.grossRevenue),
    compareAmounts('imweb_orders_to_revenue_refunds', orderTotals.refundedAmount, revenueTotals.refundedAmount),
    compareAmounts('imweb_orders_to_revenue_net', orderTotals.netRevenue, revenueTotals.netRevenue),
    compareAmounts('revenue_to_projection_gross', revenueTotals.grossRevenue, sumRows(dailyMerged, row => row.revenue)),
    compareAmounts('revenue_to_projection_refunds', revenueTotals.refundedAmount, sumRows(dailyMerged, row => row.refunded)),
    compareAmounts('revenue_to_projection_net', revenueTotals.netRevenue, sumRows(dailyMerged, row => row.netRevenue)),
    compareAmounts('meta_spend_to_projection_usd', metaTotals.spendUsd, sumRows(dailyMerged, row => row.spend), 0.01, 2),
    compareAmounts('meta_spend_krw_to_waterfall', sumRows(dailyMerged, row => row.spendKrw), sumRows(waterfall, row => row.adSpendKRW)),
    compareAmounts('sheets_cogs_to_waterfall', cogsTotals.totalCOGS, sumRows(waterfall, row => row.cogs)),
    compareAmounts('sheets_shipping_to_waterfall', cogsTotals.totalShipping, sumRows(waterfall, row => row.cogsShipping)),
  ];

  const projectionNet = sumRows(waterfall, row => row.netRevenue);
  const projectionCosts = sumRows(waterfall, row =>
    toNumber(row.cogs) + toNumber(row.cogsShipping) + toNumber(row.paymentFees) + toNumber(row.adSpendKRW)
  );
  checks.push(compareAmounts(
    'true_net_profit_identity',
    projectionNet - projectionCosts,
    sumRows(waterfall, row => row.trueNetProfit),
    roundingTolerance
  ));

  const failed = checks.filter(check => check.status !== 'pass');
  return {
    status: failed.length === 0 ? 'reconciled' : 'mismatch',
    checkedAt: new Date().toISOString(),
    fx: projection.fx,
    sourceTotals: {
      imweb: orderTotals,
      revenueProjectionInput: revenueTotals,
      meta: metaTotals,
      cogs: cogsTotals,
    },
    projectionTotals: {
      grossRevenue: round(sumRows(dailyMerged, row => row.revenue)),
      refundedAmount: round(sumRows(dailyMerged, row => row.refunded)),
      netRevenue: round(sumRows(dailyMerged, row => row.netRevenue)),
      adSpendKRW: round(sumRows(waterfall, row => row.adSpendKRW)),
      cogs: round(sumRows(waterfall, row => row.cogs)),
      shipping: round(sumRows(waterfall, row => row.cogsShipping)),
      paymentFees: round(sumRows(waterfall, row => row.paymentFees)),
      trueNetProfit: round(sumRows(waterfall, row => row.trueNetProfit)),
    },
    checks,
    failedChecks: failed.map(check => check.name),
  };
}

function buildSourceReceipt({ source, sourceHealthKey = source, request, result, validation, latestData, latestSummary }) {
  const fetchStatus = result?.ok ? 'ok' : 'failed';
  const latestRows = round(latestSummary?.rowCount ?? latestSummary?.campaignRows ?? 0);
  return {
    source,
    request: request || {},
    fetchStatus,
    acceptedThisScan: fetchStatus === 'ok',
    validation: normalizeValidation(validation),
    received: result?.received || null,
    accepted: {
      rowCount: fetchStatus === 'ok' ? round(result?.acceptedRows ?? latestRows) : 0,
      latestRowCount: latestRows,
      rejectedRowCount: 0,
      malformedRowCount: 0,
    },
    freshness: latestData?.sources?.[sourceHealthKey] || {},
    latestSummary: latestSummary || {},
  };
}

function buildSourceExtractionAudit({ scanId, since, until, sourceResults = {}, latestData = {} }) {
  const projection = buildFinancialProjection(latestData);
  const reconciliation = buildProjectionReconciliation(latestData, projection);

  const imwebSummary = summarizeImwebOrders(latestData.orders);
  const metaSummary = summarizeMetaInsights(latestData.campaignInsights, latestData.adInsights);
  const cogsSummary = summarizeCogsData(latestData.cogsData);

  const sources = {
    imweb: buildSourceReceipt({
      source: 'imweb',
      request: { mode: 'all_orders' },
      result: sourceResults.imweb,
      validation: sourceResults.imweb?.validation,
      latestData,
      latestSummary: imwebSummary,
    }),
    meta: buildSourceReceipt({
      source: 'meta',
      sourceHealthKey: 'metaInsights',
      request: { since, until, adInsightsSince: sourceResults.metaInsights?.adSince || null },
      result: sourceResults.metaInsights,
      validation: sourceResults.metaInsights?.validation,
      latestData,
      latestSummary: metaSummary,
    }),
    cogs: buildSourceReceipt({
      source: 'cogs',
      request: { mode: 'google_sheets_workbook' },
      result: sourceResults.cogs,
      validation: latestData.cogsData?.validation || null,
      latestData,
      latestSummary: cogsSummary,
    }),
  };

  const staleSources = Object.entries(latestData.sources || {})
    .filter(([, source]) => source?.stale)
    .map(([source]) => source);
  const failedFetches = Object.entries(sources)
    .filter(([, source]) => source.fetchStatus !== 'ok')
    .map(([source]) => source);

  return {
    status: reconciliation.status === 'reconciled' && failedFetches.length === 0
      ? 'reconciled'
      : reconciliation.status === 'reconciled'
        ? 'reconciled_with_stale_sources'
        : 'mismatch',
    scanId,
    generatedAt: new Date().toISOString(),
    canonicalSources: ['imweb', 'meta', 'cogs'],
    window: { since, until },
    summary: {
      failedFetches,
      staleSources,
      reconciliationStatus: reconciliation.status,
      passedChecks: reconciliation.checks.filter(check => check.status === 'pass').length,
      failedChecks: reconciliation.failedChecks,
    },
    sources,
    reconciliation,
  };
}

module.exports = {
  buildSourceExtractionAudit,
  buildProjectionReconciliation,
  summarizeImwebOrders,
  summarizeMetaInsights,
  summarizeCogsData,
};
