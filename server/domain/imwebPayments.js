const { KST_TIME_ZONE, formatDateInTimeZone } = require('./time');

const NON_CASH_PAYMENT_STATUS_TOKENS = [
  'PREPARATION',
  'OVERDUE',
  'READY',
  'PENDING',
  'WAIT',
];
const PAYMENT_REVENUE_CHANNELS = [
  'card',
  'bank_transfer',
  'virtual_account',
  'other',
  'unknown',
];

function getImwebOrderPaymentState(order) {
  const payments = Array.isArray(order?.payments) ? order.payments : [];
  const paymentStatuses = [...new Set(
    payments
      .map(payment => String(payment?.paymentStatus || '').trim().toUpperCase())
      .filter(Boolean)
  )];
  const hasAwaitingStatus = paymentStatuses.some(status => (
    NON_CASH_PAYMENT_STATUS_TOKENS.some(token => status.includes(token))
      || status.includes('REQUEST')
  ));
  const hasAwaitingBankTransfer = payments.some(payment => {
    const status = String(payment?.paymentStatus || '').trim().toUpperCase();
    const isAwaiting = NON_CASH_PAYMENT_STATUS_TOKENS.some(token => status.includes(token))
      || status.includes('REQUEST');
    return isAwaiting && normalizeChannelGroup(payment?.method, payment?.pgName) === 'bank_transfer';
  });

  return {
    hasCompletedPayment: normalizeImwebPayments([order]).some(payment => payment.type === 'approval'),
    hasAwaitingStatus,
    hasAwaitingBankTransfer,
    paymentStatuses,
  };
}

function normalizeChannelGroup(method, pgName) {
  const methodLabel = String(method || '').toUpperCase();
  const pgLabel = String(pgName || '').toUpperCase();

  if (methodLabel.includes('CARD') || pgLabel.includes('CARD')) return 'card';
  if (
    methodLabel.includes('VBANK')
      || methodLabel.includes('VIRTUAL')
      || pgLabel.includes('VBANK')
      || pgLabel.includes('VIRTUAL')
  ) return 'virtual_account';
  if (methodLabel.includes('BANK') || pgLabel.includes('BANK')) return 'bank_transfer';
  if (!methodLabel && !pgLabel) return 'unknown';
  return 'other';
}

function maskName(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length === 1) return '*';
  if (text.length === 2) return `${text[0]}*`;
  return `${text[0]}${'*'.repeat(Math.max(1, text.length - 2))}${text[text.length - 1]}`;
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
        payerName: maskName(String(
          payment?.bankTransfer?.depositorName ||
          order?.ordererName ||
          order?.memberName ||
          ''
        ).trim()),
      });
    }
  }

  return payments.sort((left, right) => {
    if (left.completedAt === right.completedAt) return left.paymentId.localeCompare(right.paymentId);
    return left.completedAt.localeCompare(right.completedAt);
  });
}

function getOrderRevenueChannel(order, cardOrderNos) {
  const orderNo = String(order?.orderNo || '').trim();
  if (orderNo && cardOrderNos.has(orderNo)) {
    return 'card';
  }

  const normalizedChannels = new Set(
    normalizeImwebPayments([order])
      .filter(payment => payment.type === 'approval')
      .map(payment => payment.channelGroup)
      .filter(channel => channel && channel !== 'unknown')
  );
  if (normalizedChannels.size === 1) {
    return Array.from(normalizedChannels)[0];
  }
  if (normalizedChannels.size > 1) {
    return 'other';
  }

  const declaredChannels = new Set(
    (Array.isArray(order?.payments) ? order.payments : [])
      .map(payment => normalizeChannelGroup(payment?.method, payment?.pgName))
      .filter(channel => channel !== 'unknown')
  );
  if (declaredChannels.size === 1) {
    return Array.from(declaredChannels)[0];
  }
  if (declaredChannels.size > 1) {
    return 'other';
  }

  return normalizeChannelGroup(order?.paymentMethod, order?.pgName);
}

function buildPaymentChannelRevenue(orders, options = {}) {
  const cardOrderNos = options.cardOrderNos instanceof Set
    ? options.cardOrderNos
    : new Set(Array.isArray(options.cardOrderNos) ? options.cardOrderNos.map(String) : []);
  const bankTransferAsRemainder = options.bankTransferAsRemainder === true;
  const channelTotals = new Map(
    PAYMENT_REVENUE_CHANNELS.map(channel => [channel, {
      channel,
      revenue: 0,
      orderCount: 0,
    }])
  );
  let totalGrossRevenue = 0;
  let totalOrderCount = 0;

  for (const order of Array.isArray(orders) ? orders : []) {
    const grossRevenue = Math.max(0, Math.round(getOrderCashTotals(order).approvedAmount));
    if (grossRevenue <= 0) continue;

    totalGrossRevenue += grossRevenue;
    totalOrderCount += 1;
    const channel = getOrderRevenueChannel(order, cardOrderNos);
    if (bankTransferAsRemainder && channel !== 'card') {
      continue;
    }

    const row = channelTotals.get(channel) || channelTotals.get('other');
    row.revenue += grossRevenue;
    row.orderCount += 1;
  }

  if (bankTransferAsRemainder) {
    const card = channelTotals.get('card');
    const bankTransfer = channelTotals.get('bank_transfer');
    bankTransfer.revenue = totalGrossRevenue - card.revenue;
    bankTransfer.orderCount = totalOrderCount - card.orderCount;
  }

  const rows = PAYMENT_REVENUE_CHANNELS.map(channel => channelTotals.get(channel));
  return {
    totalGrossRevenue,
    totalOrderCount,
    rows,
  };
}

module.exports = {
  buildPaymentChannelRevenue,
  getOrderCashTotals,
  getImwebOrderPaymentState,
  getPaymentTimestamp,
  normalizeChannelGroup,
  normalizeImwebPayments,
};
