// ═══════════════════════════════════════════════════════
// AdPilot — Imweb API Client (Orders + Token Refresh)
// ═══════════════════════════════════════════════════════

const fs = require('fs');
const config = require('../config');
const { formatDateInTimeZone, getHourInTimeZone } = require('../domain/time');
const { summarizeOrderAttribution } = require('../domain/imwebAttribution');
const { getOrderCashTotals } = require('../domain/imwebPayments');
const { sanitizeImwebOrder, sanitizeImwebOrders } = require('../services/privacyService');
const runtimePaths = require('../runtime/paths');

let accessToken = null;
let refreshToken = null;
let tokenExpiry = 0;
const authState = {
  status: 'missing',
  tokenSource: 'none',
  tokenFilePath: runtimePaths.imwebTokenFile,
  tokenFileExists: false,
  envRefreshTokenConfigured: false,
  refreshTokenMismatch: false,
  clientIdConfigured: false,
  clientSecretConfigured: false,
  hasAccessToken: false,
  hasRefreshToken: false,
  expiresAt: null,
  lastRefreshAttemptAt: null,
  lastRefreshSucceededAt: null,
  lastError: null,
};

function nowIso() {
  return new Date().toISOString();
}

function getEnvRefreshToken() {
  const seedRefresh = typeof process.env.IMWEB_REFRESH_TOKEN === 'string'
    ? process.env.IMWEB_REFRESH_TOKEN.trim()
    : '';

  if (!seedRefresh) return '';
  if (seedRefresh.startsWith('Your ') || seedRefresh.length <= 20) return '';
  return seedRefresh;
}

function getDiskRefreshToken() {
  try {
    if (!fs.existsSync(runtimePaths.imwebTokenFile)) return '';
    const raw = JSON.parse(fs.readFileSync(runtimePaths.imwebTokenFile, 'utf8'));
    const payload = raw.data || raw;
    const persisted = payload.refreshToken || payload.refresh_token;
    return typeof persisted === 'string' ? persisted.trim() : '';
  } catch (_) {
    return '';
  }
}

function hasImwebClientCredentials() {
  return Boolean(config.imweb.clientId && config.imweb.clientSecret);
}

function deriveAuthStatus() {
  if (!hasImwebClientCredentials()) return 'misconfigured';
  if (accessToken && refreshToken && !authState.lastError) return 'connected';
  if (accessToken && refreshToken) return 'degraded';
  if (refreshToken) return authState.lastError ? 'error' : 'refresh_only';
  if (accessToken) return authState.lastError ? 'degraded' : 'access_only';
  return authState.lastError ? 'error' : 'missing';
}

function syncAuthState(patch = {}) {
  const envRefreshToken = getEnvRefreshToken();
  const diskRefreshToken = getDiskRefreshToken();

  Object.assign(authState, patch, {
    tokenFileExists: fs.existsSync(runtimePaths.imwebTokenFile),
    envRefreshTokenConfigured: Boolean(envRefreshToken),
    refreshTokenMismatch: Boolean(envRefreshToken && diskRefreshToken && envRefreshToken !== diskRefreshToken),
    clientIdConfigured: Boolean(config.imweb.clientId),
    clientSecretConfigured: Boolean(config.imweb.clientSecret),
    hasAccessToken: Boolean(accessToken),
    hasRefreshToken: Boolean(refreshToken),
    expiresAt: tokenExpiry ? new Date(tokenExpiry).toISOString() : null,
  });
  authState.status = deriveAuthStatus();
  return authState;
}

function getAuthState() {
  return { ...syncAuthState() };
}

function stringifyImwebPayload(payload) {
  try {
    return JSON.stringify(payload);
  } catch (_) {
    return String(payload);
  }
}

function extractImwebError(payload) {
  if (!payload || typeof payload !== 'object') return '';

  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }

  if (payload.error && typeof payload.error === 'object') {
    const parts = [payload.error.errorCode, payload.error.message].filter(Boolean);
    if (parts.length > 0) return parts.join(': ');
  }

  if (typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error.trim();
  }

  return '';
}

async function readImwebResponse(res, label) {
  const rawText = await res.text();
  let payload = null;

  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch (err) {
    throw new Error(`${label} returned invalid JSON (HTTP ${res.status})`);
  }

  const payloadStatus = typeof payload?.statusCode === 'number' ? payload.statusCode : null;
  const failed = !res.ok || !!payload?.error || (payloadStatus != null && payloadStatus >= 400);
  if (!failed) return payload;

  const detail = extractImwebError(payload) || stringifyImwebPayload(payload);
  throw new Error(`${label} failed (HTTP ${res.status}): ${detail}`);
}

