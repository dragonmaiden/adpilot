const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProfitWindowSummaries,
  buildProfitWindowSummary,
  divideOrNull,
  summarizeWaterfallCoverage,
} = require('../server/domain/profitWindowMetrics');

function row(date, overrides = {}) {
  return {
    date,
    revenue: 0,
    refunded: 0,
    netRevenue: 0,
    orders: 0,
    cogs: 0,
    cogsShipping: 0,
    adSpendKRW: 0,
    paymentFees: 0,
    trueNetProfit: 0,
    cogsCoverageRatio: 0,
    ...overrides,
  };
}

test('divideOrNull refuses zero and negative denominators', () => {
  assert.equal(divideOrNull(10, 0), null);
  assert.equal(divideOrNull(10, -5), null);
  assert.equal(divideOrNull(10, 5), 2);
});

test('window summaries scope COGS coverage to the selected trailing window', () => {
  const waterfall = [
    row('2026-02-01', { cogsCoverageRatio: 0 }),
    row('2026-02-02', { cogsCoverageRatio: 0 }),
    row('2026-02-03', { cogsCoverageRatio: 0 }),
    row('2026-04-24', { cogsCoverageRatio: 1, hasCOGS: true }),
    row('2026-04-25', { cogsCoverageRatio: 1, hasCOGS: true }),
    row('2026-04-26', { cogsCoverageRatio: 0.5, hasPartialCOGS: true }),
    row('2026-04-27', { cogsCoverageRatio: 0 }),
    row('2026-04-28', { cogsCoverageRatio: 1, hasCOGS: true }),
    row('2026-04-29', { cogsCoverageRatio: 1, hasCOGS: true }),
    row('2026-04-30', { cogsCoverageRatio: 1, hasCOGS: true, hasPendingRecovery: true }),
  ];

  const summaries = buildProfitWindowSummaries(waterfall, waterfall);
  const coverage = summaries['7d'].coverage;

  assert.equal(summaries['7d'].daysShown, 7);
  assert.equal(coverage.totalDays, 7);
  assert.equal(coverage.daysWithCOGS, 5);
  assert.equal(coverage.daysWithPartialCOGS, 1);
  assert.equal(coverage.daysWithPendingRecovery, 1);
  assert.equal(coverage.coverageScore, 5.5);
  assert.equal(coverage.coverageRatio, 0.786);
  assert.deepEqual(coverage.missingRanges, ['2026-04-27']);
  assert.deepEqual(coverage.cogsCoveredRange, { from: '2026-04-24', to: '2026-04-30' });

  assert.equal(summaries.all.coverage.totalDays, 10);
  assert.equal(summaries.all.coverage.coverageRatio, 0.55);
});

test('zero-revenue windows keep denominator-based metrics nullable instead of rendering fake zero percentages', () => {
  const summary = buildProfitWindowSummary([
    row('2026-04-30', {
      revenue: 0,
      refunded: 0,
      netRevenue: 0,
      cogs: 300000,
      cogsShipping: 12000,
      adSpendKRW: 83781,
      paymentFees: 0,
      trueNetProfit: -395781,
      cogsCoverageRatio: 1,
      hasCOGS: true,
    }),
  ]);

  assert.equal(summary.totalGrossRevenue, 0);
  assert.equal(summary.totalNetRevenue, 0);
  assert.equal(summary.blendedMargin, null);
  assert.equal(summary.costsShare, null);
  assert.equal(summary.refundRate, null);
  assert.equal(summary.trueRoas, 0);
});

test('profit window summary sums the canonical waterfall cost components without client formulas', () => {
  const summary = buildProfitWindowSummary([
    row('2026-04-29', {
      revenue: 600000,
      refunded: 100000,
      netRevenue: 500000,
      orders: 3,
      cogs: 180000,
      cogsShipping: 20000,
      adSpendKRW: 90000,
      paymentFees: 30000,
      trueNetProfit: 180000,
      cogsCoverageRatio: 1,
      hasCOGS: true,
    }),
    row('2026-04-30', {
      revenue: 400000,
      refunded: 0,
      netRevenue: 400000,
      orders: 2,
      cogs: 120000,
      cogsShipping: 10000,
      adSpendKRW: 80000,
      paymentFees: 24000,
      trueNetProfit: 166000,
      cogsCoverageRatio: 1,
      hasCOGS: true,
    }),
  ]);

  assert.equal(summary.totalGrossRevenue, 1000000);
  assert.equal(summary.totalRefunded, 100000);
  assert.equal(summary.totalNetRevenue, 900000);
  assert.equal(summary.totalCosts, 554000);
  assert.equal(summary.totalProfit, 346000);
  assert.equal(summary.totalOrders, 5);
  assert.equal(summary.refundRate, 10);
  assert.equal(summary.costsShare, 61.6);
  assert.equal(summary.blendedMargin, 38.4);
  assert.equal(Number(summary.trueRoas.toFixed(2)), 5.29);
});

test('coverage summary groups contiguous missing COGS dates inside the supplied rows only', () => {
  const coverage = summarizeWaterfallCoverage([
    row('2026-04-20', { cogsCoverageRatio: 1, hasCOGS: true }),
    row('2026-04-21', { cogsCoverageRatio: 0 }),
    row('2026-04-22', { cogsCoverageRatio: 0 }),
    row('2026-04-23', { cogsCoverageRatio: 0.5, hasPartialCOGS: true }),
    row('2026-04-24', { cogsCoverageRatio: 0 }),
  ]);

  assert.deepEqual(coverage.missingRanges, ['2026-04-21 -> 2026-04-22', '2026-04-24']);
});
