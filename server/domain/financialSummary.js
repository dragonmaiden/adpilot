const { divideOrNull } = require('./profitWindowMetrics');
const { getOrderCashTotals } = require('./imwebPayments');
const { applyPaywayFeesToFinancialDays } = require('./paywayFinancials');
const { KST_TIME_ZONE, formatDateInTimeZone } = require('./time');

const COUNTED_CANCEL_SECTION_STATUSES = new Set([
  'CANCEL_DONE',
  'RETURN_DONE',
  'EXCHANGE_DONE',
  'CANCEL_REQUEST',
  'RETURN_REQUEST',
]);

function isValidDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function toUtcDate(dateKey) {
  if (!isValidDateKey(dateKey)) return null;
  const [year, month, day] = String(dateKey).split('-').map(value => Number.parseInt(value, 10));
  return new Date(Date.UTC(year, month - 1, day));
}

function fromUtcDate(date) {
  return date instanceof Date && !Number.isNaN(date.getTime())
    ? date.toISOString().slice(0, 10)
    : null;
}

function compareDateKeys(left, right) {
  return String(left || '').localeCompare(String(right || ''));
}

function startOfMonth(dateKey) {
  const date = toUtcDate(dateKey);
  if (!date) return null;
  date.setUTCDate(1);
  return fromUtcDate(date);
}

function endOfMonth(dateKey) {
  const date = toUtcDate(dateKey);
  if (!date) return null;
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return fromUtcDate(date);
}

function shiftMonth(dateKey, deltaMonths) {
  const date = toUtcDate(dateKey);
  if (!date) return null;

  const day = date.getUTCDate();
  const shifted = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + deltaMonths, 1));
  const lastDay = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
  shifted.setUTCDate(Math.min(day, lastDay));
  return fromUtcDate(shifted);
}

function ratioPercentOrNull(numerator, denominator, digits = 1) {
  const ratio = divideOrNull(numerator, denominator);
  return ratio == null ? null : Number((ratio * 100).toFixed(digits));
}

