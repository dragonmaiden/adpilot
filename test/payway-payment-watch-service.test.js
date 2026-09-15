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
    [require.resolve('../server/modules/imwebClient'), overrides.imwebClient || {
      getOrder: async orderNo => {
        throw new Error(`Unexpected direct Imweb lookup for ${orderNo}`);
      },
      confirmBankTransferPayment: async () => ({ confirmed: true, alreadyConfirmed: false }),
    }],
    [require.resolve('../server/services/cogsAutofillService'), overrides.cogsAutofillService || {
      buildOrderNotificationResult: order => {
        const payment = Array.isArray(order?.payments) ? order.payments[0] : null;
        const amount = Number(payment?.paidPrice || order?.totalPaymentPrice || order?.totalPrice || 0);
        const isPaid = String(payment?.paymentStatus || '').includes('COMPLETE');
        return {
          orderNo: String(order?.orderNo || ''),
          orderDate: order?.wtime || '',
          customerName: order?.ordererName || '',
          productNames: [],
          orderValue: amount,
          paymentDueAmount: amount,
          paywayMatchAmount: amount,
          paymentState: isPaid ? 'paid' : 'awaiting_check',
          paymentMethod: payment?.method || '',
          paymentChannel: payment?.method === 'BANKTRANSFER' ? 'bank_transfer' : 'other',
        };
      },
    }],
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
    const watchOrder = service.watchOrder;
    service.watchOrder = (result, options) => watchOrder({
      paymentChannel: 'bank_transfer',
      ...result,
    }, options);
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
      autoConfirmImwebPayment: false,
    },
  };
}

test('scheduled payment checks confirm other orders while Telegram remains blocked', async () => {
  const dataDir = createTempDataDir();
  const config = createConfig();
  config.payway.autoConfirmImwebPayment = true;
  const confirmed = [];
  let releaseTelegram;
  const telegramGate = new Promise(resolve => { releaseTelegram = resolve; });
  let deliveries = 0;
  const orders = ['202609140001', '202609140002'];
  await withMockedWatchService({ config, runtimePaths: { dataDir },
    paywayClient: { isEnabled: () => true, isConfigured: () => true,
      isApprovedPaywayPayment: () => true,
      fetchPaymentHistory: async () => orders.map(orderNo => ({ merchantOrderNo: orderNo, transactionId: orderNo,
        transactionAmount: 88063, transactionAtIso: '2026-09-14T09:00:00Z' })),
    },
    imwebClient: { confirmBankTransferPayment: async orderNo => { confirmed.push(orderNo); return { confirmed: true }; } },
    orderNotificationService: { deliverPaywayPaymentNotification: async () => { deliveries++; await telegramGate; return { ok: true }; } },
  }, async service => {
    for (const orderNo of orders) service.watchOrder({ orderNo, orderValue: 88063, paymentState: 'awaiting_check' },
      { now: new Date('2026-09-14T09:00:00Z') });
    const poll = service.runDueChecks({ now: new Date('2026-09-14T09:00:15Z'), waitForNotifications: false });
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(confirmed, orders);
      assert.equal((await poll).directUnresolved, 0);
      assert.equal((await service.runDueChecks({ now: new Date('2026-09-14T09:00:30Z'), waitForNotifications: false })).directUnresolved, 0);
      assert.deepEqual(confirmed, orders);
      assert.equal(deliveries, 2);
      service.watchOrder({ orderNo: '202609140003', orderValue: 99000, paymentState: 'awaiting_check' });
    } finally {
      releaseTelegram();
      await poll;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(service.loadState().watchedOrders[orders[0]].status, 'paid');
    assert.equal(service.loadState().watchedOrders[orders[1]].status, 'paid');
    assert.equal(service.loadState().watchedOrders['202609140003'].status, 'watching');
  });
});

