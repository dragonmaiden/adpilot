const fs = require('fs');
const path = require('path');
const runtimePaths = require('../runtime/paths');

const SNAP_DIR = path.join(runtimePaths.dataDir, 'snapshots');

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

function cleanupSnapshots(maxScanSets = 240) {
  try {
    const files = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.json'));
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

function saveSnapshot(scanId, snapshotData) {
  ensureSnapshotDir();

  if (Array.isArray(snapshotData.campaigns) || Array.isArray(snapshotData.adSets) || Array.isArray(snapshotData.ads)) {
    saveSnapshotFile(`${scanId}_meta_structure.json`, {
      campaigns: snapshotData.campaigns ?? [],
      adSets: snapshotData.adSets ?? [],
      ads: snapshotData.ads ?? [],
    });
  }

  if (Array.isArray(snapshotData.campaignInsights) || Array.isArray(snapshotData.adSetInsights) || Array.isArray(snapshotData.adInsights)) {
    saveSnapshotFile(`${scanId}_meta_insights.json`, {
      campaignInsights: snapshotData.campaignInsights ?? [],
      adSetInsights: snapshotData.adSetInsights ?? [],
      adInsights: snapshotData.adInsights ?? [],
    });
  }

  if (snapshotData.orders && snapshotData.orders.length > 0) {
    saveSnapshotFile(`${scanId}_imweb_orders.json`, snapshotData.orders);
  }

  if (snapshotData.revenueData !== undefined || snapshotData.cogsData !== undefined) {
    saveSnapshotFile(`${scanId}_normalized.json`, {
      revenueData: snapshotData.revenueData,
      cogsData: snapshotData.cogsData ?? null,
      timestamp: new Date().toISOString(),
    });
  }

  cleanupSnapshots(240);
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
};
