const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pruneSnapshots, getMaxSnapshotBytes, getMaxSnapshotScanSets } = require('../server/runtime/snapshotRetention');

function fixture(t, sizes) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adpilot-retention-'));
  const directory = path.join(dataDir, 'snapshots');
  fs.mkdirSync(directory);
  for (const [id, bytes] of Object.entries(sizes)) {
    fs.writeFileSync(path.join(directory, `${id}_normalized.json`), 'x'.repeat(bytes));
  }
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, directory };
}

function budget(t, bytes) {
  const previous = process.env.SNAPSHOT_MAX_BYTES;
  process.env.SNAPSHOT_MAX_BYTES = String(bytes);
  t.after(() => {
    if (previous === undefined) delete process.env.SNAPSHOT_MAX_BYTES;
    else process.env.SNAPSHOT_MAX_BYTES = previous;
  });
}

test('byte budget prunes oldest whole sets below the count limit and leaves unrelated data unchanged', t => {
  budget(t, 65);
  const { dataDir, directory } = fixture(t, { 1000: 30, 2000: 30, 3000: 30 });
  fs.writeFileSync(path.join(directory, '1000_imweb_orders.json'), 'extra');
  fs.writeFileSync(path.join(directory, '1000_evidence.json'), 'keep');
  fs.writeFileSync(path.join(dataDir, 'payway_payment_watch_state.json'), 'keep payments');
  fs.writeFileSync(path.join(dataDir, 'imweb_tokens.json'), 'keep tokens');
  const result = pruneSnapshots(dataDir);
  assert.equal(result.deletedSets, 1);
  assert.equal(result.freedBytes, 35);
  assert.equal(result.bytes, 60);
  assert.equal(result.canWrite, true);
  assert.equal(fs.existsSync(path.join(directory, '1000_imweb_orders.json')), false);
  assert.equal(fs.readFileSync(path.join(directory, '1000_evidence.json'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(dataDir, 'payway_payment_watch_state.json'), 'utf8'), 'keep payments');
  assert.equal(fs.readFileSync(path.join(dataDir, 'imweb_tokens.json'), 'utf8'), 'keep tokens');
});

test('incoming snapshot space is reserved before writing', t => {
  budget(t, 100);
  const { dataDir } = fixture(t, { 1000: 30, 2000: 30, 3000: 30 });
  const result = pruneSnapshots(dataDir, { reservedBytes: 60 });
  assert.equal(result.deletedSets, 2);
  assert.equal(result.bytes, 30);
  assert.equal(result.canWrite, true);
});

test('newest recovery set survives even when no new snapshot will fit', t => {
  budget(t, 25);
  const { dataDir, directory } = fixture(t, { 1000: 30, 2000: 30 });
  const result = pruneSnapshots(dataDir, { reservedBytes: 40 });
  assert.equal(result.canWrite, false);
  assert.equal(result.deletedSets, 1);
  assert.equal(fs.statSync(path.join(directory, '2000_normalized.json')).size, 30);
});

test('filesystem headroom triggers pruning even below the snapshot budget', t => {
  const { dataDir } = fixture(t, { 1000: 30, 2000: 30 });
  t.mock.method(fs, 'statfsSync', () => ({ bavail: 1, bsize: 4096 }));
  const result = pruneSnapshots(dataDir);
  assert.equal(result.deletedSets, 1);
  assert.equal(result.canWrite, false);
});

test('retention neither follows file symlinks nor a symlinked snapshot directory', t => {
  budget(t, 1);
  const { dataDir, directory } = fixture(t, { 1000: 30, 2000: 30 });
  const stateFile = path.join(dataDir, 'payment.json');
  fs.writeFileSync(stateFile, 'keep');
  fs.symlinkSync(stateFile, path.join(directory, '1000_imweb_orders.json'));
  pruneSnapshots(dataDir);
  assert.equal(fs.lstatSync(path.join(directory, '1000_imweb_orders.json')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), 'keep');
  fs.renameSync(directory, path.join(dataDir, 'original'));
  fs.symlinkSync(path.join(dataDir, 'original'), directory);
  assert.throws(() => pruneSnapshots(dataDir), /must not be a symlink/);
});

test('invalid retention limits use safe defaults', t => {
  budget(t, -1);
  const previous = process.env.SNAPSHOT_MAX_SCAN_SETS;
  process.env.SNAPSHOT_MAX_SCAN_SETS = 'garbage';
  t.after(() => {
    if (previous === undefined) delete process.env.SNAPSHOT_MAX_SCAN_SETS;
    else process.env.SNAPSHOT_MAX_SCAN_SETS = previous;
  });
  assert.equal(getMaxSnapshotBytes(), 256 * 1024 * 1024);
  assert.equal(getMaxSnapshotScanSets(), 72);
});