test('a failed Imweb confirmation retries next poll even while Telegram is blocked', async () => {
  const dataDir = createTempDataDir();
  const config = createConfig();
  config.payway.autoConfirmImwebPayment = true;
  const orderNo = '202609055487584';
  let attempts = 0;
  let releaseTelegram;
  const gate = new Promise(resolve => { releaseTelegram = resolve; });
  const deliveries = [];
  await withMockedWatchService({ config, runtimePaths: { dataDir },
    paywayClient: { isEnabled: () => true, isConfigured: () => true,
      isApprovedPaywayPayment: () => true,
      fetchPaymentHistory: async () => [{ merchantOrderNo: orderNo, transactionId: 'retry-approval',
        transactionAmount: 198550, transactionAtIso: '2026-09-05T08:50:06Z' }],
    },
    imwebClient: { confirmBankTransferPayment: async () => {
      if (++attempts === 1) throw new Error('temporary Imweb timeout');
      return { confirmed: true };
    } },
    orderNotificationService: {
      deliverPaywayAttentionWarning: async () => { await gate; return { ok: true }; },
      deliverPaywayPaymentNotification: async (_order, _payment, options) => {
        deliveries.push(options); await gate; return { ok: true };
      },
    },
  }, async service => {
    service.watchOrder({ orderNo, orderValue: 198550, paymentState: 'awaiting_check' },
      { now: new Date('2026-09-05T08:53:55Z') });
    try {
      await service.runDueChecks({ now: new Date('2026-09-05T08:54:00Z'), waitForNotifications: false });
      await service.runDueChecks({ now: new Date('2026-09-05T08:54:30Z'), waitForNotifications: false });
      assert.equal(attempts, 2);
      assert.equal(service.loadState().watchedOrders[orderNo].imwebConfirmation.status, 'confirmed');
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].imwebPaymentConfirmed, true);
    } finally {
      releaseTelegram();
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(service.loadState().watchedOrders[orderNo].status, 'paid');
  });
});

test('poll cadence subtracts processing time and never overlaps slow payment checks', async () => {
  const config = createConfig();
  config.payway.autoConfirmImwebPayment = true;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalNow = Date.now;
  let elapsed = 0;
  let processingMs = 11000;
  const delays = [];
  await withMockedWatchService({ config, runtimePaths: { dataDir: createTempDataDir() },
    paywayClient: { isEnabled: () => true, isConfigured: () => true,
      fetchPaymentHistory: async () => { elapsed += processingMs; return []; }, isApprovedPaywayPayment: () => true },
    orderNotificationService: {},
  }, async service => {
    try {
      Date.now = () => originalNow() + elapsed;
      global.setTimeout = (_callback, delay) => { delays.push(delay); return { unref() {} }; };
      global.clearTimeout = () => {};
      service.start();
      await service.runDueChecks({ waitForNotifications: false });
      assert.ok(delays.at(-1) <= 19000 && delays.at(-1) >= 18500);
      processingMs = 40000;
      await service.runDueChecks({ waitForNotifications: false });
      assert.equal(delays.at(-1), 1000);
    } finally {
      service.stop();
      Date.now = originalNow;
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    }
  });
});

test('an in-flight payment poll cannot erase a newly registered order', async () => {
  const dataDir = createTempDataDir();
  let finishFetch;
  const config = createConfig();
  config.payway.autoConfirmImwebPayment = true;
  await withMockedWatchService({
    config, runtimePaths: { dataDir },
    paywayClient: {
      isEnabled: () => true, isConfigured: () => true,
      isApprovedPaywayPayment: () => true,
      fetchPaymentHistory: () => new Promise(resolve => { finishFetch = resolve; }),
    },
    orderNotificationService: {},
  }, async service => {
    const poll = service.runDueChecks({ now: new Date('2026-09-13T04:43:00Z') });
    service.watchOrder({ orderNo: '202609137271906', orderValue: 88063, paymentState: 'awaiting_check' },
      { now: new Date('2026-09-13T04:43:03Z') });
    finishFetch([]);
    await poll;
    assert.equal(service.loadState().watchedOrders['202609137271906']?.watchStartedAt, '2026-09-13T04:43:03.000Z');
  });
});

