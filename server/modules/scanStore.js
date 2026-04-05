const fs = require('fs');
const path = require('path');
const runtimePaths = require('../runtime/paths');

const DATA_DIR = runtimePaths.dataDir;
const SNAPSHOT_DIR = path.join(DATA_DIR, 'snapshots');
const MAX_OPTIMIZATIONS = 500;
const MAX_SCAN_HISTORY = 100;
const ALL_OPTIMIZATIONS_FILE = 'all_optimizations.json';
const LATEST_SCAN_FILE = 'latest_scan.json';
const LATEST_DATA_FILE = 'latest_data.json';
const SCAN_HISTORY_FILE = 'scan_history.json';
const LAST_SUCCESSFUL_IMWEB_ORDERS_FILE = 'last_successful_imweb_orders.json';
const LAST_SUCCESSFUL_REVENUE_FILE = 'last_successful_revenue.json';
const SOURCE_KEYS = ['metaStructure', 'metaInsights', 'imweb', 'cogs'];

function createSourceState() {
  return {
    status: 'unknown',
    stale: false,
    hasData: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  };
}

function createSourcesState() {
  return SOURCE_KEYS.reduce((result, key) => {
    result[key] = createSourceState();
    return result;
  }, {});
}

function createLatestDataState() {
  return {
    campaigns: [],
    adSets: [],
    ads: [],
    campaignInsights: [],
    adInsights: [],
    revenueData: null,
    orders: [],
    cogsData: null,
    economicsLedger: null,
    sources: createSourcesState(),
  };
}

function saveData(filename, data) {
  const filepath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(filepath, 0o600);
}

function loadData(filename, fallback = null) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (err) {
    console.warn(`[STORE] Failed to load ${filename}: ${err.message}`);
    return fallback;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasUsableRevenueData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const dailyRevenueCount = value.dailyRevenue && typeof value.dailyRevenue === 'object' && !Array.isArray(value.dailyRevenue)
    ? Object.keys(value.dailyRevenue).length
    : 0;

  return dailyRevenueCount > 0
    || Number(value.totalOrders || 0) > 0
    || Number(value.totalRevenue || 0) > 0
    || Number(value.totalRefunded || 0) > 0;
}

function hasUsableCogsData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const dailyCogsCount = value.dailyCOGS && typeof value.dailyCOGS === 'object' && !Array.isArray(value.dailyCOGS)
    ? Object.keys(value.dailyCOGS).length
    : 0;

  return dailyCogsCount > 0
    || Number(value.totalCOGS || 0) > 0
    || Number(value.totalShipping || 0) > 0
    || Number(value.itemCount || 0) > 0;
}

function loadLastSuccessfulImwebBackup() {
  const revenueRaw = loadData(LAST_SUCCESSFUL_REVENUE_FILE, null);
  const ordersRaw = loadData(LAST_SUCCESSFUL_IMWEB_ORDERS_FILE, []);

  return {
    revenueData: revenueRaw?.revenueData && typeof revenueRaw.revenueData === 'object' && !Array.isArray(revenueRaw.revenueData)
      ? revenueRaw.revenueData
      : null,
    orders: asArray(ordersRaw),
    timestamp: typeof revenueRaw?.timestamp === 'string' ? revenueRaw.timestamp : null,
  };
}

function normalizeSourceEntry(raw) {
  return {
    ...createSourceState(),
    ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}),
    stale: Boolean(raw?.stale),
    hasData: Boolean(raw?.hasData),
    lastAttemptAt: typeof raw?.lastAttemptAt === 'string' ? raw.lastAttemptAt : null,
    lastSuccessAt: typeof raw?.lastSuccessAt === 'string' ? raw.lastSuccessAt : null,
    lastError: typeof raw?.lastError === 'string' && raw.lastError.trim() ? raw.lastError.trim() : null,
  };
}

