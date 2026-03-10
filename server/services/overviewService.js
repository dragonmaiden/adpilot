const config = require('../config');
const scheduler = require('../modules/scheduler');
const contracts = require('../contracts/v1');
const transforms = require('../transforms/charts');
const { sumField, sumPurchases, calcCPA, calcCTR, calcROAS } = require('../helpers/metrics');

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
  const totalSpend = sumField(insights, 'spend');
  const totalPurchases = sumPurchases(insights);
  const totalClicks = sumField(insights, 'clicks', parseInt);
  const totalImpressions = sumField(insights, 'impressions', parseInt);

  const revenue = data.revenueData || {};
  const cogs = data.cogsData || null;
  const cpa = calcCPA(totalSpend, totalPurchases) ?? 0;
  const ctr = calcCTR(totalClicks, totalImpressions);
  const roas = calcROAS(revenue.netRevenue || 0, totalSpend, config.currency.usdToKrw);

  // Build ALL chart data server-side — frontend does zero transformation
  const dailyMerged = transforms.buildDailyMerged(revenue.dailyRevenue, data.campaignInsights);
  const hourlyOrders = transforms.buildHourlyOrders(revenue.hourlyOrders);
  const weekdayPerf = transforms.buildWeekdayPerf(dailyMerged);
  const weeklyAgg = transforms.buildWeeklyAgg(dailyMerged);
  const monthlyRefunds = transforms.buildMonthlyRefunds(dailyMerged);
  const dailyProfit = transforms.buildDailyProfit(dailyMerged);

  // Compute gross profit margin
  const totalCOGSWithShipping = cogs ? cogs.totalCOGSWithShipping : 0;
  const grossProfit = (revenue.netRevenue || 0) - totalCOGSWithShipping - (totalSpend * config.currency.usdToKrw);
  const grossMargin = (revenue.netRevenue || 0) > 0 ? (grossProfit / (revenue.netRevenue || 1) * 100) : 0;

  return contracts.overview({
    kpis: {
      revenue: revenue.totalRevenue || 0,
      refunded: revenue.totalRefunded || 0,
      netRevenue: revenue.netRevenue || 0,
      totalOrders: revenue.totalOrders || 0,
      adSpend: totalSpend,
      adSpendKRW: totalSpend * config.currency.usdToKrw,
      purchases: totalPurchases,
      cpa,
      ctr,
      roas,
      refundRate: revenue.refundRate || 0,
      cancelRate: revenue.cancelRate || 0,
      cogs: cogs ? cogs.totalCOGSWithShipping : null,
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
