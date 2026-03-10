// ═══════════════════════════════════════════════════════
// AdPilot — Chart Data Transforms (Server-Side)
// Converts raw/normalized data into chart-ready arrays.
// Frontend receives these arrays and plugs them directly
// into Chart.js — no transformation on the client.
// ═══════════════════════════════════════════════════════

const {
  aggregateInsightsBy,
  calcCPA,
  calcCPC,
  calcCTR,
  calcGrossProfit,
  calcMargin,
  calcROAS,
  convertUsdToKrw,
} = require('../domain/metrics');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toFiniteNumber(value, parse = parseFloat) {
  const parsed = parse(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getActualPurchasesForDate(entry) {
  if (entry && Number.isFinite(entry.purchases)) {
    return entry.purchases;
  }
  return null;
}

/**
 * Merge revenueByDay (dict) + dailyInsights (Meta rows) + daily COGS order counts into a sorted array.
 * @param {Object} revenueByDay – { "2026-03-10": { revenue, refunded, orders }, ... }
 * @param {Array} dailyInsights – raw Meta campaign insight rows
 * @param {Object} dailyCogs – { "2026-03-10": { purchases, refunds, ... }, ... }
 * @returns {Array} [{date, revenue, refunded, netRevenue, orders, spend, spendKrw, purchases, cpa, roas, clicks, impressions, ctr, cpc}, ...]
 */
function buildDailyMerged(revenueByDay, dailyInsights, dailyCogs = null) {
  const byDate = aggregateInsightsBy(
    dailyInsights,
    row => row.date_start,
    date => ({ date, revenue: 0, refunded: 0, orders: 0, actualPurchases: null })
  );

  if (revenueByDay && typeof revenueByDay === 'object' && !Array.isArray(revenueByDay)) {
    for (const [date, value] of Object.entries(revenueByDay)) {
      if (!byDate[date]) {
        byDate[date] = {
          date,
          revenue: 0,
          refunded: 0,
          orders: 0,
          spend: 0,
          purchases: 0,
          clicks: 0,
          impressions: 0,
          actualPurchases: null,
        };
      }

      byDate[date].revenue = value.revenue || 0;
      byDate[date].refunded = value.refunded || 0;
      byDate[date].orders = value.orders || 0;

      if (byDate[date].actualPurchases == null) {
        byDate[date].actualPurchases = value.orders || 0;
      }
    }
  }

  if (dailyCogs && typeof dailyCogs === 'object' && !Array.isArray(dailyCogs)) {
    for (const [date, value] of Object.entries(dailyCogs)) {
      if (!byDate[date]) {
        byDate[date] = {
          date,
          revenue: 0,
          refunded: 0,
          orders: 0,
          spend: 0,
          purchases: 0,
          clicks: 0,
          impressions: 0,
          actualPurchases: null,
        };
      }

      byDate[date].actualPurchases = getActualPurchasesForDate(value) ?? 0;
    }
  }

  return Object.values(byDate)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(day => {
      const netRevenue = day.revenue - day.refunded;
      const purchases = day.actualPurchases != null ? day.actualPurchases : (day.orders || 0);

      return {
        ...day,
        purchases,
        netRevenue,
        spendKrw: Math.round(convertUsdToKrw(day.spend)),
        cpa: parseFloat(calcCPA(day.spend, purchases, 0).toFixed(4)),
        roas: parseFloat(calcROAS(netRevenue, day.spend).toFixed(4)),
        ctr: parseFloat(calcCTR(day.clicks, day.impressions).toFixed(4)),
        cpc: parseFloat(calcCPC(day.spend, day.clicks).toFixed(4)),
      };
    });
}

/**
 * Build weekday performance from merged daily data.
 */
function buildWeekdayPerf(daily) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const aggregates = days.map(day => ({
    day,
    spend: 0,
    purchases: 0,
    clicks: 0,
    impressions: 0,
    revenue: 0,
    refunded: 0,
    orders: 0,
  }));

  for (const entry of daily) {
    const weekdayIndex = new Date(`${entry.date}T00:00:00`).getDay();
    const aggregate = aggregates[weekdayIndex];
    aggregate.spend += entry.spend;
    aggregate.purchases += entry.purchases;
    aggregate.clicks += entry.clicks;
    aggregate.impressions += entry.impressions;
    aggregate.revenue += entry.revenue;
    aggregate.refunded += entry.refunded;
    aggregate.orders += entry.orders;
  }

  return aggregates.map(aggregate => ({
    day: aggregate.day.slice(0, 3),
    spend: aggregate.spend,
    purchases: aggregate.purchases,
    cpa: parseFloat(calcCPA(aggregate.spend, aggregate.purchases, 0).toFixed(2)),
    ctr: parseFloat(calcCTR(aggregate.clicks, aggregate.impressions).toFixed(2)),
    revenue: aggregate.revenue,
    refunded: aggregate.refunded,
    orders: aggregate.orders,
    paid: aggregate.revenue,
    net: aggregate.revenue - aggregate.refunded,
  }));
}

/**
 * Build hourly orders from raw flat array [count_0h, count_1h, ... count_23h].
 */
function buildHourlyOrders(hourlyArr) {
  if (!Array.isArray(hourlyArr) || hourlyArr.length === 0) {
    return Array.from({ length: 24 }, (_, index) => ({ hour: index, orders: 0 }));
  }
  return hourlyArr.map((count, index) => ({ hour: index, orders: count ?? 0 }));
}

/**
 * Build weekly aggregates from daily data.
 */
function buildWeeklyAgg(daily) {
  const weeks = {};

  for (const day of daily) {
    const date = new Date(`${day.date}T00:00:00`);
    const weekday = (date.getDay() + 6) % 7;
    const weekStart = new Date(date);
    weekStart.setDate(date.getDate() - weekday);
    const weekKey = weekStart.toISOString().slice(0, 10);

    if (!weeks[weekKey]) {
      weeks[weekKey] = { week: weekKey, revenue: 0, refunded: 0, spend: 0, purchases: 0 };
    }

    weeks[weekKey].revenue += day.revenue;
    weeks[weekKey].refunded += day.refunded;
    weeks[weekKey].spend += day.spend;
    weeks[weekKey].purchases += day.purchases;
  }

  return Object.values(weeks)
    .sort((a, b) => a.week.localeCompare(b.week))
    .map(week => ({
      week: week.week,
      profit: Math.round(calcGrossProfit(week.revenue - week.refunded, 0, week.spend)),
      revenue: week.revenue,
      refunded: week.refunded,
      spend: week.spend,
      purchases: week.purchases,
      cpa: parseFloat(calcCPA(week.spend, week.purchases, 0).toFixed(2)),
    }));
}

/**
 * Build monthly refund comparison.
 */
function buildMonthlyRefunds(daily) {
  const months = {};

  for (const day of daily) {
    const monthKey = day.date.slice(0, 7);
    if (!months[monthKey]) months[monthKey] = { month: monthKey, revenue: 0, refunded: 0 };
    months[monthKey].revenue += day.revenue;
    months[monthKey].refunded += day.refunded;
  }

  return Object.values(months).sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Build daily profit from merged data.
 */
function buildDailyProfit(daily) {
  return daily.map(day => ({
    date: day.date,
    profit: Math.round(calcGrossProfit(day.netRevenue ?? (day.revenue - day.refunded), 0, day.spend)),
  }));
}

/**
 * Build spend transition data for the Spend & CAC chart.
 * The chart still consumes OHLC-shaped points, but highs/lows now come
 * directly from the real day-over-day range instead of fabricated noise.
 */
function buildSpendDaily(dailyMerged) {
  const daily = asArray(dailyMerged).slice().sort((a, b) => a.date.localeCompare(b.date));
  if (daily.length === 0) return [];

  return daily.map((entry, index) => {
    const spendKrw = convertUsdToKrw(entry.spend || 0);
    const previousSpendKrw = index > 0 ? convertUsdToKrw(daily[index - 1].spend || 0) : spendKrw;
    const open = previousSpendKrw;
    const close = spendKrw;
    const high = Math.max(open, close);
    const low = Math.min(open, close);

    return {
      date: entry.date,
      o: Math.round(open),
      h: Math.round(high),
      l: Math.round(low),
      c: Math.round(close),
      spend: Math.round(spendKrw),
      cac: Math.round(calcCPA(spendKrw, entry.purchases || 0, 0)),
      orders: entry.purchases || 0,
    };
  });
}

/**
 * Build profit waterfall data — true net profit per day including COGS, shipping, payment fees.
 */
function buildProfitWaterfall(dailyMerged, dailyCOGS, paymentFeeRate) {
  const cogsDict = dailyCOGS || {};
  const feeRate = paymentFeeRate || 0;

  return asArray(dailyMerged).map(day => {
    const dateKey = (day.date || '').slice(0, 10);
    const netRevenue = day.revenue - day.refunded;
    const cogsEntry = cogsDict[dateKey];
    const hasCOGS = !!cogsEntry;
    const cogs = hasCOGS ? (cogsEntry.cost || cogsEntry.cogs || 0) : 0;
    const cogsShipping = hasCOGS ? (cogsEntry.shipping || 0) : 0;
    const adSpendKRW = convertUsdToKrw(day.spend || 0);
    const paymentFees = netRevenue * feeRate;
    const trueNetProfit = calcGrossProfit(netRevenue, cogs + cogsShipping + paymentFees, day.spend || 0);

    return {
      date: day.date,
      revenue: day.revenue,
      refunded: day.refunded,
      netRevenue,
      cogs,
      cogsShipping,
      adSpendKRW,
      paymentFees: Math.round(paymentFees),
      trueNetProfit: Math.round(trueNetProfit),
      hasCOGS,
    };
  });
}

/**
 * Build campaign-level profit estimates using Meta pixel purchases × avg Imweb AOV.
 */
function buildCampaignProfit(campaignInsights, campaigns, avgAOV, cogsData, totalRevenue) {
  const campaignMap = {};
  for (const campaign of asArray(campaigns)) {
    campaignMap[campaign.id] = campaign;
  }

  const byCampaign = aggregateInsightsBy(campaignInsights, row => row.campaign_id);
  const totalCOGSWithShipping = cogsData ? ((cogsData.totalCOGS || 0) + (cogsData.totalShipping || 0)) : 0;

  const result = Object.entries(byCampaign).map(([campaignId, aggregate]) => {
    const campaign = campaignMap[campaignId] || {};
    const spendKRW = convertUsdToKrw(aggregate.spend);
    const estimatedRevenue = aggregate.purchases * avgAOV;
    const revenueShare = totalRevenue > 0 ? estimatedRevenue / totalRevenue : 0;
    const allocatedCOGS = totalCOGSWithShipping * revenueShare;
    const grossProfit = calcGrossProfit(estimatedRevenue, allocatedCOGS, aggregate.spend);
    const margin = calcMargin(grossProfit, estimatedRevenue);

    return {
      campaignId,
      campaignName: campaign.name || campaignId,
      status: campaign.effective_status || campaign.status || 'UNKNOWN',
      spend: parseFloat(aggregate.spend.toFixed(2)),
      spendKRW: Math.round(spendKRW),
      metaPurchases: aggregate.purchases,
      estimatedRevenue: Math.round(estimatedRevenue),
      allocatedCOGS: Math.round(allocatedCOGS),
      grossProfit: Math.round(grossProfit),
      margin: parseFloat(margin.toFixed(1)),
    };
  });

  return result.sort((a, b) => b.grossProfit - a.grossProfit);
}

/**
 * Build a truthful daily fatigue trend from ad insights.
 * CTR is impression-weighted and frequency is impression-weighted where possible.
 */
function buildFatigueTrend(adInsights) {
  const byDate = {};

  for (const insight of asArray(adInsights)) {
    const date = insight.date_start;
    if (!date) continue;

    if (!byDate[date]) {
      byDate[date] = {
        date,
        clicks: 0,
        impressions: 0,
        frequencyWeightedSum: 0,
        frequencyWeight: 0,
        frequencyFallbackSum: 0,
        frequencyFallbackCount: 0,
      };
    }

    const impressions = toFiniteNumber(insight.impressions, value => Number.parseInt(value, 10));
    const clicks = toFiniteNumber(insight.clicks, value => Number.parseInt(value, 10));
    const frequency = toFiniteNumber(insight.frequency);

    byDate[date].clicks += clicks;
    byDate[date].impressions += impressions;

    if (frequency > 0 && impressions > 0) {
      byDate[date].frequencyWeightedSum += frequency * impressions;
      byDate[date].frequencyWeight += impressions;
    } else if (frequency > 0) {
      byDate[date].frequencyFallbackSum += frequency;
      byDate[date].frequencyFallbackCount++;
    }
  }

  return Object.values(byDate)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(day => ({
      date: day.date,
      ctr: parseFloat(calcCTR(day.clicks, day.impressions).toFixed(4)),
      frequency: parseFloat((
        day.frequencyWeight > 0
          ? day.frequencyWeightedSum / day.frequencyWeight
          : (day.frequencyFallbackCount > 0 ? day.frequencyFallbackSum / day.frequencyFallbackCount : 0)
      ).toFixed(4)),
    }));
}

/**
 * Build data coverage / confidence metrics for COGS.
 */
function buildDataCoverage(dailyMerged, dailyCOGS) {
  const cogsDict = dailyCOGS || {};
  const totalDays = dailyMerged.length;
  const dates = dailyMerged.map(day => day.date);
  const coveredDates = dates.filter(date => !!cogsDict[date.slice(0, 10)]);
  const daysWithCOGS = coveredDates.length;
  const coverageRatio = totalDays > 0 ? daysWithCOGS / totalDays : 0;

  let level;
  let label;
  let color;

  if (coverageRatio >= 0.8) {
    level = 'high';
    label = 'High confidence';
    color = '#4ade80';
  } else if (coverageRatio >= 0.4) {
    level = 'medium';
    label = 'Medium confidence';
    color = '#fbbf24';
  } else {
    level = 'low';
    label = 'Low confidence';
    color = '#f87171';
  }

  const sortedCovered = coveredDates.sort();
  const cogsCoveredRange = sortedCovered.length > 0
    ? { from: sortedCovered[0], to: sortedCovered[sortedCovered.length - 1] }
    : { from: null, to: null };

  const missingRanges = [];
  let gapStart = null;

  for (const date of dates) {
    const key = date.slice(0, 10);
    if (!cogsDict[key]) {
      if (!gapStart) gapStart = date;
    } else if (gapStart) {
      const previous = dates[dates.indexOf(date) - 1] || gapStart;
      missingRanges.push(gapStart === previous ? gapStart : `${gapStart} → ${previous}`);
      gapStart = null;
    }
  }

  if (gapStart) {
    const last = dates[dates.length - 1];
    missingRanges.push(gapStart === last ? gapStart : `${gapStart} → ${last}`);
  }

  return {
    totalDays,
    daysWithCOGS,
    coverageRatio: parseFloat(coverageRatio.toFixed(3)),
    confidence: { level, label, color },
    cogsCoveredRange,
    missingRanges,
  };
}

module.exports = {
  buildDailyMerged,
  buildWeekdayPerf,
  buildHourlyOrders,
  buildWeeklyAgg,
  buildMonthlyRefunds,
  buildDailyProfit,
  buildSpendDaily,
  buildProfitWaterfall,
  buildCampaignProfit,
  buildFatigueTrend,
  buildDataCoverage,
};
