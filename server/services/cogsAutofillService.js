const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const runtimePaths = require('../runtime/paths');
const cogsClient = require('../modules/cogsClient');
const imweb = require('../modules/imwebClient');
const { getOrderItems } = require('../domain/imwebAttribution');
const { formatDateInTimeZone } = require('../domain/time');
const { getOrderCashTotals, normalizeImwebPayments } = require('../domain/imwebPayments');
const {
  asString,
  getOrderContactSnapshot,
  maskName,
} = require('./privacyService');

const STATE_FILE = path.join(runtimePaths.dataDir, 'cogs_autofill_state.json');
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DEFAULT_POLL_LOOKBACK_DAYS = 7;
const MAX_NEW_ORDER_BACKFILL_HOURS = 1;
const BIG_FISH_THRESHOLD_KRW = 200000;
const COMPACT_DETAIL_COLUMN_INDEX = 12;
const COMPACT_DETAIL_HEADER_LABEL = 'delivery note';
const TERMINAL_ORDER_STATUS_TOKENS = [
  'CANCEL',
  'RETURN',
  'EXCHANGE',
  'REFUND',
  'CLOSED',
];
const LEGACY_OPTIONAL_HEADER_LABELS = new Set([
  '배송메모',
  '주문자 연락처',
  '수령인 이름',
  '수령인 연락처',
  '우편번호',
  '주소',
]);

let googleAccessToken = null;
let googleAccessTokenExpiry = 0;

function normalizePrivateKey(value) {
  return asString(value).replace(/\\n/g, '\n');
}

function isConfigured() {
  return Boolean(
    config.cogs.spreadsheetId
    && asString(config.cogs.autofill.googleClientEmail)
    && normalizePrivateKey(config.cogs.autofill.googlePrivateKey)
  );
}

function createEmptyState() {
  return {
    importedOrders: {},
    notifiedOrders: {},
  };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return createEmptyState();
  }

  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      importedOrders: raw?.importedOrders && typeof raw.importedOrders === 'object'
        ? raw.importedOrders
        : {},
      notifiedOrders: raw?.notifiedOrders && typeof raw.notifiedOrders === 'object'
        ? raw.notifiedOrders
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

function markOrderImported(orderNo, metadata = {}) {
  const normalizedOrderNo = asString(orderNo);
  if (!normalizedOrderNo) return;

  const state = loadState();
  state.importedOrders[normalizedOrderNo] = {
    orderNo: normalizedOrderNo,
    importedAt: new Date().toISOString(),
    ...metadata,
  };
  saveState(state);
}

function getImportedOrderMetadata(orderNo) {
  const normalizedOrderNo = asString(orderNo);
  if (!normalizedOrderNo) return null;
  const state = loadState();
  return state.importedOrders[normalizedOrderNo] || null;
}

function markOrderNotified(orderNo, metadata = {}) {
  const normalizedOrderNo = asString(orderNo);
  if (!normalizedOrderNo) return;

  const state = loadState();
  state.notifiedOrders[normalizedOrderNo] = {
    ...(state.notifiedOrders[normalizedOrderNo] || {}),
    orderNo: normalizedOrderNo,
    notifiedAt: state.notifiedOrders[normalizedOrderNo]?.notifiedAt || new Date().toISOString(),
    ...metadata,
  };
  saveState(state);
}

function recordOrderNotificationDelivery(orderNo, metadata = {}) {
  markOrderNotified(orderNo, metadata);
  return getNotifiedOrderMetadata(orderNo);
}

function markOrderNotificationCompleted(orderNo, metadata = {}) {
  markOrderNotified(orderNo, {
    notificationStage: 'payment_confirmed',
    paymentConfirmedAt: new Date().toISOString(),
    ...metadata,
  });
  return getNotifiedOrderMetadata(orderNo);
}

function markOrderNotificationClosed(orderNo, metadata = {}) {
  markOrderNotified(orderNo, {
    notificationStage: 'order_closed',
    closedAt: new Date().toISOString(),
    ...metadata,
  });
  return getNotifiedOrderMetadata(orderNo);
}

function getNotifiedOrderMetadata(orderNo) {
  const normalizedOrderNo = asString(orderNo);
  if (!normalizedOrderNo) return null;
  const state = loadState();
  return state.notifiedOrders[normalizedOrderNo] || null;
}

