const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPaymentChannelRevenue,
} = require('../server/domain/imwebPayments');

function makeOrder(orderNo, {
  netPaid,
  refunded = 0,
  method = '',
  pgName = '',
} = {}) {
  return {
    orderNo,
    totalPaymentPrice: netPaid,
    totalRefundedPrice: refunded,
    payments: method || pgName
      ? [{
        method,
        pgName,
        paidPrice: netPaid + refunded,
        paymentStatus: 'COMPLETE',
      }]
      : [],
  };
}

test('payment-channel revenue uses identified cards and treats bank transfer as the gross-revenue remainder', () => {
  const result = buildPaymentChannelRevenue([
    makeOrder('direct-card', { netPaid: 100_000, method: 'CARD' }),
    makeOrder('payway-card', { netPaid: 200_000, method: 'BANKTRANSFER' }),
    makeOrder('manual-bank', { netPaid: 300_000, method: 'BANKTRANSFER' }),
    makeOrder('unclassified', { netPaid: 50_000 }),
  ], {
    cardOrderNos: new Set(['payway-card']),
    bankTransferAsRemainder: true,
  });

  const byChannel = Object.fromEntries(result.rows.map(row => [row.channel, row]));

  assert.equal(byChannel.card.revenue, 300_000);
  assert.equal(byChannel.card.orderCount, 2);
  assert.equal(byChannel.bank_transfer.revenue, 350_000);
  assert.equal(byChannel.bank_transfer.orderCount, 2);
  assert.equal(byChannel.unknown.revenue, 0);
  assert.equal(byChannel.unknown.orderCount, 0);
  assert.equal(result.totalGrossRevenue, 650_000);
  assert.equal(result.totalOrderCount, 4);
  assert.equal(
    byChannel.card.revenue + byChannel.bank_transfer.revenue,
    result.totalGrossRevenue
  );
});

test('payment-channel rows reconcile to gross approved revenue including later refunds', () => {
  const result = buildPaymentChannelRevenue([
    makeOrder('refunded-card', {
      netPaid: 90_000,
      refunded: 10_000,
      method: 'CARD',
    }),
  ]);

  assert.equal(result.totalGrossRevenue, 100_000);
  assert.equal(
    result.rows.reduce((sum, row) => sum + row.revenue, 0),
    result.totalGrossRevenue
  );
});
