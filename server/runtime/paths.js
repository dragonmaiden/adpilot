const fs = require('fs');
const path = require('path');
const config = require('../config');

const SNAPSHOT_DIR_NAME = 'snapshots';
const STARTUP_RECOVERY_SCAN_SETS = 24;

function ensureWritableDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const testFile = path.join(
    dir,
    `.write-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );

  fs.writeFileSync(testFile, 'ok', { flag: 'wx' });

  try {
    fs.unlinkSync(testFile);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

function cleanupSnapshotSets(dataDir, maxScanSets = STARTUP_RECOVERY_SCAN_SETS) {
  const snapshotDir = path.join(dataDir, SNAPSHOT_DIR_NAME);
  if (!fs.existsSync(snapshotDir)) {
    return 0;
  }

  const files = fs.readdirSync(snapshotDir).filter(file => file.endsWith('.json'));
  const scanIds = [...new Set(files.map(file => file.split('_')[0]))].sort();
  if (scanIds.length <= maxScanSets) {
    return 0;
  }

  const toDelete = scanIds.slice(0, scanIds.length - maxScanSets);
  for (const scanId of toDelete) {
    const scanFiles = files.filter(file => file.startsWith(`${scanId}_`));
    for (const file of scanFiles) {
      fs.unlinkSync(path.join(snapshotDir, file));
    }
  }

  return toDelete.length;
}

function tryRecoverWritableDataDir(dir, err) {
  if (err?.code !== 'ENOSPC') {
    return {
      attempted: false,
      recovered: false,
      deletedSnapshotSets: 0,
      error: err,
    };
  }

  try {
    const deletedSnapshotSets = cleanupSnapshotSets(dir);
    if (deletedSnapshotSets === 0) {
      return {
        attempted: true,
        recovered: false,
        deletedSnapshotSets,
        error: err,
      };
    }

    ensureWritableDirectory(dir);
    return {
      attempted: true,
      recovered: true,
      deletedSnapshotSets,
      error: null,
    };
  } catch (recoveryError) {
    return {
      attempted: true,
      recovered: false,
      deletedSnapshotSets: 0,
      error: recoveryError,
    };
  }
}

const configuredDataDir = config.paths.defaultDataDir;
const fallbackDataDir = path.join(__dirname, '..', 'data');

let dataDir = configuredDataDir;
let usedFallback = false;
let fallbackReason = null;
let startupRecovery = {
  attempted: false,
  recovered: false,
  deletedSnapshotSets: 0,
};

try {
  ensureWritableDirectory(configuredDataDir);
} catch (err) {
  startupRecovery = tryRecoverWritableDataDir(configuredDataDir, err);
  if (!startupRecovery.recovered) {
    usedFallback = configuredDataDir !== fallbackDataDir;
    fallbackReason = startupRecovery.error || err;
    dataDir = fallbackDataDir;
    ensureWritableDirectory(dataDir);
  }
}

const logDir = path.join(dataDir, 'logs');
ensureWritableDirectory(logDir);

module.exports = {
  configuredDataDir,
  fallbackDataDir,
  dataDir,
  logDir,
  imwebTokenFile: path.join(dataDir, 'imweb_tokens.json'),
  runtimeSettingsFile: path.join(dataDir, 'runtime_settings.json'),
  usedFallback,
  fallbackReason,
  startupRecovery,
};