function normalizeSources(raw, latestData) {
  const sources = createSourcesState();
  const sourceMap = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  for (const key of SOURCE_KEYS) {
    sources[key] = normalizeSourceEntry(sourceMap[key]);
  }

  const derivedFlags = {
    metaStructure: asArray(latestData.campaigns).length > 0 || asArray(latestData.adSets).length > 0 || asArray(latestData.ads).length > 0,
    metaInsights: asArray(latestData.campaignInsights).length > 0 || asArray(latestData.adInsights).length > 0,
    imweb: hasUsableRevenueData(latestData.revenueData) || asArray(latestData.orders).length > 0,
    cogs: hasUsableCogsData(latestData.cogsData),
  };

  for (const key of SOURCE_KEYS) {
    if (derivedFlags[key]) {
      sources[key].hasData = true;
      if (sources[key].status === 'unknown') {
        sources[key].status = 'loaded';
      }
    }
  }

  return sources;
}

function normalizeLatestData(raw) {
  const base = createLatestDataState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return base;
  }

  const normalized = {
    ...base,
    campaigns: asArray(raw.campaigns),
    adSets: asArray(raw.adSets),
    ads: asArray(raw.ads),
    campaignInsights: asArray(raw.campaignInsights),
    adInsights: asArray(raw.adInsights),
    revenueData: raw.revenueData && typeof raw.revenueData === 'object' ? raw.revenueData : null,
    orders: asArray(raw.orders),
    cogsData: raw.cogsData && typeof raw.cogsData === 'object' ? raw.cogsData : null,
    economicsLedger: raw.economicsLedger && typeof raw.economicsLedger === 'object' ? raw.economicsLedger : null,
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : null,
  };

  normalized.sources = normalizeSources(raw.sources, normalized);
  return normalized;
}

function normalizeLastScanResult(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return raw;
}

