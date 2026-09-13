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
    reportDeliveries: {},
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
      reportDeliveries: raw.reportDeliveries || {},
    };
  } catch (err) {
    console.warn(`[TELEGRAM STATE] Failed to load state: ${err.message}`);
    throw err;
  }
}

function saveState(state) {
  const temporaryFile = `${STATE_FILE}.${process.pid}.tmp`;
  const fd = fs.openSync(temporaryFile, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(state, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporaryFile, STATE_FILE);
}

// Keep Telegram's receiver ID on the persistent disk before attempting Postgres.
function recordReportDelivery(record) {
  const state = loadState();
  state.reportDeliveries[record.reportDate] = { ...record, ledgerPending: true };
  if (record.status === 'sent') {
    state.dailyReport = { reportDate: record.reportDate, sentAt: record.sentAt };
  }
  saveState(state);
}

function markReportDeliverySynced(record) {
  const state = loadState();
  const current = state.reportDeliveries[record.reportDate];
  // An older database write must not acknowledge a newer correction.
  if (current && JSON.stringify({ ...current, ledgerPending: undefined })
      === JSON.stringify({ ...record, ledgerPending: undefined })) {
    current.ledgerPending = false;
    saveState(state);
  }
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
  recordReportDelivery,
  markReportDeliverySynced,
};
