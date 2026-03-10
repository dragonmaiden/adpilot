// ═══════════════════════════════════════════════════════
// AdPilot — Chart Data Transforms (Server-Side)
// Converts raw/normalized data into chart-ready arrays.
// Frontend receives these arrays and plugs them directly
// into Chart.js — no transformation on the client.
// ═══════════════════════════════════════════════════════

const config = require('../config');
const { PURCHASE_ACTION_TYPES } = require('../helpers/metrics');

const USD_TO_KRW = config.currency.usdToKrw;

/**
 * Merge revenueByDay (dict) + dailyInsights (Meta rows) into a sorted array.
 * @param {Object} revenueByDay  – { "2026-03-10": { revenue, refunded, orders }, ... }
 * @param {Array}  dailyInsights – raw Meta campaign insight rows
 * @returns {Array} [{date, revenue, refunded, orders, spend, purchases, clicks, impressions, ctr, cpc}, ...]
 */
function buildDailyMerged(revenueByDay, dailyInsights) {
  const byDate = {};

  // Aggregate ad insights by date
  for (const row of (dailyInsights || [])) {
    const d = row.date_start;
    if (!d) continue;
    if (!byDate[d]) byDate[d] = { date: d, revenue: 0, refunded: 0, orders: 0, spend: 0, purchases: 0, clicks: 0, impressions: 0 };
    byDate[d].spend += parseFloat(row.spend || 0);
    byDate[d].clicks += parseInt(row.clicks || 0);
    byDate[d].impressions += parseInt(row.impressions || 0);
    const acts = row.actions || [];
    for (const a of acts) {
      if (PURCHASE_ACTION_TYPES.includes(a.action_type)) {
        byDate[d].purchases += parseInt(a.value || 0);
      }
    }
  }

  // Merge revenue data (dict keyed by date)
  if (revenueByDay && typeof revenueByDay === 'object' && !Array.isArray(revenueByDay)) {
    for (const [d, v] of Object.entries(revenueByDay)) {
      if (!byDate[d]) byDate[d] = { date: d, revenue: 0, refunded: 0, orders: 0, spend: 0, purchases: 0, clicks: 0, impressions: 0 };
      byDate[d].revenue = v.revenue || 0;
      byDate[d].refunded = v.refunded || 0;
      byDate[d].orders = v.orders || 0;
    }
  }

  // Compute derived metrics and sort
  return Object.values(byDate)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(d => ({
      ...d,
      ctr: d.impressions > 0 ? parseFloat((d.clicks / d.impressions * 100).toFixed(4)) : 0,
      cpc: d.clicks > 0 ? parseFloat((d.spend / d.clicks).toFixed(4)) : 0,
    }));
}

/**
 * Build weekday performance from merged daily data.
 * @param {Array} daily – output of buildDailyMerged
 * @returns {Array} [{day: 'Mon', spend, purchases, cpa, ctr, revenue, refunded, orders, paid, net}, ...]
 */
function buildWeekdayPerf(daily) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const agg = days.map(d => ({ day: d, spend: 0, purchases: 0, clicks: 0, impressions: 0, revenue: 0, refunded: 0, orders: 0, count: 0 }));
  for (const d of daily) {
    const dow = new Date(d.date + 'T00:00:00').getDay();
    agg[dow].spend += d.spend;
    agg[dow].purchases += d.purchases;
    agg[dow].clicks += d.clicks;
    agg[dow].impressions += d.impressions;
    agg[dow].revenue += d.revenue;
    agg[dow].refunded += d.refunded;
    agg[dow].orders += d.orders;
    agg[dow].count++;
  }
  return agg.map(d => ({
    day: d.day.slice(0, 3),
    spend: d.spend,
    purchases: d.purchases,
    cpa: d.purchases > 0 ? parseFloat((d.spend / d.purchases).toFixed(2)) : 0,
    ctr: d.impressions > 0 ? parseFloat((d.clicks / d.impressions * 100).toFixed(2)) : 0,
    revenue: d.revenue,
    refunded: d.refunded,
    orders: d.orders,
    paid: d.revenue,
    net: d.revenue - d.refunded,
  }));
}

/**
 * Build hourly orders from raw flat array [count_0h, count_1h, ... count_23h].
 * @param {Array} hourlyArr – flat array of 24 counts
 * @returns {Array} [{hour: 0, orders: 9}, {hour: 1, orders: 1}, ...]
 */
function buildHourlyOrders(hourlyArr) {
  if (!Array.isArray(hourlyArr) || hourlyArr.length === 0) {
    return Array.from({ length: 24 }, (_, i) => ({ hour: i, orders: 0 }));
  }
  return hourlyArr.map((count, i) => ({ hour: i, orders: count ?? 0 }));
}

/**
 * Build weekly aggregates from daily data.
 * @param {Array} daily – output of buildDailyMerged
 * @returns {Array} [{week, profit, revenue, refunded, spend, purchases, cpa}, ...]
 */
