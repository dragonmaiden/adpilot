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
let tokenInitialized = false;
const authState = {
  status: 'missing',
  tokenSource: 'none',
  tokenFilePath: runtimePaths.imwebTokenFile,
  tokenFileExists: false,
  envRefreshTokenConfigured: false,
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

// ── Token source helpers ──

function getEnvRefreshToken() {
  const seedRefresh = typeof process.env.IMWEB_REFRESH_TOKEN === 'string'
    ? process.env.IMWEB_REFRESH_TOKEN.trim()
    : '';

  if (!seedRefresh) return '';
  if (seedRefresh.startsWith('Your ') || seedRefresh.length <= 20) return '';
  return seedRefresh;
}

function hasImwebClientCredentials() {
  return Boolean(config.imweb.clientId && config.imweb.clientSecret);
}

/**
 * Read the token file from disk as structured data.  Returns null when
 * the file is missing, unreadable, or contains no refresh token.
 */
function loadTokenFileData() {
  try {
    if (!fs.existsSync(runtimePaths.imwebTokenFile)) return null;
    const raw = JSON.parse(fs.readFileSync(runtimePaths.imwebTokenFile, 'utf8'));
    const payload = raw.data || raw;
    const diskRefresh = payload.refreshToken || payload.refresh_token;
    if (!diskRefresh) return null;
    return {
      accessToken: (payload.accessToken || payload.access_token) || null,
      refreshToken: typeof diskRefresh === 'string' ? diskRefresh.trim() : null,
      expiresAt: payload.expires_at || null,
      chainStartedAt: typeof payload.chain_started_at === 'number' ? payload.chain_started_at : null,
      envTokenConsumed: typeof payload.env_token_consumed === 'string' ? payload.env_token_consumed : null,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Determine the best available refresh token at startup.  Called exactly
 * once — every subsequent refresh uses the in-memory (rotated) token.
 *
 * Priority:
 *  1. Env var was updated since last consume → user re-authorized
 *  2. Disk has a valid refresh token → latest rotation
 *  3. Env var as initial bootstrap → first deploy or disk loss
 */
function resolveInitialToken() {
  const envToken = getEnvRefreshToken();
  const diskData = loadTokenFileData();

  // Env var was manually updated (differs from what we last consumed)
  if (envToken && diskData && envToken !== diskData.envTokenConsumed) {
    console.log('[IMWEB] IMWEB_REFRESH_TOKEN env var changed since last consumed — using new env token (re-authorization detected)');
    return { refreshToken: envToken, accessToken: null, expiresAt: 0, source: 'env', isNewChain: true };
  }

  // Disk has a valid token from a previous rotation
  if (diskData?.refreshToken) {
    console.log(`[IMWEB] Tokens loaded from disk (expires_at: ${diskData.expiresAt ? new Date(diskData.expiresAt).toISOString() : 'unknown'})`);
    return {
      refreshToken: diskData.refreshToken,
      accessToken: diskData.accessToken,
      expiresAt: diskData.expiresAt || 0,
      source: 'disk',
      isNewChain: false,
    };
  }

  // No disk data — first deploy or disk loss
  if (envToken) {
    console.log('[IMWEB] No token file — seeding from IMWEB_REFRESH_TOKEN env var');
    return { refreshToken: envToken, accessToken: null, expiresAt: 0, source: 'env', isNewChain: true };
  }

  return null;
}

// ── Auth state ──

function deriveAuthStatus() {
  if (!hasImwebClientCredentials()) return 'misconfigured';
  if (accessToken && refreshToken && !authState.lastError) return 'connected';
  if (accessToken && refreshToken) return 'degraded';
  if (refreshToken) return authState.lastError ? 'error' : 'refresh_only';
  if (accessToken) return authState.lastError ? 'degraded' : 'access_only';
  return authState.lastError ? 'error' : 'missing';
}

function syncAuthState(patch = {}) {
  Object.assign(authState, patch, {
    tokenFileExists: fs.existsSync(runtimePaths.imwebTokenFile),
    envRefreshTokenConfigured: Boolean(getEnvRefreshToken()),
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
  let payload;

  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch (err) {
    throw new Error(`${label} returned invalid JSON (HTTP ${res.status})`, { cause: err });
  }

  const payloadStatus = typeof payload?.statusCode === 'number' ? payload.statusCode : null;
  const failed = !res.ok || !!payload?.error || (payloadStatus != null && payloadStatus >= 400);
  if (!failed) return payload;

  const detail = extractImwebError(payload) || stringifyImwebPayload(payload);
  throw new Error(`${label} failed (HTTP ${res.status}): ${detail}`);
}

// ── Chain age tracking ──
const CHAIN_MAX_AGE_DAYS = 90;
const CHAIN_WARNING_DAYS = 75;
let chainWarningAlertSent = false;

function sendChainExpiryWarning(chainAgeDays) {
  if (chainWarningAlertSent) return;
  chainWarningAlertSent = true;
  try {
    const remaining = Math.max(0, CHAIN_MAX_AGE_DAYS - chainAgeDays);
    const telegram = require('./telegram');
    telegram.sendMessage(
      `⚠️ <b>Imweb Token Chain Expiring</b>\n\n`
      + `The refresh token chain is ${Math.round(chainAgeDays)} days old.`
      + ` Imweb tokens expire after ${CHAIN_MAX_AGE_DAYS} days from the original authorization.\n\n`
      + `<b>~${Math.round(remaining)} days remaining.</b>\n\n`
      + `Re-authorize the Imweb app and update IMWEB_REFRESH_TOKEN on Render to start a fresh chain.`,
    ).catch(() => {});
  } catch (_) { /* telegram not available */ }
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

// ── Save tokens to disk ──
function saveTokens(data, { fallbackRefreshToken = null, source = 'disk' } = {}) {
  const payload = data.data || data;
  const newAccess = payload.accessToken || payload.access_token;
  const newRefresh = payload.refreshToken || payload.refresh_token;
  const expiresIn = payload.expiresIn || payload.expires_in || 7200; // seconds

  if (!newAccess) {
    throw new Error('Imweb token refresh succeeded without an access token');
  }

  const previousRefresh = refreshToken;

  if (newAccess) accessToken = newAccess;
  if (newRefresh) refreshToken = newRefresh;
  if (!refreshToken && fallbackRefreshToken) refreshToken = fallbackRefreshToken;

  if (newRefresh && newRefresh !== previousRefresh) {
    console.log('[IMWEB] Refresh token rotated (new token received from API)');
  } else if (!newRefresh) {
    console.warn('[IMWEB] ⚠ API did not return a new refresh token — reusing previous');
  }

  const now = Date.now();
  tokenExpiry = now + expiresIn * 1000;

  // Preserve chain metadata from the existing disk file.
  const diskData = loadTokenFileData();
  const isNewChain = source === 'seed' || source === 'env' || !diskData?.chainStartedAt;
  const chainStartedAt = isNewChain ? now : diskData.chainStartedAt;

  // Track which env var value was consumed so that resolveInitialToken()
  // can detect when the user manually updates IMWEB_REFRESH_TOKEN.
  // Only update env_token_consumed when we actually bootstrap from the env var.
  const envTokenConsumed = isNewChain
    ? getEnvRefreshToken()
    : (diskData?.envTokenConsumed || '');

  const dir = require('path').dirname(runtimePaths.imwebTokenFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(runtimePaths.imwebTokenFile, JSON.stringify({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    expires_at: tokenExpiry,
    saved_at: now,
    chain_started_at: chainStartedAt,
    env_token_consumed: envTokenConsumed,
  }, null, 2), { mode: 0o600 });
  fs.chmodSync(runtimePaths.imwebTokenFile, 0o600);

  const chainAgeDays = (now - chainStartedAt) / (1000 * 60 * 60 * 24);
  console.log(
    `[IMWEB] Tokens saved (expires_at: ${new Date(tokenExpiry).toISOString()}, `
    + `chain age: ${Math.round(chainAgeDays)}d)`
  );

  if (chainAgeDays >= CHAIN_WARNING_DAYS) {
    sendChainExpiryWarning(chainAgeDays);
  }

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
    throw new Error(msg, { cause: networkErr });
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

// ── External seed (called by /api/seed-token endpoint) ──
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

async function exchangeAuthorizationCode(code, redirectUri) {
  const authorizationCode = typeof code === 'string' ? code.trim() : '';
  const normalizedRedirectUri = typeof redirectUri === 'string' ? redirectUri.trim() : '';

  if (!authorizationCode) {
    throw new Error('authorization code is required');
  }
  if (!normalizedRedirectUri) {
    throw new Error('redirectUri is required');
  }
  if (!hasImwebClientCredentials()) {
    throw new Error('Imweb client credentials are missing');
  }

  const params = new URLSearchParams();
  params.append('grantType', 'authorization_code');
  params.append('clientId', config.imweb.clientId);
  params.append('clientSecret', config.imweb.clientSecret);
  params.append('redirectUri', normalizedRedirectUri);
  params.append('code', authorizationCode);

  let res;
  try {
    res = await fetch(`${config.imweb.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch (networkErr) {
    const msg = `Imweb authorization-code exchange network error: ${networkErr.message}`;
    console.error(`[IMWEB] ${msg}`);
    syncAuthState({ lastError: msg, tokenSource: 'oauth_callback' });
    throw new Error(msg, { cause: networkErr });
  }

  const data = await readImwebResponse(res, 'Imweb authorization-code exchange');
  saveTokens(data, { source: 'seed' });
  console.log('[IMWEB] Authorization code exchanged successfully');
  return true;
}

/**
 * Pre-load tokens into memory.  Called once at scheduler startup.
 * Does NOT refresh — just loads so getAuthState() is populated early.
 */
function loadTokens() {
  const resolved = resolveInitialToken();
  if (!resolved) {
    console.log('[IMWEB] No tokens available at startup');
    syncAuthState({ tokenSource: 'none' });
    return false;
  }
  accessToken = resolved.accessToken;
  refreshToken = resolved.refreshToken;
  tokenExpiry = resolved.expiresAt || 0;
  tokenInitialized = true;
  syncAuthState({ tokenSource: resolved.source, lastError: null });
  return true;
}

/**
 * Ensure a valid access token is available before making an API call.
 *
 * Initialization runs exactly once — resolveInitialToken() picks the best
 * source (disk vs. env var) with env_token_consumed tracking to detect
 * manual re-authorization.  After that, only the in-memory (rotated)
 * refresh token is used.  The env var is NEVER re-read at runtime to
 * avoid poisoning the rotation chain with a stale value.
 */
async function ensureToken() {
  if (!tokenInitialized) {
    tokenInitialized = true;
    const resolved = resolveInitialToken();
    if (!resolved) {
      throw new Error('No Imweb tokens available. Set IMWEB_REFRESH_TOKEN env var for first deploy.');
    }
    accessToken = resolved.accessToken;
    refreshToken = resolved.refreshToken;
    tokenExpiry = resolved.expiresAt || 0;
    syncAuthState({ tokenSource: resolved.source, lastError: null });
  }

  if (!accessToken || Date.now() > tokenExpiry - 5 * 60 * 1000) {
    if (!refreshToken) {
      throw new Error('No Imweb refresh token available');
    }
    await refreshAccessToken({
      refreshTokenOverride: refreshToken,
      source: authState.tokenSource || 'memory',
    });
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
      throw new Error(`Order ${normalizedOrderNo} not found`, { cause: err });
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
  exchangeAuthorizationCode,
  getAuthState,
  getAllOrders,
  getOrder,
  processOrders,
};
