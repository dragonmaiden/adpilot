const fs = require('fs');
const path = require('path');
const config = require('../config');
const runtimePaths = require('../runtime/paths');
const runtimeSettings = require('../runtime/runtimeSettings');
const paywayClient = require('../modules/paywayClient');
const imwebClient = require('../modules/imwebClient');
const cogsAutofillService = require('./cogsAutofillService');
const orderNotificationService = require('./orderNotificationService');
const { asString } = require('./privacyService');

const STATE_FILE = path.join(runtimePaths.dataDir, 'payway_payment_watch_state.json');
const HANDLED_TRANSACTION_RETENTION_HOURS = 24;
const PAYMENT_COMPLETION_RETRY_HOURS = 24;
const MATCH_LEAD_SCAN_BUFFER_MINUTES = 2;
const DEFAULT_PAYWAY_WATCH_MINUTES = 10;
const DEFAULT_PAYWAY_MIN_WATCH_MINUTES = 60;
const NO_MATCH_LOG_INTERVAL_POLLS = 10;
const PAYMENT_MONITOR_OVERLAP_MS = 60 * 1000;

let pollTimer = null;
let started = false;
let runningPoll = null;

function nowIso(now = new Date()) {
  return now.toISOString();
}

function createEmptyState() {
  return {
    watchedOrders: {},
    handledTransactions: {},
    ambiguityWarnings: {},
    paymentMonitorCursorAt: null,
  };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return createEmptyState();
  }

  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      watchedOrders: raw?.watchedOrders && typeof raw.watchedOrders === 'object'
        ? raw.watchedOrders
        : {},
      handledTransactions: raw?.handledTransactions && typeof raw.handledTransactions === 'object'
        ? raw.handledTransactions
        : {},
      ambiguityWarnings: raw?.ambiguityWarnings && typeof raw.ambiguityWarnings === 'object'
        ? raw.ambiguityWarnings
        : {},
      paymentMonitorCursorAt: asString(raw?.paymentMonitorCursorAt) || null,
    };
  } catch (_) {
    return createEmptyState();
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.chmodSync(STATE_FILE, 0o600);
}

function getPositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function getWatchMinutes() {
  const configuredWatchMinutes = getPositiveInteger(config.payway?.watchMinutes, DEFAULT_PAYWAY_WATCH_MINUTES);
  const minimumWatchMinutes = getPositiveInteger(config.payway?.minimumWatchMinutes, DEFAULT_PAYWAY_MIN_WATCH_MINUTES);
  return Math.max(configuredWatchMinutes, minimumWatchMinutes);
}

function getPollIntervalMs() {
  return getPositiveInteger(config.payway?.pollIntervalSeconds, 30) * 1000;
}

function getSchedulerScanIntervalMinutes() {
  const runtimeInterval = Number(runtimeSettings.getSchedulerSettings?.()?.scanIntervalMinutes);
  if (Number.isFinite(runtimeInterval) && runtimeInterval > 0) {
    return Math.floor(runtimeInterval);
  }
  return getPositiveInteger(config.scheduler?.scanIntervalMinutes, 3);
}

function getMatchLeadMinutes() {
  const configuredLead = getPositiveInteger(config.payway?.matchLeadMinutes, 5);
  const scanInterval = getSchedulerScanIntervalMinutes();
  return Math.max(configuredLead, scanInterval + MATCH_LEAD_SCAN_BUFFER_MINUTES);
}

function getMatchLeadMs() {
  return getMatchLeadMinutes() * 60 * 1000;
}

function getOrderAmount(result) {
  const amount = Number(
    result?.paywayMatchAmount
      || result?.paymentDueAmount
      || result?.netRevenue
      || result?.approvedAmount
      || result?.orderValue
      || 0
  );
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : 0;
}

function buildStoredOrderResult(result) {
  return {
    orderNo: asString(result?.orderNo),
    orderDate: asString(result?.orderDate),
    customerName: asString(result?.customerName),
    productNames: Array.isArray(result?.productNames) ? result.productNames.map(asString).filter(Boolean) : [],
    orderValue: getOrderAmount(result),
    paywayMatchAmount: Number(result?.paywayMatchAmount || result?.paymentDueAmount || 0) || null,
    netRevenue: Number(result?.netRevenue || 0) || null,
    approvedAmount: Number(result?.approvedAmount || 0) || null,
    paymentState: asString(result?.paymentState),
    paymentLabel: asString(result?.paymentLabel),
    paymentMethod: asString(result?.paymentMethod),
    paymentChannel: asString(result?.paymentChannel),
    notificationSource: asString(result?.notificationSource),
    sheetName: asString(result?.sheetName),
    rowCount: Number.isFinite(Number(result?.rowCount)) ? Number(result.rowCount) : null,
  };
}

