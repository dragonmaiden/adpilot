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

function createLatestDataState() {
  return {
    campaigns: [],
    adSets: [],
    ads: [],
    campaignInsights: [],
    adSetInsights: [],
    adInsights: [],
    revenueData: null,
    orders: [],
    cogsData: null,
  };
}

function saveData(filename, data) {
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
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

function normalizeLatestData(raw) {
  const base = createLatestDataState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return base;
  }

  return {
    ...base,
    campaigns: asArray(raw.campaigns),
    adSets: asArray(raw.adSets),
    ads: asArray(raw.ads),
    campaignInsights: asArray(raw.campaignInsights),
    adSetInsights: asArray(raw.adSetInsights),
    adInsights: asArray(raw.adInsights),
    revenueData: raw.revenueData && typeof raw.revenueData === 'object' ? raw.revenueData : null,
    orders: asArray(raw.orders),
    cogsData: raw.cogsData && typeof raw.cogsData === 'object' ? raw.cogsData : null,
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : null,
  };
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
  if (latestData.adSetInsights.length === 0 && insights?.adSetInsights) snapshotPatch.adSetInsights = insights.adSetInsights;
  if (latestData.adInsights.length === 0 && insights?.adInsights) snapshotPatch.adInsights = insights.adInsights;
  if (latestData.orders.length === 0 && Array.isArray(orders)) snapshotPatch.orders = orders;
  if (!latestData.revenueData && normalized?.revenueData) snapshotPatch.revenueData = normalized.revenueData;
  if (!latestData.cogsData && normalized?.cogsData) snapshotPatch.cogsData = normalized.cogsData;
  if (!latestData.timestamp && normalized?.timestamp) snapshotPatch.timestamp = normalized.timestamp;

  if (Object.keys(snapshotPatch).length === 0) {
    return latestData;
  }

  return normalizeLatestData({
    ...latestData,
    ...snapshotPatch,
  });
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

function parseLastScanTime(lastScanResult, latestData) {
  const candidate = lastScanResult?.endTime || lastScanResult?.startTime || latestData?.timestamp;
  if (!candidate) return null;

  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function createState() {
  const lastScanResult = normalizeLastScanResult(loadData(LATEST_SCAN_FILE, null));
  const latestData = hydrateLatestDataFromSnapshot(
    lastScanResult?.scanId,
    normalizeLatestData(loadData(LATEST_DATA_FILE, null))
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

function getIsScanning() {
  return state.isScanning;
}

function setIsScanning(isScanning) {
  state.isScanning = isScanning;
  return state.isScanning;
}

function saveLatestArtifacts(scanResult) {
  saveData(LATEST_SCAN_FILE, scanResult);
  saveData(LATEST_DATA_FILE, {
    ...state.latestData,
    timestamp: new Date().toISOString(),
  });
}

module.exports = {
  getLatestData,
  patchLatestData,
  getLastScanResult,
  setLastScanResult,
  getLastScanTime,
  setLastScanTime,
  getScanHistory,
  addScanHistory,
  getAllOptimizations,
  appendOptimizations,
  getIsScanning,
  setIsScanning,
  saveLatestArtifacts,
};
