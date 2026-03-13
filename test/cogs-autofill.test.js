const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const actualImwebAttribution = require('../server/domain/imwebAttribution');
const actualTime = require('../server/domain/time');

function createPrivateKeyPem() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function createTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adpilot-cogs-autofill-'));
}

async function withMockedService(overrides, run) {
  const servicePath = require.resolve('../server/services/cogsAutofillService');
  const dependencyEntries = [
    [require.resolve('../server/config'), overrides.config],
    [require.resolve('../server/runtime/paths'), overrides.runtimePaths],
    [require.resolve('../server/modules/cogsClient'), overrides.cogsClient],
    [require.resolve('../server/modules/imwebClient'), overrides.imwebClient],
    [require.resolve('../server/domain/imwebAttribution'), actualImwebAttribution],
    [require.resolve('../server/domain/time'), actualTime],
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

  const originalService = require.cache[servicePath] || null;
  delete require.cache[servicePath];

  try {
    const service = require(servicePath);
    return await run(service);
  } finally {
    delete require.cache[servicePath];
    if (originalService) {
      require.cache[servicePath] = originalService;
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

function createOrder(overrides = {}) {
  return {
    orderNo: '20260313225187',
    wtime: '2026-03-13T02:36:00.000Z',
    ordererName: '홍신희',
    sections: [
      {
        sectionItems: [
          { productInfo: { prodName: '실크 모노그램 방도' } },
          { productInfo: { prodName: '에르 스카프' } },
        ],
      },
    ],
    ...overrides,
  };
}

function createConfig(privateKey) {
  return {
    cogs: {
      spreadsheetId: 'spreadsheet-123',
      autofill: {
        googleClientEmail: 'svc-account@example.iam.gserviceaccount.com',
        googlePrivateKey: privateKey,
        webhookToken: 'webhook-secret',
      },
    },
  };
}

test('syncOrderToCogsSheet appends multi-item rows to the correct month tab without overwriting existing data', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();
  const appendRequests = [];
  const originalFetch = global.fetch;

  global.fetch = async (url, options = {}) => {
    const textUrl = String(url);
    if (textUrl === 'https://oauth2.googleapis.com/token') {
      return {
        ok: true,
        json: async () => ({ access_token: 'google-access-token', expires_in: 3600 }),
      };
    }

    appendRequests.push({
      url: textUrl,
      options,
      body: JSON.parse(options.body),
    });

    return {
      ok: true,
      json: async () => ({ updates: { updatedRows: 2 } }),
    };
  };

  try {
    await withMockedService({
      config: createConfig(privateKey),
      runtimePaths: { dataDir },
      cogsClient: {
        fetchWorkbookMetadata: async () => ({
          workbookSheets: [{ name: '3월 주문', path: 'xl/worksheets/sheet2.xml' }],
        }),
        buildSheetTargets: () => [
          { label: '3월', sheetName: '3월 주문', gid: null, discovered: false },
        ],
        fetchSheetCSV: async () => [
          ['번호', '날짜', '이름', '주문번호'],
          [],
          ['101', '2026-03-12', '기존 고객', '20260312001'],
        ],
      },
      imwebClient: {
        getOrder: async () => {
          throw new Error('getOrder should not be called for direct syncOrderToCogsSheet test');
        },
      },
    }, async service => {
      const result = await service.syncOrderToCogsSheet(createOrder());

      assert.equal(result.status, 'appended');
      assert.equal(result.orderDate, '2026-03-13');
      assert.equal(result.customerName, '홍신희');
      assert.deepEqual(result.productNames, ['실크 모노그램 방도', '에르 스카프']);
      assert.equal(result.sheetName, '3월 주문');
      assert.equal(result.rowCount, 2);
      assert.equal(result.sequenceNo, 102);
      assert.equal(appendRequests.length, 1);

      const appendRequest = appendRequests[0];
      assert.match(appendRequest.url, /insertDataOption=INSERT_ROWS/);
      assert.match(appendRequest.url, /'3%EC%9B%94%20%EC%A3%BC%EB%AC%B8'!A%3AL:append/);

      const [firstRow, secondRow] = appendRequest.body.values;
      assert.deepEqual(firstRow.slice(0, 7), ['102', '2026-03-13', '홍신희', '20260313225187', '', '', '실크 모노그램 방도']);
      assert.deepEqual(secondRow.slice(0, 7), ['', '', '', '', '', '', '에르 스카프']);
      assert.equal(firstRow[9], 'FALSE');
      assert.equal(firstRow[10], 'FALSE');
      assert.equal(secondRow[9], 'FALSE');
      assert.equal(secondRow[10], 'FALSE');

      const statePath = path.join(dataDir, 'cogs_autofill_state.json');
      assert.equal(fs.existsSync(statePath), true);
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.ok(state.importedOrders['20260313225187']);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('syncOrderToCogsSheet skips appending when the order number already exists in the target sheet', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();
  const originalFetch = global.fetch;
  let appendCount = 0;

  global.fetch = async (url) => {
    const textUrl = String(url);
    if (textUrl === 'https://oauth2.googleapis.com/token') {
      return {
        ok: true,
        json: async () => ({ access_token: 'google-access-token', expires_in: 3600 }),
      };
    }

    appendCount += 1;
    return {
      ok: true,
      json: async () => ({ updates: { updatedRows: 1 } }),
    };
  };

  try {
    await withMockedService({
      config: createConfig(privateKey),
      runtimePaths: { dataDir },
      cogsClient: {
        fetchWorkbookMetadata: async () => ({
          workbookSheets: [{ name: '3월 주문', path: 'xl/worksheets/sheet2.xml' }],
        }),
        buildSheetTargets: () => [
          { label: '3월', sheetName: '3월 주문', gid: null, discovered: false },
        ],
        fetchSheetCSV: async () => [
          ['번호', '날짜', '이름', '주문번호'],
          [],
          ['101', '2026-03-13', '홍신희', '20260313225187'],
        ],
      },
      imwebClient: {
        getOrder: async () => {
          throw new Error('getOrder should not be called for duplicate sheet test');
        },
      },
    }, async service => {
      const result = await service.syncOrderToCogsSheet(createOrder());
      assert.equal(result.status, 'duplicate');
      assert.equal(result.reason, 'order already exists in sheet');
      assert.equal(result.orderDate, '2026-03-13');
      assert.equal(result.customerName, '홍신희');
      assert.deepEqual(result.productNames, ['실크 모노그램 방도', '에르 스카프']);
      assert.equal(appendCount, 0);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleWebhookPayload processes deposit-complete and product-preparation order events and ignores unsupported events', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();
  const originalFetch = global.fetch;
  let getOrderCalls = 0;
  let appendCount = 0;

  global.fetch = async (url) => {
    const textUrl = String(url);
    if (textUrl === 'https://oauth2.googleapis.com/token') {
      return {
        ok: true,
        json: async () => ({ access_token: 'google-access-token', expires_in: 3600 }),
      };
    }

    appendCount += 1;
    return {
      ok: true,
      json: async () => ({ updates: { updatedRows: 1 } }),
    };
  };

  try {
    await withMockedService({
      config: createConfig(privateKey),
      runtimePaths: { dataDir },
      cogsClient: {
        fetchWorkbookMetadata: async () => ({
          workbookSheets: [{ name: '3월 주문', path: 'xl/worksheets/sheet2.xml' }],
        }),
        buildSheetTargets: () => [
          { label: '3월', sheetName: '3월 주문', gid: null, discovered: false },
        ],
        fetchSheetCSV: async () => [
          ['번호', '날짜', '이름', '주문번호'],
          [],
        ],
      },
      imwebClient: {
        getOrder: async () => {
          getOrderCalls += 1;
          return createOrder();
        },
      },
    }, async service => {
      const depositComplete = await service.handleWebhookPayload({ eventName: 'ORDER_DEPOSIT_COMPLETE', orderNo: '20260313225187' });
      assert.equal(depositComplete.status, 'appended');
      assert.deepEqual(depositComplete.productNames, ['실크 모노그램 방도', '에르 스카프']);
      assert.equal(getOrderCalls, 1);

      const appended = await service.handleWebhookPayload({
        eventName: 'ORDER_PRODUCT_PREPARATION',
        data: { order: createOrder() },
      });

      assert.equal(appended.status, 'duplicate');
      assert.equal(getOrderCalls, 1);
      assert.equal(appendCount, 1);

      const ignored = await service.handleWebhookPayload({ eventName: 'ORDER_CANCEL_REQUEST', orderNo: '20260313225187' });
      assert.equal(ignored.status, 'ignored');
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleWebhookPayload accepts eventType payloads from Imweb order webhooks', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();
  const originalFetch = global.fetch;
  let getOrderCalls = 0;
  let appendCount = 0;

  global.fetch = async (url) => {
    const textUrl = String(url);
    if (textUrl === 'https://oauth2.googleapis.com/token') {
      return {
        ok: true,
        json: async () => ({ access_token: 'google-access-token', expires_in: 3600 }),
      };
    }

    appendCount += 1;
    return {
      ok: true,
      json: async () => ({ updates: { updatedRows: 1 } }),
    };
  };

  try {
    await withMockedService({
      config: createConfig(privateKey),
      runtimePaths: { dataDir },
      cogsClient: {
        fetchWorkbookMetadata: async () => ({
          workbookSheets: [{ name: '3월 주문', path: 'xl/worksheets/sheet2.xml' }],
        }),
        buildSheetTargets: () => [
          { label: '3월', sheetName: '3월 주문', gid: null, discovered: false },
        ],
        fetchSheetCSV: async () => [
          ['번호', '날짜', '이름', '주문번호'],
          [],
        ],
      },
      imwebClient: {
        getOrder: async () => {
          getOrderCalls += 1;
          return createOrder({ orderNo: '202603138754779', ordererName: '박유림' });
        },
      },
    }, async service => {
      const appended = await service.handleWebhookPayload({
        eventType: 'ORDER_DEPOSIT_COMPLETE',
        orderNo: '202603138754779',
      });

      assert.equal(appended.status, 'appended');
      assert.equal(appended.orderNo, '202603138754779');
      assert.equal(appended.customerName, '박유림');
      assert.equal(getOrderCalls, 1);
      assert.equal(appendCount, 1);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('syncRecentOrdersToCogs appends only recent paid orders and skips stale or duplicate candidates', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();
  const originalFetch = global.fetch;
  const now = Date.now();
  let appendCount = 0;

  global.fetch = async (url, options = {}) => {
    const textUrl = String(url);
    if (textUrl === 'https://oauth2.googleapis.com/token') {
      return {
        ok: true,
        json: async () => ({ access_token: 'google-access-token', expires_in: 3600 }),
      };
    }

    appendCount += 1;
    return {
      ok: true,
      json: async () => ({ updates: { updatedRows: 1 }, echoedBody: JSON.parse(options.body) }),
    };
  };

  try {
    await withMockedService({
      config: createConfig(privateKey),
      runtimePaths: { dataDir },
      cogsClient: {
        fetchWorkbookMetadata: async () => ({
          workbookSheets: [{ name: '3월 주문', path: 'xl/worksheets/sheet2.xml' }],
        }),
        buildSheetTargets: () => [
          { label: '3월', sheetName: '3월 주문', gid: null, discovered: false },
        ],
        fetchSheetCSV: async () => [
          ['번호', '날짜', '이름', '주문번호'],
          [],
          ['101', '2026-03-13', '기존 고객', '20260313002'],
        ],
      },
      imwebClient: {
        getOrder: async () => {
          throw new Error('getOrder should not be called for recent-order reconciliation test');
        },
      },
    }, async service => {
      const recentPaid = createOrder({
        orderNo: '20260313001',
        ordererName: '최근 결제',
        wtime: new Date(now - (2 * 60 * 60 * 1000)).toISOString(),
        totalPaymentPrice: 111000,
        payments: [
          {
            paidPrice: 111000,
            paymentStatus: 'PAID',
            paymentCompleteTime: new Date(now - (90 * 60 * 1000)).toISOString(),
          },
        ],
        sections: [{ sectionItems: [{ productInfo: { prodName: '스카프 A' } }] }],
      });
      const recentDuplicate = createOrder({
        orderNo: '20260313002',
        ordererName: '중복 결제',
        wtime: new Date(now - (3 * 60 * 60 * 1000)).toISOString(),
        totalPaymentPrice: 99000,
        payments: [
          {
            paidPrice: 99000,
            paymentStatus: 'PAID',
            paymentCompleteTime: new Date(now - (2 * 60 * 60 * 1000)).toISOString(),
          },
        ],
        sections: [{ sectionItems: [{ productInfo: { prodName: '스카프 B' } }] }],
      });
      const stalePaid = createOrder({
        orderNo: '20260301001',
        ordererName: '오래된 결제',
        wtime: new Date(now - (10 * 24 * 60 * 60 * 1000)).toISOString(),
        totalPaymentPrice: 88000,
        payments: [
          {
            paidPrice: 88000,
            paymentStatus: 'PAID',
            paymentCompleteTime: new Date(now - (9 * 24 * 60 * 60 * 1000)).toISOString(),
          },
        ],
        sections: [{ sectionItems: [{ productInfo: { prodName: '스카프 C' } }] }],
      });
      const unpaid = createOrder({
        orderNo: '20260313003',
        ordererName: '미결제',
        wtime: new Date(now - (60 * 60 * 1000)).toISOString(),
        totalPaymentPrice: 0,
        totalRefundedPrice: 0,
        payments: [],
        sections: [{ sectionItems: [{ productInfo: { prodName: '스카프 D' } }] }],
      });

      const result = await service.syncRecentOrdersToCogs(
        [stalePaid, recentDuplicate, unpaid, recentPaid],
        { lookbackDays: 3 }
      );

      assert.equal(result.status, 'ok');
      assert.equal(result.lookbackDays, 3);
      assert.equal(result.eligibleOrders, 2);
      assert.equal(result.appended.length, 1);
      assert.equal(result.duplicates.length, 1);
      assert.equal(result.skipped.length, 0);
      assert.equal(result.appended[0].orderNo, '20260313001');
      assert.equal(result.duplicates[0].orderNo, '20260313002');
      assert.equal(appendCount, 1);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('resolveTargetSheet falls back to the conventional month tab name when workbook discovery is unavailable', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();

  await withMockedService({
    config: createConfig(privateKey),
    runtimePaths: { dataDir },
    cogsClient: {
      fetchWorkbookMetadata: async () => {
        throw new Error('workbook unavailable');
      },
      buildSheetTargets: () => [],
      fetchSheetCSV: async () => [],
    },
    imwebClient: {
      getOrder: async () => createOrder(),
    },
  }, async service => {
    const target = await service.resolveTargetSheet('2026-04-02');
    assert.deepEqual(target, {
      label: '4월',
      gid: null,
      sheetName: '4월 주문',
      discovered: false,
    });
  });
});
