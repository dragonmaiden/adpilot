const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

function createTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adpilot-snapshots-'));
}

async function withMockedSnapshotRepository(runtimePaths, run) {
  const repositoryPath = require.resolve('../server/modules/snapshotRepository');
  const runtimePathsPath = require.resolve('../server/runtime/paths');

  const originalRepository = require.cache[repositoryPath] || null;
  const originalRuntimePaths = require.cache[runtimePathsPath] || null;
  delete require.cache[repositoryPath];
  require.cache[runtimePathsPath] = {
    id: runtimePathsPath,
    filename: runtimePathsPath,
    loaded: true,
    exports: runtimePaths,
  };

  try {
    const repository = require(repositoryPath);
    return await run(repository);
  } finally {
    delete require.cache[repositoryPath];
    if (originalRepository) {
      require.cache[repositoryPath] = originalRepository;
    }

    if (originalRuntimePaths) {
      require.cache[runtimePathsPath] = originalRuntimePaths;
    } else {
      delete require.cache[runtimePathsPath];
    }
  }
}

function listSnapshotScanIds(dataDir) {
  const snapshotDir = path.join(dataDir, 'snapshots');
  return fs.readdirSync(snapshotDir)
    .filter(file => file.endsWith('.json'))
    .map(file => file.split('_')[0])
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
}

test('saveSnapshot prunes old scan sets before writing new snapshots', async () => {
  const dataDir = createTempDataDir();
  const snapshotDir = path.join(dataDir, 'snapshots');
  fs.mkdirSync(snapshotDir, { recursive: true });

  const previousLimit = process.env.SNAPSHOT_MAX_SCAN_SETS;
  process.env.SNAPSHOT_MAX_SCAN_SETS = '3';

  try {
    for (const scanId of ['1000', '2000', '3000', '4000']) {
      fs.writeFileSync(
        path.join(snapshotDir, `${scanId}_normalized.json`),
        JSON.stringify({ scanId }),
      );
    }

    await withMockedSnapshotRepository({
      dataDir,
      logDir: path.join(dataDir, 'logs'),
    }, async repository => {
      repository.saveSnapshot('5000', {
        revenueData: { totalRevenue: 1 },
      });
    });

    assert.deepEqual(listSnapshotScanIds(dataDir), ['3000', '4000', '5000']);
  } finally {
    if (previousLimit === undefined) {
      delete process.env.SNAPSHOT_MAX_SCAN_SETS;
    } else {
      process.env.SNAPSHOT_MAX_SCAN_SETS = previousLimit;
    }
  }
});

test('saveSnapshot retries after ENOSPC by pruning more aggressively', async () => {
  const dataDir = createTempDataDir();
  const snapshotDir = path.join(dataDir, 'snapshots');
  fs.mkdirSync(snapshotDir, { recursive: true });

  const previousLimit = process.env.SNAPSHOT_MAX_SCAN_SETS;
  process.env.SNAPSHOT_MAX_SCAN_SETS = '4';

  try {
    for (const scanId of ['1000', '2000', '3000', '4000']) {
      fs.writeFileSync(
        path.join(snapshotDir, `${scanId}_normalized.json`),
        JSON.stringify({ scanId }),
      );
    }

    const originalWriteFileSync = fs.writeFileSync;
    let firstWrite = true;
    fs.writeFileSync = (filepath, data, options) => {
      if (firstWrite && String(filepath).includes('5000_normalized.json')) {
        firstWrite = false;
        const error = new Error('disk full');
        error.code = 'ENOSPC';
        throw error;
      }
      return originalWriteFileSync(filepath, data, options);
    };

    try {
      await withMockedSnapshotRepository({
        dataDir,
        logDir: path.join(dataDir, 'logs'),
      }, async repository => {
        repository.saveSnapshot('5000', {
          revenueData: { totalRevenue: 1 },
        });
      });
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }

    assert.deepEqual(listSnapshotScanIds(dataDir), ['3000', '4000', '5000']);
  } finally {
    if (previousLimit === undefined) {
      delete process.env.SNAPSHOT_MAX_SCAN_SETS;
    } else {
      process.env.SNAPSHOT_MAX_SCAN_SETS = previousLimit;
    }
  }
});
