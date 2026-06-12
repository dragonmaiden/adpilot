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
    [require.resolve('../server/runtime/runtimeSettings'), overrides.runtimeSettings || {
      getSchedulerSettings: () => overrides.config?.scheduler || {},
    }],
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

test('Payway watcher accepts payments from any configured Payway terminal id', async () => {
  const dataDir = createTempDataDir();
  const deliveries = [];
  const config = createConfig();
  config.payway.mid = 'TMN009889,TMN025656';

  await withMockedWatchService({
    config,
    runtimePaths: { dataDir },
    paywayClient: {
      isEnabled: () => true,
      isConfigured: () => true,
      isApprovedPaywayPayment: payment => payment.status === '승인' && payment.transactionAmount > 0,
      fetchPaymentHistory: async () => [
        {
          transactionId: 'TMN025656:55556666:2026-06-02 09:23:56:96900',
          transactionAt: '2026-06-02 09:23:56',
          transactionAtIso: '2026-06-02T00:23:56.000Z',
          status: '승인',
          terminal: 'TMN025656',
          approvalNo: '55556666',
          transactionAmount: 96900,
          approvedAmount: 96900,
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
      orderNo: '202606020001',
      orderDate: '2026-06-02',
      customerName: '김민지',
      orderValue: 96900,
      paymentState: 'awaiting_check',
      productNames: ['니트백'],
    }, {
      now: new Date('2026-06-02T00:20:00.000Z'),
      messageId: 5001,
    });

    const result = await service.runDueChecks({
      now: new Date('2026-06-02T00:24:00.000Z'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.detected, 1);
    assert.equal(result.delivered, 1);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payment.terminal, 'TMN025656');

    const state = service.loadState();
    assert.equal(state.watchedOrders['202606020001'].status, 'paid');
  });
});

test('Payway watcher accepts terminal-id drift when strict terminal matching is disabled', async () => {
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
          transactionId: 'TMN777777:66667777:2026-06-02 09:33:56:96900',
          transactionAt: '2026-06-02 09:33:56',
          transactionAtIso: '2026-06-02T00:33:56.000Z',
          status: '승인',
          terminal: 'TMN777777',
          approvalNo: '66667777',
          transactionAmount: 96900,
          approvedAmount: 96900,
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
      orderNo: '202606020002',
      orderDate: '2026-06-02',
      customerName: '김민지',
      orderValue: 96900,
      paymentState: 'awaiting_check',
      productNames: ['니트백'],
    }, {
      now: new Date('2026-06-02T00:30:00.000Z'),
      messageId: 5002,
    });

    const result = await service.runDueChecks({
      now: new Date('2026-06-02T00:34:00.000Z'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.detected, 1);
    assert.equal(result.delivered, 1);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payment.terminal, 'TMN777777');
  });
});

