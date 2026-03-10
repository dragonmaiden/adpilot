const config = require('../config');
const scheduler = require('../modules/scheduler');
const contracts = require('../contracts/v1');
const transforms = require('../transforms/charts');
const { calcAOV } = require('../domain/metrics');
const { getTodayInTimeZone } = require('../domain/time');

/**
 * Build the /api/analytics response — charts, refund rates, profit analysis.
 */
function getAnalyticsResponse() {
  const data = scheduler.getLatestData();
  const revenue = data.revenueData || {};
  const cogs = data.cogsData || null;

  // Build chart-ready arrays server-side
  const dailyMerged = transforms.buildDailyMerged(revenue.dailyRevenue, data.campaignInsights, cogs?.dailyCOGS);
  const hourlyOrders = transforms.buildHourlyOrders(revenue.hourlyOrders);
  const weekdayPerf = transforms.buildWeekdayPerf(dailyMerged);
  const weeklyAgg = transforms.buildWeeklyAgg(dailyMerged);
  const monthlyRefunds = transforms.buildMonthlyRefunds(dailyMerged);
  const dailyProfit = transforms.buildDailyProfit(dailyMerged);
  const fatigueTrend = transforms.buildFatigueTrend(data.adInsights || []);

  // Compute per-month refund rates from monthly data
  const monthlyRates = {};
  for (const m of monthlyRefunds) {
    if (m.revenue > 0) {
      monthlyRates[m.month] = parseFloat(((m.refunded / m.revenue) * 100).toFixed(1));
    }
  }

  // ── Profit Analysis transforms ──
  const dailyCOGS = cogs ? cogs.dailyCOGS : {};
  const profitWaterfall = transforms.buildProfitWaterfall(dailyMerged, dailyCOGS, config.fees.paymentFeeRate);
  const avgAOV = calcAOV(revenue.netRevenue || 0, revenue.totalOrders || 0);
  const campaignProfit = transforms.buildCampaignProfit(data.campaignInsights, data.campaigns, avgAOV, cogs, revenue.netRevenue || 0);
  const dataCoverage = transforms.buildDataCoverage(dailyMerged, dailyCOGS);

  // Today's summary from last waterfall row
  const todayStr = getTodayInTimeZone();
  const todayRow = profitWaterfall.find(r => r.date === todayStr) || (profitWaterfall.length > 0 ? profitWaterfall[profitWaterfall.length - 1] : null);
  const todaySummary = todayRow ? {
    date: todayRow.date,
    trueNetProfit: todayRow.trueNetProfit,
    hasCOGS: todayRow.hasCOGS,
    confidence: dataCoverage.confidence,
    verdict: todayRow.trueNetProfit >= 0 ? 'Profitable' : 'Unprofitable',
  } : null;

  return contracts.analytics({
    charts: { dailyMerged, hourlyOrders, weekdayPerf, weeklyAgg, monthlyRefunds, dailyProfit, fatigueTrend },
    revenueData: revenue,
    dailyInsights: data.campaignInsights || [],
    adSetInsights: data.adSetInsights || [],
    adInsights: data.adInsights || [],
    cogsData: cogs,
    monthlyRates,
    profitAnalysis: {
      waterfall: profitWaterfall,
      campaignProfit,
      coverage: dataCoverage,
      todaySummary,
    },
  });
}

module.exports = { getAnalyticsResponse };
