const crypto = require('crypto');

const ALERT_DUPLICATE_COOLDOWN_MS = 90 * 60 * 1000;
const ALERT_ITEM_LIMIT = 3;
const PRIORITY_RANK = Object.freeze({
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
});
const PIPELINE_ERROR_STEPS = new Set([
  'meta_structure',
  'meta_insights',
  'imweb_orders',
  'cogs_sheets',
  'fx_rate',
  'economics_ledger',
  'source_audit',
]);

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

function formatStepName(step) {
  return String(step || 'unknown')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function buildSourceAuditAlert(scanResult, latestData) {
  const sourceAudit = scanResult?.sourceAudit || latestData?.sourceAudit || null;
  const reconciliation = sourceAudit?.reconciliation || null;
  if (!sourceAudit || reconciliation?.status === 'reconciled') {
    return null;
  }

  const failedChecks = Array.isArray(reconciliation?.failedChecks)
    ? reconciliation.failedChecks.filter(Boolean)
    : [];
  const reason = failedChecks.length > 0
    ? failedChecks.slice(0, 3).join(', ')
    : 'Source audit did not reconcile the latest source extraction to the financial projection.';

  return {
    priority: 'critical',
    type: 'source_audit',
    level: 'pipeline',
    targetName: 'Financial data projection',
    action: 'Source projection mismatch',
    reason,
    impact: 'Treat dashboard figures as stale until Imweb, Meta, Sheets, and the server projection reconcile cleanly.',
  };
}

function buildPipelineErrorAlerts(scanResult) {
  const seenSteps = new Set();
  const alerts = [];

  for (const entry of Array.isArray(scanResult?.errors) ? scanResult.errors : []) {
    const step = String(entry?.step || '').trim();
    if (!PIPELINE_ERROR_STEPS.has(step) || seenSteps.has(step)) {
      continue;
    }
    seenSteps.add(step);
    alerts.push({
      priority: step === 'source_audit' || step === 'economics_ledger' ? 'critical' : 'high',
      type: 'scan_error',
      level: 'pipeline',
      targetName: formatStepName(step),
      action: `${formatStepName(step)} failed`,
      reason: entry?.error || 'The scan reported a pipeline error without a detailed message.',
      impact: 'Check source health and preserve last-known-good data until the next clean scan.',
    });
  }

  return alerts;
}

function buildSourceHealthAlerts(latestData) {
  const sources = latestData?.sources && typeof latestData.sources === 'object'
    ? latestData.sources
    : {};
  const alerts = [];

  for (const [sourceKey, source] of Object.entries(sources)) {
    const status = String(source?.status || '').toLowerCase();
    const stale = source?.stale === true;
    if (!status || (status === 'connected' && !stale)) {
      continue;
    }
    alerts.push({
      priority: status === 'error' ? 'high' : 'medium',
      type: 'source_health',
      level: 'source',
      targetName: formatStepName(sourceKey),
      action: stale ? `${formatStepName(sourceKey)} is stale` : `${formatStepName(sourceKey)} is ${status}`,
      reason: source?.lastError || 'Source health is not fully connected.',
      impact: 'Verify source credentials and freshness before trusting new profit movement.',
    });
  }

  return alerts;
}

function buildDataPipelineAlertItems(scanResult, latestData) {
  const alerts = [
    buildSourceAuditAlert(scanResult, latestData),
    ...buildPipelineErrorAlerts(scanResult),
    ...buildSourceHealthAlerts(latestData),
  ].filter(Boolean);

  return alerts
    .sort((left, right) => (PRIORITY_RANK[right.priority] || 0) - (PRIORITY_RANK[left.priority] || 0))
    .slice(0, ALERT_ITEM_LIMIT);
}

function buildFingerprintPayload(context, category) {
  return {
    category,
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

  return `🚨 <b>AdPilot Data Pipeline Alert</b>

${alertLines}`;
}

function buildScanSummaryPlan(scanResult, latestData, state, now = new Date()) {
  const optimizations = Array.isArray(scanResult?.optimizations)
    ? scanResult.optimizations
    : [];

  const operatorAlerts = [
    ...buildDataPipelineAlertItems(scanResult, latestData),
    ...buildOperatorAlertItems(optimizations),
  ].slice(0, ALERT_ITEM_LIMIT);
  const category = getCategory({ operatorAlerts });
  const fingerprint = hash(JSON.stringify(buildFingerprintPayload({
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
        operatorAlerts,
      })
      : null,
  };
}

module.exports = {
  buildScanSummaryPlan,
  buildNotificationDecision,
  hoursSince,
};
