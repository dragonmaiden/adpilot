const { buildFinancialProjection } = require('./financialProjectionService');
const { KST_TIME_ZONE, formatDateInTimeZone, shiftDate } = require('../domain/time');

const KST_UTC_OFFSET_MS = 9 * 60 * 60 * 1000;
const MONTH_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'long',
});
const DAILY_REPORT_KST_HOUR = 23;
const DAILY_REPORT_KST_MINUTE = 30;
const DAILY_REPORT_KST_MINUTE_OF_DAY = (DAILY_REPORT_KST_HOUR * 60) + DAILY_REPORT_KST_MINUTE;

function parseDateKey(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map(value => Number.parseInt(value, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  return { year, month, day };
}

function dateKeyToKstTimeUtc(dateKey, hour = 0, minute = 0) {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return null;
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day, hour, minute) - KST_UTC_OFFSET_MS);
}

function getKstMinuteOfDay(now = new Date()) {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) return null;

  const kstDate = new Date(date.getTime() + KST_UTC_OFFSET_MS);
  return (kstDate.getUTCHours() * 60) + kstDate.getUTCMinutes();
}

function getNextDailyReportAt(now = new Date()) {
  const currentTime = new Date(now);
  if (Number.isNaN(currentTime.getTime())) return null;

  const currentKstDate = formatDateInTimeZone(now, KST_TIME_ZONE);
  const todayReportAt = dateKeyToKstTimeUtc(
    currentKstDate,
    DAILY_REPORT_KST_HOUR,
    DAILY_REPORT_KST_MINUTE
  );
  if (todayReportAt && currentTime < todayReportAt) {
    return todayReportAt;
  }

  const nextKstDate = shiftDate(currentKstDate, 1);
  return dateKeyToKstTimeUtc(nextKstDate, DAILY_REPORT_KST_HOUR, DAILY_REPORT_KST_MINUTE);
}

function resolveDailyReportDate(now = new Date()) {
  const currentKstDate = formatDateInTimeZone(now, KST_TIME_ZONE);
  const minuteOfDay = getKstMinuteOfDay(now);
  return minuteOfDay != null && minuteOfDay >= DAILY_REPORT_KST_MINUTE_OF_DAY
    ? currentKstDate
    : shiftDate(currentKstDate, -1);
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

function formatCoveragePercent(value) {
  return Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : '0%';
}

function divideOrNull(numerator, denominator) {
  const parsedDenominator = asFiniteNumber(denominator);
  if (parsedDenominator <= 0) return null;
  return asFiniteNumber(numerator) / parsedDenominator;
}

function getCoverageRatio(row) {
  const ratio = Number(row?.cogsCoverageRatio);
  if (!Number.isFinite(ratio)) {
    if (row?.hasCOGS) return 1;
    if (row?.hasPartialCOGS) return 0.5;
    return 0;
  }
  return Math.max(0, Math.min(1, ratio));
}

function isSourceUnavailable(source) {
  return source?.stale === true || source?.status === 'error' || source?.hasData === false;
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
  const imwebUnavailable = isSourceUnavailable(imwebSource);
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
    unavailable: imwebUnavailable || (revenueRow == null && (
      hasCogsActivity
      || reportBeforeRevenueRange
      || reportAfterRevenueRange
    )),
  };
}

function getUnavailableReason(diagnostics) {
  if (!diagnostics.unavailable) return null;
  if (!diagnostics.hasRevenueRow && diagnostics.hasCogsActivity) {
    return 'revenue-missing-for-cogs-activity';
  }
  if (diagnostics.imwebStale || diagnostics.imwebStatus === 'error') {
    return 'revenue-source-unavailable';
  }
  if (diagnostics.revenueRange.lastDate && diagnostics.reportDate > diagnostics.revenueRange.lastDate) {
    return 'revenue-source-does-not-cover-report-date';
  }
  if (diagnostics.revenueRange.firstDate && diagnostics.reportDate < diagnostics.revenueRange.firstDate) {
    return 'report-date-before-revenue-source-range';
  }
  return 'revenue-source-unavailable';
}

