const telegram = require('../modules/telegram');
const cogsAutofillService = require('./cogsAutofillService');

const orderNotificationQueues = new Map();

function getTelegramMessageId(response) {
  const messageId = response?.result?.message_id;
  return Number.isFinite(Number(messageId)) ? Number(messageId) : null;
}

function nowIso() {
  return new Date().toISOString();
}

function resolveBoolean(resultValue, metadataValue) {
  if (typeof resultValue === 'boolean') return resultValue;
  return typeof metadataValue === 'boolean' ? metadataValue : false;
}

function getCogsMetadataPatch(result, metadata = {}) {
  const cogsComplete = resolveBoolean(result?.cogsComplete, metadata?.cogsComplete);
  const cogsCostComplete = resolveBoolean(result?.cogsCostComplete, metadata?.cogsCostComplete);
  const cogsShippingComplete = resolveBoolean(result?.cogsShippingComplete, metadata?.cogsShippingComplete);

  return {
    cogsComplete,
    cogsCostComplete,
    cogsShippingComplete,
    cogsCompletedAt: cogsComplete ? (metadata?.cogsCompletedAt || nowIso()) : null,
  };
}

async function withOrderNotificationLock(orderNo, command) {
  const key = String(orderNo || '').trim();
  if (!key) {
    return command();
  }

  const previous = orderNotificationQueues.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => current);
  orderNotificationQueues.set(key, queued);

  await previous.catch(() => {});
  try {
    return await command();
  } finally {
    release();
    if (orderNotificationQueues.get(key) === queued) {
      orderNotificationQueues.delete(key);
    }
  }
}

function buildOrderCardResult(result, metadata = {}, overrides = {}) {
  const merged = {
    ...result,
    paymentState: result?.paymentState || metadata?.paymentState,
    paymentSource: result?.paymentSource || metadata?.paymentSource,
    paywayTransactionId: result?.paywayTransactionId || metadata?.paywayTransactionId,
    paywayApprovedAt: result?.paywayApprovedAt || metadata?.paywayApprovedAt,
    paywayApprovalNo: result?.paywayApprovalNo || metadata?.paywayApprovalNo,
    paywayMaskedCardNumber: result?.paywayMaskedCardNumber || metadata?.paywayMaskedCardNumber,
    paywayAmount: result?.paywayAmount || metadata?.paywayAmount,
    sheetName: result?.sheetName || metadata?.sheetName,
    rowCount: result?.rowCount ?? metadata?.rowCount,
    cogsComplete: resolveBoolean(result?.cogsComplete, metadata?.cogsComplete),
    cogsCostComplete: resolveBoolean(result?.cogsCostComplete, metadata?.cogsCostComplete),
    cogsShippingComplete: resolveBoolean(result?.cogsShippingComplete, metadata?.cogsShippingComplete),
    notificationStage: result?.notificationStage || metadata?.notificationStage,
    ...overrides,
  };

  if (typeof merged.paymentReceived !== 'boolean') {
    merged.paymentReceived = Boolean(
      metadata?.paywayPaymentReceivedAt
      || metadata?.paymentConfirmedAt
      || merged.paymentState === 'paid'
      || merged.notificationStage === 'payment_received'
      || merged.notificationStage === 'payment_confirmed'
    );
  }
  if (typeof merged.imwebPaymentConfirmed !== 'boolean') {
    merged.imwebPaymentConfirmed = Boolean(
      metadata?.imwebPaymentConfirmedAt
      || merged.notificationStage === 'payment_confirmed'
    );
  }

  return merged;
}

async function deliverNewOrderNotification(result) {
  return withOrderNotificationLock(result?.orderNo, async () => {
    const metadata = cogsAutofillService.getNotifiedOrderMetadata(result?.orderNo);
    if (metadata?.messageId) {
      return {
        ok: true,
        skipped: true,
        reason: 'already_delivered',
        publicMessage: null,
        messageId: metadata.messageId,
      };
    }

    const publicMessage = await telegram.sendMessage(cogsAutofillService.buildNewOrderNotification(
      buildOrderCardResult(result, metadata, {
        notificationStage: 'payment_pending',
        paymentReceived: false,
        imwebPaymentConfirmed: false,
      })
    ));
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
      ok: Boolean(publicMessage?.ok),
      publicMessage,
      messageId,
    };
  });
}