function buildNotificationBehaviorInference(metadata) {
  if (!metadata) {
    return {
      initialAlertStatus: 'not_recorded',
      initialBellCardLikelySent: null,
      completedCardLikelyEditedInPlace: null,
      closedCardLikelyEditedInPlace: null,
      completedFallbackLikelyUsed: null,
      customerDetailsLikelyResentOnCompletion: null,
      summary: 'No notification record exists for this order.',
    };
  }

  const source = asString(metadata.source);
  const stage = asString(metadata.notificationStage);
  const hasMessageId = Number.isFinite(Number(metadata.messageId));
  const isInitialAlertSource = source === 'webhook_new_order' || source === 'scan_backstop';
  const isFallbackSource = source === 'cogs_autofill_fallback' || !source;

  if (stage === 'delivery_pending') {
    return {
      initialAlertStatus: 'delivery_pending',
      initialBellCardLikelySent: false,
      completedCardLikelyEditedInPlace: false,
      closedCardLikelyEditedInPlace: false,
      completedFallbackLikelyUsed: false,
      customerDetailsLikelyResentOnCompletion: false,
      summary: 'The order was seen, but Telegram delivery of the initial bell card was not confirmed.',
    };
  }

  if (isInitialAlertSource && hasMessageId && stage === 'payment_pending') {
    return {
      initialAlertStatus: 'sent_pending_payment',
      initialBellCardLikelySent: true,
      completedCardLikelyEditedInPlace: false,
      closedCardLikelyEditedInPlace: false,
      completedFallbackLikelyUsed: false,
      customerDetailsLikelyResentOnCompletion: false,
      summary: 'The initial bell card was delivered and is still waiting for payment recognition.',
    };
  }

  if (isInitialAlertSource && hasMessageId && stage === 'payment_confirmed') {
    return {
      initialAlertStatus: 'sent_then_completed',
      initialBellCardLikelySent: true,
      completedCardLikelyEditedInPlace: true,
      closedCardLikelyEditedInPlace: false,
      completedFallbackLikelyUsed: false,
      customerDetailsLikelyResentOnCompletion: false,
      summary: 'The initial bell card was delivered and later completed in place.',
    };
  }

  if (isInitialAlertSource && stage === 'order_closed') {
    return {
      initialAlertStatus: hasMessageId ? 'sent_then_closed' : 'closed_before_delivery_confirmation',
      initialBellCardLikelySent: hasMessageId,
      completedCardLikelyEditedInPlace: false,
      closedCardLikelyEditedInPlace: hasMessageId,
      completedFallbackLikelyUsed: false,
      customerDetailsLikelyResentOnCompletion: false,
      summary: hasMessageId
        ? 'The initial bell card was delivered and later marked closed in place.'
        : 'The order was later closed before Telegram delivery of the initial bell card was confirmed.',
    };
  }

  if (isFallbackSource && hasMessageId && stage === 'payment_confirmed') {
    return {
      initialAlertStatus: 'completed_fallback_only',
      initialBellCardLikelySent: false,
      completedCardLikelyEditedInPlace: false,
      closedCardLikelyEditedInPlace: false,
      completedFallbackLikelyUsed: true,
      customerDetailsLikelyResentOnCompletion: true,
      summary: 'There is only a completed notification record, so this likely skipped the initial bell card and used the completed fallback.',
    };
  }

  return {
    initialAlertStatus: 'unknown',
    initialBellCardLikelySent: null,
    completedCardLikelyEditedInPlace: null,
    closedCardLikelyEditedInPlace: null,
    completedFallbackLikelyUsed: null,
    customerDetailsLikelyResentOnCompletion: null,
    summary: 'Notification state exists, but the delivery path cannot be inferred confidently.',
  };
}

function sanitizeNotificationMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  return {
    orderNo: asString(metadata.orderNo) || null,
    source: asString(metadata.source) || null,
    eventName: asString(metadata.eventName) || null,
    notificationStage: asString(metadata.notificationStage) || null,
    notifiedAt: asString(metadata.notifiedAt) || null,
    paymentConfirmedAt: asString(metadata.paymentConfirmedAt) || null,
    closedAt: asString(metadata.closedAt) || null,
    orderDate: asString(metadata.orderDate) || null,
    paymentState: asString(metadata.paymentState) || null,
    sheetName: asString(metadata.sheetName) || null,
    messageId: Number.isFinite(Number(metadata.messageId)) ? Number(metadata.messageId) : null,
    rowCount: Number.isFinite(Number(metadata.rowCount)) ? Number(metadata.rowCount) : null,
  };
}

function getOrderNotificationDiagnostics(orderNo) {
  const normalizedOrderNo = asString(orderNo);
  if (!normalizedOrderNo) {
    return null;
  }

  const notification = sanitizeNotificationMetadata(getNotifiedOrderMetadata(normalizedOrderNo));
  const imported = getImportedOrderMetadata(normalizedOrderNo);

  return {
    orderNo: normalizedOrderNo,
    notificationRecorded: Boolean(notification),
    notification,
    importedOrder: imported ? {
      orderNo: asString(imported.orderNo) || normalizedOrderNo,
      importedAt: asString(imported.importedAt) || null,
      source: asString(imported.source) || null,
      sheetName: asString(imported.sheetName) || null,
      orderDate: asString(imported.orderDate) || null,
      rowCount: Number.isFinite(Number(imported.rowCount)) ? Number(imported.rowCount) : null,
    } : null,
    inference: buildNotificationBehaviorInference(notification),
  };
}

function wasOrderNotified(orderNo) {
  return Boolean(getNotifiedOrderMetadata(orderNo));
}

function base64UrlEncode(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createGoogleAssertion() {
  const clientEmail = asString(config.cogs.autofill.googleClientEmail);
  const privateKey = normalizePrivateKey(config.cogs.autofill.googlePrivateKey);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    scope: SHEETS_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).end().sign(privateKey);
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

async function getGoogleAccessToken() {
  if (googleAccessToken && Date.now() < googleAccessTokenExpiry - 60_000) {
    return googleAccessToken;
  }

  const assertion = createGoogleAssertion();
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.access_token) {
    throw new Error(`Google token request failed: ${payload?.error_description || payload?.error || response.status}`);
  }

  googleAccessToken = payload.access_token;
  googleAccessTokenExpiry = Date.now() + (Number(payload.expires_in || 3600) * 1000);
  return googleAccessToken;
}

