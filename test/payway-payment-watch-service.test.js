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