test('Payway watcher enforces a 60-minute minimum watch window', async () => {
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
          transactionId: 'TMN009889:66668888:2026-06-02 10:15:00:96900',
          transactionAt: '2026-06-02 10:15:00',
          transactionAtIso: '2026-06-02T01:15:00.000Z',
          status: '승인',
          terminal: 'TMN009889',
          approvalNo: '66668888',
          transactionAmount: 96900,
          approvedAmount: 96900,
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
      orderNo: '202606020003',
      orderDate: '2026-06-02',
      customerName: '김민지',
      orderValue: 96900,
      paymentState: 'awaiting_check',
      productNames: ['니트백'],
    }, {
      now: new Date('2026-06-02T00:30:00.000Z'),
      messageId: 5003,
    });

    assert.equal(watched.expiresAt, '2026-06-02T01:30:00.000Z');

    const result = await service.runDueChecks({
      now: new Date('2026-06-02T01:15:30.000Z'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.detected, 1);
    assert.equal(result.delivered, 1);
    assert.equal(deliveries.length, 1);
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

test('Payway watcher lead window follows runtime scheduler overrides', async () => {
  const dataDir = createTempDataDir();
  const deliveries = [];

  await withMockedWatchService({
    config: createConfig(),
    runtimePaths: { dataDir },
    runtimeSettings: {
      getSchedulerSettings: () => ({ scanIntervalMinutes: 10 }),
    },
    paywayClient: {
      isEnabled: () => true,
      isConfigured: () => true,
      isApprovedPaywayPayment: payment => payment.status === '승인' && payment.transactionAmount > 0,
      fetchPaymentHistory: async () => [
        {
          transactionId: 'TMN009889:77773333:2026-05-25 19:47:45:129000',
          transactionAt: '2026-05-25 19:47:45',
          transactionAtIso: '2026-05-25T10:47:45.000Z',
          status: '승인',
          terminal: 'TMN009889',
          approvalNo: '77773333',
          transactionAmount: 129000,
          approvedAmount: 129000,
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
      orderNo: '202605252918861',
      orderDate: '2026-05-25',
      customerName: '이지은',
      orderValue: 129000,
      paymentState: 'awaiting_check',
      productNames: ['숄더백'],
    }, {
      now: new Date('2026-05-25T10:58:32.000Z'),
      messageId: 1365,
    });

    const result = await service.runDueChecks({
      now: new Date('2026-05-25T10:58:33.000Z'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.detected, 1);
    assert.equal(result.delivered, 1);
    assert.equal(deliveries.length, 1);
  });
});

test('Payway watcher fails closed when one payment matches multiple pending orders', async () => {
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
          transactionId: 'TMN009889:22221111:2026-05-25 20:01:00:118000',
          transactionAt: '2026-05-25 20:01:00',
          transactionAtIso: '2026-05-25T11:01:00.000Z',
          status: '승인',
          terminal: 'TMN009889',
          approvalNo: '22221111',
          transactionAmount: 118000,
          approvedAmount: 118000,
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
      orderNo: '202605252918862',
      orderDate: '2026-05-25',
      customerName: '김서연',
      orderValue: 118000,
      paymentState: 'awaiting_check',
      productNames: ['지갑'],
    }, {
      now: new Date('2026-05-25T11:00:00.000Z'),
      messageId: 1366,
    });
    service.watchOrder({
      orderNo: '202605252918863',
      orderDate: '2026-05-25',
      customerName: '박민지',
      orderValue: 118000,
      paymentState: 'awaiting_check',
      productNames: ['지갑'],
    }, {
      now: new Date('2026-05-25T11:00:30.000Z'),
      messageId: 1367,
    });

    const result = await service.runDueChecks({
      now: new Date('2026-05-25T11:01:30.000Z'),
    });

    assert.equal(result.ok, false);
    assert.equal(result.detected, 0);
    assert.equal(result.delivered, 0);
    assert.equal(result.ambiguousMatches, 2);
    assert.equal(deliveries.length, 0);

    const state = service.loadState();
    assert.equal(state.watchedOrders['202605252918862'].status, 'watching');
    assert.equal(state.watchedOrders['202605252918863'].status, 'watching');
    assert.equal(state.watchedOrders['202605252918862'].lastPollError, 'ambiguous_multiple_order_watches');
    assert.equal(state.watchedOrders['202605252918863'].lastPollError, 'ambiguous_multiple_order_watches');
  });
});

test('Payway watcher sends one deduped warning for ambiguous Payway matches', async () => {
  const dataDir = createTempDataDir();
  const deliveries = [];
  const warnings = [];

  await withMockedWatchService({
    config: createConfig(),
    runtimePaths: { dataDir },
    paywayClient: {
      isEnabled: () => true,
      isConfigured: () => true,
      isApprovedPaywayPayment: payment => payment.status === '승인' && payment.transactionAmount > 0,
      fetchPaymentHistory: async () => [
        {
          transactionId: 'TMN009889:22221111:2026-05-25 20:01:00:118000',
          transactionAt: '2026-05-25 20:01:00',
          transactionAtIso: '2026-05-25T11:01:00.000Z',
          status: '승인',
          terminal: 'TMN009889',
          approvalNo: '22221111',
          transactionAmount: 118000,
          approvedAmount: 118000,
          cancelAmount: 0,
        },
      ],
    },
    orderNotificationService: {
      deliverPaywayPaymentNotification: async (result, payment) => {
        deliveries.push({ result, payment });
        return { ok: true };
      },
      deliverPaywayAmbiguousPaymentWarning: async payload => {
        warnings.push(payload);
        return { ok: true, messageId: 9001 };
      },
    },
  }, async service => {
    service.watchOrder({
      orderNo: '202605252918862',
      orderDate: '2026-05-25',
      customerName: '김서연',
      orderValue: 118000,
      paymentState: 'awaiting_check',
      productNames: ['지갑'],
    }, {
      now: new Date('2026-05-25T11:00:00.000Z'),
      messageId: 1366,
    });
    service.watchOrder({
      orderNo: '202605252918863',
      orderDate: '2026-05-25',
      customerName: '박민지',
      orderValue: 118000,
      paymentState: 'awaiting_check',
      productNames: ['지갑'],
    }, {
      now: new Date('2026-05-25T11:00:30.000Z'),
      messageId: 1367,
    });

    const first = await service.runDueChecks({
      now: new Date('2026-05-25T11:01:30.000Z'),
    });
    const second = await service.runDueChecks({
      now: new Date('2026-05-25T11:02:00.000Z'),
    });

    assert.equal(first.ok, false);
    assert.equal(first.ambiguousMatches, 2);
    assert.equal(first.ambiguousWarningsSent, 1);
    assert.equal(second.ambiguousWarningsSent, 0);
    assert.equal(warnings.length, 1);
    assert.equal(deliveries.length, 0);
    assert.deepEqual(warnings[0].orderNos, ['202605252918862', '202605252918863']);
    assert.equal(warnings[0].amount, 118000);

    const state = service.loadState();
    assert.equal(Object.keys(state.ambiguityWarnings).length, 1);
    assert.equal(Object.values(state.ambiguityWarnings)[0].messageId, 9001);
  });
});

test('Payway watcher fails closed when one order matches multiple payments', async () => {
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
          transactionId: 'TMN009889:33331111:2026-05-25 20:01:00:88000',
          transactionAt: '2026-05-25 20:01:00',
          transactionAtIso: '2026-05-25T11:01:00.000Z',
          status: '승인',
          terminal: 'TMN009889',
          approvalNo: '33331111',
          transactionAmount: 88000,
          approvedAmount: 88000,
          cancelAmount: 0,
        },
        {
          transactionId: 'TMN009889:33332222:2026-05-25 20:01:20:88000',
          transactionAt: '2026-05-25 20:01:20',
          transactionAtIso: '2026-05-25T11:01:20.000Z',
          status: '승인',
          terminal: 'TMN009889',
          approvalNo: '33332222',
          transactionAmount: 88000,
          approvedAmount: 88000,
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
      orderNo: '202605252918864',
      orderDate: '2026-05-25',
      customerName: '최유리',
      orderValue: 88000,
      paymentState: 'awaiting_check',
      productNames: ['파우치'],
    }, {
      now: new Date('2026-05-25T11:00:00.000Z'),
      messageId: 1368,
    });

    const result = await service.runDueChecks({
      now: new Date('2026-05-25T11:01:30.000Z'),
    });

    assert.equal(result.ok, false);
    assert.equal(result.detected, 0);
    assert.equal(result.delivered, 0);
    assert.equal(result.ambiguousMatches, 1);
    assert.equal(deliveries.length, 0);

    const state = service.loadState();
    assert.equal(state.watchedOrders['202605252918864'].status, 'watching');
    assert.equal(state.watchedOrders['202605252918864'].lastPollError, 'ambiguous_multiple_payway_payments');
  });
});

