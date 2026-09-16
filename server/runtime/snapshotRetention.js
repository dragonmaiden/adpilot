const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_SCAN_SETS = 72;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const MIN_FREE_BYTES = 128 * 1024 * 1024;
const SNAPSHOT_FILE = /^(\d+)_(meta_structure|meta_insights|imweb_orders|normalized)\.json$/;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function getMaxSnapshotScanSets() {
  return positiveInteger(process.env.SNAPSHOT_MAX_SCAN_SETS, DEFAULT_MAX_SCAN_SETS);
}

function getMaxSnapshotBytes() {
  return positiveInteger(process.env.SNAPSHOT_MAX_BYTES, DEFAULT_MAX_BYTES);
}

function listSnapshotSets(dataDir) {
  const directory = path.join(dataDir, 'snapshots');
  if (!fs.existsSync(directory)) return [];
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('Snapshot directory must not be a symlink');
  const sets = new Map();
  for (const name of fs.readdirSync(directory)) {
    const match = SNAPSHOT_FILE.exec(name);
    if (!match) continue;
    const filepath = path.join(directory, name);
    const stat = fs.lstatSync(filepath);
    if (!stat.isFile()) continue;
    const set = sets.get(match[1]) || { scanId: match[1], bytes: 0, files: [] };
    set.bytes += stat.size;
    set.files.push(filepath);
    sets.set(set.scanId, set);
  }
  return [...sets.values()].sort((a, b) => Number(a.scanId) - Number(b.scanId));
}

function availableBytes(dataDir) {
  const stat = fs.statfsSync(dataDir);
  return stat.bavail * stat.bsize;
}

// Only generated snapshot parts are disposable. Never touch root data or workflow files.
// Keep the newest existing set as a recovery copy even if that means refusing a new snapshot.
function pruneSnapshots(dataDir, { maxScanSets = getMaxSnapshotScanSets(), reservedBytes = 0 } = {}) {
  const sets = listSnapshotSets(dataDir);
  let bytes = sets.reduce((total, set) => total + set.bytes, 0);
  let freeBytes = availableBytes(dataDir);
  const maxBytes = getMaxSnapshotBytes();
  let deletedSets = 0;
  let freedBytes = 0;
  for (const set of sets.slice(0, -1)) {
    if (sets.length - deletedSets <= maxScanSets
      && bytes + reservedBytes <= maxBytes
      && freeBytes - reservedBytes >= MIN_FREE_BYTES) break;
    for (const file of set.files) fs.unlinkSync(file);
    deletedSets += 1;
    freedBytes += set.bytes;
    bytes -= set.bytes;
    freeBytes = availableBytes(dataDir);
  }
  if (deletedSets) {
    console.log(`[STORAGE] Removed ${deletedSets} old snapshot sets; freed ${freedBytes} bytes; retained ${bytes} snapshot bytes`);
  }
  return {
    deletedSets, freedBytes, bytes, freeBytes,
    canWrite: bytes + reservedBytes <= maxBytes && freeBytes - reservedBytes >= MIN_FREE_BYTES,
  };
}

module.exports = { getMaxSnapshotScanSets, getMaxSnapshotBytes, listSnapshotSets, pruneSnapshots };