// ── Load tokens from disk ──
function loadTokens() {
  try {
    if (!fs.existsSync(runtimePaths.imwebTokenFile)) {
      console.log('[IMWEB] No token file found — will authenticate fresh');
      syncAuthState({ tokenSource: 'none' });
      return false;
    }
    const raw = JSON.parse(fs.readFileSync(runtimePaths.imwebTokenFile, 'utf8'));
    const payload = raw.data || raw;
    const loadedAccess = payload.accessToken || payload.access_token;
    const loadedRefresh = payload.refreshToken || payload.refresh_token;

    if (!loadedAccess && !loadedRefresh) {
      console.warn('[IMWEB] Token file exists but contains no valid tokens — ignoring');
      syncAuthState({ tokenSource: 'disk', lastError: 'Token file contains no usable tokens' });
      return false;
    }

    accessToken = loadedAccess || null;
    refreshToken = loadedRefresh || null;
    // Use the stored absolute expiry if available; otherwise force an immediate refresh
    tokenExpiry = payload.expires_at || (Date.now() + 5 * 60 * 1000);
    console.log(`[IMWEB] Tokens loaded from disk (expires_at: ${new Date(tokenExpiry).toISOString()})`);
    syncAuthState({ tokenSource: 'disk', lastError: null });
    return true;
  } catch (e) {
    console.error('[IMWEB] Failed to load tokens:', e.message);
    syncAuthState({ tokenSource: 'disk', lastError: `Failed to load token file: ${e.message}` });
    return false;
  }
}

