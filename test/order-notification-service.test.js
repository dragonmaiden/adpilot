const test = require('node:test');
const assert = require('node:assert/strict');

async function withMockedOrderNotificationService(overrides, run) {
  const servicePath = require.resolve('../server/services/orderNotificationService');
  const dependencyEntries = [
    [require.resolve('../server/modules/telegram'), overrides.telegram],
    [require.resolve('../server/services/cogsAutofillService'), overrides.cogsAutofillService],
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

test('deliverNewOrderNotification stores the public Telegram message id for later checklist updates', async () => {
  const sentMessages = [];
  const recordedDeliveries = [];

  await withMockedOrderNotificationService({
    telegram: {
      sendMessage: async (text, parseMode = 'HTML', options = {}) => {
        sentMessages.push({ text, parseMode, options });
        if (sentMessages.length === 1) {
          return { ok: true, result: { message_id: 4321 } };
        }
        return { ok: true, result: { message_id: 4322 } };
      },
    },
    cogsAutofillService: {
      getNotifiedOrderMetadata: () => null,
      buildNewOrderNotification: result => `new:${result.orderNo}`,
      recordOrderNotificationDelivery: (orderNo, metadata) => {
        recordedDeliveries.push({ orderNo, metadata });
        return { orderNo, ...metadata };
      },
    },
  }, async service => {
    const result = await service.deliverNewOrderNotification({
      orderNo: '202603150001',
      paymentState: 'awaiting_check',
      orderDate: '2026-03-15',
      notificationSource: 'scan_backstop',
    });

    assert.equal(result.messageId, 4321);
    assert.equal(sentMessages.length, 1);
    assert.deepEqual(recordedDeliveries, [
      {
        orderNo: '202603150001',
        metadata: {
          messageId: 4321,
          notificationStage: 'payment_pending',
          paymentState: 'awaiting_check',
          orderDate: '2026-03-15',
          source: 'scan_backstop',
        },
      },
    ]);
  });
});

test('concurrent scan and Payway delivery keep one canonical order card', async () => {
  const sentMessages = [];
  const editedMessages = [];
  let metadata = null;
  let releaseSend;
  let markSendStarted;
  const sendGate = new Promise(resolve => {
    releaseSend = resolve;
  });
  const sendStarted = new Promise(resolve => {
    markSendStarted = resolve;
  });

  await withMockedOrderNotificationService({
    telegram: {
      sendMessage: async text => {
        sentMessages.push(text);
        markSendStarted();
        await sendGate;
        return { ok: true, result: { message_id: 4321 } };
      },
      editMessageText: async (messageId, text) => {
        editedMessages.push({ messageId, text });
        return { ok: true, result: { message_id: messageId } };
      },
    },
    cogsAutofillService: {
      getNotifiedOrderMetadata: () => metadata,
      buildNewOrderNotification: result => [
        result.orderNo,
        result.notificationStage,
        result.paymentReceived,
        result.imwebPaymentConfirmed,
      ].join(':'),
      recordOrderNotificationDelivery: (orderNo, patch) => {
        metadata = { ...(metadata || {}), orderNo, ...patch };
        return metadata;
      },
      markOrderNotificationCompleted: (orderNo, patch) => {
        metadata = {
          ...(metadata || {}),
          orderNo,
          notificationStage: 'payment_confirmed',
          ...patch,
        };
        return metadata;
      },
    },
  }, async service => {
    const pendingDelivery = service.deliverNewOrderNotification({
      orderNo: '202607232920239',
      orderDate: '2026-07-23',
      paymentState: 'awaiting_check',
      notificationSource: 'scan_backstop',
    });
    await sendStarted;
    const paywayDelivery = service.deliverPaywayPaymentNotification({
      orderNo: '202607232920239',
      orderDate: '2026-07-23',
      orderValue: 93600,
      notificationSource: 'payway_direct',
    }, {
      transactionId: 'payway:tmn:00207109:93600',
      transactionAt: '2026-07-23 23:30:28',
      transactionAmount: 93600,
      approvalNo: '00207109',
      maskedCardNumber: '516526****651*',
    }, {
      imwebPaymentConfirmed: true,
      imwebPaymentConfirmedAt: '2026-07-23T14:30:29.000Z',
    });
    releaseSend();

    const [pendingResult, paidResult] = await Promise.all([pendingDelivery, paywayDelivery]);
    assert.equal(pendingResult.messageId, 4321);
    assert.equal(paidResult.messageId, 4321);
    assert.equal(sentMessages.length, 1);
    assert.deepEqual(editedMessages, [{
      messageId: 4321,
      text: '202607232920239:payment_confirmed:true:true',
    }]);
    assert.equal(metadata.notificationStage, 'payment_confirmed');
    assert.equal(metadata.paywayApprovalNo, '00207109');
  });
});

test('completeExistingOrderNotification edits the original alert and marks the checklist as completed', async () => {
  const editedMessages = [];
  const completionMarks = [];

  await withMockedOrderNotificationService({
    telegram: {
      editMessageText: async (messageId, text) => {
        editedMessages.push({ messageId, text });
        return { ok: true, result: { message_id: messageId } };
      },
    },
    cogsAutofillService: {
      getNotifiedOrderMetadata: () => ({
        orderNo: '202603150001',
        messageId: 4321,
        notificationStage: 'payment_pending',
      }),
      buildNewOrderNotification: result => `completed:${result.orderNo}:${result.notificationStage}:${result.sheetName}`,
      markOrderNotificationCompleted: (orderNo, metadata) => {
        completionMarks.push({ orderNo, metadata });
        return { orderNo, ...metadata };
      },
    },
  }, async service => {
    const result = await service.completeExistingOrderNotification({
      orderNo: '202603150001',
      paymentState: 'paid',
      sheetName: '3월 주문',
      rowCount: 2,
    });

    assert.equal(result.updated, true);
    assert.deepEqual(editedMessages, [
      {
        messageId: 4321,
        text: 'completed:202603150001:payment_confirmed:3월 주문',
      },
    ]);
    assert.deepEqual(completionMarks, [
      {
        orderNo: '202603150001',
        metadata: {
          messageId: 4321,
          paymentState: 'paid',
          sheetName: '3월 주문',
          rowCount: 2,
          imwebPaymentConfirmedAt: completionMarks[0].metadata.imwebPaymentConfirmedAt,
          cogsComplete: false,
          cogsCostComplete: false,
          cogsShippingComplete: false,
          cogsCompletedAt: null,
        },
      },
    ]);
    assert.match(completionMarks[0].metadata.imwebPaymentConfirmedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('deliverPaywayPaymentNotification updates only the original order card', async () => {
  const sentMessages = [];
  const editedMessages = [];
  const completionMarks = [];

  await withMockedOrderNotificationService({
    telegram: {
      sendMessage: async (text, parseMode = 'HTML', options = {}) => {
        sentMessages.push({ text, parseMode, options });
        return { ok: true, result: { message_id: 8801 } };
      },
      editMessageText: async (messageId, text) => {
        editedMessages.push({ messageId, text });
        return { ok: true, result: { message_id: messageId } };
      },
    },
    cogsAutofillService: {
      getNotifiedOrderMetadata: () => ({
        orderNo: '202603150001',
        messageId: 4321,
        notificationStage: 'payment_pending',
      }),
      buildNewOrderNotification: result => [
        result.orderNo,
        result.notificationStage,
        result.paymentSource,
        result.paymentReceived,
        result.imwebPaymentConfirmed,
        result.paywayApprovalNo,
      ].join(':'),
      markOrderNotificationCompleted: (orderNo, metadata) => {
        completionMarks.push({ orderNo, metadata });
        return { orderNo, ...metadata };
      },
    },
  }, async service => {
    const result = await service.deliverPaywayPaymentNotification({
      orderNo: '202603150001',
      orderValue: 111000,
    }, {
      transactionId: 'payway:tmn:appr:111000',
      transactionAt: '2026-03-15 12:30:00',
      transactionAmount: 111000,
      approvalNo: '12345678',
      maskedCardNumber: '1234********5678',
    }, {
      imwebPaymentConfirmed: true,
      imwebPaymentConfirmedAt: '2026-03-15T03:30:01.000Z',
    });

    assert.equal(result.ok, true);
    assert.equal(result.kind, 'payway_order_card_updated');
    assert.equal(sentMessages.length, 0);
    assert.deepEqual(editedMessages, [
      {
        messageId: 4321,
        text: '202603150001:payment_confirmed:payway:true:true:12345678',
      },
    ]);
    assert.equal(completionMarks.length, 1);
    assert.equal(completionMarks[0].orderNo, '202603150001');
    assert.deepEqual(completionMarks[0].metadata, {
      messageId: 4321,
      notificationStage: 'payment_confirmed',
      paymentState: 'paid',
      paymentSource: 'payway',
      paywayPaymentReceivedAt: completionMarks[0].metadata.paywayPaymentReceivedAt,
      paywayTransactionId: 'payway:tmn:appr:111000',
      paywayApprovedAt: '2026-03-15 12:30:00',
      paywayApprovalNo: '12345678',
      paywayMaskedCardNumber: '1234********5678',
      paywayAmount: 111000,
      orderDate: undefined,
      cogsComplete: false,
      cogsCostComplete: false,
      cogsShippingComplete: false,
      cogsCompletedAt: null,
      source: 'payway_direct',
      imwebPaymentConfirmedAt: '2026-03-15T03:30:01.000Z',
    });
    assert.match(completionMarks[0].metadata.paywayPaymentReceivedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('deliverPaywayPaymentNotification skips an already-current single order card', async () => {
  const sentMessages = [];
  const editedMessages = [];

  await withMockedOrderNotificationService({
    telegram: {
      sendMessage: async (...args) => {
        sentMessages.push(args);
        return { ok: true, result: { message_id: 9900 } };
      },
      editMessageText: async (messageId, text) => {
        editedMessages.push({ messageId, text });
        return { ok: true, result: { message_id: messageId } };
      },
    },
    cogsAutofillService: {
      getNotifiedOrderMetadata: () => ({
        orderNo: '202603150001',
        messageId: 4321,
        notificationStage: 'payment_confirmed',
        paywayTransactionId: 'payway:tmn:appr:111000',
        imwebPaymentConfirmedAt: '2026-03-15T03:30:01.000Z',
      }),
      buildNewOrderNotification: () => {
        throw new Error('already-current order card should not be rebuilt');
      },
      markOrderNotificationCompleted: () => ({}),
    },
  }, async service => {
    const result = await service.deliverPaywayPaymentNotification({
      orderNo: '202603150001',
      orderValue: 111000,
    }, {
      transactionId: 'payway:tmn:appr:111000',
      transactionAmount: 111000,
    }, {
      imwebPaymentConfirmed: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.kind, 'payway_order_card_already_current');
    assert.equal(sentMessages.length, 0);
    assert.equal(editedMessages.length, 0);
  });
});

test('deliverPaywayPaymentNotification creates one completed order card when no pending card exists yet', async () => {
  const sentMessages = [];
  const completionMarks = [];

  await withMockedOrderNotificationService({
    telegram: {
      sendMessage: async text => {
        sentMessages.push(text);
        return { ok: true, result: { message_id: 9901 } };
      },
    },
    cogsAutofillService: {
      getNotifiedOrderMetadata: () => null,
      buildNewOrderNotification: result => [
        result.orderNo,
        result.notificationStage,
        result.paymentReceived,
        result.imwebPaymentConfirmed,
      ].join(':'),
      markOrderNotificationCompleted: (orderNo, metadata) => {
        completionMarks.push({ orderNo, metadata });
        return { orderNo, ...metadata };
      },
    },
  }, async service => {
    const result = await service.deliverPaywayPaymentNotification({
      orderNo: '202607237401269',
      orderValue: 245000,
    }, {
      transactionId: 'payway:tmn:approval:245000',
      transactionAt: '2026-07-23 17:00:20',
      transactionAmount: 245000,
      approvalNo: '44332211',
      maskedCardNumber: '1234********5678',
    }, {
      imwebPaymentConfirmed: true,
      imwebPaymentConfirmedAt: '2026-07-23T08:00:21.000Z',
    });

    assert.equal(result.ok, true);
    assert.equal(result.kind, 'payway_order_card_created');
    assert.equal(result.messageId, 9901);
    assert.deepEqual(sentMessages, ['202607237401269:payment_confirmed:true:true']);
    assert.equal(completionMarks.length, 1);
    assert.equal(completionMarks[0].metadata.messageId, 9901);
    assert.equal(completionMarks[0].metadata.paywayTransactionId, 'payway:tmn:approval:245000');
    assert.equal(completionMarks[0].metadata.imwebPaymentConfirmedAt, '2026-07-23T08:00:21.000Z');
  });
});

test('Payway completion adds COGS to the same order card after the sheet sync', async () => {
  const sentMessages = [];
  const editedMessages = [];
  let metadata = {
    orderNo: '202607232920239',
    messageId: 4321,
    notificationStage: 'payment_pending',
  };

  await withMockedOrderNotificationService({
    telegram: {
      sendMessage: async text => {
        sentMessages.push(text);
        return { ok: true, result: { message_id: 9901 } };
      },
      editMessageText: async (messageId, text) => {
        editedMessages.push({ messageId, text });
        return { ok: true, result: { message_id: messageId } };
      },
    },
    cogsAutofillService: {
      getNotifiedOrderMetadata: () => metadata,
      buildNewOrderNotification: result => [
        result.notificationStage,
        result.paymentSource,
        result.sheetName || 'no-cogs',
        result.paywayApprovalNo,
        result.cogsComplete,
      ].join(':'),
      markOrderNotificationCompleted: (orderNo, patch) => {
        metadata = {
          ...metadata,
          orderNo,
          notificationStage: 'payment_confirmed',
          ...patch,
        };
        return metadata;
      },
    },
  }, async service => {
    const paymentResult = await service.deliverPaywayPaymentNotification({
      orderNo: '202607232920239',
      orderValue: 93600,
    }, {
      transactionId: 'payway:tmn:00207109:93600',
      transactionAmount: 93600,
      approvalNo: '00207109',
    }, {
      imwebPaymentConfirmed: true,
      imwebPaymentConfirmedAt: '2026-07-23T14:30:29.000Z',
    });
    const cogsResult = await service.deliverPaidOrderNotification({
      orderNo: '202607232920239',
      paymentState: 'paid',
      sheetName: 'July',
      rowCount: 1,
      cogsComplete: false,
      cogsCostComplete: true,
      cogsShippingComplete: false,
    });
    const completedCogsResult = await service.deliverPaidOrderNotification({
      orderNo: '202607232920239',
      paymentState: 'paid',
      sheetName: 'July',
      rowCount: 1,
      cogsComplete: true,
      cogsCostComplete: true,
      cogsShippingComplete: true,
    });

    assert.equal(paymentResult.ok, true);
    assert.equal(cogsResult.updated, true);
    assert.equal(completedCogsResult.updated, true);
    assert.equal(sentMessages.length, 0);
    assert.deepEqual(editedMessages, [
      {
        messageId: 4321,
        text: 'payment_confirmed:payway:no-cogs:00207109:false',
      },
      {
        messageId: 4321,
        text: 'payment_confirmed:payway:July:00207109:false',
      },
      {
        messageId: 4321,
        text: 'payment_confirmed:payway:July:00207109:true',
      },
    ]);
    assert.equal(metadata.sheetName, 'July');
    assert.equal(metadata.paywayApprovalNo, '00207109');
    assert.equal(metadata.cogsComplete, true);
    assert.equal(metadata.cogsCostComplete, true);
    assert.equal(metadata.cogsShippingComplete, true);
    assert.match(metadata.cogsCompletedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('deliverPaywayAmbiguousPaymentWarning sends the manual-check alert', async () => {
  const sentMessages = [];

  await withMockedOrderNotificationService({
    telegram: {
      sendMessage: async (text, parseMode = 'HTML', options = {}) => {
        sentMessages.push({ text, parseMode, options });
        return { ok: true, result: { message_id: 9001 } };
      },
    },
    cogsAutofillService: {
      buildPaywayAmbiguousPaymentNotification: payload => `ambiguous:${payload.reason}:${payload.orderNos.join(',')}`,
    },
  }, async service => {
    const result = await service.deliverPaywayAmbiguousPaymentWarning({
      reason: 'ambiguous_multiple_order_watches',
      orderNos: ['202605252918862', '202605252918863'],
    });

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 9001);
    assert.deepEqual(sentMessages.map(message => message.text), [
      'ambiguous:ambiguous_multiple_order_watches:202605252918862,202605252918863',
    ]);
  });
});

test('deliverPaidOrderNotification stays silent when an existing order card cannot be edited yet', async () => {
  const sentMessages = [];

  await withMockedOrderNotificationService({
    telegram: {
      editMessageText: async () => {
        throw new Error('should not edit without a stored message id');
      },
      sendMessage: async (text, parseMode = 'HTML', options = {}) => {
        sentMessages.push({ text, parseMode, options });
        return { ok: true, result: { message_id: sentMessages.length + 7000 } };
      },
    },
    cogsAutofillService: {
      getNotifiedOrderMetadata: () => ({
        orderNo: '202603150001',
        notificationStage: 'payment_pending',
      }),
      buildNewOrderNotification: result => `completed:${result.orderNo}:${result.notificationStage}`,
    },
  }, async service => {
    const result = await service.deliverPaidOrderNotification({
      orderNo: '202603150001',
      paymentState: 'paid',
      sheetName: '3월 주문',
      rowCount: 1,
    });

    assert.equal(result.kind, 'awaiting_existing_update');
    assert.equal(result.reason, 'missing_message_id');
    assert.equal(sentMessages.length, 0);
  });
});

test('deliverPaidOrderNotification stays silent when the order was already marked completed without a stored message id', async () => {
  const sentMessages = [];

  await withMockedOrderNotificationService({
    telegram: {
      sendMessage: async (...args) => {
        sentMessages.push(args);
        return { ok: true, result: { message_id: 1 } };
      },
    },
    cogsAutofillService: {
      getNotifiedOrderMetadata: () => ({
        orderNo: '202603150001',
        notificationStage: 'payment_confirmed',
        sheetName: '3월 주문',
        cogsComplete: false,
        cogsCostComplete: false,
        cogsShippingComplete: false,
      }),
      buildAutofillNotification: result => `paid:${result.orderNo}`,
    },
  }, async service => {
    const result = await service.deliverPaidOrderNotification({
      orderNo: '202603150001',
      paymentState: 'paid',
      sheetName: '3월 주문',
      rowCount: 1,
    });

    assert.equal(result.kind, 'already_completed');
    assert.equal(sentMessages.length, 0);
  });
});

test('deliverPaidOrderNotification still falls back to a completed card when no prior order alert exists', async () => {
  const sentMessages = [];
  const completionMarks = [];

  await withMockedOrderNotificationService({
    telegram: {
      sendMessage: async (text, parseMode = 'HTML', options = {}) => {
        sentMessages.push({ text, parseMode, options });
        return { ok: true, result: { message_id: sentMessages.length + 7000 } };
      },
    },
    cogsAutofillService: {
      getNotifiedOrderMetadata: () => null,
      buildNewOrderNotification: result => `completed:${result.orderNo}:${result.notificationStage}`,
      markOrderNotificationCompleted: (orderNo, metadata) => {
        completionMarks.push({ orderNo, metadata });
        return { orderNo, ...metadata };
      },
    },
  }, async service => {
    const result = await service.deliverPaidOrderNotification({
      orderNo: '202603150001',
      paymentState: 'paid',
      sheetName: '3월 주문',
      rowCount: 1,
    });

    assert.equal(result.kind, 'sent_paid_fallback');
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].text, 'completed:202603150001:payment_confirmed');
    assert.equal(completionMarks.length, 1);
    assert.equal(completionMarks[0].orderNo, '202603150001');
    assert.deepEqual(completionMarks[0].metadata, {
      messageId: 7001,
      paymentState: 'paid',
      imwebPaymentConfirmedAt: completionMarks[0].metadata.imwebPaymentConfirmedAt,
      sheetName: '3월 주문',
      rowCount: 1,
      source: 'cogs_autofill_fallback',
      cogsComplete: false,
      cogsCostComplete: false,
      cogsShippingComplete: false,
      cogsCompletedAt: null,
    });
    assert.match(completionMarks[0].metadata.imwebPaymentConfirmedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('closeExistingOrderNotification edits the original alert when an order is later cancelled', async () => {
  const editedMessages = [];
  const closedMarks = [];

  await withMockedOrderNotificationService({
    telegram: {
      editMessageText: async (messageId, text) => {
        editedMessages.push({ messageId, text });
        return { ok: true, result: { message_id: messageId } };
      },
    },
    cogsAutofillService: {
      getNotifiedOrderMetadata: () => ({
        orderNo: '202603150009',
        messageId: 229,
        notificationStage: 'payment_pending',
        source: 'scan_backstop',
        orderDate: '2026-03-15',
      }),
      buildNewOrderNotification: result => `closed:${result.orderNo}:${result.notificationStage}:${result.paymentState}`,
      markOrderNotificationClosed: (orderNo, metadata) => {
        closedMarks.push({ orderNo, metadata });
        return { orderNo, ...metadata };
      },
    },
  }, async service => {
    const result = await service.closeExistingOrderNotification({
      orderNo: '202603150009',
      paymentState: 'cancelled',
      orderDate: '2026-03-15',
    });

    assert.equal(result.updated, true);
    assert.deepEqual(editedMessages, [
      {
        messageId: 229,
        text: 'closed:202603150009:order_closed:cancelled',
      },
    ]);
    assert.deepEqual(closedMarks, [
      {
        orderNo: '202603150009',
        metadata: {
          messageId: 229,
          paymentState: 'cancelled',
          orderDate: '2026-03-15',
          source: 'scan_backstop',
        },
      },
    ]);
  });
});

test('deliverClosedOrderNotification stays silent but marks the order closed when no message id was stored', async () => {
  const sentMessages = [];
  const closedMarks = [];

  await withMockedOrderNotificationService({
    telegram: {
      sendMessage: async (...args) => {
        sentMessages.push(args);
        return { ok: true, result: { message_id: 1 } };
      },
    },
    cogsAutofillService: {
      getNotifiedOrderMetadata: () => ({
        orderNo: '202603150010',
        notificationStage: 'delivery_pending',
        source: 'scan_backstop',
        orderDate: '2026-03-15',
      }),
      markOrderNotificationClosed: (orderNo, metadata) => {
        closedMarks.push({ orderNo, metadata });
        return { orderNo, ...metadata };
      },
    },
  }, async service => {
    const result = await service.deliverClosedOrderNotification({
      orderNo: '202603150010',
      paymentState: 'cancelled',
      orderDate: '2026-03-15',
    });

    assert.equal(result.kind, 'marked_closed_without_message');
    assert.equal(sentMessages.length, 0);
    assert.deepEqual(closedMarks, [
      {
        orderNo: '202603150010',
        metadata: {
          paymentState: 'cancelled',
          orderDate: '2026-03-15',
          source: 'scan_backstop',
        },
      },
    ]);
  });
});
