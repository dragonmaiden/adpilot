const config = require('../config');
const transforms = require('../transforms/charts');
const { getPurchases } = require('./metrics');
const { getTodayInTimeZone, shiftDate } = require('./time');

function getWindowStart(days, referenceDate = getTodayInTimeZone()) {
  return shiftDate(referenceDate, -(days - 1));
}

function resolveWindowBounds(days, referenceDate = getTodayInTimeZone(), options = {}) {
  const { includeCurrentDay = true } = options;
  const windowEnd = includeCurrentDay ? referenceDate : shiftDate(referenceDate, -1);
  if (!windowEnd) {
    return { windowStart: null, windowEnd: null };
  }

  return {
    windowStart: getWindowStart(days, windowEnd),
    windowEnd,
  };
}

function filterRecentInsights(insights, idKey, idValue, days = 7, referenceDate = getTodayInTimeZone(), options = {}) {
  const { windowStart, windowEnd } = resolveWindowBounds(days, referenceDate, options);
  if (!windowStart || !windowEnd) {
    return [];
  }

  return (Array.isArray(insights) ? insights : [])
    .filter(row =>
      row?.[idKey] === idValue
      && row?.date_start >= windowStart
      && row?.date_start <= windowEnd
    )
    .sort((left, right) => String(left?.date_start || '').localeCompare(String(right?.date_start || '')));
}

function filterAllRecentInsights(insights, days = 7, referenceDate = getTodayInTimeZone(), options = {}) {
  const { windowStart, windowEnd } = resolveWindowBounds(days, referenceDate, options);
  if (!windowStart || !windowEnd) {
    return [];
  }

  return (Array.isArray(insights) ? insights : [])
    .filter(row => row?.date_start >= windowStart && row?.date_start <= windowEnd)
    .sort((left, right) => String(left?.date_start || '').localeCompare(String(right?.date_start || '')));
}

function sumRecentNetRevenue(revenueData, days = 7, referenceDate = getTodayInTimeZone(), options = {}) {
  const dailyRevenue = revenueData?.dailyRevenue;
  const { windowStart, windowEnd } = resolveWindowBounds(days, referenceDate, options);
  if (!dailyRevenue || typeof dailyRevenue !== 'object' || Array.isArray(dailyRevenue)) {
    return 0;
  }
  if (!windowStart || !windowEnd) {
    return 0;
  }

  return Object.entries(dailyRevenue).reduce((sum, [date, value]) => {
    if (date < windowStart || date > windowEnd) return sum;
    const paid = Number(value?.revenue || 0);
    const refunded = Number(value?.refunded || 0);
    return sum + paid - refunded;
  }, 0);
}

