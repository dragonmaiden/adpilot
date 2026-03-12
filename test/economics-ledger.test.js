const test = require('node:test');
const assert = require('node:assert/strict');

const { buildEconomicsLedger } = require('../server/services/economicsLedgerService');

function createOrder(overrides = {}) {
  return {
    orderNo: '1001',
    orderStatus: 'OPEN',
    ordererName: 'Kim',
    saleChannel: 'IMWEB',
    device: 'MOBILE',
    country: 'KR',
    totalPaymentPrice: 100000,
    totalRefundedPrice: 0,
    wtime: '2026-03-10T12:00:00.000Z',
    payments: [],
    sections: [
      {
        orderSectionStatus: 'OPEN',
        sectionItems: [
          {
            qty: 1,
            productInfo: {
              prodName: 'Signature Scarf',
              brand: 'LOUISVUITTON',
            },
          },
        ],
      },
    ],
    ...overrides,
  };
}

test('buildEconomicsLedger keeps unattributed revenue explicit and links exact COGS matches', () => {
  const ledger = buildEconomicsLedger({
    orders: [
      createOrder({
        orderNo: '1001',
        totalPaymentPrice: 97000,
        totalRefundedPrice: 3000,
        fbclid: 'fb.1.123456',
      }),
      createOrder({
        orderNo: '1002',
        totalPaymentPrice: 50000,
        totalRefundedPrice: 0,
      }),
    ],
    cogsData: {
      orders: [
        {
          orderNumber: '1001',
          date: '2026-03-10',
          cost: 30000,
          shipping: 4000,
          refundCost: 0,
          refundShipping: 0,
          netCost: 30000,
          netShipping: 4000,
          costCoverageRatio: 1,
        },
        {
          orderNumber: '2001',
          date: '2026-03-10',
          cost: 20000,
          shipping: 4000,
          refundCost: 0,
          refundShipping: 0,
          netCost: 20000,
          netShipping: 4000,
          costCoverageRatio: 1,
          name: 'Unmatched Customer',
          sequenceNo: '3',
        },
      ],
    },
    campaignInsights: [
      { campaign_id: 'c1', campaign_name: 'Scale Winner', date_start: '2026-03-10', spend: '10' },
      { campaign_id: 'c2', campaign_name: 'Drag Campaign', date_start: '2026-03-10', spend: '5' },
    ],
    campaigns: [
      { id: 'c1', name: 'Scale Winner' },
      { id: 'c2', name: 'Drag Campaign' },
    ],
  });

  assert.equal(ledger.summary.recognizedOrders, 2);
  assert.equal(ledger.summary.matchedOrdersToCogs, 1);
  assert.equal(ledger.summary.exactMatchedOrdersToCogs, 1);
  assert.equal(ledger.summary.fallbackMatchedOrdersToCogs, 0);
  assert.equal(ledger.summary.unmatchedOrdersToCogs, 1);
  assert.equal(ledger.summary.unmatchedCogsOrders, 1);
  assert.equal(ledger.summary.metaAttributedNetRevenue, 97000);
  assert.equal(ledger.summary.unattributedNetRevenue, 50000);
  assert.equal(ledger.summary.totalMetaSpendKrw, 21750);
  assert.equal(ledger.summary.attributionCoverageRate, 0.5);
  assert.equal(ledger.summary.cogsMatchRate, 0.5);

  const kinds = ledger.rows.map(row => row.kind);
  assert.ok(kinds.includes('order_approval'));
  assert.ok(kinds.includes('order_refund'));
  assert.ok(kinds.includes('payment_fee'));
  assert.ok(kinds.includes('cogs_purchase'));
  assert.ok(kinds.includes('shipping_purchase'));
  assert.ok(kinds.includes('meta_spend'));

  const matchedOrder = ledger.orderSnapshots.find(order => order.orderNo === '1001');
  const unmatchedOrder = ledger.orderSnapshots.find(order => order.orderNo === '1002');

  assert.equal(matchedOrder.cogsMatched, true);
  assert.equal(matchedOrder.cogsMatchMode, 'exact_order_number');
  assert.equal(matchedOrder.attribution.bucket, 'meta');
  assert.equal(unmatchedOrder.cogsMatched, false);
  assert.equal(unmatchedOrder.attribution.bucket, 'unattributed');
});

test('buildEconomicsLedger records conservative fallback matches from date and customer name', () => {
  const ledger = buildEconomicsLedger({
    orders: [
      createOrder({
        orderNo: '2001',
        ordererName: '김가영',
        totalPaymentPrice: 62000,
        totalRefundedPrice: 0,
        wtime: '2026-02-08T05:00:00.000Z',
      }),
    ],
    cogsData: {
      orders: [
        {
          orderNumber: '(17038) 경기 용인시 처인구 경안천로 368',
          date: '2026-02-08',
          name: '김가영',
          cost: 35000,
          shipping: 4000,
          refundCost: 0,
          refundShipping: 0,
          netCost: 35000,
          netShipping: 4000,
          costCoverageRatio: 1,
        },
      ],
    },
    campaignInsights: [],
    campaigns: [],
  });

  assert.equal(ledger.summary.recognizedOrders, 1);
  assert.equal(ledger.summary.matchedOrdersToCogs, 1);
  assert.equal(ledger.summary.exactMatchedOrdersToCogs, 0);
  assert.equal(ledger.summary.fallbackMatchedOrdersToCogs, 1);
  assert.equal(ledger.orderSnapshots[0].cogsMatchMode, 'date_customer_unique');
});
