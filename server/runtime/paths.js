const fs = require('fs');
const path = require('path');
const config = require('../config');
const { pruneSnapshots } = require('./snapshotRetention');

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
  return pruneSnapshots(dataDir, { maxScanSets }).deletedSets;
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

// A tiny write probe can succeed on a nearly full disk while payment-state writes fail.
// Enforce retention before any service loads or writes its state, not only after ENOSPC.
try {
  const storage = pruneSnapshots(dataDir);
  console.log(`[STORAGE] Snapshot bytes=${storage.bytes}; free bytes=${storage.freeBytes}`);
  if (!storage.canWrite) console.warn('[STORAGE] Low disk headroom; newest recovery snapshot preserved');
} catch (err) {
  console.warn('[STORAGE] Startup snapshot retention failed:', err.message);
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