function ratioOrNull(numerator, denominator, digits = 2) {
  const ratio = divideOrNull(numerator, denominator);
  return ratio == null ? null : Number(ratio.toFixed(digits));
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getOrderDateKey(order) {
  return order?.wtime ? formatDateInTimeZone(order.wtime, KST_TIME_ZONE) : null;
}

function getOrderSections(order) {
  if (Array.isArray(order?.sections)) return order.sections;
  if (Array.isArray(order?.orderSections)) return order.orderSections;
  return [];
}

function getOrderPaymentAmounts(order) {
  const { approvedAmount, netPaidAmount, refundedAmount } = getOrderCashTotals(order);
  return {
    payAmount: approvedAmount,
    netAmount: netPaidAmount,
    refundAmount: refundedAmount,
  };
}

function isRecognizedOrder(order) {
  const { payAmount, refundAmount } = getOrderPaymentAmounts(order);
  return payAmount > 0 || refundAmount > 0;
}

function isCountedCancelledSectionStatus(status) {
  return COUNTED_CANCEL_SECTION_STATUSES.has(String(status || '').trim().toUpperCase());
}

function buildOrderMetrics(orders) {
  let recognizedOrders = 0;
  let refundOrders = 0;
  let totalSections = 0;
  let cancelledSections = 0;

  for (const order of Array.isArray(orders) ? orders : []) {
    if (isRecognizedOrder(order)) {
      recognizedOrders += 1;
    }

    const { refundAmount } = getOrderPaymentAmounts(order);
    if (refundAmount > 0) {
      refundOrders += 1;
    }

    for (const section of getOrderSections(order)) {
      totalSections += 1;
      if (isCountedCancelledSectionStatus(section?.orderSectionStatus || section?.orderStatus)) {
        cancelledSections += 1;
      }
    }
  }

  return {
    recognizedOrders,
    refundOrders,
    totalSections,
    cancelledSections,
    cancelRate: totalSections > 0 ? (cancelledSections / totalSections) * 100 : 0,
  };
}

function getRefundDeductionEconomics(order) {
  const { payAmount, refundAmount } = getOrderPaymentAmounts(order);
  const totalRefundedAmount = Math.max(0, toFiniteNumber(refundAmount));
  const sections = getOrderSections(order);
  const sectionStatuses = sections.map(section =>
    String(section?.orderSectionStatus || section?.orderStatus || '').trim().toUpperCase()
  );
  const hasReturnSection = sectionStatuses.some(status => /^RETURN(?:_|$)/.test(status));
  const hasCancellationSection = sectionStatuses.some(status => /^CANCEL(?:_|$)/.test(status));
  const isCancellationOnly = hasCancellationSection
    && sectionStatuses.every(status => /^CANCEL(?:_|$)/.test(status));
  // Imweb combines cancellation and return refunds at order level. Cancellation
  // sections carry their own refund amount, so subtract them before measuring returns.
  const explicitCancellationAmount = Math.min(
    totalRefundedAmount,
    sections.reduce((total, section) => {
      const status = String(
        section?.orderSectionStatus || section?.orderStatus || ''
      ).trim().toUpperCase();
      if (!/^CANCEL(?:_|$)/.test(status)) return total;
      return total + Math.max(0, toFiniteNumber(section?.cancelInfo?.refundAmount));
    }, 0)
  );
  const cancellationRefundedAmount = hasCancellationSection
    ? hasReturnSection
      ? explicitCancellationAmount
      : totalRefundedAmount
    : 0;
  const returnRefundedAmount = hasReturnSection
    ? Math.max(0, totalRefundedAmount - cancellationRefundedAmount)
    : 0;
  const unclassifiedRefundedAmount = Math.max(
    0,
    totalRefundedAmount - returnRefundedAmount - cancellationRefundedAmount
  );
  const eligibleGrossRevenue = isCancellationOnly
    ? 0
    : Math.max(
      0,
      toFiniteNumber(payAmount) - cancellationRefundedAmount - unclassifiedRefundedAmount
    );

  return {
    eligibleGrossRevenue,
    totalRefundedAmount,
    returnRefundedAmount,
    cancellationRefundedAmount,
    unclassifiedRefundedAmount,
  };
}

function buildRefundDeductionMetrics(orders) {
  return (Array.isArray(orders) ? orders : []).reduce((summary, order) => {
    const economics = getRefundDeductionEconomics(order);
    summary.grossRevenue += economics.eligibleGrossRevenue;
    summary.totalRefundedAmount += economics.totalRefundedAmount;
    summary.returnRefundedAmount += economics.returnRefundedAmount;
    summary.cancellationRefundedAmount += economics.cancellationRefundedAmount;
    summary.unclassifiedRefundedAmount += economics.unclassifiedRefundedAmount;
    if (economics.eligibleGrossRevenue > 0) {
      summary.recognizedOrders += 1;
    }
    if (economics.returnRefundedAmount > 0) {
      summary.returnRefundOrders += 1;
    }
    if (economics.cancellationRefundedAmount > 0) {
      summary.cancellationOrders += 1;
    }
    return summary;
  }, {
    grossRevenue: 0,
    totalRefundedAmount: 0,
    returnRefundedAmount: 0,
    cancellationRefundedAmount: 0,
    unclassifiedRefundedAmount: 0,
    recognizedOrders: 0,
    returnRefundOrders: 0,
    cancellationOrders: 0,
  });
}

function buildDayMaps(dailyMerged, profitWaterfall) {
  return {
    mergedByDate: new Map((Array.isArray(dailyMerged) ? dailyMerged : []).map(row => [row.date, row])),
    profitByDate: new Map((Array.isArray(profitWaterfall) ? profitWaterfall : []).map(row => [row.date, row])),
  };
}

function buildSelectionSummary(selectionDays, selectionOrders, coverage, paywaySummary) {
  const dayTotals = (Array.isArray(selectionDays) ? selectionDays : []).reduce((summary, day) => {
    summary.grossRevenue += Number(day?.revenue || 0);
    summary.refundedAmount += Number(day?.refunded || 0);
    summary.netRevenue += Number(day?.netRevenue || 0);
    summary.adSpend += Number(day?.adSpend || 0);
    summary.adSpendKRW += Number(day?.adSpendKRW || 0);
    summary.cogs += Number(day?.cogs || 0);
    summary.shipping += Number(day?.shipping || 0);
    summary.purchaseCogs += Number(day?.purchaseCogs || 0);
    summary.refundCogs += Number(day?.refundCogs || 0);
    summary.purchaseShipping += Number(day?.purchaseShipping || 0);
    summary.refundShipping += Number(day?.refundShipping || 0);
    const hasCostActivity = Boolean(
      day?.hasCOGS
      || day?.hasPartialCOGS
      || Number(day?.purchaseCogs || 0) !== 0
      || Number(day?.refundCogs || 0) !== 0
      || Number(day?.purchaseShipping || 0) !== 0
      || Number(day?.refundShipping || 0) !== 0
    );
    if (hasCostActivity && !day?.sheetTotalsObserved) {
      summary.sheetTotalsComplete = false;
    }
    if (day?.sheetTotalsObserved) {
      summary.cogsSheetTotal += Number(day.cogsSheetTotal || 0);
      summary.shippingSheetTotal += Number(day.shippingSheetTotal || 0);
    }
    if (day?.paymentFees == null || day?.trueNetProfit == null) {
      summary.paymentFeesComplete = false;
    } else {
      summary.paymentFees += Number(day.paymentFees);
      summary.trueNetProfit += Number(day.trueNetProfit);
    }
    summary.metaPurchases += Number(day?.metaPurchases || 0);
    const needsCostCoverage = Number(day?.revenue || 0) > 0
      || Number(day?.refunded || 0) > 0
      || Number(day?.orders || 0) > 0
      || Number(day?.cogs || 0) !== 0
      || Number(day?.shipping || 0) !== 0
      || day?.hasCOGS || day?.hasPartialCOGS;
    if (needsCostCoverage) {
      summary.daysRequiringCOGS += 1;
      if (day?.hasCOGS) summary.daysWithCOGS += 1;
      else if (day?.hasPartialCOGS) summary.daysWithPartialCOGS += 1;
    }
    return summary;
  }, {
    grossRevenue: 0,
    refundedAmount: 0,
    netRevenue: 0,
    adSpend: 0,
    adSpendKRW: 0,
    cogs: 0,
    shipping: 0,
    purchaseCogs: 0,
    refundCogs: 0,
    purchaseShipping: 0,
    refundShipping: 0,
    cogsSheetTotal: 0,
    shippingSheetTotal: 0,
    sheetTotalsComplete: true,
    paymentFees: 0,
    trueNetProfit: 0,
    metaPurchases: 0,
    paymentFeesComplete: true,
    daysRequiringCOGS: 0,
    daysWithCOGS: 0,
    daysWithPartialCOGS: 0,
  });

  const orderMetrics = buildOrderMetrics(selectionOrders);
  const refundDeductions = buildRefundDeductionMetrics(selectionOrders);
  const classifiedRefundedAmount = refundDeductions.returnRefundedAmount
    + refundDeductions.cancellationRefundedAmount;
  const residualRefundedAmount = Math.round(
    dayTotals.refundedAmount - classifiedRefundedAmount
  );
  const refundSplitValid = residualRefundedAmount >= 0;
  const returnRefundedAmount = refundSplitValid
    ? refundDeductions.returnRefundedAmount
    : 0;
  const cancellationRefundedAmount = refundSplitValid
    ? refundDeductions.cancellationRefundedAmount
    : 0;
  const unclassifiedRefundedAmount = refundSplitValid
    ? residualRefundedAmount
    : dayTotals.refundedAmount;
  const paymentFees = dayTotals.paymentFeesComplete ? dayTotals.paymentFees : null;
  const trueNetProfit = dayTotals.paymentFeesComplete ? dayTotals.trueNetProfit : null;
  const totalCosts = paymentFees == null
    ? null
    : dayTotals.cogs + dayTotals.shipping + paymentFees + dayTotals.adSpendKRW;
  const buildCostBridge = ({ sheetTotal, purchaseTotal, refundMarkedTotal, netTotal }) => {
    const sourcePartitionDelta = sheetTotal - purchaseTotal - refundMarkedTotal;
    const netCheckDelta = purchaseTotal - refundMarkedTotal - netTotal;

    return {
      sheetTotal,
      purchaseTotal,
      refundMarkedTotal,
      netTotal,
      sourcePartitionDelta,
      netCheckDelta,
      reconciled: sourcePartitionDelta === 0 && netCheckDelta === 0,
    };
  };
  const costReconciliation = {
    source: 'cogs_sheet',
    basis: 'raw_sheet_columns',
    complete: dayTotals.sheetTotalsComplete,
    coverageComplete: dayTotals.daysWithCOGS === dayTotals.daysRequiringCOGS,
    daysRequiringCOGS: dayTotals.daysRequiringCOGS,
    daysWithCOGS: dayTotals.daysWithCOGS,
    daysWithPartialCOGS: dayTotals.daysWithPartialCOGS,
    cogs: buildCostBridge({
      sheetTotal: dayTotals.cogsSheetTotal,
      purchaseTotal: dayTotals.purchaseCogs,
      refundMarkedTotal: dayTotals.refundCogs,
      netTotal: dayTotals.cogs,
    }),
    shipping: buildCostBridge({
      sheetTotal: dayTotals.shippingSheetTotal,
      purchaseTotal: dayTotals.purchaseShipping,
      refundMarkedTotal: dayTotals.refundShipping,
      netTotal: dayTotals.shipping,
    }),
  };
  costReconciliation.amountsReconcile = costReconciliation.complete
    && costReconciliation.cogs.reconciled
    && costReconciliation.shipping.reconciled;
  costReconciliation.reconciled = costReconciliation.amountsReconcile
    && costReconciliation.coverageComplete;

  return {
    ...dayTotals,
    paymentFees,
    trueNetProfit,
    totalCosts,
    costReconciliation,
    margin: trueNetProfit == null ? null : ratioPercentOrNull(trueNetProfit, dayTotals.netRevenue),
    roas: ratioOrNull(dayTotals.netRevenue, dayTotals.adSpendKRW),
    recognizedOrders: orderMetrics.recognizedOrders,
    refundRate: ratioPercentOrNull(dayTotals.refundedAmount, dayTotals.grossRevenue),
    returnRefundedAmount,
    cancellationRefundedAmount,
    unclassifiedRefundedAmount,
    returnRefundOrders: refundSplitValid ? refundDeductions.returnRefundOrders : 0,
    cancellationOrders: refundSplitValid ? refundDeductions.cancellationOrders : 0,
    cancelRate: Number(orderMetrics.cancelRate.toFixed(1)),
    refundOrders: orderMetrics.refundOrders,
    cancelledSections: orderMetrics.cancelledSections,
    totalSections: orderMetrics.totalSections,
    confidence: coverage?.confidence || { level: 'low', label: 'Waiting for data' },
    cogsCoverageRatio: coverage?.coverageRatio ?? 0,
    daysWithCOGS: coverage?.daysWithCOGS ?? 0,
    daysWithPartialCOGS: coverage?.daysWithPartialCOGS ?? 0,
    totalDays: coverage?.totalDays ?? 0,
    paymentFeeSource: 'payway',
    paymentFeeFetchedAt: paywaySummary?.fetchedAt || null,
    paymentFeeStale: Boolean(paywaySummary?.stale),
    paymentFeeError: paywaySummary?.error || null,
    paymentFeeCoverage: paywaySummary?.ready === true ? {
      complete: paywaySummary?.totals?.feesComplete === true,
      feeRows: Number(paywaySummary?.totals?.feeRows || 0),
      financialRows: Number(paywaySummary?.totals?.financialRows || 0),
    } : {
      complete: false,
      feeRows: 0,
      financialRows: 0,
    },
  };
}

function buildSelectionFxContext({
  selectionDays,
  selectionSummary,
  historicalFx,
  fallbackFx,
  startDate,
  endDate,
} = {}) {
  const days = Array.isArray(selectionDays) ? selectionDays : [];
  const fallbackRate = Number(fallbackFx?.usdToKrwRate);
  const dailyContexts = days.map(day => {
    const historicalContext = historicalFx?.ratesByDate?.[day.date];
    const historicalRate = Number(historicalContext?.usdToKrwRate);
    const rowRate = Number(day?.usdToKrwRate);
    let usdToKrwRate = fallbackRate;

    if (Number.isFinite(historicalRate) && historicalRate > 0) {
      usdToKrwRate = historicalRate;
    } else if (Number.isFinite(rowRate) && rowRate > 0) {
      usdToKrwRate = rowRate;
    }

    return {
      date: day?.date || null,
      usdToKrwRate,
      rateDate: historicalContext?.rateDate || day?.fxRateDate || fallbackFx?.rateDate || null,
      stale: historicalContext
        ? Boolean(historicalFx?.stale || historicalContext.stale)
        : true,
    };
  }).filter(context =>
    context.date
    && Number.isFinite(context.usdToKrwRate)
    && context.usdToKrwRate > 0
  );

  const totalSpendUsd = Number(selectionSummary?.adSpend || 0);
  const totalSpendKrw = Number(selectionSummary?.adSpendKRW || 0);
  const singleDay = startDate === endDate;
  let basis = 'latest_fallback';
  let effectiveRate = fallbackRate;
  let rateDate = fallbackFx?.rateDate || null;

  if (historicalFx && singleDay) {
    basis = 'daily';
    effectiveRate = dailyContexts[0]?.usdToKrwRate;
    rateDate = dailyContexts[0]?.rateDate || null;
  } else if (historicalFx && totalSpendUsd > 0) {
    basis = 'spend_weighted_average';
    effectiveRate = totalSpendKrw / totalSpendUsd;
    rateDate = null;
  } else if (historicalFx) {
    basis = 'arithmetic_average';
    effectiveRate = dailyContexts.length > 0
      ? dailyContexts.reduce((sum, context) => sum + context.usdToKrwRate, 0)
        / dailyContexts.length
      : fallbackRate;
    rateDate = null;
  }

  return {
    base: 'USD',
    quote: 'KRW',
    source: historicalFx?.source || fallbackFx?.source || 'unknown',
    basis,
    usdToKrwRate: Number.isFinite(effectiveRate) && effectiveRate > 0
      ? Number(effectiveRate.toFixed(4))
      : null,
    rateDate,
    rangeStart: startDate || days[0]?.date || null,
    rangeEnd: endDate || days[days.length - 1]?.date || null,
    fetchedAt: historicalFx?.fetchedAt || fallbackFx?.fetchedAt || null,
    stale: dailyContexts.length === 0
      || dailyContexts.some(context => context.stale),
  };
}

function normalizeAllTimeHourlyRows(hourlyRows) {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0, revenue: 0 }));

  for (const row of Array.isArray(hourlyRows) ? hourlyRows : []) {
    const hour = Number.isInteger(row?.hour) ? row.hour : null;
    if (hour == null || hour < 0 || hour > 23) continue;
    buckets[hour].orders = toFiniteNumber(row?.orders);
    buckets[hour].revenue = toFiniteNumber(row?.revenue);
  }

  return buckets;
}