function buildDailyReportTotals(latestData, reportDate, financialDay) {
  if (financialDay?.date !== reportDate || !financialDay.paymentFeesComplete || financialDay.fxStale) {
    throw new Error('Daily report requires the website financial day with actual Payway fees and dated FX');
  }
  const orders = asFiniteNumber(financialDay.orders);
  const revenue = asFiniteNumber(financialDay.revenue);
  const refunds = asFiniteNumber(financialDay.refunded);
  const netRevenue = asFiniteNumber(financialDay.netRevenue);
  const cogs = asFiniteNumber(financialDay.cogs);
  const shipping = asFiniteNumber(financialDay.shipping);
  const cogsWithShipping = cogs + shipping;
  const adSpendKrw = asFiniteNumber(financialDay.adSpendKRW);
  const paymentFees = asFiniteNumber(financialDay.paymentFees);
  const trueNetProfit = asFiniteNumber(financialDay.trueNetProfit);
  const cogsCoverageRatio = getCoverageRatio(financialDay);
  const unavailableSources = ['cogs', 'metaInsights']
    .filter(key => isSourceUnavailable(latestData?.sources?.[key]));
  const financialUnavailableReason = unavailableSources.length > 0
    ? `${unavailableSources.join(', ')} source unavailable or stale`
    : latestData?.sourceAudit?.status === 'mismatch'
      ? 'source reconciliation mismatch'
    : null;
  const sheetIncomplete = Boolean(latestData?.sourceAudit?.status
    && latestData.sourceAudit.status !== 'reconciled');
  const profitAvailable = !financialUnavailableReason && !sheetIncomplete && (financialDay.hasCOGS || orders === 0);
  const profitIsEstimated = !financialUnavailableReason && !profitAvailable
    && cogsCoverageRatio > 0 && (financialDay.hasPartialCOGS || (sheetIncomplete && financialDay.hasCOGS));
  const profitReportable = profitAvailable || profitIsEstimated;
  const marginRatio = profitReportable ? divideOrNull(trueNetProfit, netRevenue) : null;
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
    financialUnavailableReason,
    profitIsEstimated,
    sheetIncomplete,
    cogsCoverageRatio,
    marginPct: marginRatio == null ? null : marginRatio * 100,
    refundRatePct: refundRateRatio == null ? null : refundRateRatio * 100,
    cogsSharePct: cogsShareRatio == null ? null : cogsShareRatio * 100,
    roas: roasRatio,
  };

  return totals;
}

