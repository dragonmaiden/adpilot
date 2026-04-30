function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function divideOrNull(numerator, denominator) {
  const top = toFiniteNumber(numerator);
  const bottom = toFiniteNumber(denominator);
  return bottom > 0 ? top / bottom : null;
}

function getDateKey(row) {
  return String(row?.date || '').slice(0, 10);
}

function sortRowsByDate(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row && getDateKey(row))
    .slice()
    .sort((left, right) => getDateKey(left).localeCompare(getDateKey(right)));
}

function sliceRowsByTrailingDays(rows, days) {
  const sorted = sortRowsByDate(rows);
  if (!days || sorted.length <= days) return sorted;
  return sorted.slice(-days);
}

function getRowCoverageRatio(row) {
  const explicitRatio = Number(row?.cogsCoverageRatio);
  if (Number.isFinite(explicitRatio)) {
    return Math.max(0, Math.min(1, explicitRatio));
  }
  if (row?.hasCOGS) return 1;
  if (row?.hasPartialCOGS) return 0.5;
  return 0;
}

function classifyCoverage(coverageRatio) {
  if (coverageRatio >= 0.8) {
    return { level: 'high', label: 'High confidence', color: '#4ade80' };
  }
  if (coverageRatio >= 0.4) {
    return { level: 'medium', label: 'Medium confidence', color: '#fbbf24' };
  }
  return { level: 'low', label: 'Low confidence', color: '#f87171' };
}

function pushMissingRange(missingRanges, start, end) {
  if (!start) return;
  missingRanges.push(start === end ? start : `${start} -> ${end}`);
}

function summarizeWaterfallCoverage(rows) {
  const sortedRows = sortRowsByDate(rows);
  const dates = sortedRows.map(getDateKey);
  const totalDays = sortedRows.length;
  const fullCoveredDates = [];
  const partialCoveredDates = [];
  const pendingRecoveryDates = [];
  const missingRanges = [];
  let coverageScore = 0;
  let gapStart = null;

  sortedRows.forEach((row, index) => {
    const date = dates[index];
    const coverageRatio = getRowCoverageRatio(row);
    const isPendingRecovery = Boolean(row.hasPendingRecovery)
      || toFiniteNumber(row.pendingRecoveryItems) > 0
      || toFiniteNumber(row.pendingRecoveryOrders) > 0;

    coverageScore += coverageRatio;

    if (coverageRatio >= 1) {
      fullCoveredDates.push(date);
    } else if (coverageRatio > 0 || row.hasPartialCOGS) {
      partialCoveredDates.push(date);
    }

    if (isPendingRecovery) {
      pendingRecoveryDates.push(date);
    }

    if (coverageRatio <= 0 && !row.hasPartialCOGS) {
      if (!gapStart) gapStart = date;
    } else if (gapStart) {
      pushMissingRange(missingRanges, gapStart, dates[index - 1] || gapStart);
      gapStart = null;
    }
  });

  if (gapStart) {
    pushMissingRange(missingRanges, gapStart, dates[dates.length - 1] || gapStart);
  }

  const coverageRatio = totalDays > 0 ? coverageScore / totalDays : 0;
  const sortedCovered = fullCoveredDates.slice().sort();

  return {
    totalDays,
    daysWithCOGS: fullCoveredDates.length,
    daysWithPartialCOGS: partialCoveredDates.length,
    daysWithPendingRecovery: pendingRecoveryDates.length,
    coverageScore: Number(coverageScore.toFixed(3)),
    coverageRatio: Number(coverageRatio.toFixed(3)),
    confidence: classifyCoverage(coverageRatio),
    cogsCoveredRange: sortedCovered.length > 0
      ? { from: sortedCovered[0], to: sortedCovered[sortedCovered.length - 1] }
      : { from: null, to: null },
    missingRanges,
  };
}

function sumRows(rows, selector) {
  return (Array.isArray(rows) ? rows : []).reduce((sum, row) => sum + toFiniteNumber(selector(row)), 0);
}

function buildProfitWindowSummary(waterfallRows, revenueRows) {
  const waterfall = sortRowsByDate(waterfallRows);
  const revenueSource = Array.isArray(revenueRows) && revenueRows.length > 0
    ? sortRowsByDate(revenueRows)
    : waterfall;

  const totalProfit = sumRows(waterfall, row => row.trueNetProfit);
  const totalGrossRevenue = sumRows(revenueSource, row => row.revenue);
  const totalRefunded = sumRows(revenueSource, row => row.refunded);
  const totalNetRevenue = sumRows(revenueSource, row => row.netRevenue ?? (toFiniteNumber(row.revenue) - toFiniteNumber(row.refunded)));
  const totalAdSpend = sumRows(waterfall, row => row.adSpendKRW);
  const totalCogs = sumRows(waterfall, row => row.cogs);
  const totalShipping = sumRows(waterfall, row => row.cogsShipping ?? row.shipping);
  const totalPaymentFees = sumRows(waterfall, row => row.paymentFees);
  const totalOrders = sumRows(revenueSource, row => row.orders);
  const totalCosts = totalCogs + totalShipping + totalAdSpend + totalPaymentFees;

  const blendedMargin = divideOrNull(totalProfit, totalNetRevenue);
  const costsShare = divideOrNull(totalCosts, totalNetRevenue);
  const refundRate = divideOrNull(totalRefunded, totalGrossRevenue);

  return {
    daysShown: waterfall.length,
    from: waterfall[0]?.date || null,
    to: waterfall[waterfall.length - 1]?.date || null,
    totalProfit: Math.round(totalProfit),
    totalGrossRevenue: Math.round(totalGrossRevenue),
    totalRefunded: Math.round(totalRefunded),
    totalNetRevenue: Math.round(totalNetRevenue),
    totalAdSpend: Math.round(totalAdSpend),
    totalCogs: Math.round(totalCogs),
    totalShipping: Math.round(totalShipping),
    totalPaymentFees: Math.round(totalPaymentFees),
    totalOrders: Math.round(totalOrders),
    totalCosts: Math.round(totalCosts),
    blendedMargin: blendedMargin == null ? null : Number((blendedMargin * 100).toFixed(1)),
    costsShare: costsShare == null ? null : Number((costsShare * 100).toFixed(1)),
    refundRate: refundRate == null ? null : Number((refundRate * 100).toFixed(1)),
    trueRoas: divideOrNull(totalNetRevenue, totalAdSpend),
    coverage: summarizeWaterfallCoverage(waterfall),
  };
}

function selectWindowRows(profitWaterfall, dailyMerged, days) {
  const waterfall = sliceRowsByTrailingDays(profitWaterfall, days);
  const dateSet = new Set(waterfall.map(getDateKey));
  const revenueRows = sortRowsByDate(dailyMerged).filter(row => dateSet.has(getDateKey(row)));
  return { waterfall, revenueRows };
}

function buildProfitWindowSummaries(profitWaterfall, dailyMerged, options = {}) {
  const windowOptions = {
    '7d': 7,
    '14d': 14,
    '30d': 30,
    all: null,
    ...options,
  };

  return Object.fromEntries(Object.entries(windowOptions).map(([key, days]) => {
    const { waterfall, revenueRows } = selectWindowRows(profitWaterfall, dailyMerged, days);
    return [key, buildProfitWindowSummary(waterfall, revenueRows)];
  }));
}

module.exports = {
  buildProfitWindowSummaries,
  buildProfitWindowSummary,
  divideOrNull,
  selectWindowRows,
  summarizeWaterfallCoverage,
};
