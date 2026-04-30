const telegram = require('../modules/telegram');
const cogsAutofillService = require('./cogsAutofillService');

function getTelegramMessageId(response) {
  const messageId = response?.result?.message_id;
  return Number.isFinite(Number(messageId)) ? Number(messageId) : null;
}

async function sendPrivateOrderDetails(result) {
  if (typeof telegram.sendPrivateMessage !== 'function') {
    return { ok: false, skipped: true, reason: 'private_delivery_unavailable' };
  }

  return telegram.sendPrivateMessage(
    cogsAutofillService.buildAutofillPrivateNotification(result),
    'HTML'
  );
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

  let privateMessage = null;
  if (publicMessage?.ok) {
    privateMessage = await sendPrivateOrderDetails(result);
  }

  return {
    publicMessage,
    privateMessage,
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
    cogsAutofillService.markOrderNotificationCompleted(result.orderNo, {
      messageId: metadata.messageId,
      paymentState: result.paymentState || 'paid',
      sheetName: result.sheetName || metadata.sheetName,
      rowCount: result.rowCount ?? metadata.rowCount,
    });
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
  let privateMessage = null;
  if (publicMessage?.ok) {
    privateMessage = await sendPrivateOrderDetails(result);
  }

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
    privateMessage,
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
  closeExistingOrderNotification,
  deliverClosedOrderNotification,
};
