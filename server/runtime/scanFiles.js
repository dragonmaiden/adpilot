const fs = require('node:fs');
const path = require('node:path');
const { cleanupAbandonedJsonWrites } = require('./jsonFile');
const { SNAPSHOT_FILE } = require('./snapshotRetention');

const SCAN_FILES = Object.freeze({
  latestData: 'latest_data.json',
  latestScan: 'latest_scan.json',
  history: 'scan_history.json',
  imwebOrders: 'last_successful_imweb_orders.json',
  revenue: 'last_successful_revenue.json',
});

// Explicit allowlist: payment, token, and notification workflow files are not
// scan checkpoints. Only abandoned partial writes are disposable, never finals.
function cleanupAbandonedScanWrites(dataDir) {
  let freedBytes = 0;
  for (const name of Object.values(SCAN_FILES)) {
    freedBytes += cleanupAbandonedJsonWrites(path.join(dataDir, name));
  }
  const directory = path.join(dataDir, 'snapshots');
  if (!fs.existsSync(directory) || !fs.lstatSync(directory).isDirectory()) return freedBytes;
  const targets = new Set();
  for (const name of fs.readdirSync(directory)) {
    const target = name.replace(/\.\d+\.[a-f0-9]+\.tmp$/, '');
    if (target !== name && SNAPSHOT_FILE.test(target)) targets.add(target);
  }
  for (const target of targets) freedBytes += cleanupAbandonedJsonWrites(path.join(directory, target));
  return freedBytes;
}

module.exports = { SCAN_FILES, cleanupAbandonedScanWrites };
