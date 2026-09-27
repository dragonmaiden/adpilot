const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSheetDate,
  buildSheetTargets,
  parseOrderItems,
  observeSheetColumnTotals,
  aggregateCOGSItems,
} = require('../server/modules/cogsClient');
const { buildDataCoverage, buildProfitWaterfall } = require('../server/transforms/charts');

async function withMockedCogsClient(overrides, run) {
  const clientPath = require.resolve('../server/modules/cogsClient');
  const dependencyEntries = [
    [require.resolve('../server/config'), overrides.config],
    [require.resolve('../server/services/googleSheetsAuthService'), overrides.googleSheetsAuthService],
  ];

  const originalEntries = new Map();
  for (const [dependencyPath, dependencyExports] of dependencyEntries) {
    originalEntries.set(dependencyPath, require.cache[dependencyPath] || null);
    require.cache[dependencyPath] = {
      id: dependencyPath,
      filename: dependencyPath,
      loaded: true,
      exports: dependencyExports,
    };
  }

  const originalClient = require.cache[clientPath] || null;
  delete require.cache[clientPath];

  try {
    const client = require(clientPath);
    return await run(client);
  } finally {
    delete require.cache[clientPath];
    if (originalClient) {
      require.cache[clientPath] = originalClient;
    }

    for (const [dependencyPath] of dependencyEntries) {
      const originalEntry = originalEntries.get(dependencyPath);
      if (originalEntry) {
        require.cache[dependencyPath] = originalEntry;
      } else {
        delete require.cache[dependencyPath];
      }
    }
  }
}

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
  assert.equal(normalizeSheetDate('2026-02-30'), '');
  assert.equal(normalizeSheetDate('not a date'), '');
});

test('malformed cost text is never partly included in profit', () => {
  const items = parseOrderItems([[], [],
    ['1', '2026-09-24', 'Customer', 'order-1', '', '', 'Bag', '50000abc', '4000'],
  ], { sheetLabel: '9월' });
  const result = aggregateCOGSItems(items);
  assert.equal(items[0].cost, 0);
  assert.ok(items[0].warnings.includes('invalid_cost'));
  assert.equal(result.validation.invalidValueRows, 1);
});

test('a pending-recovery day without monetary columns is not a false Sheet mismatch', async () => {
  await withMockedCogsClient({
    config: { cogs: { spreadsheetId: 'spreadsheet-123', sheetGids: { Sep: '9' } } },
    googleSheetsAuthService: {
      isConfigured: () => true,
      fetchSpreadsheetMetadata: async () => ({ sheets: [{ properties: { sheetId: '9', title: 'Sep' } }] }),
      fetchSheetValues: async () => [[], [],
        ['1', '2026-09-24', 'Customer', 'order-1', '', '', 'Bag', '', '', '', '', '회수 예정'],
      ],
    },
  }, async client => {
    const result = await client.fetchAllCOGS();
    assert.equal(result.dailyCOGS['2026-09-24'].cost, 0);
    assert.equal(result.validation.sourceColumnMismatchDays, 0);
  });
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
      { label: '4월', sheetName: '4월 주문', discovered: false },
    ]
  );
});

test('fetchSheetCSV retries with the gid-resolved title when a shorthand month label fails', async () => {
  const fetchCalls = [];
  let metadataRequests = 0;

  await withMockedCogsClient({
    config: {
      cogs: {
        spreadsheetId: 'spreadsheet-123',
        sheetGids: {},
      },
    },
    googleSheetsAuthService: {
      isConfigured: () => true,
      fetchSpreadsheetMetadata: async () => {
        metadataRequests += 1;
        return {
          sheets: [
            {
              properties: {
                sheetId: '456791124',
                title: '3월 주문',
              },
            },
          ],
        };
      },
      fetchSheetValues: async (_spreadsheetId, sheetName) => {
        fetchCalls.push(sheetName);
        if (sheetName === '3월') {
          throw new Error("Google Sheets values request failed: Unable to parse range: '3월'!A:Q");
        }
        return [['번호'], ['101']];
      },
    },
  }, async client => {
    const rows = await client.fetchSheetCSV({
      gid: '456791124',
      sheetName: '3월',
    });

    assert.deepEqual(rows, [['번호'], ['101']]);
    assert.deepEqual(fetchCalls, ['3월', '3월 주문']);
    assert.equal(metadataRequests, 1);
  });
});

