const imweb = require('./imwebClient');
const telegram = require('./telegram');
const runtimeSettings = require('../runtime/runtimeSettings');

const COMMERCE_INITIAL_DELAY_MS = 5 * 1000;
const ANALYSIS_INITIAL_DELAY_MS = 90 * 1000;

let commerceTimer = null;
let analysisTimer = null;
let initialCommerceTimer = null;
let initialAnalysisTimer = null;
let nextCommerceRunAt = null;
let nextAnalysisRunAt = null;
let unsubscribeSettings = null;
let runAnalysisRef = null;
let runCommerceRef = null;

function clearTimer(timerRef) {
  if (timerRef.current) {
    clearTimeout(timerRef.current);
    clearInterval(timerRef.current);
    timerRef.current = null;
  }
}

function clearRecurringTimers() {
  clearTimer({ current: commerceTimer });
  commerceTimer = null;
  clearTimer({ current: analysisTimer });
  analysisTimer = null;
  nextCommerceRunAt = null;
  nextAnalysisRunAt = null;
}

function clearInitialTimers() {
  clearTimer({ current: initialCommerceTimer });
  initialCommerceTimer = null;
  clearTimer({ current: initialAnalysisTimer });
  initialAnalysisTimer = null;
}

function scheduleCommerceLoop() {
  if (commerceTimer) {
    clearInterval(commerceTimer);
    commerceTimer = null;
  }

  const intervalMinutes = runtimeSettings.getSchedulerSettings().scanIntervalMinutes;
  const intervalMs = intervalMinutes * 60 * 1000;
  nextCommerceRunAt = new Date(Date.now() + intervalMs);
  commerceTimer = setInterval(() => {
    nextCommerceRunAt = new Date(Date.now() + intervalMs);
    runCommerceRef(false);
  }, intervalMs);
}

function scheduleAnalysisLoop() {
  if (analysisTimer) {
    clearInterval(analysisTimer);
    analysisTimer = null;
  }

  const intervalMinutes = runtimeSettings.getSchedulerSettings().analysisIntervalMinutes;
  const intervalMs = intervalMinutes * 60 * 1000;
  nextAnalysisRunAt = new Date(Date.now() + intervalMs);
  analysisTimer = setInterval(() => {
    nextAnalysisRunAt = new Date(Date.now() + intervalMs);
    runAnalysisRef(false);
  }, intervalMs);
}

function startScheduler(runAnalysis, runCommerceSync) {
  if (commerceTimer || analysisTimer) {
    return { commerceTimer, analysisTimer };
  }

  runAnalysisRef = runAnalysis;
  runCommerceRef = runCommerceSync;
  const settings = runtimeSettings.getSchedulerSettings();
  console.log(
    `[SCHEDULER] Starting scheduler `
    + `(commerce every ${settings.scanIntervalMinutes} min, analysis every ${settings.analysisIntervalMinutes} min)`
  );

  imweb.loadTokens();
  telegram.startPolling();
  telegram.maybeSendStartupMessage();

  nextCommerceRunAt = new Date(Date.now() + COMMERCE_INITIAL_DELAY_MS);
  initialCommerceTimer = setTimeout(() => {
    initialCommerceTimer = null;
    nextCommerceRunAt = null;
    runCommerceSync(false);
  }, COMMERCE_INITIAL_DELAY_MS);

  nextAnalysisRunAt = new Date(Date.now() + ANALYSIS_INITIAL_DELAY_MS);
  initialAnalysisTimer = setTimeout(() => {
    initialAnalysisTimer = null;
    nextAnalysisRunAt = null;
    runAnalysis(false);
  }, ANALYSIS_INITIAL_DELAY_MS);

  scheduleCommerceLoop();
  scheduleAnalysisLoop();
  unsubscribeSettings = runtimeSettings.onChange(({ changedKeys, current }) => {
    if (changedKeys.includes('scanIntervalMinutes')) {
      scheduleCommerceLoop();
      console.log(`[SCHEDULER] Rescheduled commerce sync loop (every ${current.scheduler.scanIntervalMinutes} min)`);
    }
    if (changedKeys.includes('analysisIntervalMinutes')) {
      scheduleAnalysisLoop();
      console.log(`[SCHEDULER] Rescheduled analysis loop (every ${current.scheduler.analysisIntervalMinutes} min)`);
    }
  });

  return { commerceTimer, analysisTimer };
}

function stopScheduler() {
  clearInitialTimers();
  clearRecurringTimers();

  if (unsubscribeSettings) {
    unsubscribeSettings();
    unsubscribeSettings = null;
  }

  if (runAnalysisRef || runCommerceRef) {
    runAnalysisRef = null;
    runCommerceRef = null;
    console.log('[SCHEDULER] Scheduler stopped');
  }
}

function getNextScheduledRunAt() {
  const candidates = [
    nextCommerceRunAt,
    nextAnalysisRunAt,
  ].filter(Boolean);

  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, candidate) => (candidate < earliest ? candidate : earliest));
}

module.exports = {
  startScheduler,
  stopScheduler,
  getNextScheduledRunAt,
};
