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
        },
      },
    ]);
  });
});

test('deliverPaywayPaymentNotification sends one payment received message before completing the original card', async () => {
  const sentMessages = [];
  const editedMessages = [];
  const recordedDeliveries = [];
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
      buildPaywayPaymentReceivedNotification: (result, payment) => `payway:${result.orderNo}:${payment.transactionId}`,
      buildNewOrderNotification: result => `completed:${result.orderNo}:${result.notificationStage}:${result.paymentSource}`,
      recordOrderNotificationDelivery: (orderNo, metadata) => {
        recordedDeliveries.push({ orderNo, metadata });
        return { orderNo, ...metadata };
      },
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
    });

    assert.equal(result.ok, true);
    assert.equal(result.kind, 'payway_updated_existing');
    assert.deepEqual(sentMessages.map(message => message.text), ['payway:202603150001:payway:tmn:appr:111000']);
    assert.deepEqual(editedMessages, [
      {
        messageId: 4321,
        text: 'completed:202603150001:payment_confirmed:payway',
      },
    ]);
    assert.equal(recordedDeliveries.length, 1);
    assert.equal(recordedDeliveries[0].orderNo, '202603150001');
    assert.equal(recordedDeliveries[0].metadata.paywayPaymentReceivedMessageId, 8801);
    assert.equal(recordedDeliveries[0].metadata.paywayTransactionId, 'payway:tmn:appr:111000');
    assert.equal(recordedDeliveries[0].metadata.paymentSource, 'payway');
    assert.deepEqual(completionMarks, [
      {
        orderNo: '202603150001',
        metadata: {
          messageId: 4321,
          paymentState: 'paid',
          paymentSource: 'payway',
          paywayTransactionId: 'payway:tmn:appr:111000',
          paywayApprovedAt: '2026-03-15 12:30:00',
          sheetName: undefined,
          rowCount: undefined,
        },
      },
    ]);
  });
});

test('deliverPaywayPaymentNotification does not resend the payment received message for the same order', async () => {
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
        notificationStage: 'payment_pending',
        paywayPaymentReceivedMessageId: 8801,
      }),
      buildPaywayPaymentReceivedNotification: () => {
        throw new Error('payment received message should not be rebuilt');
      },
      buildNewOrderNotification: result => `completed:${result.orderNo}:${result.notificationStage}:${result.paymentSource}`,
      markOrderNotificationCompleted: () => ({}),
    },
  }, async service => {
    const result = await service.deliverPaywayPaymentNotification({
      orderNo: '202603150001',
      orderValue: 111000,
    }, {
      transactionId: 'payway:tmn:appr:111000',
      transactionAmount: 111000,
    });

    assert.equal(result.ok, true);
    assert.equal(sentMessages.length, 0);
    assert.equal(result.paymentMessage.reason, 'already_sent');
    assert.deepEqual(editedMessages, [
      {
        messageId: 4321,
        text: 'completed:202603150001:payment_confirmed:payway',
      },
    ]);
  });
});

test('deliverPaywayPaymentNotification completes from the Payway message when no pending card exists yet', async () => {
  const completionMarks = [];

  await withMockedOrderNotificationService({
    telegram: {
      sendMessage: async () => ({ ok: true, result: { message_id: 9901 } }),
    },
    cogsAutofillService: {
      getNotifiedOrderMetadata: () => null,
      buildPaywayPaymentReceivedNotification: result => `payway:${result.orderNo}`,
      recordOrderNotificationDelivery: () => ({}),
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
    });

    assert.equal(result.ok, true);
    assert.equal(result.kind, 'payway_completed_without_pending_card');
    assert.equal(result.completion.messageId, 9901);
    assert.deepEqual(completionMarks, [{
      orderNo: '202607237401269',
      metadata: {
        messageId: 9901,
        paymentState: 'paid',
        paymentSource: 'payway',
        paywayTransactionId: 'payway:tmn:approval:245000',
        paywayApprovedAt: '2026-07-23 17:00:20',
      },
    }]);
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
    assert.deepEqual(completionMarks, [
      {
        orderNo: '202603150001',
        metadata: {
          messageId: 7001,
          paymentState: 'paid',
          sheetName: '3월 주문',
          rowCount: 1,
        },
      },
    ]);
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
