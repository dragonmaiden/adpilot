const scheduler = require('../modules/scheduler');
const contracts = require('../contracts/v1');
const transforms = require('../transforms/charts');
const reconciliationService = require('./reconciliationService');
const { buildFinancialProjection } = require('./financialProjectionService');
const {
  calcAOV,
  getPurchases,
} = require('../domain/metrics');
const { divideOrNull } = require('../domain/profitWindowMetrics');
const { getOrderCashTotals } = require('../domain/imwebPayments');
const { buildProductCategoryRevenue } = require('../domain/productCategories');
const {
  KST_TIME_ZONE,
  formatDateInTimeZone,
  getTodayInTimeZone,
} = require('../domain/time');
const { maskName, maskOrderNumber } = require('./privacyService');

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

function clampDateKey(dateKey, min, max) {
  if (!isValidDateKey(dateKey)) return min;
  if (compareDateKeys(dateKey, min) < 0) return min;
  if (compareDateKeys(dateKey, max) > 0) return max;
  return dateKey;
}

function enumerateDateKeys(start, end) {
  const dates = [];
  let cursor = start;

  while (cursor && compareDateKeys(cursor, end) <= 0) {
    dates.push(cursor);
    const current = toUtcDate(cursor);
    current.setUTCDate(current.getUTCDate() + 1);
    cursor = fromUtcDate(current);
  }

  return dates;
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

function buildMonthEntries(visibleStart, visibleEnd) {
  const months = [];
  let cursor = startOfMonth(visibleStart);
  const lastMonth = startOfMonth(visibleEnd);

  while (cursor && lastMonth && compareDateKeys(cursor, lastMonth) <= 0) {
    const date = toUtcDate(cursor);
    months.push({
      month: cursor.slice(0, 7),
      label: new Intl.DateTimeFormat('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(date),
      start: cursor,
      end: endOfMonth(cursor),
    });
    cursor = shiftMonth(cursor, 1);
  }

  return months;
}

function buildDefaultViewport() {
  const today = getTodayInTimeZone(KST_TIME_ZONE);
  const currentMonthStart = startOfMonth(today);
  const previousMonthStart = shiftMonth(currentMonthStart, -1);
  return {
    today,
    visibleStart: previousMonthStart,
    visibleEnd: endOfMonth(today),
    selectionStart: today,
    selectionEnd: today,
  };
}

function normalizeViewport(query = {}) {
  const defaults = buildDefaultViewport();
  let visibleStart = isValidDateKey(query.visibleStart) ? query.visibleStart : defaults.visibleStart;
  let visibleEnd = isValidDateKey(query.visibleEnd) ? query.visibleEnd : defaults.visibleEnd;

  if (compareDateKeys(visibleStart, visibleEnd) > 0) {
    [visibleStart, visibleEnd] = [visibleEnd, visibleStart];
  }

  let selectionStart = isValidDateKey(query.selectionStart) ? query.selectionStart : defaults.selectionStart;
  let selectionEnd = isValidDateKey(query.selectionEnd) ? query.selectionEnd : selectionStart;

  selectionStart = clampDateKey(selectionStart, visibleStart, visibleEnd);
  selectionEnd = clampDateKey(selectionEnd, visibleStart, visibleEnd);

  if (compareDateKeys(selectionStart, selectionEnd) > 0) {
    [selectionStart, selectionEnd] = [selectionEnd, selectionStart];
  }

  return {
    today: defaults.today,
    visibleStart,
    visibleEnd,
    selectionStart,
    selectionEnd,
    months: buildMonthEntries(visibleStart, visibleEnd),
  };
}

function getOrderDateKey(order) {
  return order?.wtime ? formatDateInTimeZone(order.wtime, KST_TIME_ZONE) : null;
}

function getOrderSections(order) {
  if (Array.isArray(order?.sections)) return order.sections;
  if (Array.isArray(order?.orderSections)) return order.orderSections;
  return [];
}

function getSectionItems(section) {
  return Array.isArray(section?.sectionItems) ? section.sectionItems : [];
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

function isRefundOrCancelStatus(status) {
  return /(CANCEL|RETURN|EXCHANGE)/.test(String(status || '').trim().toUpperCase());
}

function normalizeProductName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function buildStatusMix(counts) {
  return Object.entries(counts || {})
    .map(([status, count]) => ({ status, count }))
    .sort((left, right) => {
      if (right.count === left.count) return left.status.localeCompare(right.status);
      return right.count - left.count;
    });
}

function formatOperationTimestamp(dateKey) {
  const date = toUtcDate(dateKey);
  if (!date) return null;
  date.setUTCHours(12, 0, 0, 0);
  return date.toISOString();
}

function buildReconciliationOverlap(dailyRows, matches, unmatchedSettlements, unmatchedImwebPayments) {
  const mismatchMatches = (matches || []).filter(match => match?.methodMismatch);
  const confidence = (matches || []).reduce((summary, match) => {
    const key = match?.confidence || 'low';
    summary[key] = (summary[key] || 0) + 1;
    return summary;
  }, {});

  return {
    matchedCount: (matches || []).length,
    netAmount: (dailyRows || []).reduce((sum, day) => sum + Number(day?.matched?.netAmount || 0), 0),
    methodMismatchCount: mismatchMatches.length,
    methodMismatchAmount: mismatchMatches.reduce((sum, match) => sum + Number(match?.amount || 0), 0),
    confidence,
    unmatchedSettlementCount: (unmatchedSettlements || []).length,
    unmatchedImwebCount: (unmatchedImwebPayments || []).length,
  };
}

function filterReconciliationReport(report, start, end) {
  if (!report || report.ready === false) {
    return {
      ready: false,
      matchWindowMinutes: report?.matchWindowMinutes ?? 0,
      summary: report?.summary ?? {},
      daily: [],
      matches: [],
      unmatchedSettlements: [],
      unmatchedImwebPayments: [],
    };
  }

  const daily = (Array.isArray(report.daily) ? report.daily : []).filter(day =>
    day?.date && compareDateKeys(day.date, start) >= 0 && compareDateKeys(day.date, end) <= 0
  );

  const matches = (Array.isArray(report.matches) ? report.matches : []).filter(match => {
    const dateKey = match?.settlement?.tradedDate || match?.imwebPayment?.completedDate;
    return dateKey && compareDateKeys(dateKey, start) >= 0 && compareDateKeys(dateKey, end) <= 0;
  });

  const unmatchedSettlements = (Array.isArray(report.unmatchedSettlements) ? report.unmatchedSettlements : []).filter(item => {
    const dateKey = item?.tradedDate;
    return dateKey && compareDateKeys(dateKey, start) >= 0 && compareDateKeys(dateKey, end) <= 0;
  });

  const unmatchedImwebPayments = (Array.isArray(report.unmatchedImwebPayments) ? report.unmatchedImwebPayments : []).filter(item => {
    const dateKey = item?.completedDate;
    return dateKey && compareDateKeys(dateKey, start) >= 0 && compareDateKeys(dateKey, end) <= 0;
  });

  return {
    ...report,
    daily,
    matches,
    unmatchedSettlements,
    unmatchedImwebPayments,
    summary: {
      ...(report.summary || {}),
      overlap: buildReconciliationOverlap(daily, matches, unmatchedSettlements, unmatchedImwebPayments),
    },
  };
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

function buildOrderLedgerRows(orders) {
  return (Array.isArray(orders) ? orders : [])
    .map(order => {
      const date = getOrderDateKey(order);
      const sections = getOrderSections(order);
      const items = sections.flatMap(section => getSectionItems(section));
      const { payAmount, netAmount, refundAmount } = getOrderPaymentAmounts(order);
      const payment = Array.isArray(order?.payments) && order.payments.length > 0 ? order.payments[0] : null;
      const productNames = items
        .map(item => String(item?.productInfo?.prodName || '').trim())
        .filter(Boolean);
      const brands = [...new Set(items
        .map(item => String(item?.productInfo?.brand || '').trim())
        .filter(Boolean))];
      const statusMix = {};

      for (const section of sections) {
        const status = String(section?.orderSectionStatus || section?.orderStatus || order?.orderStatus || 'UNKNOWN').trim();
        statusMix[status] = (statusMix[status] || 0) + 1;
      }

      return {
        date,
        orderedAt: order?.wtime ?? null,
        orderNo: maskOrderNumber(order?.orderNo),
        customerName: maskName(order?.ordererName || order?.memberName),
        orderStatus: String(order?.orderStatus || '').trim(),
        paymentMethod: String(payment?.method || order?.paymentMethod || '').trim(),
        pgName: String(payment?.pgName || '').trim(),
        paidAmount: payAmount,
        refundedAmount: refundAmount,
        netRevenue: netAmount,
        sectionCount: sections.length,
        itemCount: items.reduce((sum, item) => sum + Number(item?.qty || 0), 0),
        recognizedOrder: isRecognizedOrder(order),
        productSummary: productNames.slice(0, 3).join(', '),
        brandSummary: brands.join(', '),
        statusMix: buildStatusMix(statusMix),
      };
    })
    .sort((left, right) => {
      if (left.orderedAt === right.orderedAt) return String(right.orderNo).localeCompare(String(left.orderNo));
      return String(right.orderedAt || '').localeCompare(String(left.orderedAt || ''));
    });
}

function buildProductExplorerRows(orders, cogsItems) {
  const cogsByExactKey = new Map();

  for (const item of Array.isArray(cogsItems) ? cogsItems : []) {
    if (item?.isRefund) continue;

    const date = String(item?.date || '').trim();
    const normalizedName = normalizeProductName(item?.productName);
    if (!date || !normalizedName) continue;

    const key = `${date}|${normalizedName}`;
    const existing = cogsByExactKey.get(key) || {
      qty: 0,
      cost: 0,
      shipping: 0,
      missingCostCount: 0,
    };

    existing.qty += 1;
    existing.cost += Number(item?.cost || 0);
    existing.shipping += Number(item?.shipping || 0);
    if (Array.isArray(item?.warnings) && item.warnings.includes('missing_cost_and_shipping')) {
      existing.missingCostCount += 1;
    }
    cogsByExactKey.set(key, existing);
  }

  const products = new Map();

  for (const order of Array.isArray(orders) ? orders : []) {
    const date = getOrderDateKey(order);
    if (!date) continue;

    const sections = getOrderSections(order);
    const { refundAmount } = getOrderPaymentAmounts(order);

    for (const section of sections) {
      const sectionStatus = String(section?.orderSectionStatus || section?.orderStatus || order?.orderStatus || 'UNKNOWN').trim();
      const items = getSectionItems(section);

      for (const item of items) {
        const productName = String(item?.productInfo?.prodName || '').trim();
        const normalizedName = normalizeProductName(productName);
        if (!normalizedName) continue;

        const brand = String(item?.productInfo?.brand || '').trim();
        const qty = Math.max(1, Number(item?.qty || 1));
        const itemRevenue = Math.round(Number(item?.productInfo?.itemPrice ?? 0) * qty);
        const productKey = `${normalizedName}|${brand}`;
        const existing = products.get(productKey) || {
          productName,
          brand,
          qty: 0,
          orderNos: new Set(),
          itemRevenue: 0,
          refundedOrCanceledQty: 0,
          statusCounts: {},
          dateBuckets: new Map(),
          exactCostCoverage: true,
          coveredQty: 0,
          knownCogs: 0,
          knownShipping: 0,
          missingCostDates: new Set(),
        };

        existing.qty += qty;
        existing.orderNos.add(String(order?.orderNo ?? ''));
        existing.itemRevenue += itemRevenue;
        if (refundAmount > 0 || isRefundOrCancelStatus(sectionStatus)) {
          existing.refundedOrCanceledQty += qty;
        }
        existing.statusCounts[sectionStatus] = (existing.statusCounts[sectionStatus] || 0) + qty;

        const exactKey = `${date}|${normalizedName}`;
        const dateBucket = existing.dateBuckets.get(exactKey) || { qty: 0 };
        dateBucket.qty += qty;
        existing.dateBuckets.set(exactKey, dateBucket);

        products.set(productKey, existing);
      }
    }
  }

  return Array.from(products.values())
    .map(product => {
      for (const [exactKey, bucket] of product.dateBuckets.entries()) {
        const cogsMatch = cogsByExactKey.get(exactKey);
        const matchedQty = Math.min(bucket.qty, cogsMatch?.qty || 0);
        product.coveredQty += matchedQty;

        if (!cogsMatch || cogsMatch.qty !== bucket.qty || Number(cogsMatch.missingCostCount || 0) > 0) {
          product.exactCostCoverage = false;
          product.missingCostDates.add(exactKey.split('|')[0]);
          continue;
        }

        product.knownCogs += cogsMatch.cost;
        product.knownShipping += cogsMatch.shipping;
      }

      const coverageRatio = product.qty > 0 ? product.coveredQty / product.qty : 0;
      const knownProfit = product.exactCostCoverage
        ? Math.round(product.itemRevenue - product.knownCogs - product.knownShipping)
        : null;

      return {
        productName: product.productName,
        brand: product.brand,
        qty: product.qty,
        orderCount: product.orderNos.size,
        itemRevenue: product.itemRevenue,
        refundedOrCanceledQty: product.refundedOrCanceledQty,
        statusMix: buildStatusMix(product.statusCounts),
        exactCostCoverage: product.exactCostCoverage && coverageRatio === 1,
        coverageRatio: Number(coverageRatio.toFixed(3)),
        knownCogs: product.exactCostCoverage && coverageRatio === 1 ? product.knownCogs : null,
        knownShipping: product.exactCostCoverage && coverageRatio === 1 ? product.knownShipping : null,
        knownProfit,
        missingCostDates: Array.from(product.missingCostDates).sort(),
      };
    })
    .sort((left, right) => {
      if (right.itemRevenue === left.itemRevenue) return left.productName.localeCompare(right.productName);
      return right.itemRevenue - left.itemRevenue;
    });
}

function buildCampaignRows(insights, campaigns, summary, transformOptions = {}) {
  const avgAOV = calcAOV(summary.netRevenue || 0, summary.recognizedOrders || 0);
  const selectionCogs = {
    totalCOGS: summary.cogs || 0,
    totalShipping: summary.shipping || 0,
  };

  return transforms.buildCampaignProfit(
    insights,
    campaigns,
    avgAOV,
    selectionCogs,
    summary.netRevenue || 0,
    transformOptions
  ).map(row => ({
    ...row,
    estimatedRoas: row.spendKRW > 0 ? Number((row.estimatedRevenue / row.spendKRW).toFixed(2)) : 0,
    estimated: true,
  }));
}

function buildDayMaps(dailyMerged, profitWaterfall) {
  return {
    mergedByDate: new Map((Array.isArray(dailyMerged) ? dailyMerged : []).map(row => [row.date, row])),
    profitByDate: new Map((Array.isArray(profitWaterfall) ? profitWaterfall : []).map(row => [row.date, row])),
  };
}

function buildMetaPurchasesByDate(insights) {
  const byDate = new Map();

  for (const row of Array.isArray(insights) ? insights : []) {
    const date = String(row?.date_start || '').trim();
    if (!date) continue;
    byDate.set(date, (byDate.get(date) || 0) + getPurchases(row?.actions));
  }

  return byDate;
}

function buildOperationEvents({ scanHistory, latestScanResult, optimizations, reconciliation }) {
  const events = [];

  for (const scan of Array.isArray(scanHistory) ? scanHistory : []) {
    const date = scan?.time ? formatDateInTimeZone(scan.time, KST_TIME_ZONE) : null;
    if (!date) continue;

    const latestDetails = latestScanResult?.scanId === scan?.scanId ? latestScanResult : null;
    events.push({
      id: `scan:${scan.scanId}`,
      type: 'scan',
      timestamp: scan.time,
      date,
      status: Number(scan?.errors || 0) > 0 ? 'warning' : 'ok',
      title: 'Scan completed',
      summary: `${Number(scan?.optimizations || 0)} optimizations · ${Number(scan?.errors || 0)} errors`,
      scanId: scan?.scanId ?? null,
      meta: latestDetails ? { steps: latestDetails.steps || [] } : {},
    });
  }

  for (const optimization of Array.isArray(optimizations) ? optimizations : []) {
    const date = optimization?.timestamp ? formatDateInTimeZone(optimization.timestamp, KST_TIME_ZONE) : null;
    if (!date) continue;

    events.push({
      id: `optimization:${optimization.id}`,
      type: 'optimization',
      timestamp: optimization.timestamp,
      date,
      status: optimization?.priority === 'high' || optimization?.priority === 'critical' ? 'warning' : 'info',
      title: optimization?.action || 'Optimization suggested',
      summary: optimization?.reason || '',
      scanId: optimization?.scanId ?? null,
      meta: {
        targetName: optimization?.targetName || '',
        priority: optimization?.priority || '',
        executed: !!optimization?.executed,
      },
    });

    if (optimization?.executionResult) {
      events.push({
        id: `execution:${optimization.id}`,
        type: 'execution',
        timestamp: optimization.timestamp,
        date,
        status: optimization?.executed ? 'ok' : /^Failed:/i.test(String(optimization.executionResult))
          ? 'error'
          : 'warning',
        title: optimization?.executed ? 'Optimization executed' : 'Optimization execution update',
        summary: optimization.executionResult,
        scanId: optimization?.scanId ?? null,
        meta: {
          targetName: optimization?.targetName || '',
          action: optimization?.action || '',
        },
      });
    }
  }

  for (const day of Array.isArray(reconciliation?.daily) ? reconciliation.daily : []) {
    const settlementGap = Number(day?.unmatchedSettlement?.netAmount || 0);
    const imwebGap = Number(day?.unmatchedImweb?.netAmount || 0);
    const totalGap = Math.abs(settlementGap) + Math.abs(imwebGap);

    if (totalGap <= 0) continue;

    events.push({
      id: `reconciliation_gap:${day.date}`,
      type: 'reconciliation_gap',
      timestamp: formatOperationTimestamp(day.date),
      date: day.date,
      status: 'warning',
      title: 'Settlement gap detected',
      summary: `Settlement ${settlementGap >= 0 ? '+' : ''}${settlementGap} · Imweb ${imwebGap >= 0 ? '+' : ''}${imwebGap}`,
      meta: {
        settlementGap,
        imwebGap,
      },
    });
  }

  return events.sort((left, right) => {
    if (left.timestamp === right.timestamp) return String(left.id).localeCompare(String(right.id));
    return String(right.timestamp || '').localeCompare(String(left.timestamp || ''));
  });
}

function buildSelectionSummary(selectionDays, selectionOrders, coverage) {
  const dayTotals = (Array.isArray(selectionDays) ? selectionDays : []).reduce((summary, day) => {
    summary.grossRevenue += Number(day?.revenue || 0);
    summary.refundedAmount += Number(day?.refunded || 0);
    summary.netRevenue += Number(day?.netRevenue || 0);
    summary.adSpend += Number(day?.adSpend || 0);
    summary.adSpendKRW += Number(day?.adSpendKRW || 0);
    summary.cogs += Number(day?.cogs || 0);
    summary.shipping += Number(day?.shipping || 0);
    summary.paymentFees += Number(day?.paymentFees || 0);
    summary.trueNetProfit += Number(day?.trueNetProfit || 0);
    summary.metaPurchases += Number(day?.metaPurchases || 0);
    return summary;
  }, {
    grossRevenue: 0,
    refundedAmount: 0,
    netRevenue: 0,
    adSpend: 0,
    adSpendKRW: 0,
    cogs: 0,
    shipping: 0,
    paymentFees: 0,
    trueNetProfit: 0,
    metaPurchases: 0,
  });

  const orderMetrics = buildOrderMetrics(selectionOrders);

  return {
    ...dayTotals,
    margin: ratioPercentOrNull(dayTotals.trueNetProfit, dayTotals.netRevenue),
    roas: ratioOrNull(dayTotals.netRevenue, dayTotals.adSpendKRW),
    recognizedOrders: orderMetrics.recognizedOrders,
    refundRate: ratioPercentOrNull(dayTotals.refundedAmount, dayTotals.grossRevenue),
    cancelRate: Number(orderMetrics.cancelRate.toFixed(1)),
    refundOrders: orderMetrics.refundOrders,
    cancelledSections: orderMetrics.cancelledSections,
    totalSections: orderMetrics.totalSections,
    confidence: coverage?.confidence || { level: 'low', label: 'Waiting for data' },
    cogsCoverageRatio: coverage?.coverageRatio ?? 0,
    daysWithCOGS: coverage?.daysWithCOGS ?? 0,
    daysWithPartialCOGS: coverage?.daysWithPartialCOGS ?? 0,
    totalDays: coverage?.totalDays ?? 0,
  };
}

function normalizeAllTimeHourlyRows(hourlyRows) {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0 }));

  for (const row of Array.isArray(hourlyRows) ? hourlyRows : []) {
    const hour = Number.isInteger(row?.hour) ? row.hour : null;
    if (hour == null || hour < 0 || hour > 23) continue;
    buckets[hour].orders = toFiniteNumber(row?.orders);
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

    rangeStart = !rangeStart || compareDateKeys(date, rangeStart) < 0 ? date : rangeStart;
    rangeEnd = !rangeEnd || compareDateKeys(date, rangeEnd) > 0 ? date : rangeEnd;

    const dateObj = toUtcDate(date);
    if (!dateObj) continue;

    const revenue = toFiniteNumber(row?.revenue);
    const refunded = toFiniteNumber(row?.refunded);
    const net = revenue - refunded;
    const orders = toFiniteNumber(row?.orders);
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

function buildDailyRows(dateKeys, maps, metaPurchasesByDate, ordersByDate, operationsByDate, reconciliationByDate) {
  return dateKeys.map(date => {
    const merged = maps.mergedByDate.get(date) || { date, revenue: 0, refunded: 0, netRevenue: 0, orders: 0, spend: 0, spendKrw: 0, purchases: 0 };
    const profit = maps.profitByDate.get(date) || { date, cogs: 0, cogsShipping: 0, paymentFees: 0, trueNetProfit: 0, hasCOGS: false, hasPartialCOGS: false, cogsCoverageRatio: 0 };
    const orders = ordersByDate.get(date) || [];
    const orderMetrics = buildOrderMetrics(orders);
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
      metaPurchases: Number(metaPurchasesByDate.get(date) || 0),
      cogs: Number(profit.cogs || 0),
      shipping: Number(profit.cogsShipping || 0),
      paymentFees: Number(profit.paymentFees || 0),
      trueNetProfit: Number(profit.trueNetProfit || 0),
      margin: ratioPercentOrNull(profit.trueNetProfit || 0, merged.netRevenue || 0),
      roas: ratioOrNull(merged.netRevenue || 0, merged.spendKrw || 0),
      refundRate: ratioPercentOrNull(merged.refunded || 0, merged.revenue || 0),
      cancelRate: Number(orderMetrics.cancelRate.toFixed(1)),
      refundCount: orderMetrics.refundOrders,
      opCount: (operationsByDate.get(date) || []).length,
      reconciliationGapCount: reconciliationGapAmount > 0 ? 1 : 0,
      reconciliationGapAmount,
      hasCOGS: !!profit.hasCOGS,
      hasPartialCOGS: !!profit.hasPartialCOGS,
      cogsCoverageRatio: Number(profit.cogsCoverageRatio || 0),
      coverageLevel: profit.hasCOGS ? 'covered' : profit.hasPartialCOGS ? 'partial' : 'missing',
    };
  });
}

async function getCalendarAnalysisResponse(query = {}) {
  const viewport = normalizeViewport(query);
  const data = scheduler.getLatestData();
  const revenue = data.revenueData || null;

  if (!revenue) {
    return contracts.calendarAnalysis({
      ready: false,
      viewport,
      calendarDays: [],
      orderPatterns: buildAllTimeOrderPatterns({}),
      sourceAudit: data.sourceAudit || null,
      selection: {
        label: '',
        dayCount: 0,
        summary: {},
        days: [],
        orders: [],
        products: [],
        campaigns: [],
        operations: [],
        reconciliation: { ready: false, daily: [], matches: [], unmatchedSettlements: [], unmatchedImwebPayments: [] },
        coverage: {},
      },
    });
  }

  const projection = buildFinancialProjection(data);
  const cogs = projection.cogs || {};
  const dailyMerged = projection.dailyMerged;
  const profitWaterfall = projection.profitWaterfall;
  const maps = buildDayMaps(dailyMerged, profitWaterfall);
  const metaPurchasesByDate = buildMetaPurchasesByDate(data.campaignInsights || []);

  const visibleDates = enumerateDateKeys(viewport.visibleStart, viewport.visibleEnd);
  const selectionDates = enumerateDateKeys(viewport.selectionStart, viewport.selectionEnd);

  const orders = Array.isArray(data.orders) ? data.orders : [];
  const visibleOrders = orders.filter(order => {
    const date = getOrderDateKey(order);
    return date && compareDateKeys(date, viewport.visibleStart) >= 0 && compareDateKeys(date, viewport.visibleEnd) <= 0;
  });
  const selectionOrders = orders.filter(order => {
    const date = getOrderDateKey(order);
    return date && compareDateKeys(date, viewport.selectionStart) >= 0 && compareDateKeys(date, viewport.selectionEnd) <= 0;
  });

  const ordersByDate = new Map();
  for (const order of visibleOrders) {
    const date = getOrderDateKey(order);
    const existing = ordersByDate.get(date) || [];
    existing.push(order);
    ordersByDate.set(date, existing);
  }

  let reconciliationReport;
  try {
    reconciliationReport = await reconciliationService.getReconciliationResponse({ refresh: false });
  } catch (err) {
    reconciliationReport = {
      ready: false,
      error: err.message,
      matchWindowMinutes: 0,
      summary: {},
      daily: [],
      matches: [],
      unmatchedSettlements: [],
      unmatchedImwebPayments: [],
    };
  }

  const visibleReconciliation = filterReconciliationReport(reconciliationReport, viewport.visibleStart, viewport.visibleEnd);
  const selectionReconciliation = filterReconciliationReport(reconciliationReport, viewport.selectionStart, viewport.selectionEnd);
  const reconciliationByDate = new Map((visibleReconciliation.daily || []).map(day => [day.date, day]));

  const allOperations = buildOperationEvents({
    scanHistory: scheduler.getScanHistory(),
    latestScanResult: scheduler.getLastScanResult(),
    optimizations: [],
    reconciliation: visibleReconciliation,
  });

  const visibleOperations = allOperations.filter(event =>
    event?.date && compareDateKeys(event.date, viewport.visibleStart) >= 0 && compareDateKeys(event.date, viewport.visibleEnd) <= 0
  );
  const selectionOperations = allOperations.filter(event =>
    event?.date && compareDateKeys(event.date, viewport.selectionStart) >= 0 && compareDateKeys(event.date, viewport.selectionEnd) <= 0
  );

  const operationsByDate = new Map();
  for (const event of visibleOperations) {
    const existing = operationsByDate.get(event.date) || [];
    existing.push(event);
    operationsByDate.set(event.date, existing);
  }

  const visibleDayRows = buildDailyRows(visibleDates, maps, metaPurchasesByDate, ordersByDate, operationsByDate, reconciliationByDate);
  const maxRevenue = visibleDayRows.reduce((max, day) => Math.max(max, day.revenue || 0), 0);
  const calendarDays = visibleDayRows.map(day => ({
    ...day,
    month: day.date.slice(0, 7),
    revenueIntensity: maxRevenue > 0 ? Number((day.revenue / maxRevenue).toFixed(3)) : 0,
  }));
  const categoryRevenueByDate = Object.fromEntries(
    visibleDates.map(date => [date, buildProductCategoryRevenue(ordersByDate.get(date) || [])])
  );
  const categoryRevenueByMonth = Object.fromEntries(
    (viewport.months || []).map(month => {
      const monthKey = month?.key || month?.month || String(month?.start || '').slice(0, 7);
      const monthOrders = visibleOrders.filter(order => String(getOrderDateKey(order) || '').startsWith(`${monthKey}-`));
      return [monthKey, buildProductCategoryRevenue(monthOrders)];
    }).filter(([monthKey]) => /^\d{4}-\d{2}$/.test(String(monthKey || '')))
  );

  const selectionDayRows = visibleDayRows.filter(day =>
    compareDateKeys(day.date, viewport.selectionStart) >= 0 && compareDateKeys(day.date, viewport.selectionEnd) <= 0
  );
  const selectionCoverage = transforms.buildDataCoverage(
    selectionDayRows.map(day => ({ date: day.date })),
    cogs.dailyCOGS || {}
  );
  const selectionSummary = buildSelectionSummary(selectionDayRows, selectionOrders, selectionCoverage);
  const selectionInsights = (Array.isArray(data.campaignInsights) ? data.campaignInsights : []).filter(row =>
    row?.date_start &&
    compareDateKeys(row.date_start, viewport.selectionStart) >= 0 &&
    compareDateKeys(row.date_start, viewport.selectionEnd) <= 0
  );

  return contracts.calendarAnalysis({
    ready: true,
    viewport,
    calendarDays,
    categoryRevenueByDate,
    categoryRevenueByMonth,
    orderPatterns: buildAllTimeOrderPatterns(projection),
    sourceAudit: data.sourceAudit || null,
    selection: {
      label: viewport.selectionStart === viewport.selectionEnd
        ? viewport.selectionStart
        : `${viewport.selectionStart} → ${viewport.selectionEnd}`,
      dayCount: selectionDates.length,
      summary: selectionSummary,
      days: selectionDayRows,
      categoryRevenue: buildProductCategoryRevenue(selectionOrders),
      orders: buildOrderLedgerRows(selectionOrders),
      products: buildProductExplorerRows(selectionOrders, cogs.items || []),
      campaigns: buildCampaignRows(selectionInsights, data.campaigns || [], selectionSummary, projection.transformOptions),
      operations: selectionOperations,
      reconciliation: selectionReconciliation,
      coverage: selectionCoverage,
    },
  });
}

module.exports = {
  getCalendarAnalysisResponse,
};
