const scheduler = require('../modules/scheduler');
const contracts = require('../contracts/v1');
const {
  getApprovalDedupKey,
  getLifecycleStatus,
} = require('./optimizationDedupService');
const {
  getOptimizationStatus,
  isBudgetIncreaseAction,
} = require('../domain/optimizationSemantics');

const WINDOW_HOURS = 72;
const STALE_ALERT_HOURS = 36;

function parseTimestamp(value) {
  const timestampMs = new Date(value || 0).getTime();
  return Number.isFinite(timestampMs) ? timestampMs : 0;
}

function getReferenceTimestamp(opt) {
  return parseTimestamp(opt?.approvalRequestedAt || opt?.timestamp);
}

function isRecent(opt, nowMs, windowMs) {
  const timestampMs = getReferenceTimestamp(opt);
  return timestampMs > 0 && (nowMs - timestampMs) <= windowMs;
}

function summarizeOptimization(opt) {
  return {
    id: opt.id ?? '',
    targetName: opt.targetName ?? '',
    action: opt.action ?? '',
    status: getOptimizationStatus(opt),
    priority: opt.priority ?? 'low',
    timestamp: opt.timestamp ?? null,
    approvalRequestedAt: opt.approvalRequestedAt ?? null,
  };
}

function buildDuplicateApprovalTargets(optimizations) {
  const grouped = new Map();

  for (const opt of optimizations) {
    const key = getApprovalDedupKey(opt);
    if (!key) continue;

    const existing = grouped.get(key) || {
      key,
      targetName: opt.targetName ?? '',
      targetId: opt.targetId ?? '',
      action: opt.action ?? '',
      count: 0,
      statuses: new Set(),
      latestTimestamp: 0,
    };

    existing.count += 1;
    existing.statuses.add(getOptimizationStatus(opt));
    existing.latestTimestamp = Math.max(existing.latestTimestamp, getReferenceTimestamp(opt));
    grouped.set(key, existing);
  }

  return Array.from(grouped.values())
    .filter(entry => entry.count > 1)
    .sort((left, right) => right.count - left.count || right.latestTimestamp - left.latestTimestamp)
    .slice(0, 10)
    .map(entry => ({
      targetName: entry.targetName,
      targetId: entry.targetId,
      action: entry.action,
      count: entry.count,
      statuses: Array.from(entry.statuses).sort(),
      latestTimestamp: entry.latestTimestamp > 0 ? new Date(entry.latestTimestamp).toISOString() : null,
    }));
}

function getRecommendationQualityResponse() {
  const nowMs = Date.now();
  const windowMs = WINDOW_HOURS * 60 * 60 * 1000;
  const staleAlertMs = STALE_ALERT_HOURS * 60 * 60 * 1000;
  const optimizations = scheduler.getAllOptimizations() || [];
  const recentOptimizations = optimizations.filter(opt => isRecent(opt, nowMs, windowMs));
  const recentScaleRecommendations = recentOptimizations
    .filter(opt => opt.type === 'budget' && opt.level === 'campaign' && isBudgetIncreaseAction(opt.action))
    .sort((left, right) => getReferenceTimestamp(right) - getReferenceTimestamp(left))
    .slice(0, 20)
    .map(summarizeOptimization);
  const staleHighPriorityAlerts = optimizations.filter(opt => {
    const status = getOptimizationStatus(opt);
    if (status !== 'advisory') return false;
    if (!['high', 'critical'].includes(String(opt.priority || '').toLowerCase())) return false;
    const timestampMs = getReferenceTimestamp(opt);
    return timestampMs > 0 && (nowMs - timestampMs) > staleAlertMs;
  });
  const duplicateApprovalTargets = buildDuplicateApprovalTargets(recentOptimizations);

  const lifecycleCounts = recentOptimizations.reduce((summary, opt) => {
    const lifecycle = getLifecycleStatus(opt);
    if (lifecycle) {
      summary[lifecycle] = (summary[lifecycle] || 0) + 1;
    }
    return summary;
  }, {});

  return contracts.recommendationQuality({
    generatedAt: new Date(nowMs).toISOString(),
    windowHours: WINDOW_HOURS,
    summary: {
      totalRecentRecommendations: recentOptimizations.length,
      recentScaleRecommendations: recentScaleRecommendations.length,
      openApprovals: recentOptimizations.filter(opt => ['needs_approval', 'awaiting_telegram'].includes(getOptimizationStatus(opt))).length,
      expiredApprovals: lifecycleCounts.expired || 0,
      rejectedApprovals: lifecycleCounts.rejected || 0,
      failedApprovalRequests: lifecycleCounts.failed_request || 0,
      staleHighPriorityAlerts: staleHighPriorityAlerts.length,
      duplicateApprovalClusters: duplicateApprovalTargets.length,
    },
    duplicateApprovalTargets,
    recentScaleRecommendations,
  });
}

module.exports = {
  getRecommendationQualityResponse,
};
