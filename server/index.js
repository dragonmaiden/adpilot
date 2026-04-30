// ═══════════════════════════════════════════════════════
// AdPilot — Express Server
// REST API for dashboard + order monitoring
// ═══════════════════════════════════════════════════════

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const config = require('./config');
const runtimePaths = require('./runtime/paths');
const runtimeSettings = require('./runtime/runtimeSettings');
const scheduler = require('./modules/scheduler');
const imweb = require('./modules/imwebClient');
const telegram = require('./modules/telegram');
const contracts = require('./contracts/v1');
const transforms = require('./transforms/charts');
const overviewService = require('./services/overviewService');
const campaignService = require('./services/campaignService');
const postmortemService = require('./services/postmortemService');
const analyticsService = require('./services/analyticsService');
const livePerformanceService = require('./services/livePerformanceService');
const calendarService = require('./services/calendarService');
const { buildFinancialProjection } = require('./services/financialProjectionService');
const reconciliationService = require('./services/reconciliationService');
const cogsAutofillService = require('./services/cogsAutofillService');
const orderNotificationService = require('./services/orderNotificationService');
const observabilityService = require('./services/observabilityService');
const imwebAuthRepairService = require('./services/imwebAuthRepairService');

function shouldDeliverPaidOrderNotification(result) {
  return result?.status === 'appended'
    || (result?.status === 'duplicate' && result?.alreadyNotified);
}

function handleInternalError(req, res, err) {
  console.error(`[API] ${req.method} ${req.path} error:`, err);
  observabilityService.captureException(err, {
    category: 'api.error',
    title: `${req.method} ${req.path} failed`,
    tags: {
      method: req.method,
      path: req.path,
    },
  });
  res.status(500).json({ error: 'Internal server error' });
}