function isPendingBankTransferResult(result) {
  return asString(result?.paymentState) === 'awaiting_check'
    && asString(result?.paymentChannel) === 'bank_transfer';
}

function shouldMonitorDirectPaywayPayments() {
  return config.payway?.autoConfirmImwebPayment === true
    && paywayClient.isEnabled()
    && paywayClient.isConfigured();
}

function parseDate(value) {
  const date = value instanceof Date ? value : new Date(asString(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function isTerminalWatchStatus(status) {
  return ['paid', 'expired', 'cancelled', 'completion_failed'].includes(asString(status));
}

function getCompletionRetryExpiresAt(watch) {
  const explicitExpiry = parseDate(watch?.completionRetryExpiresAt);
  if (explicitExpiry) return explicitExpiry;

  const detectedAt = parseDate(watch?.paymentDetectedAt);
  if (!detectedAt) return null;

  return new Date(detectedAt.getTime() + (PAYMENT_COMPLETION_RETRY_HOURS * 60 * 60 * 1000));
}

function getActiveWatches(state, now = new Date()) {
  const nowMs = now.getTime();
  return Object.values(state.watchedOrders || {})
    .filter(watch => {
      if (!watch || isTerminalWatchStatus(watch.status)) return false;
      if (watch.status === 'payment_detected') {
        const completionRetryExpiresAt = getCompletionRetryExpiresAt(watch);
        return !completionRetryExpiresAt || completionRetryExpiresAt.getTime() >= nowMs;
      }
      const expiresAt = parseDate(watch.expiresAt);
      return !expiresAt || expiresAt.getTime() >= nowMs;
    })
    .sort((left, right) => {
      const leftStartedAt = parseDate(left.watchStartedAt)?.getTime() || 0;
      const rightStartedAt = parseDate(right.watchStartedAt)?.getTime() || 0;
      return leftStartedAt - rightStartedAt;
    });
}

function expireOldWatches(state, now = new Date()) {
  const nowMs = now.getTime();
  let expired = 0;

  for (const watch of Object.values(state.watchedOrders || {})) {
    if (!watch || isTerminalWatchStatus(watch.status)) continue;
    if (watch.status === 'payment_detected') {
      const completionRetryExpiresAt = getCompletionRetryExpiresAt(watch);
      if (completionRetryExpiresAt && completionRetryExpiresAt.getTime() < nowMs) {
        watch.status = 'completion_failed';
        watch.completionFailedAt = nowIso(now);
        expired += 1;
      }
      continue;
    }

    const expiresAt = parseDate(watch.expiresAt);
    if (expiresAt && expiresAt.getTime() < nowMs) {
      watch.status = 'expired';
      watch.expiredAt = nowIso(now);
      console.warn(
        `[PAYWAY] Payment watch expired for order ${watch.orderNo} after ${Number(watch.pollAttempts || 0)} poll(s); `
        + `amount=${watch.amount || 'unknown'} last_error=${watch.lastPollError || 'none'}`
      );
      expired += 1;
    }
  }

  return expired;
}

function pruneHandledTransactions(state, now = new Date()) {
  const cutoffMs = now.getTime() - (HANDLED_TRANSACTION_RETENTION_HOURS * 60 * 60 * 1000);

  for (const [transactionId, metadata] of Object.entries(state.handledTransactions || {})) {
    const handledAt = parseDate(metadata?.handledAt);
    if (handledAt && handledAt.getTime() < cutoffMs) {
      delete state.handledTransactions[transactionId];
    }
  }
}

function pruneAmbiguityWarnings(state, now = new Date()) {
  const cutoffMs = now.getTime() - (HANDLED_TRANSACTION_RETENTION_HOURS * 60 * 60 * 1000);

  for (const [warningKey, metadata] of Object.entries(state.ambiguityWarnings || {})) {
    const warnedAt = parseDate(metadata?.warnedAt || metadata?.lastAttemptAt);
    if (warnedAt && warnedAt.getTime() < cutoffMs) {
      delete state.ambiguityWarnings[warningKey];
    }
  }
}

function clearPollTimer() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function scheduleNextPoll(delayMs = getPollIntervalMs()) {
  if (!started) return null;
  clearPollTimer();
  pollTimer = setTimeout(() => {
    pollTimer = null;
    runDueChecks().catch(err => {
      console.error('[PAYWAY] Payment watcher poll failed:', err.message);
      scheduleNextPoll(getPollIntervalMs());
    });
  }, Math.max(0, delayMs));
  if (typeof pollTimer.unref === 'function') {
    pollTimer.unref();
  }
  return pollTimer;
}

function getConfiguredTerminalIds() {
  if (typeof paywayClient.getConfiguredTerminalIds === 'function') {
    return paywayClient.getConfiguredTerminalIds();
  }

  const terminalIds = asString(config.payway?.mid)
    .split(/[\s,;]+/)
    .map(value => value.trim())
    .filter(Boolean);
  return [...new Set(terminalIds)];
}

function shouldMatchTerminal(payment) {
  if (config.payway?.strictTerminalMatch !== true) {
    return true;
  }

  const configuredTerminals = getConfiguredTerminalIds();
  const terminal = asString(payment?.terminal);
  return configuredTerminals.length === 0
    || !terminal
    || configuredTerminals.some(configuredTerminal => terminal.includes(configuredTerminal));
}

function paymentTimestampMs(payment) {
  const parsed = parseDate(payment?.transactionAtIso || payment?.transactionAt);
  return parsed ? parsed.getTime() : null;
}

function getPaymentOrderNo(payment) {
  return asString(payment?.merchantOrderNo);
}

function isImwebOrderReference(value) {
  return /^\d{12,20}$/.test(asString(value));
}

function ensurePaymentMonitorCursor(state, now = new Date()) {
  const existing = parseDate(state.paymentMonitorCursorAt);
  if (existing) {
    return existing;
  }

  const initialCursor = new Date(now.getTime() - getMatchLeadMs());
  state.paymentMonitorCursorAt = nowIso(initialCursor);
  return initialCursor;
}

function isWithinPaymentMonitorWindow(state, payment, now = new Date()) {
  const paidAtMs = paymentTimestampMs(payment);
  if (!paidAtMs) return false;
  const cursor = ensurePaymentMonitorCursor(state, now);
  return paidAtMs >= cursor.getTime() - PAYMENT_MONITOR_OVERLAP_MS;
}

function matchesWatch(watch, payment) {
  if (!paywayClient.isApprovedPaywayPayment(payment)) return false;
  if (!shouldMatchTerminal(payment)) return false;
  if (getPaymentOrderNo(payment) !== asString(watch?.orderNo)) return false;

  const paymentAmount = Math.round(Number(payment.transactionAmount || payment.approvedAmount || 0));
  if (paymentAmount !== Number(watch.amount)) return false;

  const paidAtMs = paymentTimestampMs(payment);
  if (!paidAtMs) return true;

  const watchStartedAt = parseDate(watch.watchStartedAt);
  const expiresAt = parseDate(watch.expiresAt);
  const lowerBoundMs = watchStartedAt ? watchStartedAt.getTime() - getMatchLeadMs() : null;
  const upperBoundMs = expiresAt ? expiresAt.getTime() + 60000 : null;

  if (lowerBoundMs != null && paidAtMs < lowerBoundMs) return false;
  if (upperBoundMs != null && paidAtMs > upperBoundMs) return false;
  return true;
}

function getMatchingPayments(watch, payments, handledTransactions) {
  return payments
    .filter(payment => !handledTransactions[payment.transactionId])
    .filter(payment => matchesWatch(watch, payment))
    .sort((left, right) => {
      const leftTime = paymentTimestampMs(left) || 0;
      const rightTime = paymentTimestampMs(right) || 0;
      return leftTime - rightTime;
    });
}

function getPaymentMatchingWatches(payment, watches) {
  return watches.filter(watch => matchesWatch(watch, payment));
}

function buildAmbiguousOrderSummary(watch) {
  return {
    orderNo: asString(watch?.orderNo),
    customerName: asString(watch?.orderResult?.customerName),
    amount: Number(watch?.amount || 0) || null,
  };
}

function buildAmbiguousPaymentSummary(payment) {
  return {
    transactionId: asString(payment?.transactionId),
    transactionAt: asString(payment?.transactionAt || payment?.transactionAtIso),
    approvalNo: asString(payment?.approvalNo),
    transactionAmount: Number(payment?.transactionAmount || payment?.approvedAmount || 0) || null,
  };
}

function uniqueSorted(values) {
  return [...new Set(values.map(asString).filter(Boolean))].sort();
}

function buildAmbiguityWarningKey(watch, match) {
  const orderNos = uniqueSorted(
    Array.isArray(match?.orders) && match.orders.length > 0
      ? match.orders.map(order => order.orderNo)
      : [watch?.orderNo, ...(Array.isArray(match?.competingOrderNos) ? match.competingOrderNos : [])]
  );
  const transactionIds = uniqueSorted(
    Array.isArray(match?.candidatePayments)
      ? match.candidatePayments.map(payment => payment.transactionId)
      : []
  );
  const amount = Number(match?.amount || watch?.amount || 0) || '';
  return [
    asString(match?.reason || 'ambiguous_payway_payment_match'),
    orderNos.join(','),
    transactionIds.join(','),
    amount,
  ].join('|');
}

function findMatchingPayment(watch, payments, handledTransactions, activeWatches = []) {
  const matchingPayments = getMatchingPayments(watch, payments, handledTransactions || {});
  if (matchingPayments.length === 0) {
    return { payment: null };
  }

  if (matchingPayments.length > 1) {
    return {
      payment: null,
      ambiguous: true,
      reason: 'ambiguous_multiple_payway_payments',
      candidateCount: matchingPayments.length,
      orders: [buildAmbiguousOrderSummary(watch)],
      amount: Number(watch?.amount || 0) || null,
      candidatePayments: matchingPayments.map(buildAmbiguousPaymentSummary),
    };
  }

  const [payment] = matchingPayments;
  const matchingWatches = getPaymentMatchingWatches(payment, activeWatches);
  if (matchingWatches.length > 1) {
    return {
      payment: null,
      ambiguous: true,
      reason: 'ambiguous_multiple_order_watches',
      candidateCount: matchingWatches.length,
      amount: Number(payment?.transactionAmount || payment?.approvedAmount || watch?.amount || 0) || null,
      orders: matchingWatches.map(buildAmbiguousOrderSummary),
      candidatePayments: [buildAmbiguousPaymentSummary(payment)],
      competingOrderNos: matchingWatches
        .map(candidate => asString(candidate.orderNo))
        .filter(Boolean)
        .filter(orderNo => orderNo !== watch.orderNo),
    };
  }

  return { payment };
}

function recordAmbiguousMatch(watch, match, now = new Date()) {
  const reason = match?.reason || 'ambiguous_payway_payment_match';
  const previousError = watch.lastPollError;
  const warningKey = buildAmbiguityWarningKey(watch, match);
  watch.lastPollError = reason;
  watch.lastAmbiguousMatchAt = nowIso(now);
  watch.ambiguousMatch = {
    reason,
    candidateCount: Number(match?.candidateCount || 0) || null,
    warningKey,
    competingOrderNos: Array.isArray(match?.competingOrderNos) ? match.competingOrderNos : [],
  };

  if (previousError !== reason) {
    console.warn(`[PAYWAY] Ambiguous payment match for order ${watch.orderNo}: ${reason}`);
  }

  return {
    key: warningKey,
    payload: {
      reason,
      candidateCount: Number(match?.candidateCount || 0) || null,
      amount: Number(match?.amount || watch?.amount || 0) || null,
      orderNos: uniqueSorted(
        Array.isArray(match?.orders) && match.orders.length > 0
          ? match.orders.map(order => order.orderNo)
          : [watch?.orderNo, ...(Array.isArray(match?.competingOrderNos) ? match.competingOrderNos : [])]
      ),
      orders: Array.isArray(match?.orders) ? match.orders : [buildAmbiguousOrderSummary(watch)],
      candidatePayments: Array.isArray(match?.candidatePayments) ? match.candidatePayments : [],
    },
  };
}

async function deliverAmbiguousMatchWarnings(state, warnings, now = new Date()) {
  if (!Array.isArray(warnings) || warnings.length === 0) {
    return { sent: 0, failed: 0 };
  }
  if (typeof orderNotificationService.deliverPaywayAmbiguousPaymentWarning !== 'function') {
    return { sent: 0, failed: 0 };
  }

  state.ambiguityWarnings = state.ambiguityWarnings || {};
  const uniqueWarnings = new Map();
  for (const warning of warnings) {
    if (!warning?.key) continue;
    uniqueWarnings.set(warning.key, warning.payload);
  }

  let sent = 0;
  let failed = 0;
  for (const [key, payload] of uniqueWarnings.entries()) {
    if (state.ambiguityWarnings[key]?.warnedAt) {
      continue;
    }

    const delivery = await orderNotificationService.deliverPaywayAmbiguousPaymentWarning(payload);
    if (delivery?.ok) {
      state.ambiguityWarnings[key] = {
        warnedAt: nowIso(now),
        reason: payload.reason,
        orderNos: payload.orderNos,
        messageId: Number.isFinite(Number(delivery.messageId)) ? Number(delivery.messageId) : null,
      };
      sent += 1;
    } else {
      state.ambiguityWarnings[key] = {
        ...(state.ambiguityWarnings[key] || {}),
        reason: payload.reason,
        orderNos: payload.orderNos,
        lastAttemptAt: nowIso(now),
        lastError: delivery?.reason || delivery?.response?.description || 'telegram_warning_failed',
      };
      failed += 1;
    }
  }

  return { sent, failed };
}

function describeDeliveryFailure(delivery) {
  return delivery?.reason
    || delivery?.completion?.reason
    || delivery?.paymentMessage?.reason
    || delivery?.paymentMessage?.response?.description
    || 'unknown_delivery_failure';
}

function recordHandledTransaction(state, payment, orderNo, now, status, reason = null) {
  state.handledTransactions[payment.transactionId] = {
    orderNo,
    handledAt: nowIso(now),
    status,
    reason,
    transactionAmount: payment.transactionAmount || payment.approvedAmount || null,
  };
}

function recordDirectManualReview(state, payment, orderNo, now, reason) {
  recordHandledTransaction(state, payment, orderNo, now, 'manual_review', reason);
  console.warn(
    `[PAYWAY] Direct auto-confirm skipped for order ${orderNo}: ${reason} `
    + `(transaction=${payment.transactionId || payment.approvalNo || 'unknown'})`
  );
}

async function reconcileDirectPayment(state, payment, now = new Date()) {
  const orderNo = getPaymentOrderNo(payment);
  const order = await imwebClient.getOrder(orderNo);
  const orderResult = cogsAutofillService.buildOrderNotificationResult(order, {
    notificationKind: 'new_order',
    notificationSource: 'payway_direct',
  });
  const paymentAmount = Math.round(Number(payment.transactionAmount || payment.approvedAmount || 0));
  const orderAmount = getOrderAmount(orderResult);

  if (asString(orderResult.paymentState) === 'paid') {
    recordHandledTransaction(state, payment, orderNo, now, 'already_confirmed');
    return { reconciled: true, delivered: false, alreadyConfirmed: true };
  }

  if (!isPendingBankTransferResult(orderResult)) {
    recordDirectManualReview(state, payment, orderNo, now, 'imweb_order_not_pending_bank_transfer');
    return { reconciled: false, delivered: false, manualReview: true };
  }

  if (!orderAmount || paymentAmount !== orderAmount) {
    recordDirectManualReview(state, payment, orderNo, now, 'payway_imweb_amount_mismatch');
    return { reconciled: false, delivered: false, manualReview: true };
  }

  const existing = state.watchedOrders[orderNo];
  const watchStartedAt = existing?.watchStartedAt || nowIso(now);
  const expiresAt = existing?.expiresAt
    || new Date(now.getTime() + (getWatchMinutes() * 60 * 1000)).toISOString();
  const watch = {
    ...(existing || {}),
    orderNo,
    amount: orderAmount,
    status: 'payment_detected',
    watchStartedAt,
    expiresAt,
    orderResult: buildStoredOrderResult(orderResult),
    paymentDetectedAt: existing?.paymentDetectedAt || nowIso(now),
    paywayTransactionId: payment.transactionId,
    matchedPayment: payment,
    lastPollAt: nowIso(now),
    pollAttempts: Number(existing?.pollAttempts || 0) + 1,
  };
  state.watchedOrders[orderNo] = watch;

  const result = await deliverDetectedPayment(state, watch, payment, now);
  return {
    reconciled: true,
    delivered: result.delivered,
    alreadyConfirmed: Boolean(result.confirmation?.alreadyConfirmed),
  };
}

async function reconcileDirectPayments(state, payments, now = new Date()) {
  if (!shouldMonitorDirectPaywayPayments()) {
    return { detected: 0, delivered: 0, manualReview: 0, unresolved: 0 };
  }

  const candidates = payments
    .filter(payment => paywayClient.isApprovedPaywayPayment(payment))
    .filter(payment => shouldMatchTerminal(payment))
    .filter(payment => isImwebOrderReference(getPaymentOrderNo(payment)))
    .filter(payment => !state.handledTransactions[payment.transactionId])
    .filter(payment => isWithinPaymentMonitorWindow(state, payment, now));
  const candidatesByOrder = new Map();

  for (const payment of candidates) {
    const orderNo = getPaymentOrderNo(payment);
    const orderPayments = candidatesByOrder.get(orderNo) || [];
    orderPayments.push(payment);
    candidatesByOrder.set(orderNo, orderPayments);
  }

  let detected = 0;
  let delivered = 0;
  let manualReview = 0;
  let unresolved = 0;

  for (const [orderNo, orderPayments] of candidatesByOrder.entries()) {
    if (orderPayments.length > 1) {
      for (const payment of orderPayments) {
        recordDirectManualReview(state, payment, orderNo, now, 'multiple_payway_payments_for_order');
      }
      manualReview += orderPayments.length;
      continue;
    }

    try {
      const result = await reconcileDirectPayment(state, orderPayments[0], now);
      if (result.reconciled) detected += 1;
      if (result.delivered) delivered += 1;
      if (result.manualReview) manualReview += 1;
    } catch (err) {
      unresolved += 1;
      console.warn(`[PAYWAY] Direct auto-confirm deferred for order ${orderNo}: ${err.message}`);
    }
  }

  if (unresolved === 0) {
    state.paymentMonitorCursorAt = nowIso(now);
  }

  return { detected, delivered, manualReview, unresolved };
}

async function confirmMatchedImwebPayment(watch, now = new Date()) {
  if (config.payway?.autoConfirmImwebPayment !== true) {
    return { ok: true, skipped: true, reason: 'auto_confirmation_disabled' };
  }
  if (watch.imwebConfirmation?.status === 'confirmed') {
    return {
      ok: true,
      skipped: true,
      reason: 'already_confirmed',
      alreadyConfirmed: Boolean(watch.imwebConfirmation.alreadyConfirmed),
    };
  }

  const attemptedAt = nowIso(now);
  const attempts = Number(watch.imwebConfirmation?.attempts || 0) + 1;

  try {
    const result = await imwebClient.confirmBankTransferPayment(watch.orderNo);
    watch.imwebConfirmation = {
      status: 'confirmed',
      attempts,
      lastAttemptAt: attemptedAt,
      confirmedAt: attemptedAt,
      alreadyConfirmed: Boolean(result?.alreadyConfirmed),
      lastError: null,
    };
    return {
      ok: true,
      alreadyConfirmed: Boolean(result?.alreadyConfirmed),
    };
  } catch (err) {
    const error = err?.message || 'unknown Imweb confirmation failure';
    watch.imwebConfirmation = {
      status: 'failed',
      attempts,
      lastAttemptAt: attemptedAt,
      confirmedAt: null,
      alreadyConfirmed: false,
      lastError: error,
    };
    return {
      ok: false,
      reason: 'imweb_confirmation_failed',
      error,
    };
  }
}

function describeCompletionFailure(confirmation, delivery) {
  if (!confirmation?.ok) {
    return `${confirmation?.reason || 'imweb_confirmation_failed'}: ${confirmation?.error || 'unknown failure'}`;
  }
  return describeDeliveryFailure(delivery);
}

async function deliverDetectedPayment(state, watch, payment, now = new Date()) {
  console.log(
    `[PAYWAY] Payment matched for order ${watch.orderNo}: `
    + `amount=${payment.transactionAmount || payment.approvedAmount || watch.amount || 'unknown'} `
    + `terminal=${payment.terminal || 'unknown'} `
    + `transaction=${payment.transactionId || payment.approvalNo || 'unknown'}`
  );

  const notificationResult = {
    ...watch.orderResult,
    orderValue: watch.amount,
    paymentState: 'paid',
    paymentLabel: 'Payway card approved',
    paymentMethod: 'Payway card',
    paymentSource: 'payway',
    paywayTransactionId: payment.transactionId,
    paywayApprovedAt: payment.transactionAt || payment.transactionAtIso,
  };
  const confirmation = await confirmMatchedImwebPayment(watch, now);
  const imwebPaymentConfirmed = confirmation.ok
    && confirmation.reason !== 'auto_confirmation_disabled';
  const delivery = await orderNotificationService.deliverPaywayPaymentNotification(
    notificationResult,
    payment,
    {
      imwebPaymentConfirmed,
      imwebPaymentConfirmedAt: watch.imwebConfirmation?.confirmedAt || null,
    }
  );

  if (confirmation.ok && delivery?.ok) {
    watch.status = 'paid';
    watch.paymentDetectedAt = watch.paymentDetectedAt || nowIso(now);
    watch.paywayTransactionId = payment.transactionId;
    watch.matchedPayment = payment;
    watch.lastDeliveryError = null;
    watch.lastCompletionAttemptAt = nowIso(now);
    state.handledTransactions[payment.transactionId] = {
      orderNo: watch.orderNo,
      handledAt: nowIso(now),
      transactionAmount: payment.transactionAmount || payment.approvedAmount || watch.amount,
    };
    console.log(`[PAYWAY] Payment notification delivered for order ${watch.orderNo}`);
    return { delivered: true, confirmation, delivery };
  }

  watch.status = 'payment_detected';
  watch.paymentDetectedAt = watch.paymentDetectedAt || nowIso(now);
  watch.paywayTransactionId = payment.transactionId;
  watch.matchedPayment = payment;
  watch.lastDeliveryError = describeCompletionFailure(confirmation, delivery);
  watch.completionRetryStartedAt = watch.completionRetryStartedAt || nowIso(now);
  watch.completionRetryExpiresAt = watch.completionRetryExpiresAt
    || new Date(now.getTime() + (PAYMENT_COMPLETION_RETRY_HOURS * 60 * 60 * 1000)).toISOString();
  watch.lastCompletionAttemptAt = nowIso(now);
  watch.completionAttempts = Number(watch.completionAttempts || 0) + 1;
  if (payment.transactionId) {
    state.handledTransactions[payment.transactionId] = {
      orderNo: watch.orderNo,
      handledAt: nowIso(now),
      status: 'delivery_pending',
      transactionAmount: payment.transactionAmount || payment.approvedAmount || watch.amount,
    };
  }
  console.warn(`[PAYWAY] Payment completion failed for order ${watch.orderNo}: ${watch.lastDeliveryError}`);
  return { delivered: false, confirmation, delivery };
}

function watchOrder(result, options = {}) {
  if (!paywayClient.isEnabled()) {
    return { ok: false, skipped: true, reason: 'payway_disabled' };
  }
  if (!paywayClient.isConfigured()) {
    return { ok: false, skipped: true, reason: 'payway_not_configured' };
  }
  if (!isPendingBankTransferResult(result)) {
    return { ok: false, skipped: true, reason: 'not_pending_bank_transfer' };
  }

  const orderNo = asString(result?.orderNo);
  if (!orderNo) {
    return { ok: false, skipped: true, reason: 'missing_order_no' };
  }

  const amount = getOrderAmount(result);
  if (!amount) {
    return { ok: false, skipped: true, reason: 'missing_order_amount' };
  }

  const now = options.now instanceof Date ? options.now : new Date();
  const state = loadState();
  const existing = state.watchedOrders[orderNo];
  if (existing && existing.status === 'paid') {
    return { ok: true, skipped: true, reason: 'already_paid', orderNo };
  }

  const watchStartedAt = nowIso(now);
  const expiresAt = new Date(now.getTime() + (getWatchMinutes() * 60 * 1000)).toISOString();
  state.watchedOrders[orderNo] = {
    ...(existing || {}),
    orderNo,
    amount,
    status: 'watching',
    watchStartedAt: existing?.watchStartedAt || watchStartedAt,
    expiresAt,
    messageId: Number.isFinite(Number(options.messageId)) ? Number(options.messageId) : existing?.messageId || null,
    orderResult: buildStoredOrderResult(result),
    lastPollAt: existing?.lastPollAt || null,
    pollAttempts: Number(existing?.pollAttempts || 0),
  };

  pruneHandledTransactions(state, now);
  saveState(state);
  scheduleNextPoll(0);
  console.log(
    `[PAYWAY] ${existing ? 'Refreshed' : 'Started'} payment watch for order ${orderNo}: `
    + `amount=${amount} expires_at=${expiresAt}`
  );
  return { ok: true, watching: true, orderNo, expiresAt };
}

async function runDueChecks(options = {}) {
  if (runningPoll) {
    return runningPoll;
  }

  runningPoll = (async () => {
    const now = options.now instanceof Date ? options.now : new Date();
    const state = loadState();
    expireOldWatches(state, now);
    pruneHandledTransactions(state, now);
    pruneAmbiguityWarnings(state, now);

    const activeWatches = getActiveWatches(state, now);
    const directMonitoring = shouldMonitorDirectPaywayPayments();
    if (directMonitoring) {
      ensurePaymentMonitorCursor(state, now);
    }
    if (activeWatches.length === 0 && !directMonitoring) {
      saveState(state);
      clearPollTimer();
      return { ok: true, activeWatches: 0, detected: 0, delivered: 0, failedDeliveries: 0 };
    }

    let detected = 0;
    let delivered = 0;
    let failedDeliveries = 0;
    let ambiguousMatches = 0;
    let directManualReview = 0;
    let directUnresolved = 0;
    const ambiguousWarnings = [];
    const existingDetected = activeWatches.filter(watch => watch.status === 'payment_detected' && watch.matchedPayment);

    for (const watch of existingDetected) {
      const result = await deliverDetectedPayment(state, watch, watch.matchedPayment, now);
      if (result.delivered) {
        delivered += 1;
      } else {
        failedDeliveries += 1;
      }
    }

    const remainingWatches = getActiveWatches(state, now).filter(watch => watch.status !== 'payment_detected');
    if (remainingWatches.length > 0 || directMonitoring) {
      let payments;
      try {
        payments = await paywayClient.fetchPaymentHistory({ now });
      } catch (err) {
        console.warn(
          `[PAYWAY] Payment history fetch failed `
          + `(${remainingWatches.length} active watch${remainingWatches.length === 1 ? '' : 'es'}): ${err.message}`
        );
        for (const watch of remainingWatches) {
          watch.lastPollAt = nowIso(now);
          watch.pollAttempts = Number(watch.pollAttempts || 0) + 1;
          watch.lastPollError = err.message;
        }
        saveState(state);
        scheduleNextPoll(getPollIntervalMs());
        return {
          ok: false,
          activeWatches: activeWatches.length,
          detected,
          delivered,
          failedDeliveries,
          error: err.message,
        };
      }

      for (const watch of remainingWatches) {
        watch.lastPollAt = nowIso(now);
        watch.pollAttempts = Number(watch.pollAttempts || 0) + 1;
        const match = findMatchingPayment(watch, payments, state.handledTransactions, remainingWatches);
        if (!match.payment) {
          if (match.ambiguous) {
            ambiguousMatches += 1;
            const warning = recordAmbiguousMatch(watch, match, now);
            if (warning) {
              ambiguousWarnings.push(warning);
            }
          } else {
            watch.lastPollError = null;
            delete watch.ambiguousMatch;
            delete watch.lastAmbiguousMatchAt;
            if (watch.pollAttempts === 1 || watch.pollAttempts % NO_MATCH_LOG_INTERVAL_POLLS === 0) {
              console.log(
                `[PAYWAY] No matching payment yet for order ${watch.orderNo}: `
                + `poll=${watch.pollAttempts} amount=${watch.amount} payments_checked=${payments.length}`
              );
            }
          }
          continue;
        }

        watch.lastPollError = null;
        delete watch.ambiguousMatch;
        delete watch.lastAmbiguousMatchAt;
        detected += 1;
        const result = await deliverDetectedPayment(state, watch, match.payment, now);
        if (result.delivered) {
          delivered += 1;
        } else {
          failedDeliveries += 1;
        }
      }

      const directResult = await reconcileDirectPayments(state, payments, now);
      detected += directResult.detected;
      delivered += directResult.delivered;
      directManualReview += directResult.manualReview;
      directUnresolved += directResult.unresolved;
    }

    const warningResult = await deliverAmbiguousMatchWarnings(state, ambiguousWarnings, now);

    saveState(state);

    if (directMonitoring || getActiveWatches(state, now).length > 0) {
      scheduleNextPoll(getPollIntervalMs());
    } else {
      clearPollTimer();
    }

    return {
      ok: failedDeliveries === 0 && ambiguousMatches === 0 && directUnresolved === 0,
      activeWatches: activeWatches.length,
      detected,
      delivered,
      failedDeliveries,
      ambiguousMatches,
      ambiguousWarningsSent: warningResult.sent,
      ambiguousWarningsFailed: warningResult.failed,
      directManualReview,
      directUnresolved,
    };
  })();

  try {
    return await runningPoll;
  } finally {
    runningPoll = null;
  }
}

function start() {
  started = true;
  const state = loadState();
  const activeCount = getActiveWatches(state).length;
  const directMonitoring = shouldMonitorDirectPaywayPayments();
  if (directMonitoring) {
    ensurePaymentMonitorCursor(state);
    saveState(state);
  }
  if (activeCount > 0 || directMonitoring) {
    console.log(
      `[PAYWAY] Starting payment watcher with ${activeCount} active order${activeCount === 1 ? '' : 's'}`
      + `${directMonitoring ? ' and direct Payway-to-Imweb reconciliation' : ''}`
    );
    scheduleNextPoll(0);
  }
  return { ok: true, activeWatches: activeCount, directMonitoring };
}

function stop() {
  started = false;
  clearPollTimer();
}

module.exports = {
  watchOrder,
  runDueChecks,
  start,
  stop,
  loadState,
};
