const { KST_TIME_ZONE, formatDateInTimeZone } = require('./time');

const NON_CASH_PAYMENT_STATUS_TOKENS = [
  'PREPARATION',
  'OVERDUE',
  'READY',
  'PENDING',
  'WAIT',
];

function normalizeChannelGroup(method, pgName) {
  const methodLabel = String(method || '').toUpperCase();
  const pgLabel = String(pgName || '').toUpperCase();

  if (methodLabel.includes('CARD') || pgLabel.includes('CARD')) return 'card';
  if (methodLabel.includes('BANK') || pgLabel.includes('BANK')) return 'bank_transfer';
  if (methodLabel.includes('VBANK') || methodLabel.includes('VIRTUAL')) return 'virtual_account';
  if (!methodLabel && !pgLabel) return 'unknown';
  return 'other';
}

function getPaymentTimestamp(order, payment) {
  const candidates = [
    payment?.paymentCompleteTime,
    payment?.bankTransfer?.depositCompletedTime,
    order?.mtime,
    order?.wtime,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return null;
}

function getOrderCashTotals(order) {
  const hasExplicitNetPayment = order?.totalPaymentPrice !== undefined && order?.totalPaymentPrice !== null;
  const netPaidAmount = Number(hasExplicitNetPayment ? order.totalPaymentPrice : (order?.totalPrice ?? 0));
  const refundedAmount = Number(order?.totalRefundedPrice ?? 0);
  // Imweb exposes totalPaymentPrice as the remaining paid balance after refunds.
  const grossApprovedAmount = hasExplicitNetPayment
    ? netPaidAmount + refundedAmount
    : netPaidAmount;

  return {
    approvedAmount: grossApprovedAmount,
    netPaidAmount,
    refundedAmount,
    hasRecognizedCash: grossApprovedAmount > 0 || refundedAmount > 0,
  };
}

function classifyImwebPayment(payment) {
  const rawAmount = Number(payment?.paidPrice || 0);
  if (!rawAmount) return null;

  const status = String(payment?.paymentStatus || '').trim().toUpperCase();
  const magnitude = Math.abs(rawAmount);

  if (status.includes('CANCELLED_BEFORE_DEPOSIT')) {
    return null;
  }

  if (NON_CASH_PAYMENT_STATUS_TOKENS.some(token => status.includes(token))) {
    return null;
  }

  if (rawAmount < 0) {
    return { type: 'refund', amount: magnitude };
  }

  return { type: 'approval', amount: magnitude };
}

function normalizeImwebPayments(orders, options = {}) {
  const includeIgnored = options.includeIgnored === true;
  const payments = [];

  for (const order of Array.isArray(orders) ? orders : []) {
    const paymentList = Array.isArray(order?.payments) ? order.payments : [];
    for (let index = 0; index < paymentList.length; index++) {
      const payment = paymentList[index];
      const completedAt = getPaymentTimestamp(order, payment);
      if (!completedAt) {
        continue;
      }

      const classification = classifyImwebPayment(payment);
      if (!classification && !includeIgnored) {
        continue;
      }

      const status = String(payment?.paymentStatus || '').trim();
      const method = String(payment?.method || '').trim();
      const pgName = String(payment?.pgName || '').trim();
      const amount = classification?.amount || Math.abs(Number(payment?.paidPrice || 0));
      const type = classification?.type || 'ignore';

      payments.push({
        paymentId: `imweb_payment:${order?.orderNo ?? 'unknown'}:${payment?.paymentNo || index}:${index}`,
        source: 'imweb',
        orderNo: order?.orderNo ?? null,
        paymentNo: payment?.paymentNo || null,
        amount,
        signedAmount: type === 'refund' ? -amount : type === 'approval' ? amount : 0,
        type,
        completedAt: completedAt.toISOString(),
        completedDate: formatDateInTimeZone(completedAt, KST_TIME_ZONE),
        method,
        pgName,
        channelGroup: normalizeChannelGroup(method, pgName),
        paymentStatus: status,
        isCancel: String(payment?.isCancel || '').trim(),
        payerName: String(
          payment?.bankTransfer?.depositorName ||
          order?.ordererName ||
          order?.memberName ||
          ''
        ).trim(),
      });
    }
  }

  return payments.sort((left, right) => {
    if (left.completedAt === right.completedAt) return left.paymentId.localeCompare(right.paymentId);
    return left.completedAt.localeCompare(right.completedAt);
  });
}

module.exports = {
  getOrderCashTotals,
  getPaymentTimestamp,
  normalizeChannelGroup,
  normalizeImwebPayments,
};
