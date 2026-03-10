// ═══════════════════════════════════════════════════════
// AdPilot — Express Server
// REST API for dashboard + autonomous optimization engine
// ═══════════════════════════════════════════════════════

const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const scheduler = require('./modules/scheduler');
const meta = require('./modules/metaClient');
const telegram = require('./modules/telegram');
const contracts = require('./contracts/v1');
const transforms = require('./transforms/charts');
const overviewService = require('./services/overviewService');
const campaignService = require('./services/campaignService');
const postmortemService = require('./services/postmortemService');
const analyticsService = require('./services/analyticsService');
const optimizationService = require('./services/optimizationService');

// ── Validate required env vars on startup ──
const REQUIRED_ENV = ['META_ACCESS_TOKEN', 'IMWEB_CLIENT_ID', 'IMWEB_CLIENT_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
const missing = REQUIRED_ENV.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error(`\n❌ Missing required environment variables:\n  ${missing.join('\n  ')}\n`);
  console.error('Set these in Render Dashboard → Environment or in a local .env file.\n');
  process.exit(1);
}

// ── Ensure data directory exists ──
// If the configured DATA_DIR (e.g. /data) isn't writable (no persistent disk attached),
// fall back to a local directory so the server can still start.
let DATA_DIR = config.paths.dataDir;
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  // Test write access
  const testFile = path.join(DATA_DIR, '.write-test');
  fs.writeFileSync(testFile, 'ok');
  fs.unlinkSync(testFile);
  console.log(`[INIT] Data directory ready: ${DATA_DIR}`);
} catch (err) {
  const fallback = path.join(__dirname, 'data');
  console.warn(`[INIT] ⚠️  Cannot write to ${DATA_DIR} (${err.code}) — falling back to ${fallback}`);
  console.warn('[INIT] Data will NOT persist across deploys. Attach a Render Disk at /data for persistence.');
  DATA_DIR = fallback;
  config.paths.dataDir = fallback;
  config.imweb.tokenFile = path.join(fallback, 'imweb_tokens.json');
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}
const LOG_DIR = path.join(DATA_DIR, 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const app = express();
app.use(express.json());

// ── Serve static dashboard files (frontend) ──
const FRONTEND_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(FRONTEND_DIR));

// ── CORS for dev ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  next();
});

// ═══════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime(),
    lastScan: scheduler.getLastScanTime()?.toISOString() || null,
    isScanning: scheduler.getIsScanning(),
    autonomousMode: config.rules.autonomousMode,
  });
});

// ── Dashboard Overview (live KPIs + charts data) ──
app.get('/api/overview', (req, res) => {
  res.json(overviewService.getOverviewResponse());
});

// ── Campaigns list with live data ──
app.get('/api/campaigns', (req, res) => {
  res.json(campaignService.getEnrichedCampaigns());
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
    nextScan: scheduler.getLastScanTime()
      ? new Date(scheduler.getLastScanTime().getTime() + config.scheduler.scanIntervalMinutes * 60 * 1000).toISOString()
      : null,
  }));
});

// ── Trigger manual scan ──
app.post('/api/scan', async (req, res) => {
  if (scheduler.getIsScanning()) {
    return res.json({ status: 'busy', message: 'Scan already in progress' });
  }
  // Don't await — respond immediately, scan runs in background
  scheduler.runScan(true);
  res.json({ status: 'started', message: 'Manual scan initiated' });
});

// ── Campaign actions (write operations — require Telegram approval) ──
app.post('/api/campaigns/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
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
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/budget', async (req, res) => {
  try {
    const { dailyBudget } = req.body;
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
    res.status(500).json({ error: err.message });
  }
});

// ── Ad set actions (require Telegram approval) ──
app.post('/api/adsets/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
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
    res.status(500).json({ error: err.message });
  }
});

// ── Ad actions (require Telegram approval) ──
app.post('/api/ads/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
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
    res.status(500).json({ error: err.message });
  }
});