function extractMonthNumber(value) {
  const text = asString(value);
  if (!text) return null;

  const monthMatch = text.match(/(^|\D)(\d{1,2})\s*월/);
  if (monthMatch) {
    return Number.parseInt(monthMatch[2], 10);
  }

  const numericMatch = text.match(/^\s*(\d{1,2})\s*$/);
  if (numericMatch) {
    return Number.parseInt(numericMatch[1], 10);
  }

  return null;
}

function findTargetForMonth(targets, month) {
  return (Array.isArray(targets) ? targets : []).find(target => (
    extractMonthNumber(target?.sheetName) === month
      || extractMonthNumber(target?.label) === month
  )) || null;
}

async function resolveTargetSheet(dateKey) {
  const month = Number.parseInt(String(dateKey || '').slice(5, 7), 10);
  if (!Number.isFinite(month) || month < 1 || month > 12) {
    throw new Error(`Invalid order date for COGS sheet routing: ${dateKey}`);
  }

  try {
    const workbookMeta = await cogsClient.fetchWorkbookMetadata();
    const targets = cogsClient.buildSheetTargets(workbookMeta?.workbookSheets || []);
    const matched = findTargetForMonth(targets, month);
    if (matched) {
      return matched;
    }
  } catch (err) {
    console.warn(`[COGS AUTOFILL] Workbook discovery failed, falling back to known sheet names: ${err.message}`);
  }

  const fallbackLabel = `${month}월`;
  return {
    label: fallbackLabel,
    gid: null,
    sheetName: `${fallbackLabel} 주문`,
    discovered: false,
  };
}

async function fetchExistingRows(target) {
  try {
    if (target?.gid) {
      return await cogsClient.fetchSheetCSV({ gid: target.gid, sheetName: target.sheetName });
    }
    return await cogsClient.fetchSheetCSV({ sheetName: target.sheetName });
  } catch (primaryError) {
    if (target?.sheetName && target?.label && target.sheetName !== target.label) {
      return cogsClient.fetchSheetCSV({ sheetName: target.label });
    }
    throw primaryError;
  }
}

function getSheetCacheKey(target) {
  if (target?.gid) return `gid:${target.gid}`;
  return `sheet:${asString(target?.sheetName || target?.label)}`;
}

function toColumnLabel(columnNumber) {
  let remaining = Number(columnNumber || 0);
  let label = '';
  while (remaining > 0) {
    const offset = (remaining - 1) % 26;
    label = String.fromCharCode(65 + offset) + label;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return label;
}

async function getRowsForTarget(target, sheetCache) {
  if (!(sheetCache instanceof Map)) {
    return fetchExistingRows(target);
  }

  const cacheKey = getSheetCacheKey(target);
  if (!sheetCache.has(cacheKey)) {
    sheetCache.set(cacheKey, await fetchExistingRows(target));
  }
  return sheetCache.get(cacheKey);
}

function setRowsForTarget(target, rows, sheetCache) {
  if (!(sheetCache instanceof Map)) return;
  sheetCache.set(getSheetCacheKey(target), rows);
}

function getNextSequenceNumber(rows) {
  // Scan every cell, not just column 0 — the Google Sheets append API
  // may place data at a column offset (e.g. column M) when the sheet
  // has pre-existing data that doesn't start at column A.
  return (Array.isArray(rows) ? rows : []).reduce((max, row) => {
    if (!Array.isArray(row)) return max;
    for (const cell of row) {
      const candidate = Number.parseInt(asString(cell), 10);
      if (Number.isFinite(candidate) && candidate > max) {
        max = candidate;
        break; // sequence is always the first non-empty cell
      }
    }
    return max;
  }, 0) + 1;
}

async function updateSheetValues(ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    return null;
  }

  const token = await getGoogleAccessToken();
  const url = `${SHEETS_API_BASE}/${encodeURIComponent(config.cogs.spreadsheetId)}/values:batchUpdate`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: ranges,
    }),
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`Google Sheets batch update failed: ${payload?.error?.message || response.status}`);
  }

  return payload;
}

async function ensureOptionalHeaders(target, rows) {
  const headerRow = Array.isArray(rows?.[0]) ? [...rows[0]] : [];
  const updates = [];
  const currentHeader = asString(headerRow[COMPACT_DETAIL_COLUMN_INDEX]);
  const shouldSetCompactHeader = !currentHeader
    || LEGACY_OPTIONAL_HEADER_LABELS.has(currentHeader)
    || currentHeader.toLowerCase() === COMPACT_DETAIL_HEADER_LABEL;

  if (shouldSetCompactHeader && currentHeader !== COMPACT_DETAIL_HEADER_LABEL) {
    updates.push({
      range: `'${String(target.sheetName || target.label || '').replace(/'/g, "''")}'!${toColumnLabel(COMPACT_DETAIL_COLUMN_INDEX + 1)}1`,
      majorDimension: 'ROWS',
      values: [[COMPACT_DETAIL_HEADER_LABEL]],
    });
    headerRow[COMPACT_DETAIL_COLUMN_INDEX] = COMPACT_DETAIL_HEADER_LABEL;
  }

  if (updates.length === 0) {
    return { updated: false, count: 0 };
  }

  await updateSheetValues(updates);

  if (Array.isArray(rows)) {
    if (!Array.isArray(rows[0])) {
      rows[0] = [];
    }
    rows[0][COMPACT_DETAIL_COLUMN_INDEX] = COMPACT_DETAIL_HEADER_LABEL;
  }

  return { updated: true, count: updates.length };
}