function buildPaywayCompletionResult(result, payment = {}) {
  const amount = Number(
    payment?.transactionAmount
    || payment?.approvedAmount
    || result?.orderValue
    || result?.netRevenue
    || result?.approvedAmount
    || 0
  );

  return {
    ...result,
    paymentState: 'paid',
    paymentLabel: result?.paymentLabel || 'Payway card approved',
    paymentMethod: result?.paymentMethod || 'Payway card',
    paymentSource: 'payway',
    paywayTransactionId: payment?.transactionId || result?.paywayTransactionId,
    paywayApprovedAt: payment?.transactionAt || payment?.transactionAtIso || result?.paywayApprovedAt,
    paywayApprovalNo: payment?.approvalNo || result?.paywayApprovalNo,
    paywayMaskedCardNumber: payment?.maskedCardNumber || result?.paywayMaskedCardNumber,
    paywayAmount: amount || result?.paywayAmount,
  };
}

async function completeExistingOrderNotificationUnlocked(result) {
  if (!result?.orderNo) {
    return { ok: false, updated: false, reason: 'missing_order_no' };
  }

  const metadata = cogsAutofillService.getNotifiedOrderMetadata(result.orderNo);
  if (!metadata) {
    return { ok: false, updated: false, reason: 'missing_notification' };
  }

  const cogsMetadataPatch = getCogsMetadataPatch(result, metadata);
  const cogsStateAlreadyCurrent = typeof metadata.cogsComplete === 'boolean'
    && metadata.cogsComplete === cogsMetadataPatch.cogsComplete
    && metadata.cogsCostComplete === cogsMetadataPatch.cogsCostComplete
    && metadata.cogsShippingComplete === cogsMetadataPatch.cogsShippingComplete;
  if (
    metadata?.notificationStage === 'payment_confirmed'
    && (!result?.sheetName || metadata.sheetName === result.sheetName)
    && cogsStateAlreadyCurrent
  ) {
    return { ok: true, updated: false, reason: 'already_completed' };
  }

  if (!metadata?.messageId) {
    return { ok: false, updated: false, reason: 'missing_message_id' };
  }

  const editResult = await telegram.editMessageText(
    metadata.messageId,
    cogsAutofillService.buildNewOrderNotification(buildOrderCardResult(result, metadata, {
      notificationStage: 'payment_confirmed',
      paymentReceived: true,
      imwebPaymentConfirmed: true,
    }))
  );

  if (editResult?.ok) {
    const completionMetadata = {
      messageId: metadata.messageId,
      paymentState: result.paymentState || 'paid',
      sheetName: result.sheetName || metadata.sheetName,
      rowCount: result.rowCount ?? metadata.rowCount,
      imwebPaymentConfirmedAt: metadata.imwebPaymentConfirmedAt || nowIso(),
      ...cogsMetadataPatch,
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

async function completeExistingOrderNotification(result) {
  return withOrderNotificationLock(
    result?.orderNo,
    () => completeExistingOrderNotificationUnlocked(result)
  );
}

async function closeExistingOrderNotificationUnlocked(result) {
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
    cogsAutofillService.buildNewOrderNotification(buildOrderCardResult(result, metadata, {
      notificationStage: 'order_closed',
    }))
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

async function closeExistingOrderNotification(result) {
  return withOrderNotificationLock(
    result?.orderNo,
    () => closeExistingOrderNotificationUnlocked(result)
  );
}

async function deliverPaidOrderNotification(result) {
  return withOrderNotificationLock(result?.orderNo, async () => {
    const completed = await completeExistingOrderNotificationUnlocked(result);
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

    const publicMessage = await telegram.sendMessage(cogsAutofillService.buildNewOrderNotification(
      buildOrderCardResult(result, {}, {
        notificationStage: 'payment_confirmed',
        paymentReceived: true,
        imwebPaymentConfirmed: true,
      })
    ));
    const messageId = getTelegramMessageId(publicMessage);

    if (result?.orderNo && publicMessage?.ok) {
      cogsAutofillService.markOrderNotificationCompleted(result.orderNo, {
        messageId,
        paymentState: result.paymentState || 'paid',
        imwebPaymentConfirmedAt: nowIso(),
        sheetName: result.sheetName,
        rowCount: result.rowCount,
        ...getCogsMetadataPatch(result),
        source: result.notificationSource || 'cogs_autofill_fallback',
      });
    }

    return {
      kind: 'sent_paid_fallback',
      ok: Boolean(publicMessage?.ok),
      publicMessage,
      messageId,
    };
  });
}

async function deliverPaywayPaymentNotification(result, payment = {}, options = {}) {
  const completionResult = buildPaywayCompletionResult(result, payment);
  if (!completionResult?.orderNo) {
    return { kind: 'payway_order_card', ok: false, reason: 'missing_order_no' };
  }

  return withOrderNotificationLock(completionResult.orderNo, async () => {
    const metadata = cogsAutofillService.getNotifiedOrderMetadata(completionResult.orderNo);
    const imwebPaymentConfirmed = options.imwebPaymentConfirmed === true
      || metadata?.notificationStage === 'payment_confirmed';
    const notificationStage = imwebPaymentConfirmed ? 'payment_confirmed' : 'payment_received';
    const notificationResult = buildOrderCardResult(completionResult, metadata, {
      notificationStage,
      paymentReceived: true,
      imwebPaymentConfirmed,
    });
    const targetAlreadyRecorded = metadata?.messageId
      && metadata.notificationStage === notificationStage
      && metadata.paywayTransactionId === completionResult.paywayTransactionId
      && (!imwebPaymentConfirmed || metadata.imwebPaymentConfirmedAt);

    if (targetAlreadyRecorded) {
      return {
        kind: 'payway_order_card_already_current',
        ok: true,
        updated: false,
        messageId: metadata.messageId,
      };
    }

    let response;
    let messageId = Number.isFinite(Number(metadata?.messageId))
      ? Number(metadata.messageId)
      : null;
    if (messageId) {
      response = await telegram.editMessageText(
        messageId,
        cogsAutofillService.buildNewOrderNotification(notificationResult)
      );
    } else {
      response = await telegram.sendMessage(
        cogsAutofillService.buildNewOrderNotification(notificationResult)
      );
      messageId = getTelegramMessageId(response);
    }

    if (!response?.ok || !messageId) {
      return {
        kind: 'payway_order_card',
        ok: false,
        updated: false,
        reason: messageId ? 'edit_failed' : 'send_failed',
        messageId,
      };
    }

    const metadataPatch = {
      messageId,
      notificationStage,
      paymentState: 'paid',
      paymentSource: 'payway',
      paywayPaymentReceivedAt: metadata?.paywayPaymentReceivedAt || nowIso(),
      paywayTransactionId: completionResult.paywayTransactionId || null,
      paywayApprovedAt: completionResult.paywayApprovedAt || null,
      paywayApprovalNo: completionResult.paywayApprovalNo || null,
      paywayMaskedCardNumber: completionResult.paywayMaskedCardNumber || null,
      paywayAmount: completionResult.paywayAmount || null,
      orderDate: completionResult.orderDate,
      ...getCogsMetadataPatch(notificationResult, metadata),
      source: metadata?.source || completionResult.notificationSource || 'payway_direct',
    };

    if (imwebPaymentConfirmed) {
      cogsAutofillService.markOrderNotificationCompleted(completionResult.orderNo, {
        ...metadataPatch,
        imwebPaymentConfirmedAt: metadata?.imwebPaymentConfirmedAt
          || options.imwebPaymentConfirmedAt
          || nowIso(),
      });
    } else {
      cogsAutofillService.recordOrderNotificationDelivery(
        completionResult.orderNo,
        metadataPatch
      );
    }

    return {
      kind: metadata?.messageId ? 'payway_order_card_updated' : 'payway_order_card_created',
      ok: true,
      updated: Boolean(metadata?.messageId),
      messageId,
    };
  });
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
  return withOrderNotificationLock(result?.orderNo, async () => {
    const closed = await closeExistingOrderNotificationUnlocked(result);
    return {
      kind: closed.updated ? 'updated_existing' : closed.reason,
      ...closed,
    };
  });
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