function buildAllTimeOrderPatterns(projection) {
  const dailyRows = Array.isArray(projection?.dailyMerged) ? projection.dailyMerged : [];
  const weekday = Array.from({ length: 7 }, (_, dayIndex) => ({
    dayIndex,
    revenue: 0,
    refunded: 0,
    net: 0,
    orders: 0,
  }));
  const summary = {
    totalGrossRevenue: 0,
    totalRefunded: 0,
    totalNetRevenue: 0,
    totalOrders: 0,
  };
  let rangeStart = null;
  let rangeEnd = null;

  for (const row of dailyRows) {
    const date = isValidDateKey(row?.date) ? row.date : null;
    if (!date) continue;

    const revenue = toFiniteNumber(row?.revenue);
    const refunded = toFiniteNumber(row?.refunded);
    const net = revenue - refunded;
    const orders = toFiniteNumber(row?.orders);
    // dailyMerged also holds Meta-spend-only days; they carry no order signal
    // and must not stretch the "orders since" range.
    if (revenue <= 0 && refunded <= 0 && orders <= 0) continue;

    rangeStart = !rangeStart || compareDateKeys(date, rangeStart) < 0 ? date : rangeStart;
    rangeEnd = !rangeEnd || compareDateKeys(date, rangeEnd) > 0 ? date : rangeEnd;

    const dateObj = toUtcDate(date);
    if (!dateObj) continue;
    const bucket = weekday[dateObj.getUTCDay()];
    bucket.revenue += revenue;
    bucket.refunded += refunded;
    bucket.net += net;
    bucket.orders += orders;

    summary.totalGrossRevenue += revenue;
    summary.totalRefunded += refunded;
    summary.totalNetRevenue += net;
    summary.totalOrders += orders;
  }

  return {
    range: {
      start: rangeStart,
      end: rangeEnd,
    },
    weekday,
    hourly: normalizeAllTimeHourlyRows(projection?.hourlyOrders),
    summary,
  };
}