test('Payway watcher retries after a temporary payment history failure', async () => {
  const dataDir = createTempDataDir();
  const deliveries = [];
  let fetchAttempts = 0;

  await withMockedWatchService({
    config: createConfig(),
    runtimePaths: { dataDir },
    paywayClient: {
      isEnabled: () => true,
      isConfigured: () => true,
      isApprovedPaywayPayment: payment => payment.status === '승인' && payment.transactionAmount > 0,
      fetchPaymentHistory: async () => {
        fetchAttempts += 1;
        if (fetchAttempts === 1) {
          throw new Error('Payway timeout');
        }
        return [
          {
            transactionId: 'TMN009889:44441111:2026-05-25 20:01:00:158000',
            transactionAt: '2026-05-25 20:01:00',
            transactionAtIso: '2026-05-25T11:01:00.000Z',
            status: '승인',
            terminal: 'TMN009889',
            approvalNo: '44441111',
            transactionAmount: 158000,
            approvedAmount: 158000,
            cancelAmount: 0,
          },
        ];
      },
    },
    orderNotificationService: {
      deliverPaywayPaymentNotification: async (result, payment) => {
        deliveries.push({ result, payment });
        return { ok: true };
      },
    },
  }, async service => {
    service.watchOrder({
      orderNo: '202605252918865',
      orderDate: '2026-05-25',
      customerName: '정다은',
      orderValue: 158000,
      paymentState: 'awaiting_check',
      productNames: ['토트백'],
    }, {
      now: new Date('2026-05-25T11:00:00.000Z'),
      messageId: 1369,
    });

    const failed = await service.runDueChecks({
      now: new Date('2026-05-25T11:01:30.000Z'),
    });

    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'Payway timeout');
    assert.equal(deliveries.length, 0);
    let state = service.loadState();
    assert.equal(state.watchedOrders['202605252918865'].status, 'watching');
    assert.equal(state.watchedOrders['202605252918865'].lastPollError, 'Payway timeout');

    const recovered = await service.runDueChecks({
      now: new Date('2026-05-25T11:02:00.000Z'),
    });

    assert.equal(recovered.ok, true);
    assert.equal(recovered.detected, 1);
    assert.equal(recovered.delivered, 1);
    assert.equal(deliveries.length, 1);
    state = service.loadState();
    assert.equal(state.watchedOrders['202605252918865'].status, 'paid');
    assert.equal(state.watchedOrders['202605252918865'].lastPollError, null);
  });
});

test('Payway watcher refresh keeps the original match window for missed pending cards', async () => {
  const dataDir = createTempDataDir();
  const deliveries = [];
  const config = createConfig();
  config.payway.minimumWatchMinutes = 10;
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
    config,
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