function hasOrderNumber(rows, orderNo) {
  const normalizedOrderNo = asString(orderNo);
  if (!normalizedOrderNo) return false;

  // Search every cell in each row — the Google Sheets append API may
  // place data at a column offset when the sheet has pre-existing data
  // that doesn't start at column A, so the order number won't always
  // be at index 3.
  return (Array.isArray(rows) ? rows : []).some(row =>
    Array.isArray(row) && row.some(cell => asString(cell) === normalizedOrderNo)
  );
}

function getOrderProductNames(order) {
  const productNames = getOrderItems(order)
    .map(item => asString(item?.productInfo?.prodName || item?.productName || item?.name))
    .filter(Boolean);

  return productNames.length > 0 ? productNames : [''];
}

function getOrderSections(order) {
  if (Array.isArray(order?.sections)) return order.sections;
  if (Array.isArray(order?.orderSections)) return order.orderSections;
  return [];
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatStoreMoney(amount) {
  const numeric = Number(amount || 0);
  return new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency: config.currency?.storeCurrency || 'KRW',
    maximumFractionDigits: 0,
  }).format(Math.round(numeric));
}

function getOrderSizeLabel(amount) {
  return Number(amount || 0) >= BIG_FISH_THRESHOLD_KRW
    ? '🐋 BIG FISH ₩₩!'
    : '🐟 small fish ₩₩';
}

function getPaymentMethodLabel(order) {
  const payments = Array.isArray(order?.payments) ? order.payments : [];
  const candidates = [
    payments[0]?.method,
    order?.paymentMethod,
    payments[0]?.pgName,
  ];

  for (const candidate of candidates) {
    const value = asString(candidate);
    if (value) return value;
  }

  return '';
}

function summarizeOrderPayment(order) {
  const hasCompletedPayment = normalizeImwebPayments([order]).some(payment => payment.type === 'approval');
  const paymentStatuses = [...new Set(
    (Array.isArray(order?.payments) ? order.payments : [])
      .map(payment => asString(payment?.paymentStatus).toUpperCase())
      .filter(Boolean)
  )];
  const paymentMethod = getPaymentMethodLabel(order);
  const rawStatus = paymentStatuses.join(', ');

  if (hasCompletedPayment) {
    return {
      paymentState: 'paid',
      paymentLabel: 'Paid confirmed',
      paymentMethod,
      paymentStatusDetail: rawStatus,
    };
  }

  const hasAwaitingStatus = paymentStatuses.some(status => (
    status.includes('WAIT')
      || status.includes('PENDING')
      || status.includes('READY')
      || status.includes('REQUEST')
      || status.includes('PREPARATION')
      || status.includes('OVERDUE')
  ));

  return {
    paymentState: hasAwaitingStatus ? 'awaiting_check' : 'check_now',
    paymentLabel: hasAwaitingStatus ? 'Awaiting payment check' : 'Check payment now',
    paymentMethod,
    paymentStatusDetail: rawStatus,
  };
}

function summarizeTerminalOrderState(order) {
  const statuses = [
    order?.orderStatus,
    ...getOrderSections(order).map(section => section?.orderSectionStatus || section?.status),
  ].map(value => asString(value).toUpperCase()).filter(Boolean);

  if (statuses.some(status => status.includes('REFUND'))) {
    return { paymentState: 'refunded', paymentLabel: 'Refunded in Imweb' };
  }
  if (statuses.some(status => status.includes('RETURN'))) {
    return { paymentState: 'returned', paymentLabel: 'Returned in Imweb' };
  }
  if (statuses.some(status => status.includes('EXCHANGE'))) {
    return { paymentState: 'exchanged', paymentLabel: 'Exchanged in Imweb' };
  }
  if (statuses.some(status => status.includes('CANCEL'))) {
    return { paymentState: 'cancelled', paymentLabel: 'Cancelled in Imweb' };
  }
  return { paymentState: 'closed', paymentLabel: 'Closed in Imweb' };
}

function hasRecognizedPayment(order) {
  return normalizeImwebPayments([order]).some(payment => payment.type === 'approval');
}

function isTerminalOrderState(order) {
  const orderStatus = asString(order?.orderStatus).toUpperCase();
  if (TERMINAL_ORDER_STATUS_TOKENS.some(token => orderStatus.includes(token))) {
    return true;
  }

  const sectionStatuses = getOrderSections(order)
    .map(section => asString(section?.orderSectionStatus || section?.status).toUpperCase())
    .filter(Boolean);

  return sectionStatuses.some(status => (
    TERMINAL_ORDER_STATUS_TOKENS.some(token => status.includes(token))
  ));
}

function buildOrderNotificationResult(order, overrides = {}) {
  const orderDate = order?.wtime ? formatDateInTimeZone(order.wtime) : '';
  const customerName = asString(order?.ordererName || order?.memberName);
  const productNames = getOrderProductNames(order).filter(Boolean);
  const contact = getOrderContactSnapshot(order);
  const deliveryAddress = contact.address || '';
  const firstSection = getOrderSections(order)[0] || null;
  const deliveryNote = asString(firstSection?.delivery?.memo || firstSection?.pickupMemo);
  const cashTotals = getOrderCashTotals(order);
  const paymentSummary = summarizeOrderPayment(order);
  const orderValue = Number(
    order?.totalPrice
      || cashTotals.netPaidAmount
      || cashTotals.approvedAmount
      || 0
  );

  return {
    orderNo: asString(order?.orderNo),
    orderDate,
    customerName,
    productNames,
    productLines: buildNotificationProductLines(order),
    customerPhone: contact.receiverPhone || contact.ordererPhone,
    deliveryAddress,
    deliveryNote,
    approvedAmount: cashTotals.approvedAmount,
    netRevenue: cashTotals.netPaidAmount,
    refundedAmount: cashTotals.refundedAmount,
    orderValue,
    ...paymentSummary,
    ...overrides,
  };
}

