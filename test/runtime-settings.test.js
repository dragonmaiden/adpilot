const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function withMockedRuntimeSettings({ rawSettings, schedulerConfig }, run) {
  const modulePath = require.resolve('../server/runtime/runtimeSettings');
  const configPath = require.resolve('../server/config');
  const runtimePathsPath = require.resolve('../server/runtime/paths');

  const originalConfig = require(configPath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adpilot-runtime-settings-'));
  const runtimeSettingsFile = path.join(tempDir, 'runtime_settings.json');

  if (rawSettings !== undefined) {
    fs.writeFileSync(runtimeSettingsFile, JSON.stringify(rawSettings, null, 2));
  }

  const mockedConfig = {
    ...originalConfig,
    rules: { ...originalConfig.rules },
    scheduler: {
      ...originalConfig.scheduler,
      ...(schedulerConfig || {}),
    },
  };

  const originalConfigEntry = require.cache[configPath] || null;
  const originalRuntimePathsEntry = require.cache[runtimePathsPath] || null;
  const originalModuleEntry = require.cache[modulePath] || null;

  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: mockedConfig,
  };
  require.cache[runtimePathsPath] = {
    id: runtimePathsPath,
    filename: runtimePathsPath,
    loaded: true,
    exports: {
      runtimeSettingsFile,
    },
  };
  delete require.cache[modulePath];

  try {
    const runtimeSettings = require(modulePath);
    return await run({ runtimeSettings, runtimeSettingsFile });
  } finally {
    delete require.cache[modulePath];
    if (originalConfigEntry) require.cache[configPath] = originalConfigEntry;
    else delete require.cache[configPath];
    if (originalRuntimePathsEntry) require.cache[runtimePathsPath] = originalRuntimePathsEntry;
    else delete require.cache[runtimePathsPath];
    if (originalModuleEntry) require.cache[modulePath] = originalModuleEntry;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('loadState normalizes legacy persisted scheduler cadences to the current default and persists the migration', async () => {
  await withMockedRuntimeSettings({
    rawSettings: {
      schemaVersion: 1,
      rules: {
        autonomousMode: true,
      },
      scheduler: {
        scanIntervalMinutes: 3,
      },
    },
    schedulerConfig: {
      scanIntervalMinutes: 10,
    },
  }, async ({ runtimeSettings, runtimeSettingsFile }) => {
    assert.equal(runtimeSettings.getSchedulerSettings().scanIntervalMinutes, 10);

    const diagnostics = runtimeSettings.getSchedulerDiagnostics();
    assert.equal(diagnostics.driftDetected, false);
    assert.equal(diagnostics.migratedLegacyScheduler, true);
    assert.equal(diagnostics.persistedScanIntervalMinutes, 10);

    const persisted = JSON.parse(fs.readFileSync(runtimeSettingsFile, 'utf8'));
    assert.equal(persisted.schemaVersion, 2);
    assert.equal(persisted.scheduler.scanIntervalMinutes, 10);
  });
});

test('getSchedulerDiagnostics surfaces runtime drift when persisted runtime settings differ from service config', async () => {
  await withMockedRuntimeSettings({
    rawSettings: {
      schemaVersion: 2,
      rules: {
        autonomousMode: true,
      },
      scheduler: {
        scanIntervalMinutes: 3,
      },
    },
    schedulerConfig: {
      scanIntervalMinutes: 10,
    },
  }, async ({ runtimeSettings }) => {
    assert.equal(runtimeSettings.getSchedulerSettings().scanIntervalMinutes, 3);

    const diagnostics = runtimeSettings.getSchedulerDiagnostics();
    assert.equal(diagnostics.scanIntervalMinutes, 3);
    assert.equal(diagnostics.configuredScanIntervalMinutes, 10);
    assert.equal(diagnostics.persistedScanIntervalMinutes, 3);
    assert.equal(diagnostics.driftDetected, true);
    assert.equal(diagnostics.intervalSource, 'runtime_override');
    assert.equal(diagnostics.migratedLegacyScheduler, false);
  });
});
