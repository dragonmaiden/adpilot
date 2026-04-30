const fs = require('fs');
const path = require('path');
const runtimePaths = require('../runtime/paths');

const STATE_FILE = path.join(runtimePaths.dataDir, 'telegram_state.json');

function createState() {
  return {
    summary: {
      fingerprint: null,
      sentAt: null,
      category: null,
    },
    dailyReport: {
      reportDate: null,
      sentAt: null,
    },
  };
}

function normalizeDailyReportState(raw) {
  return {
    reportDate: typeof raw?.dailyReport?.reportDate === 'string' ? raw.dailyReport.reportDate : null,
    sentAt: typeof raw?.dailyReport?.sentAt === 'string' ? raw.dailyReport.sentAt : null,
  };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return createState();
  }

  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      summary: {
        fingerprint: typeof raw?.summary?.fingerprint === 'string' ? raw.summary.fingerprint : null,
        sentAt: typeof raw?.summary?.sentAt === 'string' ? raw.summary.sentAt : null,
        category: typeof raw?.summary?.category === 'string' ? raw.summary.category : null,
      },
      dailyReport: normalizeDailyReportState(raw),
    };
  } catch (err) {
    console.warn(`[TELEGRAM STATE] Failed to load state: ${err.message}`);
    return createState();
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.chmodSync(STATE_FILE, 0o600);
}

function getState() {
  return loadState();
}

function markSummarySent({ fingerprint, category, sentAt = new Date().toISOString() }) {
  const state = loadState();
  state.summary.fingerprint = fingerprint || null;
  state.summary.category = category || null;
  state.summary.sentAt = sentAt;
  saveState(state);
  return state;
}

function markDailyReportSent({ reportDate, sentAt = new Date().toISOString() }) {
  const state = loadState();
  state.dailyReport.reportDate = reportDate || null;
  state.dailyReport.sentAt = sentAt;
  saveState(state);
  return state;
}

module.exports = {
  getState,
  markDailyReportSent,
  markSummarySent,
};
