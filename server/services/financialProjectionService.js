const config = require('../config');
const transforms = require('../transforms/charts');
const { buildProfitWindowSummaries } = require('../domain/profitWindowMetrics');
const { getTodayInTimeZone } = require('../domain/time');

function normalizeFxContext(rawFx = null) {
  const rate = Number(rawFx?.usdToKrwRate);
  if (Number.isFinite(rate) && rate > 0) {
    return {
      base: rawFx.base || 'USD',
      quote: rawFx.quote || 'KRW',
      source: rawFx.source || 'unknown',
      usdToKrwRate: rate,
      rateDate: rawFx.rateDate || null,
      fetchedAt: rawFx.fetchedAt || null,
      stale: Boolean(rawFx.stale),
    };
  }

  return {
    base: 'USD',
    quote: 'KRW',
    source: 'static-config',
    usdToKrwRate: config.currency.usdToKrw,
    rateDate: null,
    fetchedAt: null,
    stale: true,
  };
}

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

function buildMonthlyRates(monthlyRefunds) {
  const monthlyRates = {};
  for (const month of Array.isArray(monthlyRefunds) ? monthlyRefunds : []) {
    if (month.revenue > 0) {
      monthlyRates[month.month] = parseFloat(((month.refunded / month.revenue) * 100).toFixed(1));
    }
  }
  return monthlyRates;
}

function buildFinancialProjection(data = {}, options = {}) {
  const revenue = data.revenueData || {};
  const cogs = data.cogsData || null;
  const fx = normalizeFxContext(options.fx || data.fx);
  const transformOptions = { usdToKrwRate: fx.usdToKrwRate };

  const dailyMerged = transforms.buildDailyMerged(
    revenue.dailyRevenue,
    data.campaignInsights,
    cogs?.dailyCOGS,
    transformOptions
  );
  const dailyCOGS = cogs ? cogs.dailyCOGS || {} : {};
  const profitWaterfall = transforms.buildProfitWaterfall(
    dailyMerged,
    dailyCOGS,
    config.fees.paymentFeeRate,
    transformOptions
  );
  const hourlyOrders = transforms.buildHourlyOrders(revenue.hourlyOrders);
  const weekdayPerf = transforms.buildWeekdayPerf(dailyMerged);
  const monthlyRefunds = transforms.buildMonthlyRefunds(dailyMerged);
  const dailyProfit = transforms.buildDailyProfit(dailyMerged, profitWaterfall);
  const weeklyAgg = transforms.buildWeeklyAgg(dailyMerged, profitWaterfall);
  const dataCoverage = transforms.buildDataCoverage(dailyMerged, dailyCOGS);
  const windowSummaries = buildProfitWindowSummaries(profitWaterfall, dailyMerged);
  const todaySummary = buildFeaturedProfitSummary(profitWaterfall, dataCoverage, getTodayInTimeZone());

  return {
    fx,
    revenue,
    cogs,
    transformOptions,
    dailyMerged,
    dailyCOGS,
    profitWaterfall,
    hourlyOrders,
    weekdayPerf,
    monthlyRefunds,
    dailyProfit,
    weeklyAgg,
    dataCoverage,
    windowSummaries,
    todaySummary,
    profitRunRate: buildProfitRunRate(profitWaterfall, 14),
    monthlyRates: buildMonthlyRates(monthlyRefunds),
  };
}

module.exports = {
  normalizeFxContext,
  buildFinancialProjection,
  buildFeaturedProfitSummary,
  buildProfitRunRate,
};
