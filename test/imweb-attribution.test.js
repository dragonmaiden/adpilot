const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractOrderAttribution,
  summarizeOrderAttribution,
} = require('../server/domain/imwebAttribution');
const { processOrders } = require('../server/modules/imwebClient');

function createOrder(overrides = {}) {
  return {
    orderNo: '1001',
    orderStatus: 'OPEN',
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

test('extractOrderAttribution treats fbclid as a high-confidence Meta signal', () => {
  const attribution = extractOrderAttribution(createOrder({
    fbclid: 'fb.1.123456',
    utmCampaign: 'spring-scale',
  }));

  assert.equal(attribution.bucket, 'meta');
  assert.equal(attribution.marketingSource, 'meta_ads');
  assert.equal(attribution.basis, 'click_id');
  assert.equal(attribution.confidence, 'high');
  assert.equal(attribution.hasCampaignSignal, true);
});

test('extractOrderAttribution keeps plain IMWEB storefront orders unattributed', () => {
  const attribution = extractOrderAttribution(createOrder());

  assert.equal(attribution.bucket, 'unattributed');
  assert.equal(attribution.marketingSource, 'imweb_storefront');
  assert.equal(attribution.basis, 'sale_channel');
  assert.equal(attribution.confidence, 'low');
});

test('summaries carry explicit attribution coverage into processOrders', () => {
  const revenueData = processOrders([
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
      saleChannel: 'IMWEB',
    }),
  ]);

  const directSummary = summarizeOrderAttribution([
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
      saleChannel: 'IMWEB',
    }),
  ]);

  assert.deepEqual(revenueData.attributionSummary, directSummary);
  assert.equal(revenueData.attributionSummary.recognizedOrders, 2);
  assert.equal(revenueData.attributionSummary.byBucket.meta, 1);
  assert.equal(revenueData.attributionSummary.byBucket.unattributed, 1);
  assert.equal(revenueData.attributionSummary.netRevenueByBucket.meta, 97000);
  assert.equal(revenueData.attributionSummary.netRevenueByBucket.unattributed, 50000);
  assert.equal(revenueData.attributionSummary.attributionCoverageRate, 0.5);
});