test('direct reconciliation replays a late-visible exact-order payment behind the cursor', async () => {
  const dataDir = createTempDataDir();
  const config = createConfig();
  config.payway.autoConfirmImwebPayment = true;
  let payments = [];
  const confirmed = [];
  await withMockedWatchService({
    config, runtimePaths: { dataDir },
    paywayClient: {
      isEnabled: () => true, isConfigured: () => true,
      isApprovedPaywayPayment: () => true, fetchPaymentHistory: async () => payments,
    },
    imwebClient: {
      getOrder: async orderNo => ({ orderNo, totalPrice: 88063, payments: [{ method: 'BANKTRANSFER', paymentStatus: 'PAYMENT_WAIT' }] }),
      confirmBankTransferPayment: async orderNo => { confirmed.push(orderNo); return { confirmed: true }; },
    },
    orderNotificationService: { deliverPaywayPaymentNotification: async () => ({ ok: true }) },
  }, async service => {
    await service.runDueChecks({ now: new Date('2026-09-13T04:49:00Z') });
    payments = [{ transactionId: 'late-approval', merchantOrderNo: '202609137271906',
      transactionAmount: 88063, transactionAtIso: '2026-09-13T04:38:04Z', terminal: 'TMN025656' }];
    await service.runDueChecks({ now: new Date('2026-09-13T04:50:00Z') });
    await service.runDueChecks({ now: new Date('2026-09-13T04:51:00Z') });
    assert.deepEqual(confirmed, ['202609137271906']);
  });
});

test('confirmation retries survive concurrent scans and restart, with retried, deduplicated warnings', async () => {
  const dataDir = createTempDataDir();
  const config = createConfig();
  config.payway.autoConfirmImwebPayment = true;
  let releaseConfirmation;
  let warningCalls = 0;
  let confirmationCalls = 0;
  const payment = { transactionId: 'restart-payment', merchantOrderNo: '202609137271906',
    transactionAmount: 88063, transactionAtIso: '2026-09-13T04:38:04Z', terminal: 'TMN025656' };
  const order = { orderNo: payment.merchantOrderNo, orderValue: 88063, paymentState: 'awaiting_check' };
  const overrides = {
    config, runtimePaths: { dataDir },
    paywayClient: { isEnabled: () => true, isConfigured: () => true,
      isApprovedPaywayPayment: () => true, fetchPaymentHistory: async () => [payment] },
    imwebClient: {
      confirmBankTransferPayment: async () => {
        confirmationCalls++;
        await new Promise(resolve => { releaseConfirmation = resolve; });
        throw new Error('temporary Imweb failure');
      },
    },
    orderNotificationService: {
      deliverPaywayPaymentNotification: async () => { throw new Error('Telegram timeout'); },
      deliverPaywayAttentionWarning: async () => ({ ok: ++warningCalls > 1 }),
    },
  };
  await withMockedWatchService(overrides, async service => {
    service.watchOrder(order, { now: new Date('2026-09-13T04:49:51Z') });
    const poll = service.runDueChecks({ now: new Date('2026-09-13T04:50:00Z') });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.loadState().watchedOrders[order.orderNo].matchedPayment.transactionId, payment.transactionId);
    assert.equal(service.watchOrder(order).reason, 'payment_already_detected');
    releaseConfirmation();
    await poll;
    assert.equal(service.loadState().watchedOrders[order.orderNo].status, 'payment_detected');
    assert.equal(warningCalls, 1, 'failed warning remains eligible for the next poll');
  });
  // New module instance reads the persisted approval even when Payway no longer returns it.
  overrides.paywayClient.fetchPaymentHistory = async () => [];
  overrides.imwebClient.confirmBankTransferPayment = async () => {
    confirmationCalls++;
    throw new Error('still unavailable');
  };
  await withMockedWatchService(overrides, async service => {
    await service.runDueChecks({ now: new Date('2026-09-13T04:51:00Z') });
    await service.runDueChecks({ now: new Date('2026-09-13T04:52:00Z') });
    assert.equal(warningCalls, 2);
    assert.equal(confirmationCalls, 3);
    overrides.imwebClient.confirmBankTransferPayment = async () => ({ confirmed: true });
    overrides.orderNotificationService.deliverPaywayPaymentNotification = async () => ({ ok: true });
    await service.runDueChecks({ now: new Date('2026-09-13T04:53:00Z') });
    assert.equal(service.loadState().watchedOrders[order.orderNo].status, 'paid');
  });
});