function buildClosedOrderNotificationResult(order, overrides = {}) {
  return buildOrderNotificationResult(order, {
    ...summarizeTerminalOrderState(order),
    notificationStage: 'order_closed',
    ...overrides,
  });
}

function buildNewOrderNotification(result) {
  const isClosed = result?.notificationStage === 'order_closed'
    || ['cancelled', 'returned', 'exchanged', 'refunded', 'closed'].includes(asString(result?.paymentState).toLowerCase());
  const isCompleted = result?.paymentState === 'paid' || result?.notificationStage === 'payment_confirmed';
  const orderValue = Number(result?.orderValue || result?.netRevenue || result?.approvedAmount || 0);
  const productLines = Array.isArray(result?.productNames) && result.productNames.length > 0
    ? result.productNames.map(line => `• ${escapeHtml(line)}`).join('\n')
    : '• Product name unavailable';
  const paymentLabel = [
    result?.paymentLabel,
    result?.paymentMethod,
  ].filter(Boolean).map(value => escapeHtml(value)).join(' · ');
  const checklistLine = isClosed
    ? `Checklist: ${escapeHtml(getClosedChecklistLabel(result))}`
    : isCompleted
      ? 'Checklist: Payment recognized in Imweb ✅'
      : 'Checklist: Check payment in Imweb ☐';

  const sections = [
    isClosed
      ? `❌ <b>${escapeHtml(getClosedCardTitle(result))}</b>`
      : isCompleted
        ? '✅ <b>New Imweb Order</b>'
        : '🛎️ <b>New Imweb Order</b> 🎉🎉',
    '',
    `Order: ${escapeHtml(result?.orderNo || 'Unavailable')}`,
    `Date: ${escapeHtml(result?.orderDate || 'Unavailable')}`,
    `Customer: ${escapeHtml(result?.customerName || 'Unavailable')}`,
    `Revenue: ${escapeHtml(formatStoreMoney(orderValue))} · ${escapeHtml(getOrderSizeLabel(orderValue))}`,
    `Payment: ${paymentLabel || (isClosed ? getClosedPaymentFallback(result) : (isCompleted ? 'Paid confirmed' : 'Check payment now'))}`,
    checklistLine,
  ];

  if (isCompleted && result?.sheetName) {
    sections.push(`✅ COGS logged in ${escapeHtml(result.sheetName)}`);
  }

  sections.push('', 'Products:', productLines);
  return sections.join('\n');
}

function buildAutofillNotification(result) {
  const revenue = Number(result?.netRevenue || result?.approvedAmount || 0);
  const productLines = Array.isArray(result?.productNames) && result.productNames.length > 0
    ? result.productNames.map(line => `• ${escapeHtml(line)}`).join('\n')
    : '• Product name unavailable';

  const sections = [
    '✅ <b>Paid Imweb Order Logged</b>',
    '',
    `Order: ${escapeHtml(result?.orderNo || 'Unavailable')}`,
    `Date: ${escapeHtml(result?.orderDate || 'Unavailable')}`,
    `Customer: ${escapeHtml(result?.customerName || 'Unavailable')}`,
    `Revenue: ${escapeHtml(formatStoreMoney(revenue))} · ${escapeHtml(getOrderSizeLabel(revenue))}`,
    `Sheet: ${escapeHtml(result?.sheetName || 'Unavailable')}`,
    `Rows appended: ${escapeHtml(String(result?.rowCount || 0))}`,
    '',
    'Products:',
    productLines,
  ];

  return sections.join('\n');
}

function buildAutofillPrivateNotification(result) {
  const productLines = Array.isArray(result?.productLines) && result.productLines.length > 0
    ? result.productLines.map(line => `• ${escapeHtml(line)}`).join('\n')
    : '• Product name unavailable';

  const spoiler = value => (
    value
      ? `<tg-spoiler>${escapeHtml(value)}</tg-spoiler>`
      : `<tg-spoiler>${escapeHtml('Unavailable')}</tg-spoiler>`
  );

  const sections = [
    '🔒 <b>Customer Details</b>',
    '',
    '<i>Tap the hidden fields to reveal customer details.</i>',
    '',
    '<b>Order ID</b>',
    spoiler(result?.orderNo),
    '',
    '<b>Name</b>',
    spoiler(result?.customerName),
    '',
    '<b>Phone number</b>',
    spoiler(result?.customerPhone),
    '',
    '<b>Address</b>',
    spoiler(result?.deliveryAddress),
  ];

  if (result?.deliveryNote) {
    sections.push('', '<b>Delivery note</b>', spoiler(result.deliveryNote));
  }

  sections.push('', '<b>Products</b>', productLines);

  return sections.join('\n');
}

function sanitizeAutofillResultForResponse(result) {
  if (!result || typeof result !== 'object') {
    return result;
  }

  return {
    ...result,
    customerName: result.customerName ? maskName(result.customerName) : result.customerName,
    customerPhone: undefined,
    deliveryAddress: undefined,
    deliveryNote: undefined,
  };
}

