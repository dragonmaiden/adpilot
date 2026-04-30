const { buildFinancialProjection } = require('./financialProjectionService');
const { KST_TIME_ZONE, formatDateInTimeZone, shiftDate } = require('../domain/time');

const KST_UTC_OFFSET_MS = 9 * 60 * 60 * 1000;
const MONTH_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'long',
});

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

function buildDailyReportTotals(latestData, reportDate) {
  const projection = buildFinancialProjection(latestData || {});
  const revenueRow = findRowByDate(projection.dailyMerged, reportDate);
  const profitRow = findRowByDate(projection.profitWaterfall, reportDate);
  const orders = asFiniteNumber(revenueRow?.orders);
  const revenue = asFiniteNumber(profitRow?.revenue ?? revenueRow?.revenue);
  const refunds = asFiniteNumber(profitRow?.refunded ?? revenueRow?.refunded);
  const trueNetProfit = asFiniteNumber(profitRow?.trueNetProfit);
  const profitAvailable = !profitRow || profitRow.hasCOGS || orders === 0;

  return {
    reportDate,
    orders,
    revenue,
    refunds,
    trueNetProfit,
    profitAvailable,
  };
}

function buildDailyReportMessage(totals) {
  const profitText = totals.profitAvailable
    ? formatKrw(totals.trueNetProfit)
    : 'N/A (COGS pending)';

  return `📊 <b>Summary Report on ${formatReportDate(totals.reportDate)}</b>

📦 <b>Total Orders:</b> ${formatWholeNumber(totals.orders)}
💰 <b>Total Revenue:</b> ${formatKrw(totals.revenue)}
📈 <b>Total Profits:</b> ${profitText}
❌ <b>Total Refunds:</b> ${formatKrw(totals.refunds)}`;
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
    text: buildDailyReportMessage(totals),
    totals,
  };
}

module.exports = {
  buildDailySummaryReportPlan,
  buildDailyReportMessage,
  buildDailyReportTotals,
  buildRevenueCoverageDiagnostics,
  dateKeyToKstMidnightUtc,
  formatKrw,
  formatReportDate,
  getNextKstMidnightAt,
  resolveDailyReportDate,
};
