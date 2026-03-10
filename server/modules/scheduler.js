// ═══════════════════════════════════════════════════════
// AdPilot — Scan Scheduler
// Runs hourly scans, pulls fresh data, runs optimizer
// ═══════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const config = require('../config');
const meta = require('./metaClient');
const imweb = require('./imwebClient');
const OptimizationEngine = require('./optimizer');
const telegram = require('./telegram');

const DATA_DIR = config.paths.dataDir;
const LOG_DIR = path.join(DATA_DIR, 'logs');

// ── State ──
let lastScanTime = null;
let lastScanResult = null;
let scanHistory = [];
let allOptimizations = loadData('all_optimizations.json') || [];
let latestData = {
  campaigns: [],
  adSets: [],
  ads: [],
  campaignInsights: [],
  adSetInsights: [],
  adInsights: [],
  revenueData: null,
  orders: [],
};
let isScanning = false;

// ── Date helpers ──
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── Save data to disk ──
function saveData(filename, data) {
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
}

// ── Load data from disk ──
function loadData(filename) {
  const filepath = path.join(DATA_DIR, filename);
  if (fs.existsSync(filepath)) {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  }
  return null;
}

// ═══════════════════════════════════════════════
// MAIN SCAN FUNCTION
// ═══════════════════════════════════════════════

