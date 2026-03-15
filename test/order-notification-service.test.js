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
      buildAutofillPrivateNotification: result => `private:${result.orderNo}`,
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
    assert.equal(sentMessages.length, 2);
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
    assert.equal(sentMessages[1].options.protectContent, true);
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
      buildAutofillPrivateNotification: result => `private:${result.orderNo}`,
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
      buildAutofillPrivateNotification: result => `private:${result.orderNo}`,
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
      buildAutofillPrivateNotification: result => `private:${result.orderNo}`,
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
    assert.equal(sentMessages.length, 2);
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
    assert.equal(sentMessages[1].options.protectContent, true);
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
        source: 'webhook_new_order',
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
          source: 'webhook_new_order',
        },
      },
    ]);
  });
});