test('September 5 approval is confirmed after delayed discovery, with or without a scanner watch', async () => {
  // Replay the observed timestamps; this does not establish the historical failure cause.
  for (const registerWatch of [false, true]) {
    const dataDir = createTempDataDir();
    const config = createConfig();
    config.payway.autoConfirmImwebPayment = true;
    const orderNo = '202609055487584';
    let payments = [];
    let confirmations = 0;
    await withMockedWatchService({ config, runtimePaths: { dataDir },
      paywayClient: { isEnabled: () => true, isConfigured: () => true,
        isApprovedPaywayPayment: () => true, fetchPaymentHistory: async () => payments },
      imwebClient: {
        getOrder: async () => ({ orderNo, orderStatus: 'OPEN', totalPrice: 198550,
          payments: [{ method: 'BANKTRANSFER', paymentStatus: 'PAYMENT_WAIT', paidPrice: 198550 }] }),
        confirmBankTransferPayment: async () => { confirmations++; return { confirmed: true }; },
      },
      orderNotificationService: { deliverPaywayPaymentNotification: async () => ({ ok: true }) },
    }, async service => {
      await service.runDueChecks({ now: new Date('2026-09-05T08:53:55Z') });
      if (registerWatch) service.watchOrder({ orderNo, orderValue: 198550, paymentState: 'awaiting_check' },
        { now: new Date('2026-09-05T09:00:00Z') });
      payments = [{ merchantOrderNo: orderNo, transactionId: 'TMN025656:45292363:198550',
        terminal: 'TMN025656', transactionAmount: 198550, transactionAtIso: '2026-09-05T08:50:06Z' }];
      await service.runDueChecks({ now: new Date('2026-09-05T09:00:30Z') });
      await service.runDueChecks({ now: new Date('2026-09-05T09:01:00Z') });
      assert.equal(confirmations, 1);
      assert.equal(service.loadState().watchedOrders[orderNo].imwebConfirmation.status, 'confirmed');
    });
  }
});

test('invalid tracking state is preserved instead of silently resetting it', async () => {
  const dataDir = createTempDataDir();
  const stateFile = path.join(dataDir, 'payway_payment_watch_state.json');
  const config = createConfig();
  await withMockedWatchService({ config, runtimePaths: { dataDir },
    paywayClient: { isEnabled: () => true, isConfigured: () => true },
    orderNotificationService: {},
  }, async service => {
    for (const invalid of ['{truncated', '{"watchedOrders":[]}']) {
      fs.writeFileSync(stateFile, invalid);
      assert.throws(() => service.watchOrder({ orderNo: '202609137271906', orderValue: 88063, paymentState: 'awaiting_check' }), /refusing to replace/);
      assert.equal(fs.readFileSync(stateFile, 'utf8'), invalid);
    }
  });
});

test('bank-transfer searches without Payway evidence expire silently and retain audit state', async () => {
  const dataDir = createTempDataDir();
  const warnings = [];
  fs.writeFileSync(path.join(dataDir, 'payway_payment_watch_state.json'), JSON.stringify({
    watchedOrders: { historical: { orderNo: 'historical', status: 'expired' } }, handledTransactions: {},
  }));
  await withMockedWatchService({ config: createConfig(), runtimePaths: { dataDir },
    paywayClient: { isEnabled: () => true, isConfigured: () => true },
    orderNotificationService: { deliverPaywayAttentionWarning: async payload => { warnings.push(payload); return { ok: true }; } },
  }, async service => {
    service.watchOrder({ orderNo: '202609137271906', orderValue: 88063, paymentState: 'awaiting_check' },
      { now: new Date('2026-09-13T04:43:03Z') });
    await service.runDueChecks({ now: new Date('2026-09-13T05:44:00Z') });
    await service.runDueChecks({ now: new Date('2026-09-13T05:45:00Z') });
    assert.deepEqual(warnings, []);
    assert.equal(service.loadState().watchedOrders['202609137271906'].status, 'expired');
    assert.ok(service.loadState().watchedOrders['202609137271906'].attentionRequiredAt);
  });
});

