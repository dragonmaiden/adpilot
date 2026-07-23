const telegram = require('../modules/telegram');
const cogsAutofillService = require('./cogsAutofillService');

function getTelegramMessageId(response) {
  const messageId = response?.result?.message_id;
  return Number.isFinite(Number(messageId)) ? Number(messageId) : null;
}

function nowIso() {
  return new Date().toISOString();
}

async function deliverNewOrderNotification(result) {
  const publicMessage = await telegram.sendMessage(cogsAutofillService.buildNewOrderNotification(result));
  const messageId = getTelegramMessageId(publicMessage);

  if (messageId && result?.orderNo) {
    cogsAutofillService.recordOrderNotificationDelivery(result.orderNo, {
      messageId,
      notificationStage: 'payment_pending',
      paymentState: result.paymentState,
      orderDate: result.orderDate,
      source: result.notificationSource || 'scan_backstop',
    });
  }

  return {
    publicMessage,
    messageId,
  };
}

function buildPaywayCompletionResult(result, payment = {}) {
  return {
    ...result,
    paymentState: 'paid',
    paymentLabel: result?.paymentLabel || 'Payway card approved',
    paymentMethod: result?.paymentMethod || 'Payway card',
    paymentSource: 'payway',
    paywayTransactionId: payment?.transactionId || result?.paywayTransactionId,
    paywayApprovedAt: payment?.transactionAt || payment?.transactionAtIso || result?.paywayApprovedAt,
  };
}

async function sendPaywayPaymentReceivedMessage(result, payment = {}) {
  if (!result?.orderNo) {
    return { ok: false, skipped: true, reason: 'missing_order_no' };
  }

  const metadata = cogsAutofillService.getNotifiedOrderMetadata(result.orderNo);
  if (metadata?.paywayPaymentReceivedMessageId) {
    return {
      ok: true,
      skipped: true,
      reason: 'already_sent',
      messageId: metadata.paywayPaymentReceivedMessageId,
    };
  }

  const response = await telegram.sendMessage(
    cogsAutofillService.buildPaywayPaymentReceivedNotification(result, payment)
  );
  const messageId = getTelegramMessageId(response);

  if (response?.ok && messageId) {
    cogsAutofillService.recordOrderNotificationDelivery(result.orderNo, {
      paywayPaymentReceivedMessageId: messageId,
      paywayPaymentReceivedAt: nowIso(),
      paywayTransactionId: payment?.transactionId || result?.paywayTransactionId || null,
      paymentSource: 'payway',
    });
  }

  return {
    ok: Boolean(response?.ok),
    response,
    messageId,
  };
}

async function completeExistingOrderNotification(result) {
  if (!result?.orderNo) {
    return { ok: false, updated: false, reason: 'missing_order_no' };
  }

  const metadata = cogsAutofillService.getNotifiedOrderMetadata(result.orderNo);
  if (!metadata) {
    return { ok: false, updated: false, reason: 'missing_notification' };
  }

  if (metadata?.notificationStage === 'payment_confirmed' && (!result?.sheetName || metadata.sheetName === result.sheetName)) {
    return { ok: true, updated: false, reason: 'already_completed' };
  }

  if (!metadata?.messageId) {
    return { ok: false, updated: false, reason: 'missing_message_id' };
  }

  const editResult = await telegram.editMessageText(
    metadata.messageId,
    cogsAutofillService.buildNewOrderNotification({
      ...result,
      notificationStage: 'payment_confirmed',
    })
  );

  if (editResult?.ok) {
    const completionMetadata = {
      messageId: metadata.messageId,
      paymentState: result.paymentState || 'paid',
      sheetName: result.sheetName || metadata.sheetName,
      rowCount: result.rowCount ?? metadata.rowCount,
    };
    const paymentSource = result.paymentSource || metadata.paymentSource;
    const paywayTransactionId = result.paywayTransactionId || metadata.paywayTransactionId;
    const paywayApprovedAt = result.paywayApprovedAt || metadata.paywayApprovedAt;
    if (paymentSource) completionMetadata.paymentSource = paymentSource;
    if (paywayTransactionId) completionMetadata.paywayTransactionId = paywayTransactionId;
    if (paywayApprovedAt) completionMetadata.paywayApprovedAt = paywayApprovedAt;

    cogsAutofillService.markOrderNotificationCompleted(result.orderNo, completionMetadata);
    return {
      ok: true,
      updated: true,
      messageId: metadata.messageId,
    };
  }

  return { ok: false, updated: false, reason: 'edit_failed' };
}

