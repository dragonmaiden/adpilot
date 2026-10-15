const {
  buildSummaryFinancialDays,
  buildSelectionSummary,
  buildSelectionFxContext,
  buildAllTimeOrderPatterns,
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
} = require('../domain/financialSummary');
const scheduler = require('../modules/scheduler');
const contracts = require('../contracts/v1');
const transforms = require('../transforms/charts');
const reconciliationService = require('./reconciliationService');
const paywayFinancialService = require('./paywayFinancialService');
const fxService = require('./fxService');
const { buildFinancialProjection } = require('./financialProjectionService');
const {
  calcAOV,
  getPurchases,
} = require('../domain/metrics');
const {
  buildNetPaymentChannels,
} = require('../domain/paywayFinancials');
const { buildProductCategoryRevenue } = require('../domain/productCategories');
const {
  KST_TIME_ZONE,
  formatDateInTimeZone,
  getTodayInTimeZone,
} = require('../domain/time');
const { maskName, maskOrderNumber } = require('./privacyService');

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
    selectionStart: currentMonthStart,
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

function getSectionItems(section) {
  return Array.isArray(section?.sectionItems) ? section.sectionItems : [];
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
    if (Array.isArray(item?.warnings) && item.warnings.some(warning =>
      ['missing_cost_and_shipping', 'missing_cost', 'missing_shipping'].includes(warning))) {
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

function alignCalendarDaysWithSelection(calendarDays, selectionDays) {
  const selectionByDate = new Map(
    (Array.isArray(selectionDays) ? selectionDays : []).map(day => [day.date, day])
  );

  return (Array.isArray(calendarDays) ? calendarDays : []).map(day => ({
    ...day,
    ...(selectionByDate.get(day.date) || {}),
  }));
}

function buildCalendarMonthRoas(months, calendarDays, today) {
  return (Array.isArray(months) ? months : []).map(month => {
    const totals = (Array.isArray(calendarDays) ? calendarDays : []).reduce((sum, day) => {
      if (!day?.date
        || compareDateKeys(day.date, month.start) < 0
        || compareDateKeys(day.date, month.end) > 0
        || compareDateKeys(day.date, today) > 0) {
        return sum;
      }
      sum.netRevenue += toFiniteNumber(day.netRevenue);
      sum.adSpendKRW += toFiniteNumber(day.adSpendKRW);
      return sum;
    }, { netRevenue: 0, adSpendKRW: 0 });

    return {
      ...month,
      roas: ratioOrNull(totals.netRevenue, totals.adSpendKRW),
      roasNetRevenue: Math.round(totals.netRevenue),
      roasAdSpendKRW: Math.round(totals.adSpendKRW),
    };
  });
}

async function getCalendarAnalysisResponse(query = {}) {
  const viewport = normalizeViewport(query);
  const data = scheduler.getLatestData();
  const revenue = data.revenueData || null;

  if (!revenue) {
    const orderPatterns = buildAllTimeOrderPatterns({});
    return contracts.calendarAnalysis({
      ready: false,
      fx: data.fx || null,
      viewport,
      calendarDays: [],
      orderPatterns,
      refundComparison: buildRefundRateComparison(),
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

  const [historicalFx, reconciliationReport, paywayFinancials] = await Promise.all([
    fxService.getUsdToKrwRatesForRange(
      viewport.visibleStart,
      viewport.visibleEnd
    ).catch(err => {
      console.warn('[CALENDAR] Historical FX unavailable; using latest FX fallback:', err.message);
      return null;
    }),
    reconciliationService.getReconciliationResponse({ refresh: false })
      .catch(err => ({
        ready: false,
        error: err.message,
        matchWindowMinutes: 0,
        summary: {},
        daily: [],
        matches: [],
        unmatchedSettlements: [],
        unmatchedImwebPayments: [],
      })),
    paywayFinancialService.getPaywayFinancialSummary({
      startDate: viewport.selectionStart,
      endDate: viewport.selectionEnd,
    }),
  ]);

  const projection = buildFinancialProjection(data, {
    usdToKrwRatesByDate: historicalFx?.ratesByDate || null,
  });
  const orderPatterns = buildAllTimeOrderPatterns(projection);
  const cogs = projection.cogs || {};
  const dailyMerged = projection.dailyMerged;
  const profitWaterfall = projection.profitWaterfall;
  const maps = buildDayMaps(dailyMerged, profitWaterfall);
  const metaPurchasesByDate = buildMetaPurchasesByDate(data.campaignInsights || []);

  const visibleDates = enumerateDateKeys(viewport.visibleStart, viewport.visibleEnd);
  const selectionDates = enumerateDateKeys(viewport.selectionStart, viewport.selectionEnd);

  const orders = Array.isArray(data.orders) ? data.orders : [];
  const monthToDateStart = startOfMonth(viewport.today);
  const historicalEndDate = (() => {
    const date = toUtcDate(monthToDateStart);
    if (!date) return null;
    date.setUTCDate(date.getUTCDate() - 1);
    return fromUtcDate(date);
  })();
  const historicalRefundAverage = buildHistoricalMonthlyRefundAverage({
    orders,
    start: orderPatterns?.range?.start,
    end: historicalEndDate,
  });
  const monthToDateRefundSummary = buildRefundWindowSummary({
    orders,
    start: monthToDateStart,
    end: viewport.today,
  });
  const refundComparison = buildRefundRateComparison(
    historicalRefundAverage,
    monthToDateRefundSummary
  );
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
  const unadjustedCalendarDays = visibleDayRows.map(day => ({
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

  const selectionDayRows = buildSummaryFinancialDays(
    projection, selectionDates, paywayFinancials,
    { metaPurchasesByDate, ordersByDate, operationsByDate, reconciliationByDate }
  );
  const calendarDays = alignCalendarDaysWithSelection(
    unadjustedCalendarDays,
    selectionDayRows
  );
  const selectionCoverage = transforms.buildDataCoverage(
    selectionDayRows.map(day => ({ date: day.date })),
    cogs.dailyCOGS || {}
  );
  const selectionSummary = buildSelectionSummary(
    selectionDayRows,
    selectionOrders,
    selectionCoverage,
    paywayFinancials
  );
  const selectionFx = buildSelectionFxContext(
    {
      selectionDays: selectionDayRows,
      selectionSummary,
      historicalFx,
      fallbackFx: projection.fx,
      startDate: viewport.selectionStart,
      endDate: viewport.selectionEnd,
    }
  );
  const paymentChannels = buildNetPaymentChannels({
    totalNetRevenue: selectionSummary.netRevenue,
    totalOrderCount: selectionSummary.recognizedOrders,
    paywaySummary: paywayFinancials,
  });
  const selectionInsights = (Array.isArray(data.campaignInsights) ? data.campaignInsights : []).filter(row =>
    row?.date_start &&
    compareDateKeys(row.date_start, viewport.selectionStart) >= 0 &&
    compareDateKeys(row.date_start, viewport.selectionEnd) <= 0
  );

  return contracts.calendarAnalysis({
    ready: true,
    fx: selectionFx,
    viewport: {
      ...viewport,
      months: buildCalendarMonthRoas(viewport.months, calendarDays, viewport.today),
    },
    calendarDays,
    categoryRevenueByDate,
    categoryRevenueByMonth,
    orderPatterns,
    refundComparison,
    sourceAudit: data.sourceAudit || null,
    selection: {
      label: viewport.selectionStart === viewport.selectionEnd
        ? viewport.selectionStart
        : `${viewport.selectionStart} → ${viewport.selectionEnd}`,
      dayCount: selectionDates.length,
      summary: selectionSummary,
      days: selectionDayRows,
      paymentChannels,
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
  buildCalendarMonthRoas,
  getCalendarAnalysisResponse,
  alignCalendarDaysWithSelection,
};