test('bank-transfer placeholder with a detected Payway payment still warns once after restart', async () => {
  const dataDir = createTempDataDir();
  const warnings = [];
  fs.writeFileSync(path.join(dataDir, 'payway_payment_watch_state.json'), JSON.stringify({
    watchedOrders: {
      directBank: { orderNo: 'directBank', status: 'expired', attentionRequiredAt: '2026-09-13T05:00:00Z',
        orderResult: { paymentChannel: 'bank_transfer' } },
      paywayCard: { orderNo: 'paywayCard', status: 'completion_failed', attentionRequiredAt: '2026-09-13T05:00:00Z',
        orderResult: { paymentChannel: 'bank_transfer' }, matchedPayment: { transactionId: 'approval-1', approvedAmount: 88063 } },
    }, handledTransactions: {},
  }));
  await withMockedWatchService({ config: createConfig(), runtimePaths: { dataDir },
    paywayClient: { isEnabled: () => true, isConfigured: () => true },
    orderNotificationService: { deliverPaywayAttentionWarning: async payload => { warnings.push(payload); return { ok: true }; } },
  }, async service => {
    await service.runDueChecks({ now: new Date('2026-09-13T05:44:00Z') });
    await service.runDueChecks({ now: new Date('2026-09-13T05:45:00Z') });
    assert.deepEqual(warnings, [{ orderNo: 'paywayCard', reason: 'completion_failed', paymentDetected: true }]);
  });
});

test('direct replay preserves cancelled-order, amount, duplicate-payment and age guards', async () => {
  const dataDir = createTempDataDir();
  const config = createConfig();
  config.payway.autoConfirmImwebPayment = true;
  const warnings = [];
  const payment = (orderNo, transactionId, time = '2026-09-13T04:38:04Z') => ({
    transactionId, merchantOrderNo: orderNo, transactionAmount: 88063, transactionAtIso: time, terminal: 'TMN025656',
  });
  await withMockedWatchService({ config, runtimePaths: { dataDir },
    paywayClient: { isEnabled: () => true, isConfigured: () => true,
      isApprovedPaywayPayment: () => true, fetchPaymentHistory: async () => [
        payment('202609130001', 'cancelled'), payment('202609130002', 'wrong-amount'),
        payment('202609130003', 'duplicate-one'), payment('202609130003', 'duplicate-two'),
        payment('202609120001', 'too-old', '2026-09-12T01:00:00Z'),
      ] },
    imwebClient: {
      getOrder: async orderNo => {
        assert.ok(['202609130001', '202609130002'].includes(orderNo));
        return { orderNo, totalPrice: 99000, orderStatus: orderNo === '202609130001' ? 'CANCEL_COMPLETE' : 'ORDER_WAIT',
          payments: [{ method: 'BANKTRANSFER', paymentStatus: 'PAYMENT_PREPARATION' }] };
      },
      confirmBankTransferPayment: async () => assert.fail('unsafe Imweb confirmation'),
    },
    orderNotificationService: {
      deliverPaywayPaymentNotification: async () => assert.fail('unsafe completion notification'),
      deliverPaywayAttentionWarning: async payload => { warnings.push(payload); return { ok: true }; },
    },
  }, async service => {
    await service.runDueChecks({ now: new Date('2026-09-13T04:50:00Z') });
    await service.runDueChecks({ now: new Date('2026-09-13T04:51:00Z') });
    const handled = service.loadState().handledTransactions;
    assert.equal(handled.cancelled.reason, 'imweb_order_cancelled_or_closed');
    assert.equal(handled['wrong-amount'].reason, 'payway_imweb_amount_mismatch');
    assert.equal(handled['duplicate-one'].reason, 'multiple_payway_payments_for_order');
    assert.equal(handled['too-old'], undefined);
    assert.equal(warnings.length, 4);
  });
});

