const config = require('../config');
const { KST_TIME_ZONE, formatDateInTimeZone } = require('../domain/time');
const { asString } = require('../services/privacyService');

let cookieJar = new Map();
const connectionState = {
  lastCheckedAt: null,
  lastOkAt: null,
  lastErrorAt: null,
  lastError: null,
};

const PAYMENT_HISTORY_QUERY = 'asp_usr_pay_lst';
const PAYMENT_HISTORY_ROWS = '150';
const PAYMENT_HISTORY_PAGE = 1;
const PAYMENT_HISTORY_PAGE_SIZE = Number(PAYMENT_HISTORY_ROWS);
const PAYMENT_HISTORY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_PAYMENT_HISTORY_PAGES = 100;

function getPaywayConfig() {
  return config.payway || {};
}

function getConfiguredTerminalIds() {
  const terminalIds = asString(getPaywayConfig().mid)
    .split(/[\s,;]+/)
    .map(value => value.trim())
    .filter(Boolean);
  return [...new Set(terminalIds)];
}

function getPositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function recordConnectionOk() {
  const checkedAt = nowIso();
  connectionState.lastCheckedAt = checkedAt;
  connectionState.lastOkAt = checkedAt;
  connectionState.lastErrorAt = null;
  connectionState.lastError = null;
}

