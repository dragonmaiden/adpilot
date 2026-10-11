const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeJsonFileSync, measureJsonBytes } = require('../server/runtime/jsonFile');

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adpilot-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'data.json');
}

test('bounded JSON preserves financial data and native JSON encoding semantics', t => {
  const filepath = tempFile(t);
  const shared = { approved: 100, refunded: 40, name: '슈에 😀', missing: undefined };
  const data = {
    orders: [shared, shared],
    cogs: { total: 12.34, negative: -0 },
    special: [undefined, undefined, NaN, Infinity, () => {}, Symbol('omit')],
    omit: undefined,
    date: new Date('2026-10-11T07:55:10Z'),
    custom: { toJSON: key => ({ key, value: 42 }) },
    boxed: [new Number(2), new String('escaped\n"'), new Boolean(false)],
    // Place a surrogate pair across the 64 KiB chunk boundary.
    unicode: 'a'.repeat(65530) + '😀'.repeat(40000),
  };
  delete data.special[1];
  const expected = JSON.stringify(data);
  writeJsonFileSync(filepath, data);
  assert.equal(fs.readFileSync(filepath, 'utf8'), expected);
  assert.equal(measureJsonBytes(data), Buffer.byteLength(expected));
  assert.equal(fs.statSync(filepath).mode & 0o777, 0o600);
});

test('failed serialization preserves the previous file and removes temporary files', t => {
  const filepath = tempFile(t);
  writeJsonFileSync(filepath, { keep: 'recovery' });
  const circular = { orders: Array.from({ length: 5000 }, () => ({ total: 123 })) };
  circular.circular = circular;
  for (const invalid of [circular, { total: 1n }, { total: Object(1n) }, undefined]) {
    assert.throws(() => writeJsonFileSync(filepath, invalid), TypeError);
    assert.deepEqual(JSON.parse(fs.readFileSync(filepath, 'utf8')), { keep: 'recovery' });
    assert.deepEqual(fs.readdirSync(path.dirname(filepath)), ['data.json']);
  }
});

test('short writes are completed and ENOSPC keeps the last successful recovery copy', t => {
  const filepath = tempFile(t);
  const original = fs.writeSync;
  t.mock.method(fs, 'writeSync', (fd, buffer, offset, length) => original(fd, buffer, offset, Math.min(length, 7)));
  writeJsonFileSync(filepath, { total: 12345, name: '슈에' });
  assert.deepEqual(JSON.parse(fs.readFileSync(filepath, 'utf8')), { total: 12345, name: '슈에' });
  let writes = 0;
  t.mock.method(fs, 'writeSync', (...args) => {
    if (++writes > 1) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return original(...args);
  });
  assert.throws(() => writeJsonFileSync(filepath, { data: 'x'.repeat(200000) }), /disk full/);
  assert.deepEqual(JSON.parse(fs.readFileSync(filepath, 'utf8')), { total: 12345, name: '슈에' });
  assert.deepEqual(fs.readdirSync(path.dirname(filepath)), ['data.json']);
});

test('scan store persists and reloads every projection and Imweb backup without whole-document stringify', t => {
  const filepath = tempFile(t);
  const storePath = require.resolve('../server/modules/scanStore');
  const pathsPath = require.resolve('../server/runtime/paths');
  const previousStore = require.cache[storePath];
  const previousPaths = require.cache[pathsPath];
  require.cache[pathsPath] = { exports: { dataDir: path.dirname(filepath) } };
  delete require.cache[storePath];
  t.after(() => {
    delete require.cache[storePath];
    if (previousStore) require.cache[storePath] = previousStore;
    if (previousPaths) require.cache[pathsPath] = previousPaths;
    else delete require.cache[pathsPath];
  });
  const store = require(storePath);
  const projection = {
    orders: [{ orderNo: 'old-refund', totalPaymentPrice: 60, totalRefundedPrice: 40 }],
    revenueData: { totalRevenue: 100, dailyRevenue: { '2026-10-11': { revenue: 100 } } },
    cogsData: { totalCOGS: 20, items: [{ orderNo: 'old-refund', cost: 20 }] },
    economicsLedger: { rows: [{ approved: 100, refunded: 40 }] },
    fx: { usdToKrwRate: 1400 },
    sourceAudit: { status: 'mismatch' },
  };
  store.patchLatestData(projection);
  const stringify = JSON.stringify;
  t.mock.method(JSON, 'stringify', value => {
    assert.ok(value === null || typeof value !== 'object', 'persistence must not stringify an entire collection');
    return stringify(value);
  });
  store.saveLatestData();
  store.saveLastSuccessfulImwebData(projection);
  delete require.cache[storePath];
  const restarted = require(storePath);
  for (const [key, value] of Object.entries(projection)) assert.deepEqual(restarted.getLatestData()[key], value);
  assert.deepEqual(restarted.loadLastSuccessfulImwebBackup().orders, projection.orders);
});

test('large nested scan persists repeatedly in a small V8 heap', t => {
  const filepath = tempFile(t);
  const result = spawnSync(process.execPath, ['--max-old-space-size=48', '-e', `
    const fs = require('node:fs');
    const { writeJsonFileSync, measureJsonBytes } = require(${JSON.stringify(require.resolve('../server/runtime/jsonFile'))});
    const rows = Array.from({ length: 30000 }, (_, id) => ({ id, price: 123, payload: 'x'.repeat(1024) }));
    const data = { orders: rows, cogsData: { items: rows }, economicsLedger: { rows } };
    const expectedBytes = measureJsonBytes(data);
    for (let pass = 0; pass < 3; pass++) writeJsonFileSync(${JSON.stringify(filepath)}, data);
    if (fs.statSync(${JSON.stringify(filepath)}).size !== expectedBytes) process.exit(1);
  `], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
});