test('fetchAllCOGS rejects a partial workbook when one monthly tab fails', async () => {
  await withMockedCogsClient({
    config: {
      cogs: { spreadsheetId: 'spreadsheet-123', sheetGids: { Feb: '1', March: '2' } },
    },
    googleSheetsAuthService: {
      isConfigured: () => true,
      fetchSpreadsheetMetadata: async () => ({ sheets: [
        { properties: { sheetId: '1', title: 'Feb' } },
        { properties: { sheetId: '2', title: 'March' } },
      ] }),
      fetchSheetValues: async (_spreadsheetId, sheetName) => {
        if (sheetName === 'March') throw new Error('temporary Sheets outage');
        return [[], [], ['1', '2026-02-10', 'Customer', 'order-1', '', '', 'Item', '50000', '4000']];
      },
    },
  }, async client => {
    await assert.rejects(client.fetchAllCOGS(), /COGS sheet fetch incomplete: March/);
  });
});

test('fetchAllCOGS carries the raw Sheet column control alongside parsed net costs', async () => {
  await withMockedCogsClient({
    config: { cogs: { spreadsheetId: 'spreadsheet-123', sheetGids: { Sep: '9' } } },
    googleSheetsAuthService: {
      isConfigured: () => true,
      fetchSpreadsheetMetadata: async () => ({ sheets: [{ properties: { sheetId: '9', title: 'Sep' } }] }),
      fetchSheetValues: async (_id, _name, range) => {
        assert.equal(range, 'A:S');
        return [[], [],
          ['1', '2026-09-24', 'Customer', 'order-1', '', '', 'Bag', '50000', '4000'],
          ['', '', '', '', '', '', 'Accessory', '10000', '0'],
        ];
      },
    },
  }, async client => {
    const result = await client.fetchAllCOGS();
    assert.equal(result.sourceTotalsOrigin, 'raw_sheet_columns');
    assert.deepEqual(result.sourceTotalsByDate['2026-09-24'], { cogs: 60000, shipping: 4000 });
    assert.equal(result.dailyCOGS['2026-09-24'].purchaseCost, 60000);
    assert.equal(result.validation.sourceColumnMismatchDays, 0);
  });
});

test('blank cost or shipping stays incomplete, while an explicit zero is a known value', () => {
  const rows = [[], [],
    ['1', '2026-09-20', 'A', 'order-1', '', '', 'Item', '50000', ''],
    ['2', '2026-09-20', 'B', 'order-2', '', '', 'Item', '0', '0'],
    ['3', '2026-09-20', 'C', 'order-3', '', '', 'Item', '', '4000'],
    ['4', '2026-09-20', 'D', 'order-4', '', '', 'Item', 'TBD', '4000'],
  ];
  const items = parseOrderItems(rows, { sheetLabel: '9월' });
  const result = aggregateCOGSItems(items);
  assert.equal(result.missingCostItemCount, 3);
  assert.equal(result.costedItemCount, 1);
  assert.equal(result.incompletePurchaseCount, 3);
  assert.deepEqual(items.map(item => item.warnings), [
    ['missing_shipping'], [], ['missing_cost'], ['missing_cost', 'invalid_cost'],
  ]);
});

test('COGS parsing preserves a repeated-order name but flags a genuinely missing name or order ID', () => {
  const items = parseOrderItems([[], [],
    ['1', '2026-09-24', 'Customer A', '202609240000001', '', '', 'First', '50000', '4000'],
    ['1', '2026-09-24', '', '202609240000001', '', '', 'Second', '30000', '0'],
    ['2', '2026-09-24', '', '202609240000002', '', '', 'Third', '', ''],
    ['3', '2026-09-24', 'Customer C', '', '', '', 'Fourth', '', ''],
  ], { sheetLabel: '9월' });
  assert.equal(items[1].name, 'Customer A');
  assert.deepEqual(items[1].warnings, []);
  assert.ok(items[2].warnings.includes('missing_customer_name'));
  assert.ok(items[3].warnings.includes('missing_order_number'));
  assert.equal(items[3].orderNumber, '', 'a Sheet sequence is not an Imweb order ID');
  assert.equal(items[3].orderKey, '9월:row:6');
});