// ── Execute specific optimization ──
app.post('/api/optimizations/:id/execute', async (req, res) => {
  try {
    const opts = scheduler.getAllOptimizations();
    const opt = opts.find(o => o.id === req.params.id);
    if (!opt) return res.status(404).json({ error: 'Optimization not found' });
    if (opt.executed) return res.json({ already: true, optimization: opt });

    const OptimizationEngine = require('./modules/optimizer');
    const engine = new OptimizationEngine();
    engine.actions = [opt];
    const result = await engine.executeAction(opt);
    res.json({ success: true, optimization: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Seed Imweb token (one-time, secured by Telegram chat ID) ──
app.post('/api/seed-token', async (req, res) => {
  try {
    const { chatId, refreshToken } = req.body;
    if (!chatId || chatId !== config.telegram.chatId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    if (!refreshToken) {
      return res.status(400).json({ error: 'refreshToken required' });
    }
    // Write token file so imwebClient.loadTokens() can pick it up
    const dir = path.dirname(config.imweb.tokenFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tokenData = { data: { accessToken: null, refreshToken } };
    fs.writeFileSync(config.imweb.tokenFile, JSON.stringify(tokenData, null, 2));
    // Load + refresh via imwebClient (loadTokens reads the file, refreshAccessToken gets a valid pair)
    const imweb = require('./modules/imwebClient');
    imweb.loadTokens();
    await imweb.refreshAccessToken();
    // Trigger a scan to get data flowing
    if (!scheduler.getIsScanning()) {
      scheduler.runScan(true);
    }
    res.json({ success: true, message: 'Token seeded and refreshed. Scan started.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Settings ──
app.get('/api/settings', (req, res) => {
  res.json(contracts.settings({
    rules: config.rules,
    scheduler: config.scheduler,
    meta: {
      adAccountId: config.meta.adAccountId,
      apiVersion: config.meta.apiVersion,
      tokenExpiry: 'Long-lived token (~60 days)',
    },
    imweb: {
      siteCode: config.imweb.siteCode,
    },
    currency: config.currency,
  }));
});

app.put('/api/settings', (req, res) => {
  const updates = req.body;
  // Update in-memory config (not persisted to file for safety)
  if (updates.autonomousMode !== undefined) config.rules.autonomousMode = updates.autonomousMode;
  if (updates.maxBudgetChangePercent !== undefined) config.rules.maxBudgetChangePercent = updates.maxBudgetChangePercent;
  if (updates.cpaPauseThreshold !== undefined) config.rules.cpaPauseThreshold = updates.cpaPauseThreshold;
  if (updates.scanIntervalMinutes !== undefined) config.scheduler.scanIntervalMinutes = updates.scanIntervalMinutes;
  if (updates.budgetReallocationEnabled !== undefined) config.rules.budgetReallocationEnabled = updates.budgetReallocationEnabled;
  res.json({ success: true, settings: { rules: config.rules, scheduler: config.scheduler } });
});

// ── Post-mortem analysis for paused ads ──
app.get('/api/postmortem', (req, res) => {
  res.json(postmortemService.getPostmortemResponse());
});

// ── Optimization Timeline (for micro-adjustment chart) ──
app.get('/api/optimizations/timeline', (req, res) => {
  res.json(optimizationService.getTimelineResponse());
});

// ── Spend Daily (OHLC candlestick data for the Spend & CAC chart) ──
app.get('/api/spend-daily', async (req, res) => {
  try {
    const data = scheduler.getLatestData();
    const result = transforms.buildSpendDaily(data.campaignInsights);
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
  console.log(`  Mode: ${config.rules.autonomousMode ? 'AUTONOMOUS' : 'SUGGESTION ONLY'}`);
  console.log(`  Scan interval: ${config.scheduler.scanIntervalMinutes} min`);
  console.log('='.repeat(60) + '\n');

  // Start the scheduler
  scheduler.startScheduler();
});
