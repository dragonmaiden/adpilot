const fs = require('fs');
const path = require('path');
const runtimePaths = require('../runtime/paths');

const DATA_DIR = runtimePaths.dataDir;
const OBSERVABILITY_FILE = 'observability_events.json';
const OBSERVABILITY_LIMIT = 1000;

function loadJson(filename, fallback) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (err) {
    console.warn(`[OBSERVABILITY] Failed to load ${filename}: ${err.message}`);
    return fallback;
  }
}

function saveJson(filename, value) {
  const filepath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(filepath, 0o600);
}

function truncate(list, limit) {
  return (Array.isArray(list) ? list : []).slice(-limit);
}

const state = {
  events: truncate(loadJson(OBSERVABILITY_FILE, []), OBSERVABILITY_LIMIT),
};

function addObservabilityEvent(event) {
  if (!event || typeof event !== 'object' || !event.id) {
    return null;
  }

  state.events.push(event);
  state.events = truncate(state.events, OBSERVABILITY_LIMIT);
  saveJson(OBSERVABILITY_FILE, state.events);
  return state.events.find(entry => entry.id === event.id) || null;
}

function getObservabilityEvents() {
  return state.events.slice();
}

module.exports = {
  addObservabilityEvent,
  getObservabilityEvents,
};