function loadSnapshotPart(scanId, suffix) {
  if (!scanId || !fs.existsSync(SNAPSHOT_DIR)) {
    return null;
  }

  const filepath = path.join(SNAPSHOT_DIR, `${scanId}_${suffix}.json`);
  if (!fs.existsSync(filepath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (err) {
    console.warn(`[STORE] Failed to load snapshot ${scanId}_${suffix}.json: ${err.message}`);
    return null;
  }
}

function hydrateLatestDataFromSnapshot(scanId, latestData) {
  if (!scanId) {
    return latestData;
  }

  const snapshotPatch = {};
  const structure = loadSnapshotPart(scanId, 'meta_structure');
  const insights = loadSnapshotPart(scanId, 'meta_insights');
  const orders = loadSnapshotPart(scanId, 'imweb_orders');
  const normalized = loadSnapshotPart(scanId, 'normalized');

  if (latestData.campaigns.length === 0 && structure?.campaigns) snapshotPatch.campaigns = structure.campaigns;
  if (latestData.adSets.length === 0 && structure?.adSets) snapshotPatch.adSets = structure.adSets;
  if (latestData.ads.length === 0 && structure?.ads) snapshotPatch.ads = structure.ads;
  if (latestData.campaignInsights.length === 0 && insights?.campaignInsights) snapshotPatch.campaignInsights = insights.campaignInsights;
  if (latestData.adInsights.length === 0 && insights?.adInsights) snapshotPatch.adInsights = insights.adInsights;
  if (latestData.orders.length === 0 && Array.isArray(orders) && orders.length > 0) snapshotPatch.orders = orders;
  if (!hasUsableRevenueData(latestData.revenueData) && hasUsableRevenueData(normalized?.revenueData)) snapshotPatch.revenueData = normalized.revenueData;
  if (!hasUsableCogsData(latestData.cogsData) && hasUsableCogsData(normalized?.cogsData)) snapshotPatch.cogsData = normalized.cogsData;
  if (!latestData.timestamp && normalized?.timestamp) snapshotPatch.timestamp = normalized.timestamp;

  if (Object.keys(snapshotPatch).length === 0) {
    return latestData;
  }

  return normalizeLatestData({
    ...latestData,
    ...snapshotPatch,
  });
}

function hydrateLatestDataFromImwebBackup(latestData) {
  const needsOrders = latestData.orders.length === 0;
  const needsRevenue = !hasUsableRevenueData(latestData.revenueData);
  if (!needsOrders && !needsRevenue) {
    return latestData;
  }

  const backup = loadLastSuccessfulImwebBackup();
  const snapshotPatch = {};

  if (needsOrders && backup.orders.length > 0) {
    snapshotPatch.orders = backup.orders;
  }

  if (needsRevenue && hasUsableRevenueData(backup.revenueData)) {
    snapshotPatch.revenueData = backup.revenueData;
  }

  if (!latestData.timestamp && backup.timestamp) {
    snapshotPatch.timestamp = backup.timestamp;
  }

  if (Object.keys(snapshotPatch).length === 0) {
    return latestData;
  }

  return normalizeLatestData({
    ...latestData,
    ...snapshotPatch,
  });
}

function saveLastSuccessfulImwebData({ orders, revenueData }) {
  const normalizedOrders = asArray(orders);
  if (normalizedOrders.length > 0) {
    saveData(LAST_SUCCESSFUL_IMWEB_ORDERS_FILE, normalizedOrders);
  }

  if (hasUsableRevenueData(revenueData)) {
    saveData(LAST_SUCCESSFUL_REVENUE_FILE, {
      revenueData,
      timestamp: new Date().toISOString(),
    });
  }
}

function createScanHistoryEntry(scanResult) {
  if (!scanResult || typeof scanResult !== 'object') return null;

  return {
    scanId: scanResult.scanId ?? null,
    time: scanResult.endTime || scanResult.startTime || null,
    optimizations: Array.isArray(scanResult.optimizations) ? scanResult.optimizations.length : 0,
    errors: Array.isArray(scanResult.errors) ? scanResult.errors.length : 0,
  };
}

function normalizeScanHistory(entries, fallbackLastScan) {
  const normalized = asArray(entries)
    .filter(entry => entry && typeof entry === 'object')
    .map(entry => ({
      scanId: entry.scanId ?? null,
      time: entry.time ?? null,
      optimizations: Number.isFinite(entry.optimizations) ? entry.optimizations : 0,
      errors: Number.isFinite(entry.errors) ? entry.errors : 0,
    }))
    .slice(-MAX_SCAN_HISTORY);

  if (normalized.length > 0) {
    return normalized;
  }

  const fallbackEntry = createScanHistoryEntry(fallbackLastScan);
  return fallbackEntry ? [fallbackEntry] : [];
}

function applyLastScanSourceHealth(latestData, lastScanResult) {
  if (!lastScanResult || !latestData?.sources) {
    return latestData;
  }

  const attemptedAt = lastScanResult.endTime || lastScanResult.startTime || null;
  const errorsByStep = new Map(
    asArray(lastScanResult.errors).map(entry => [entry?.step, entry?.error || null])
  );
  const mappings = [
    { step: 'meta_structure', source: 'metaStructure' },
    { step: 'meta_insights', source: 'metaInsights' },
    { step: 'imweb_orders', source: 'imweb' },
    { step: 'cogs_sheets', source: 'cogs' },
  ];

  for (const { step, source } of mappings) {
    const stepResult = asArray(lastScanResult.steps).find(entry => entry?.step === step);
    if (!stepResult) continue;

    const sourceState = latestData.sources[source] || createSourceState();
    if (stepResult.status === 'ok') {
      latestData.sources[source] = {
        ...sourceState,
        status: 'connected',
        stale: false,
        lastAttemptAt: sourceState.lastAttemptAt || attemptedAt,
        lastSuccessAt: sourceState.lastSuccessAt || attemptedAt,
        lastError: null,
      };
      continue;
    }

    if (stepResult.status === 'failed') {
      latestData.sources[source] = {
        ...sourceState,
        status: 'error',
        stale: Boolean(sourceState.hasData),
        lastAttemptAt: sourceState.lastAttemptAt || attemptedAt,
        lastError: sourceState.lastError || errorsByStep.get(step) || null,
      };
    }
  }

  return latestData;
}

function parseLastScanTime(lastScanResult, latestData) {
  const candidate = lastScanResult?.endTime || lastScanResult?.startTime || latestData?.timestamp;
  if (!candidate) return null;

  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function createState() {
  const lastScanResult = normalizeLastScanResult(loadData(LATEST_SCAN_FILE, null));
  const latestData = applyLastScanSourceHealth(
    hydrateLatestDataFromImwebBackup(
      hydrateLatestDataFromSnapshot(
        lastScanResult?.scanId,
        normalizeLatestData(loadData(LATEST_DATA_FILE, null))
      )
    ),
    lastScanResult
  );
  return {
    lastScanTime: parseLastScanTime(lastScanResult, latestData),
    lastScanResult,
    scanHistory: normalizeScanHistory(loadData(SCAN_HISTORY_FILE, []), lastScanResult),
    allOptimizations: asArray(loadData(ALL_OPTIMIZATIONS_FILE, [])).slice(-MAX_OPTIMIZATIONS),
    latestData,
    isScanning: false,
  };
}

const state = createState();

function getLatestData() {
  return state.latestData;
}

function patchLatestData(patch) {
  Object.assign(state.latestData, patch);
  return state.latestData;
}

function getSourceHealth() {
  return SOURCE_KEYS.reduce((result, key) => {
    result[key] = {
      ...state.latestData.sources[key],
    };
    return result;
  }, {});
}

function updateSourceHealth(sourceKey, patch) {
  if (!SOURCE_KEYS.includes(sourceKey)) {
    return getSourceHealth();
  }

  if (!state.latestData.sources || typeof state.latestData.sources !== 'object') {
    state.latestData.sources = createSourcesState();
  }

  state.latestData.sources[sourceKey] = {
    ...createSourceState(),
    ...state.latestData.sources[sourceKey],
    ...(patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}),
  };

  return getSourceHealth();
}

function getLastScanResult() {
  return state.lastScanResult;
}

function setLastScanResult(scanResult) {
  state.lastScanResult = scanResult;
  return state.lastScanResult;
}

function getLastScanTime() {
  return state.lastScanTime;
}

function setLastScanTime(scanTime) {
  state.lastScanTime = scanTime;
  return state.lastScanTime;
}

function getScanHistory() {
  return state.scanHistory.slice();
}

function addScanHistory(entry) {
  state.scanHistory.push(entry);
  if (state.scanHistory.length > MAX_SCAN_HISTORY) {
    state.scanHistory = state.scanHistory.slice(-MAX_SCAN_HISTORY);
  }
  saveData(SCAN_HISTORY_FILE, state.scanHistory);
  return state.scanHistory;
}

function getAllOptimizations() {
  return state.allOptimizations.slice();
}

function appendOptimizations(optimizations) {
  if (!Array.isArray(optimizations) || optimizations.length === 0) {
    return state.allOptimizations;
  }

  state.allOptimizations.push(...optimizations);
  if (state.allOptimizations.length > MAX_OPTIMIZATIONS) {
    state.allOptimizations = state.allOptimizations.slice(-MAX_OPTIMIZATIONS);
  }
  saveData(ALL_OPTIMIZATIONS_FILE, state.allOptimizations);
  return state.allOptimizations;
}

function updateOptimization(id, patch) {
  if (!id) return null;
  const optimization = state.allOptimizations.find(entry => entry.id === id);
  if (!optimization) return null;

  const nextPatch = typeof patch === 'function' ? patch({ ...optimization }) : patch;
  if (!nextPatch || typeof nextPatch !== 'object') {
    return optimization;
  }

  Object.assign(optimization, nextPatch);
  saveData(ALL_OPTIMIZATIONS_FILE, state.allOptimizations);
  return optimization;
}

function getIsScanning() {
  return state.isScanning;
}

function setIsScanning(isScanning) {
  state.isScanning = isScanning;
  return state.isScanning;
}

function saveLatestArtifacts(scanResult) {
  saveData(LATEST_SCAN_FILE, scanResult);
  saveLatestData();
}

function saveLatestData() {
  saveData(LATEST_DATA_FILE, {
    ...state.latestData,
    timestamp: new Date().toISOString(),
  });
}

module.exports = {
  getLatestData,
  patchLatestData,
  getSourceHealth,
  updateSourceHealth,
  getLastScanResult,
  setLastScanResult,
  getLastScanTime,
  setLastScanTime,
  getScanHistory,
  addScanHistory,
  getAllOptimizations,
  appendOptimizations,
  updateOptimization,
  getIsScanning,
  setIsScanning,
  saveLatestData,
  saveLatestArtifacts,
  saveLastSuccessfulImwebData,
  loadLastSuccessfulImwebBackup,
};
