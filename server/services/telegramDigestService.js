const crypto = require('crypto');
const { getOptimizationStatus } = require('../domain/optimizationSemantics');

const STARTUP_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const ALERT_DUPLICATE_COOLDOWN_MS = 90 * 60 * 1000;
const ALERT_ITEM_LIMIT = 3;
const PRIORITY_RANK = Object.freeze({
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
});

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function hash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function parseIso(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function hoursSince(iso, now = new Date()) {
  const date = parseIso(iso);
  if (!date) return Infinity;
  return (now.getTime() - date.getTime()) / (60 * 60 * 1000);
}

function shouldSendStartupMessage(state, now = new Date()) {
  const lastSentAt = state?.startup?.sentAt;
  if (!lastSentAt) return true;
  return (now.getTime() - new Date(lastSentAt).getTime()) >= STARTUP_COOLDOWN_MS;
}

function buildOperatorAlertItems(optimizations) {
  return (Array.isArray(optimizations) ? optimizations : [])
    .filter(opt => opt?.status === 'advisory' && (opt.priority === 'critical' || opt.priority === 'high'))
    .sort((left, right) => {
      const priorityDelta = (PRIORITY_RANK[right.priority] || 0) - (PRIORITY_RANK[left.priority] || 0);
      if (priorityDelta !== 0) return priorityDelta;

      const leftTime = parseIso(left.timestamp)?.getTime() || 0;
      const rightTime = parseIso(right.timestamp)?.getTime() || 0;
      return leftTime - rightTime;
    })
    .slice(0, ALERT_ITEM_LIMIT);
}

function buildFingerprintPayload(context, category) {
  return {
    category,
    actionableCount: context.actionable.length,
    operatorAlerts: context.operatorAlerts.map(opt => [
      opt.priority,
      opt.type,
      opt.level,
      opt.targetName,
      opt.action,
      opt.reason,
    ]),
  };
}

function getCategory(context) {
  if (context.operatorAlerts.length > 0) {
    return 'alert';
  }
  return 'silent';
}

function buildNotificationDecision({ category, fingerprint, state, now = new Date() }) {
  if (category === 'silent') {
    return { shouldSend: false, reason: 'no-high-signal-content' };
  }

  const lastFingerprint = state?.summary?.fingerprint || null;
  const lastSentAt = state?.summary?.sentAt || null;
  const lastSent = parseIso(lastSentAt);
  const duplicate = lastFingerprint === fingerprint;

  if (!lastSent) {
    return { shouldSend: true, reason: 'first-alert' };
  }

  const elapsedMs = now.getTime() - lastSent.getTime();
  if (duplicate && elapsedMs < ALERT_DUPLICATE_COOLDOWN_MS) {
    return { shouldSend: false, reason: 'duplicate-alert' };
  }

  return {
    shouldSend: true,
    reason: duplicate ? 'alert-cooldown-expired' : 'new-alert',
  };
}

function buildOperatorAlertMessage(context) {
  const alertLines = context.operatorAlerts.map((opt, index) => (
    `${index + 1}. <b>${opt.action}</b>\n`
    + `   • Target: ${opt.targetName}\n`
    + `   • Why now: ${opt.reason}\n`
    + `   • Suggested move: ${opt.impact}`
  )).join('\n\n');

  const approvalNotice = context.actionable.length > 0
    ? `\n\n<i>${pluralize(context.actionable.length, 'approval request')} sent separately for executable campaign budget or stop-loss changes.</i>`
    : '';

  return `🚨 <b>AdPilot Action Alert</b>

${alertLines}${approvalNotice}`;
}

function buildScanSummaryPlan(scanResult, latestData, state, now = new Date()) {
  void latestData;

  const optimizations = (scanResult.optimizations || []).map(opt => ({
    ...opt,
    status: getOptimizationStatus(opt),
  }));

  const actionable = optimizations.filter(opt => opt.status === 'needs_approval' || opt.status === 'awaiting_telegram');
  const operatorAlerts = buildOperatorAlertItems(optimizations);
  const category = getCategory({ actionable, operatorAlerts });
  const fingerprint = hash(JSON.stringify(buildFingerprintPayload({
    actionable,
    operatorAlerts,
  }, category)));
  const decision = buildNotificationDecision({ category, fingerprint, state, now });

  return {
    shouldSend: decision.shouldSend,
    reason: decision.reason,
    category,
    fingerprint,
    text: decision.shouldSend
      ? buildOperatorAlertMessage({
        actionable,
        operatorAlerts,
      })
      : null,
  };
}

module.exports = {
  buildScanSummaryPlan,
  buildNotificationDecision,
  shouldSendStartupMessage,
  hoursSince,
};
