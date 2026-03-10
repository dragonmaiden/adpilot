const scheduler = require('../modules/scheduler');
const contracts = require('../contracts/v1');
const transforms = require('../transforms/charts');
const {
  summarizeInsights,
  calcCPA,
  calcROAS,
  convertUsdToKrw,
  calcAOV,
  calcPercent,
  calcGrossProfit,
  calcMargin,
} = require('../domain/metrics');

/**
 * Build the full /api/overview response.
 * Returns the not-ready contract if no scan has completed yet.
 */
function getOverviewResponse() {
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
  const roas = calcROAS(revenue.netRevenue || 0, totalSpend);

  // Build ALL chart data server-side — frontend does zero transformation
  const dailyMerged = transforms.buildDailyMerged(revenue.dailyRevenue, data.campaignInsights, cogs?.dailyCOGS);
  const hourlyOrders = transforms.buildHourlyOrders(revenue.hourlyOrders);
  const weekdayPerf = transforms.buildWeekdayPerf(dailyMerged);
  const weeklyAgg = transforms.buildWeeklyAgg(dailyMerged);
  const monthlyRefunds = transforms.buildMonthlyRefunds(dailyMerged);
  const dailyProfit = transforms.buildDailyProfit(dailyMerged);

  // Compute gross profit margin
  const totalCOGSWithShipping = cogs ? cogs.totalCOGSWithShipping : 0;
  const adSpendKRW = convertUsdToKrw(totalSpend);
  const grossProfit = calcGrossProfit(revenue.netRevenue || 0, totalCOGSWithShipping, totalSpend);
  const grossMargin = calcMargin(grossProfit, revenue.netRevenue || 0);
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
  });
}

module.exports = { getOverviewResponse };