// ── Save tokens to disk ──
function saveTokens(data, { fallbackRefreshToken = null, source = 'disk' } = {}) {
  const payload = data.data || data;
  const newAccess = payload.accessToken || payload.access_token;
  const newRefresh = payload.refreshToken || payload.refresh_token;
  const expiresIn = payload.expiresIn || payload.expires_in || 7200; // seconds

  if (!newAccess) {
    throw new Error('Imweb token refresh succeeded without an access token');
  }

  // Only overwrite if the API actually returned a value — preserve old otherwise
  if (newAccess) accessToken = newAccess;
  if (newRefresh) refreshToken = newRefresh;
  if (!refreshToken && fallbackRefreshToken) refreshToken = fallbackRefreshToken;

  const now = Date.now();
  tokenExpiry = now + expiresIn * 1000;

  // Persist with absolute timestamps so loadTokens() doesn't guess
  const dir = require('path').dirname(runtimePaths.imwebTokenFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(runtimePaths.imwebTokenFile, JSON.stringify({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    expires_at: tokenExpiry,
    saved_at: now,
  }, null, 2), { mode: 0o600 });
  fs.chmodSync(runtimePaths.imwebTokenFile, 0o600);
  console.log(`[IMWEB] Tokens saved (expires_at: ${new Date(tokenExpiry).toISOString()})`);
  syncAuthState({
    tokenSource: source,
    lastError: null,
    lastRefreshSucceededAt: nowIso(),
  });
}

// ── Refresh access token ──
async function refreshAccessToken(options = {}) {
  const candidateRefreshToken = typeof options.refreshTokenOverride === 'string'
    ? options.refreshTokenOverride.trim()
    : refreshToken;
  const source = options.source || authState.tokenSource || 'memory';

  if (!candidateRefreshToken) {
    const msg = 'No Imweb refresh token available';
    syncAuthState({ lastError: msg });
    throw new Error(msg);
  }

  if (!hasImwebClientCredentials()) {
    const msg = 'Imweb client credentials are missing';
    syncAuthState({ lastError: msg });
    throw new Error(msg);
  }

  console.log(`[IMWEB] Refreshing access token (${source})...`);
  syncAuthState({ lastRefreshAttemptAt: nowIso() });
  // Imweb uses camelCase param names in their OAuth2 implementation
  const params = new URLSearchParams();
  params.append('grantType', 'refresh_token');
  params.append('clientId', config.imweb.clientId);
  params.append('clientSecret', config.imweb.clientSecret);
  params.append('refreshToken', candidateRefreshToken);

  let res;
  try {
    res = await fetch(`${config.imweb.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch (networkErr) {
    const msg = `Imweb token refresh network error: ${networkErr.message}`;
    console.error(`[IMWEB] ${msg}`);
    syncAuthState({ lastError: msg, tokenSource: source });
    sendTokenAlert(msg);
    throw new Error(msg);
  }

  try {
    const data = await readImwebResponse(res, 'Imweb token refresh');
    saveTokens(data, { fallbackRefreshToken: candidateRefreshToken, source });
    console.log('[IMWEB] Token refreshed successfully');
    return true;
  } catch (err) {
    const msg = err.message || 'Imweb token refresh failed';
    console.error(`[IMWEB] ${msg}`);
    syncAuthState({ lastError: msg, tokenSource: source });
    sendTokenAlert(msg);
    throw err;
  }
}

// ── Alert on token failure (non-blocking) ──
function sendTokenAlert(errorMsg) {
  try {
    const telegram = require('./telegram');
    telegram.sendMessage(
      `🔴 <b>Imweb Token Failure</b>\n\n${errorMsg}\n\n` +
      `Revenue data is stale. Update IMWEB_REFRESH_TOKEN on Render or restore a valid persisted Imweb token.`
    ).catch(() => {}); // fire-and-forget
  } catch (_) { /* telegram not available */ }
}

// ── Seed tokens from env var (for first Render deploy) ──
function seedTokensFromEnv() {
  const seedRefresh = getEnvRefreshToken();
  if (seedRefresh) {
    console.log('[IMWEB] Seeding refresh token from IMWEB_REFRESH_TOKEN env var');
    accessToken = null;
    refreshToken = seedRefresh;
    tokenExpiry = 0; // Force immediate refresh
    syncAuthState({ tokenSource: 'env', lastError: null });
    return true;
  }
  if (process.env.IMWEB_REFRESH_TOKEN) {
    console.warn('[IMWEB] IMWEB_REFRESH_TOKEN looks like a placeholder — ignoring');
  }
  syncAuthState();
  return false;
}

async function refreshAccessTokenWithFallback() {
  const attempted = new Set();
  const candidates = [];
  const currentRefreshToken = typeof refreshToken === 'string' ? refreshToken.trim() : '';
  const envRefreshToken = getEnvRefreshToken();

  if (currentRefreshToken) {
    candidates.push({
      refreshToken: currentRefreshToken,
      source: authState.tokenSource === 'none' ? 'disk' : authState.tokenSource,
    });
    attempted.add(currentRefreshToken);
  }

  if (envRefreshToken && !attempted.has(envRefreshToken)) {
    candidates.push({ refreshToken: envRefreshToken, source: 'env' });
    attempted.add(envRefreshToken);
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return await refreshAccessToken({
        refreshTokenOverride: candidate.refreshToken,
        source: candidate.source,
      });
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  throw new Error('No Imweb refresh token available');
}

async function seedRefreshToken(candidateRefreshToken) {
  const nextRefreshToken = typeof candidateRefreshToken === 'string'
    ? candidateRefreshToken.trim()
    : '';
  if (!nextRefreshToken) {
    throw new Error('refreshToken required');
  }

  return refreshAccessToken({
    refreshTokenOverride: nextRefreshToken,
    source: 'seed',
  });
}

// ── Ensure valid token ──
async function ensureToken() {
  if (!accessToken && !refreshToken) {
    const loaded = loadTokens();
    if (!loaded) {
      // Try seeding from env var
      if (!seedTokensFromEnv()) {
        throw new Error('No Imweb tokens available. Set IMWEB_REFRESH_TOKEN env var for first deploy.');
      }
    }
  }

  if (!accessToken || Date.now() > tokenExpiry - 5 * 60 * 1000) {
    await refreshAccessTokenWithFallback();
  }
}

async function requestImwebWithAccessToken(path, method = 'GET', params = {}, options = {}) {
  const explicitAccessToken = typeof options.accessTokenOverride === 'string'
    ? options.accessTokenOverride.trim()
    : '';
  const explicitSiteCode = typeof options.siteCodeOverride === 'string'
    ? options.siteCodeOverride.trim()
    : '';

  const bearerToken = explicitAccessToken || accessToken;
  if (!bearerToken) {
    throw new Error('No Imweb access token available');
  }

  const siteCode = explicitSiteCode || config.imweb.siteCode;
  const url = new URL(`${config.imweb.baseUrl}${path}`);
  if (method === 'GET' && params && typeof params === 'object') {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, value);
      }
    });
  }

  const headers = {
    'Authorization': `Bearer ${bearerToken}`,
    ...(siteCode ? { 'x-site-code': siteCode } : {}),
    ...(options.extraHeaders || {}),
  };

  const requestOptions = {
    method,
    headers,
  };

  if (method !== 'GET') {
    if (options.formEncoded) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      requestOptions.body = new URLSearchParams(params).toString();
    } else if (params !== null && params !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestOptions.body = JSON.stringify(params);
    }
  }

  const response = await fetch(url.toString(), requestOptions);
  return readImwebResponse(response, `Imweb ${method} ${path}`);
}

// ── Make authenticated API request ──
async function imwebApi(path, method = 'GET', params = {}) {
  await ensureToken();

  async function requestOnce(retryOnAuthFailure) {
    const requestPromise = requestImwebWithAccessToken(path, method, params);
    const res = await requestPromise.catch(err => {
      if (!retryOnAuthFailure) throw err;
      const statusMatch = String(err.message || '').match(/HTTP (\d{3})/);
      const status = statusMatch ? Number(statusMatch[1]) : null;
      if ((status === 401 || status === 403) && refreshToken) {
        return { __retryAuthFailure: true };
      }
      throw err;
    });

    if (res && res.__retryAuthFailure) {
      console.warn(`[IMWEB] ${method} ${path} returned auth failure; attempting token refresh and one retry`);
      tokenExpiry = 0;
      await refreshAccessToken();
      return requestOnce(false);
    }

    return res;
  }

  return requestOnce(true);
}

// ═══════════════════════════════════════════════
// ORDER & REVENUE DATA
// ═══════════════════════════════════════════════

// Get all orders (paginated)
async function getAllOrders() {
  const allOrders = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const data = await imwebApi('/orders', 'GET', { page, limit });
    if (!Array.isArray(data?.data?.list)) {
      throw new Error(`Imweb GET /orders returned an unexpected shape on page ${page}`);
    }
    if (data.data.list.length === 0) break;
    allOrders.push(...data.data.list);
    const totalCount = data.data.totalCount || 0;
    console.log(`[IMWEB] Fetched page ${page}: ${data.data.list.length} orders (total: ${totalCount})`);
    if (allOrders.length >= totalCount) break;
    page++;
  }

  console.log(`[IMWEB] Total orders fetched: ${allOrders.length}`);
  return sanitizeImwebOrders(allOrders);
}

async function getOrder(orderNo) {
  const normalizedOrderNo = String(orderNo || '').trim();
  if (!normalizedOrderNo) {
    throw new Error('orderNo is required');
  }

  try {
    const payload = await imwebApi(`/orders/${encodeURIComponent(normalizedOrderNo)}`, 'GET');
    const order = payload?.data?.order || payload?.data || payload?.order || payload;
    if (!order || typeof order !== 'object') {
      throw new Error('unexpected payload shape');
    }
    return sanitizeImwebOrder(order);
  } catch (err) {
    console.warn(`[IMWEB] Direct getOrder failed for ${normalizedOrderNo}, falling back to paginated search: ${err.message}`);
    const orders = await getAllOrders();
    const fallback = orders.find(order => String(order?.orderNo || '').trim() === normalizedOrderNo);
    if (!fallback) {
      throw new Error(`Order ${normalizedOrderNo} not found`);
    }
    return fallback;
  }
}

// Process orders into revenue metrics
function processOrders(orders) {
  let totalRevenue = 0;
  let totalRefunded = 0;
  let totalOrders = 0;
  let cancelledSections = 0;
  let totalSections = 0;
  const dailyRevenue = {};
  const hourlyOrders = new Array(24).fill(0);
  const attributionSummary = summarizeOrderAttribution(orders);

  for (const order of orders) {
    const { approvedAmount, refundedAmount, hasRecognizedCash } = getOrderCashTotals(order);

    // wtime is ISO string like "2026-03-10T05:13:50.000Z"
    const orderDate = order.wtime ? new Date(order.wtime) : new Date();
    const dateKey = formatDateInTimeZone(orderDate);
    const hour = getHourInTimeZone(orderDate);

    if (!dailyRevenue[dateKey]) {
      dailyRevenue[dateKey] = { revenue: 0, refunded: 0, orders: 0 };
    }

    if (hasRecognizedCash) {
      totalOrders++;
      dailyRevenue[dateKey].orders++;
      hourlyOrders[hour]++;
    }

    totalRevenue += approvedAmount;
    totalRefunded += refundedAmount;
    dailyRevenue[dateKey].revenue += approvedAmount;
    dailyRevenue[dateKey].refunded += refundedAmount;

    // Process sections for cancel tracking
    const sections = order.sections || order.orderSections || [];
    for (const section of sections) {
      totalSections++;
      const status = section.orderSectionStatus || section.orderStatus || '';
      if (status === 'CANCEL_DONE' || status === 'RETURN_DONE' || status === 'EXCHANGE_DONE'
          || status === 'CANCEL_REQUEST' || status === 'RETURN_REQUEST') {
        cancelledSections++;
      }
    }
  }

  return {
    totalOrders,
    totalRevenue,
    totalRefunded,
    netRevenue: totalRevenue - totalRefunded,
    cancelledSections,
    totalSections,
    refundRate: totalRevenue > 0 ? (totalRefunded / totalRevenue * 100) : 0,
    cancelRate: totalSections > 0 ? (cancelledSections / totalSections * 100) : 0,
    dailyRevenue,
    hourlyOrders,
    attributionSummary,
  };
}

module.exports = {
  loadTokens,
  refreshAccessToken,
  seedRefreshToken,
  getAuthState,
  getAllOrders,
  getOrder,
  processOrders,
};