function getItemOptionDetails(item) {
  const productInfo = item?.productInfo || {};
  const rawDetails = [
    asString(productInfo.optionName),
    asString(productInfo.optionValue),
    asString(productInfo.optionDetailName),
    asString(productInfo.optionDetailCode),
    asString(productInfo.customProdCode),
  ].filter(Boolean);

  const uniqueDetails = [...new Set(rawDetails)];
  return uniqueDetails.length > 0 ? uniqueDetails.join(' / ') : '';
}

function buildNotificationProductLines(order) {
  return getOrderItems(order).map(item => {
    const productName = asString(item?.productInfo?.prodName || item?.productName || item?.name) || 'Product name unavailable';
    const optionDetails = getItemOptionDetails(item);
    const qty = Math.max(1, Number(item?.qty || 1));
    const qtyLabel = qty > 1 ? ` x${qty}` : '';
    return optionDetails
      ? `${productName}${qtyLabel} (${optionDetails})`
      : `${productName}${qtyLabel}`;
  });
}

function buildCompactDeliveryDetails(details = {}) {
  const primaryPhone = asString(details.receiverPhone || details.customerPhone);
  const combinedAddress = [asString(details.zipcode), asString(details.address)]
    .filter(Boolean)
    .join(' ')
    .trim();
  const fields = [
    ['receiver', details.receiverName],
    ['phone', primaryPhone],
    ['address', combinedAddress],
    ['delivery note', details.deliveryNote],
  ].filter(([, value]) => asString(value));

  return fields.map(([label, value]) => `${label}: ${asString(value)}`).join(' | ');
}

function getOrderAutofillTimestamp(order) {
  const approvals = normalizeImwebPayments([order])
    .filter(payment => payment.type === 'approval')
    .map(payment => payment.completedAt)
    .filter(Boolean);

  const candidates = [
    approvals.length > 0 ? approvals[approvals.length - 1] : null,
    order?.mtime,
    order?.wtime,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return null;
}

function parseTimestamp(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function resolveWindowStart(options = {}) {
  const sinceTime = parseTimestamp(options.sinceTime);
  if (sinceTime) return sinceTime;

  const lookbackDays = Number.isFinite(options.lookbackDays)
    ? Number(options.lookbackDays)
    : DEFAULT_POLL_LOOKBACK_DAYS;
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0) {
    return null;
  }

  return new Date(Date.now() - (lookbackDays * 24 * 60 * 60 * 1000));
}

function resolveNewOrderBackfillWindowStart(options = {}) {
  const broadLookbackStart = new Date(Date.now() - (MAX_NEW_ORDER_BACKFILL_HOURS * 60 * 60 * 1000));
  const sinceTime = parseTimestamp(options.sinceTime);

  if (!(broadLookbackStart instanceof Date) || Number.isNaN(broadLookbackStart.getTime())) {
    return sinceTime;
  }

  if (!(sinceTime instanceof Date) || Number.isNaN(sinceTime.getTime())) {
    return broadLookbackStart;
  }

  // Rescue missed new-order alerts across a bounded recent window so stale unpaid orders
  // do not suddenly appear as new.
  return new Date(Math.min(broadLookbackStart.getTime(), sinceTime.getTime()));
}

function getClosedCardTitle(result) {
  switch (asString(result?.paymentState).toLowerCase()) {
    case 'refunded':
      return 'Imweb Order Refunded';
    case 'returned':
      return 'Imweb Order Returned';
    case 'exchanged':
      return 'Imweb Order Exchanged';
    case 'closed':
      return 'Imweb Order Closed';
    case 'cancelled':
    default:
      return 'Imweb Order Cancelled';
  }
}

function getClosedChecklistLabel(result) {
  switch (asString(result?.paymentState).toLowerCase()) {
    case 'refunded':
      return 'Order refunded in Imweb ❌';
    case 'returned':
      return 'Order returned in Imweb ❌';
    case 'exchanged':
      return 'Order exchanged in Imweb ❌';
    case 'closed':
      return 'Order closed in Imweb ❌';
    case 'cancelled':
    default:
      return 'Order cancelled in Imweb ❌';
  }
}

function getClosedPaymentFallback(result) {
  switch (asString(result?.paymentState).toLowerCase()) {
    case 'refunded':
      return 'Refunded in Imweb';
    case 'returned':
      return 'Returned in Imweb';
    case 'exchanged':
      return 'Exchanged in Imweb';
    case 'closed':
      return 'Closed in Imweb';
    case 'cancelled':
    default:
      return 'Cancelled in Imweb';
  }
}

function isRecentEnough(date, windowStart) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return false;
  }
  if (!(windowStart instanceof Date) || Number.isNaN(windowStart.getTime())) {
    return true;
  }

  return date.getTime() >= windowStart.getTime();
}

function isEligibleRecentOrder(order, options = {}) {
  const orderNo = asString(order?.orderNo);
  if (!orderNo) {
    return false;
  }

  const orderStatus = asString(order?.orderStatus).toUpperCase();
  const hasPreparedSection = getOrderSections(order).some(section => (
    asString(section?.orderSectionStatus || section?.status).toUpperCase() === 'PRODUCT_PREPARATION'
  ));
  const hasCompletedPayment = normalizeImwebPayments([order]).some(payment => payment.type === 'approval');
  const isOperationallyEligible = hasPreparedSection || (orderStatus === 'OPEN' && hasCompletedPayment);

  if (!isOperationallyEligible) {
    return false;
  }

  const cashTotals = getOrderCashTotals(order);
  if (!cashTotals.approvedAmount && !hasCompletedPayment) {
    return false;
  }

  const effectiveTimestamp = getOrderAutofillTimestamp(order);
  return isRecentEnough(effectiveTimestamp, resolveWindowStart(options));
}

