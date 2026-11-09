const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const { writeJsonFile, writeJsonFileSync, measureJsonBytes, cleanupAbandonedJsonWrites } = require('../server/runtime/jsonFile');

test('startup removes only abandoned atomic-write files and preserves active writers and recovery data', t => {
  const filepath = tempFile(t);
  fs.writeFileSync(filepath, '{"keep":true}');
  const abandoned = `${filepath}.999999.a123.tmp`;
  const reusedPid = `${filepath}.${process.pid}.b123.tmp`;
  const active = `${filepath}.999998.c123.tmp`;
  const unrelated = `${filepath}.backup.tmp`;
  for (const file of [abandoned, reusedPid, active, unrelated]) fs.writeFileSync(file, 'partial');
  const symlink = `${filepath}.999999.d123.tmp`;
  fs.symlinkSync(filepath, symlink);
  t.mock.method(process, 'kill', pid => {
    if (pid === 999999) throw Object.assign(new Error('not running'), { code: 'ESRCH' });
  });
  assert.equal(cleanupAbandonedJsonWrites(filepath), 14);
  assert.deepEqual(JSON.parse(fs.readFileSync(filepath)), { keep: true });
  for (const file of [active, unrelated, symlink]) assert.ok(fs.existsSync(file));
  for (const file of [abandoned, reusedPid]) assert.equal(fs.existsSync(file), false);
  assert.equal(cleanupAbandonedJsonWrites(filepath), 0);
});

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adpilot-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'data.json');
}

test('large checkpoint writes keep HTTP health requests responsive', async t => {
  const filepath = tempFile(t);
  const server = http.createServer((req, res) => res.end('ok'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  let completed = false;
  const data = { rows: Array.from({ length: 20000 }, (_, id) => ({ id, cost: 123, payload: 'x'.repeat(1024) })) };
  const writing = writeJsonFile(filepath, data).then(() => { completed = true; });
  let responsesDuringWrite = 0;
  while (!completed) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, { signal: AbortSignal.timeout(1000) });
    assert.equal(await response.text(), 'ok');
    if (!completed) responsesDuringWrite++;
  }
  await writing;
  assert.ok(responsesDuringWrite > 1, 'health must respond during serialization, not just afterward');
  assert.deepEqual(JSON.parse(fs.readFileSync(filepath)), data);
});

test('SIGKILL during each checkpoint type recovers on real startup without touching valid or unrelated files', { timeout: 20000 }, async t => {
  const dataDir = path.dirname(tempFile(t));
  fs.mkdirSync(path.join(dataDir, 'snapshots'));
  const files = ['latest_data.json', 'latest_scan.json', 'scan_history.json',
    'last_successful_imweb_orders.json', 'last_successful_revenue.json',
    ...['meta_structure', 'meta_insights', 'imweb_orders', 'normalized'].map(part => `snapshots/123_${part}.json`)];
  const writer = require.resolve('../server/runtime/jsonFile');
  for (const name of files) {
    const filepath = path.join(dataDir, name);
    fs.writeFileSync(filepath, '{"keep":"valid"}');
    const child = spawn(process.execPath, ['-e', `
      const { writeJsonFile } = require(${JSON.stringify(writer)});
      writeJsonFile(${JSON.stringify(filepath)}, { padding: 'x'.repeat(200000), barrier: {
        toJSON() { process.stdout.write('READY'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
      }});
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGKILL'));
    const exit = once(child, 'exit');
    const ready = await Promise.race([once(child.stdout, 'data'), exit.then(() => { throw Error('Writer exited before barrier'); })]);
    assert.match(ready[0].toString(), /READY/);
    const partial = fs.readdirSync(path.dirname(filepath)).find(name => name.startsWith(`${path.basename(filepath)}.${child.pid}.`));
    assert.ok(partial && fs.statSync(path.join(path.dirname(filepath), partial)).size > 0);
    child.kill('SIGKILL');
    assert.equal((await exit)[1], 'SIGKILL');
    assert.deepEqual(JSON.parse(fs.readFileSync(filepath)), { keep: 'valid' });
  }
  fs.writeFileSync(path.join(dataDir, 'payment_state.json.999999.abc.tmp'), 'preserve');
  const restart = spawnSync(process.execPath, ['-e', `
    const configPath = require.resolve(${JSON.stringify(require.resolve('../server/config'))});
    require.cache[configPath] = { exports: { paths: { defaultDataDir: ${JSON.stringify(dataDir)} } } };
    const paths = require(${JSON.stringify(require.resolve('../server/runtime/paths'))});
    if (paths.usedFallback) process.exit(2);
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(restart.status, 0, restart.stderr);
  for (const name of files) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, name))), { keep: 'valid' });
  assert.deepEqual(fs.readdirSync(dataDir).filter(name => name.endsWith('.tmp')), ['payment_state.json.999999.abc.tmp']);
  assert.equal(fs.readdirSync(path.join(dataDir, 'snapshots')).filter(name => name.endsWith('.tmp')).length, 0);
  for (const name of files) {
    await writeJsonFile(path.join(dataDir, name), { recovered: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, name))), { recovered: true });
  }
});

