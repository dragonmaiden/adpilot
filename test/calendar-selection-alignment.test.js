const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyPaywayFeesToFinancialDays,
} = require('../server/domain/paywayFinancials');
const {
  alignCalendarDaysWithSelection,
} = require('../server/services/calendarService');

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