test('failed atomic replacement leaves the previous tracking file intact', async () => {
  const dataDir = createTempDataDir();
  const stateFile = path.join(dataDir, 'payway_payment_watch_state.json');
  await withMockedWatchService({ config: createConfig(), runtimePaths: { dataDir },
    paywayClient: { isEnabled: () => true, isConfigured: () => true }, orderNotificationService: {},
  }, async service => {
    const order = { orderNo: '202609137271906', orderValue: 88063, paymentState: 'awaiting_check' };
    service.watchOrder(order);
    const before = fs.readFileSync(stateFile, 'utf8');
    const rename = fs.renameSync;
    try {
      fs.renameSync = () => { throw new Error('simulated disk failure'); };
      assert.throws(() => service.watchOrder({ ...order, orderNo: '202609130002' }), /simulated disk failure/);
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  });
});

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
          merchantOrderNo: '202603150001',
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
          merchantOrderNo: '202606020001',
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
          merchantOrderNo: '202606020002',
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
          merchantOrderNo: '202606020003',
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
          merchantOrderNo: '202605252918860',
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
          merchantOrderNo: '202605252918861',
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

test('Payway watcher uses the exact merchant order number instead of amount-only matching', async () => {
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
          merchantOrderNo: '202605252918862',
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

    assert.equal(result.ok, true);
    assert.equal(result.detected, 1);
    assert.equal(result.delivered, 1);
    assert.equal(result.ambiguousMatches, 0);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].result.orderNo, '202605252918862');

    const state = service.loadState();
    assert.equal(state.watchedOrders['202605252918862'].status, 'paid');
    assert.equal(state.watchedOrders['202605252918863'].status, 'watching');
    assert.equal(state.watchedOrders['202605252918863'].lastPollError, null);
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
          merchantOrderNo: '202605252918864',
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
          merchantOrderNo: '202605252918864',
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
            merchantOrderNo: '202605252918865',
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
    merchantOrderNo: '202603150001',
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
      deliverPaywayPaymentNotification: async (result, matchedPayment, options) => {
        deliveries.push({ result, payment: matchedPayment, options });
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
          merchantOrderNo: '202605208943494',
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
    merchantOrderNo: '202605210303073',
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

test('Payway watcher confirms a uniquely matched card payment in Imweb before completing the workflow', async () => {
  const dataDir = createTempDataDir();
  const confirmations = [];
  const deliveries = [];
  const config = createConfig();
  config.payway.autoConfirmImwebPayment = true;
  const payment = {
    transactionId: 'TMN009889:55667788:2026-07-23 15:50:20:245000',
    merchantOrderNo: '202607237401269',
    transactionAt: '2026-07-23 15:50:20',
    transactionAtIso: '2026-07-23T06:50:20.000Z',
    status: '승인',
    terminal: 'TMN009889',
    approvalNo: '55667788',
    transactionAmount: 245000,
    approvedAmount: 245000,
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
    imwebClient: {
      confirmBankTransferPayment: async orderNo => {
        confirmations.push(orderNo);
        return { confirmed: true, alreadyConfirmed: false };
      },
    },
    orderNotificationService: {
      deliverPaywayPaymentNotification: async (result, matchedPayment, options) => {
        deliveries.push({ result, payment: matchedPayment, options });
        return { ok: true };
      },
    },
  }, async service => {
    service.watchOrder({
      orderNo: '202607237401269',
      orderDate: '2026-07-23',
      customerName: '이현숙',
      orderValue: 245000,
      paymentState: 'awaiting_check',
      paymentMethod: 'BANKTRANSFER',
      productNames: ['코튼 블렌드 트렌치 재킷'],
    }, {
      now: new Date('2026-07-23T06:50:00.000Z'),
      messageId: 9001,
    });

    const result = await service.runDueChecks({
      now: new Date('2026-07-23T06:50:30.000Z'),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(confirmations, ['202607237401269']);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].options.imwebPaymentConfirmed, true);
    assert.ok(Number.isFinite(Date.parse(deliveries[0].options.imwebPaymentConfirmedAt)));
    const state = service.loadState();
    assert.equal(state.watchedOrders['202607237401269'].status, 'paid');
    assert.equal(state.watchedOrders['202607237401269'].imwebConfirmation.status, 'confirmed');
    assert.equal(state.watchedOrders['202607237401269'].imwebConfirmation.attempts, 1);
  });
});

test('Payway watcher does not repeat a successful Imweb write while retrying Telegram completion', async () => {
  const dataDir = createTempDataDir();
  let confirmationCalls = 0;
  let deliveryCalls = 0;
  const config = createConfig();
  config.payway.autoConfirmImwebPayment = true;
  const payment = {
    transactionId: 'TMN009889:99887766:2026-07-23 16:10:20:118000',
    merchantOrderNo: '202607230001',
    transactionAt: '2026-07-23 16:10:20',
    transactionAtIso: '2026-07-23T07:10:20.000Z',
    status: '승인',
    terminal: 'TMN009889',
    approvalNo: '99887766',
    transactionAmount: 118000,
    approvedAmount: 118000,
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
    imwebClient: {
      confirmBankTransferPayment: async () => {
        confirmationCalls += 1;
        return { confirmed: true, alreadyConfirmed: false };
      },
    },
    orderNotificationService: {
      deliverPaywayPaymentNotification: async () => {
        deliveryCalls += 1;
        return deliveryCalls === 1
          ? { ok: false, reason: 'edit_failed' }
          : { ok: true };
      },
    },
  }, async service => {
    service.watchOrder({
      orderNo: '202607230001',
      orderDate: '2026-07-23',
      customerName: '테스트',
      orderValue: 118000,
      paymentState: 'awaiting_check',
      paymentMethod: 'BANKTRANSFER',
      productNames: ['테스트 상품'],
    }, {
      now: new Date('2026-07-23T07:10:00.000Z'),
      messageId: 9002,
    });

    const first = await service.runDueChecks({
      now: new Date('2026-07-23T07:10:30.000Z'),
    });
    assert.equal(first.ok, false);
    assert.equal(confirmationCalls, 1);
    assert.equal(service.loadState().watchedOrders['202607230001'].status, 'payment_detected');

    const second = await service.runDueChecks({
      now: new Date('2026-07-23T07:11:00.000Z'),
    });
    assert.equal(second.ok, true);
    assert.equal(confirmationCalls, 1);
    assert.equal(deliveryCalls, 2);
    assert.equal(service.loadState().watchedOrders['202607230001'].status, 'paid');
  });
});