test('async checkpoint handles short writes and preserves recovery on disk-full and encoding errors', async t => {
  const filepath = tempFile(t);
  const open = fs.promises.open.bind(fs.promises);
  let fail = false;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const file = await open(...args);
    const write = file.write.bind(file);
    let writes = 0;
    file.write = (buffer, offset, length) => {
      if (fail && ++writes > 1) return Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
      return write(buffer, offset, Math.min(length, 7));
    };
    return file;
  });
  const valid = { total: 12345, name: '슈에' };
  await writeJsonFile(filepath, valid);
  assert.deepEqual(JSON.parse(fs.readFileSync(filepath)), valid);
  fail = true;
  await assert.rejects(writeJsonFile(filepath, { total: 987654321 }), { code: 'ENOSPC' });
  fail = false;
  await assert.rejects(writeJsonFile(filepath, { total: 1n }), TypeError);
  assert.deepEqual(JSON.parse(fs.readFileSync(filepath)), valid);
  assert.deepEqual(fs.readdirSync(path.dirname(filepath)), ['data.json']);
});

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

test('scan store persists and reloads every projection and Imweb backup without whole-document stringify', async t => {
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
  await store.saveLatestData();
  await store.saveLastSuccessfulImwebData(projection);
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

test('startup reads only needed recovery parts and preserves newer source health', t => {
  const dataDir = path.dirname(tempFile(t));
  const snapshotDir = path.join(dataDir, 'snapshots');
  fs.mkdirSync(snapshotDir);
  const source = { status: 'connected', hasData: true, stale: false,
    lastAttemptAt: '2026-10-15T13:37:00Z', lastSuccessAt: '2026-10-15T13:38:00Z' };
  const latest = {
    campaigns: [{}], adSets: [{}], ads: [{}], campaignInsights: [{}], adInsights: [{}],
    orders: [{ orderNo: 'canonical-order' }], revenueData: { totalRevenue: 100 },
    cogsData: { totalCOGS: 20 }, economicsLedger: {}, orderNotificationAudit: {},
    fx: { usdToKrwRate: 1400 }, sourceAudit: { status: 'incomplete' },
    timestamp: '2026-10-15T13:38:00Z',
    sources: Object.fromEntries(['metaStructure', 'metaInsights', 'imweb', 'cogs'].map(key => [key, source])),
  };
  writeJsonFileSync(path.join(dataDir, 'latest_data.json'), latest);
  writeJsonFileSync(path.join(dataDir, 'latest_scan.json'), {
    scanId: 1, endTime: '2026-10-15T13:35:00Z', steps: [{ step: 'meta_insights', status: 'failed' }],
  });
  for (const [part, value] of Object.entries({
    meta_structure: { campaigns: [{ old: true }] }, meta_insights: { campaignInsights: [{ old: true }] },
    imweb_orders: [{ orderNo: 'recovered-order' }],
    normalized: { cogsData: { totalCOGS: 30 }, sources: { metaInsights: { status: 'error', stale: true } } },
  })) writeJsonFileSync(path.join(snapshotDir, `1_${part}.json`), value);
  const storePath = require.resolve('../server/modules/scanStore');
  const pathsPath = require.resolve('../server/runtime/paths');
  const previousStore = require.cache[storePath];
  const previousPaths = require.cache[pathsPath];
  require.cache[pathsPath] = { exports: { dataDir } };
  t.after(() => {
    if (previousStore) require.cache[storePath] = previousStore;
    else delete require.cache[storePath];
    if (previousPaths) require.cache[pathsPath] = previousPaths;
    else delete require.cache[pathsPath];
  });
  const reads = [];
  const readFile = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (String(file).startsWith(snapshotDir)) reads.push(path.basename(file));
    return readFile(file, ...args);
  });
  delete require.cache[storePath];
  let data = require(storePath).getLatestData();
  assert.deepEqual(reads, [], 'complete checkpoint must not allocate recovery snapshots');
  assert.deepEqual(data.orders, latest.orders);
  assert.equal(data.sources.metaInsights.status, 'connected');
  writeJsonFileSync(path.join(dataDir, 'latest_data.json'), { ...latest, orders: [], cogsData: null });
  delete require.cache[storePath];
  data = require(storePath).getLatestData();
  assert.deepEqual(reads, ['1_imweb_orders.json', '1_normalized.json']);
  assert.deepEqual(data.orders, [{ orderNo: 'recovered-order' }]);
  assert.equal(data.cogsData.totalCOGS, 30);
  assert.equal(data.sources.metaInsights.stale, false);
});
