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
const BIG_FISH_THRESHOLD_KRW = 200000;
const OPTIONAL_HEADER_LABELS = new Map([
  [11, '배송메모'],
  [12, '주문자 연락처'],
  [13, '수령인 이름'],
  [14, '수령인 연락처'],
  [15, '우편번호'],
  [16, '주소'],
]);
const SUPPORTED_EVENTS = new Set([
  'ORDER_DEPOSIT_COMPLETE',
  'ORDER_PRODUCT_PREPARATION',
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

function getWebhookToken() {
  return asString(config.cogs.autofill.webhookToken);
}

function createEmptyState() {
  return { importedOrders: {} };
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

function wasOrderImported(orderNo) {
  return Boolean(getImportedOrderMetadata(orderNo));
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
  return (Array.isArray(rows) ? rows : []).reduce((max, row) => {
    const candidate = Number.parseInt(asString(row?.[0]), 10);
    return Number.isFinite(candidate) ? Math.max(max, candidate) : max;
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

  for (const [columnIndex, label] of OPTIONAL_HEADER_LABELS.entries()) {
    if (asString(headerRow[columnIndex])) {
      continue;
    }

    updates.push({
      range: `'${String(target.sheetName || target.label || '').replace(/'/g, "''")}'!${toColumnLabel(columnIndex + 1)}1`,
      majorDimension: 'ROWS',
      values: [[label]],
    });
    headerRow[columnIndex] = label;
  }

  if (updates.length === 0) {
    return { updated: false, count: 0 };
  }

  await updateSheetValues(updates);

  if (Array.isArray(rows)) {
    if (!Array.isArray(rows[0])) {
      rows[0] = [];
    }
    for (const [columnIndex, label] of OPTIONAL_HEADER_LABELS.entries()) {
      if (!rows[0][columnIndex]) {
        rows[0][columnIndex] = label;
      }
    }
  }

  return { updated: true, count: updates.length };
}

function hasOrderNumber(rows, orderNo) {
  const normalizedOrderNo = asString(orderNo);
  if (!normalizedOrderNo) return false;

  return (Array.isArray(rows) ? rows : []).some(row => asString(row?.[3]) === normalizedOrderNo);
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

function buildAutofillNotification(result) {
  const revenue = Number(result?.netRevenue || result?.approvedAmount || 0);
  const productLines = Array.isArray(result?.productNames) && result.productNames.length > 0
    ? result.productNames.map(line => `• ${escapeHtml(line)}`).join('\n')
    : '• Product name unavailable';

  const sections = [
    '🧾 <b>New Imweb Order Logged</b>',
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
    index === 0 ? deliveryNote : '',
    index === 0 ? customerPhone : '',
    index === 0 ? receiverName : '',
    index === 0 ? receiverPhone : '',
    index === 0 ? zipcode : '',
    index === 0 ? address : '',
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

function extractWebhookEventName(payload) {
  const candidates = [
    payload?.eventName,
    payload?.event,
    payload?.eventType,
    payload?.type,
    payload?.topic,
    payload?.code,
    payload?.webhookEvent,
    payload?.data?.eventName,
    payload?.data?.event,
    payload?.data?.eventType,
    payload?.payload?.eventName,
    payload?.payload?.event,
    payload?.payload?.eventType,
  ];

  for (const candidate of candidates) {
    const value = asString(candidate);
    if (value) return value.toUpperCase();
  }

  return '';
}

function extractOrderNoFromWebhookPayload(payload) {
  const candidates = [
    payload?.orderNo,
    payload?.order_no,
    payload?.data?.orderNo,
    payload?.data?.order_no,
    payload?.order?.orderNo,
    payload?.order?.order_no,
    payload?.data?.order?.orderNo,
    payload?.payload?.orderNo,
  ];

  for (const candidate of candidates) {
    const value = asString(candidate);
    if (value) return value;
  }

  return '';
}

function extractInlineOrder(payload) {
  const candidates = [
    payload?.order,
    payload?.data?.order,
    payload?.data,
  ];

  return candidates.find(candidate => candidate && typeof candidate === 'object' && candidate.orderNo) || null;
}

async function syncOrderToCogsSheet(order, options = {}) {
  if (!isConfigured()) {
    return { ok: false, status: 'disabled', reason: 'COGS autofill is not configured' };
  }

  const normalizedOrderNo = asString(order?.orderNo);
  if (!normalizedOrderNo) {
    throw new Error('Order is missing orderNo');
  }

  const orderDate = order?.wtime ? formatDateInTimeZone(order.wtime) : '';
  if (!orderDate) {
    throw new Error(`Order ${normalizedOrderNo} is missing wtime`);
  }
  const customerName = asString(order?.ordererName || order?.memberName);
  const productNames = getOrderProductNames(order).filter(Boolean);
  const contact = getOrderContactSnapshot(order);
  const deliveryAddress = contact.address || '';
  const firstSection = getOrderSections(order)[0] || null;
  const deliveryNote = asString(firstSection?.delivery?.memo || firstSection?.pickupMemo);
  const cashTotals = getOrderCashTotals(order);

  const importedMetadata = getImportedOrderMetadata(normalizedOrderNo);
  const target = options.target || await resolveTargetSheet(orderDate);
  const existingRows = options.existingRows || await getRowsForTarget(target, options.sheetCache);
  await ensureOptionalHeaders(target, existingRows);
  if (hasOrderNumber(existingRows, normalizedOrderNo)) {
    markOrderImported(normalizedOrderNo, {
      source: importedMetadata ? (importedMetadata.source || 'sheet_duplicate') : 'sheet_duplicate',
      sheetName: target.sheetName,
      orderDate,
    });
    return {
      ok: true,
      status: 'duplicate',
      reason: importedMetadata ? 'order already imported' : 'order already exists in sheet',
      orderNo: normalizedOrderNo,
      orderDate,
      customerName,
      productNames,
      productLines: buildNotificationProductLines(order),
      customerPhone: contact.receiverPhone || contact.ordererPhone,
      deliveryAddress,
      deliveryNote,
      sheetName: target.sheetName,
      approvedAmount: cashTotals.approvedAmount,
      netRevenue: cashTotals.netPaidAmount,
      refundedAmount: cashTotals.refundedAmount,
    };
  }

  const nextSequenceNo = getNextSequenceNumber(existingRows);
  const rows = buildRowsForOrder(order, nextSequenceNo);
  await appendRowsToSheet(target, rows);
  setRowsForTarget(target, existingRows.concat(rows), options.sheetCache);
  markOrderImported(normalizedOrderNo, {
    source: importedMetadata ? 'recovered_append' : 'append',
    sheetName: target.sheetName,
    orderDate,
    rowCount: rows.length,
  });

  return {
    ok: true,
    status: 'appended',
    orderNo: normalizedOrderNo,
    orderDate,
    customerName,
    productNames,
    productLines: buildNotificationProductLines(order),
    customerPhone: contact.receiverPhone || contact.ordererPhone,
    deliveryAddress,
    deliveryNote,
    sheetName: target.sheetName,
    rowCount: rows.length,
    sequenceNo: nextSequenceNo,
    approvedAmount: cashTotals.approvedAmount,
    netRevenue: cashTotals.netPaidAmount,
    refundedAmount: cashTotals.refundedAmount,
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

async function handleWebhookPayload(payload) {
  const eventName = extractWebhookEventName(payload);
  if (!SUPPORTED_EVENTS.has(eventName)) {
    return { ok: true, status: 'ignored', reason: `unsupported event: ${eventName || 'unknown'}` };
  }

  const orderNo = extractOrderNoFromWebhookPayload(payload);
  if (!orderNo) {
    throw new Error('Webhook payload did not include orderNo');
  }

  const inlineOrder = extractInlineOrder(payload);
  if (inlineOrder && asString(inlineOrder.orderNo) === asString(orderNo)) {
    return syncOrderToCogsSheet(inlineOrder);
  }

  return syncImwebOrderToCogs(orderNo);
}

module.exports = {
  isConfigured,
  getWebhookToken,
  extractMonthNumber,
  extractWebhookEventName,
  extractOrderNoFromWebhookPayload,
  buildRowsForOrder,
  getNextSequenceNumber,
  hasOrderNumber,
  findTargetForMonth,
  resolveTargetSheet,
  buildAutofillNotification,
  buildAutofillPrivateNotification,
  sanitizeAutofillResultForResponse,
  getImportedOrderMetadata,
  syncOrderToCogsSheet,
  syncImwebOrderToCogs,
  syncRecentOrdersToCogs,
  handleWebhookPayload,
};
