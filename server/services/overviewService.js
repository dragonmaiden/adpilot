const scheduler = require('../modules/scheduler');
const contracts = require('../contracts/v1');
const transforms = require('../transforms/charts');
const fxService = require('./fxService');
const {
  summarizeInsights,
  calcCPA,
  calcAOV,
  calcPercent,
  calcMargin,
} = require('../domain/metrics');

/**
 * Build the full /api/overview response.
 * Returns the not-ready contract if no scan has completed yet.
 */
function applyOverviewFx(dailyMerged, usdToKrwRate) {
  return (dailyMerged || []).map(row => {
    const spend = Number(row?.spend || 0);
    const netRevenue = Number(row?.netRevenue ?? ((row?.revenue || 0) - (row?.refunded || 0)));
    const spendKrw = Math.round(spend * usdToKrwRate);
    const roas = spendKrw > 0 ? Number((netRevenue / spendKrw).toFixed(4)) : 0;

    return {
      ...row,
      spendKrw,
      roas,
      usdToKrwRate,
    };
  });
}

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
  const fx = await fxService.getLatestUsdToKrwRate();
  const usdToKrwRate = Number(fx?.usdToKrwRate || 0);

  // Build ALL chart data server-side — frontend does zero transformation
  const baseDailyMerged = transforms.buildDailyMerged(revenue.dailyRevenue, data.campaignInsights, cogs?.dailyCOGS);
  const dailyMerged = applyOverviewFx(baseDailyMerged, usdToKrwRate);
  const hourlyOrders = transforms.buildHourlyOrders(revenue.hourlyOrders);
  const weekdayPerf = transforms.buildWeekdayPerf(dailyMerged);
  const weeklyAgg = transforms.buildWeeklyAgg(dailyMerged);
  const monthlyRefunds = transforms.buildMonthlyRefunds(dailyMerged);
  const dailyProfit = transforms.buildDailyProfit(dailyMerged);

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
    charts: { dailyMerged, hourlyOrders, weekdayPerf, weeklyAgg, monthlyRefunds, dailyProfit },
    scanStats: scan.stats || {},
    lastScan: scheduler.getLastScanTime()?.toISOString(),
    isScanning: scheduler.getIsScanning(),
    dataSources: scheduler.getSourceHealth(),
    fx: {
      base: fx.base,
      quote: fx.quote,
      source: fx.source,
      usdToKrwRate,
      rateDate: fx.rateDate,
      fetchedAt: fx.fetchedAt,
    },
  });
}

module.exports = { getOverviewResponse };
