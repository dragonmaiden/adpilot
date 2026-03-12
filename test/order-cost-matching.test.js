const test = require('node:test');
const assert = require('node:assert/strict');

const { matchOrdersToCogs } = require('../server/services/orderCostMatchingService');

function createOrder(overrides = {}) {
  return {
    orderNo: '1001',
    ordererName: 'Kim',
    wtime: '2026-03-10T12:00:00.000Z',
    ...overrides,
  };
}

function createCogsOrder(overrides = {}) {
  return {
    orderNumber: '1001',
    date: '2026-03-10',
    name: 'Kim',
    ...overrides,
  };
}

test('matchOrdersToCogs prefers exact order-number matches', () => {
  const result = matchOrdersToCogs(
    [createOrder({ orderNo: '1001', ordererName: 'Kim' })],
    [createCogsOrder({ orderNumber: '1001', name: 'Kim' })]
  );

  assert.equal(result.matchesByOrderNo.get('1001').matchMode, 'exact_order_number');
  assert.equal(result.unmatchedCogsOrders.length, 0);
});

test('matchOrdersToCogs falls back to a unique date and customer-name match', () => {
  const result = matchOrdersToCogs(
    [createOrder({ orderNo: '2001', ordererName: '김가영' })],
    [createCogsOrder({
      orderNumber: '(17038) 경기 용인시 처인구 경안천로 368',
      date: '2026-03-10',
      name: '김가영',
    })]
  );

  assert.equal(result.matchesByOrderNo.get('2001').matchMode, 'date_customer_unique');
  assert.equal(result.unmatchedCogsOrders.length, 0);
});

test('matchOrdersToCogs leaves ambiguous same-day same-name cases unmatched', () => {
  const result = matchOrdersToCogs(
    [
      createOrder({ orderNo: '3001', ordererName: '홍길동' }),
      createOrder({ orderNo: '3002', ordererName: '홍길동', wtime: '2026-03-10T13:00:00.000Z' }),
    ],
    [createCogsOrder({
      orderNumber: '55',
      date: '2026-03-10',
      name: '홍길동',
    })]
  );

  assert.equal(result.matchesByOrderNo.size, 0);
  assert.equal(result.unmatchedCogsOrders.length, 1);
});
