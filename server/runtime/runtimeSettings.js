const fs = require('fs');
const EventEmitter = require('events');
const config = require('../config');
const runtimePaths = require('./paths');

const emitter = new EventEmitter();
const SETTINGS_SCHEMA_VERSION = 2;

const MUTABLE_RULE_KEYS = [
  'autonomousMode',
  'maxBudgetChangePercent',
  'cpaPauseThreshold',
  'budgetReallocationEnabled',
];

const MUTABLE_SCHEDULER_KEYS = [
  'scanIntervalMinutes',
];

function pick(source, keys) {
  return keys.reduce((result, key) => {
    result[key] = source[key];
    return result;
  }, {});
}

function cloneState(state) {
  return {
    rules: { ...state.rules },
    scheduler: { ...state.scheduler },
  };
}

const defaultState = {
  rules: pick(config.rules, MUTABLE_RULE_KEYS),
  scheduler: pick(config.scheduler, MUTABLE_SCHEDULER_KEYS),
};

const runtimeMetadata = {
  hasPersistedFile: false,
  persistedSchedulerScanIntervalMinutes: null,
  migratedLegacyScheduler: false,
};

function validateSettingsPatch(updates) {
  const errors = [];

  if (updates.autonomousMode !== undefined && typeof updates.autonomousMode !== 'boolean') {
    errors.push('autonomousMode must be a boolean');
  }
  if (updates.maxBudgetChangePercent !== undefined && (!Number.isFinite(updates.maxBudgetChangePercent) || updates.maxBudgetChangePercent < 1 || updates.maxBudgetChangePercent > 100)) {
    errors.push('maxBudgetChangePercent must be a number between 1 and 100');
  }
  if (updates.cpaPauseThreshold !== undefined && (!Number.isFinite(updates.cpaPauseThreshold) || updates.cpaPauseThreshold < 1 || updates.cpaPauseThreshold > 500)) {
    errors.push('cpaPauseThreshold must be a number between 1 and 500');
  }
  if (updates.scanIntervalMinutes !== undefined && (!Number.isFinite(updates.scanIntervalMinutes) || updates.scanIntervalMinutes < 1 || updates.scanIntervalMinutes > 1440)) {
    errors.push('scanIntervalMinutes must be a number between 1 and 1440');
  }
  if (updates.budgetReallocationEnabled !== undefined && typeof updates.budgetReallocationEnabled !== 'boolean') {
    errors.push('budgetReallocationEnabled must be a boolean');
  }

  return errors;
}

