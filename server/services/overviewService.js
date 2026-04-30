const scheduler = require('../modules/scheduler');
const contracts = require('../contracts/v1');
const fxService = require('./fxService');
const { buildFinancialProjection } = require('./financialProjectionService');
const {
  summarizeInsights,
  calcCPA,
  calcAOV,
  calcPercent,
  calcMargin,
} = require('../domain/metrics');

async function getOverviewResponse() {
  const data = scheduler.getLatestData();
  const scan = scheduler.getLastScanResult();

  if (!scan) {
    return contracts.overviewNotReady();
  }

  // Calculate KPIs from fresh data
  const insights = data.campaignInsights || [];
  const insightSummary = summarizeInsights(insights);
  const totalSpend = insightSummary.spend;

  const revenue = data.revenueData || {};
  const cogs = data.cogsData || null;
  const totalPurchases = cogs?.purchaseCount ?? revenue.totalOrders ?? 0;
  const cpa = calcCPA(totalSpend, totalPurchases, 0);
  const ctr = insightSummary.ctr;
  let fx = data.fx || null;
  if (!Number.isFinite(Number(fx?.usdToKrwRate)) || Number(fx?.usdToKrwRate) <= 0) {
    try {
      fx = await fxService.getLatestUsdToKrwRate();
    } catch (err) {
      console.warn('[OVERVIEW] FX rate unavailable; using projection fallback:', err.message);
    }
  }
  const projection = buildFinancialProjection(data, { fx });
  const usdToKrwRate = projection.fx.usdToKrwRate;

  // Build ALL chart data server-side — frontend does zero transformation
  const dailyMerged = projection.dailyMerged;

  // Compute gross profit margin
  const totalCOGSWithShipping = cogs ? cogs.totalCOGSWithShipping : 0;
  const adSpendKRW = Math.round(totalSpend * usdToKrwRate);
  const grossProfit = Math.round((revenue.netRevenue || 0) - totalCOGSWithShipping - adSpendKRW);
  const grossMargin = calcMargin(grossProfit, revenue.netRevenue || 0);
  const roas = adSpendKRW > 0 ? (revenue.netRevenue || 0) / adSpendKRW : 0;
  const aov = calcAOV(revenue.totalRevenue || 0, revenue.totalOrders || 0);
  const cogsRate = calcPercent(totalCOGSWithShipping, revenue.totalRevenue || 0);

  return contracts.overview({
    kpis: {
      revenue: revenue.totalRevenue || 0,
      refunded: revenue.totalRefunded || 0,
      netRevenue: revenue.netRevenue || 0,
      totalOrders: revenue.totalOrders || 0,
      adSpend: totalSpend,
      adSpendKRW,
      purchases: totalPurchases,
      cpa,
      ctr,
      roas,
      refundRate: revenue.refundRate || 0,
      cancelRate: revenue.cancelRate || 0,
      cogs: cogs ? cogs.totalCOGSWithShipping : null,
      aov: Math.round(aov),
      cogsRate: parseFloat(cogsRate.toFixed(1)),
      grossProfit,
      grossMargin: parseFloat(grossMargin.toFixed(1)),
    },
    days: dailyMerged.length,
    campaigns: data.campaigns || [],
    charts: {
      dailyMerged,
      hourlyOrders: projection.hourlyOrders,
      weekdayPerf: projection.weekdayPerf,
      weeklyAgg: projection.weeklyAgg,
      monthlyRefunds: projection.monthlyRefunds,
      dailyProfit: projection.dailyProfit,
    },
    scanStats: scan.stats || {},
    lastScan: scheduler.getLastScanTime()?.toISOString(),
    isScanning: scheduler.getIsScanning(),
    dataSources: scheduler.getSourceHealth(),
    sourceAudit: data.sourceAudit || null,
    fx: {
      base: projection.fx.base,
      quote: projection.fx.quote,
      source: projection.fx.source,
      usdToKrwRate,
      rateDate: projection.fx.rateDate,
      fetchedAt: projection.fx.fetchedAt,
      stale: projection.fx.stale,
    },
  });
}

module.exports = { getOverviewResponse };
