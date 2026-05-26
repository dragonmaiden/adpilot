const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function withMockedWatchService(overrides, run) {
  const servicePath = require.resolve('../server/services/paywayPaymentWatchService');
  const dependencyEntries = [
    [require.resolve('../server/config'), overrides.config],
    [require.resolve('../server/runtime/paths'), overrides.runtimePaths],
    [require.resolve('../server/modules/paywayClient'), overrides.paywayClient],
    [require.resolve('../server/services/orderNotificationService'), overrides.orderNotificationService],
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

function createTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adpilot-payway-watch-'));
}

function createConfig() {
  return {
    scheduler: {
      scanIntervalMinutes: 3,
    },
    payway: {
      enabled: true,
      mid: 'TMN009889',
      watchMinutes: 10,
      pollIntervalSeconds: 30,
      matchLeadMinutes: 2,
    },
  };
}

test('Payway watcher detects a matching approved payment and triggers the Payway Telegram completion flow', async () => {
  const dataDir = createTempDataDir();
  const deliveries = [];

  await withMockedWatchService({
    config: createConfig(),
    runtimePaths: { dataDir },
    paywayClient: {
      isEnabled: () => true,
      isConfigured: () => true,
      isApprovedPaywayPayment: payment => payment.status === '승인' && payment.transactionAmount > 0,
      fetchPaymentHistory: async () => [
        {
          transactionId: 'TMN009889:87654321:2026-03-15 12:30:20:111000',
          transactionAt: '2026-03-15 12:30:20',
          transactionAtIso: '2026-03-15T03:30:20.000Z',
          status: '승인',
          terminal: 'TMN009889',
          approvalNo: '87654321',
          transactionAmount: 111000,
          approvedAmount: 111000,
          cancelAmount: 0,
        },
      ],
    },
    orderNotificationService: {
      deliverPaywayPaymentNotification: async (result, payment) => {
        deliveries.push({ result, payment });
        return { ok: true };
      },
    },
  }, async service => {
    const watched = service.watchOrder({
      orderNo: '202603150001',
      orderDate: '2026-03-15',
      customerName: '홍신희',
      orderValue: 111000,
      paymentState: 'awaiting_check',
      productNames: ['실크 모노그램 방도'],
    }, {
      now: new Date('2026-03-15T03:30:00.000Z'),
      messageId: 4321,
    });

    assert.equal(watched.watching, true);
    const result = await service.runDueChecks({
      now: new Date('2026-03-15T03:30:30.000Z'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.detected, 1);
    assert.equal(result.delivered, 1);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].result.orderNo, '202603150001');
    assert.equal(deliveries[0].result.paymentSource, 'payway');
    assert.equal(deliveries[0].result.paymentLabel, 'Payway card approved');
    assert.equal(deliveries[0].payment.approvalNo, '87654321');

    const state = service.loadState();
    assert.equal(state.watchedOrders['202603150001'].status, 'paid');
    assert.ok(state.handledTransactions['TMN009889:87654321:2026-03-15 12:30:20:111000']);
  });
});

test('Payway watcher lead window covers scheduler lag before the watch starts', async () => {
  const dataDir = createTempDataDir();
  const deliveries = [];

  await withMockedWatchService({
    config: createConfig(),
    runtimePaths: { dataDir },
    paywayClient: {
      isEnabled: () => true,
      isConfigured: () => true,
      isApprovedPaywayPayment: payment => payment.status === '승인' && payment.transactionAmount > 0,
      fetchPaymentHistory: async () => [
        {
          transactionId: 'TMN009889:55554444:2026-05-25 19:56:17:316800',
          transactionAt: '2026-05-25 19:56:17',
          transactionAtIso: '2026-05-25T10:56:17.000Z',
          status: '승인',
          terminal: 'TMN009889',
          approvalNo: '55554444',
          transactionAmount: 316800,
          approvedAmount: 316800,
          cancelAmount: 0,
        },
      ],
    },
    orderNotificationService: {
      deliverPaywayPaymentNotification: async (result, payment) => {
        deliveries.push({ result, payment });
        return { ok: true };
      },
    },
  }, async service => {
    service.watchOrder({
      orderNo: '202605252918860',
      orderDate: '2026-05-25',
      customerName: '송현지',
      orderValue: 344000,
      paymentDueAmount: 316800,
      paywayMatchAmount: 316800,
      paymentState: 'awaiting_check',
      productNames: ['백팩'],
    }, {
      now: new Date('2026-05-25T10:58:32.000Z'),
      messageId: 1364,
    });

    const result = await service.runDueChecks({
      now: new Date('2026-05-25T10:58:33.000Z'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.detected, 1);
    assert.equal(result.delivered, 1);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].result.orderNo, '202605252918860');
    assert.equal(deliveries[0].payment.transactionAmount, 316800);
  });
});

test('Payway watcher refresh keeps the original match window for missed pending cards', async () => {
  const dataDir = createTempDataDir();
  const deliveries = [];
  const payment = {
    transactionId: 'TMN009889:87654321:2026-03-15 12:35:20:111000',
    transactionAt: '2026-03-15 12:35:20',
    transactionAtIso: '2026-03-15T03:35:20.000Z',
    status: '승인',
    terminal: 'TMN009889',
    approvalNo: '87654321',
    transactionAmount: 111000,
    approvedAmount: 111000,
    cancelAmount: 0,
  };

  await withMockedWatchService({
    config: createConfig(),
    runtimePaths: { dataDir },
    paywayClient: {
      isEnabled: () => true,
      isConfigured: () => true,
      isApprovedPaywayPayment: candidate => candidate.status === '승인' && candidate.transactionAmount > 0,
      fetchPaymentHistory: async () => [payment],
    },
    orderNotificationService: {
      deliverPaywayPaymentNotification: async (result, matchedPayment) => {
        deliveries.push({ result, payment: matchedPayment });
        return { ok: true };
      },
    },
  }, async service => {
    const order = {
      orderNo: '202603150001',
      orderDate: '2026-03-15',
      customerName: '홍신희',
      orderValue: 111000,
      paymentState: 'awaiting_check',
      productNames: ['실크 모노그램 방도'],
    };

    service.watchOrder(order, {
      now: new Date('2026-03-15T03:30:00.000Z'),
      messageId: 4321,
    });
    await service.runDueChecks({
      now: new Date('2026-03-15T03:41:30.000Z'),
    });

    let state = service.loadState();
    assert.equal(state.watchedOrders['202603150001'].status, 'expired');

    service.watchOrder(order, {
      now: new Date('2026-03-15T03:42:00.000Z'),
      messageId: 4321,
    });
    const result = await service.runDueChecks({
      now: new Date('2026-03-15T03:42:05.000Z'),
    });

    assert.equal(result.detected, 1);
    assert.equal(result.delivered, 1);
    assert.equal(deliveries.length, 1);
    state = service.loadState();
    assert.equal(state.watchedOrders['202603150001'].watchStartedAt, '2026-03-15T03:30:00.000Z');
    assert.equal(state.watchedOrders['202603150001'].status, 'paid');
  });
});

test('Payway watcher matches the Imweb payable amount instead of the display order total', async () => {
  const dataDir = createTempDataDir();
  const deliveries = [];

  await withMockedWatchService({
    config: createConfig(),
    runtimePaths: { dataDir },
    paywayClient: {
      isEnabled: () => true,
      isConfigured: () => true,
      isApprovedPaywayPayment: payment => payment.status === '승인' && payment.transactionAmount > 0,
      fetchPaymentHistory: async () => [
        {
          transactionId: 'TMN009889:40895600:2026-05-20 12:25:28:217050',
          transactionAt: '2026-05-20 12:25:28',
          transactionAtIso: '2026-05-20T03:25:28.000Z',
          status: '승인',
          terminal: 'TMN009889',
          approvalNo: '40895600',
          transactionAmount: 217050,
          approvedAmount: 217050,
          cancelAmount: 0,
        },
      ],
    },
    orderNotificationService: {
      deliverPaywayPaymentNotification: async (result, payment) => {
        deliveries.push({ result, payment });
        return { ok: true };
      },
    },
  }, async service => {
    const watched = service.watchOrder({
      orderNo: '202605208943494',
      orderDate: '2026-05-20',
      customerName: '김민정',
      orderValue: 239000,
      paymentDueAmount: 217050,
      paywayMatchAmount: 217050,
      paymentState: 'awaiting_check',
      productNames: ['미니 크로스백'],
    }, {
      now: new Date('2026-05-20T03:27:13.000Z'),
      messageId: 7001,
    });

    assert.equal(watched.watching, true);
    let state = service.loadState();
    assert.equal(state.watchedOrders['202605208943494'].amount, 217050);

    const result = await service.runDueChecks({
      now: new Date('2026-05-20T03:27:20.000Z'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.detected, 1);
    assert.equal(result.delivered, 1);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].result.orderNo, '202605208943494');
    assert.equal(deliveries[0].result.orderValue, 217050);
    assert.equal(deliveries[0].payment.transactionAmount, 217050);

    state = service.loadState();
    assert.equal(state.watchedOrders['202605208943494'].status, 'paid');
  });
});

test('Payway watcher retries original card completion after the payment watch window expires', async () => {
  const dataDir = createTempDataDir();
  const deliveries = [];
  const payment = {
    transactionId: 'TMN009889:31201111:2026-05-21 08:33:24:118000',
    transactionAt: '2026-05-21 08:33:24',
    transactionAtIso: '2026-05-20T23:33:24.000Z',
    status: '승인',
    terminal: 'TMN009889',
    approvalNo: '31201111',
    transactionAmount: 118000,
    approvedAmount: 118000,
    cancelAmount: 0,
  };

  await withMockedWatchService({
    config: createConfig(),
    runtimePaths: { dataDir },
    paywayClient: {
      isEnabled: () => true,
      isConfigured: () => true,
      isApprovedPaywayPayment: candidate => candidate.status === '승인' && candidate.transactionAmount > 0,
      fetchPaymentHistory: async () => [payment],
    },
    orderNotificationService: {
      deliverPaywayPaymentNotification: async (result, matchedPayment) => {
        deliveries.push({ result, payment: matchedPayment });
        if (deliveries.length === 1) {
          return {
            ok: false,
            reason: 'completion_failed',
            paymentMessage: { ok: true, messageId: 8801 },
            completion: { ok: false, reason: 'edit_failed' },
          };
        }
        return { ok: true };
      },
    },
  }, async service => {
    service.watchOrder({
      orderNo: '202605210303073',
      orderDate: '2026-05-21',
      customerName: '구지은',
      orderValue: 118000,
      paymentState: 'awaiting_check',
      productNames: ['테스트 상품'],
    }, {
      now: new Date('2026-05-20T23:33:43.000Z'),
      messageId: 1281,
    });

    const detected = await service.runDueChecks({
      now: new Date('2026-05-20T23:34:16.000Z'),
    });

    assert.equal(detected.ok, false);
    assert.equal(detected.detected, 1);
    assert.equal(detected.failedDeliveries, 1);

    let state = service.loadState();
    assert.equal(state.watchedOrders['202605210303073'].status, 'payment_detected');
    assert.equal(state.watchedOrders['202605210303073'].completionAttempts, 1);
    assert.equal(state.watchedOrders['202605210303073'].completionRetryExpiresAt, '2026-05-21T23:34:16.000Z');

    const retried = await service.runDueChecks({
      now: new Date('2026-05-20T23:45:00.000Z'),
    });

    assert.equal(retried.ok, true);
    assert.equal(retried.detected, 0);
    assert.equal(retried.delivered, 1);
    assert.equal(deliveries.length, 2);

    state = service.loadState();
    assert.equal(state.watchedOrders['202605210303073'].status, 'paid');
    assert.equal(state.watchedOrders['202605210303073'].paywayTransactionId, payment.transactionId);
  });
});
