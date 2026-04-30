const imweb = require('./imwebClient');
const telegram = require('./telegram');
const runtimeSettings = require('../runtime/runtimeSettings');
const { getNextKstMidnightAt } = require('../services/dailyTelegramReportService');

let scanTimer = null;
let initialScanTimer = null;
let dailyReportTimer = null;
let nextRecurringRunAt = null;
let nextInitialRunAt = null;
let nextDailyReportAt = null;
let unsubscribeSettings = null;
let runScanRef = null;
let getLatestDataRef = null;

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

function clearDailyReportTimer() {
  if (dailyReportTimer) {
    clearTimeout(dailyReportTimer);
    dailyReportTimer = null;
  }
  nextDailyReportAt = null;
}

async function sendScheduledDailyReport(reportNow = new Date()) {
  if (typeof getLatestDataRef !== 'function') {
    console.warn('[SCHEDULER] Daily Telegram report skipped: latest data reader is not configured');
    return;
  }

  try {
    const result = await telegram.sendDailySummaryReport(getLatestDataRef(), { now: reportNow });
    if (result?.skipped && result.reason !== 'daily-report-already-sent') {
      console.log(`[SCHEDULER] Daily Telegram report skipped: ${result.reason}`);
    }
  } catch (err) {
    console.error(`[SCHEDULER] Daily Telegram report failed: ${err.message}`);
  }
}

function scheduleDailyReport() {
  clearDailyReportTimer();

  nextDailyReportAt = getNextKstMidnightAt(new Date());
  if (!nextDailyReportAt) {
    console.warn('[SCHEDULER] Daily Telegram report not scheduled: unable to resolve next KST midnight');
    return null;
  }

  const delayMs = Math.max(1000, nextDailyReportAt.getTime() - Date.now());
  const reportNow = nextDailyReportAt;
  dailyReportTimer = setTimeout(async () => {
    dailyReportTimer = null;
    nextDailyReportAt = null;
    await sendScheduledDailyReport(reportNow);
    scheduleDailyReport();
  }, delayMs);
  console.log(`[SCHEDULER] Daily Telegram report scheduled for ${nextDailyReportAt.toISOString()} (00:00 KST)`);
  return dailyReportTimer;
}

function startScheduler(runScan, options = {}) {
  if (scanTimer) {
    return scanTimer;
  }

  runScanRef = runScan;
  getLatestDataRef = options.getLatestData || null;
  const intervalMinutes = runtimeSettings.getSchedulerSettings().scanIntervalMinutes;
  console.log(`[SCHEDULER] Starting scan scheduler (every ${intervalMinutes} min)`);
  logSchedulerDiagnostics('Runtime interval override detected');

  imweb.loadTokens();
  telegram.startStatusChecks();

  nextInitialRunAt = new Date(Date.now() + 5000);
  initialScanTimer = setTimeout(() => {
    initialScanTimer = null;
    nextInitialRunAt = null;
    runScan(false);
  }, 5000);

  scheduleRecurringLoop();
  scheduleDailyReport();
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
  clearDailyReportTimer();

  if (unsubscribeSettings) {
    unsubscribeSettings();
    unsubscribeSettings = null;
  }

  telegram.stopStatusChecks();

  if (runScanRef) {
    runScanRef = null;
    getLatestDataRef = null;
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