function requireLegacyAdOps(req, res, next) {
  if (config.features.legacyAdOpsEnabled) {
    return next();
  }

  return res.status(410).json({
    error: 'Legacy ad-operations endpoints are disabled.',
    nextAction: 'Set LEGACY_AD_OPS_ENABLED=true only when intentionally using old Meta operations.',
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderImwebInstallPage({ title, body, statusCode = 200 }) {
  return {
    statusCode,
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f4f1ea; color: #173042; }
      main { max-width: 720px; margin: 48px auto; padding: 32px; background: rgba(255,255,255,0.82); border: 1px solid rgba(23,48,66,0.14); border-radius: 24px; box-shadow: 0 24px 60px rgba(23,48,66,0.08); }
      h1 { margin: 0 0 16px; font-size: 28px; line-height: 1.15; }
      p, li { font-size: 15px; line-height: 1.6; }
      code { background: rgba(23,48,66,0.08); padding: 2px 6px; border-radius: 6px; }
      .meta { margin-top: 20px; padding: 16px; background: rgba(23,48,66,0.05); border-radius: 16px; }
      .meta strong { display: inline-block; min-width: 128px; }
      .cta { display: inline-block; margin-top: 20px; padding: 10px 16px; border-radius: 999px; background: #0f7f89; color: white; text-decoration: none; font-weight: 600; }
    </style>
  </head>
  <body>
    <main>
      ${body}
    </main>
  </body>
</html>`,
  };
}

function getPublicRequestOrigin(req) {
  const forwardedProto = String(req.get('x-forwarded-proto') || req.protocol || 'https')
    .split(',')[0]
    .trim();
  const host = String(req.get('host') || '').trim();
  return `${forwardedProto || 'https'}://${host}`;
}

function buildImwebOAuthResultPage({ title, body, statusCode = 200 }) {
  return renderImwebInstallPage({
    title,
    statusCode,
    body: `
      <h1>${escapeHtml(title)}</h1>
      <p>${body}</p>
      <a class="cta" href="/">Open AdPilot</a>
    `,
  });
}

function buildImwebOAuthErrorPage({ errorCode, message }) {
  const code = String(errorCode || '').trim();
  const detail = String(message || '').trim() || 'Imweb returned an authorization error before issuing a code.';
  const scopeHint = detail.includes('site-info:write')
    ? 'Imweb requires the <code>site-info:write</code> scope when issuing authorization codes.'
    : null;

  return renderImwebInstallPage({
    title: 'Imweb Authorization Failed',
    statusCode: 400,
    body: `
      <h1>Imweb Authorization Failed</h1>
      <p>${escapeHtml(detail)}</p>
      ${code ? `<div class="meta"><p><strong>Error code</strong> <code>${escapeHtml(code)}</code></p></div>` : ''}
      ${scopeHint ? `<p>${scopeHint}</p>` : ''}
      <a class="cta" href="${imwebAuthRepairService.IMWEB_AUTH_REPAIR_PATH}">Try Again</a>
      <br />
      <a class="cta" href="/">Open AdPilot</a>
    `,
  });
}

// ── Validate required env vars on startup ──
const REQUIRED_ENV = ['META_ACCESS_TOKEN', 'IMWEB_CLIENT_ID', 'IMWEB_CLIENT_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
const missing = REQUIRED_ENV.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error(`\n❌ Missing required environment variables:\n  ${missing.join('\n  ')}\n`);
  console.error('Set these in Render Dashboard → Environment or in a local .env file.\n');
  process.exit(1);
}

// ── Ensure data directory exists ──
// If the configured DATA_DIR isn't writable, runtimePaths already falls back to a local directory.
const DATA_DIR = runtimePaths.dataDir;
if (runtimePaths.usedFallback) {
  console.warn(`[INIT] ⚠️  Cannot write to ${runtimePaths.configuredDataDir} (${runtimePaths.fallbackReason.code}) — falling back to ${DATA_DIR}`);
  console.warn('[INIT] Data will NOT persist across deploys. Attach a Render Disk at /data for persistence.');
} else if (runtimePaths.startupRecovery?.recovered) {
  console.warn(`[INIT] Recovered ${runtimePaths.configuredDataDir} by pruning ${runtimePaths.startupRecovery.deletedSnapshotSets} old snapshot set${runtimePaths.startupRecovery.deletedSnapshotSets === 1 ? '' : 's'}`);
  console.log(`[INIT] Data directory ready: ${DATA_DIR}`);
} else {
  console.log(`[INIT] Data directory ready: ${DATA_DIR}`);
}

observabilityService.initObservability('adpilot-server');

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || `http://localhost:${config.server.port}`;
const DASHBOARD_API_KEY = process.env.DASHBOARD_API_KEY;

if (!DASHBOARD_API_KEY) {
  console.warn('[INIT] ⚠️   DASHBOARD_API_KEY not set — API auth disabled (set in production!)');
}

function requireAuth(req, res, next) {
  if (!DASHBOARD_API_KEY) return next();

  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${DASHBOARD_API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many write requests' },
});

const scanLimiter = rateLimit({
  windowMs: 300_000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Scan rate limit exceeded' },
});

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:', 'https:'],
    },
  },
}));

// ── Serve static dashboard files (frontend) ──
const FRONTEND_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(FRONTEND_DIR));

// ── CORS for dev ──
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === ALLOWED_ORIGIN) {
    res.header('Access-Control-Allow-Origin', origin);
    res.vary('Origin');
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/imweb/oauth/start', (req, res) => {
  res.redirect(imwebAuthRepairService.buildAuthorizeUrl({
    baseUrl: config.imweb.baseUrl,
    clientId: config.imweb.clientId,
    siteCode: config.imweb.siteCode,
    origin: getPublicRequestOrigin(req),
  }));
});