function buildRowsForOrder(order, nextSequenceNo) {
  const orderDate = order?.wtime ? formatDateInTimeZone(order.wtime) : '';
  const customerName = asString(order?.ordererName || order?.memberName);
  const orderNo = asString(order?.orderNo);
  const productNames = getOrderProductNames(order);
  const contact = getOrderContactSnapshot(order);
  const firstSection = getOrderSections(order)[0] || null;
  const deliveryNote = asString(firstSection?.delivery?.memo || firstSection?.pickupMemo);
  const customerPhone = contact.ordererPhone;
  const receiverName = contact.receiverName || customerName;
  const receiverPhone = contact.receiverPhone || customerPhone;
  const zipcode = contact.zipcode;
  const address = contact.address;
  const compactDeliveryDetails = buildCompactDeliveryDetails({
    deliveryNote,
    customerName,
    customerPhone,
    receiverName,
    receiverPhone,
    zipcode,
    address,
  });

  return productNames.map((productName, index) => ([
    index === 0 ? String(nextSequenceNo) : '',
    index === 0 ? orderDate : '',
    index === 0 ? customerName : '',
    index === 0 ? orderNo : '',
    '',
    '',
    productName,
    '',
    '',
    'FALSE',
    'FALSE',
    '',
    index === 0 ? compactDeliveryDetails : '',
    '',
    '',
    '',
    '',
  ]));
}

