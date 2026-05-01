const { buildFinancialProjection } = require('./financialProjectionService');
const { KST_TIME_ZONE, formatDateInTimeZone, shiftDate } = require('../domain/time');
const { convertUsdToKrw, getPurchases } = require('../domain/metrics');

const KST_UTC_OFFSET_MS = 9 * 60 * 60 * 1000;
const MONTH_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'long',
});
const MIN_RECORD_HISTORY_DAYS = 7;
const MIN_AVERAGE_HISTORY_DAYS = 3;
const PROFIT_AVERAGE_LOOKBACK_DAYS = 14;

function parseDateKey(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map(value => Number.parseInt(value, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  return { year, month, day };
}

function dateKeyToKstMidnightUtc(dateKey) {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return null;
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day) - KST_UTC_OFFSET_MS);
}

function getNextKstMidnightAt(now = new Date()) {
  const currentKstDate = formatDateInTimeZone(now, KST_TIME_ZONE);
  const nextKstDate = shiftDate(currentKstDate, 1);
  return dateKeyToKstMidnightUtc(nextKstDate);
}

function resolveDailyReportDate(now = new Date()) {
  const currentKstDate = formatDateInTimeZone(now, KST_TIME_ZONE);
  return shiftDate(currentKstDate, -1);
}

function getOrdinalSuffix(day) {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';

  switch (day % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

function formatReportDate(dateKey) {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return 'Unknown Date';

  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  return `${parsed.day}${getOrdinalSuffix(parsed.day)} ${MONTH_FORMATTER.format(date)}`;
}

function asFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatWholeNumber(value) {
  return Math.round(asFiniteNumber(value)).toLocaleString('en-US');
}

function formatKrw(value) {
  const rounded = Math.round(asFiniteNumber(value));
  const sign = rounded < 0 ? '-' : '';
  return `${sign}₩${Math.abs(rounded).toLocaleString('en-US')}`;
}

function formatPercent(value) {
  return Number.isFinite(Number(value)) ? `${Math.round(Number(value))}%` : 'N/A';
}

function escapeTelegramHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function divideOrNull(numerator, denominator) {
  const parsedDenominator = asFiniteNumber(denominator);
  if (parsedDenominator <= 0) return null;
  return asFiniteNumber(numerator) / parsedDenominator;
}

function findRowByDate(rows, dateKey) {
  return (Array.isArray(rows) ? rows : []).find(row => row?.date === dateKey) || null;
}

function getDailyRevenue(latestData) {
  const dailyRevenue = latestData?.revenueData?.dailyRevenue;
  return dailyRevenue && typeof dailyRevenue === 'object' && !Array.isArray(dailyRevenue)
    ? dailyRevenue
    : {};
}

function getDateRange(dailyRevenue) {
  const dates = Object.keys(dailyRevenue).sort();
  return {
    firstDate: dates[0] || null,
    lastDate: dates[dates.length - 1] || null,
    dayCount: dates.length,
  };
}

function buildRevenueCoverageDiagnostics(latestData, reportDate) {
  const dailyRevenue = getDailyRevenue(latestData);
  const revenueRange = getDateRange(dailyRevenue);
  const revenueRow = Object.prototype.hasOwnProperty.call(dailyRevenue, reportDate)
    ? dailyRevenue[reportDate]
    : null;
  const cogsRow = latestData?.cogsData?.dailyCOGS?.[reportDate] || null;
  const imwebSource = latestData?.sources?.imweb || {};
  const imwebStatus = String(imwebSource.status || '').toLowerCase();
  const imwebUnavailable = imwebSource.stale === true || imwebStatus === 'error';
  const cogsPurchases = asFiniteNumber(cogsRow?.purchases);
  const cogsCost = asFiniteNumber(cogsRow?.cost ?? cogsRow?.cogs);
  const cogsShipping = asFiniteNumber(cogsRow?.shipping);
  const hasCogsActivity = cogsPurchases > 0 || cogsCost > 0 || cogsShipping > 0;
  const reportAfterRevenueRange = revenueRange.lastDate != null && reportDate > revenueRange.lastDate;
  const reportBeforeRevenueRange = revenueRange.firstDate != null && reportDate < revenueRange.firstDate;

  return {
    reportDate,
    hasRevenueRow: revenueRow != null,
    revenueRange,
    imwebStatus: imwebStatus || null,
    imwebStale: imwebSource.stale === true,
    imwebLastError: typeof imwebSource.lastError === 'string' ? imwebSource.lastError : null,
    hasCogsActivity,
    cogsPurchases,
    unavailable: revenueRow == null && (
      hasCogsActivity
      || reportBeforeRevenueRange
      || (reportAfterRevenueRange && imwebUnavailable)
      || (revenueRange.dayCount === 0 && imwebUnavailable)
    ),
  };
}

function getUnavailableReason(diagnostics) {
  if (!diagnostics.unavailable) return null;
  if (diagnostics.hasCogsActivity) {
    return 'revenue-missing-for-cogs-activity';
  }
  if (diagnostics.revenueRange.lastDate && diagnostics.reportDate > diagnostics.revenueRange.lastDate) {
    return 'revenue-source-does-not-cover-report-date';
  }
  if (diagnostics.revenueRange.firstDate && diagnostics.reportDate < diagnostics.revenueRange.firstDate) {
    return 'report-date-before-revenue-source-range';
  }
  return 'revenue-source-unavailable';
}

function isBeforeReportDate(row, reportDate) {
  return String(row?.date || '') < reportDate;
}

function buildHistoricalPerformanceSignals(projection, totals) {
  const priorRevenueRows = (Array.isArray(projection?.dailyMerged) ? projection.dailyMerged : [])
    .filter(row => isBeforeReportDate(row, totals.reportDate))
    .filter(row => asFiniteNumber(row?.orders) > 0 || asFiniteNumber(row?.revenue) > 0);
  const priorProfitRows = (Array.isArray(projection?.profitWaterfall) ? projection.profitWaterfall : [])
    .filter(row => isBeforeReportDate(row, totals.reportDate))
    .filter(row => row?.hasCOGS && asFiniteNumber(row?.netRevenue) > 0);
  const signals = [];

  if (priorRevenueRows.length >= MIN_RECORD_HISTORY_DAYS) {
    const priorBestOrders = Math.max(...priorRevenueRows.map(row => asFiniteNumber(row?.orders)));
    const priorBestRevenue = Math.max(...priorRevenueRows.map(row => asFiniteNumber(row?.revenue)));

    if (totals.orders > priorBestOrders && priorBestOrders > 0) {
      signals.push({
        type: 'record_orders',
        current: totals.orders,
        previousBest: priorBestOrders,
      });
    }
    if (totals.revenue > priorBestRevenue && priorBestRevenue > 0) {
      signals.push({
        type: 'record_revenue',
        current: totals.revenue,
        previousBest: priorBestRevenue,
      });
    }
  }

  const averageRows = priorProfitRows.slice(-PROFIT_AVERAGE_LOOKBACK_DAYS);
  if (totals.profitAvailable && averageRows.length >= MIN_AVERAGE_HISTORY_DAYS) {
    const averageProfit = averageRows.reduce((sum, row) => sum + asFiniteNumber(row?.trueNetProfit), 0) / averageRows.length;
    if (averageProfit > 0 && totals.trueNetProfit > averageProfit) {
      signals.push({
        type: 'profit_above_recent_average',
        current: totals.trueNetProfit,
        average: averageProfit,
        liftPct: ((totals.trueNetProfit - averageProfit) / averageProfit) * 100,
        daysCompared: averageRows.length,
      });
    }
  }

  return signals;
}

function buildDailyReportTotals(latestData, reportDate) {
  const projection = buildFinancialProjection(latestData || {});
  const revenueRow = findRowByDate(projection.dailyMerged, reportDate);
  const profitRow = findRowByDate(projection.profitWaterfall, reportDate);
  const orders = asFiniteNumber(revenueRow?.orders);
  const revenue = asFiniteNumber(profitRow?.revenue ?? revenueRow?.revenue);
  const refunds = asFiniteNumber(profitRow?.refunded ?? revenueRow?.refunded);
  const netRevenue = asFiniteNumber(profitRow?.netRevenue ?? revenueRow?.netRevenue ?? (revenue - refunds));
  const cogs = asFiniteNumber(profitRow?.cogs);
  const shipping = asFiniteNumber(profitRow?.cogsShipping);
  const cogsWithShipping = cogs + shipping;
  const adSpendKrw = asFiniteNumber(profitRow?.adSpendKRW ?? revenueRow?.spendKrw);
  const paymentFees = asFiniteNumber(profitRow?.paymentFees);
  const trueNetProfit = asFiniteNumber(profitRow?.trueNetProfit);
  const profitAvailable = !profitRow || profitRow.hasCOGS || orders === 0;
  const marginRatio = profitAvailable ? divideOrNull(trueNetProfit, netRevenue) : null;
  const refundRateRatio = divideOrNull(refunds, revenue);
  const cogsShareRatio = divideOrNull(cogsWithShipping, netRevenue);
  const roasRatio = divideOrNull(netRevenue, adSpendKrw);

  const totals = {
    reportDate,
    orders,
    revenue,
    refunds,
    netRevenue,
    cogs,
    shipping,
    cogsWithShipping,
    adSpendKrw,
    paymentFees,
    trueNetProfit,
    profitAvailable,
    marginPct: marginRatio == null ? null : marginRatio * 100,
    refundRatePct: refundRateRatio == null ? null : refundRateRatio * 100,
    cogsSharePct: cogsShareRatio == null ? null : cogsShareRatio * 100,
    roas: roasRatio,
  };

  return {
    ...totals,
    historicalSignals: buildHistoricalPerformanceSignals(projection, totals),
  };
}

function hashDateKey(dateKey) {
  return String(dateKey || '').split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function chooseDateVariant(dateKey, variants) {
  if (!Array.isArray(variants) || variants.length === 0) return '';
  return variants[hashDateKey(dateKey) % variants.length];
}

function getCampaignLabel(row) {
  return String(row?.campaign_name || row?.campaignName || row?.campaign_id || row?.campaignId || 'Unnamed campaign').trim();
}

function buildDailyCampaignSummaries(latestData, reportDate) {
  const fxRate = asFiniteNumber(latestData?.fx?.usdToKrwRate, null);
  const campaigns = new Map();

  for (const row of Array.isArray(latestData?.campaignInsights) ? latestData.campaignInsights : []) {
    if (row?.date_start !== reportDate) continue;

    const key = String(row?.campaign_id || row?.campaignId || getCampaignLabel(row));
    const current = campaigns.get(key) || {
      campaignId: key,
      name: getCampaignLabel(row),
      spendUsd: 0,
      spendKrw: 0,
      purchases: 0,
    };
    const spendUsd = asFiniteNumber(row?.spend);
    current.spendUsd += spendUsd;
    current.spendKrw += Math.round(convertUsdToKrw(spendUsd, fxRate || undefined));
    current.purchases += getPurchases(row?.actions);
    campaigns.set(key, current);
  }

  return [...campaigns.values()]
    .filter(campaign => campaign.spendKrw > 0 || campaign.purchases > 0)
    .sort((left, right) => right.spendKrw - left.spendKrw);
}

function buildCampaignWatchInsights(totals, latestData = {}) {
  const campaigns = buildDailyCampaignSummaries(latestData, totals.reportDate);
  const totalSpend = campaigns.reduce((sum, campaign) => sum + campaign.spendKrw, 0);
  const totalPurchases = campaigns.reduce((sum, campaign) => sum + campaign.purchases, 0);
  const insights = [];

  if (totalSpend <= 0) {
    return insights;
  }

  const zeroPurchaseCampaign = campaigns
    .filter(campaign => campaign.purchases <= 0)
    .sort((left, right) => right.spendKrw - left.spendKrw)[0];
  const zeroPurchaseThreshold = Math.max(10000, totalSpend * 0.15);
  if (zeroPurchaseCampaign && zeroPurchaseCampaign.spendKrw >= zeroPurchaseThreshold) {
    insights.push(
      `👀 <b>Campaign watch:</b> ${escapeTelegramHtml(zeroPurchaseCampaign.name)} spent ${formatKrw(zeroPurchaseCampaign.spendKrw)} with 0 Meta purchases`
    );
  }

  if (totalPurchases <= 0 && totals.orders > 0) {
    insights.push(`⚠️ <b>Attribution watch:</b> Meta shows 0 purchases while Imweb has ${formatWholeNumber(totals.orders)} order${totals.orders === 1 ? '' : 's'}`);
    return insights.slice(0, 2);
  }

  const bestCpaCampaign = campaigns
    .filter(campaign => campaign.purchases > 0 && campaign.spendKrw > 0)
    .sort((left, right) => (left.spendKrw / left.purchases) - (right.spendKrw / right.purchases))[0];
  if (bestCpaCampaign) {
    insights.push(
      `🎯 <b>Best Meta signal:</b> ${escapeTelegramHtml(bestCpaCampaign.name)} drove ${formatWholeNumber(bestCpaCampaign.purchases)} purchase${bestCpaCampaign.purchases === 1 ? '' : 's'} at ${formatKrw(bestCpaCampaign.spendKrw / bestCpaCampaign.purchases)} CPA`
    );
  }

  const topCampaign = campaigns[0];
  if (topCampaign && campaigns.length > 1) {
    const spendShare = divideOrNull(topCampaign.spendKrw, totalSpend);
    if (spendShare != null && spendShare >= 0.5) {
      insights.push(
        `📌 <b>Spend concentration:</b> ${escapeTelegramHtml(topCampaign.name)} used ${formatPercent(spendShare * 100)} of Meta spend`
      );
    }
  }

  return insights.slice(0, 2);
}

function buildHistoricalPerformanceInsights(totals) {
  const insights = [];

  for (const signal of Array.isArray(totals?.historicalSignals) ? totals.historicalSignals : []) {
    if (signal.type === 'record_orders') {
      insights.push(
        `🏆 <b>New orders high:</b> ${formatWholeNumber(signal.current)} orders beat the previous best of ${formatWholeNumber(signal.previousBest)}`
      );
    } else if (signal.type === 'record_revenue') {
      insights.push(
        `🏆 <b>New sales high:</b> ${formatKrw(signal.current)} beat the previous best of ${formatKrw(signal.previousBest)}`
      );
    } else if (signal.type === 'profit_above_recent_average') {
      insights.push(
        `🎉 <b>Profit signal:</b> ${formatKrw(signal.current)} is ${formatPercent(signal.liftPct)} above the recent ${formatWholeNumber(signal.daysCompared)}-day average`
      );
    }
  }

  return insights.slice(0, 3);
}

function getReportMood(totals, latestData = {}) {
  const sourceAuditFailed = latestData?.sourceAudit?.reconciliation?.status
    && latestData.sourceAudit.reconciliation.status !== 'reconciled';
  const orderAuditFailed = latestData?.orderNotificationAudit?.status === 'failed';

  if (sourceAuditFailed || orderAuditFailed) {
    return chooseDateVariant(totals.reportDate, [
      'Data check needed',
      'Audit review needed',
      'Pipeline needs a look',
    ]);
  }
  if (!totals.profitAvailable) {
    return chooseDateVariant(totals.reportDate, [
      'COGS pending',
      'Profit pending final costs',
      'Waiting on cost coverage',
    ]);
  }
  if (totals.orders <= 0 || totals.revenue <= 0) {
    return chooseDateVariant(totals.reportDate, [
      'Quiet sales day',
      'Low activity day',
      'No revenue recorded',
    ]);
  }
  if (totals.trueNetProfit < 0) {
    return chooseDateVariant(totals.reportDate, [
      'Below break-even',
      'Loss day after costs',
      'Cost pressure day',
    ]);
  }
  if (Number(totals.marginPct) >= 20) {
    return chooseDateVariant(totals.reportDate, [
      'Strong profit day',
      'Healthy profit day',
      'Clean profit day',
    ]);
  }

  return chooseDateVariant(totals.reportDate, [
    'Positive margin day',
    'Profitable day',
    'Steady profit day',
  ]);
}

function buildDailyReportInsights(totals, latestData = {}) {
  const insights = [];
  const sourceAudit = latestData?.sourceAudit;
  const failedSourceChecks = Array.isArray(sourceAudit?.reconciliation?.failedChecks)
    ? sourceAudit.reconciliation.failedChecks
    : [];
  const orderAudit = latestData?.orderNotificationAudit;
  const orderAuditIssues = asFiniteNumber(orderAudit?.summary?.missingDeliveryCount)
    + asFiniteNumber(orderAudit?.summary?.staleNotificationCount);

  if (sourceAudit?.reconciliation?.status && sourceAudit.reconciliation.status !== 'reconciled') {
    insights.push(`⚠️ <b>Data check:</b> ${formatWholeNumber(failedSourceChecks.length)} source audit issue${failedSourceChecks.length === 1 ? '' : 's'}`);
  }
  if (orderAudit?.status === 'failed') {
    insights.push(`⚠️ <b>Telegram audit:</b> ${formatWholeNumber(orderAuditIssues)} order alert issue${orderAuditIssues === 1 ? '' : 's'}`);
  }
  if (!totals.profitAvailable) {
    insights.push('⏳ <b>Watch:</b> profit is pending final COGS coverage');
  } else if (totals.orders <= 0 || totals.revenue <= 0) {
    insights.push('ℹ️ <b>Readout:</b> no revenue activity recorded for the day');
  } else if (totals.trueNetProfit < 0) {
    insights.push(`⚠️ <b>Watch:</b> loss after costs was ${formatKrw(totals.trueNetProfit)}`);
  }

  insights.push(...buildHistoricalPerformanceInsights(totals));
  insights.push(...buildCampaignWatchInsights(totals, latestData));

  return insights.slice(0, 3);
}

function buildDailyReportMessage(totals, latestData = {}) {
  const profitText = totals.profitAvailable
    ? formatKrw(totals.trueNetProfit)
    : 'N/A (COGS pending)';
  const totalCosts = totals.cogsWithShipping + totals.adSpendKrw + totals.paymentFees;
  const marginText = totals.profitAvailable ? formatPercent(totals.marginPct) : 'N/A';
  const insights = buildDailyReportInsights(totals, latestData);
  const insightSection = insights.length > 0
    ? `\n\n${insights.join('\n')}`
    : '';

  return `📊 <b>Summary Report on ${formatReportDate(totals.reportDate)}</b>
<i>${getReportMood(totals, latestData)}</i>

📦 <b>Total Orders:</b> ${formatWholeNumber(totals.orders)}
💰 <b>Total Revenue:</b> ${formatKrw(totals.revenue)}
📈 <b>Total Profits:</b> ${profitText}
📐 <b>Net Profit Margin:</b> ${marginText}
❌ <b>Total Refunds:</b> ${formatKrw(totals.refunds)}

🧾 <b>Total Costs:</b> ${formatKrw(totalCosts)}
   └ COGS: ${formatKrw(totals.cogs)}
   └ Shipping: ${formatKrw(totals.shipping)}
   └ Payment Fees: ${formatKrw(totals.paymentFees)}
   └ Ad Spend: ${formatKrw(totals.adSpendKrw)}${insightSection}`;
}

function buildDailySummaryReportPlan(latestData, state, now = new Date()) {
  const reportDate = resolveDailyReportDate(now);
  if (!reportDate) {
    return { shouldSend: false, reason: 'invalid-report-date', reportDate: null, text: null };
  }

  if (state?.dailyReport?.reportDate === reportDate) {
    return { shouldSend: false, reason: 'daily-report-already-sent', reportDate, text: null };
  }

  const diagnostics = buildRevenueCoverageDiagnostics(latestData, reportDate);
  if (diagnostics.unavailable) {
    return {
      shouldSend: false,
      reason: getUnavailableReason(diagnostics),
      reportDate,
      text: null,
      diagnostics,
    };
  }

  const totals = buildDailyReportTotals(latestData, reportDate);
  return {
    shouldSend: true,
    reason: 'scheduled-daily-report',
    reportDate,
    text: buildDailyReportMessage(totals, latestData),
    totals,
  };
}

module.exports = {
  buildCampaignWatchInsights,
  buildDailyCampaignSummaries,
  buildDailySummaryReportPlan,
  buildDailyReportInsights,
  buildDailyReportMessage,
  buildDailyReportTotals,
  buildHistoricalPerformanceInsights,
  buildHistoricalPerformanceSignals,
  buildRevenueCoverageDiagnostics,
  dateKeyToKstMidnightUtc,
  formatKrw,
  formatReportDate,
  getNextKstMidnightAt,
  resolveDailyReportDate,
};