function recordConnectionError(err) {
  const checkedAt = nowIso();
  connectionState.lastCheckedAt = checkedAt;
  connectionState.lastErrorAt = checkedAt;
  connectionState.lastError = err?.message || String(err || 'unknown Payway connection error');
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function buildUrl(pathname) {
  const baseUrl = asString(getPaywayConfig().baseUrl) || 'https://payway.kr';
  return new URL(pathname || '/', baseUrl).toString();
}

function getConfiguredCookieHeader() {
  return asString(getPaywayConfig().sessionCookie);
}

function getCookieHeader() {
  const configuredCookie = getConfiguredCookieHeader();
  if (configuredCookie) {
    return configuredCookie;
  }

  return Array.from(cookieJar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function getSetCookieHeaders(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  const combined = headers.get('set-cookie');
  if (!combined) return [];

  return combined.split(/,(?=\s*[^;,=\s]+=[^;,]+)/);
}

function storeResponseCookies(headers) {
  for (const header of getSetCookieHeaders(headers)) {
    const cookiePair = asString(header).split(';')[0];
    const separatorIndex = cookiePair.indexOf('=');
    if (separatorIndex <= 0) continue;

    const name = cookiePair.slice(0, separatorIndex).trim();
    const value = cookiePair.slice(separatorIndex + 1).trim();
    if (name && value) {
      cookieJar.set(name, value);
    }
  }
}

function isEnabled() {
  return getPaywayConfig().enabled === true;
}

function hasDashboardCredentials() {
  const payway = getPaywayConfig();
  return Boolean(asString(payway.dashboardId) && asString(payway.dashboardPassword));
}

function isConfigured() {
  return Boolean(isEnabled() && (getConfiguredCookieHeader() || hasDashboardCredentials()));
}

function getStatus() {
  const payway = getPaywayConfig();
  const enabled = isEnabled();
  const dashboardCredentialsConfigured = hasDashboardCredentials();
  const sessionCookieConfigured = Boolean(getConfiguredCookieHeader());
  const configured = Boolean(enabled && (sessionCookieConfigured || dashboardCredentialsConfigured));
  const configuredWatchMinutes = getPositiveInteger(payway.watchMinutes, 10);
  const minimumWatchMinutes = getPositiveInteger(payway.minimumWatchMinutes, 60);
  let status = 'ready';
  let reason = null;

  if (!enabled) {
    status = 'disabled';
    reason = 'payway_disabled';
  } else if (!configured) {
    status = 'not_configured';
    reason = 'payway_not_configured';
  }

  return {
    status,
    enabled,
    configured,
    reason,
    midConfigured: getConfiguredTerminalIds().length > 0,
    dashboardCredentialsConfigured,
    sessionCookieConfigured,
    historyPath: asString(payway.historyPath) || '/pay',
    watchMinutes: Math.max(configuredWatchMinutes, minimumWatchMinutes),
    configuredWatchMinutes,
    minimumWatchMinutes,
    pollIntervalSeconds: getPositiveInteger(payway.pollIntervalSeconds, 30),
    matchLeadMinutes: getPositiveInteger(payway.matchLeadMinutes, 5),
    strictTerminalMatch: payway.strictTerminalMatch === true,
    lastCheckedAt: connectionState.lastCheckedAt,
    lastOkAt: connectionState.lastOkAt,
    lastErrorAt: connectionState.lastErrorAt,
    lastError: connectionState.lastError,
  };
}

function parseJsonMaybe(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function buildRequestHeaders(extraHeaders = {}) {
  const cookieHeader = getCookieHeader();
  return {
    ...extraHeaders,
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };
}

async function requestPayway(pathname, options = {}) {
  const timeoutMs = getPositiveInteger(getPaywayConfig().requestTimeoutMs, 10000);
  const timeout = createTimeoutSignal(timeoutMs);
  const response = await fetch(buildUrl(pathname), {
    method: options.method || 'GET',
    headers: buildRequestHeaders(options.headers || {}),
    body: options.body,
    redirect: options.redirect || 'follow',
    signal: timeout.signal,
  }).finally(timeout.clear);

  storeResponseCookies(response.headers);
  return response;
}

function clearSession() {
  cookieJar = new Map();
}

function describeLoginFailure(payload, status) {
  const result = asString(payload?.res);
  if (result && result !== 'OK') return result;
  const message = asString(payload?.msg || payload?.message || payload?.error);
  if (message) return message;
  if (status) return `HTTP ${status}`;
  return 'unknown Payway login failure';
}

async function login() {
  if (getConfiguredCookieHeader()) {
    return { ok: true, source: 'session_cookie' };
  }

  const payway = getPaywayConfig();
  if (!hasDashboardCredentials()) {
    throw new Error('Payway dashboard credentials are not configured');
  }

  const response = await requestPayway('/ajax.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      cmd: 'LOGIN',
      jData: JSON.stringify({
        uid: asString(payway.dashboardId),
        pw: asString(payway.dashboardPassword),
      }),
      rtnType: 'scalar',
    }),
    redirect: 'manual',
  });
  const text = await response.text();
  const payload = parseJsonMaybe(text);
  const next = asString(payload?.next).toUpperCase();

  if (response.ok && payload?.res === 'OK') {
    if (next === 'OTP' || next === 'OTP_SETUP') {
      throw new Error(`Payway login requires ${next}; dashboard polling cannot continue unattended`);
    }
    return { ok: true, source: 'dashboard_login', next: payload?.next || null };
  }

  throw new Error(`Payway login failed: ${describeLoginFailure(payload, response.status)}`);
}

async function ensureSession() {
  if (getConfiguredCookieHeader() || cookieJar.size > 0) {
    return { ok: true, source: getConfiguredCookieHeader() ? 'session_cookie' : 'cookie_jar' };
  }
  return login();
}

function decodeHtmlEntities(value) {
  return asString(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function cellToText(html) {
  return decodeHtmlEntities(
    asString(html)
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

function parseMoney(value) {
  const text = asString(value).replace(/,/g, '');
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return 0;
  const numeric = Number(match[0]);
  return Number.isFinite(numeric) ? numeric : 0;
}

function parseOptionalMoney(value) {
  const text = asString(value).replace(/,/g, '');
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const numeric = Number(match[0]);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatCompactPaywayTimestamp(value) {
  const match = asString(value).trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second = '00'] = match;
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function parsePaywayTimestamp(value) {
  const text = asString(value).trim();
  const normalizedText = formatCompactPaywayTimestamp(text) || text;
  const match = normalizedText.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second = '00'] = match;
  const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildTransactionId(payment) {
  return [
    asString(payment?.terminal),
    asString(payment?.approvalNo),
    asString(payment?.transactionAt),
    String(Number(payment?.transactionAmount || payment?.approvedAmount || 0)),
  ].filter(Boolean).join(':');
}

function setPaymentTimestampAndId(payment) {
  const parsedAt = parsePaywayTimestamp(payment.transactionAt);
  const compactTransactionAt = formatCompactPaywayTimestamp(payment.transactionAt);
  if (compactTransactionAt) {
    payment.transactionAt = compactTransactionAt;
  }
  payment.transactionAtIso = parsedAt ? parsedAt.toISOString() : null;
  payment.transactionId = buildTransactionId(payment);
}

function pickField(row, fieldNames) {
  for (const fieldName of fieldNames) {
    const value = row?.[fieldName];
    if (value != null && asString(value)) {
      return value;
    }
  }
  return '';
}

function normalizePaymentRow(cells) {
  const payment = {
    no: asString(cells[0]),
    merchantOrderNo: '',
    transactionAt: asString(cells[1]),
    status: asString(cells[2]),
    merchantName: asString(cells[3]),
    terminal: asString(cells[4]),
    acquirer: asString(cells[5]),
    installment: asString(cells[6]),
    maskedCardNumber: asString(cells[7]),
    approvalNo: asString(cells[8]),
    approvedAmount: parseMoney(cells[9]),
    cancelAmount: parseMoney(cells[10]),
    transactionAmount: parseMoney(cells[11]),
    feeAmount: parseOptionalMoney(cells[12]),
    settlementAmount: parseOptionalMoney(cells[13]),
    settlementDue: asString(cells[14]),
    pg: asString(cells[15]),
    agent: asString(cells[16]),
  };
  setPaymentTimestampAndId(payment);
  return payment;
}

function isCancelledJsonRow(row) {
  const cancelFlag = asString(pickField(row, ['cancel_yn', 'cancelYn', 'can_yn', 'cancelled'])).toUpperCase();
  const status = asString(pickField(row, ['pay_sta', 'status', 'pay_status', 'stat_nm']));
  return cancelFlag === '1' || cancelFlag === 'Y' || status.includes('취소');
}

function normalizePaymentJsonRow(row) {
  const transactionAt = asString(pickField(row, ['pay_dt', 'payDt', 'tr_dt', 'trDt', 'transactionAt']));
  const cancelled = isCancelledJsonRow(row);
  const amount = parseMoney(pickField(row, ['amt', 'pay_amt', 'payAmt', 'appr_amt', 'approvedAmount', 'transactionAmount']));
  const explicitCancelAmount = parseMoney(pickField(row, ['c_amt', 'cancel_amt', 'cancelAmount']));
  const cancelAmount = explicitCancelAmount || (cancelled ? amount : 0);
  const approvedAmount = cancelled ? 0 : amount;
  const payment = {
    no: asString(pickField(row, ['no', 'NO', 'rownum'])),
    merchantOrderNo: asString(pickField(row, ['odrno', 'order_no', 'orderNo', 'merchantOrderNo'])),
    transactionAt,
    status: cancelled ? '취소' : '승인',
    merchantName: asString(pickField(row, ['mc_nm', 'merchantName', 'store_nm'])),
    terminal: asString(pickField(row, ['tmid', 'tid', 'terminal', 'mid'])),
    acquirer: asString(pickField(row, ['buy_comp', 'card_nm', 'acquirer', 'issuer'])),
    installment: asString(pickField(row, ['installment', 'halbu', 'quota'])),
    maskedCardNumber: asString(pickField(row, ['cardno', 'card_no', 'maskedCardNumber'])),
    approvalNo: asString(pickField(row, ['authno', 'auth_no', 'approvalNo', 'appr_no'])),
    approvedAmount,
    cancelAmount,
    transactionAmount: cancelled ? 0 : amount,
    feeAmount: parseOptionalMoney(pickField(row, ['fee', 'fee_amt', 'feeAmount'])),
    settlementAmount: parseOptionalMoney(pickField(row, ['settle_amt', 'settlementAmount'])),
    settlementDue: asString(pickField(row, ['settle_dt', 'settlementDue'])),
    pg: asString(pickField(row, ['pg', 'pg_nm'])),
    agent: asString(pickField(row, ['agent', 'agent_nm'])),
  };
  setPaymentTimestampAndId(payment);
  return payment;
}

function parsePaymentHistoryAjaxResponse(payload) {
  const rows = Array.isArray(payload?.T2)
    ? payload.T2
    : Array.isArray(payload?.rows)
      ? payload.rows
      : [];

  return rows
    .map(normalizePaymentJsonRow)
    .filter(payment => payment.transactionId);
}

function parsePaymentHistoryHtml(html) {
  const payments = [];
  const rowMatches = asString(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);

  for (const rowMatch of rowMatches) {
    const cellMatches = Array.from(rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi));
    const cells = cellMatches.map(match => cellToText(match[1]));
    if (cells.length < 12) continue;
    if (cells[0] === 'NO' || cells[1] === '거래일자') continue;
    if (!cells.some(cell => cell === '승인' || cell.includes('승인'))) continue;

    const payment = normalizePaymentRow(cells);
    if (!payment.transactionId) continue;
    payments.push(payment);
  }

  return payments;
}

function isApprovedPaywayPayment(payment) {
  const status = asString(payment?.status);
  const amount = Number(payment?.transactionAmount || payment?.approvedAmount || 0);
  const cancelAmount = Number(payment?.cancelAmount || 0);
  const merchantOrderNo = asString(payment?.merchantOrderNo);
  const approvalNo = asString(payment?.approvalNo);
  const maskedCardNumber = asString(payment?.maskedCardNumber);
  return status === '승인'
    && amount > 0
    && cancelAmount <= 0
    && Boolean(merchantOrderNo)
    && Boolean(approvalNo)
    && Boolean(maskedCardNumber);
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(asString(value));
}

function getPaymentHistoryDateRange(options = {}) {
  const startDate = asString(options.startDate);
  const endDate = asString(options.endDate);
  if (isDateKey(startDate) && isDateKey(endDate) && startDate <= endDate) {
    return { startDate, endDate };
  }

  const nowInput = options.now ?? new Date();
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const end = Number.isNaN(now.getTime()) ? new Date() : now;
  const start = new Date(end.getTime() - PAYMENT_HISTORY_LOOKBACK_MS);
  return {
    startDate: formatDateInTimeZone(start, KST_TIME_ZONE),
    endDate: formatDateInTimeZone(end, KST_TIME_ZONE),
  };
}

function buildPaymentHistoryRequestBody(options = {}, terminalId = '', page = PAYMENT_HISTORY_PAGE) {
  const { startDate, endDate } = getPaymentHistoryDateRange(options);
  return new URLSearchParams({
    qry: PAYMENT_HISTORY_QUERY,
    jData: JSON.stringify({
      st: startDate,
      ed: endDate,
      pay_sta: 'ALL',
      kf: terminalId ? 'terminal' : '',
      k: terminalId,
      rows: PAYMENT_HISTORY_ROWS,
      page,
      pageSize: PAYMENT_HISTORY_PAGE_SIZE,
    }),
    rtnType: 'json3',
  });
}

function getPaymentHistoryQueryTargets() {
  const terminalIds = getConfiguredTerminalIds();
  return ['', ...terminalIds];
}

function dedupePayments(payments) {
  const seen = new Set();
  const deduped = [];

  for (const payment of payments) {
    const key = payment.transactionId || JSON.stringify(payment);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(payment);
  }

  return deduped;
}

async function fetchPaymentHistoryAjaxPage(body) {
  const response = await requestPayway('/ajax.php', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
  });
  const text = await response.text();

  if (!response.ok) {
    const error = new Error(`Payway payment history request failed: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const payload = parseJsonMaybe(text);
  if (!payload || typeof payload !== 'object') {
    const error = new Error('Payway payment history request returned a non-JSON response');
    error.status = response.status;
    throw error;
  }

  return parsePaymentHistoryAjaxResponse(payload);
}

async function fetchPaymentHistoryForTarget(options, terminalId) {
  const payments = [];

  for (let page = PAYMENT_HISTORY_PAGE; page <= MAX_PAYMENT_HISTORY_PAGES; page += 1) {
    const rows = await fetchPaymentHistoryAjaxPage(
      buildPaymentHistoryRequestBody(options, terminalId, page)
    );
    payments.push(...rows);

    if (rows.length < PAYMENT_HISTORY_PAGE_SIZE) {
      return payments;
    }
  }

  throw new Error(
    `Payway payment history exceeded ${MAX_PAYMENT_HISTORY_PAGES} pages for `
    + `${terminalId || 'all terminals'}`
  );
}

async function fetchPaymentHistoryViaAjax(options = {}) {
  const paymentBatches = [];
  const failures = [];
  for (const terminalId of getPaymentHistoryQueryTargets()) {
    try {
      paymentBatches.push(await fetchPaymentHistoryForTarget(options, terminalId));
    } catch (err) {
      if (!terminalId) {
        throw err;
      }
      failures.push(err);
    }
  }

  if (paymentBatches.length === 0 && failures.length > 0) {
    throw failures[0];
  }
  if (failures.length > 0) {
    console.warn(
      `[PAYWAY] ${failures.length} supplemental payment history request(s) failed; `
      + `using ${paymentBatches.length} successful response(s)`
    );
  }

  return dedupePayments(paymentBatches.flat());
}

async function fetchPaymentHistory(options = {}) {
  try {
    await ensureSession();
    const payments = await fetchPaymentHistoryViaAjax(options);
    recordConnectionOk();
    return payments;
  } catch (err) {
    if ((err.status === 401 || err.status === 403) && !getConfiguredCookieHeader()) {
      try {
        clearSession();
        await login();
        const payments = await fetchPaymentHistoryViaAjax(options);
        recordConnectionOk();
        return payments;
      } catch (retryErr) {
        recordConnectionError(retryErr);
        throw retryErr;
      }
    }
    recordConnectionError(err);
    throw err;
  }
}

async function probeConnection() {
  if (!isEnabled()) {
    return { ok: false, skipped: true, reason: 'payway_disabled' };
  }
  if (!isConfigured()) {
    return { ok: false, skipped: true, reason: 'payway_not_configured' };
  }

  try {
    const session = await ensureSession();
    recordConnectionOk();
    return { ok: true, source: session.source || null };
  } catch (err) {
    recordConnectionError(err);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  isEnabled,
  isConfigured,
  getStatus,
  probeConnection,
  login,
  fetchPaymentHistory,
  parsePaymentHistoryHtml,
  parsePaymentHistoryAjaxResponse,
  isApprovedPaywayPayment,
  getConfiguredTerminalIds,
  parseMoney,
  parsePaywayTimestamp,
  clearSession,
};
