// ═══════════════════════════════════════════════════════
// AdPilot — Imweb API Client (Orders + Token Refresh)
// ═══════════════════════════════════════════════════════

const fs = require('fs');
const config = require('../config');

let accessToken = null;
let refreshToken = null;
let tokenExpiry = 0;

// ── Load tokens from disk ──
function loadTokens() {
  try {
    if (!fs.existsSync(config.imweb.tokenFile)) {
      console.log('[IMWEB] No token file found — will authenticate fresh');
      return false;
    }
    const raw = JSON.parse(fs.readFileSync(config.imweb.tokenFile, 'utf8'));
    const payload = raw.data || raw;
    const loadedAccess = payload.accessToken || payload.access_token;
    const loadedRefresh = payload.refreshToken || payload.refresh_token;

    if (!loadedAccess && !loadedRefresh) {
      console.warn('[IMWEB] Token file exists but contains no valid tokens — ignoring');
      return false;
    }

    accessToken = loadedAccess || null;
    refreshToken = loadedRefresh || null;
    // Use the stored absolute expiry if available; otherwise force an immediate refresh
    tokenExpiry = payload.expires_at || (Date.now() + 5 * 60 * 1000);
    console.log(`[IMWEB] Tokens loaded from disk (expires_at: ${new Date(tokenExpiry).toISOString()})`);
    return true;
  } catch (e) {
    console.error('[IMWEB] Failed to load tokens:', e.message);
    return false;
  }
}

// ── Save tokens to disk ──
function saveTokens(data) {
  const payload = data.data || data;
  const newAccess = payload.accessToken || payload.access_token;
  const newRefresh = payload.refreshToken || payload.refresh_token;
  const expiresIn = payload.expiresIn || payload.expires_in || 7200; // seconds

  // Only overwrite if the API actually returned a value — preserve old otherwise
  if (newAccess) accessToken = newAccess;
  if (newRefresh) refreshToken = newRefresh;

  const now = Date.now();
  tokenExpiry = now + expiresIn * 1000;

  // Persist with absolute timestamps so loadTokens() doesn't guess
  const dir = require('path').dirname(config.imweb.tokenFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(config.imweb.tokenFile, JSON.stringify({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    expires_at: tokenExpiry,
    saved_at: now,
  }, null, 2));
  console.log(`[IMWEB] Tokens saved (expires_at: ${new Date(tokenExpiry).toISOString()})`);
}

// ── Refresh access token ──
async function refreshAccessToken() {
  console.log('[IMWEB] Refreshing access token...');
  // Imweb uses camelCase param names in their OAuth2 implementation
  const params = new URLSearchParams();
  params.append('grantType', 'refresh_token');
  params.append('clientId', config.imweb.clientId);
  params.append('clientSecret', config.imweb.clientSecret);
  params.append('refreshToken', refreshToken);

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
    sendTokenAlert(msg);
    throw new Error(msg);
  }

  const data = await res.json();
  if (data.error || !res.ok) {
    const msg = `Imweb token refresh failed (HTTP ${res.status}): ${JSON.stringify(data)}`;
    console.error(`[IMWEB] ${msg}`);
    sendTokenAlert(msg);
    throw new Error(msg);
  }
  saveTokens(data);
  console.log('[IMWEB] Token refreshed successfully');
  return true;
}

// ── Alert on token failure (non-blocking) ──
function sendTokenAlert(errorMsg) {
  try {
    const telegram = require('./telegram');
    telegram.sendMessage(
      `🔴 <b>Imweb Token Failure</b>\n\n${errorMsg}\n\n` +
      `Revenue data is stale. Re-seed via /api/seed-token or update IMWEB_REFRESH_TOKEN on Render.`
    ).catch(() => {}); // fire-and-forget
  } catch (_) { /* telegram not available */ }
}

// ── Seed tokens from env var (for first Render deploy) ──
function seedTokensFromEnv() {
  const seedRefresh = process.env.IMWEB_REFRESH_TOKEN;
  if (seedRefresh && !seedRefresh.startsWith('Your ') && seedRefresh.length > 20) {
    console.log('[IMWEB] Seeding refresh token from IMWEB_REFRESH_TOKEN env var');
    refreshToken = seedRefresh;
    tokenExpiry = 0; // Force immediate refresh
    return true;
  }
  if (seedRefresh && (seedRefresh.startsWith('Your ') || seedRefresh.length <= 20)) {
    console.warn('[IMWEB] IMWEB_REFRESH_TOKEN looks like a placeholder — ignoring');
  }
  return false;
}

// ── Ensure valid token ──
async function ensureToken() {
  if (!accessToken) {
    const loaded = loadTokens();
    if (!loaded) {
      // Try seeding from env var
      if (!seedTokensFromEnv()) {
        throw new Error('No Imweb tokens available. Set IMWEB_REFRESH_TOKEN env var for first deploy.');
      }
    }
  }
  if (Date.now() > tokenExpiry - 5 * 60 * 1000) {
    await refreshAccessToken();
  }
}

// ── Make authenticated API request ──
async function imwebApi(path, method = 'GET', params = {}) {
  await ensureToken();
  const url = new URL(`${config.imweb.baseUrl}${path}`);

  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'x-site-code': config.imweb.siteCode,
    'Content-Type': 'application/json',
  };

  if (method === 'GET') {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString(), { headers });
    return res.json();
  }

  const res = await fetch(url.toString(), { method, headers, body: JSON.stringify(params) });
  return res.json();
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
    if (!data.data?.list || data.data.list.length === 0) break;
    allOrders.push(...data.data.list);
    const totalCount = data.data.totalCount || 0;
    console.log(`[IMWEB] Fetched page ${page}: ${data.data.list.length} orders (total: ${totalCount})`);
    if (allOrders.length >= totalCount) break;
    page++;
  }

  console.log(`[IMWEB] Total orders fetched: ${allOrders.length}`);
  return allOrders;
}

// Process orders into revenue metrics
function processOrders(orders) {
  let totalRevenue = 0;
  let totalRefunded = 0;
  let totalOrders = orders.length;
  let cancelledSections = 0;
  let totalSections = 0;
  const dailyRevenue = {};
  const hourlyOrders = new Array(24).fill(0);

  for (const order of orders) {
    // Imweb uses totalPaymentPrice (actual amount paid) and totalRefundedPrice
    const payAmount = order.totalPaymentPrice || order.totalPrice || 0;
    const refundAmount = order.totalRefundedPrice || 0;

    // wtime is ISO string like "2026-03-10T05:13:50.000Z"
    const orderDate = order.wtime ? new Date(order.wtime) : new Date();
    const dateKey = orderDate.toISOString().slice(0, 10);
    const hour = (orderDate.getUTCHours() + 9) % 24; // UTC → KST

    // Revenue by day
    if (!dailyRevenue[dateKey]) {
      dailyRevenue[dateKey] = { revenue: 0, refunded: 0, orders: 0 };
    }
    dailyRevenue[dateKey].orders++;
    hourlyOrders[hour]++;

    // Track revenue and refunds from order-level totals
    totalRevenue += payAmount;
    totalRefunded += refundAmount;
    dailyRevenue[dateKey].revenue += payAmount;
    dailyRevenue[dateKey].refunded += refundAmount;

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
  };
}

module.exports = {
  loadTokens,
  refreshAccessToken,
  getAllOrders,
  processOrders,
};
