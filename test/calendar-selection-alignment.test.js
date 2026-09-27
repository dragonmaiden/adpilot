const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyPaywayFeesToFinancialDays,
} = require('../server/domain/paywayFinancials');
const {
  alignCalendarDaysWithSelection,
  buildCalendarMonthRoas,
  buildSelectionSummary,
} = require('../server/services/calendarService');
const { buildDailyCogsWithSheetTotals } = require('../server/services/financialProjectionService');
const { buildProfitWaterfall } = require('../server/transforms/charts');

test('calendar month ROAS uses summed net revenue and Meta spend for that month', () => {
  const months = [
    { start: '2026-08-01', end: '2026-08-31' },
    { start: '2026-09-01', end: '2026-09-30' },
  ];
  const days = [
    { date: '2026-08-31', netRevenue: 100_000, adSpendKRW: 25_000 },
    { date: '2026-09-01', netRevenue: 100_000, adSpendKRW: 20_000 },
    { date: '2026-09-02', netRevenue: 50_000, adSpendKRW: 10_000 },
    { date: '2026-09-03', netRevenue: 300_000, adSpendKRW: 100_000 },
  ];

  const result = buildCalendarMonthRoas(months, days, '2026-09-02');

  assert.equal(result[0].roas, 4);
  assert.equal(result[1].roas, 5);
  assert.equal(result[1].roasNetRevenue, 150_000);
  assert.equal(result[1].roasAdSpendKRW, 30_000);
  assert.deepEqual(months, [
    { start: '2026-08-01', end: '2026-08-31' },
    { start: '2026-09-01', end: '2026-09-30' },
  ]);
});

test('calendar month ROAS stays unavailable when no Meta spend was recorded', () => {
  const [month] = buildCalendarMonthRoas(
    [{ start: '2026-09-01', end: '2026-09-30' }],
    [{ date: '2026-09-01', netRevenue: 80_000, adSpendKRW: 0 }],
    '2026-09-02'
  );

  assert.equal(month.roas, null);
  assert.equal(month.roasNetRevenue, 80_000);
  assert.equal(month.roasAdSpendKRW, 0);
});

test('selected calendar cells use the same Payway-adjusted profit as the selected panels', () => {
  const calendarDays = [
    {
      date: '2026-07-01',
      month: '2026-07',
      revenueIntensity: 1,
      netRevenue: 200_000,
      cogs: 50_000,
      shipping: 6_000,
      paymentFees: 12_000,
      adSpendKRW: 20_000,
      trueNetProfit: 112_000,
    },
    {
      date: '2026-07-02',
      month: '2026-07',
      revenueIntensity: 0.5,
      trueNetProfit: 40_000,
    },
  ];
  const selectionDays = applyPaywayFeesToFinancialDays(
    [calendarDays[0]],
    {
      ready: true,
      totals: { feesComplete: true },
      daily: [{ date: '2026-07-01', processingFees: 7_800 }],
    }
  );

  const alignedDays = alignCalendarDaysWithSelection(calendarDays, selectionDays);

  assert.equal(alignedDays[0].paymentFees, 7_800);
  assert.equal(alignedDays[0].trueNetProfit, 116_200);
  assert.equal(alignedDays[0].trueNetProfit, selectionDays[0].trueNetProfit);
  assert.equal(alignedDays[0].month, '2026-07');
  assert.equal(alignedDays[0].revenueIntensity, 1);
  assert.deepEqual(alignedDays[1], calendarDays[1]);
});

test('selected calendar cells preserve unavailable Payway profit instead of estimated profit', () => {
  const calendarDays = [{
    date: '2026-07-01',
    paymentFees: 12_000,
    trueNetProfit: 112_000,
  }];
  const selectionDays = applyPaywayFeesToFinancialDays(
    calendarDays,
    {
      ready: true,
      totals: { feesComplete: false },
    }
  );

  const [alignedDay] = alignCalendarDaysWithSelection(calendarDays, selectionDays);

  assert.equal(alignedDay.paymentFees, null);
  assert.equal(alignedDay.trueNetProfit, null);
});

test('selected calendar range profit reconciles to the selected panel total', () => {
  const calendarDays = [
    {
      date: '2026-07-01',
      netRevenue: 200_000,
      cogs: 50_000,
      shipping: 6_000,
      paymentFees: 12_000,
      adSpendKRW: 20_000,
      trueNetProfit: 112_000,
    },
    {
      date: '2026-07-02',
      netRevenue: 100_000,
      cogs: 20_000,
      shipping: 3_000,
      paymentFees: 6_000,
      adSpendKRW: 10_000,
      trueNetProfit: 61_000,
    },
  ];
  const selectionDays = applyPaywayFeesToFinancialDays(
    calendarDays,
    {
      ready: true,
      totals: { feesComplete: true },
      daily: [
        { date: '2026-07-01', processingFees: 7_800 },
        { date: '2026-07-02', processingFees: 4_000 },
      ],
    }
  );

  const alignedDays = alignCalendarDaysWithSelection(calendarDays, selectionDays);
  const calendarRangeProfit = alignedDays.reduce(
    (total, day) => total + day.trueNetProfit,
    0
  );
  const selectedPanelProfit = selectionDays.reduce(
    (total, day) => total + day.trueNetProfit,
    0
  );

  assert.equal(calendarRangeProfit, selectedPanelProfit);
  assert.equal(selectedPanelProfit, 179_200);
});

