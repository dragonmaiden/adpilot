const { KST_TIME_ZONE, formatDateInTimeZone } = require('./time');

function toAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.abs(amount) : 0;
}

function toOptionalAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.abs(amount) : null;
}

function isApproval(transaction) {
  return String(transaction?.status || '').trim() === '승인'
    && toAmount(transaction?.transactionAmount || transaction?.approvedAmount) > 0
    && toAmount(transaction?.cancelAmount) === 0;
}

function isCancellation(transaction) {
  return String(transaction?.status || '').includes('취소')
    || toAmount(transaction?.cancelAmount) > 0;
}

function getTransactionDate(transaction) {
  if (!transaction?.transactionAtIso) return null;
  return formatDateInTimeZone(transaction.transactionAtIso, KST_TIME_ZONE);
}

function getTransactionAmount(transaction, kind) {
  if (kind === 'cancellation') {
    return toAmount(
      transaction?.cancelAmount
      || transaction?.transactionAmount
      || transaction?.approvedAmount
    );
  }

  return toAmount(transaction?.transactionAmount || transaction?.approvedAmount);
}

function createDailyRow(date) {
  return {
    date,
    approvalCount: 0,
    cancellationCount: 0,
    grossApprovals: 0,
    cancellations: 0,
    netReceipts: 0,
    approvalFees: 0,
    cancelledFees: 0,
    processingFees: 0,
    feeRows: 0,
    financialRows: 0,
    feesComplete: true,
  };
}

function applyTransaction(row, transaction, kind) {
  const amount = getTransactionAmount(transaction, kind);
  const fee = toOptionalAmount(transaction?.feeAmount);

  row.financialRows += 1;
  if (fee == null) {
    row.feesComplete = false;
  } else {
    row.feeRows += 1;
  }

  if (kind === 'approval') {
    row.approvalCount += 1;
    row.grossApprovals += amount;
    row.approvalFees += fee || 0;
  } else {
    row.cancellationCount += 1;
    row.cancellations += amount;
    row.cancelledFees += fee || 0;
  }

  row.netReceipts = row.grossApprovals - row.cancellations;
  row.processingFees = row.approvalFees - row.cancelledFees;
}

function buildTotals(daily) {
  const totals = daily.reduce((summary, row) => {
    summary.approvalCount += row.approvalCount;
    summary.cancellationCount += row.cancellationCount;
    summary.grossApprovals += row.grossApprovals;
    summary.cancellations += row.cancellations;
    summary.netReceipts += row.netReceipts;
    summary.approvalFees += row.approvalFees;
    summary.cancelledFees += row.cancelledFees;
    summary.processingFees += row.processingFees;
    summary.feeRows += row.feeRows;
    summary.financialRows += row.financialRows;
    summary.feesComplete = summary.feesComplete && row.feesComplete;
    return summary;
  }, {
    approvalCount: 0,
    cancellationCount: 0,
    grossApprovals: 0,
    cancellations: 0,
    netReceipts: 0,
    approvalFees: 0,
    cancelledFees: 0,
    processingFees: 0,
    feeRows: 0,
    financialRows: 0,
    feesComplete: true,
  });

  if (!totals.feesComplete) {
    totals.processingFees = null;
  }

  return totals;
}

function summarizePaywayTransactions(transactions, { startDate, endDate } = {}) {
  const dailyByDate = new Map();
  const seen = new Set();

  for (const transaction of Array.isArray(transactions) ? transactions : []) {
    const transactionId = String(transaction?.transactionId || '').trim();
    if (transactionId && seen.has(transactionId)) continue;
    if (transactionId) seen.add(transactionId);

    const date = getTransactionDate(transaction);
    if (!date || (startDate && date < startDate) || (endDate && date > endDate)) {
      continue;
    }

    const kind = isApproval(transaction)
      ? 'approval'
      : isCancellation(transaction)
        ? 'cancellation'
        : null;
    if (!kind) continue;

    const row = dailyByDate.get(date) || createDailyRow(date);
    applyTransaction(row, transaction, kind);
    dailyByDate.set(date, row);
  }

  const daily = [...dailyByDate.values()].sort((left, right) => (
    left.date.localeCompare(right.date)
  ));

  return {
    source: 'payway',
    dateBasis: 'payment_transaction_kst',
    range: {
      start: startDate || daily[0]?.date || null,
      end: endDate || daily[daily.length - 1]?.date || null,
    },
    totals: buildTotals(daily),
    daily,
  };
}