async function closeExistingOrderNotification(result) {
  if (!result?.orderNo) {
    return { ok: false, updated: false, reason: 'missing_order_no' };
  }

  const metadata = cogsAutofillService.getNotifiedOrderMetadata(result.orderNo);
  if (!metadata) {
    return { ok: false, updated: false, reason: 'missing_notification' };
  }

  if (metadata?.notificationStage === 'order_closed') {
    return { ok: true, updated: false, reason: 'already_closed' };
  }

  if (metadata?.notificationStage === 'payment_confirmed') {
    return { ok: true, updated: false, reason: 'already_completed' };
  }

  if (!metadata?.messageId) {
    cogsAutofillService.markOrderNotificationClosed(result.orderNo, {
      paymentState: result.paymentState || metadata.paymentState || 'closed',
      orderDate: result.orderDate || metadata.orderDate,
      source: metadata.source,
    });
    return { ok: true, updated: false, reason: 'marked_closed_without_message' };
  }

  const editResult = await telegram.editMessageText(
    metadata.messageId,
    cogsAutofillService.buildNewOrderNotification({
      ...result,
      notificationStage: 'order_closed',
    })
  );

  if (editResult?.ok) {
    cogsAutofillService.markOrderNotificationClosed(result.orderNo, {
      messageId: metadata.messageId,
      paymentState: result.paymentState || metadata.paymentState || 'closed',
      orderDate: result.orderDate || metadata.orderDate,
      source: metadata.source,
    });
    return {
      ok: true,
      updated: true,
      messageId: metadata.messageId,
    };
  }

  return { ok: false, updated: false, reason: 'edit_failed' };
}

async function deliverPaidOrderNotification(result) {
  const completed = await completeExistingOrderNotification(result);
  if (completed.updated) {
    return {
      kind: 'updated_existing',
      ...completed,
    };
  }

  if (completed.reason === 'already_completed') {
    return {
      kind: 'already_completed',
      ...completed,
    };
  }

  if (completed.reason === 'missing_message_id' || completed.reason === 'edit_failed') {
    return {
      kind: 'awaiting_existing_update',
      ...completed,
    };
  }

  const publicMessage = await telegram.sendMessage(cogsAutofillService.buildNewOrderNotification({
    ...result,
    notificationStage: 'payment_confirmed',
  }));

  if (result?.orderNo && publicMessage?.ok) {
    cogsAutofillService.markOrderNotificationCompleted(result.orderNo, {
      messageId: getTelegramMessageId(publicMessage),
      paymentState: result.paymentState || 'paid',
      sheetName: result.sheetName,
      rowCount: result.rowCount,
    });
  }

  return {
    kind: 'sent_paid_fallback',
    ok: Boolean(publicMessage?.ok),
    publicMessage,
  };
}

async function deliverPaywayPaymentNotification(result, payment = {}) {
  const completionResult = buildPaywayCompletionResult(result, payment);
  const paymentMessage = await sendPaywayPaymentReceivedMessage(completionResult, payment);

  if (!paymentMessage?.ok) {
    return {
      kind: 'payway_payment_detected',
      ok: false,
      reason: paymentMessage?.reason || 'payment_message_failed',
      paymentMessage,
    };
  }

  const completed = await completeExistingOrderNotification(completionResult);
  if (completed.updated || completed.reason === 'already_completed') {
    return {
      kind: completed.updated ? 'payway_updated_existing' : 'payway_already_completed',
      ok: true,
      paymentMessage,
      completion: completed,
    };
  }
  if (completed.reason === 'missing_message_id' || completed.reason === 'missing_notification') {
    cogsAutofillService.markOrderNotificationCompleted(completionResult.orderNo, {
      messageId: paymentMessage.messageId,
      paymentState: 'paid',
      paymentSource: 'payway',
      paywayTransactionId: payment?.transactionId || completionResult.paywayTransactionId,
      paywayApprovedAt: payment?.transactionAt || payment?.transactionAtIso || completionResult.paywayApprovedAt,
    });
    return {
      kind: 'payway_completed_without_pending_card',
      ok: true,
      paymentMessage,
      completion: {
        ok: true,
        updated: false,
        reason: 'payment_message_became_completion_card',
        messageId: paymentMessage.messageId,
      },
    };
  }

  return {
    kind: 'payway_payment_detected',
    ok: false,
    reason: completed.reason || 'completion_failed',
    paymentMessage,
    completion: completed,
  };
}

async function deliverPaywayAmbiguousPaymentWarning(payload = {}) {
  const response = await telegram.sendMessage(
    cogsAutofillService.buildPaywayAmbiguousPaymentNotification(payload)
  );

  return {
    ok: Boolean(response?.ok),
    response,
    messageId: getTelegramMessageId(response),
  };
}

async function deliverClosedOrderNotification(result) {
  const closed = await closeExistingOrderNotification(result);
  return {
    kind: closed.updated ? 'updated_existing' : closed.reason,
    ...closed,
  };
}

module.exports = {
  deliverNewOrderNotification,
  completeExistingOrderNotification,
  deliverPaidOrderNotification,
  deliverPaywayPaymentNotification,
  deliverPaywayAmbiguousPaymentWarning,
  closeExistingOrderNotification,
  deliverClosedOrderNotification,
};
