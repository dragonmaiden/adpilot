const fs = require('fs');
const EventEmitter = require('events');
const config = require('../config');
const runtimePaths = require('./paths');

const emitter = new EventEmitter();

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
  if (updates.scanIntervalMinutes !== undefined && (!Number.isFinite(updates.scanIntervalMinutes) || updates.scanIntervalMinutes < 5 || updates.scanIntervalMinutes > 1440)) {
    errors.push('scanIntervalMinutes must be a number between 5 and 1440');
  }
  if (updates.budgetReallocationEnabled !== undefined && typeof updates.budgetReallocationEnabled !== 'boolean') {
    errors.push('budgetReallocationEnabled must be a boolean');
  }

  return errors;
}

function persistState(state) {
  fs.writeFileSync(runtimePaths.runtimeSettingsFile, JSON.stringify({
    rules: state.rules,
    scheduler: state.scheduler,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function loadState() {
  if (!fs.existsSync(runtimePaths.runtimeSettingsFile)) {
    return cloneState(defaultState);
  }

  try {
    const raw = JSON.parse(fs.readFileSync(runtimePaths.runtimeSettingsFile, 'utf8'));
    const persisted = {
      autonomousMode: raw.rules?.autonomousMode,
      maxBudgetChangePercent: raw.rules?.maxBudgetChangePercent,
      cpaPauseThreshold: raw.rules?.cpaPauseThreshold,
      budgetReallocationEnabled: raw.rules?.budgetReallocationEnabled,
      scanIntervalMinutes: raw.scheduler?.scanIntervalMinutes,
    };

    const errors = validateSettingsPatch(Object.fromEntries(
      Object.entries(persisted).filter(([, value]) => value !== undefined)
    ));

    if (errors.length > 0) {
      console.warn(`[SETTINGS] Ignoring invalid persisted runtime settings: ${errors.join('; ')}`);
      return cloneState(defaultState);
    }

    return {
      rules: {
        ...defaultState.rules,
        ...(raw.rules || {}),
      },
      scheduler: {
        ...defaultState.scheduler,
        ...(raw.scheduler || {}),
      },
    };
  } catch (err) {
    console.warn(`[SETTINGS] Failed to load persisted runtime settings: ${err.message}`);
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
  updateSettings,
  validateSettingsPatch,
  onChange,
};
