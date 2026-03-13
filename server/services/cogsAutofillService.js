const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const runtimePaths = require('../runtime/paths');
const cogsClient = require('../modules/cogsClient');
const imweb = require('../modules/imwebClient');
const { getOrderItems } = require('../domain/imwebAttribution');
const { formatDateInTimeZone } = require('../domain/time');

const STATE_FILE = path.join(runtimePaths.dataDir, 'cogs_autofill_state.json');
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SUPPORTED_EVENTS = new Set(['ORDER_PRODUCT_PREPARATION']);

let googleAccessToken = null;
let googleAccessTokenExpiry = 0;

function asString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

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
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
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

function wasOrderImported(orderNo) {
  const normalizedOrderNo = asString(orderNo);
  if (!normalizedOrderNo) return false;
  const state = loadState();
  return Boolean(state.importedOrders[normalizedOrderNo]);
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

function getNextSequenceNumber(rows) {
  return (Array.isArray(rows) ? rows : []).reduce((max, row) => {
    const candidate = Number.parseInt(asString(row?.[0]), 10);
    return Number.isFinite(candidate) ? Math.max(max, candidate) : max;
  }, 0) + 1;
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

function buildRowsForOrder(order, nextSequenceNo) {
  const orderDate = order?.wtime ? formatDateInTimeZone(order.wtime) : '';
  const customerName = asString(order?.ordererName || order?.memberName);
  const orderNo = asString(order?.orderNo);
  const productNames = getOrderProductNames(order);

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
  ]));
}

async function appendRowsToSheet(target, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('No rows to append');
  }

  const token = await getGoogleAccessToken();
  const escapedSheetName = String(target.sheetName || target.label || '').replace(/'/g, "''");
  const range = encodeURIComponent(`'${escapedSheetName}'!A:L`);
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
    payload?.type,
    payload?.topic,
    payload?.code,
    payload?.webhookEvent,
    payload?.data?.eventName,
    payload?.data?.event,
    payload?.payload?.eventName,
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

  if (wasOrderImported(normalizedOrderNo)) {
    return { ok: true, status: 'duplicate', reason: 'order already imported' };
  }

  const orderDate = order?.wtime ? formatDateInTimeZone(order.wtime) : '';
  if (!orderDate) {
    throw new Error(`Order ${normalizedOrderNo} is missing wtime`);
  }
  const customerName = asString(order?.ordererName || order?.memberName);
  const productNames = getOrderProductNames(order).filter(Boolean);

  const target = options.target || await resolveTargetSheet(orderDate);
  const existingRows = await fetchExistingRows(target);
  if (hasOrderNumber(existingRows, normalizedOrderNo)) {
    markOrderImported(normalizedOrderNo, {
      source: 'sheet_duplicate',
      sheetName: target.sheetName,
      orderDate,
    });
    return {
      ok: true,
      status: 'duplicate',
      reason: 'order already exists in sheet',
      orderNo: normalizedOrderNo,
      orderDate,
      customerName,
      productNames,
      sheetName: target.sheetName,
    };
  }

  const nextSequenceNo = getNextSequenceNumber(existingRows);
  const rows = buildRowsForOrder(order, nextSequenceNo);
  await appendRowsToSheet(target, rows);
  markOrderImported(normalizedOrderNo, {
    source: 'append',
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
    sheetName: target.sheetName,
    rowCount: rows.length,
    sequenceNo: nextSequenceNo,
  };
}

async function syncImwebOrderToCogs(orderNo) {
  const order = await imweb.getOrder(orderNo);
  return syncOrderToCogsSheet(order);
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
  syncOrderToCogsSheet,
  syncImwebOrderToCogs,
  handleWebhookPayload,
};