function buildWeeklyAgg(daily) {
  const weeks = {};
  for (const d of daily) {
    const dt = new Date(d.date + 'T00:00:00');
    // Week starts Monday
    const dayOfWeek = (dt.getDay() + 6) % 7;
    const weekStart = new Date(dt);
    weekStart.setDate(dt.getDate() - dayOfWeek);
    const weekKey = weekStart.toISOString().slice(0, 10);
    if (!weeks[weekKey]) weeks[weekKey] = { week: weekKey, revenue: 0, refunded: 0, spend: 0, purchases: 0, spendKrw: 0 };
    weeks[weekKey].revenue += d.revenue;
    weeks[weekKey].refunded += d.refunded;
    weeks[weekKey].spend += d.spend;
    weeks[weekKey].purchases += d.purchases;
    weeks[weekKey].spendKrw += d.spend * USD_TO_KRW;
  }
  return Object.values(weeks).sort((a, b) => a.week.localeCompare(b.week)).map(w => ({
    week: w.week,
    profit: w.revenue - w.refunded - w.spendKrw,
    revenue: w.revenue,
    refunded: w.refunded,
    spend: w.spend,
    purchases: w.purchases,
    cpa: w.purchases > 0 ? parseFloat((w.spend / w.purchases).toFixed(2)) : 0,
  }));
}

/**
 * Build monthly refund comparison.
 * @param {Array} daily – output of buildDailyMerged
 * @returns {Array} [{month: '2026-03', revenue, refunded}, ...]
 */