app.get('/imweb/oauth/callback', async (req, res) => {
  const oauthError = imwebAuthRepairService.parseOAuthError(req.query);
  if (oauthError) {
    const page = buildImwebOAuthErrorPage({
      errorCode: oauthError.code,
      message: oauthError.message,
    });
    return res.status(page.statusCode).type('html').send(page.html);
  }

  const authorizationCode = String(req.query.code || '').trim();
  if (authorizationCode) {
    try {
      const redirectUri = `${getPublicRequestOrigin(req)}${req.path}`;
      await imweb.exchangeAuthorizationCode(authorizationCode, redirectUri);
      if (!scheduler.getIsScanning()) {
        scheduler.runScan(true);
      }

      const page = buildImwebOAuthResultPage({
        title: 'Imweb Authorization Complete',
        body: 'A fresh Imweb token was saved successfully and AdPilot started a new scan. You can close this tab.',
      });
      return res.status(page.statusCode).type('html').send(page.html);
    } catch (err) {
      console.error('[IMWEB OAUTH CALLBACK] Token exchange failed:', err.message);
      const page = buildImwebOAuthResultPage({
        title: 'Imweb Authorization Failed',
        statusCode: 500,
        body: `Imweb returned an error while saving the new token: <code>${escapeHtml(err.message)}</code>`,
      });
      return res.status(page.statusCode).type('html').send(page.html);
    }
  }
  res.redirect(imwebAuthRepairService.IMWEB_AUTH_REPAIR_PATH);
});

app.use('/api', apiLimiter);
app.use('/api', (req, res, next) => {
  res.header('Cache-Control', 'private, no-store, max-age=0');
  res.header('Pragma', 'no-cache');
  if (req.path === '/health') return next();
  requireAuth(req, res, next);
});

// ═══════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════

// ── Health check ──
app.get('/api/health', (req, res) => {
  const sourceHealth = scheduler.getSourceHealth();
  const latestData = scheduler.getLatestData();
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime(),
    lastScan: scheduler.getLastScanTime()?.toISOString() || null,
    isScanning: scheduler.getIsScanning(),
    imwebAuth: imweb.getAuthState().status,
    telegram: telegram.getStatus(),
    sources: sourceHealth,
    sourceAudit: latestData.sourceAudit ? {
      status: latestData.sourceAudit.status,
      generatedAt: latestData.sourceAudit.generatedAt,
      summary: latestData.sourceAudit.summary,
    } : null,
  });
});

// ── Dashboard Overview (live KPIs + charts data) ──
app.get('/api/overview', async (req, res) => {
  try {
    res.json(await overviewService.getOverviewResponse());
  } catch (err) {
    handleInternalError(req, res, err);
  }
});

// ── Campaigns list with live data ──
app.get('/api/campaigns', requireLegacyAdOps, (req, res) => {
  res.json(campaignService.getEnrichedCampaigns(req.query));
});

app.get('/api/live-performance', requireLegacyAdOps, (req, res) => {
  try {
    res.json(livePerformanceService.buildLivePerformanceResponse(req.query));
  } catch (err) {
    handleInternalError(req, res, err);
  }
});

// ── Scan history ──
app.get('/api/scans', (req, res) => {
  res.json(contracts.scans({
    history: scheduler.getScanHistory().reverse(),
    lastScan: scheduler.getLastScanResult(),
    isScanning: scheduler.getIsScanning(),
    nextScan: scheduler.getNextScheduledRunAt()?.toISOString() || null,
  }));
});

app.get('/api/orders/:orderNo/notification-diagnostic', (req, res) => {
  const orderNo = String(req.params?.orderNo || '').trim();
  if (!orderNo) {
    return res.status(400).json({ error: 'orderNo is required' });
  }

  const diagnostics = cogsAutofillService.getOrderNotificationDiagnostics(orderNo);
  res.json({
    orderNo,
    found: Boolean(diagnostics?.notificationRecorded || diagnostics?.importedOrder),
    diagnostics,
  });
});

