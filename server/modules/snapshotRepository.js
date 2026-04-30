const fs = require('fs');
const path = require('path');
const runtimePaths = require('../runtime/paths');

const SNAP_DIR = path.join(runtimePaths.dataDir, 'snapshots');
const DEFAULT_MAX_SCAN_SETS = 72;

function getMaxSnapshotScanSets() {
  const configured = Number.parseInt(process.env.SNAPSHOT_MAX_SCAN_SETS || '', 10);
  if (!Number.isFinite(configured) || configured < 1) {
    return DEFAULT_MAX_SCAN_SETS;
  }
  return configured;
}

function ensureSnapshotDir() {
  if (!fs.existsSync(SNAP_DIR)) {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
  }
}

function saveSnapshotFile(filename, data) {
  const filepath = path.join(SNAP_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(filepath, 0o600);
}

function listSnapshotFiles() {
  if (!fs.existsSync(SNAP_DIR)) return [];
  return fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.json'));
}

function cleanupSnapshots(maxScanSets = 240) {
  try {
    const files = listSnapshotFiles();
    const scanIds = [...new Set(files.map(f => f.split('_')[0]))].sort();
    if (scanIds.length <= maxScanSets) return;

    const toDelete = scanIds.slice(0, scanIds.length - maxScanSets);
    for (const scanId of toDelete) {
      const scanFiles = files.filter(f => f.startsWith(scanId + '_'));
      for (const file of scanFiles) {
        fs.unlinkSync(path.join(SNAP_DIR, file));
      }
    }
    console.log(`[SCHEDULER] Cleaned up ${toDelete.length} old snapshot sets`);
  } catch (err) {
    console.warn('[SCHEDULER] Snapshot cleanup error:', err.message);
  }
}

function writeSnapshotParts(scanId, snapshotData) {
  if (Array.isArray(snapshotData.campaigns) || Array.isArray(snapshotData.adSets) || Array.isArray(snapshotData.ads)) {
    saveSnapshotFile(`${scanId}_meta_structure.json`, {
      campaigns: snapshotData.campaigns ?? [],
      adSets: snapshotData.adSets ?? [],
      ads: snapshotData.ads ?? [],
    });
  }

  if (Array.isArray(snapshotData.campaignInsights) || Array.isArray(snapshotData.adInsights)) {
    saveSnapshotFile(`${scanId}_meta_insights.json`, {
      campaignInsights: snapshotData.campaignInsights ?? [],
      adInsights: snapshotData.adInsights ?? [],
    });
  }

  if (Array.isArray(snapshotData.orders)) {
    saveSnapshotFile(`${scanId}_imweb_orders.json`, snapshotData.orders);
  }

  if (
    snapshotData.revenueData !== undefined ||
    snapshotData.cogsData !== undefined ||
    snapshotData.economicsLedger !== undefined ||
    snapshotData.fx !== undefined ||
    snapshotData.sourceAudit !== undefined ||
    snapshotData.sources !== undefined
  ) {
    saveSnapshotFile(`${scanId}_normalized.json`, {
      revenueData: snapshotData.revenueData,
      cogsData: snapshotData.cogsData ?? null,
      economicsLedger: snapshotData.economicsLedger ?? null,
      fx: snapshotData.fx ?? null,
      sourceAudit: snapshotData.sourceAudit ?? null,
      sources: snapshotData.sources ?? {},
      timestamp: new Date().toISOString(),
    });
  }
}

function saveSnapshot(scanId, snapshotData) {
  ensureSnapshotDir();
  const maxScanSets = getMaxSnapshotScanSets();
  cleanupSnapshots(Math.max(1, maxScanSets - 1));

  try {
    writeSnapshotParts(scanId, snapshotData);
  } catch (err) {
    if (err?.code !== 'ENOSPC') {
      throw err;
    }

    const retryMaxSets = Math.max(1, Math.floor(maxScanSets / 2));
    console.warn(`[SCHEDULER] Snapshot disk full — pruning to ${retryMaxSets} scan sets and retrying save`);
    cleanupSnapshots(retryMaxSets);
    writeSnapshotParts(scanId, snapshotData);
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