function persistState(state) {
  fs.writeFileSync(runtimePaths.runtimeSettingsFile, JSON.stringify({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    rules: state.rules,
    scheduler: state.scheduler,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function updateRuntimeMetadata(patch = {}) {
  Object.assign(runtimeMetadata, patch);
}

function loadState() {
  if (!fs.existsSync(runtimePaths.runtimeSettingsFile)) {
    updateRuntimeMetadata({
      hasPersistedFile: false,
      persistedSchedulerScanIntervalMinutes: null,
      migratedLegacyScheduler: false,
    });
    return cloneState(defaultState);
  }

  try {
    const raw = JSON.parse(fs.readFileSync(runtimePaths.runtimeSettingsFile, 'utf8'));
    let shouldPersistMigration = false;
    let migratedLegacyScheduler = false;
    const persisted = {
      autonomousMode: raw.rules?.autonomousMode,
      maxBudgetChangePercent: raw.rules?.maxBudgetChangePercent,
      cpaPauseThreshold: raw.rules?.cpaPauseThreshold,
      budgetReallocationEnabled: raw.rules?.budgetReallocationEnabled,
      scanIntervalMinutes: raw.scheduler?.scanIntervalMinutes,
    };

    // Migrate legacy single-loop scheduler files to the current default cadence.
    // Older production disks may still carry 3/30/60 minute defaults from previous
    // experiments; if the settings file predates this schema, normalize those legacy
    // values to the new default once on boot.
    if (
      raw.schemaVersion !== SETTINGS_SCHEMA_VERSION
      && defaultState.scheduler.scanIntervalMinutes === 10
      && [3, 5, 30, 60].includes(persisted.scanIntervalMinutes)
    ) {
      persisted.scanIntervalMinutes = 10;
      raw.scheduler = {
        ...(raw.scheduler || {}),
        scanIntervalMinutes: 10,
      };
      shouldPersistMigration = true;
      migratedLegacyScheduler = true;
    }

    const errors = validateSettingsPatch(Object.fromEntries(
      Object.entries(persisted).filter(([, value]) => value !== undefined)
    ));

    if (errors.length > 0) {
      console.warn(`[SETTINGS] Ignoring invalid persisted runtime settings: ${errors.join('; ')}`);
      updateRuntimeMetadata({
        hasPersistedFile: true,
        persistedSchedulerScanIntervalMinutes: Number.isFinite(persisted.scanIntervalMinutes)
          ? persisted.scanIntervalMinutes
          : null,
        migratedLegacyScheduler: false,
      });
      return cloneState(defaultState);
    }

    const nextState = {
      rules: {
        ...defaultState.rules,
        ...(raw.rules || {}),
      },
      scheduler: {
        ...defaultState.scheduler,
        ...(raw.scheduler || {}),
      },
    };

    if (raw.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
      shouldPersistMigration = true;
      raw.schemaVersion = SETTINGS_SCHEMA_VERSION;
    }

    if (shouldPersistMigration) {
      fs.writeFileSync(runtimePaths.runtimeSettingsFile, JSON.stringify({
        schemaVersion: raw.schemaVersion,
        rules: nextState.rules,
        scheduler: nextState.scheduler,
        updatedAt: new Date().toISOString(),
      }, null, 2));
    }

    updateRuntimeMetadata({
      hasPersistedFile: true,
      persistedSchedulerScanIntervalMinutes: Number.isFinite(persisted.scanIntervalMinutes)
        ? persisted.scanIntervalMinutes
        : null,
      migratedLegacyScheduler,
    });

    return nextState;
  } catch (err) {
    console.warn(`[SETTINGS] Failed to load persisted runtime settings: ${err.message}`);
    updateRuntimeMetadata({
      hasPersistedFile: true,
      persistedSchedulerScanIntervalMinutes: null,
      migratedLegacyScheduler: false,
    });
    return cloneState(defaultState);
  }
}

let state = loadState();

function getSettings() {
  return {
    rules: {
      ...config.rules,
      ...state.rules,
    },
    scheduler: {
      ...config.scheduler,
      ...state.scheduler,
    },
  };
}

function getRules() {
  return getSettings().rules;
}

function getSchedulerSettings() {
  return getSettings().scheduler;
}

function getSchedulerDiagnostics() {
  const settings = getSettings();
  const effectiveScanIntervalMinutes = Number(settings.scheduler?.scanIntervalMinutes ?? null);
  const configuredScanIntervalMinutes = Number(config.scheduler?.scanIntervalMinutes ?? null);
  const persistedScanIntervalMinutes = Number.isFinite(runtimeMetadata.persistedSchedulerScanIntervalMinutes)
    ? Number(runtimeMetadata.persistedSchedulerScanIntervalMinutes)
    : null;
  const driftDetected = Number.isFinite(effectiveScanIntervalMinutes)
    && Number.isFinite(configuredScanIntervalMinutes)
    && effectiveScanIntervalMinutes !== configuredScanIntervalMinutes;

  let intervalSource = 'config_default';
  if (runtimeMetadata.hasPersistedFile) {
    intervalSource = driftDetected ? 'runtime_override' : 'persisted_matches_config';
  }

  return {
    scanIntervalMinutes: effectiveScanIntervalMinutes,
    configuredScanIntervalMinutes,
    persistedScanIntervalMinutes,
    driftDetected,
    intervalSource,
    migratedLegacyScheduler: Boolean(runtimeMetadata.migratedLegacyScheduler),
  };
}

function updateSettings(updates) {
  const errors = validateSettingsPatch(updates);
  if (errors.length > 0) {
    const err = new Error(errors.join('; '));
    err.statusCode = 400;
    throw err;
  }

  const previous = getSettings();
  const nextState = cloneState(state);
  const changedKeys = [];

  for (const key of MUTABLE_RULE_KEYS) {
    if (updates[key] !== undefined && nextState.rules[key] !== updates[key]) {
      nextState.rules[key] = updates[key];
      changedKeys.push(key);
    }
  }

  for (const key of MUTABLE_SCHEDULER_KEYS) {
    if (updates[key] !== undefined && nextState.scheduler[key] !== updates[key]) {
      nextState.scheduler[key] = updates[key];
      changedKeys.push(key);
    }
  }

  if (changedKeys.length === 0) {
    return {
      settings: getSettings(),
      changedKeys,
    };
  }

  state = nextState;
  persistState(state);
  updateRuntimeMetadata({
    hasPersistedFile: true,
    persistedSchedulerScanIntervalMinutes: Number.isFinite(nextState.scheduler.scanIntervalMinutes)
      ? nextState.scheduler.scanIntervalMinutes
      : null,
    migratedLegacyScheduler: false,
  });

  const current = getSettings();
  emitter.emit('changed', {
    previous,
    current,
    changedKeys,
  });

  return {
    settings: current,
    changedKeys,
  };
}

function onChange(listener) {
  emitter.on('changed', listener);
  return () => emitter.off('changed', listener);
}

module.exports = {
  getSettings,
  getRules,
  getSchedulerSettings,
  getSchedulerDiagnostics,
  updateSettings,
  validateSettingsPatch,
  onChange,
};
