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

// ── Validate required env vars on startup ──
const REQUIRED_ENV = ['META_ACCESS_TOKEN', 'IMWEB_CLIENT_ID', 'IMWEB_CLIENT_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
const missing = REQUIRED_ENV.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error(`\n❌ Missing required environment variables:\n  ${missing.join('\n  ')}\n`);
  console.error('Set these in Render Dashboard → Environment or in a local .env file.\n');
  process.exit(1);
}

// ── Ensure data directory exists ──
const DATA_DIR = config.paths.dataDir;
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`[INIT] Created data directory: ${DATA_DIR}`);
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
  const data = scheduler.getLatestData();
  const scan = scheduler.getLastScanResult();

  if (!scan) {
    return res.json({ ready: false, message: 'First scan not yet complete. Starting up...' });
  }

  // Calculate KPIs from fresh data
  const totalSpend = (data.campaignInsights || []).reduce((s, i) => s + parseFloat(i.spend || 0), 0);
  const totalPurchases = (data.campaignInsights || []).reduce((s, i) => {
    const acts = i.actions || [];
    const p = acts.find(a => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase');
    return s + (p ? parseInt(p.value) : 0);
  }, 0);
  const totalClicks = (data.campaignInsights || []).reduce((s, i) => s + parseInt(i.clicks || 0), 0);
  const totalImpressions = (data.campaignInsights || []).reduce((s, i) => s + parseInt(i.impressions || 0), 0);

  const revenue = data.revenueData || {};
  const cpa = totalPurchases > 0 ? totalSpend / totalPurchases : 0;
  const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions * 100) : 0;
  const roas = totalSpend > 0 ? revenue.netRevenue / (totalSpend * config.currency.usdToKrw) : 0;

  res.json({
    ready: true,
    lastScan: scheduler.getLastScanTime()?.toISOString(),
    isScanning: scheduler.getIsScanning(),
    kpis: {
      revenue: revenue.totalRevenue || 0,
      refunded: revenue.totalRefunded || 0,
      netRevenue: revenue.netRevenue || 0,
      totalOrders: revenue.totalOrders || 0,
      adSpend: totalSpend,
      adSpendKRW: totalSpend * config.currency.usdToKrw,
      purchases: totalPurchases,
      cpa,
      ctr,
      roas,
      refundRate: revenue.refundRate || 0,
      cancelRate: revenue.cancelRate || 0,
    },
    campaigns: (data.campaigns || []).map(c => ({
      id: c.id,
      name: c.name,
      status: c.status,
      dailyBudget: c.daily_budget,
      objective: c.objective,
      bidStrategy: c.bid_strategy,
    })),
    dailyInsights: data.campaignInsights || [],
    adSetInsights: data.adSetInsights || [],
    revenueByDay: revenue.dailyRevenue || {},
    hourlyOrders: revenue.hourlyOrders || [],
    scanStats: scan.stats || {},
  });
});

