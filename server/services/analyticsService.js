const config = require('../config');
const scheduler = require('../modules/scheduler');
const contracts = require('../contracts/v1');
const transforms = require('../transforms/charts');
const { buildProfitWindowSummaries } = require('../domain/profitWindowMetrics');
const { getTodayInTimeZone } = require('../domain/time');

function buildFeaturedProfitSummary(profitWaterfall, coverage, todayStr) {
  const rows = Array.isArray(profitWaterfall) ? profitWaterfall : [];
  if (rows.length === 0) return null;

  const todayRow = rows.find(row => row.date === todayStr) || null;
  const latestCoveredRow = rows.slice().reverse().find(row => row.hasCOGS) || null;
  const fallbackRow = rows[rows.length - 1] || null;

  let row = fallbackRow;
  let summaryType = 'latest';

  if (todayRow && todayRow.hasCOGS) {
    row = todayRow;
    summaryType = 'today';
  } else if (latestCoveredRow) {
    row = latestCoveredRow;
    summaryType = latestCoveredRow.date === todayStr ? 'today' : 'latest_completed';
  } else if (todayRow) {
    row = todayRow;
    summaryType = 'estimated';
  }

  return row ? {
    date: row.date,
    trueNetProfit: row.trueNetProfit,
    hasCOGS: row.hasCOGS,
    confidence: coverage.confidence,
    verdict: row.trueNetProfit >= 0 ? 'Profitable' : 'Unprofitable',
    summaryType,
    isEstimated: !row.hasCOGS,
  } : null;
}

function buildProfitRunRate(profitWaterfall, windowDays = 14) {
  const coveredRows = (Array.isArray(profitWaterfall) ? profitWaterfall : []).filter(row => row.hasCOGS);
  if (coveredRows.length === 0) return null;

  const window = coveredRows.slice(-windowDays);
  const totalNetProfit = window.reduce((sum, row) => sum + (row.trueNetProfit || 0), 0);
  const avgDailyNetProfit = totalNetProfit / window.length;

  return {
    windowDays,
    daysUsed: window.length,
    from: window[0].date,
    to: window[window.length - 1].date,
    avgDailyNetProfit: Math.round(avgDailyNetProfit),
    projectedMonthlyNetProfit: Math.round(avgDailyNetProfit * 30),
  };
}

/**
 * Build the /api/analytics response — charts, refund rates, profit analysis.
 */
function getAnalyticsResponse() {
  const data = scheduler.getLatestData();
  const revenue = data.revenueData || {};
  const cogs = data.cogsData || null;
  const dataSources = scheduler.getSourceHealth();

  // Build chart-ready arrays server-side
  const dailyMerged = transforms.buildDailyMerged(revenue.dailyRevenue, data.campaignInsights, cogs?.dailyCOGS);
  const hourlyOrders = transforms.buildHourlyOrders(revenue.hourlyOrders);
  const weekdayPerf = transforms.buildWeekdayPerf(dailyMerged);
  const monthlyRefunds = transforms.buildMonthlyRefunds(dailyMerged);
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
  const dailyProfit = transforms.buildDailyProfit(dailyMerged, profitWaterfall);
  const weeklyAgg = transforms.buildWeeklyAgg(dailyMerged, profitWaterfall);
  const dataCoverage = transforms.buildDataCoverage(dailyMerged, dailyCOGS);
  const profitRunRate = buildProfitRunRate(profitWaterfall, 14);
  const profitWindowSummaries = buildProfitWindowSummaries(profitWaterfall, dailyMerged);

  // Featured summary prefers a fully-covered current day, otherwise the latest completed covered day.
  const todayStr = getTodayInTimeZone();
  const todaySummary = buildFeaturedProfitSummary(profitWaterfall, dataCoverage, todayStr);

  return contracts.analytics({
    charts: { dailyMerged, hourlyOrders, weekdayPerf, weeklyAgg, monthlyRefunds, dailyProfit, fatigueTrend },
    revenueData: revenue,
    dailyInsights: data.campaignInsights || [],
    adInsights: data.adInsights || [],
    dataSources,
    cogsData: cogs,
    monthlyRates,
    profitAnalysis: {
      waterfall: profitWaterfall,
      coverage: dataCoverage,
      windowSummaries: profitWindowSummaries,
      todaySummary,
      runRate: profitRunRate,
    },
  });
}

module.exports = { getAnalyticsResponse };