function getWeekdayName(dateKey) {
  if (!dateKey) return '';
  return new Date(`${dateKey}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: 'UTC',
  });
}

function median(values) {
  const sorted = (values || [])
    .filter(value => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint];
}

function buildWeekdayScaleContext(insights, rules, referenceDate = getTodayInTimeZone(), options = {}) {
  const {
    lookbackDays = 28,
    cautionRatio = 1.15,
    suppressRatio = 1.4,
    includeCurrentDay = true,
  } = options;
  const currentWeekday = getWeekdayName(referenceDate);
  const recentInsights = filterAllRecentInsights(insights, lookbackDays, referenceDate, {
    includeCurrentDay,
  });
  if (!currentWeekday || recentInsights.length === 0) {
    return { status: 'neutral', weekday: currentWeekday };
  }

  const dayPerf = new Map();
  for (const insight of recentInsights) {
    const weekday = getWeekdayName(insight?.date_start);
    if (!weekday) continue;
    const spend = Number(insight?.spend || 0);
    const purchases = getPurchases(insight?.actions);
    const bucket = dayPerf.get(weekday) || { weekday, spend: 0, purchases: 0, observations: 0 };
    bucket.spend += spend;
    bucket.purchases += purchases;
    bucket.observations += 1;
    dayPerf.set(weekday, bucket);
  }

  const weekdayRows = Array.from(dayPerf.values()).map(day => ({
    ...day,
    cpa: day.purchases > 0 ? day.spend / day.purchases : Infinity,
    purchaseEfficiency: day.spend > 0 ? day.purchases / day.spend : 0,
  }));
  const current = weekdayRows.find(day => day.weekday === currentWeekday);
  if (!current || current.observations < 2 || current.spend < rules.minSpendForDecision) {
    return { status: 'neutral', weekday: currentWeekday };
  }

  if (current.purchases === 0) {
    return {
      status: 'suppress',
      weekday: currentWeekday,
      currentCpa: null,
      reason: `Recent ${currentWeekday} delivery spent $${current.spend.toFixed(2)} across ${current.observations} observations with 0 Meta-attributed purchases`,
    };
  }

  const comparable = weekdayRows.filter(day => day.observations > 0 && day.spend >= rules.minSpendForDecision);
  if (comparable.length < 3) {
    return { status: 'neutral', weekday: currentWeekday };
  }
  const medianCpa = median(comparable.filter(day => Number.isFinite(day.cpa)).map(day => day.cpa));
  const medianEfficiency = median(comparable.filter(day => day.purchaseEfficiency > 0).map(day => day.purchaseEfficiency));
  if (!Number.isFinite(medianCpa) || !Number.isFinite(medianEfficiency) || medianCpa <= 0 || medianEfficiency <= 0) {
    return { status: 'neutral', weekday: currentWeekday };
  }

  const cpaWeaknessRatio = current.cpa / medianCpa;
  const efficiencyWeaknessRatio = medianEfficiency / current.purchaseEfficiency;
  const weaknessRatio = Math.max(cpaWeaknessRatio, efficiencyWeaknessRatio);
  const summary = `${currentWeekday} CPA is $${current.cpa.toFixed(2)} versus a $${medianCpa.toFixed(2)} median weekday CPA`;

  if (weaknessRatio > suppressRatio) {
    return {
      status: 'suppress',
      weekday: currentWeekday,
      weaknessRatio,
      currentCpa: current.cpa,
      medianCpa,
      reason: `${currentWeekday} is materially underperforming the weekday baseline — ${summary}`,
    };
  }

  if (weaknessRatio >= cautionRatio) {
    return {
      status: 'caution',
      weekday: currentWeekday,
      weaknessRatio,
      currentCpa: current.cpa,
      medianCpa,
      reason: `${currentWeekday} is softer than the weekday baseline — ${summary}`,
    };
  }

  return {
    status: 'favorable',
    weekday: currentWeekday,
    weaknessRatio,
    currentCpa: current.cpa,
    medianCpa,
    reason: `${currentWeekday} is in line with the weekday baseline — ${summary}`,
  };
}

function buildProfitContext(campaignInsights, revenueData, cogsData, days = 7, referenceDate = getTodayInTimeZone(), options = {}) {
  const {
    paymentFeeRate = config.fees.paymentFeeRate,
    minCoverageRatio = 0.8,
    includeCurrentDay = true,
  } = options;

  if (!revenueData?.dailyRevenue || !cogsData?.dailyCOGS) {
    return null;
  }

  const dailyMerged = transforms.buildDailyMerged(revenueData.dailyRevenue, campaignInsights, cogsData.dailyCOGS);
  const profitWaterfall = transforms.buildProfitWaterfall(dailyMerged, cogsData.dailyCOGS, paymentFeeRate);
  const { windowStart, windowEnd } = resolveWindowBounds(days, referenceDate, { includeCurrentDay });
  const rows = profitWaterfall.filter(row =>
    row?.date
    && windowStart
    && windowEnd
    && row.date >= windowStart
    && row.date <= windowEnd
  );

  if (rows.length === 0) {
    return null;
  }

  const totals = rows.reduce((summary, row) => {
    summary.netRevenue += Number(row?.netRevenue || 0);
    summary.trueNetProfit += Number(row?.trueNetProfit || 0);
    summary.adSpendKRW += Number(row?.adSpendKRW || 0);
    summary.cogs += Number(row?.cogs || 0);
    summary.shipping += Number(row?.cogsShipping || 0);
    summary.paymentFees += Number(row?.paymentFees || 0);
    summary.coveredDays += row?.hasCOGS ? 1 : 0;
    summary.partialCoveredDays += row?.hasPartialCOGS ? 1 : 0;
    summary.coverageWeight += Number.isFinite(row?.cogsCoverageRatio)
      ? row.cogsCoverageRatio
      : row?.hasCOGS
      ? 1
      : 0;
    return summary;
  }, {
    netRevenue: 0,
    trueNetProfit: 0,
    adSpendKRW: 0,
    cogs: 0,
    shipping: 0,
    paymentFees: 0,
    coveredDays: 0,
    partialCoveredDays: 0,
    coverageWeight: 0,
  });

  const coverageRatio = rows.length > 0 ? totals.coverageWeight / rows.length : 0;
  const confidence = coverageRatio >= minCoverageRatio
    ? 'high'
    : coverageRatio >= 0.4
    ? 'medium'
    : 'low';

  return {
    days,
    rowCount: rows.length,
    coveredDays: totals.coveredDays,
    partialCoveredDays: totals.partialCoveredDays,
    coverageWeight: parseFloat(totals.coverageWeight.toFixed(3)),
    coverageRatio,
    hasReliableCoverage: coverageRatio >= minCoverageRatio,
    confidence,
    netRevenue: Math.round(totals.netRevenue),
    trueNetProfit: Math.round(totals.trueNetProfit),
    adSpendKRW: Math.round(totals.adSpendKRW),
    cogs: Math.round(totals.cogs),
    shipping: Math.round(totals.shipping),
    paymentFees: Math.round(totals.paymentFees),
    margin: totals.netRevenue > 0 ? totals.trueNetProfit / totals.netRevenue : 0,
  };
}

module.exports = {
  getWindowStart,
  resolveWindowBounds,
  filterRecentInsights,
  filterAllRecentInsights,
  sumRecentNetRevenue,
  getWeekdayName,
  buildWeekdayScaleContext,
  buildProfitContext,
};
