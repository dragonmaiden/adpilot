const scheduler = require('../modules/scheduler');
const contracts = require('../contracts/v1');
const transforms = require('../transforms/charts');
const { buildFinancialProjection } = require('./financialProjectionService');

/**
 * Build the /api/analytics response — charts, refund rates, profit analysis.
 */
function getAnalyticsResponse() {
  const data = scheduler.getLatestData();
  const dataSources = scheduler.getSourceHealth();
  const projection = buildFinancialProjection(data);
  const fatigueTrend = transforms.buildFatigueTrend(data.adInsights || []);

  return contracts.analytics({
    charts: {
      dailyMerged: projection.dailyMerged,
      hourlyOrders: projection.hourlyOrders,
      weekdayPerf: projection.weekdayPerf,
      weeklyAgg: projection.weeklyAgg,
      monthlyRefunds: projection.monthlyRefunds,
      dailyProfit: projection.dailyProfit,
      fatigueTrend,
    },
    revenueData: projection.revenue,
    dailyInsights: data.campaignInsights || [],
    adInsights: data.adInsights || [],
    dataSources,
    sourceAudit: data.sourceAudit || null,
    cogsData: projection.cogs,
    monthlyRates: projection.monthlyRates,
    profitAnalysis: {
      waterfall: projection.profitWaterfall,
      coverage: projection.dataCoverage,
      windowSummaries: projection.windowSummaries,
      todaySummary: projection.todaySummary,
      runRate: projection.profitRunRate,
    },
  });
}

module.exports = { getAnalyticsResponse };
