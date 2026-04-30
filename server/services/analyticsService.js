const config = require('../config');
const scheduler = require('../modules/scheduler');
const contracts = require('../contracts/v1');
const transforms = require('../transforms/charts');
const { buildProfitWindowSummaries } = require('../domain/profitWindowMetrics');
const { getTodayInTimeZone } = require('../domain/time');
const { buildCampaignEconomics } = require('./campaignEconomicsService');

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

function toCampaignProfitRows(campaignEconomicsContext) {
  return (campaignEconomicsContext?.campaigns || []).map(campaign => ({
    campaignId: campaign.campaignId,
    campaignName: campaign.campaignName,
    status: campaign.status,
    spend: campaign.spend,
    spendKRW: campaign.spendKrw,
    metaPurchases: campaign.metaPurchases,
    estimatedRevenue: campaign.estimatedRevenue,
    allocatedCOGS: campaign.allocatedCogs + campaign.allocatedShipping,
    allocatedShipping: campaign.allocatedShipping,
    allocatedFees: campaign.allocatedFees,
    grossProfit: campaign.estimatedTrueNetProfit,
    margin: Number((campaign.estimatedMargin * 100).toFixed(1)),
    estimatedRoas: campaign.estimatedRoas,
    estimatedAov: campaign.estimatedAov,
    breakEvenCpa: campaign.breakEvenCpa,
    targetCpa: campaign.targetCpa,
    confidence: campaign.confidence,
    confidenceLabel: campaign.confidenceLabel,
    confidenceReasons: campaign.confidenceReasons,
    coverageRatio: campaign.coverageRatio,
    hasReliableEstimate: campaign.hasReliableEstimate,
    basis: campaign.basis,
  }));
}

function toCampaignProfitWindow(campaignEconomicsContext) {
  const campaigns = toCampaignProfitRows(campaignEconomicsContext);
  const summary = campaignEconomicsContext?.summary || {};
  const spend = campaigns.reduce((sum, campaign) => sum + Number(campaign.spend || 0), 0);
  const spendKRW = campaigns.reduce((sum, campaign) => sum + Number(campaign.spendKRW || 0), 0);
  const estimatedProfit = campaigns.reduce((sum, campaign) => sum + Number(campaign.grossProfit || 0), 0);
  const activeCampaigns = campaigns.filter(campaign => campaign.status === 'ACTIVE').length;
  const profitableCampaigns = campaigns.filter(campaign => Number(campaign.grossProfit || 0) > 0).length;

  return {
    summary: {
      days: summary.days,
      windowStart: summary.windowStart,
      windowEnd: summary.windowEnd,
      netRevenue: summary.netRevenue || 0,
      estimatedMetaRevenue: summary.estimatedMetaRevenue || 0,
      attributableRevenueShare: summary.attributableRevenueShare || 0,
      totalMetaPurchases: summary.totalMetaPurchases || 0,
      spend: Number(spend.toFixed(2)),
      spendKRW,
      estimatedProfit: Math.round(estimatedProfit),
      campaignCount: campaigns.length,
      activeCampaigns,
      profitableCampaigns,
      confidence: summary.confidence || 'low',
      confidenceLabel: summary.confidenceLabel || '',
      confidenceReasons: summary.confidenceReasons || [],
      basis: summary.basis,
    },
    campaigns,
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
  const campaignWindowOptions = {
    '7d': 7,
    '14d': 14,
    '30d': 30,
    all: Math.max(dailyMerged.length, 1),
  };
  const campaignProfitWindows = Object.fromEntries(
    Object.entries(campaignWindowOptions).map(([key, days]) => {
      const context = buildCampaignEconomics(
        data.campaigns || [],
        data.campaignInsights || [],
        revenue,
        cogs,
        dataSources.imweb,
        {
          days,
          referenceDate: todayStr,
          includeCurrentDay: true,
          paymentFeeRate: config.fees.paymentFeeRate,
        }
      );
      return [key, toCampaignProfitWindow(context)];
    })
  );
  const campaignProfit = campaignProfitWindows.all?.campaigns || [];
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
      campaignProfit,
      campaignProfitWindows,
      coverage: dataCoverage,
      windowSummaries: profitWindowSummaries,
      todaySummary,
      runRate: profitRunRate,
    },
  });
}

module.exports = { getAnalyticsResponse };
