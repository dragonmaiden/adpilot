const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

function createTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adpilot-runtime-paths-'));
}

async function withMockedRuntimePaths(configOverride, run) {
  const runtimePathsPath = require.resolve('../server/runtime/paths');
  const configPath = require.resolve('../server/config');

  const originalRuntimePaths = require.cache[runtimePathsPath] || null;
  const originalConfig = require.cache[configPath] || null;
  delete require.cache[runtimePathsPath];
  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: configOverride,
  };

  try {
    const runtimePaths = require(runtimePathsPath);
    return await run(runtimePaths);
  } finally {
    delete require.cache[runtimePathsPath];
    if (originalRuntimePaths) {
      require.cache[runtimePathsPath] = originalRuntimePaths;
    }

    if (originalConfig) {
      require.cache[configPath] = originalConfig;
    } else {
      delete require.cache[configPath];
    }
  }
}

test('runtime paths recover from ENOSPC by pruning snapshot sets before falling back', async () => {
  const dataDir = createTempDataDir();
  const snapshotDir = path.join(dataDir, 'snapshots');
  fs.mkdirSync(snapshotDir, { recursive: true });

  for (let index = 0; index < 30; index += 1) {
    const scanId = String(1000 + index);
    fs.writeFileSync(path.join(snapshotDir, `${scanId}_normalized.json`), JSON.stringify({ scanId }));
  }

  const originalWriteFileSync = fs.writeFileSync;
  let firstWriteTest = true;
  fs.writeFileSync = (filepath, data, options) => {
    if (firstWriteTest && String(filepath).includes('.write-test-') && path.dirname(filepath) === dataDir) {
      firstWriteTest = false;
      const error = new Error('disk full');
      error.code = 'ENOSPC';
      throw error;
    }
    return originalWriteFileSync(filepath, data, options);
  };

  try {
    await withMockedRuntimePaths({
      paths: {
        defaultDataDir: dataDir,
      },
    }, async runtimePaths => {
      assert.equal(runtimePaths.usedFallback, false);
      assert.equal(runtimePaths.dataDir, dataDir);
      assert.equal(runtimePaths.startupRecovery.recovered, true);
      assert.equal(runtimePaths.startupRecovery.deletedSnapshotSets, 6);

      const remainingScanIds = fs.readdirSync(snapshotDir)
        .filter(file => file.endsWith('.json'))
        .map(file => file.split('_')[0]);
      assert.equal(new Set(remainingScanIds).size, 24);
    });
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
});

test('startup enforces snapshot byte budget even when the tiny write probe succeeds', async t => {
  const dataDir = createTempDataDir();
  const snapshotDir = path.join(dataDir, 'snapshots');
  fs.mkdirSync(snapshotDir);
  for (const id of ['1000', '2000', '3000']) {
    fs.writeFileSync(path.join(snapshotDir, `${id}_normalized.json`), 'x'.repeat(30));
  }
  const stateFile = path.join(dataDir, 'payway_payment_watch_state.json');
  fs.writeFileSync(stateFile, '{"pending":"preserve"}');
  const previous = process.env.SNAPSHOT_MAX_BYTES;
  process.env.SNAPSHOT_MAX_BYTES = '65';
  t.after(() => {
    if (previous === undefined) delete process.env.SNAPSHOT_MAX_BYTES;
    else process.env.SNAPSHOT_MAX_BYTES = previous;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await withMockedRuntimePaths({ paths: { defaultDataDir: dataDir } }, async runtimePaths => {
    assert.equal(runtimePaths.usedFallback, false);
    assert.equal(fs.existsSync(path.join(snapshotDir, '1000_normalized.json')), false);
    assert.equal(fs.readdirSync(snapshotDir).length, 2);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), '{"pending":"preserve"}');
  });
});