// ── Trigger manual scan ──
app.post('/api/scan', scanLimiter, async (req, res) => {
  if (scheduler.getIsScanning()) {
    return res.json({ status: 'busy', message: 'Scan already in progress' });
  }
  // Don't await — respond immediately, scan runs in background
  scheduler.runScan(true);
  res.json({ status: 'started', message: 'Manual scan initiated' });
});

app.post('/api/cogs/autofill-order', writeLimiter, async (req, res) => {
  try {
    if (!cogsAutofillService.isConfigured()) {
      return res.status(503).json({ ok: false, error: 'COGS autofill is not configured' });
    }

    const orderNo = String(req.body?.orderNo || '').trim();
    if (!orderNo) {
      return res.status(400).json({ ok: false, error: 'orderNo is required' });
    }

    const result = await cogsAutofillService.syncImwebOrderToCogs(orderNo);
    if (shouldDeliverPaidOrderNotification(result)) {
      await orderNotificationService.deliverPaidOrderNotification(result);
    }
    res.json(cogsAutofillService.sanitizeAutofillResultForResponse(result));
  } catch (err) {
    handleInternalError(req, res, err);
  }
});

// ── Seed Imweb token (one-time, secured by Telegram chat ID) ──
app.post('/api/seed-token', writeLimiter, async (req, res) => {
  try {
    const { chatId, refreshToken } = req.body || {};
    if (!chatId || chatId !== config.telegram.chatId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    if (!refreshToken) {
      return res.status(400).json({ error: 'refreshToken required' });
    }
    await imweb.seedRefreshToken(refreshToken);
    // Trigger a scan to get data flowing
    if (!scheduler.getIsScanning()) {
      scheduler.runScan(true);
    }
    res.json({ success: true, message: 'Token seeded and refreshed. Scan started.' });
  } catch (err) {
    handleInternalError(req, res, err);
  }
});

// ── Settings ──
app.get('/api/settings', (req, res) => {
  const settings = runtimeSettings.getSettings();
  const schedulerDiagnostics = runtimeSettings.getSchedulerDiagnostics();
  const sourceHealth = scheduler.getSourceHealth();
  const imwebAuth = imweb.getAuthState();
  const imwebRecovery = imwebAuthRepairService.buildRepairMetadata(imwebAuth);
  const latestData = scheduler.getLatestData();
  const cogsData = latestData.cogsData || null;
  const cogsDates = Object.keys(cogsData?.dailyCOGS || {}).sort();
  const cogsSheets = Array.isArray(cogsData?.sheets) ? cogsData.sheets : [];
  res.json(contracts.settings({
    rules: settings.rules,
    scheduler: {
      ...settings.scheduler,
      ...schedulerDiagnostics,
    },
    meta: {
      adAccountId: config.meta.adAccountId,
      apiVersion: config.meta.apiVersion,
      tokenExpiry: 'Long-lived token (~60 days)',
    },
    imweb: {
      siteCode: config.imweb.siteCode,
      unitCode: config.imweb.unitCode,
      scopes: imwebRecovery.scopes,
      authRepairPath: imwebRecovery.path,
      recovery: imwebRecovery,
      auth: imwebAuth,
      data: sourceHealth.imweb || {},
    },
    cogs: {
      data: sourceHealth.cogs || {},
      sheets: cogsSheets,
      coverage: {
        from: cogsDates[0] || null,
        to: cogsDates[cogsDates.length - 1] || null,
        days: cogsDates.length,
      },
      totals: {
        totalCOGS: cogsData?.totalCOGS ?? 0,
        totalShipping: cogsData?.totalShipping ?? 0,
        totalCOGSWithShipping: cogsData?.totalCOGSWithShipping ?? 0,
        grossCOGS: cogsData?.grossCOGS ?? 0,
        grossShipping: cogsData?.grossShipping ?? 0,
        refundCOGS: cogsData?.refundCOGS ?? 0,
        refundShipping: cogsData?.refundShipping ?? 0,
        itemCount: cogsData?.itemCount ?? 0,
        purchaseCount: cogsData?.purchaseCount ?? 0,
        incompletePurchaseCount: cogsData?.incompletePurchaseCount ?? 0,
        missingCostItemCount: cogsData?.missingCostItemCount ?? 0,
      },
      validation: cogsData?.validation ?? {},
    },
    telegram: telegram.getStatus(),
    sources: sourceHealth,
    sourceAudit: latestData.sourceAudit || null,
    currency: config.currency,
  }));
});

app.put('/api/settings', writeLimiter, (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ error: 'Settings payload must be an object' });
  }

  const errors = runtimeSettings.validateSettingsPatch(updates);
  if (errors.length > 0) {
    return res.status(400).json({ error: errors.join('; ') });
  }

  const result = runtimeSettings.updateSettings(updates);
  res.json({ success: true, settings: result.settings });
});

