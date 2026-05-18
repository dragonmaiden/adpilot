const config = require('../config');
const { asString } = require('../services/privacyService');

let cookieJar = new Map();

function getPaywayConfig() {
  return config.payway || {};
}

function getPositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
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

function parsePaywayTimestamp(value) {
  const text = asString(value);
  const match = text.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
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

function normalizePaymentRow(cells) {
  const payment = {
    no: asString(cells[0]),
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
    feeAmount: parseMoney(cells[12]),
    settlementAmount: parseMoney(cells[13]),
    settlementDue: asString(cells[14]),
    pg: asString(cells[15]),
    agent: asString(cells[16]),
  };
  const parsedAt = parsePaywayTimestamp(payment.transactionAt);
  payment.transactionAtIso = parsedAt ? parsedAt.toISOString() : null;
  payment.transactionId = buildTransactionId(payment);
  return payment;
}

function parsePaymentHistoryHtml(html) {
  const payments = [];
  const rowMatches = asString(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);

  for (const rowMatch of rowMatches) {
    const cellMatches = Array.from(rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi));
    const cells = cellMatches.map(match => cellToText(match[1]));
    if (cells.length < 12) continue;
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
  return status === '승인' && amount > 0 && cancelAmount <= 0;
}

async function fetchPaymentHistory() {
  await ensureSession();
  const payway = getPaywayConfig();
  const historyPath = asString(payway.historyPath) || '/pay';
  let response = await requestPayway(historyPath);

  if ((response.status === 401 || response.status === 403) && !getConfiguredCookieHeader()) {
    clearSession();
    await login();
    response = await requestPayway(historyPath);
  }

  const html = await response.text();
  if (!response.ok) {
    throw new Error(`Payway payment history request failed: HTTP ${response.status}`);
  }

  return parsePaymentHistoryHtml(html);
}

module.exports = {
  isEnabled,
  isConfigured,
  login,
  fetchPaymentHistory,
  parsePaymentHistoryHtml,
  isApprovedPaywayPayment,
  parseMoney,
  parsePaywayTimestamp,
  clearSession,
};