function buildNetPaymentChannels({
  totalNetRevenue,
  totalOrderCount,
  paywaySummary,
}) {
  const netRevenue = Number(totalNetRevenue);
  const recognizedNetRevenue = Number.isFinite(netRevenue) ? Math.round(netRevenue) : 0;
  const ready = paywaySummary?.ready === true;
  const cardNetRevenue = ready
    ? Math.round(Number(paywaySummary?.totals?.netReceipts || 0))
    : null;
  const bankTransferNetRevenue = cardNetRevenue == null
    ? null
    : recognizedNetRevenue - cardNetRevenue;
  const allocatedNetRevenue = cardNetRevenue == null
    ? null
    : cardNetRevenue + bankTransferNetRevenue;

  return {
    ready,
    basis: 'net_receipts',
    dateBasis: paywaySummary?.dateBasis || 'payment_transaction_kst',
    totalNetRevenue: recognizedNetRevenue,
    totalOrderCount: Number(totalOrderCount || 0),
    fetchedAt: paywaySummary?.fetchedAt || null,
    stale: Boolean(paywaySummary?.stale),
    error: paywaySummary?.error || null,
    rows: [
      {
        channel: 'card',
        revenue: cardNetRevenue,
        orderCount: ready ? Number(paywaySummary?.totals?.approvalCount || 0) : null,
        cancellationCount: ready ? Number(paywaySummary?.totals?.cancellationCount || 0) : null,
        derived: false,
      },
      {
        channel: 'bank_transfer',
        revenue: bankTransferNetRevenue,
        orderCount: null,
        cancellationCount: null,
        derived: true,
      },
    ],
    payway: ready ? {
      ...paywaySummary.totals,
    } : null,
    reconciliation: {
      allocatedNetRevenue,
      gap: allocatedNetRevenue == null
        ? null
        : recognizedNetRevenue - allocatedNetRevenue,
      invalidNegativeBankRemainder: bankTransferNetRevenue != null
        && bankTransferNetRevenue < 0,
    },
  };
}

function applyPaywayFeesToFinancialDays(days, paywaySummary) {
  const rows = Array.isArray(days) ? days : [];
  const feesComplete = paywaySummary?.ready === true
    && paywaySummary?.totals?.feesComplete === true;
  const paywayByDate = new Map(
    (Array.isArray(paywaySummary?.daily) ? paywaySummary.daily : [])
      .map(row => [row.date, row])
  );

  return rows.map(day => {
    if (!feesComplete) {
      return {
        ...day,
        paymentFees: null,
        trueNetProfit: null,
        margin: null,
        paymentFeeSource: 'payway',
        paymentFeesComplete: false,
      };
    }

    const paymentFees = Math.round(Number(paywayByDate.get(day.date)?.processingFees || 0));
    const netRevenue = Number(day.netRevenue || 0);
    const trueNetProfit = Math.round(
      netRevenue
      - Number(day.cogs || 0)
      - Number(day.shipping || 0)
      - paymentFees
      - Number(day.adSpendKRW || 0)
    );

    return {
      ...day,
      paymentFees,
      trueNetProfit,
      margin: netRevenue > 0
        ? Number(((trueNetProfit / netRevenue) * 100).toFixed(1))
        : null,
      paymentFeeSource: 'payway',
      paymentFeesComplete: true,
    };
  });
}

module.exports = {
  summarizePaywayTransactions,
  buildNetPaymentChannels,
  applyPaywayFeesToFinancialDays,
  isApproval,
  isCancellation,
};