test('a new order ID without a sequence never inherits the previous order cost', () => {
  const items = parseOrderItems([[], [],
    ['1', '2026-09-24', 'First', 'order-1', '', '', 'Bag', '50000', '4000'],
    ['', '2026-09-25', 'Second', 'order-2', '', '', 'Hat', '30000', '0'],
    ['', '', '', '', '', '', 'Extra hat', '10000', '0'],
  ], { sheetLabel: '9월' });
  const result = aggregateCOGSItems(items);
  assert.deepEqual(items.map(item => item.orderNumber), ['order-1', 'order-2', 'order-2']);
  assert.equal(result.dailyCOGS['2026-09-24'].purchaseCost, 50000);
  assert.equal(result.dailyCOGS['2026-09-25'].purchaseCost, 40000);
});

test('an undated new order is isolated and reported instead of being charged to the prior day', () => {
  const items = parseOrderItems([[], [],
    ['1', '2026-09-24', 'First', 'order-1', '', '', 'Bag', '50000', '4000'],
    ['', '', 'Second', 'order-2', '', '', 'Hat', '30000', '0'],
  ], { sheetLabel: '9월' });
  const result = aggregateCOGSItems(items);
  assert.equal(items[1].orderNumber, 'order-2');
  assert.equal(items[1].date, null);
  assert.ok(items[1].warnings.includes('missing_order_date'));
  assert.equal(result.validation.missingOrderDateRows, 1);
  assert.equal(result.dailyCOGS['2026-09-24'].purchaseCost, 50000);
});

test('raw Sheet column totals are read separately from parsed order items', () => {
  const rows = [[], [],
    ['1', '2026-09-24', 'First', 'order-1', '', '', 'Bag', '50000', '4000'],
    ['', '', '', '', '', '', 'Extra', '10000', '0'],
    ['', '', 'Second', 'order-2', '', '', 'Hat', '30000', '0'],
  ];
  assert.deepEqual(observeSheetColumnTotals(rows), {
    byDate: { '2026-09-24': { cogs: 60000, shipping: 4000 } },
    unassignedFinancialRows: 1,
  });
});

test('invalid monetary text on a refund row cannot disappear as a zero adjustment', () => {
  const items = parseOrderItems([[], [],
    ['1', '2026-09-24', 'Customer', 'order-1', '', '', '', 'TBD', '', '', '', '환불'],
  ], { sheetLabel: '9월' });
  const result = aggregateCOGSItems(items);
  assert.equal(items.length, 1);
  assert.ok(items[0].warnings.includes('invalid_cost'));
  assert.equal(result.validation.invalidValueRows, 1);
});

test('refund-marked amounts stay unverified until COGS recovery and shipping reimbursement are separately confirmed', () => {
  const headers = Array(19).fill('');
  headers[17] = 'COGS recovered';
  headers[18] = 'Shipping reimbursed';
  const rows = [[], headers,
    ['1', '2026-09-24', 'Customer', 'order-1', '', '', 'Bag', '50000', '4000', '', '', '환불'],
    ['2', '2026-09-24', 'Customer', 'order-2', '', '', 'Bag', '30000', '3000', '', '', '환불', '', '', '', '', '', 'TRUE', 'FALSE'],
    ['3', '2026-09-24', 'Customer', 'order-3', '', '', 'Bag', '20000', '2000', '', '', '환불', '', '', '', '', '', 'TRUE', 'TRUE'],
  ];
  const items = parseOrderItems(rows, { sheetLabel: '9월' });
  assert.deepEqual(items[0].warnings.filter(warning => warning.endsWith('_unverified')),
    ['cogs_recovery_unverified', 'shipping_reimbursement_unverified']);
  assert.deepEqual(items[1].warnings.filter(warning => warning.endsWith('_unverified')),
    ['shipping_reimbursement_unverified']);
  assert.deepEqual(items[2].warnings, []);
  assert.equal(aggregateCOGSItems(items).validation.unverifiedRecoveryRows, 2);
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
  const waterfall = buildProfitWaterfall(dailyMerged, dailyCOGS, 0.06);

  assert.equal(coverage.daysWithCOGS, 2);
  assert.equal(coverage.daysWithPartialCOGS, 1);
  assert.equal(coverage.daysWithPendingRecovery, 1);
  assert.equal(coverage.coverageRatio, 0.833);
  assert.equal(waterfall[0].hasCOGS, true);
  assert.equal(waterfall[0].hasPartialCOGS, false);
  assert.equal(waterfall[0].purchaseCogs, 100000);
  assert.equal(waterfall[0].refundCogs, 0);
  assert.equal(waterfall[0].purchaseShipping, 10000);
  assert.equal(waterfall[0].refundShipping, 0);
  assert.equal(waterfall[0].cogsSheetTotal, null);
  assert.equal(waterfall[0].sheetTotalsObserved, false);
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