test('Payway watcher keeps the workflow pending when Imweb confirmation fails', async () => {
  const dataDir = createTempDataDir();
  const deliveries = [];
  const config = createConfig();
  config.payway.autoConfirmImwebPayment = true;

  await withMockedWatchService({
    config,
    runtimePaths: { dataDir },
    paywayClient: {
      isEnabled: () => true,
      isConfigured: () => true,
      isApprovedPaywayPayment: payment => payment.status === '승인' && payment.transactionAmount > 0,
      fetchPaymentHistory: async () => [{
        transactionId: 'TMN009889:11223344:2026-07-23 16:30:20:99000',
        merchantOrderNo: '202607230002',
        transactionAt: '2026-07-23 16:30:20',
        transactionAtIso: '2026-07-23T07:30:20.000Z',
        status: '승인',
        terminal: 'TMN009889',
        approvalNo: '11223344',
        transactionAmount: 99000,
        approvedAmount: 99000,
        cancelAmount: 0,
      }],
    },
    imwebClient: {
      confirmBankTransferPayment: async () => {
        throw new Error('30103: insufficient permission');
      },
    },
    orderNotificationService: {
      deliverPaywayPaymentNotification: async (_result, _payment, options) => {
        deliveries.push(options);
        return { ok: true };
      },
    },
  }, async service => {
    service.watchOrder({
      orderNo: '202607230002',
      orderDate: '2026-07-23',
      customerName: '테스트',
      orderValue: 99000,
      paymentState: 'awaiting_check',
      paymentMethod: 'BANKTRANSFER',
      productNames: ['테스트 상품'],
    }, {
      now: new Date('2026-07-23T07:30:00.000Z'),
      messageId: 9003,
    });

    const result = await service.runDueChecks({
      now: new Date('2026-07-23T07:30:30.000Z'),
    });

    assert.equal(result.ok, false);
    const state = service.loadState();
    assert.equal(state.watchedOrders['202607230002'].status, 'payment_detected');
    assert.equal(state.watchedOrders['202607230002'].imwebConfirmation.status, 'failed');
    assert.match(state.watchedOrders['202607230002'].lastDeliveryError, /30103/);
    assert.equal(deliveries.length, 0, 'only the attention warning is eligible before confirmation succeeds');
  });
});