test('selected income statement reconciles observed COGS Sheet totals through refund adjustments', () => {
  const dailyCogs = buildDailyCogsWithSheetTotals({
    dailyCOGS: {
      '2026-08-01': {
        cost: 7_700_000,
        shipping: 348_000,
        purchaseCost: 8_025_000,
        refundCost: 325_000,
        purchaseShipping: 352_000,
        refundShipping: 4_000,
        costCoverageRatio: 1,
      },
    },
    sourceTotalsOrigin: 'raw_sheet_columns',
    sourceTotalsByDate: { '2026-08-01': { cogs: 8_350_000, shipping: 356_000 } },
  });
  const [profitDay] = buildProfitWaterfall([
    {
      date: '2026-08-01',
      revenue: 20_000_000,
      refunded: 0,
      spend: 0,
      spendKrw: 2_000_000,
    },
  ], dailyCogs, 0.02);
  const summary = buildSelectionSummary([{
    ...profitDay,
    shipping: profitDay.cogsShipping,
  }], [], { coverageRatio: 1 }, { ready: true, totals: { feesComplete: true } });

  assert.deepEqual(summary.costReconciliation.cogs, {
    sheetTotal: 8_350_000,
    purchaseTotal: 8_025_000,
    refundMarkedTotal: 325_000,
    netTotal: 7_700_000,
    sourcePartitionDelta: 0,
    netCheckDelta: 0,
    reconciled: true,
  });
  assert.deepEqual(summary.costReconciliation.shipping, {
    sheetTotal: 356_000,
    purchaseTotal: 352_000,
    refundMarkedTotal: 4_000,
    netTotal: 348_000,
    sourcePartitionDelta: 0,
    netCheckDelta: 0,
    reconciled: true,
  });
  assert.equal(summary.costReconciliation.complete, true);
  assert.equal(summary.costReconciliation.reconciled, true);
  assert.equal(summary.totalCosts, 10_448_000);
});

test('selected income statement fails reconciliation when observed COGS Sheet rows do not match the financial partition', () => {
  const summary = buildSelectionSummary([{
    date: '2026-08-01',
    cogs: 70_000,
    shipping: 8_000,
    purchaseCogs: 100_000,
    refundCogs: 30_000,
    purchaseShipping: 10_000,
    refundShipping: 2_000,
    cogsSheetTotal: 140_000,
    shippingSheetTotal: 12_000,
    sheetTotalsObserved: true,
    hasCOGS: true,
    paymentFees: 0,
    trueNetProfit: -78_000,
  }], [], { coverageRatio: 1 }, { ready: true, totals: { feesComplete: true } });

  assert.equal(summary.costReconciliation.complete, true);
  assert.equal(summary.costReconciliation.reconciled, false);
  assert.equal(summary.costReconciliation.cogs.sourcePartitionDelta, 10_000);
  assert.equal(summary.costReconciliation.cogs.netCheckDelta, 0);
});

test('selected income statement keeps source alignment unavailable when parsed COGS Sheet totals are missing', () => {
  const summary = buildSelectionSummary([{
    date: '2026-08-01',
    cogs: 100_000,
    shipping: 10_000,
    purchaseCogs: 100_000,
    purchaseShipping: 10_000,
    hasCOGS: true,
    paymentFees: 0,
    trueNetProfit: -110_000,
  }], [], { coverageRatio: 1 }, { ready: true, totals: { feesComplete: true } });

  assert.equal(summary.costReconciliation.complete, false);
  assert.equal(summary.costReconciliation.reconciled, false);
});

test('matching entered COGS amounts do not imply every active day has complete costs', () => {
  const summary = buildSelectionSummary([{
    date: '2026-09-01', revenue: 100_000, orders: 1,
    cogs: 20_000, shipping: 3_000,
    purchaseCogs: 20_000, purchaseShipping: 3_000,
    cogsSheetTotal: 20_000, shippingSheetTotal: 3_000,
    sheetTotalsObserved: true, hasPartialCOGS: true, hasCOGS: false,
    paymentFees: 1_000, trueNetProfit: 76_000,
  }], [], {}, { ready: true, totals: { feesComplete: true } });
  assert.equal(summary.costReconciliation.amountsReconcile, true);
  assert.equal(summary.costReconciliation.coverageComplete, false);
  assert.equal(summary.costReconciliation.reconciled, false);
  assert.equal(summary.costReconciliation.daysRequiringCOGS, 1);
  assert.equal(summary.costReconciliation.daysWithPartialCOGS, 1);
});
