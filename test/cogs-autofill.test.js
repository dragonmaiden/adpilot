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
    ordererCall: '01012341234',
    totalPaymentPrice: 111000,
    totalRefundedPrice: 0,
    sections: [
      {
        delivery: {
          receiverName: '홍신희',
          receiverCall: '01012341234',
          zipcode: '06236',
          addr1: '서울 강남구 테헤란로 123',
          addr2: '5층',
          memo: '문 앞에 놓아주세요',
        },
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
  const batchUpdateRequests = [];
  const originalFetch = global.fetch;

  global.fetch = async (url, options = {}) => {
    const textUrl = String(url);
    if (textUrl === 'https://oauth2.googleapis.com/token') {
      return {
        ok: true,
        json: async () => ({ access_token: 'google-access-token', expires_in: 3600 }),
      };
    }

    if (textUrl.includes('/values:batchUpdate')) {
      batchUpdateRequests.push({
        url: textUrl,
        options,
        body: JSON.parse(options.body),
      });
      return {
        ok: true,
        json: async () => ({ totalUpdatedCells: 5 }),
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
          ['번호', '날짜', '이름', '주문번호', '', '', '', '', '', '', '', '', '주문자 연락처'],
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
      assert.equal(result.netRevenue, 111000);
      assert.equal(result.approvedAmount, 111000);
      assert.equal(appendRequests.length, 1);
      assert.equal(batchUpdateRequests.length, 1);

      const appendRequest = appendRequests[0];
      assert.match(appendRequest.url, /insertDataOption=INSERT_ROWS/);
      assert.match(appendRequest.url, /'3%EC%9B%94%20%EC%A3%BC%EB%AC%B8'!A%3AQ:append/);

      const headerUpdate = batchUpdateRequests[0];
      const updatedRanges = headerUpdate.body.data.map(entry => entry.range);
      assert.deepEqual(updatedRanges, ["'3월 주문'!M1"]);

      const [firstRow, secondRow] = appendRequest.body.values;
      assert.deepEqual(firstRow.slice(0, 7), ['102', '2026-03-13', '홍신희', '20260313225187', '', '', '실크 모노그램 방도']);
      assert.deepEqual(secondRow.slice(0, 7), ['', '', '', '', '', '', '에르 스카프']);
      assert.equal(firstRow[11], '');
      assert.equal(
        firstRow[12],
        'receiver: 홍신희 | phone: 01012341234 | address: 06236 서울 강남구 테헤란로 123 5층 | delivery note: 문 앞에 놓아주세요'
      );
      assert.deepEqual(secondRow.slice(12, 17), ['', '', '', '', '']);
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

test('buildNewOrderNotification formats the pre-payment order alert', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();

  await withMockedService({
    config: createConfig(privateKey),
    runtimePaths: { dataDir },
    cogsClient: {
      fetchWorkbookMetadata: async () => ({ workbookSheets: [] }),
      buildSheetTargets: () => [],
      fetchSheetCSV: async () => [],
    },
    imwebClient: {
      getOrder: async () => {
        throw new Error('not used');
      },
    },
  }, async service => {
    const message = service.buildNewOrderNotification({
      orderNo: '202603145648900',
      orderDate: '2026-03-13',
      customerName: '홍신희',
      orderValue: 111000,
      paymentLabel: 'Awaiting payment check',
      paymentMethod: 'BANK_TRANSFER',
      paymentState: 'awaiting_check',
      productNames: ['실크 모노그램 방도'],
    });

    assert.match(message, /🛎️ <b>New Imweb Order<\/b>/);
    assert.match(message, /Order: 202603145648900/);
    assert.match(message, /Date: 2026-03-13/);
    assert.match(message, /Customer: 홍신희/);
    assert.match(message, /Revenue: ₩111,000 · 🐟 small fish ₩₩/);
    assert.match(message, /Payment: Awaiting payment check · BANK_TRANSFER/);
    assert.match(message, /Checklist:\n☐ Check payment in Imweb/);
    assert.match(message, /Products:\n• 실크 모노그램 방도/);
  });
});

test('buildNewOrderNotification formats the completed checklist state after payment recognition', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();

  await withMockedService({
    config: createConfig(privateKey),
    runtimePaths: { dataDir },
    cogsClient: {
      fetchWorkbookMetadata: async () => ({ workbookSheets: [] }),
      buildSheetTargets: () => [],
      fetchSheetCSV: async () => [],
    },
    imwebClient: {
      getOrder: async () => {
        throw new Error('not used');
      },
    },
  }, async service => {
    const message = service.buildNewOrderNotification({
      orderNo: '202603145648900',
      orderDate: '2026-03-13',
      customerName: '홍신희',
      orderValue: 111000,
      paymentLabel: 'Paid confirmed',
      paymentMethod: 'CARD',
      paymentState: 'paid',
      notificationStage: 'payment_confirmed',
      sheetName: '3월 주문',
      productNames: ['실크 모노그램 방도'],
    });

    assert.match(message, /✅ <b>New Imweb Order<\/b>/);
    assert.match(message, /Payment: Paid confirmed · CARD/);
    assert.match(message, /Checklist:\n✅ Payment recognized in Imweb\n✅ COGS logged in 3월 주문/);
  });
});

test('buildAutofillNotification formats the paid-order COGS summary', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();

  await withMockedService({
    config: createConfig(privateKey),
    runtimePaths: { dataDir },
    cogsClient: {
      fetchWorkbookMetadata: async () => ({ workbookSheets: [] }),
      buildSheetTargets: () => [],
      fetchSheetCSV: async () => [],
    },
    imwebClient: {
      getOrder: async () => {
        throw new Error('not used');
      },
    },
  }, async service => {
    const message = service.buildAutofillNotification({
      orderNo: '202603145648900',
      orderDate: '2026-03-13',
      customerName: '홍신희',
      customerPhone: '01012341234',
      deliveryAddress: '서울 강남구 테헤란로 123 5층',
      deliveryNote: '문 앞에 놓아주세요',
      netRevenue: 97707,
      approvedAmount: 97707,
      sheetName: '3월 주문',
      rowCount: 1,
      productNames: ['실크 모노그램 방도'],
      productLines: ['실크 모노그램 방도', '에르 스카프 (od202601302d5ef0d5fc48b)'],
    });

    assert.match(message, /✅ <b>Paid Imweb Order Logged<\/b>/);
    assert.match(message, /Order: 202603145648900/);
    assert.match(message, /Date: 2026-03-13/);
    assert.match(message, /Customer: 홍신희/);
    assert.match(message, /Revenue: ₩97,707 · 🐟 small fish ₩₩/);
    assert.match(message, /Sheet: 3월 주문/);
    assert.match(message, /Rows appended: 1/);
    assert.match(message, /Products:\n• 실크 모노그램 방도/);
  });
});

test('buildAutofillPrivateNotification formats spoiler-wrapped customer fields and detailed products', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();

  await withMockedService({
    config: createConfig(privateKey),
    runtimePaths: { dataDir },
    cogsClient: {
      fetchWorkbookMetadata: async () => ({ workbookSheets: [] }),
      buildSheetTargets: () => [],
      fetchSheetCSV: async () => [],
    },
    imwebClient: {
      getOrder: async () => {
        throw new Error('not used');
      },
    },
  }, async service => {
    const message = service.buildAutofillPrivateNotification({
      customerName: '홍신희',
      customerPhone: '01012341234',
      deliveryAddress: '서울 강남구 테헤란로 123 5층',
      deliveryNote: '문 앞에 놓아주세요',
      productLines: ['실크 모노그램 방도', '에르 스카프 (od202601302d5ef0d5fc48b)'],
    });

    assert.match(message, /🔒 <b>Customer Details<\/b>/);
    assert.match(message, /<b>Name<\/b>\n<tg-spoiler>홍신희<\/tg-spoiler>/);
    assert.match(message, /<b>Phone number<\/b>\n<tg-spoiler>01012341234<\/tg-spoiler>/);
    assert.match(message, /<b>Address<\/b>\n<tg-spoiler>서울 강남구 테헤란로 123 5층<\/tg-spoiler>/);
    assert.match(message, /<b>Delivery note<\/b>\n<tg-spoiler>문 앞에 놓아주세요<\/tg-spoiler>/);
    assert.match(message, /• 실크 모노그램 방도/);
    assert.match(message, /• 에르 스카프 \(od202601302d5ef0d5fc48b\)/);
  });
});

test('syncOrderToCogsSheet skips appending when the order number already exists in the target sheet', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();
  const originalFetch = global.fetch;
  let appendCount = 0;
  let headerUpdateCount = 0;

  global.fetch = async (url) => {
    const textUrl = String(url);
    if (textUrl === 'https://oauth2.googleapis.com/token') {
      return {
        ok: true,
        json: async () => ({ access_token: 'google-access-token', expires_in: 3600 }),
      };
    }

    if (textUrl.includes('/values:batchUpdate')) {
      headerUpdateCount += 1;
      return {
        ok: true,
        json: async () => ({ totalUpdatedCells: 6 }),
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
      assert.equal(headerUpdateCount, 1);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('syncOrderToCogsSheet recovers when imported state exists but the sheet row is missing', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();
  const originalFetch = global.fetch;
  let appendCount = 0;
  let headerUpdateCount = 0;

  fs.writeFileSync(path.join(dataDir, 'cogs_autofill_state.json'), JSON.stringify({
    importedOrders: {
      '20260313225187': {
        orderNo: '20260313225187',
        importedAt: '2026-03-13T00:00:00.000Z',
        source: 'append',
        sheetName: '3월 주문',
        orderDate: '2026-03-13',
      },
    },
  }, null, 2));

  global.fetch = async (url) => {
    const textUrl = String(url);
    if (textUrl === 'https://oauth2.googleapis.com/token') {
      return {
        ok: true,
        json: async () => ({ access_token: 'google-access-token', expires_in: 3600 }),
      };
    }

    if (textUrl.includes('/values:batchUpdate')) {
      headerUpdateCount += 1;
      return {
        ok: true,
        json: async () => ({ totalUpdatedCells: 6 }),
      };
    }

    appendCount += 1;
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
          ['101', '2026-03-13', '다른 고객', '20260313009999'],
        ],
      },
      imwebClient: {
        getOrder: async () => {
          throw new Error('getOrder should not be called for stale imported-state recovery test');
        },
      },
    }, async service => {
      const result = await service.syncOrderToCogsSheet(createOrder());
      assert.equal(result.status, 'appended');
      assert.equal(result.orderNo, '20260313225187');
      assert.equal(appendCount, 1);
      assert.equal(headerUpdateCount, 1);

      const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'cogs_autofill_state.json'), 'utf8'));
      assert.equal(state.importedOrders['20260313225187'].source, 'recovered_append');
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('syncOrderToCogsSheet marks paid appends that were already alerted in Telegram', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();
  const originalFetch = global.fetch;
  let appendCount = 0;
  let headerUpdateCount = 0;

  fs.writeFileSync(path.join(dataDir, 'cogs_autofill_state.json'), JSON.stringify({
    importedOrders: {},
    notifiedOrders: {
      '20260313225187': {
        orderNo: '20260313225187',
        notifiedAt: '2026-03-13T00:00:00.000Z',
        source: 'webhook_new_order',
      },
    },
  }, null, 2));

  global.fetch = async (url) => {
    const textUrl = String(url);
    if (textUrl === 'https://oauth2.googleapis.com/token') {
      return {
        ok: true,
        json: async () => ({ access_token: 'google-access-token', expires_in: 3600 }),
      };
    }

    if (textUrl.includes('/values:batchUpdate')) {
      headerUpdateCount += 1;
      return {
        ok: true,
        json: async () => ({ totalUpdatedCells: 6 }),
      };
    }

    appendCount += 1;
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
        ],
      },
      imwebClient: {
        getOrder: async () => {
          throw new Error('getOrder should not be called for already-notified append test');
        },
      },
    }, async service => {
      const result = await service.syncOrderToCogsSheet(createOrder({
        totalPaymentPrice: 111000,
        payments: [
          {
            paidPrice: 111000,
            paymentStatus: 'PAYMENT_COMPLETE',
            paymentCompleteTime: '2026-03-13T03:10:00.000Z',
            method: 'CARD',
          },
        ],
      }));

      assert.equal(result.status, 'appended');
      assert.equal(result.alreadyNotified, true);
      assert.equal(appendCount, 1);
      assert.equal(headerUpdateCount, 1);
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
  let headerUpdateCount = 0;

  global.fetch = async (url) => {
    const textUrl = String(url);
    if (textUrl === 'https://oauth2.googleapis.com/token') {
      return {
        ok: true,
        json: async () => ({ access_token: 'google-access-token', expires_in: 3600 }),
      };
    }

    if (textUrl.includes('/values:batchUpdate')) {
      headerUpdateCount += 1;
      return {
        ok: true,
        json: async () => ({ totalUpdatedCells: 6 }),
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
        fetchSheetCSV: async () => {
          const headerRow = headerUpdateCount > 0
            ? ['번호', '날짜', '이름', '주문번호', '', '', '', '', '', '', '', '', 'delivery note']
            : ['번호', '날짜', '이름', '주문번호'];

          return appendCount > 0
            ? [
              headerRow,
              [],
              ['101', '2026-03-13', '홍신희', '20260313225187'],
            ]
            : [
              headerRow,
              [],
            ];
        },
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
      assert.equal(depositComplete.notificationKind, 'cogs_autofill');
      assert.deepEqual(depositComplete.productNames, ['실크 모노그램 방도', '에르 스카프']);
      assert.equal(getOrderCalls, 1);

      const appended = await service.handleWebhookPayload({
        eventName: 'ORDER_PRODUCT_PREPARATION',
        data: { order: createOrder() },
      });

      assert.equal(appended.status, 'duplicate');
      assert.equal(appended.notificationKind, null);
      assert.equal(getOrderCalls, 1);
      assert.equal(appendCount, 1);
      assert.equal(headerUpdateCount, 1);

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
  let headerUpdateCount = 0;

  global.fetch = async (url) => {
    const textUrl = String(url);
    if (textUrl === 'https://oauth2.googleapis.com/token') {
      return {
        ok: true,
        json: async () => ({ access_token: 'google-access-token', expires_in: 3600 }),
      };
    }

    if (textUrl.includes('/values:batchUpdate')) {
      headerUpdateCount += 1;
      return {
        ok: true,
        json: async () => ({ totalUpdatedCells: 6 }),
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
      assert.equal(appended.notificationKind, 'cogs_autofill');
      assert.equal(appended.orderNo, '202603138754779');
      assert.equal(appended.customerName, '박유림');
      assert.equal(getOrderCalls, 1);
      assert.equal(appendCount, 1);
      assert.equal(headerUpdateCount, 1);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleWebhookPayload sends a new-order notification before payment events and suppresses repeats', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();

  await withMockedService({
    config: createConfig(privateKey),
    runtimePaths: { dataDir },
    cogsClient: {
      fetchWorkbookMetadata: async () => {
        throw new Error('sheet lookup should not run for new-order notifications');
      },
      buildSheetTargets: () => [],
      fetchSheetCSV: async () => [],
    },
    imwebClient: {
      getOrder: async () => createOrder({
        orderStatus: 'OPEN',
        totalPrice: 111000,
        totalPaymentPrice: 0,
        paymentMethod: 'BANK_TRANSFER',
        payments: [],
      }),
    },
  }, async service => {
    const first = await service.handleWebhookPayload({
      eventName: 'ORDER_CREATE',
      orderNo: '20260313225187',
    });

    assert.equal(first.status, 'notified');
    assert.equal(first.notificationKind, 'new_order');
    assert.equal(first.paymentState, 'check_now');
    assert.equal(first.paymentLabel, 'Check payment now');

    const repeated = await service.handleWebhookPayload({
      eventName: 'ORDER_CREATE',
      orderNo: '20260313225187',
    });

    assert.equal(repeated.status, 'already_notified');
    assert.equal(repeated.notificationKind, null);
    assert.equal(repeated.reason, 'order notification already sent');
  });
});

test('handleWebhookPayload treats an unknown unpaid order event as the first-order alert', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();

  await withMockedService({
    config: createConfig(privateKey),
    runtimePaths: { dataDir },
    cogsClient: {
      fetchWorkbookMetadata: async () => {
        throw new Error('sheet lookup should not run for pre-payment alerts');
      },
      buildSheetTargets: () => [],
      fetchSheetCSV: async () => [],
    },
    imwebClient: {
      getOrder: async () => createOrder({
        orderStatus: 'OPEN',
        totalPrice: 111000,
        totalPaymentPrice: 0,
        payments: [],
      }),
    },
  }, async service => {
    const result = await service.handleWebhookPayload({
      eventName: 'ORDER_SOMETHING_NEW',
      orderNo: '20260313225187',
    });

    assert.equal(result.status, 'notified');
    assert.equal(result.notificationKind, 'new_order');
    assert.equal(result.paymentState, 'check_now');
  });
});

test('handleWebhookPayload suppresses the later paid-order ping when a new-order alert already went out', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();
  const originalFetch = global.fetch;
  let appendCount = 0;
  let headerUpdateCount = 0;
  let getOrderCalls = 0;

  global.fetch = async (url, options = {}) => {
    const textUrl = String(url);
    if (textUrl === 'https://oauth2.googleapis.com/token') {
      return {
        ok: true,
        json: async () => ({ access_token: 'google-access-token', expires_in: 3600 }),
      };
    }

    if (textUrl.includes('/values:batchUpdate')) {
      headerUpdateCount += 1;
      return {
        ok: true,
        json: async () => ({ totalUpdatedCells: 6, echoedBody: JSON.parse(options.body) }),
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
        ],
      },
      imwebClient: {
        getOrder: async () => {
          getOrderCalls += 1;
          if (getOrderCalls === 1) {
            return createOrder({
              totalPrice: 111000,
              totalPaymentPrice: 0,
              paymentMethod: 'BANK_TRANSFER',
              payments: [],
            });
          }

          return createOrder({
            totalPrice: 111000,
            totalPaymentPrice: 111000,
            paymentMethod: 'CARD',
            payments: [
              {
                paidPrice: 111000,
                paymentStatus: 'PAYMENT_COMPLETE',
                paymentCompleteTime: '2026-03-13T03:10:00.000Z',
                method: 'CARD',
              },
            ],
          });
        },
      },
    }, async service => {
      const first = await service.handleWebhookPayload({
        eventName: 'ORDER_CREATE',
        orderNo: '20260313225187',
      });
      assert.equal(first.status, 'notified');
      assert.equal(first.notificationKind, 'new_order');

      const paid = await service.handleWebhookPayload({
        eventName: 'ORDER_DEPOSIT_COMPLETE',
        orderNo: '20260313225187',
      });
      assert.equal(paid.status, 'appended');
      assert.equal(paid.notificationKind, null);
      assert.equal(paid.notificationSuppressed, true);
      assert.equal(appendCount, 1);
      assert.equal(headerUpdateCount, 1);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('collectRecentNewOrderNotifications backfills recent unpaid orders that were missed or left delivery-pending', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();
  const now = Date.now();

  fs.writeFileSync(path.join(dataDir, 'cogs_autofill_state.json'), JSON.stringify({
    importedOrders: {},
    notifiedOrders: {
      '20260313002': {
        orderNo: '20260313002',
        notifiedAt: new Date(now - (8 * 60 * 1000)).toISOString(),
        source: 'webhook_new_order',
        notificationStage: 'delivery_pending',
      },
      '20260313003': {
        orderNo: '20260313003',
        notifiedAt: new Date(now - (7 * 60 * 1000)).toISOString(),
        source: 'webhook_new_order',
        notificationStage: 'payment_pending',
        messageId: 4321,
      },
      '20260313004': {
        orderNo: '20260313004',
        notifiedAt: new Date(now - (6 * 60 * 1000)).toISOString(),
        source: 'cogs_autofill_fallback',
        notificationStage: 'payment_confirmed',
      },
    },
  }, null, 2));

  await withMockedService({
    config: createConfig(privateKey),
    runtimePaths: { dataDir },
    cogsClient: {
      fetchWorkbookMetadata: async () => ({ workbookSheets: [] }),
      buildSheetTargets: () => [],
      fetchSheetCSV: async () => [],
    },
    imwebClient: {
      getOrder: async () => {
        throw new Error('not used');
      },
    },
  }, async service => {
    const result = await service.collectRecentNewOrderNotifications([
      createOrder({
        orderNo: '20260313001',
        wtime: new Date(now - (4 * 60 * 1000)).toISOString(),
        orderStatus: 'OPEN',
        totalPrice: 111000,
        totalPaymentPrice: 0,
        payments: [],
      }),
      createOrder({
        orderNo: '20260313002',
        wtime: new Date(now - (5 * 60 * 1000)).toISOString(),
        orderStatus: 'OPEN',
        totalPrice: 111000,
        totalPaymentPrice: 0,
        payments: [],
      }),
      createOrder({
        orderNo: '20260313003',
        wtime: new Date(now - (6 * 60 * 1000)).toISOString(),
        orderStatus: 'OPEN',
        totalPrice: 111000,
        totalPaymentPrice: 0,
        payments: [],
      }),
      createOrder({
        orderNo: '20260313004',
        wtime: new Date(now - (7 * 60 * 1000)).toISOString(),
        orderStatus: 'OPEN',
        totalPrice: 111000,
        totalPaymentPrice: 0,
        payments: [],
      }),
      createOrder({
        orderNo: '20260313005',
        wtime: new Date(now - (3 * 60 * 60 * 1000)).toISOString(),
        orderStatus: 'OPEN',
        totalPrice: 111000,
        totalPaymentPrice: 0,
        payments: [],
      }),
      createOrder({
        orderNo: '20260313006',
        wtime: new Date(now - (2 * 60 * 1000)).toISOString(),
        orderStatus: 'OPEN',
        totalPrice: 111000,
        totalPaymentPrice: 111000,
        payments: [
          {
            paidPrice: 111000,
            paymentStatus: 'PAYMENT_COMPLETE',
            paymentCompleteTime: new Date(now - (90 * 1000)).toISOString(),
            method: 'CARD',
          },
        ],
      }),
    ], {
      sinceTime: new Date(now - (30 * 60 * 1000)),
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.eligibleOrders, 2);
    assert.deepEqual(result.pending.map(order => order.orderNo), ['20260313002', '20260313001']);
    assert.equal(result.pending[0].notificationSource, 'scan_backstop');
    assert.equal(result.pending[1].notificationKind, 'new_order');
  });
});

test('syncRecentOrdersToCogs appends only recent paid orders and skips stale or duplicate candidates', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();
  const originalFetch = global.fetch;
  const now = Date.now();
  let appendCount = 0;
  let headerUpdateCount = 0;

  global.fetch = async (url, options = {}) => {
    const textUrl = String(url);
    if (textUrl === 'https://oauth2.googleapis.com/token') {
      return {
        ok: true,
        json: async () => ({ access_token: 'google-access-token', expires_in: 3600 }),
      };
    }

    if (textUrl.includes('/values:batchUpdate')) {
      headerUpdateCount += 1;
      return {
        ok: true,
        json: async () => ({ totalUpdatedCells: 6, echoedBody: JSON.parse(options.body) }),
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
        orderStatus: 'OPEN',
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
        orderStatus: 'OPEN',
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
        orderStatus: 'OPEN',
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
      const refundedClosed = createOrder({
        orderNo: '20260313004',
        orderStatus: 'CLOSED',
        ordererName: '환불 완료',
        wtime: new Date(now - (2 * 60 * 60 * 1000)).toISOString(),
        totalPaymentPrice: 0,
        totalRefundedPrice: 111000,
        payments: [
          {
            paidPrice: 111000,
            paymentStatus: 'REFUND_COMPLETE',
            paymentCompleteTime: new Date(now - (30 * 60 * 1000)).toISOString(),
          },
        ],
        sections: [{ sectionItems: [{ productInfo: { prodName: '스카프 환불' } }] }],
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
        [stalePaid, recentDuplicate, unpaid, refundedClosed, recentPaid],
        { lookbackDays: 3 }
      );

      assert.equal(result.status, 'ok');
      assert.equal(result.lookbackDays, 3);
      assert.equal(result.eligibleOrders, 2);
      assert.equal(result.appended.length, 1);
      assert.equal(result.duplicates.length, 1);
      assert.equal(result.skipped.length, 0);
      assert.equal(result.errors.length, 0);
      assert.equal(result.appended[0].orderNo, '20260313001');
      assert.equal(result.duplicates[0].orderNo, '20260313002');
      assert.equal(appendCount, 1);
      assert.equal(headerUpdateCount, 1);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('syncRecentOrdersToCogs respects an explicit scan window start and skips older paid orders', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();
  const originalFetch = global.fetch;
  const now = Date.now();
  let appendCount = 0;
  let headerUpdateCount = 0;

  global.fetch = async (url, options = {}) => {
    const textUrl = String(url);
    if (textUrl === 'https://oauth2.googleapis.com/token') {
      return {
        ok: true,
        json: async () => ({ access_token: 'google-access-token', expires_in: 3600 }),
      };
    }

    if (textUrl.includes('/values:batchUpdate')) {
      headerUpdateCount += 1;
      return {
        ok: true,
        json: async () => ({ totalUpdatedCells: 6, echoedBody: JSON.parse(options.body) }),
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
        ],
      },
      imwebClient: {
        getOrder: async () => {
          throw new Error('getOrder should not be called for scan window test');
        },
      },
    }, async service => {
      const olderPaid = createOrder({
        orderNo: '20260313021',
        ordererName: '이전 스캔 주문',
        orderStatus: 'OPEN',
        wtime: new Date(now - (6 * 60 * 60 * 1000)).toISOString(),
        totalPaymentPrice: 111000,
        payments: [
          {
            paidPrice: 111000,
            paymentStatus: 'PAYMENT_COMPLETE',
            paymentCompleteTime: new Date(now - (5 * 60 * 60 * 1000)).toISOString(),
          },
        ],
        sections: [{ sectionItems: [{ productInfo: { prodName: '오래된 주문' } }] }],
      });
      const recentPaid = createOrder({
        orderNo: '20260313022',
        ordererName: '현재 스캔 주문',
        orderStatus: 'OPEN',
        wtime: new Date(now - (30 * 60 * 1000)).toISOString(),
        totalPaymentPrice: 222000,
        payments: [
          {
            paidPrice: 222000,
            paymentStatus: 'PAYMENT_COMPLETE',
            paymentCompleteTime: new Date(now - (20 * 60 * 1000)).toISOString(),
          },
        ],
        sections: [{ sectionItems: [{ productInfo: { prodName: '최근 주문' } }] }],
      });

      const result = await service.syncRecentOrdersToCogs(
        [olderPaid, recentPaid],
        { sinceTime: new Date(now - (45 * 60 * 1000)).toISOString() }
      );

      assert.equal(result.status, 'ok');
      assert.equal(result.eligibleOrders, 1);
      assert.equal(result.appended.length, 1);
      assert.equal(result.appended[0].orderNo, '20260313022');
      assert.equal(appendCount, 1);
      assert.equal(headerUpdateCount, 1);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('syncRecentOrdersToCogs keeps processing after one eligible order fails to append', async () => {
  const dataDir = createTempDataDir();
  const privateKey = createPrivateKeyPem();
  const originalFetch = global.fetch;
  const now = Date.now();
  let tokenRequests = 0;
  let appendRequests = 0;
  let headerUpdateRequests = 0;

  global.fetch = async (url, options = {}) => {
    const textUrl = String(url);
    if (textUrl === 'https://oauth2.googleapis.com/token') {
      tokenRequests += 1;
      return {
        ok: true,
        json: async () => ({ access_token: 'google-access-token', expires_in: 3600 }),
      };
    }

    if (textUrl.includes('/values:batchUpdate')) {
      headerUpdateRequests += 1;
      return {
        ok: true,
        json: async () => ({ totalUpdatedCells: 6 }),
      };
    }

    appendRequests += 1;
    const payload = JSON.parse(options.body);
    const firstOrderNo = payload.values?.[0]?.[3];
    if (firstOrderNo === '20260313011') {
      return {
        ok: false,
        json: async () => ({ error: { message: 'append failed for first order' } }),
      };
    }

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
          throw new Error('getOrder should not be called for batch append error test');
        },
      },
    }, async service => {
      const first = createOrder({
        orderNo: '20260313011',
        ordererName: '첫번째 실패',
        orderStatus: 'OPEN',
        wtime: new Date(now - (2 * 60 * 60 * 1000)).toISOString(),
        totalPaymentPrice: 111000,
        payments: [
          {
            paidPrice: 111000,
            paymentStatus: 'PAYMENT_COMPLETE',
            paymentCompleteTime: new Date(now - (90 * 60 * 1000)).toISOString(),
          },
        ],
        sections: [{ sectionItems: [{ productInfo: { prodName: '실패 주문' } }] }],
      });
      const second = createOrder({
        orderNo: '20260313012',
        ordererName: '두번째 성공',
        orderStatus: 'OPEN',
        wtime: new Date(now - (60 * 60 * 1000)).toISOString(),
        totalPaymentPrice: 222000,
        payments: [
          {
            paidPrice: 222000,
            paymentStatus: 'PAYMENT_COMPLETE',
            paymentCompleteTime: new Date(now - (30 * 60 * 1000)).toISOString(),
          },
        ],
        sections: [{ sectionItems: [{ productInfo: { prodName: '성공 주문' } }] }],
      });

      const result = await service.syncRecentOrdersToCogs([first, second], { lookbackDays: 3 });

      assert.equal(result.eligibleOrders, 2);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].orderNo, '20260313011');
      assert.equal(result.appended.length, 1);
      assert.equal(result.appended[0].orderNo, '20260313012');
      assert.equal(appendRequests, 2);
      assert.equal(headerUpdateRequests, 1);
      assert.equal(tokenRequests, 1);
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
