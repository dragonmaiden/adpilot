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

module.exports = {
  OPTIMIZATION_TYPES,
  APPROVAL_REQUIRED_TYPES,
  isBudgetIncreaseAction,
  isBudgetDecreaseAction,
  isPauseAction,
  isResumeAction,
  getOptimizationDirection,
  requiresApproval,
};
