const fs = require('fs');
const path = require('path');
const config = require('../config');
const runtimePaths = require('../runtime/paths');
const paywayClient = require('../modules/paywayClient');
const orderNotificationService = require('./orderNotificationService');
const { asString } = require('./privacyService');

const STATE_FILE = path.join(runtimePaths.dataDir, 'payway_payment_watch_state.json');
const HANDLED_TRANSACTION_RETENTION_HOURS = 24;
const PAYMENT_COMPLETION_RETRY_HOURS = 24;

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
  return getPositiveInteger(config.payway?.watchMinutes, 10);
}

function getPollIntervalMs() {
  return getPositiveInteger(config.payway?.pollIntervalSeconds, 30) * 1000;
}

function getMatchLeadMs() {
  return getPositiveInteger(config.payway?.matchLeadMinutes, 2) * 60 * 1000;
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
    notificationSource: asString(result?.notificationSource),
    sheetName: asString(result?.sheetName),
    rowCount: Number.isFinite(Number(result?.rowCount)) ? Number(result.rowCount) : null,
  };
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

function shouldMatchTerminal(payment) {
  const configuredMid = asString(config.payway?.mid);
  const terminal = asString(payment?.terminal);
  return !configuredMid || !terminal || terminal.includes(configuredMid);
}

function paymentTimestampMs(payment) {
  const parsed = parseDate(payment?.transactionAtIso || payment?.transactionAt);
  return parsed ? parsed.getTime() : null;
}

function matchesWatch(watch, payment) {
  if (!paywayClient.isApprovedPaywayPayment(payment)) return false;
  if (!shouldMatchTerminal(payment)) return false;

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

function findMatchingPayment(watch, payments, handledTransactions) {
  return payments
    .filter(payment => !handledTransactions[payment.transactionId])
    .filter(payment => matchesWatch(watch, payment))
    .sort((left, right) => {
      const leftTime = paymentTimestampMs(left) || 0;
      const rightTime = paymentTimestampMs(right) || 0;
      return leftTime - rightTime;
    })[0] || null;
}

function describeDeliveryFailure(delivery) {
  return delivery?.reason
    || delivery?.completion?.reason
    || delivery?.paymentMessage?.reason
    || delivery?.paymentMessage?.response?.description
    || 'unknown_delivery_failure';
}

async function deliverDetectedPayment(state, watch, payment, now = new Date()) {
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
  const delivery = await orderNotificationService.deliverPaywayPaymentNotification(notificationResult, payment);

  if (delivery?.ok) {
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
    return { delivered: true, delivery };
  }

  watch.status = 'payment_detected';
  watch.paymentDetectedAt = watch.paymentDetectedAt || nowIso(now);
  watch.paywayTransactionId = payment.transactionId;
  watch.matchedPayment = payment;
  watch.lastDeliveryError = describeDeliveryFailure(delivery);
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
  return { delivered: false, delivery };
}

function watchOrder(result, options = {}) {
  if (!paywayClient.isEnabled()) {
    return { ok: false, skipped: true, reason: 'payway_disabled' };
  }
  if (!paywayClient.isConfigured()) {
    return { ok: false, skipped: true, reason: 'payway_not_configured' };
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

    const activeWatches = getActiveWatches(state, now);
    if (activeWatches.length === 0) {
      saveState(state);
      clearPollTimer();
      return { ok: true, activeWatches: 0, detected: 0, delivered: 0, failedDeliveries: 0 };
    }

    let detected = 0;
    let delivered = 0;
    let failedDeliveries = 0;
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
    if (remainingWatches.length > 0) {
      let payments;
      try {
        payments = await paywayClient.fetchPaymentHistory({ now });
      } catch (err) {
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
        watch.lastPollError = null;
        const payment = findMatchingPayment(watch, payments, state.handledTransactions);
        if (!payment) continue;

        detected += 1;
        const result = await deliverDetectedPayment(state, watch, payment, now);
        if (result.delivered) {
          delivered += 1;
        } else {
          failedDeliveries += 1;
        }
      }
    }

    saveState(state);

    if (getActiveWatches(state, now).length > 0) {
      scheduleNextPoll(getPollIntervalMs());
    } else {
      clearPollTimer();
    }

    return {
      ok: failedDeliveries === 0,
      activeWatches: activeWatches.length,
      detected,
      delivered,
      failedDeliveries,
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
  if (activeCount > 0) {
    console.log(`[PAYWAY] Starting payment watcher with ${activeCount} active order${activeCount === 1 ? '' : 's'}`);
    scheduleNextPoll(0);
  }
  return { ok: true, activeWatches: activeCount };
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