async function appendRowsToSheet(target, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('No rows to append');
  }

  const token = await getGoogleAccessToken();
  const escapedSheetName = String(target.sheetName || target.label || '').replace(/'/g, "''");
  const range = encodeURIComponent(`'${escapedSheetName}'!A:Q`);
  const url = `${SHEETS_API_BASE}/${encodeURIComponent(config.cogs.spreadsheetId)}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      majorDimension: 'ROWS',
      values: rows,
    }),
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`Google Sheets append failed: ${payload?.error?.message || response.status}`);
  }

  return payload;
}

function shouldSendNewOrderNotification(order) {
  const normalizedOrderNo = asString(order?.orderNo);
  if (!normalizedOrderNo) return false;
  if (isTerminalOrderState(order)) return false;
  if (hasRecognizedPayment(order)) return false;
  return true;
}

function getOrderCreationTimestamp(order) {
  return parseTimestamp(order?.wtime);
}

function shouldBackfillNewOrderNotification(order) {
  const normalizedOrderNo = asString(order?.orderNo);
  if (!normalizedOrderNo) {
    return false;
  }

  const notification = getNotifiedOrderMetadata(normalizedOrderNo);
  if (notification?.notificationStage === 'payment_confirmed' || notification?.notificationStage === 'order_closed') {
    return false;
  }

  if (notification?.messageId) {
    return false;
  }

  return shouldSendNewOrderNotification(order);
}

function shouldCloseExistingOrderNotification(order) {
  const normalizedOrderNo = asString(order?.orderNo);
  if (!normalizedOrderNo || !isTerminalOrderState(order)) {
    return false;
  }

  const notification = getNotifiedOrderMetadata(normalizedOrderNo);
  if (!notification) {
    return false;
  }

  const stage = asString(notification.notificationStage);
  if (stage === 'payment_confirmed' || stage === 'order_closed') {
    return false;
  }

  return true;
}

function collectRecentNewOrderNotifications(orders, options = {}) {
  const windowStart = resolveNewOrderBackfillWindowStart(options);
  const seenOrderNos = new Set();

  const eligibleOrders = (Array.isArray(orders) ? orders : [])
    .filter(order => {
      const orderNo = asString(order?.orderNo);
      if (!orderNo || seenOrderNos.has(orderNo)) {
        return false;
      }

      if (!shouldBackfillNewOrderNotification(order)) {
        return false;
      }

      const createdAt = getOrderCreationTimestamp(order);
      if (!isRecentEnough(createdAt, windowStart)) {
        return false;
      }

      seenOrderNos.add(orderNo);
      return true;
    })
    .sort((left, right) => {
      const leftTime = getOrderCreationTimestamp(left)?.getTime() || 0;
      const rightTime = getOrderCreationTimestamp(right)?.getTime() || 0;
      return leftTime - rightTime;
    });

  const pending = eligibleOrders.map(order => buildOrderNotificationResult(order, {
    notificationKind: 'new_order',
    notificationSource: 'scan_backstop',
  }));

  return {
    ok: true,
    status: 'ok',
    windowStartAt: windowStart ? windowStart.toISOString() : null,
    eligibleOrders: eligibleOrders.length,
    pending,
  };
}

function collectRecentClosedOrderNotifications(orders) {
  const seenOrderNos = new Set();
  const pending = [];

  for (const order of Array.isArray(orders) ? orders : []) {
    const orderNo = asString(order?.orderNo);
    if (!orderNo || seenOrderNos.has(orderNo) || !shouldCloseExistingOrderNotification(order)) {
      continue;
    }

    seenOrderNos.add(orderNo);
    pending.push(buildClosedOrderNotificationResult(order, {
      notificationKind: 'order_closed',
      notificationSource: 'scan_backstop_terminal',
    }));
  }

  return {
    ok: true,
    status: 'ok',
    eligibleOrders: pending.length,
    pending,
  };
}

async function syncOrderToCogsSheet(order, options = {}) {
  if (!isConfigured()) {
    return { ok: false, status: 'disabled', reason: 'COGS autofill is not configured' };
  }

  const normalizedOrderNo = asString(order?.orderNo);
  if (!normalizedOrderNo) {
    throw new Error('Order is missing orderNo');
  }

  const summary = buildOrderNotificationResult(order);
  if (!summary.orderDate) {
    throw new Error(`Order ${normalizedOrderNo} is missing wtime`);
  }
  const alreadyNotified = wasOrderNotified(normalizedOrderNo);

  const importedMetadata = getImportedOrderMetadata(normalizedOrderNo);
  const target = options.target || await resolveTargetSheet(summary.orderDate);
  const existingRows = options.existingRows || await getRowsForTarget(target, options.sheetCache);
  await ensureOptionalHeaders(target, existingRows);
  if (hasOrderNumber(existingRows, normalizedOrderNo)) {
    markOrderImported(normalizedOrderNo, {
      source: importedMetadata ? (importedMetadata.source || 'sheet_duplicate') : 'sheet_duplicate',
      sheetName: target.sheetName,
      orderDate: summary.orderDate,
    });
    return {
      ...summary,
      ok: true,
      status: 'duplicate',
      reason: importedMetadata ? 'order already imported' : 'order already exists in sheet',
      alreadyNotified,
      sheetName: target.sheetName,
    };
  }

  const nextSequenceNo = getNextSequenceNumber(existingRows);
  const rows = buildRowsForOrder(order, nextSequenceNo);
  await appendRowsToSheet(target, rows);
  setRowsForTarget(target, existingRows.concat(rows), options.sheetCache);
  markOrderImported(normalizedOrderNo, {
    source: importedMetadata ? 'recovered_append' : 'append',
    sheetName: target.sheetName,
    orderDate: summary.orderDate,
    rowCount: rows.length,
  });

  return {
    ...summary,
    ok: true,
    status: 'appended',
    alreadyNotified,
    sheetName: target.sheetName,
    rowCount: rows.length,
    sequenceNo: nextSequenceNo,
  };
}

async function syncImwebOrderToCogs(orderNo) {
  const order = await imweb.getOrder(orderNo);
  return syncOrderToCogsSheet(order);
}

async function syncRecentOrdersToCogs(orders, options = {}) {
  if (!isConfigured()) {
    return {
      ok: false,
      status: 'disabled',
      reason: 'COGS autofill is not configured',
      lookbackDays: options.lookbackDays ?? DEFAULT_POLL_LOOKBACK_DAYS,
      eligibleOrders: 0,
      appended: [],
      duplicates: [],
      skipped: [],
    };
  }

  const lookbackDays = Number.isFinite(options.lookbackDays)
    ? Number(options.lookbackDays)
    : DEFAULT_POLL_LOOKBACK_DAYS;
  const windowStart = resolveWindowStart(options);

  const eligibleOrders = (Array.isArray(orders) ? orders : [])
    .filter(order => isEligibleRecentOrder(order, { lookbackDays, sinceTime: windowStart }))
    .sort((left, right) => {
      const leftTime = getOrderAutofillTimestamp(left)?.getTime() || 0;
      const rightTime = getOrderAutofillTimestamp(right)?.getTime() || 0;
      return leftTime - rightTime;
    });

  const appended = [];
  const duplicates = [];
  const skipped = [];
  const errors = [];
  const targetCache = new Map();
  const sheetCache = new Map();

  for (const order of eligibleOrders) {
    try {
      const orderDate = order?.wtime ? formatDateInTimeZone(order.wtime) : '';
      const targetKey = String(orderDate || '').slice(0, 7);
      let target = targetCache.get(targetKey);
      if (!target) {
        target = await resolveTargetSheet(orderDate);
        targetCache.set(targetKey, target);
      }

      const result = await syncOrderToCogsSheet(order, {
        target,
        sheetCache,
      });
      if (result?.status === 'appended') {
        appended.push(result);
      } else if (result?.status === 'duplicate') {
        duplicates.push(result);
      } else {
        skipped.push(result);
      }
    } catch (err) {
      errors.push({
        orderNo: asString(order?.orderNo),
        error: err.message,
      });
    }
  }

  return {
    ok: true,
    status: 'ok',
    lookbackDays,
    windowStartAt: windowStart ? windowStart.toISOString() : null,
    eligibleOrders: eligibleOrders.length,
    appended,
    duplicates,
    skipped,
    errors,
  };
}

module.exports = {
  isConfigured,
  extractMonthNumber,
  buildRowsForOrder,
  getNextSequenceNumber,
  hasOrderNumber,
  findTargetForMonth,
  resolveTargetSheet,
  buildNewOrderNotification,
  buildAutofillNotification,
  buildAutofillPrivateNotification,
  sanitizeAutofillResultForResponse,
  getImportedOrderMetadata,
  getNotifiedOrderMetadata,
  getOrderNotificationDiagnostics,
  recordOrderNotificationDelivery,
  markOrderNotificationCompleted,
  markOrderNotificationClosed,
  collectRecentNewOrderNotifications,
  collectRecentClosedOrderNotifications,
  syncOrderToCogsSheet,
  syncImwebOrderToCogs,
  syncRecentOrdersToCogs,
};