function buildMonthlyRefunds(daily) {
  const months = {};
  for (const d of daily) {
    const mKey = d.date.slice(0, 7);
    if (!months[mKey]) months[mKey] = { month: mKey, revenue: 0, refunded: 0 };
    months[mKey].revenue += d.revenue;
    months[mKey].refunded += d.refunded;
  }
  return Object.values(months).sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Build daily profit from merged data.
 * @param {Array} daily – output of buildDailyMerged
 * @returns {Array} [{date, profit}, ...]
 */
function buildDailyProfit(daily) {
  return daily.map(d => ({
    date: d.date,
    profit: d.revenue - d.refunded - (d.spend * USD_TO_KRW),
  }));
}

/**
 * Build OHLC candlestick data for Spend & CAC chart.
 * @param {Array} campaignInsights – raw Meta insight rows
 * @returns {Array} [{date, o, h, l, c, spend, cac, orders}, ...]
 */
function buildSpendDaily(campaignInsights) {
  const byDate = {};
  for (const row of (campaignInsights || [])) {
    const d = row.date_start;
    if (!d) continue;
    if (!byDate[d]) byDate[d] = { spend: 0, purchases: 0, impressions: 0, clicks: 0 };
    byDate[d].spend += parseFloat(row.spend || 0);
    byDate[d].impressions += parseInt(row.impressions || 0);
    byDate[d].clicks += parseInt(row.clicks || 0);
    const acts = row.actions || [];
    const purchaseAction = acts.find(a => PURCHASE_ACTION_TYPES.includes(a.action_type));
    byDate[d].purchases += purchaseAction ? parseInt(purchaseAction.value || 0) : 0;
  }

  const dates = Object.keys(byDate).sort();
  if (dates.length === 0) return [];

  return dates.map((d, i) => {
    const spend = byDate[d].spend;
    const prevSpend = i > 0 ? byDate[dates[i - 1]].spend : spend;
    const o = prevSpend;
    const c = spend;
    const variance = spend * 0.15;
    const h = Math.max(o, c) + Math.random() * variance;
    const l = Math.max(0, Math.min(o, c) - Math.random() * variance);
    const purchases = byDate[d].purchases;
    const cac = purchases > 0 ? Math.round(spend / purchases) : 0;

    return {
      date: d,
      o: Math.round(o),
      h: Math.round(h),
      l: Math.round(l),
      c: Math.round(c),
      spend: Math.round(spend),
      cac,
      orders: purchases,
    };
  });
}

/**
 * Build profit waterfall data — true net profit per day including COGS, shipping, payment fees.
 * @param {Array} dailyMerged – output of buildDailyMerged
 * @param {Object} dailyCOGS – { "2026-02-10": { cogs, shipping }, ... }
 * @param {number} paymentFeeRate – e.g. 0.033
 * @returns {Array} [{date, revenue, refunded, netRevenue, cogs, cogsShipping, adSpendKRW, paymentFees, trueNetProfit, hasCOGS}, ...]
 */
function buildProfitWaterfall(dailyMerged, dailyCOGS, paymentFeeRate) {
  const cogsDict = dailyCOGS || {};
  const feeRate = paymentFeeRate || 0;

  return dailyMerged.map(d => {
    const dateKey = (d.date || '').slice(0, 10); // defensive normalization
    const netRevenue = d.revenue - d.refunded;
    const cogsEntry = cogsDict[dateKey];
    const hasCOGS = !!cogsEntry;
    const cogs = hasCOGS ? (cogsEntry.cogs || 0) : 0;
    const cogsShipping = hasCOGS ? (cogsEntry.shipping || 0) : 0;
    const adSpendKRW = (d.spend || 0) * USD_TO_KRW;
    const paymentFees = netRevenue * feeRate;
    const trueNetProfit = netRevenue - cogs - cogsShipping - adSpendKRW - paymentFees;

    return {
      date: d.date,
      revenue: d.revenue,
      refunded: d.refunded,
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
 * @param {Array} campaignInsights – raw Meta insight rows
 * @param {Array} campaigns – campaign metadata
 * @param {number} avgAOV – average order value (KRW)
 * @param {Object} cogsData – { totalCOGS, totalShipping, ... }
 * @param {number} totalRevenue – total net revenue (KRW)
 * @param {number} totalOrders – total orders
 * @returns {Array} sorted by grossProfit desc
 */
function buildCampaignProfit(campaignInsights, campaigns, avgAOV, cogsData, totalRevenue, totalOrders) {
  const campaignMap = {};
  for (const c of (campaigns || [])) {
    campaignMap[c.id] = c;
  }

  // Aggregate insights per campaign
  const byCampaign = {};
  for (const row of (campaignInsights || [])) {
    const cid = row.campaign_id;
    if (!cid) continue;
    if (!byCampaign[cid]) byCampaign[cid] = { spend: 0, purchases: 0 };
    byCampaign[cid].spend += parseFloat(row.spend || 0);
    const acts = row.actions || [];
    for (const a of acts) {
      if (PURCHASE_ACTION_TYPES.includes(a.action_type)) {
        byCampaign[cid].purchases += parseInt(a.value || 0);
      }
    }
  }

  const totalCOGSWithShipping = cogsData ? ((cogsData.totalCOGS || 0) + (cogsData.totalShipping || 0)) : 0;

  const result = Object.entries(byCampaign).map(([cid, agg]) => {
    const camp = campaignMap[cid] || {};
    const spendKRW = agg.spend * USD_TO_KRW;
    const estimatedRevenue = agg.purchases * avgAOV;
    // Allocate COGS proportionally based on revenue share
    const revenueShare = totalRevenue > 0 ? estimatedRevenue / totalRevenue : 0;
    const allocatedCOGS = totalCOGSWithShipping * revenueShare;
    const grossProfit = estimatedRevenue - allocatedCOGS - spendKRW;
    const margin = estimatedRevenue > 0 ? (grossProfit / estimatedRevenue * 100) : 0;

    return {
      campaignId: cid,
      campaignName: camp.name || cid,
      status: camp.effective_status || camp.status || 'UNKNOWN',
      spend: parseFloat(agg.spend.toFixed(2)),
      spendKRW: Math.round(spendKRW),
      metaPurchases: agg.purchases,
      estimatedRevenue: Math.round(estimatedRevenue),
      allocatedCOGS: Math.round(allocatedCOGS),
      grossProfit: Math.round(grossProfit),
      margin: parseFloat(margin.toFixed(1)),
    };
  });

  return result.sort((a, b) => b.grossProfit - a.grossProfit);
}

/**
 * Build data coverage / confidence metrics for COGS.
 * @param {Array} dailyMerged – output of buildDailyMerged
 * @param {Object} dailyCOGS – { "2026-02-10": {...}, ... }
 * @returns {Object} { totalDays, daysWithCOGS, coverageRatio, confidence, cogsCoveredRange, missingRanges }
 */
function buildDataCoverage(dailyMerged, dailyCOGS) {
  const cogsDict = dailyCOGS || {};
  const totalDays = dailyMerged.length;
  const dates = dailyMerged.map(d => d.date);
  const coveredDates = dates.filter(d => !!cogsDict[d.slice(0, 10)]);
  const daysWithCOGS = coveredDates.length;
  const coverageRatio = totalDays > 0 ? daysWithCOGS / totalDays : 0;

  let level, label, color;
  if (coverageRatio >= 0.8) {
    level = 'high'; label = 'High confidence'; color = '#4ade80';
  } else if (coverageRatio >= 0.4) {
    level = 'medium'; label = 'Medium confidence'; color = '#fbbf24';
  } else {
    level = 'low'; label = 'Low confidence'; color = '#f87171';
  }

  // Find covered range
  const sortedCovered = coveredDates.sort();
  const cogsCoveredRange = sortedCovered.length > 0
    ? { from: sortedCovered[0], to: sortedCovered[sortedCovered.length - 1] }
    : { from: null, to: null };

  // Find missing ranges (contiguous gaps)
  const missingRanges = [];
  let gapStart = null;
  for (const d of dates) {
    const key = d.slice(0, 10);
    if (!cogsDict[key]) {
      if (!gapStart) gapStart = d;
    } else {
      if (gapStart) {
        const prev = dates[dates.indexOf(d) - 1] || gapStart;
        missingRanges.push(gapStart === prev ? gapStart : `${gapStart} → ${prev}`);
        gapStart = null;
      }
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
  buildDataCoverage,
};
