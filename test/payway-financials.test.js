const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyPaywayFeesToFinancialDays,
  buildNetPaymentChannels,
  summarizePaywayTransactions,
} = require('../server/domain/paywayFinancials');

function makeTransaction(overrides = {}) {
  return {
    transactionId: 'transaction-1',
    transactionAtIso: '2026-07-01T01:00:00.000Z',
    status: '승인',
    approvedAmount: 100_000,
    transactionAmount: 100_000,
    cancelAmount: 0,
    feeAmount: 6_000,
    ...overrides,
  };
}

test('Payway summary reconciles approvals, cancellations, and actual fee reversals', () => {
  const duplicateApproval = makeTransaction();
  const summary = summarizePaywayTransactions([
    duplicateApproval,
    { ...duplicateApproval },
    makeTransaction({
      transactionId: 'transaction-2',
      transactionAtIso: '2026-07-02T01:00:00.000Z',
      approvedAmount: 50_000,
      transactionAmount: 50_000,
      feeAmount: 3_000,
    }),
    makeTransaction({
      transactionId: 'transaction-3',
      transactionAtIso: '2026-07-02T02:00:00.000Z',
      status: '취소',
      approvedAmount: 0,
      transactionAmount: 0,
      cancelAmount: 20_000,
      feeAmount: 1_200,
    }),
    makeTransaction({
      transactionId: 'outside-range',
      transactionAtIso: '2026-06-30T01:00:00.000Z',
    }),
  ], {
    startDate: '2026-07-01',
    endDate: '2026-07-31',
  });

  assert.deepEqual(summary.totals, {
    approvalCount: 2,
    cancellationCount: 1,
    grossApprovals: 150_000,
    cancellations: 20_000,
    netReceipts: 130_000,
    approvalFees: 9_000,
    cancelledFees: 1_200,
    processingFees: 7_800,
    feeRows: 3,
    financialRows: 3,
    feesComplete: true,
  });
  assert.deepEqual(summary.daily.map(row => row.date), ['2026-07-01', '2026-07-02']);
});

test('Payway summary fails fee completeness instead of treating a missing fee as zero', () => {
  const summary = summarizePaywayTransactions([
    makeTransaction({ feeAmount: null }),
  ], {
    startDate: '2026-07-01',
    endDate: '2026-07-31',
  });

  assert.equal(summary.totals.financialRows, 1);
  assert.equal(summary.totals.feeRows, 0);
  assert.equal(summary.totals.feesComplete, false);
  assert.equal(summary.totals.processingFees, null);
});

test('payment channels use Payway net receipts and derive bank transfer as the Imweb remainder', () => {
  const channels = buildNetPaymentChannels({
    totalNetRevenue: 200_000,
    totalOrderCount: 3,
    paywaySummary: {
      ready: true,
      source: 'payway',
      dateBasis: 'payment_transaction_kst',
      fetchedAt: '2026-07-24T00:00:00.000Z',
      stale: false,
      totals: {
        approvalCount: 2,
        cancellationCount: 1,
        grossApprovals: 150_000,
        cancellations: 20_000,
        netReceipts: 130_000,
        approvalFees: 9_000,
        cancelledFees: 1_200,
        processingFees: 7_800,
        feeRows: 3,
        financialRows: 3,
        feesComplete: true,
      },
    },
  });

  const byChannel = Object.fromEntries(
    channels.rows.map(row => [row.channel, row.revenue])
  );

  assert.equal(channels.basis, 'net_receipts');
  assert.equal(byChannel.card, 130_000);
  assert.equal(byChannel.bank_transfer, 70_000);
  assert.equal(channels.reconciliation.allocatedNetRevenue, 200_000);
  assert.equal(channels.reconciliation.gap, 0);
  assert.equal(channels.reconciliation.invalidNegativeBankRemainder, false);
});

test('payment channels expose an invalid negative bank remainder', () => {
  const channels = buildNetPaymentChannels({
    totalNetRevenue: 100_000,
    totalOrderCount: 1,
    paywaySummary: {
      ready: true,
      totals: { netReceipts: 130_000 },
    },
  });

  assert.equal(channels.rows[1].revenue, -30_000);
  assert.equal(channels.reconciliation.invalidNegativeBankRemainder, true);
});

test('Payway fees replace the estimated fee and recalculate canonical selected profit', () => {
  const [day] = applyPaywayFeesToFinancialDays([
    {
      date: '2026-07-01',
      netRevenue: 200_000,
      cogs: 50_000,
      shipping: 6_000,
      paymentFees: 12_000,
      adSpendKRW: 20_000,
      trueNetProfit: 112_000,
    },
  ], {
    ready: true,
    totals: { feesComplete: true },
    daily: [{ date: '2026-07-01', processingFees: 7_800 }],
  });

  assert.equal(day.paymentFees, 7_800);
  assert.equal(day.trueNetProfit, 116_200);
  assert.equal(day.margin, 58.1);
  assert.equal(day.paymentFeeSource, 'payway');
  assert.equal(day.paymentFeesComplete, true);
});

test('selected profit becomes unavailable when Payway fees are incomplete', () => {
  const [day] = applyPaywayFeesToFinancialDays([
    {
      date: '2026-07-01',
      netRevenue: 200_000,
      paymentFees: 12_000,
      trueNetProfit: 100_000,
    },
  ], {
    ready: true,
    totals: { feesComplete: false },
  });

  assert.equal(day.paymentFees, null);
  assert.equal(day.trueNetProfit, null);
  assert.equal(day.margin, null);
  assert.equal(day.paymentFeesComplete, false);
});
