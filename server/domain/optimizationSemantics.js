const OPTIMIZATION_TYPES = Object.freeze({
  BUDGET: 'budget',
  BID: 'bid',
  CREATIVE: 'creative',
  STATUS: 'status',
  SCHEDULE: 'schedule',
  TARGETING: 'targeting',
});

const APPROVAL_REQUIRED_TYPES = new Set([
  OPTIMIZATION_TYPES.BUDGET,
  OPTIMIZATION_TYPES.BID,
  OPTIMIZATION_TYPES.STATUS,
]);

const ACTION_PATTERNS = {
  budgetIncrease: [/\bIncrease\b/i, /\bscale\b/i],
  budgetDecrease: [/\bReduce\b/i, /\bReallocate\b/i],
  pause: [/\bPause\b/i],
  resume: [/\bResume\b/i],
};

function matchesAction(actionText, patterns) {
  return patterns.some(pattern => pattern.test(actionText || ''));
}

function isBudgetIncreaseAction(actionText) {
  return matchesAction(actionText, ACTION_PATTERNS.budgetIncrease);
}

function isBudgetDecreaseAction(actionText) {
  return matchesAction(actionText, ACTION_PATTERNS.budgetDecrease);
}

function isReallocationAction(actionText) {
  return /\bReallocate\b/i.test(String(actionText || ''));
}

function isPauseAction(actionText) {
  return matchesAction(actionText, ACTION_PATTERNS.pause);
}

function isResumeAction(actionText) {
  return matchesAction(actionText, ACTION_PATTERNS.resume);
}

function getOptimizationDirection(actionText) {
  if (isBudgetIncreaseAction(actionText) || isResumeAction(actionText)) {
    return 'up';
  }
  if (isBudgetDecreaseAction(actionText) || isPauseAction(actionText)) {
    return 'down';
  }
  return 'neutral';
}

function requiresApproval(action) {
  return !!action && APPROVAL_REQUIRED_TYPES.has(action.type);
}

function isExecutableOptimization(action) {
  if (!action || !action.type) return false;

  if (action.type === OPTIMIZATION_TYPES.STATUS) {
    return ['campaign', 'adset', 'ad'].includes(action.level);
  }

  if (action.type === OPTIMIZATION_TYPES.BUDGET) {
    if (isReallocationAction(action.action)) {
      return false;
    }
    return ['campaign', 'adset'].includes(action.level);
  }

  if (action.type === OPTIMIZATION_TYPES.BID) {
    return action.level === 'adset';
  }

  return false;
}

function normalizeResult(value) {
  return String(value || '').trim();
}

function hasFailurePrefix(result) {
  return result.startsWith('Failed:');
}

function getOptimizationStatus(action) {
  if (!action) return 'unknown';
  const result = normalizeResult(action.executionResult);
  if (action.executed) return 'executed';
  if (action.approvalStatus === 'pending') return 'awaiting_telegram';
  if (action.approvalStatus === 'rejected') return 'rejected';
  if (action.approvalStatus === 'expired') return 'expired';
  if (result === 'Failed to send Telegram approval request' || result.startsWith('Approval flow failed:')) {
    return 'delivery_failed';
  }
  if (action.approvalStatus === 'approved' && !action.executed && hasFailurePrefix(result)) {
    return 'execution_failed';
  }
  if (requiresApproval(action) && isExecutableOptimization(action)) return 'needs_approval';
  return 'advisory';
}

function isOpenApprovalStatus(status) {
  return status === 'needs_approval' || status === 'awaiting_telegram';
}

function isOpenApproval(action) {
  return isOpenApprovalStatus(getOptimizationStatus(action));
}

module.exports = {
  OPTIMIZATION_TYPES,
  APPROVAL_REQUIRED_TYPES,
  isBudgetIncreaseAction,
  isBudgetDecreaseAction,
  isReallocationAction,
  isPauseAction,
  isResumeAction,
  getOptimizationDirection,
  requiresApproval,
  isExecutableOptimization,
  getOptimizationStatus,
  isOpenApprovalStatus,
  isOpenApproval,
};