function buildRefundWindowSummary({ orders, start, end }) {
  const hasRange = isValidDateKey(start)
    && isValidDateKey(end)
    && compareDateKeys(start, end) <= 0;
  if (!hasRange) {
    return {
      orderRate: null,
      revenueRate: null,
      grossRevenue: 0,
      refundedAmount: 0,
      recognizedOrders: 0,
      refundOrders: 0,
      range: { start: null, end: null },
    };
  }

  const windowOrders = (Array.isArray(orders) ? orders : []).filter(order => {
    const date = getOrderDateKey(order);
    return date
      && compareDateKeys(date, start) >= 0
      && compareDateKeys(date, end) <= 0;
  });
  const returnMetrics = buildRefundDeductionMetrics(windowOrders);

  return {
    orderRate: ratioPercentOrNull(returnMetrics.returnRefundOrders, returnMetrics.recognizedOrders),
    revenueRate: ratioPercentOrNull(returnMetrics.returnRefundedAmount, returnMetrics.grossRevenue),
    grossRevenue: Math.round(returnMetrics.grossRevenue),
    refundedAmount: Math.round(returnMetrics.returnRefundedAmount),
    recognizedOrders: returnMetrics.recognizedOrders,
    refundOrders: returnMetrics.returnRefundOrders,
    range: { start, end },
  };
}

