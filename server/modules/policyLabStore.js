const fs = require('fs');
const path = require('path');
const runtimePaths = require('../runtime/paths');

const DATA_DIR = runtimePaths.dataDir;
const FILES = Object.freeze({
  policies: 'budget_policies.json',
  experiments: 'policy_experiments.json',
  traces: 'decision_traces.json',
  outcomes: 'budget_outcomes.json',
  shadow: 'shadow_decision_log.json',
  observability: 'observability_events.json',
  state: 'policy_lab_state.json',
});

const LIMITS = Object.freeze({
  policies: 64,
  experiments: 128,
  traces: 4000,
  outcomes: 1000,
  shadow: 2000,
  observability: 1000,
});

function loadJson(filename, fallback) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (err) {
    console.warn(`[POLICY LAB] Failed to load ${filename}: ${err.message}`);
    return fallback;
  }
}

function saveJson(filename, value) {
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(value, null, 2));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function truncate(list, limit) {
  return asArray(list).slice(-limit);
}

function createDefaultState() {
  return {
    championPolicyId: null,
    activeShadowPolicyId: null,
    lastResearchRunAt: null,
    lastResearchSummary: null,
  };
}

const state = {
  policies: truncate(loadJson(FILES.policies, []), LIMITS.policies),
  experiments: truncate(loadJson(FILES.experiments, []), LIMITS.experiments),
  traces: truncate(loadJson(FILES.traces, []), LIMITS.traces),
  outcomes: truncate(loadJson(FILES.outcomes, []), LIMITS.outcomes),
  shadow: truncate(loadJson(FILES.shadow, []), LIMITS.shadow),
  observability: truncate(loadJson(FILES.observability, []), LIMITS.observability),
  meta: {
    ...createDefaultState(),
    ...(loadJson(FILES.state, createDefaultState()) || {}),
  },
};

function persistList(key, filename, limit) {
  state[key] = truncate(state[key], limit);
  saveJson(filename, state[key]);
  return state[key];
}

function persistMeta() {
  saveJson(FILES.state, state.meta);
  return state.meta;
}

function getPolicies() {
  return state.policies.slice();
}

function replacePolicies(policies) {
  state.policies = truncate(policies, LIMITS.policies);
  saveJson(FILES.policies, state.policies);
  return getPolicies();
}

function upsertPolicy(policy) {
  if (!policy || typeof policy !== 'object' || !policy.id) {
    return null;
  }

  const existing = state.policies.find(entry => entry.id === policy.id);
  if (existing) {
    Object.assign(existing, policy);
  } else {
    state.policies.push(policy);
  }

  persistList('policies', FILES.policies, LIMITS.policies);
  return state.policies.find(entry => entry.id === policy.id) || null;
}

function getExperiments() {
  return state.experiments.slice();
}

function replaceExperiments(experiments) {
  state.experiments = truncate(experiments, LIMITS.experiments);
  saveJson(FILES.experiments, state.experiments);
  return getExperiments();
}

function addExperiments(experiments) {
  if (!Array.isArray(experiments) || experiments.length === 0) {
    return getExperiments();
  }

  state.experiments.push(...experiments);
  persistList('experiments', FILES.experiments, LIMITS.experiments);
  return getExperiments();
}

function getDecisionTraces() {
  return state.traces.slice();
}

function addDecisionTraces(traces) {
  if (!Array.isArray(traces) || traces.length === 0) {
    return getDecisionTraces();
  }

  state.traces.push(...traces);
  persistList('traces', FILES.traces, LIMITS.traces);
  return getDecisionTraces();
}

function getBudgetOutcomes() {
  return state.outcomes.slice();
}

function addBudgetOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object' || !outcome.id) {
    return null;
  }

  state.outcomes.push(outcome);
  persistList('outcomes', FILES.outcomes, LIMITS.outcomes);
  return state.outcomes.find(entry => entry.id === outcome.id) || null;
}

function updateBudgetOutcome(id, patch) {
  if (!id) return null;
  const outcome = state.outcomes.find(entry => entry.id === id);
  if (!outcome) return null;

  const nextPatch = typeof patch === 'function' ? patch({ ...outcome }) : patch;
  if (!nextPatch || typeof nextPatch !== 'object') {
    return outcome;
  }

  Object.assign(outcome, nextPatch);
  persistList('outcomes', FILES.outcomes, LIMITS.outcomes);
  return outcome;
}

function getShadowDecisionLog() {
  return state.shadow.slice();
}

function addShadowDecisionLogs(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return getShadowDecisionLog();
  }

  state.shadow.push(...entries);
  persistList('shadow', FILES.shadow, LIMITS.shadow);
  return getShadowDecisionLog();
}

function getObservabilityEvents() {
  return state.observability.slice();
}

function addObservabilityEvent(event) {
  if (!event || typeof event !== 'object' || !event.id) {
    return null;
  }

  state.observability.push(event);
  persistList('observability', FILES.observability, LIMITS.observability);
  return state.observability.find(entry => entry.id === event.id) || null;
}

function getMetaState() {
  return {
    ...state.meta,
  };
}

function updateMetaState(patch) {
  const nextPatch = typeof patch === 'function' ? patch({ ...state.meta }) : patch;
  if (!nextPatch || typeof nextPatch !== 'object') {
    return getMetaState();
  }

  Object.assign(state.meta, nextPatch);
  persistMeta();
  return getMetaState();
}

module.exports = {
  getPolicies,
  replacePolicies,
  upsertPolicy,
  getExperiments,
  replaceExperiments,
  addExperiments,
  getDecisionTraces,
  addDecisionTraces,
  getBudgetOutcomes,
  addBudgetOutcome,
  updateBudgetOutcome,
  getShadowDecisionLog,
  addShadowDecisionLogs,
  getObservabilityEvents,
  addObservabilityEvent,
  getMetaState,
  updateMetaState,
};