function hashDateKey(dateKey) {
  return String(dateKey || '').split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function chooseDateVariant(dateKey, variants) {
  if (!Array.isArray(variants) || variants.length === 0) return '';
  return variants[hashDateKey(dateKey) % variants.length];
}

function getReportMood(totals, latestData = {}) {
  const sourceAuditFailed = latestData?.sourceAudit?.status
    && latestData.sourceAudit.status !== 'reconciled';
  const orderAuditFailed = latestData?.orderNotificationAudit?.status === 'failed';

  if (sourceAuditFailed || orderAuditFailed) {
    return chooseDateVariant(totals.reportDate, [
      'Data check needed',
      'Audit review needed',
      'Pipeline needs a look',
    ]);
  }
  if (totals.financialUnavailableReason) {
    return 'Financial data unavailable';
  }
  if (totals.profitIsEstimated) {
    return chooseDateVariant(totals.reportDate, [
      'Estimated profit',
      'Partial COGS estimate',
      'Profit estimate active',
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

  if (sourceAudit?.status === 'incomplete') {
    const gaps = sourceAudit.summary?.costCompleteness || {};
    insights.push(`⚠️ <b>COGS Sheet incomplete:</b> ${formatWholeNumber(gaps.missingCostItemCount || 0)} missing cost fields, ${formatWholeNumber(gaps.invalidValueRows || 0)} invalid amounts, ${formatWholeNumber(gaps.unverifiedRecoveryRows || 0)} unverified recoveries, ${formatWholeNumber(gaps.missingOrderNumberRows || 0)} blank order IDs, ${formatWholeNumber(gaps.missingOrderDateRows || 0)} blank dates, ${formatWholeNumber(gaps.missingCustomerNameRows || 0)} blank names`);
  } else if (sourceAudit?.status && sourceAudit.status !== 'reconciled') {
    const unassigned = sourceAudit.summary?.unassignedSourceTotals || {};
    if (Number(unassigned.cogs || 0) || Number(unassigned.shipping || 0)) {
      insights.push(`⚠️ <b>COGS Sheet undated across tabs:</b> ${formatKrw(unassigned.cogs || 0)} COGS, ${formatKrw(unassigned.shipping || 0)} shipping. Profit is not final.`);
    } else {
      const detail = failedSourceChecks.length > 0
        ? `${formatWholeNumber(failedSourceChecks.length)} source mismatch${failedSourceChecks.length === 1 ? '' : 'es'}`
        : 'source data unavailable';
      insights.push(`⚠️ <b>Data check:</b> ${detail}`);
    }
  }
  if (orderAudit?.status === 'failed') {
    insights.push(`⚠️ <b>Telegram audit:</b> ${formatWholeNumber(orderAuditIssues)} order alert issue${orderAuditIssues === 1 ? '' : 's'}`);
  }
  return insights.filter(Boolean).slice(0, 3);
}

function buildDailyReportMessage(totals, latestData = {}) {
  const cogsUnavailable = isSourceUnavailable(latestData?.sources?.cogs);
  const metaUnavailable = isSourceUnavailable(latestData?.sources?.metaInsights);
  const cogsIncomplete = !totals.profitAvailable && !totals.financialUnavailableReason;
  const profitText = totals.financialUnavailableReason
    ? 'N/A (financial source unavailable)'
    : totals.profitAvailable
    ? formatKrw(totals.trueNetProfit)
    : totals.profitIsEstimated
    ? `⚠️ ${formatKrw(totals.trueNetProfit)} est. (${formatCoveragePercent(totals.cogsCoverageRatio)} COGS${totals.sheetIncomplete ? '; Sheet incomplete' : ''})`
    : 'N/A (COGS pending)';
  const totalCosts = cogsUnavailable || metaUnavailable
    ? 'N/A (financial source unavailable)'
    : cogsIncomplete
    ? 'N/A (COGS incomplete)'
    : formatKrw(totals.cogsWithShipping + totals.adSpendKrw + totals.paymentFees);
  const marginText = totals.financialUnavailableReason
    ? 'N/A'
    : totals.profitAvailable
    ? formatPercent(totals.marginPct)
    : totals.profitIsEstimated
    ? `${formatPercent(totals.marginPct)} est.`
    : 'N/A';
  const insights = buildDailyReportInsights(totals, latestData);
  if (totals.financialUnavailableReason) {
    insights.unshift(`⚠️ <b>Financial data:</b> ${totals.financialUnavailableReason}; profit and total costs withheld`);
  } else if (totals.profitIsEstimated) {
    insights.unshift('⚠️ <b>Incomplete COGS:</b> estimated profit may fall as missing costs are entered');
  }
  insights.push(buildMonthlyRefundComparisonLine(latestData, totals.reportDate));
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

🧾 <b>Total Costs:</b> ${totalCosts}
   └ COGS: ${cogsUnavailable ? 'N/A (source stale)' : `${formatKrw(totals.cogs)}${cogsIncomplete ? ' recorded so far; incomplete' : ''}`}
   └ Shipping: ${cogsUnavailable ? 'N/A (source stale)' : `${formatKrw(totals.shipping)}${cogsIncomplete ? ' recorded so far; incomplete' : ''}`}
   └ Payment Fees: ${formatKrw(totals.paymentFees)}
   └ Ad Spend: ${metaUnavailable ? 'N/A (source stale)' : formatKrw(totals.adSpendKrw)}${insightSection}`;
}

function buildMonthlyRefundComparisonLine(latestData, reportDate) {
  const source = latestData?.sources?.imweb;
  if (source?.stale || source?.status === 'error' || source?.hasData === false) {
    return '↩️ <b>MTD return/refund rate:</b> N/A — order source unavailable or stale';
  }
  // Resolve lazily: calendarService loads the scheduler, which also uses this report service.
  const {
    buildAllTimeOrderPatterns,
    buildRefundWindowSummary,
    buildHistoricalMonthlyRefundAverage,
  } = require('./calendarService');
  const monthStart = `${reportDate.slice(0, 7)}-01`;
  const orders = Array.isArray(latestData?.orders) ? latestData.orders : [];
  const rangeStart = buildAllTimeOrderPatterns(buildFinancialProjection(latestData || {})).range.start;
  const current = buildRefundWindowSummary({ orders, start: monthStart, end: reportDate });
  const historical = buildHistoricalMonthlyRefundAverage({
    orders,
    start: rangeStart,
    end: shiftDate(monthStart, -1),
  });
  const formatRate = value => value == null ? 'N/A' : `${value.toFixed(1)}%`;
  return `↩️ <b>MTD return/refund rate (revenue):</b>\n<b>${formatRate(current.revenueRate)} vs ${formatRate(historical.revenueRate)}</b>\nHistorical monthly average (cancellations excluded)`;
}

function buildDailySummaryReportPlan(latestData, state, now = new Date(), financialDay = null) {
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

  if (!financialDay) {
    return { shouldSend: false, reason: 'financial-day-unavailable', reportDate, text: null };
  }
  const totals = buildDailyReportTotals(latestData, reportDate, financialDay);
  return {
    shouldSend: true,
    reason: 'scheduled-daily-report',
    reportDate,
    text: buildDailyReportMessage(totals, latestData),
    totals,
  };
}

function buildDailyReportCorrectionPlan(latestData, reportDate, options = {}) {
  if (!parseDateKey(reportDate)) {
    return { shouldCorrect: false, reason: 'invalid-report-date', reportDate: null, text: null };
  }

  const diagnostics = buildRevenueCoverageDiagnostics(latestData, reportDate);
  if (diagnostics.unavailable) {
    return {
      shouldCorrect: false,
      reason: getUnavailableReason(diagnostics),
      reportDate,
      text: null,
      diagnostics,
    };
  }

  if (!options.financialDay) {
    return { shouldCorrect: false, reason: 'financial-day-unavailable', reportDate, text: null };
  }
  const totals = buildDailyReportTotals(latestData, reportDate, options.financialDay);
  if (totals.financialUnavailableReason) {
    return {
      shouldCorrect: false,
      reason: 'financial-source-unavailable',
      reportDate,
      text: null,
      totals,
      diagnostics,
    };
  }
  if (totals.profitIsEstimated && options.allowEstimated === true) {
    return {
      shouldCorrect: true,
      reason: 'cogs-partial-estimate',
      reportDate,
      text: buildDailyReportMessage(totals, latestData),
      totals,
      diagnostics,
    };
  }

  if (!totals.profitAvailable) {
    return {
      shouldCorrect: false,
      reason: 'profit-still-pending-cogs',
      reportDate,
      text: null,
      totals,
      diagnostics,
    };
  }

  return {
    shouldCorrect: true,
    reason: 'cogs-complete',
    reportDate,
    text: buildDailyReportMessage(totals, latestData),
    totals,
    diagnostics,
  };
}

module.exports = {
  buildDailyReportCorrectionPlan,
  buildDailySummaryReportPlan,
  buildDailyReportInsights,
  buildDailyReportMessage,
  buildDailyReportTotals,
  buildRevenueCoverageDiagnostics,
  dateKeyToKstTimeUtc,
  formatKrw,
  formatReportDate,
  getNextDailyReportAt,
  resolveDailyReportDate,
};