function buildHistoricalMonthlyRefundAverage({ orders, start, end }) {
  const hasRange = isValidDateKey(start)
    && isValidDateKey(end)
    && compareDateKeys(start, end) <= 0;
  if (!hasRange) {
    return {
      orderRate: null,
      revenueRate: null,
      monthCount: 0,
      orderRateMonthCount: 0,
      revenueRateMonthCount: 0,
      orderRateLow: null,
      orderRateHigh: null,
      range: { start: null, end: null },
    };
  }

  const monthlySummaries = [];
  let cursor = startOfMonth(start);
  const lastMonth = startOfMonth(end);

  while (cursor && lastMonth && compareDateKeys(cursor, lastMonth) <= 0) {
    const monthStart = compareDateKeys(cursor, start) < 0 ? start : cursor;
    const calendarMonthEnd = endOfMonth(cursor);
    const monthEnd = compareDateKeys(calendarMonthEnd, end) > 0 ? end : calendarMonthEnd;
    monthlySummaries.push(buildRefundWindowSummary({
      orders,
      start: monthStart,
      end: monthEnd,
    }));
    cursor = shiftMonth(cursor, 1);
  }

  const validOrderRateMonths = monthlySummaries.filter(month => month.orderRate != null);
  const validRevenueRateMonths = monthlySummaries.filter(month => month.revenueRate != null);
  const averageOrderRate = validOrderRateMonths.length > 0
    ? validOrderRateMonths.reduce((total, month) => total + month.orderRate, 0) / validOrderRateMonths.length
    : null;
  const averageRevenueRate = validRevenueRateMonths.length > 0
    ? validRevenueRateMonths.reduce((total, month) => total + month.revenueRate, 0) / validRevenueRateMonths.length
    : null;

  const orderRates = validOrderRateMonths.map(month => month.orderRate);

  return {
    orderRate: averageOrderRate == null ? null : Number(averageOrderRate.toFixed(1)),
    revenueRate: averageRevenueRate == null ? null : Number(averageRevenueRate.toFixed(1)),
    monthCount: monthlySummaries.length,
    orderRateMonthCount: validOrderRateMonths.length,
    revenueRateMonthCount: validRevenueRateMonths.length,
    orderRateLow: orderRates.length > 0 ? Number(Math.min(...orderRates).toFixed(1)) : null,
    orderRateHigh: orderRates.length > 0 ? Number(Math.max(...orderRates).toFixed(1)) : null,
    range: { start, end },
  };
}

