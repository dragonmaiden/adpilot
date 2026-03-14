const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSheetDate,
  buildSheetTargets,
  parseOrderItems,
  aggregateCOGSItems,
} = require('../server/modules/cogsClient');
const { buildDataCoverage, buildProfitWaterfall } = require('../server/transforms/charts');

function makeItem(overrides = {}) {
  return {
    sheetLabel: '3월',
    rowNumber: 1,
    sequenceNo: '1',
    orderNumber: 'o1',
    orderKey: 'o1',
    date: '2026-03-10',
    name: 'Customer',
    productUrl: '',
    sellerNo: '',
    productName: 'Item',
    cost: 0,
    shipping: 0,
    payment: true,
    delivery: true,
    note: '',
    isRefund: false,
    isPendingRecovery: false,
    refundSignals: {},
    pendingRecoverySignals: {},
    warnings: [],
    ...overrides,
  };
}

test('normalizeSheetDate parses Google Sheets serial dates', () => {
  assert.equal(normalizeSheetDate('46093'), '2026-03-12');
});

test('buildSheetTargets merges configured month labels with workbook-discovered monthly tabs', () => {
  const targets = buildSheetTargets([
    { name: '2월 주문', path: 'xl/worksheets/sheet1.xml' },
    { name: '3월 주문', path: 'xl/worksheets/sheet2.xml' },
    { name: '4월 주문', path: 'xl/worksheets/sheet3.xml' },
  ]);

  assert.deepEqual(
    targets.map(target => ({ label: target.label, sheetName: target.sheetName, discovered: target.discovered })),
    [
      { label: '2월', sheetName: '2월 주문', discovered: false },
      { label: '3월', sheetName: '3월 주문', discovered: false },
      { label: '4월 주문', sheetName: '4월 주문', discovered: true },
    ]
  );
});

test('parseOrderItems supports the compact delivery-details cell in column M', () => {
  const items = parseOrderItems([
    ['번호', '날짜', '이름', '주문번호', '', '', '', '', '', '', '', '', 'delivery note'],
    [],
    [
      '101',
      '2026-03-13',
      '홍신희',
      '20260313225187',
      '',
      '',
      '실크 모노그램 방도',
      '',
      '',
      'FALSE',
      'FALSE',
      '',
      'receiver: 홍신희 | phone: 01012341234 | address: 06236 서울 강남구 테헤란로 123 5층 | delivery note: 문 앞에 놓아주세요',
      '',
      '',
      '',
      '',
    ],
  ], { sheetLabel: '3월 주문' });

  assert.equal(items.length, 1);
  assert.equal(items[0].note, '문 앞에 놓아주세요');
  assert.equal(items[0].ordererPhone, '01012341234');
  assert.equal(items[0].receiverName, '홍신희');
  assert.equal(items[0].receiverPhone, '01012341234');
  assert.equal(items[0].zipcode, '06236');
  assert.equal(items[0].address, '서울 강남구 테헤란로 123 5층');
});

test('aggregateCOGSItems counts zero-cost purchase rows and applies refund-valued rows as adjustments', () => {
  const result = aggregateCOGSItems([
    makeItem({
      orderNumber: 'purchase-order',
      orderKey: 'purchase-order',
      cost: 100000,
      shipping: 10000,
    }),
    makeItem({
      rowNumber: 2,
      orderNumber: 'purchase-order',
      orderKey: 'purchase-order',
      productName: 'Missing cost row',
      warnings: ['missing_cost_and_shipping'],
    }),
    makeItem({
      rowNumber: 3,
      orderNumber: 'purchase-order',
      orderKey: 'purchase-order',
      productName: 'Refund adjustment',
      cost: 40000,
      shipping: 4000,
      isRefund: true,
      refundSignals: { redText: true },
    }),
    makeItem({
      rowNumber: 4,
      orderNumber: 'refund-only-order',
      orderKey: 'refund-only-order',
      productName: 'Refund only',
      cost: 20000,
      shipping: 2000,
      isRefund: true,
      refundSignals: { redText: true },
    }),
  ]);

  assert.equal(result.itemCount, 2);
  assert.equal(result.purchaseCount, 1);
  assert.equal(result.missingCostItemCount, 1);
  assert.equal(result.incompletePurchaseCount, 1);
  assert.equal(result.refundCount, 2);
  assert.equal(result.totalCOGS, 40000);
  assert.equal(result.totalShipping, 4000);
  assert.equal(result.grossCOGS, 100000);
  assert.equal(result.refundCOGS, 60000);
  assert.equal(result.dailyCOGS['2026-03-10'].costCoverageRatio, 0.5);
  assert.equal(result.dailyCOGS['2026-03-10'].isComplete, false);
});

test('coverage and waterfall mark partial COGS days separately from fully covered days', () => {
  const dailyMerged = [
    { date: '2026-03-10', revenue: 300000, refunded: 0, spend: 50 },
    { date: '2026-03-11', revenue: 200000, refunded: 0, spend: 50 },
    { date: '2026-03-12', revenue: 100000, refunded: 0, spend: 25 },
  ];
  const dailyCOGS = {
    '2026-03-10': {
      cost: 100000,
      shipping: 10000,
      costCoverageRatio: 1,
      isComplete: true,
    },
    '2026-03-11': {
      cost: 50000,
      shipping: 5000,
      costCoverageRatio: 0.5,
      isComplete: false,
    },
    '2026-03-12': {
      cost: 0,
      shipping: 0,
      costCoverageRatio: 1,
      isComplete: true,
      pendingRecoveryItems: 1,
      pendingRecoveryOrders: 1,
    },
  };

  const coverage = buildDataCoverage(dailyMerged, dailyCOGS);
  const waterfall = buildProfitWaterfall(dailyMerged, dailyCOGS, 0.033);

  assert.equal(coverage.daysWithCOGS, 2);
  assert.equal(coverage.daysWithPartialCOGS, 1);
  assert.equal(coverage.daysWithPendingRecovery, 1);
  assert.equal(coverage.coverageRatio, 0.833);
  assert.equal(waterfall[0].hasCOGS, true);
  assert.equal(waterfall[0].hasPartialCOGS, false);
  assert.equal(waterfall[1].hasCOGS, false);
  assert.equal(waterfall[1].hasPartialCOGS, true);
  assert.equal(waterfall[2].hasPendingRecovery, true);
});

test('aggregateCOGSItems tracks pending recovery rows separately from incomplete costing', () => {
  const result = aggregateCOGSItems([
    makeItem({
      orderNumber: 'pending-order',
      orderKey: 'pending-order',
      productName: 'Cancelled hold row',
      note: '중간상 환급대기',
      isPendingRecovery: true,
    }),
    makeItem({
      rowNumber: 2,
      orderNumber: 'costed-order',
      orderKey: 'costed-order',
      cost: 50000,
      shipping: 4000,
    }),
  ]);

  assert.equal(result.pendingRecoveryItemCount, 1);
  assert.equal(result.pendingRecoveryOrderCount, 1);
  assert.equal(result.missingCostItemCount, 0);
  assert.equal(result.dailyCOGS['2026-03-10'].pendingRecoveryItems, 1);
  assert.equal(result.dailyCOGS['2026-03-10'].costCoverageRatio, 1);
});