// ── Post-mortem analysis for paused ads ──
app.get('/api/postmortem', requireLegacyAdOps, (req, res) => {
  res.json(postmortemService.getPostmortemResponse(req.query));
});

// ── Spend Daily (OHLC candlestick data for the Spend & CAC chart) ──
app.get('/api/spend-daily', async (req, res) => {
  try {
    const data = scheduler.getLatestData();
    const projection = buildFinancialProjection(data);
    const result = transforms.buildSpendDaily(projection.dailyMerged, projection.transformOptions);
    res.json(contracts.spendDaily(result));
  } catch (err) {
    console.error('Spend daily error:', err.message);
    res.json([]);
  }
});

// ── Analytics deep data ──
app.get('/api/analytics', (req, res) => {
  res.json(analyticsService.getAnalyticsResponse());
});

app.get('/api/calendar-analysis', async (req, res) => {
  try {
    res.json(await calendarService.getCalendarAnalysisResponse(req.query));
  } catch (err) {
    handleInternalError(req, res, err);
  }
});

app.get('/api/reconciliation', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    res.json(await reconciliationService.getReconciliationResponse({ refresh }));
  } catch (err) {
    handleInternalError(req, res, err);
  }
});

// ── Snapshots (debug endpoints) ──
app.get('/api/snapshots', (req, res) => {
  res.json(contracts.snapshotsList(scheduler.getSnapshotsList()));
});

app.get('/api/snapshots/:scanId', (req, res) => {
  const snapshot = scheduler.getSnapshot(req.params.scanId);
  if (!snapshot) {
    return res.status(404).json({ apiVersion: contracts.API_VERSION, error: 'Snapshot not found' });
  }
  res.json(contracts.snapshotDetail(snapshot));
});

// ── SPA fallback: serve index.html for any non-API route ──
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// ═══════════════════════════════════════════════
// START SERVER + SCHEDULER
// ═══════════════════════════════════════════════

const PORT = config.server.port;

app.listen(PORT, '0.0.0.0', () => {
  const schedulerDiagnostics = runtimeSettings.getSchedulerDiagnostics();
  console.log('\n' + '='.repeat(60));
  console.log('  AdPilot Backend Server');
  console.log(`  Port: ${PORT}`);
  console.log(`  Data: ${DATA_DIR}`);
  console.log(`  Scan interval: ${schedulerDiagnostics.scanIntervalMinutes} min`);
  if (schedulerDiagnostics.driftDetected) {
    console.log(`  Scheduler drift: live ${schedulerDiagnostics.scanIntervalMinutes} min vs config ${schedulerDiagnostics.configuredScanIntervalMinutes} min`);
  }
  if (schedulerDiagnostics.migratedLegacyScheduler) {
    console.log(`  Scheduler migration: normalized legacy persisted cadence to ${schedulerDiagnostics.scanIntervalMinutes} min`);
  }
  console.log('='.repeat(60) + '\n');

  // Start the scheduler
  scheduler.startScheduler();
});