function buildRefundRateComparison(historicalAverage = {}, monthToDateSummary = {}) {
  const historicalOrderRate = historicalAverage?.orderRate ?? null;
  const historicalRevenueRate = historicalAverage?.revenueRate ?? null;
  const monthToDateOrderRate = monthToDateSummary?.orderRate ?? null;
  const monthToDateRevenueRate = monthToDateSummary?.revenueRate ?? null;
  const orderDeltaPoints = historicalOrderRate != null && monthToDateOrderRate != null
    ? Number((monthToDateOrderRate - historicalOrderRate).toFixed(1))
    : null;
  const revenueDeltaPoints = historicalRevenueRate != null && monthToDateRevenueRate != null
    ? Number((monthToDateRevenueRate - historicalRevenueRate).toFixed(1))
    : null;
  const comparableDeltas = [orderDeltaPoints, revenueDeltaPoints].filter(value => value != null);

  return {
    basis: 'completed_months_arithmetic_mean',
    scope: 'post_delivery_returns_excluding_cancellations',
    historical: {
      orderRate: historicalOrderRate,
      revenueRate: historicalRevenueRate,
      monthCount: Math.max(0, toFiniteNumber(historicalAverage?.monthCount)),
      orderRateMonthCount: Math.max(0, toFiniteNumber(historicalAverage?.orderRateMonthCount)),
      revenueRateMonthCount: Math.max(0, toFiniteNumber(historicalAverage?.revenueRateMonthCount)),
      orderRateLow: historicalAverage?.orderRateLow ?? null,
      orderRateHigh: historicalAverage?.orderRateHigh ?? null,
      range: {
        start: historicalAverage?.range?.start || null,
        end: historicalAverage?.range?.end || null,
      },
    },
    monthToDate: {
      orderRate: monthToDateOrderRate,
      revenueRate: monthToDateRevenueRate,
      grossRevenue: Math.max(0, toFiniteNumber(monthToDateSummary?.grossRevenue)),
      refundedAmount: Math.max(0, toFiniteNumber(monthToDateSummary?.refundedAmount)),
      recognizedOrders: Math.max(0, toFiniteNumber(monthToDateSummary?.recognizedOrders)),
      refundOrders: Math.max(0, toFiniteNumber(monthToDateSummary?.refundOrders)),
      range: {
        start: monthToDateSummary?.range?.start || null,
        end: monthToDateSummary?.range?.end || null,
      },
      orderDeltaPoints,
      revenueDeltaPoints,
      status: comparableDeltas.length === 0
        ? 'unavailable'
        : comparableDeltas.some(value => value > 0)
          ? 'above_benchmark'
          : 'within_benchmark',
    },
  };
}