async function runScan(manual = false) {
  if (isScanning) {
    console.log('[SCHEDULER] Scan already in progress, skipping');
    return { status: 'skipped', reason: 'Scan already in progress' };
  }

  isScanning = true;
  const scanStart = Date.now();
  const scanId = scanStart;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[SCHEDULER] ${manual ? 'MANUAL' : 'SCHEDULED'} SCAN #${scanId}`);
  console.log(`[SCHEDULER] Started at ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(60)}\n`);

  const scanResult = {
    scanId,
    startTime: new Date().toISOString(),
    endTime: null,
    manual,
    steps: [],
    optimizations: [],
    errors: [],
    stats: {},
  };

  try {
    // ── Step 1: Pull Meta Ads Structure ──
    console.log('[SCHEDULER] Step 1: Fetching Meta Ads campaigns, ad sets, ads...');
    const [campaigns, adSets, ads] = await Promise.all([
      meta.getCampaigns(),
      meta.getAdSets(),
      meta.getAds(),
    ]);
    latestData.campaigns = campaigns;
    latestData.adSets = adSets;
    latestData.ads = ads;
    scanResult.steps.push({ step: 'meta_structure', campaigns: campaigns.length, adSets: adSets.length, ads: ads.length });
    console.log(`[SCHEDULER]   → ${campaigns.length} campaigns, ${adSets.length} ad sets, ${ads.length} ads`);

    // ── Step 2: Pull Meta Ads Insights (full history from account creation) ──
    console.log('[SCHEDULER] Step 2: Fetching Meta Ads insights (full history)...');
    const since = '2026-02-01'; // Account created Feb 2 2026 — fetch from Feb 1 to catch everything
    const until = today();
    const [campaignInsights, adSetInsights, adInsights] = await Promise.all([
      meta.getAllCampaignInsights(since, until),
      meta.getAllAdSetInsights(since, until),
      meta.getAllAdInsights(since, until),
    ]);
    latestData.campaignInsights = campaignInsights;
    latestData.adSetInsights = adSetInsights;
    latestData.adInsights = adInsights;
    scanResult.steps.push({
      step: 'meta_insights',
      period: `${since} to ${until}`,
      campaignRows: campaignInsights.length,
      adSetRows: adSetInsights.length,
      adRows: adInsights.length,
    });
    console.log(`[SCHEDULER]   → ${campaignInsights.length} campaign, ${adSetInsights.length} ad set, ${adInsights.length} ad insight rows`);

    // ── Step 3: Pull Imweb Orders ──
    console.log('[SCHEDULER] Step 3: Fetching Imweb orders...');
    try {
      const orders = await imweb.getAllOrders();
      latestData.orders = orders;
      latestData.revenueData = imweb.processOrders(orders);
      scanResult.steps.push({
        step: 'imweb_orders',
        totalOrders: orders.length,
        revenue: latestData.revenueData.totalRevenue,
        refunded: latestData.revenueData.totalRefunded,
        netRevenue: latestData.revenueData.netRevenue,
      });
      console.log(`[SCHEDULER]   → ${orders.length} orders, ₩${latestData.revenueData.netRevenue.toLocaleString()} net revenue`);
    } catch (err) {
      console.error('[SCHEDULER]   ⚠ Imweb fetch failed:', err.message);
      scanResult.errors.push({ step: 'imweb_orders', error: err.message });
      // Continue with cached data if available
    }

    // ── Step 4: Run Optimization Engine ──
    console.log('[SCHEDULER] Step 4: Running optimization engine...');
    const optimizer = new OptimizationEngine();
    const optimizations = await optimizer.analyze(
      campaigns, adSets, ads,
      campaignInsights, adSetInsights, adInsights,
      latestData.revenueData
    );
    scanResult.optimizations = optimizations;
    scanResult.steps.push({ step: 'optimizer', totalOptimizations: optimizations.length });
    console.log(`[SCHEDULER]   → ${optimizations.length} optimizations generated`);

    // Send Telegram scan summary
    await telegram.sendScanSummary(scanResult);

    // Log optimization breakdown
    const byType = {};
    const byPriority = {};
    for (const opt of optimizations) {
      byType[opt.type] = (byType[opt.type] || 0) + 1;
      byPriority[opt.priority] = (byPriority[opt.priority] || 0) + 1;
    }
    console.log(`[SCHEDULER]   Types: ${JSON.stringify(byType)}`);
    console.log(`[SCHEDULER]   Priority: ${JSON.stringify(byPriority)}`);

    // ── Step 5: Execute high-priority actions (if autonomous mode) ──
    if (config.rules.autonomousMode) {
      console.log('[SCHEDULER] Step 5: Executing high-priority optimizations...');
      const executed = await optimizer.executeHighPriority();
      scanResult.steps.push({
        step: 'execution',
        attempted: executed.length,
        succeeded: executed.filter(a => a.executed).length,
        failed: executed.filter(a => !a.executed).length,
      });
      console.log(`[SCHEDULER]   → ${executed.filter(a => a.executed).length} executed, ${executed.filter(a => !a.executed).length} failed`);
    } else {
      console.log('[SCHEDULER] Step 5: Autonomous mode OFF — suggestions only');
      scanResult.steps.push({ step: 'execution', note: 'Autonomous mode disabled' });
    }

    // ── Step 6: Save results ──
    allOptimizations.push(...optimizations);
    // Keep only last 500 optimizations in memory
    if (allOptimizations.length > 500) allOptimizations = allOptimizations.slice(-500);
    // Persist optimizations so they survive restarts
    saveData('all_optimizations.json', allOptimizations);

    saveData('latest_scan.json', scanResult);
    saveData('latest_data.json', {
      campaigns: latestData.campaigns,
      adSets: latestData.adSets,
      ads: latestData.ads,
      revenueData: latestData.revenueData,
      timestamp: new Date().toISOString(),
    });

    // Compute stats
    const totalSpend7d = campaignInsights.reduce((s, i) => s + parseFloat(i.spend || 0), 0);
    const totalPurchases7d = campaignInsights.reduce((s, i) => {
      const acts = i.actions || [];
      const p = acts.find(a => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase');
      return s + (p ? parseInt(p.value) : 0);
    }, 0);

    scanResult.stats = {
      totalSpend7d: totalSpend7d.toFixed(2),
      totalPurchases7d,
      avgCPA7d: totalPurchases7d > 0 ? (totalSpend7d / totalPurchases7d).toFixed(2) : 'N/A',
      activeCampaigns: campaigns.filter(c => c.status === 'ACTIVE').length,
      activeAds: ads.filter(a => a.effective_status === 'ACTIVE').length,
      roas: latestData.revenueData ? (latestData.revenueData.netRevenue / (totalSpend7d * config.currency.usdToKrw)).toFixed(2) + 'x' : 'N/A',
    };

  } catch (err) {
    console.error('[SCHEDULER] SCAN FAILED:', err.message);
    scanResult.errors.push({ step: 'fatal', error: err.message });
  }

  scanResult.endTime = new Date().toISOString();
  scanResult.durationMs = Date.now() - scanStart;

  lastScanTime = new Date();
  lastScanResult = scanResult;
  scanHistory.push({ scanId, time: lastScanTime.toISOString(), optimizations: scanResult.optimizations.length, errors: scanResult.errors.length });
  if (scanHistory.length > 100) scanHistory = scanHistory.slice(-100);

  isScanning = false;

  console.log(`\n[SCHEDULER] Scan complete in ${scanResult.durationMs}ms`);
  console.log(`[SCHEDULER] ${scanResult.optimizations.length} optimizations, ${scanResult.errors.length} errors\n`);

  return scanResult;
}

// ═══════════════════════════════════════════════
// SCHEDULER START
// ═══════════════════════════════════════════════

let cronJob = null;

function startScheduler() {
  console.log(`[SCHEDULER] Starting hourly scan scheduler (every ${config.scheduler.scanIntervalMinutes} min)`);

  // Load Imweb tokens
  imweb.loadTokens();

  // Start Telegram polling for approval responses
  telegram.startPolling();
  telegram.sendMessage('🤖 <b>AdPilot Agent Started</b>\n\nAutonomous scanning is active. All $ decisions will require your approval here.');

  // Run initial scan after 5 seconds
  setTimeout(() => runScan(false), 5000);

  // Schedule hourly scans
  cronJob = cron.schedule(`*/${config.scheduler.scanIntervalMinutes} * * * *`, () => {
    runScan(false);
  });

  return cronJob;
}

function stopScheduler() {
  if (cronJob) {
    cronJob.stop();
    console.log('[SCHEDULER] Scheduler stopped');
  }
}

// ═══════════════════════════════════════════════
// GETTERS
// ═══════════════════════════════════════════════

function getLatestData() { return latestData; }
function getLastScanResult() { return lastScanResult; }
function getLastScanTime() { return lastScanTime; }
function getScanHistory() { return scanHistory; }
function getAllOptimizations() { return allOptimizations; }
function getIsScanning() { return isScanning; }

module.exports = {
  runScan,
  startScheduler,
  stopScheduler,
  getLatestData,
  getLastScanResult,
  getLastScanTime,
  getScanHistory,
  getAllOptimizations,
  getIsScanning,
};