test('Payway direct monitor confirms an exact Payway card order without waiting for an Imweb scan', async () => {
  const dataDir = createTempDataDir();
  const operations = [];
  const config = createConfig();
  config.payway.autoConfirmImwebPayment = true;

  await withMockedWatchService({
    config,
    runtimePaths: { dataDir },
    paywayClient: {
      isEnabled: () => true,
      isConfigured: () => true,
      isApprovedPaywayPayment: payment => (
        payment.status === '승인'
        && payment.merchantOrderNo
        && payment.approvalNo
        && payment.maskedCardNumber
      ),
      fetchPaymentHistory: async () => [{
        transactionId: 'TMN009889:44332211:2026-07-23 17:00:20:245000',
        merchantOrderNo: '202607237401269',
        transactionAt: '2026-07-23 17:00:20',
        transactionAtIso: '2026-07-23T08:00:20.000Z',
        status: '승인',
        terminal: 'TMN009889',
        approvalNo: '44332211',
        maskedCardNumber: '1234********5678',
        transactionAmount: 245000,
        cancelAmount: 0,
      }],
    },
    imwebClient: {
      getOrder: async orderNo => {
        operations.push(`lookup:${orderNo}`);
        return {
          orderNo,
          wtime: '2026-07-23T07:59:50.000Z',
          ordererName: '이현숙',
          totalPrice: 245000,
          totalPaymentPrice: 245000,
          payments: [{
            paidPrice: 245000,
            paymentStatus: 'PAYMENT_PREPARATION',
            method: 'BANKTRANSFER',
          }],
        };
      },
      confirmBankTransferPayment: async orderNo => {
        operations.push(`confirm:${orderNo}`);
        return { confirmed: true, alreadyConfirmed: false };
      },
    },
    orderNotificationService: {
      deliverPaywayPaymentNotification: async result => {
        operations.push(`notify:${result.orderNo}`);
        return { ok: true };
      },
    },
  }, async service => {
    const result = await service.runDueChecks({
      now: new Date('2026-07-23T08:00:30.000Z'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.activeWatches, 0);
    assert.equal(result.detected, 1);
    assert.equal(result.delivered, 1);
    assert.equal(result.directManualReview, 0);
    assert.deepEqual(operations, [
      'lookup:202607237401269',
      'confirm:202607237401269',
      'notify:202607237401269',
    ]);
    assert.equal(service.loadState().watchedOrders['202607237401269'].status, 'paid');
  });
});

test('Payway direct monitor ignores approvals without an exact Imweb order reference', async () => {
  const dataDir = createTempDataDir();
  let imwebCalls = 0;
  const config = createConfig();
  config.payway.autoConfirmImwebPayment = true;

  await withMockedWatchService({
    config,
    runtimePaths: { dataDir },
    paywayClient: {
      isEnabled: () => true,
      isConfigured: () => true,
      isApprovedPaywayPayment: () => true,
      fetchPaymentHistory: async () => [{
        transactionId: 'TMN009889:55443322:2026-07-23 17:10:20:245000',
        merchantOrderNo: '',
        transactionAtIso: '2026-07-23T08:10:20.000Z',
        status: '승인',
        approvalNo: '55443322',
        maskedCardNumber: '1234********5678',
        transactionAmount: 245000,
      }],
    },
    imwebClient: {
      getOrder: async () => {
        imwebCalls += 1;
        throw new Error('must not look up an unlinked payment');
      },
      confirmBankTransferPayment: async () => {
        imwebCalls += 1;
        throw new Error('must not confirm an unlinked payment');
      },
    },
    orderNotificationService: {
      deliverPaywayPaymentNotification: async () => {
        throw new Error('must not notify an unlinked payment');
      },
    },
  }, async service => {
    const result = await service.runDueChecks({
      now: new Date('2026-07-23T08:10:30.000Z'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.detected, 0);
    assert.equal(result.delivered, 0);
    assert.equal(imwebCalls, 0);
  });
});

test('Payway watcher does not watch non-bank-transfer Imweb orders', async () => {
  const dataDir = createTempDataDir();

  await withMockedWatchService({
    config: createConfig(),
    runtimePaths: { dataDir },
    paywayClient: {
      isEnabled: () => true,
      isConfigured: () => true,
      isApprovedPaywayPayment: () => true,
      fetchPaymentHistory: async () => [],
    },
    orderNotificationService: {},
  }, async service => {
    const result = service.watchOrder({
      orderNo: '202607230003',
      orderValue: 99000,
      paymentState: 'awaiting_check',
      paymentChannel: 'card',
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'not_pending_bank_transfer');
    assert.deepEqual(service.loadState().watchedOrders, {});
  });
});