function buildDailyRows(dateKeys, maps, metaPurchasesByDate, ordersByDate, operationsByDate, reconciliationByDate) {
  return dateKeys.map(date => {
    const merged = maps.mergedByDate.get(date) || { date, revenue: 0, refunded: 0, netRevenue: 0, orders: 0, spend: 0, spendKrw: 0, purchases: 0 };
    const profit = maps.profitByDate.get(date) || {
      date,
      cogs: 0,
      cogsShipping: 0,
      purchaseCogs: 0,
      refundCogs: 0,
      purchaseShipping: 0,
      refundShipping: 0,
      cogsSheetTotal: null,
      shippingSheetTotal: null,
      sheetTotalsObserved: false,
      paymentFees: 0,
      trueNetProfit: 0,
      hasCOGS: false,
      hasPartialCOGS: false,
      cogsCoverageRatio: 0,
    };
    const orders = ordersByDate.get(date) || [];
    const orderMetrics = buildOrderMetrics(orders);
    const returnMetrics = buildRefundDeductionMetrics(orders);
    const reconciliation = reconciliationByDate.get(date) || null;
    const reconciliationGapAmount = reconciliation
      ? Math.abs(Number(reconciliation?.unmatchedSettlement?.netAmount || 0)) + Math.abs(Number(reconciliation?.unmatchedImweb?.netAmount || 0))
      : 0;

    return {
      date,
      revenue: Number(merged.revenue || 0),
      refunded: Number(merged.refunded || 0),
      netRevenue: Number(merged.netRevenue || 0),
      orders: Number(merged.orders || 0),
      adSpend: Number(merged.spend || 0),
      adSpendKRW: Number(merged.spendKrw || 0),
      usdToKrwRate: Number.isFinite(Number(merged.usdToKrwRate))
        ? Number(merged.usdToKrwRate)
        : null,
      fxRateDate: merged.fxRateDate || null,
      fxStale: Boolean(merged.fxStale),
      metaPurchases: Number(metaPurchasesByDate.get(date) || 0),
      cogs: Number(profit.cogs || 0),
      shipping: Number(profit.cogsShipping || 0),
      purchaseCogs: Number(profit.purchaseCogs || 0),
      refundCogs: Number(profit.refundCogs || 0),
      purchaseShipping: Number(profit.purchaseShipping || 0),
      refundShipping: Number(profit.refundShipping || 0),
      cogsSheetTotal: profit.cogsSheetTotal == null ? null : Number(profit.cogsSheetTotal),
      shippingSheetTotal: profit.shippingSheetTotal == null ? null : Number(profit.shippingSheetTotal),
      sheetTotalsObserved: Boolean(profit.sheetTotalsObserved),
      paymentFees: Number(profit.paymentFees || 0),
      trueNetProfit: Number(profit.trueNetProfit || 0),
      margin: ratioPercentOrNull(profit.trueNetProfit || 0, merged.netRevenue || 0),
      roas: ratioOrNull(merged.netRevenue || 0, merged.spendKrw || 0),
      refundRate: ratioPercentOrNull(merged.refunded || 0, merged.revenue || 0),
      cancelRate: Number(orderMetrics.cancelRate.toFixed(1)),
      refundCount: orderMetrics.refundOrders,
      returnEligibleOrders: returnMetrics.recognizedOrders,
      returnRefundOrders: returnMetrics.returnRefundOrders,
      opCount: (operationsByDate.get(date) || []).length,
      reconciliationGapCount: reconciliationGapAmount > 0 ? 1 : 0,
      reconciliationGapAmount,
      hasCOGS: !!profit.hasCOGS,
      hasPartialCOGS: !!profit.hasPartialCOGS,
      hasPendingRecovery: !!profit.hasPendingRecovery,
      cogsCoverageRatio: Number(profit.cogsCoverageRatio || 0),
      coverageLevel: profit.hasCOGS ? 'covered' : profit.hasPartialCOGS ? 'partial' : 'missing',
    };
  });
}

function buildSummaryFinancialDays(projection, dates, paywayFinancials, context = {}) {
  const days = buildDailyRows(
    dates,
    buildDayMaps(projection.dailyMerged, projection.profitWaterfall),
    context.metaPurchasesByDate || new Map(),
    context.ordersByDate || new Map(),
    context.operationsByDate || new Map(),
    context.reconciliationByDate || new Map()
  );
  return applyPaywayFeesToFinancialDays(days, paywayFinancials);
}

module.exports = {
  buildSummaryFinancialDays,
  buildSelectionSummary,
  buildSelectionFxContext,
  buildAllTimeOrderPatterns,
  buildRefundDeductionMetrics,
  buildRefundWindowSummary,
  buildHistoricalMonthlyRefundAverage,
  buildRefundRateComparison,
  buildDayMaps,
  buildDailyRows,
  ratioOrNull,
  isValidDateKey,
  toUtcDate,
  compareDateKeys,
  toFiniteNumber,
  getOrderDateKey,
  startOfMonth,
  endOfMonth,
  shiftMonth,
  getOrderSections,
  getOrderPaymentAmounts,
  isRecognizedOrder,
  fromUtcDate,
};
