const imweb = require('./imwebClient');
const telegram = require('./telegram');
const runtimeSettings = require('../runtime/runtimeSettings');

let scanTimer = null;
let initialScanTimer = null;
let nextRecurringRunAt = null;
let nextInitialRunAt = null;
let unsubscribeSettings = null;
let runScanRef = null;

function logSchedulerDiagnostics(prefix) {
  const diagnostics = runtimeSettings.getSchedulerDiagnostics();
  if (!diagnostics.driftDetected) return;

  const persistedSuffix = Number.isFinite(diagnostics.persistedScanIntervalMinutes)
    ? `; persisted runtime ${diagnostics.persistedScanIntervalMinutes} min`
    : '';
  console.warn(
    `[SCHEDULER] ${prefix}: live ${diagnostics.scanIntervalMinutes} min vs config ${diagnostics.configuredScanIntervalMinutes} min${persistedSuffix}`
  );
}

function clearRecurringTimer() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  nextRecurringRunAt = null;
}

function scheduleRecurringLoop() {
  clearRecurringTimer();

  const intervalMinutes = runtimeSettings.getSchedulerSettings().scanIntervalMinutes;
  const intervalMs = intervalMinutes * 60 * 1000;
  nextRecurringRunAt = new Date(Date.now() + intervalMs);
  scanTimer = setInterval(() => {
    nextRecurringRunAt = new Date(Date.now() + intervalMs);
    runScanRef(false);
  }, intervalMs);
}

function startScheduler(runScan) {
  if (scanTimer) {
    return scanTimer;
  }

  runScanRef = runScan;
  const intervalMinutes = runtimeSettings.getSchedulerSettings().scanIntervalMinutes;
  console.log(`[SCHEDULER] Starting scan scheduler (every ${intervalMinutes} min)`);
  logSchedulerDiagnostics('Runtime interval override detected');

  imweb.loadTokens();
  telegram.startPolling();
  telegram.maybeSendStartupMessage();

  nextInitialRunAt = new Date(Date.now() + 5000);
  initialScanTimer = setTimeout(() => {
    initialScanTimer = null;
    nextInitialRunAt = null;
    runScan(false);
  }, 5000);

  scheduleRecurringLoop();
  unsubscribeSettings = runtimeSettings.onChange(({ changedKeys, current }) => {
    if (!changedKeys.includes('scanIntervalMinutes')) return;
    scheduleRecurringLoop();
    console.log(`[SCHEDULER] Rescheduled scan loop (every ${current.scheduler.scanIntervalMinutes} min)`);
    logSchedulerDiagnostics('Runtime interval override still active after reschedule');
  });

  return scanTimer;
}

function stopScheduler() {
  if (initialScanTimer) {
    clearTimeout(initialScanTimer);
    initialScanTimer = null;
    nextInitialRunAt = null;
  }

  clearRecurringTimer();

  if (unsubscribeSettings) {
    unsubscribeSettings();
    unsubscribeSettings = null;
  }

  if (runScanRef) {
    runScanRef = null;
    console.log('[SCHEDULER] Scheduler stopped');
  }
}

function getNextScheduledRunAt() {
  if (nextInitialRunAt && nextRecurringRunAt) {
    return nextInitialRunAt <= nextRecurringRunAt ? nextInitialRunAt : nextRecurringRunAt;
  }
  return nextInitialRunAt || nextRecurringRunAt || null;
}

module.exports = {
  startScheduler,
  stopScheduler,
  getNextScheduledRunAt,
};
