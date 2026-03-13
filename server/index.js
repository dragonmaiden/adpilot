// ═══════════════════════════════════════════════════════
// AdPilot — Express Server
// REST API for dashboard + autonomous optimization engine
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
const meta = require('./modules/metaClient');
const telegram = require('./modules/telegram');
const contracts = require('./contracts/v1');
const transforms = require('./transforms/charts');
const overviewService = require('./services/overviewService');
const campaignService = require('./services/campaignService');
const postmortemService = require('./services/postmortemService');
const analyticsService = require('./services/analyticsService');
const calendarService = require('./services/calendarService');
const optimizationService = require('./services/optimizationService');
const reconciliationService = require('./services/reconciliationService');
const operatorSummaryService = require('./services/operatorSummaryService');
const briefService = require('./services/briefService');
const cogsAutofillService = require('./services/cogsAutofillService');
const imwebAppInstallService = require('./services/imwebAppInstallService');
const { isExecutableOptimization, requiresApproval } = require('./domain/optimizationSemantics');

function isValidMetaId(id) {
  return /^\d{1,20}$/.test(String(id || ''));
}

function handleInternalError(req, res, err) {
  console.error(`[API] ${req.method} ${req.path} error:`, err);
  res.status(500).json({ error: 'Internal server error' });
}

function validateMetaIdParam(req, res, next) {
  if (!isValidMetaId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid Meta object ID' });
  }
  next();
}

function isFiniteNumberInRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isValidWebhookToken(req) {
  const expectedToken = cogsAutofillService.getWebhookToken();
  if (!expectedToken) return true;

  const candidates = [
    req.get('x-imweb-webhook-token'),
    req.get('x-webhook-token'),
    req.query?.token,
    req.body?.token,
    req.body?.webhookToken,
    req.body?.secret,
  ];

  return candidates.some(candidate => String(candidate || '').trim() === expectedToken);
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

function buildImwebInstallSuccessPage(result) {
  const configuredSite = config.imweb.siteCode
    ? `<p><strong>Configured Site</strong> <code>${escapeHtml(config.imweb.siteCode)}</code></p>`
    : '';
  const nextStep = result.integrationStatus === 'already_complete'
    ? 'The site was already marked complete in Imweb. You can now verify the site status in Imweb Developers.'
    : 'Imweb install finished and the site integration completion call succeeded. You can now verify that the site moves to 연동완료 in Imweb Developers.';

  return renderImwebInstallPage({
    title: 'Imweb Install Complete',
    body: `
      <h1>Imweb Install Complete</h1>
      <p>${escapeHtml(nextStep)}</p>
      <div class="meta">
        <p><strong>Site Code</strong> <code>${escapeHtml(result.siteCode)}</code></p>
        <p><strong>Redirect URI</strong> <code>${escapeHtml(result.redirectUri)}</code></p>
        <p><strong>Service URL</strong> <code>${escapeHtml(result.serviceUrl)}</code></p>
        <p><strong>Scope</strong> <code>${escapeHtml(result.scope)}</code></p>
        <p><strong>Status</strong> <code>${escapeHtml(result.integrationStatus)}</code></p>
        ${configuredSite}
      </div>
      <a class="cta" href="/">Open AdPilot</a>
    `,
  });
}

function buildImwebInstallErrorPage(err, statusCode = 500) {
  return renderImwebInstallPage({
    title: 'Imweb Install Failed',
    statusCode,
    body: `
      <h1>Imweb Install Failed</h1>
      <p>${escapeHtml(err?.message || 'Unknown install error')}</p>
      <p>Please confirm the Imweb app uses the correct Service URL and Redirect URI, then try the install again.</p>
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
} else {
  console.log(`[INIT] Data directory ready: ${DATA_DIR}`);
}

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

app.post('/webhooks/imweb', writeLimiter, async (req, res) => {
  try {
    if (!isValidWebhookToken(req)) {
      return res.status(401).json({ ok: false, error: 'Invalid webhook token' });
    }

    const result = await cogsAutofillService.handleWebhookPayload(req.body || {});
    if (result?.status === 'appended') {
      await telegram.sendMessage(cogsAutofillService.buildAutofillNotification(result));
    }
    res.json(result);
  } catch (err) {
    handleInternalError(req, res, err);
  }
});

app.get('/imweb/install', async (req, res) => {
  try {
    const install = imwebAppInstallService.beginInstall({
      req,
      siteCode: req.query?.siteCode,
    });
    res.redirect(302, install.authorizeUrl);
  } catch (err) {
    const page = buildImwebInstallErrorPage(err, 400);
    res.status(page.statusCode).type('html').send(page.html);
  }
});

app.get('/imweb/oauth/callback', async (req, res) => {
  try {
    if (req.query?.error) {
      const page = buildImwebInstallErrorPage(new Error(`${req.query.error}: ${req.query.error_description || 'OAuth callback returned an error'}`), 400);
      return res.status(page.statusCode).type('html').send(page.html);
    }

    const code = String(req.query?.code || '').trim();
    const state = String(req.query?.state || '').trim();
    if (!code || !state) {
      const page = buildImwebInstallErrorPage(new Error('Missing OAuth code or state'), 400);
      return res.status(page.statusCode).type('html').send(page.html);
    }

    const result = await imwebAppInstallService.finalizeInstall({ req, code, state });
    const page = buildImwebInstallSuccessPage(result);
    res.status(page.statusCode).type('html').send(page.html);
  } catch (err) {
    const page = buildImwebInstallErrorPage(err, 500);
    res.status(page.statusCode).type('html').send(page.html);
  }
});

app.use('/api', apiLimiter);
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  requireAuth(req, res, next);
});

// ═══════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════

// ── Health check ──
app.get('/api/health', (req, res) => {
  const sourceHealth = scheduler.getSourceHealth();
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime(),
    lastScan: scheduler.getLastScanTime()?.toISOString() || null,
    isScanning: scheduler.getIsScanning(),
    autonomousMode: runtimeSettings.getRules().autonomousMode,
    imwebAuth: imweb.getAuthState().status,
    telegram: telegram.getStatus(),
    sources: sourceHealth,
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

app.get('/api/operator-summary', async (req, res) => {
  try {
    res.json(await operatorSummaryService.getOperatorSummaryResponse());
  } catch (err) {
    handleInternalError(req, res, err);
  }
});

app.get('/api/operator-brief', async (req, res) => {
  try {
    res.json(await briefService.getOperatorBriefResponse());
  } catch (err) {
    handleInternalError(req, res, err);
  }
});

// ── Campaigns list with live data ──
app.get('/api/campaigns', (req, res) => {
  res.json(campaignService.getEnrichedCampaigns(req.query));
});

// ── Optimizations log ──
app.get('/api/optimizations', (req, res) => {
  res.json(optimizationService.getOptimizationsResponse(req.query));
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
    if (result?.status === 'appended') {
      await telegram.sendMessage(cogsAutofillService.buildAutofillNotification(result));
    }
    res.json(result);
  } catch (err) {
    handleInternalError(req, res, err);
  }
});

// ── Campaign actions (write operations — require Telegram approval) ──
app.post('/api/campaigns/:id/status', writeLimiter, validateMetaIdParam, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['ACTIVE', 'PAUSED'].includes(status)) {
      return res.status(400).json({ error: 'Status must be ACTIVE or PAUSED' });
    }

    // Find campaign name
    const data = scheduler.getLatestData();
    const campaign = (data.campaigns || []).find(c => c.id === req.params.id);
    const name = campaign ? campaign.name : req.params.id;

    // Request Telegram approval
    const approvalId = await telegram.requestApproval({
      type: 'status',
      level: 'campaign',
      targetId: req.params.id,
      targetName: name,
      action: `${status === 'PAUSED' ? 'Pause' : 'Resume'} campaign "${name}"`,
      reason: `Manual ${status === 'PAUSED' ? 'pause' : 'resume'} request from dashboard`,
      impact: status === 'PAUSED' ? 'Campaign will stop spending immediately' : 'Campaign will resume spending at its daily budget',
      priority: 'high',
    });

    if (!approvalId) {
      return res.status(500).json({ error: 'Failed to send Telegram approval' });
    }

    // Respond immediately — execution happens after approval
    res.json({ success: true, pending: true, message: 'Approval request sent to Telegram. Waiting for your response.' });

    // Wait and execute in background
    const response = await telegram.waitForApproval(approvalId, 300000);
    if (response.approved) {
      const result = await meta.updateCampaignStatus(req.params.id, status);
      await telegram.sendMessage(`✅ Campaign "${name}" ${status === 'PAUSED' ? 'paused' : 'resumed'} successfully.`);
    }
  } catch (err) {
    handleInternalError(req, res, err);
  }
});

app.post('/api/campaigns/:id/budget', writeLimiter, validateMetaIdParam, async (req, res) => {
  try {
    const { dailyBudget } = req.body || {};
    if (!isFiniteNumberInRange(dailyBudget, 0.01, 10000)) {
      return res.status(400).json({ error: 'dailyBudget must be a positive number up to 10000' });
    }
    const cents = Math.round(dailyBudget * 100);

    const data = scheduler.getLatestData();
    const campaign = (data.campaigns || []).find(c => c.id === req.params.id);
    const name = campaign ? campaign.name : req.params.id;
    const oldBudget = campaign ? (parseInt(campaign.daily_budget) / 100).toFixed(2) : '?';

    const approvalId = await telegram.requestApproval({
      type: 'budget',
      level: 'campaign',
      targetId: req.params.id,
      targetName: name,
      action: `Change daily budget from $${oldBudget} → $${dailyBudget}`,
      reason: `Manual budget change from dashboard`,
      impact: `New daily spend will be $${dailyBudget}/day`,
      priority: 'high',
    });

    if (!approvalId) {
      return res.status(500).json({ error: 'Failed to send Telegram approval' });
    }

    res.json({ success: true, pending: true, message: 'Budget change sent to Telegram for approval.' });

    const response = await telegram.waitForApproval(approvalId, 300000);
    if (response.approved) {
      const result = await meta.updateCampaignBudget(req.params.id, cents);
      await telegram.sendMessage(`✅ Budget for "${name}" updated to $${dailyBudget}/day.`);
    }
  } catch (err) {
    handleInternalError(req, res, err);
  }
});

// ── Ad set actions (require Telegram approval) ──
app.post('/api/adsets/:id/status', writeLimiter, validateMetaIdParam, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['ACTIVE', 'PAUSED'].includes(status)) {
      return res.status(400).json({ error: 'Status must be ACTIVE or PAUSED' });
    }

    const data = scheduler.getLatestData();
    const adSet = (data.adSets || []).find(a => a.id === req.params.id);
    const name = adSet ? adSet.name : req.params.id;

    const approvalId = await telegram.requestApproval({
      type: 'status',
      level: 'adset',
      targetId: req.params.id,
      targetName: name,
      action: `${status === 'PAUSED' ? 'Pause' : 'Resume'} ad set "${name}"`,
      reason: `Manual ${status === 'PAUSED' ? 'pause' : 'resume'} request from dashboard`,
      impact: status === 'PAUSED' ? 'Ad set will stop spending immediately' : 'Ad set will resume spending',
      priority: 'high',
    });

    if (!approvalId) {
      return res.status(500).json({ error: 'Failed to send Telegram approval' });
    }

    res.json({ success: true, pending: true, message: 'Approval request sent to Telegram.' });

    const response = await telegram.waitForApproval(approvalId, 300000);
    if (response.approved) {
      const result = await meta.updateAdSetStatus(req.params.id, status);
      await telegram.sendMessage(`✅ Ad set "${name}" ${status === 'PAUSED' ? 'paused' : 'resumed'} successfully.`);
    }
  } catch (err) {
    handleInternalError(req, res, err);
  }
});

// ── Ad actions (require Telegram approval) ──
app.post('/api/ads/:id/status', writeLimiter, validateMetaIdParam, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['ACTIVE', 'PAUSED'].includes(status)) {
      return res.status(400).json({ error: 'Status must be ACTIVE or PAUSED' });
    }

    const data = scheduler.getLatestData();
    const ad = (data.ads || []).find(a => a.id === req.params.id);
    const name = ad ? ad.name : req.params.id;

    const approvalId = await telegram.requestApproval({
      type: 'status',
      level: 'ad',
      targetId: req.params.id,
      targetName: name,
      action: `${status === 'PAUSED' ? 'Pause' : 'Resume'} ad "${name}"`,
      reason: `Manual ${status === 'PAUSED' ? 'pause' : 'resume'} request from dashboard`,
      impact: status === 'PAUSED' ? 'Ad will stop serving immediately' : 'Ad will resume serving',
      priority: 'high',
    });

    if (!approvalId) {
      return res.status(500).json({ error: 'Failed to send Telegram approval' });
    }

    res.json({ success: true, pending: true, message: 'Approval request sent to Telegram.' });

    const response = await telegram.waitForApproval(approvalId, 300000);
    if (response.approved) {
      const result = await meta.updateAdStatus(req.params.id, status);
      await telegram.sendMessage(`✅ Ad "${name}" ${status === 'PAUSED' ? 'paused' : 'resumed'} successfully.`);
    }
  } catch (err) {
    handleInternalError(req, res, err);
  }
});

// ── Execute specific optimization ──
app.post('/api/optimizations/:id/execute', writeLimiter, async (req, res) => {
  try {
    const opts = scheduler.getAllOptimizations();
    const opt = opts.find(o => o.id === req.params.id);
    if (!opt) return res.status(404).json({ error: 'Optimization not found' });
    if (opt.executed) return res.json({ already: true, optimization: opt });
    if (!isExecutableOptimization(opt)) {
      return res.status(400).json({ error: 'Optimization is advisory only and cannot be executed.' });
    }
    if (!requiresApproval(opt)) {
      return res.status(400).json({ error: 'Optimization does not require Telegram approval.' });
    }
    if (opt.approvalStatus === 'pending') {
      return res.json({ success: true, pending: true, alreadyRequested: true, optimization: opt });
    }

    const OptimizationEngine = require('./modules/optimizer');
    const engine = new OptimizationEngine();
    const approvalId = await telegram.requestApproval(opt);
    if (!approvalId) {
      const failed = scheduler.updateOptimization(opt.id, {
        executionResult: 'Failed to send Telegram approval request',
      }) || opt;
      return res.status(500).json({ error: 'Failed to send Telegram approval', optimization: failed });
    }

    const requestedAt = new Date().toISOString();
    const queued = scheduler.updateOptimization(opt.id, {
      approvalStatus: 'pending',
      approvalRequestedAt: requestedAt,
      executionResult: 'Awaiting Telegram approval',
    }) || opt;

    res.json({
      success: true,
      pending: true,
      message: 'Approval request sent to Telegram.',
      optimization: queued,
    });

    (async () => {
      try {
        const response = await telegram.waitForApproval(approvalId, 300000);
        const liveOpt = scheduler.getAllOptimizations().find(item => item.id === opt.id) || queued;

        if (response.approved) {
          await engine.executeAction(liveOpt);
          scheduler.updateOptimization(liveOpt.id, {
            executed: liveOpt.executed,
            executionResult: liveOpt.executionResult,
            approvalStatus: 'approved',
          });

          const resultEmoji = liveOpt.executed ? '✅' : '❌';
          await telegram.sendMessage(
            `${resultEmoji} <b>Execution Result</b>\n\n<b>Action:</b> ${liveOpt.action}\n<b>Result:</b> ${liveOpt.executionResult}`
          );
          return;
        }

        const rejectedStatus = String(response.reason || '').toLowerCase().includes('timeout')
          ? 'expired'
          : 'rejected';
        scheduler.updateOptimization(liveOpt.id, {
          executed: false,
          approvalStatus: rejectedStatus,
          executionResult: `${rejectedStatus === 'expired' ? 'Expired' : 'Rejected'}: ${response.reason}`,
        });
      } catch (err) {
        console.error('[API] Optimization approval flow failed:', err.message);
        scheduler.updateOptimization(opt.id, {
          executed: false,
          approvalStatus: null,
          executionResult: `Approval flow failed: ${err.message}`,
        });
      }
    })();
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
  const sourceHealth = scheduler.getSourceHealth();
  const latestData = scheduler.getLatestData();
  const cogsData = latestData.cogsData || null;
  const cogsDates = Object.keys(cogsData?.dailyCOGS || {}).sort();
  const cogsSheets = Array.isArray(cogsData?.sheets) ? cogsData.sheets : [];
  res.json(contracts.settings({
    rules: settings.rules,
    scheduler: settings.scheduler,
    meta: {
      adAccountId: config.meta.adAccountId,
      apiVersion: config.meta.apiVersion,
      tokenExpiry: 'Long-lived token (~60 days)',
    },
    imweb: {
      siteCode: config.imweb.siteCode,
      unitCode: config.imweb.unitCode,
      app: {
        serviceUrl: imwebAppInstallService.getServiceUrl(req),
        redirectUri: imwebAppInstallService.getRedirectUri(req),
        installScope: imwebAppInstallService.getInstallScope(),
        installedSite: imwebAppInstallService.getInstalledSite(),
      },
      auth: imweb.getAuthState(),
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
app.get('/api/postmortem', (req, res) => {
  res.json(postmortemService.getPostmortemResponse(req.query));
});

// ── Optimization Timeline (for micro-adjustment chart) ──
app.get('/api/optimizations/timeline', (req, res) => {
  res.json(optimizationService.getTimelineResponse());
});

// ── Spend Daily (OHLC candlestick data for the Spend & CAC chart) ──
app.get('/api/spend-daily', async (req, res) => {
  try {
    const data = scheduler.getLatestData();
    const dailyMerged = transforms.buildDailyMerged(
      data.revenueData?.dailyRevenue,
      data.campaignInsights,
      data.cogsData?.dailyCOGS
    );
    const result = transforms.buildSpendDaily(dailyMerged);
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
  console.log('\n' + '='.repeat(60));
  console.log('  AdPilot Backend Server');
  console.log(`  Port: ${PORT}`);
  console.log(`  Data: ${DATA_DIR}`);
  console.log(`  Mode: ${runtimeSettings.getRules().autonomousMode ? 'AUTONOMOUS' : 'SUGGESTION ONLY'}`);
  console.log(`  Scan interval: ${runtimeSettings.getSchedulerSettings().scanIntervalMinutes} min`);
  console.log('='.repeat(60) + '\n');

  // Start the scheduler
  scheduler.startScheduler();
});