// ── Campaigns list with live data ──
app.get('/api/campaigns', async (req, res) => {
  try {
    const data = scheduler.getLatestData();
    const campaigns = data.campaigns || [];
    const insights = data.campaignInsights || [];

    const enriched = campaigns.map(c => {
      const cInsights = insights.filter(i => i.campaign_id === c.id);
      const spend = cInsights.reduce((s, i) => s + parseFloat(i.spend || 0), 0);
      const purchases = cInsights.reduce((s, i) => {
        const acts = i.actions || [];
        const p = acts.find(a => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase');
        return s + (p ? parseInt(p.value) : 0);
      }, 0);
      const clicks = cInsights.reduce((s, i) => s + parseInt(i.clicks || 0), 0);
      const impressions = cInsights.reduce((s, i) => s + parseInt(i.impressions || 0), 0);

      return {
        ...c,
        metrics7d: {
          spend,
          purchases,
          cpa: purchases > 0 ? spend / purchases : null,
          clicks,
          impressions,
          ctr: impressions > 0 ? (clicks / impressions * 100) : 0,
        },
      };
    });

    res.json({ campaigns: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Optimizations log ──
app.get('/api/optimizations', (req, res) => {
  const opts = scheduler.getAllOptimizations();
  const limit = parseInt(req.query.limit) || 50;
  const type = req.query.type || 'all';
  const priority = req.query.priority || 'all';

  let filtered = opts;
  if (type !== 'all') filtered = filtered.filter(o => o.type === type);
  if (priority !== 'all') filtered = filtered.filter(o => o.priority === priority);

  // Most recent first
  filtered = filtered.slice().reverse().slice(0, limit);

  res.json({
    total: opts.length,
    showing: filtered.length,
    optimizations: filtered,
    stats: {
      byType: countBy(opts, 'type'),
      byPriority: countBy(opts, 'priority'),
      executed: opts.filter(o => o.executed).length,
      pending: opts.filter(o => !o.executed).length,
    },
  });
});

// ── Scan history ──
app.get('/api/scans', (req, res) => {
  res.json({
    history: scheduler.getScanHistory().reverse(),
    lastScan: scheduler.getLastScanResult(),
    isScanning: scheduler.getIsScanning(),
    nextScan: scheduler.getLastScanTime()
      ? new Date(scheduler.getLastScanTime().getTime() + config.scheduler.scanIntervalMinutes * 60 * 1000).toISOString()
      : null,
  });
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

// ── Settings ──
app.get('/api/settings', (req, res) => {
  res.json({
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
  });
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
  const data = scheduler.getLatestData();
  const ads = data.ads || [];
  const adInsights = data.adInsights || [];
  const campaigns = data.campaigns || [];
  const adSets = data.adSets || [];

  // Build performance data for ALL ads (active + paused)
  const adPerformance = ads.map(ad => {
    const insights = adInsights.filter(i => i.ad_id === ad.id);
    const totalSpend = insights.reduce((s, i) => s + parseFloat(i.spend || 0), 0);
    const totalClicks = insights.reduce((s, i) => s + parseInt(i.clicks || 0), 0);
    const totalImpressions = insights.reduce((s, i) => s + parseInt(i.impressions || 0), 0);
    const totalPurchases = insights.reduce((s, i) => {
      const acts = i.actions || [];
      const p = acts.find(a => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase');
      return s + (p ? parseInt(p.value) : 0);
    }, 0);

    const ctrs = insights.map(i => parseFloat(i.ctr || 0)).filter(c => c > 0);
    const cpms = insights.map(i => parseFloat(i.cpm || 0)).filter(c => c > 0);
    const freqs = insights.map(i => parseFloat(i.frequency || 0)).filter(f => f > 0);

    const peakCTR = ctrs.length > 0 ? Math.max(...ctrs) : 0;
    const avgCTR = ctrs.length > 0 ? ctrs.reduce((a, b) => a + b, 0) / ctrs.length : 0;
    const lastCTR = ctrs.length > 0 ? ctrs[ctrs.length - 1] : 0;
    const avgCPM = cpms.length > 0 ? cpms.reduce((a, b) => a + b, 0) / cpms.length : 0;
    const lastFreq = freqs.length > 0 ? freqs[freqs.length - 1] : 0;
    const cpa = totalPurchases > 0 ? totalSpend / totalPurchases : null;

    // Generate lessons for paused ads
    const lessons = [];
    if (ad.effective_status !== 'ACTIVE') {
      if (totalSpend > 0 && totalPurchases === 0) {
        lessons.push({ type: 'no_conversions', text: `Spent $${totalSpend.toFixed(2)} with zero purchases — creative or targeting didn't resonate` });
      }
      if (cpa && cpa > 30) {
        lessons.push({ type: 'high_cpa', text: `CPA of $${cpa.toFixed(2)} was too high — audience may have been too broad or creative lacked urgency` });
      }
      if (peakCTR > 0 && lastCTR > 0 && ((peakCTR - lastCTR) / peakCTR) > 0.3) {
        lessons.push({ type: 'ctr_decay', text: `CTR dropped ${((peakCTR - lastCTR) / peakCTR * 100).toFixed(0)}% from peak (${peakCTR.toFixed(2)}% → ${lastCTR.toFixed(2)}%) — audience fatigue` });
      }
      if (lastFreq > 3) {
        lessons.push({ type: 'high_frequency', text: `Frequency reached ${lastFreq.toFixed(1)} — same people seeing the ad too many times` });
      }
      if (avgCTR > 1.5 && totalPurchases === 0) {
        lessons.push({ type: 'clicks_no_purchase', text: `Good CTR (${avgCTR.toFixed(2)}%) but no purchases — landing page or pricing may be the issue` });
      }
      if (totalSpend === 0) {
        lessons.push({ type: 'no_data', text: 'No spend data in the last 7 days — was paused before this period' });
      }
      if (lessons.length === 0 && totalSpend > 0) {
        lessons.push({ type: 'general', text: `Spent $${totalSpend.toFixed(2)} with ${totalPurchases} purchase${totalPurchases !== 1 ? 's' : ''} — manually paused or replaced by better creative` });
      }
    }

    const campaign = campaigns.find(c => c.id === ad.campaign_id);

    return {
      id: ad.id,
      name: ad.name,
      status: ad.status,
      effectiveStatus: ad.effective_status,
      campaignId: ad.campaign_id,
      campaignName: campaign ? campaign.name : 'Unknown',
      adsetId: ad.adset_id,
      daysOfData: insights.length,
      spend: totalSpend,
      clicks: totalClicks,
      impressions: totalImpressions,
      purchases: totalPurchases,
      cpa,
      avgCTR,
      peakCTR,
      lastCTR,
      avgCPM,
      lastFrequency: lastFreq,
      lessons,
    };
  });

  // Separate active vs inactive
  const active = adPerformance.filter(a => a.effectiveStatus === 'ACTIVE');
  const inactive = adPerformance.filter(a => a.effectiveStatus !== 'ACTIVE' && a.spend > 0)
    .sort((a, b) => b.spend - a.spend);
  const noData = adPerformance.filter(a => a.effectiveStatus !== 'ACTIVE' && a.spend === 0);

  // Aggregate lessons across all inactive
  const lessonsSummary = {};
  inactive.forEach(a => {
    a.lessons.forEach(l => {
      if (!lessonsSummary[l.type]) lessonsSummary[l.type] = { count: 0, examples: [] };
      lessonsSummary[l.type].count++;
      if (lessonsSummary[l.type].examples.length < 3) {
        lessonsSummary[l.type].examples.push(a.name);
      }
    });
  });

  res.json({
    active,
    inactive,
    noData,
    lessonsSummary,
    totals: {
      activeCount: active.length,
      inactiveWithData: inactive.length,
      inactiveNoData: noData.length,
      totalAds: ads.length,
    },
  });
});

// ── Analytics deep data ──
app.get('/api/analytics', (req, res) => {
  const data = scheduler.getLatestData();
  const revenue = data.revenueData || {};

  res.json({
    dailyInsights: data.campaignInsights || [],
    adSetInsights: data.adSetInsights || [],
    adInsights: data.adInsights || [],
    revenueByDay: revenue.dailyRevenue || {},
    hourlyOrders: revenue.hourlyOrders || [],
    refundRate: revenue.refundRate || 0,
    cancelRate: revenue.cancelRate || 0,
    totalRefunded: revenue.totalRefunded || 0,
    totalRevenue: revenue.totalRevenue || 0,
    netRevenue: revenue.netRevenue || 0,
  });
});

// ── Helper ──
function countBy(arr, key) {
  return arr.reduce((acc, item) => {
    acc[item[key]] = (acc[item[key]] || 0) + 1;
    return acc;
  }, {});
}

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
