const financialLedgerRepository = require('../db/financialLedgerRepository');
const { getOrderCashTotals, normalizeImwebPayments } = require('../domain/imwebPayments');
const { formatDateInTimeZone } = require('../domain/time');
const cogsAutofillService = require('./cogsAutofillService');
const { asString } = require('./privacyService');

const DEFAULT_LOOKBACK_HOURS = 48;
const DEFAULT_LIMIT = 500;
const FINANCIAL_NOTIFICATION_STAGES = new Set(['payment_confirmed', 'order_closed']);

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function parseDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function parseRawOrder(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function normalizeLedgerOrder(row) {
  const raw = parseRawOrder(row?.raw) || parseRawOrder(row);
  const cash = raw ? getOrderCashTotals(raw) : null;
  const orderedAt = parseDate(row?.ordered_at || raw?.wtime);
  const approvedAmount = toNumber(row?.approved_amount ?? cash?.approvedAmount);
  const refundedAmount = toNumber(row?.refunded_amount ?? cash?.refundedAmount);
  const transactions = raw
    ? normalizeImwebPayments([raw]).filter(payment => payment.type === 'approval' || payment.type === 'refund')
    : [];

  return {
    orderNo: asString(row?.order_no || raw?.orderNo),
    orderedAt: orderedAt ? orderedAt.toISOString() : null,
    orderDate: asString(row?.order_date) || (orderedAt ? formatDateInTimeZone(orderedAt) : null),
    approvedAmount,
    refundedAmount,
    transactionCount: transactions.length,
    hasFinancialActivity: approvedAmount > 0 || refundedAmount > 0 || transactions.length > 0,
    lastSeenScanId: asString(row?.last_seen_scan_id) || null,
    lastSeenAt: parseDate(row?.last_seen_at)?.toISOString() || null,
  };
}

function hasTelegramMessageId(notification) {
  const messageId = Number(notification?.messageId);
  return Number.isFinite(messageId) && messageId > 0;
}

function buildOrderIssue(order, diagnostics) {
  const notification = diagnostics?.notification || null;
  const notificationStage = asString(notification?.notificationStage) || null;

  if (!diagnostics?.notificationRecorded || !hasTelegramMessageId(notification)) {
    return {
      type: 'missing_delivery',
      severity: 'error',
      orderNo: order.orderNo,
      orderedAt: order.orderedAt,
      orderDate: order.orderDate,
      approvedAmount: order.approvedAmount,
      refundedAmount: order.refundedAmount,
      transactionCount: order.transactionCount,
      notificationStage,
      importedOrder: diagnostics?.importedOrder || null,
      reason: 'Financial Imweb order has no recorded Telegram delivery message id.',
    };
  }

  if (!FINANCIAL_NOTIFICATION_STAGES.has(notificationStage)) {
    return {
      type: 'stale_notification_stage',
      severity: 'warning',
      orderNo: order.orderNo,
      orderedAt: order.orderedAt,
      orderDate: order.orderDate,
      approvedAmount: order.approvedAmount,
      refundedAmount: order.refundedAmount,
      transactionCount: order.transactionCount,
      notificationStage,
      messageId: notification.messageId,
      reason: 'Financial Imweb order still has a non-final Telegram notification stage.',
    };
  }

  return null;
}

function buildOrderNotificationAudit(rows, options = {}) {
  const getDiagnostics = options.getDiagnostics || cogsAutofillService.getOrderNotificationDiagnostics;
  const normalizedOrders = (Array.isArray(rows) ? rows : [])
    .map(normalizeLedgerOrder)
    .filter(order => order.orderNo);

  const auditedOrders = [];
  const skippedOrders = [];
  const issues = [];

  for (const order of normalizedOrders) {
    if (!order.hasFinancialActivity) {
      skippedOrders.push({
        orderNo: order.orderNo,
        orderedAt: order.orderedAt,
        reason: 'no_financial_activity',
      });
      continue;
    }

    const diagnostics = getDiagnostics(order.orderNo);
    auditedOrders.push({
      ...order,
      notificationRecorded: Boolean(diagnostics?.notificationRecorded),
      notificationStage: asString(diagnostics?.notification?.notificationStage) || null,
      messageId: Number.isFinite(Number(diagnostics?.notification?.messageId))
        ? Number(diagnostics.notification.messageId)
        : null,
    });

    const issue = buildOrderIssue(order, diagnostics);
    if (issue) {
      issues.push(issue);
    }
  }

  const missingDeliveries = issues.filter(issue => issue.type === 'missing_delivery');
  const staleNotifications = issues.filter(issue => issue.type === 'stale_notification_stage');

  return {
    status: issues.length === 0 ? 'reconciled' : 'failed',
    generatedAt: new Date().toISOString(),
    summary: {
      totalRows: normalizedOrders.length,
      checkedOrders: auditedOrders.length,
      skippedOrders: skippedOrders.length,
      missingDeliveryCount: missingDeliveries.length,
      staleNotificationCount: staleNotifications.length,
    },
    issues,
    missingDeliveries,
    staleNotifications,
    checkedOrders: auditedOrders,
    skippedOrders,
  };
}

async function auditRecentOrderNotifications(options = {}) {
  const orderReader = options.orderReader || financialLedgerRepository.listRecentImwebOrdersForNotificationAudit;
  const result = await orderReader({
    sinceTime: options.sinceTime,
    lookbackHours: options.lookbackHours || DEFAULT_LOOKBACK_HOURS,
    limit: options.limit || DEFAULT_LIMIT,
  });

  if (result?.skipped) {
    return {
      status: 'skipped',
      generatedAt: new Date().toISOString(),
      reason: result.reason,
      summary: {
        totalRows: 0,
        checkedOrders: 0,
        skippedOrders: 0,
        missingDeliveryCount: 0,
        staleNotificationCount: 0,
      },
      issues: [],
      missingDeliveries: [],
      staleNotifications: [],
      checkedOrders: [],
      skippedOrders: [],
    };
  }

  return buildOrderNotificationAudit(result?.orders || [], {
    getDiagnostics: options.getDiagnostics,
  });
}

module.exports = {
  buildOrderNotificationAudit,
  auditRecentOrderNotifications,
  normalizeLedgerOrder,
};
