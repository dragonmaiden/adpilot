const {
  getOptimizationDirection,
  isExecutableOptimization,
  isBudgetIncreaseAction,
  isBudgetDecreaseAction,
  isReallocationAction,
  requiresApproval,
} = require('../domain/optimizationSemantics');

const BLOCKING_COOLDOWNS_MS = Object.freeze({
  pending: Number.POSITIVE_INFINITY,
  rejected: 12 * 60 * 60 * 1000,
  expired: 12 * 60 * 60 * 1000,
  failed_request: 30 * 60 * 1000,
});

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function extractBudgetPercent(actionText) {
  const match = String(actionText || '').match(/\((\d+(?:\.\d+)?)%\)/);
  return match ? Number(match[1]) : null;
}

function getApprovalActionSignature(optimization) {
  const actionText = normalizeText(optimization?.action);
  if (!actionText) return '';

  if (optimization?.type === 'budget') {
    if (isReallocationAction(actionText)) {
      return actionText;
    }

    const percent = extractBudgetPercent(actionText);
    const direction = getOptimizationDirection(actionText);
    if (percent !== null) {
      return `${direction}:${percent}%`;
    }

    if (isBudgetIncreaseAction(actionText) || isBudgetDecreaseAction(actionText)) {
      return `${direction}:budget-change`;
    }
  }

  return actionText;
}

function getApprovalDedupKey(optimization) {
  if (!requiresApproval(optimization) || !isExecutableOptimization(optimization)) {
    return null;
  }

  return [
    normalizeText(optimization.type),
    normalizeText(optimization.level),
    normalizeText(optimization.targetId || optimization.targetName),
    getApprovalActionSignature(optimization),
  ].join('|');
}

function parseTimestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function getLifecycleStatus(optimization) {
  if (!optimization || optimization.executed) return null;

  if (optimization.approvalStatus === 'pending') return 'pending';
  if (optimization.approvalStatus === 'rejected') return 'rejected';
  if (optimization.approvalStatus === 'expired') return 'expired';

  const result = normalizeText(optimization.executionResult);
  if (result === 'Awaiting Telegram approval') return 'pending';
  if (result.startsWith('Rejected:')) return 'rejected';
  if (result.startsWith('Expired:')) return 'expired';
  if (result === 'Failed to send Telegram approval request') return 'failed_request';

  return null;
}

function getReferenceTimestamp(optimization) {
  return parseTimestamp(
    optimization?.approvalRequestedAt
    || optimization?.timestamp
    || optimization?.requestedAt
    || optimization?.updatedAt
  );
}

function findBlockingEquivalent(existingOptimizations, candidate, now = new Date()) {
  const approvalKey = getApprovalDedupKey(candidate);
  if (!approvalKey) {
    return null;
  }

  const nowMs = now instanceof Date ? now.getTime() : parseTimestamp(now);
  const matches = (Array.isArray(existingOptimizations) ? existingOptimizations : [])
    .filter(optimization => getApprovalDedupKey(optimization) === approvalKey)
    .map(optimization => ({
      optimization,
      lifecycleStatus: getLifecycleStatus(optimization),
      timestampMs: getReferenceTimestamp(optimization),
    }))
    .filter(entry => entry.lifecycleStatus);

  matches.sort((left, right) => right.timestampMs - left.timestampMs);

  for (const entry of matches) {
    const cooldownMs = BLOCKING_COOLDOWNS_MS[entry.lifecycleStatus];
    if (!Number.isFinite(cooldownMs)) {
      return {
        reason: entry.lifecycleStatus,
        optimization: entry.optimization,
      };
    }

    if ((nowMs - entry.timestampMs) <= cooldownMs) {
      return {
        reason: entry.lifecycleStatus,
        optimization: entry.optimization,
      };
    }
  }

  return null;
}

function filterDuplicateApprovalOptimizations(optimizations, existingOptimizations = [], now = new Date()) {
  const accepted = [];
  const suppressed = [];
  const seenKeys = new Set();

  for (const optimization of Array.isArray(optimizations) ? optimizations : []) {
    const approvalKey = getApprovalDedupKey(optimization);
    if (!approvalKey) {
      accepted.push(optimization);
      continue;
    }

    if (seenKeys.has(approvalKey)) {
      suppressed.push({
        optimization,
        reason: 'duplicate-in-scan',
        optimizationId: null,
      });
      continue;
    }

    const blocking = findBlockingEquivalent(existingOptimizations, optimization, now);
    if (blocking) {
      suppressed.push({
        optimization,
        reason: blocking.reason,
        optimizationId: blocking.optimization?.id || null,
      });
      continue;
    }

    seenKeys.add(approvalKey);
    accepted.push(optimization);
  }

  return {
    optimizations: accepted,
    suppressed,
  };
}

module.exports = {
  BLOCKING_COOLDOWNS_MS,
  getApprovalDedupKey,
  getLifecycleStatus,
  findBlockingEquivalent,
  filterDuplicateApprovalOptimizations,
};
