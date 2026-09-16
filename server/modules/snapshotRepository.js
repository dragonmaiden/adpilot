const fs = require('fs');
const path = require('path');
const runtimePaths = require('../runtime/paths');
const { getMaxSnapshotScanSets, pruneSnapshots } = require('../runtime/snapshotRetention');

const SNAP_DIR = path.join(runtimePaths.dataDir, 'snapshots');

function ensureSnapshotDir() {
  if (!fs.existsSync(SNAP_DIR)) {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
  }
}

function saveSnapshotFile(filename, data) {
  const filepath = path.join(SNAP_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(data), { mode: 0o600 });
  fs.chmodSync(filepath, 0o600);
}

function cleanupSnapshots(maxScanSets = getMaxSnapshotScanSets()) {
  return pruneSnapshots(runtimePaths.dataDir, { maxScanSets });
}

function snapshotParts(scanId, snapshotData) {
  const parts = [];
  const addPart = (filename, data) => parts.push({ filename, data });
  if (Array.isArray(snapshotData.campaigns) || Array.isArray(snapshotData.adSets) || Array.isArray(snapshotData.ads)) {
    addPart(`${scanId}_meta_structure.json`, {
      campaigns: snapshotData.campaigns ?? [],
      adSets: snapshotData.adSets ?? [],
      ads: snapshotData.ads ?? [],
    });
  }

  if (Array.isArray(snapshotData.campaignInsights) || Array.isArray(snapshotData.adInsights)) {
    addPart(`${scanId}_meta_insights.json`, {
      campaignInsights: snapshotData.campaignInsights ?? [],
      adInsights: snapshotData.adInsights ?? [],
    });
  }

  if (Array.isArray(snapshotData.orders)) {
    addPart(`${scanId}_imweb_orders.json`, snapshotData.orders);
  }

  if (
    snapshotData.revenueData !== undefined ||
    snapshotData.cogsData !== undefined ||
    snapshotData.economicsLedger !== undefined ||
    snapshotData.orderNotificationAudit !== undefined ||
    snapshotData.fx !== undefined ||
    snapshotData.sourceAudit !== undefined ||
    snapshotData.sources !== undefined
  ) {
    addPart(`${scanId}_normalized.json`, {
      revenueData: snapshotData.revenueData,
      cogsData: snapshotData.cogsData ?? null,
      economicsLedger: snapshotData.economicsLedger ?? null,
      orderNotificationAudit: snapshotData.orderNotificationAudit ?? null,
      fx: snapshotData.fx ?? null,
      sourceAudit: snapshotData.sourceAudit ?? null,
      sources: snapshotData.sources ?? {},
      timestamp: new Date().toISOString(),
    });
  }
  return parts;
}

function saveSnapshot(scanId, snapshotData) {
  if (!/^\d+$/.test(String(scanId))) throw new Error('Invalid snapshot scan ID');
  ensureSnapshotDir();
  const parts = snapshotParts(scanId, snapshotData);
  if (parts.some(part => fs.existsSync(path.join(SNAP_DIR, part.filename)))) {
    throw new Error('Snapshot already exists; refusing to overwrite recovery data');
  }
  // Measure one serialized part at a time to avoid retaining another whole scan in memory.
  const reservedBytes = parts.reduce((total, part) => total + Buffer.byteLength(JSON.stringify(part.data)), 0);
  const maxScanSets = getMaxSnapshotScanSets();
  const prepare = limit => {
    const storage = pruneSnapshots(runtimePaths.dataDir, { maxScanSets: limit, reservedBytes });
    if (!storage.canWrite) {
      const error = new Error('Snapshot skipped to preserve disk headroom and the latest recovery copy');
      error.code = 'ENOSPC';
      throw error;
    }
  };
  prepare(Math.max(1, maxScanSets - 1));

  try {
    for (const part of parts) saveSnapshotFile(part.filename, part.data);
  } catch (err) {
    // Remove only this failed new set, never an existing recovery set or workflow file.
    for (const part of parts) {
      const filepath = path.join(SNAP_DIR, part.filename);
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    }
    if (err?.code !== 'ENOSPC') {
      throw err;
    }

    const retryMaxSets = Math.max(1, Math.floor(maxScanSets / 2));
    console.warn(`[SCHEDULER] Snapshot disk full — pruning to ${retryMaxSets} scan sets and retrying save`);
    prepare(retryMaxSets);
    try {
      for (const part of parts) saveSnapshotFile(part.filename, part.data);
    } catch (retryError) {
      for (const part of parts) {
        const filepath = path.join(SNAP_DIR, part.filename);
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
      }
      throw retryError;
    }
  }

  cleanupSnapshots(maxScanSets);
}

function getSnapshotsList() {
  if (!fs.existsSync(SNAP_DIR)) return [];

  const files = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.json'));
  const scanIds = [...new Set(files.map(f => f.split('_')[0]))].sort().reverse();
  return scanIds.map(id => {
    const scanFiles = files.filter(f => f.startsWith(id + '_'));
    return {
      scanId: id,
      timestamp: new Date(parseInt(id, 10)).toISOString(),
      files: scanFiles,
    };
  });
}

function getSnapshot(scanId) {
  if (!fs.existsSync(SNAP_DIR)) return null;

  const files = fs.readdirSync(SNAP_DIR).filter(f => f.startsWith(scanId + '_'));
  if (files.length === 0) return null;

  const result = {
    scanId,
    timestamp: new Date(parseInt(scanId, 10)).toISOString(),
    data: {},
  };

  for (const file of files) {
    const key = file.replace(scanId + '_', '').replace('.json', '');
    try {
      result.data[key] = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, file), 'utf8'));
    } catch (err) {
      result.data[key] = { error: 'Failed to read: ' + err.message };
    }
  }

  return result;
}

module.exports = {
  saveSnapshot,
  getSnapshotsList,
  getSnapshot,
  cleanupSnapshots,
  getMaxSnapshotScanSets,
};
