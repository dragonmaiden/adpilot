const {
  getOptimizationDirection,
  isExecutableOptimization,
  isPauseAction,
  requiresApproval,
} = require('../domain/optimizationSemantics');

const PRIORITY_SCORES = Object.freeze({
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
});

function getEntityKey(optimization) {
  return `${optimization?.level || 'unknown'}:${optimization?.targetId || optimization?.targetName || 'unknown'}`;
}

function getParentKeys(optimization, hierarchy) {
  if (!optimization?.targetId) return [];

  if (optimization.level === 'adset') {
    const adSet = hierarchy.adSets.get(optimization.targetId);
    return adSet?.campaignId ? [`campaign:${adSet.campaignId}`] : [];
  }

  if (optimization.level === 'ad') {
    const ad = hierarchy.ads.get(optimization.targetId);
    const parentKeys = [];
    if (ad?.adSetId) parentKeys.push(`adset:${ad.adSetId}`);
    if (ad?.campaignId) parentKeys.push(`campaign:${ad.campaignId}`);
    return parentKeys;
  }

  return [];
}

function buildHierarchy(metaStructure = {}) {
  const adSets = new Map();
  const ads = new Map();

  for (const adSet of Array.isArray(metaStructure.adSets) ? metaStructure.adSets : []) {
    adSets.set(String(adSet.id), {
      campaignId: adSet.campaign_id ? String(adSet.campaign_id) : null,
    });
  }

  for (const ad of Array.isArray(metaStructure.ads) ? metaStructure.ads : []) {
    ads.set(String(ad.id), {
      adSetId: ad.adset_id ? String(ad.adset_id) : null,
      campaignId: ad.campaign_id ? String(ad.campaign_id) : null,
    });
  }

  return { adSets, ads };
}

function getActionScore(optimization) {
  if (!optimization) return 0;
  if (optimization.type === 'status' && isPauseAction(optimization.action)) return 100;
  if (optimization.type === 'status') return 90;

  const direction = getOptimizationDirection(optimization.action);
  if (optimization.type === 'budget' && direction === 'down') return 80;
  if (optimization.type === 'budget' && direction === 'up') return 60;
  return 10;
}

function compareOptimizations(left, right) {
  const leftActionScore = getActionScore(left);
  const rightActionScore = getActionScore(right);
  if (leftActionScore !== rightActionScore) return rightActionScore - leftActionScore;

  const leftPriorityScore = PRIORITY_SCORES[left?.priority] || 0;
  const rightPriorityScore = PRIORITY_SCORES[right?.priority] || 0;
  if (leftPriorityScore !== rightPriorityScore) return rightPriorityScore - leftPriorityScore;

  const leftTimestamp = new Date(left?.timestamp || 0).getTime();
  const rightTimestamp = new Date(right?.timestamp || 0).getTime();
  return leftTimestamp - rightTimestamp;
}

function selectWinningExecutable(group) {
  return group.slice().sort(compareOptimizations)[0] || null;
}

function arbitrateOptimizations(optimizations, metaStructure = {}) {
  const hierarchy = buildHierarchy(metaStructure);
  const accepted = [];
  const suppressed = [];
  const executableByEntity = new Map();

  for (const optimization of Array.isArray(optimizations) ? optimizations : []) {
    if (requiresApproval(optimization) && isExecutableOptimization(optimization)) {
      const entityKey = getEntityKey(optimization);
      const group = executableByEntity.get(entityKey) || [];
      group.push(optimization);
      executableByEntity.set(entityKey, group);
      continue;
    }

    accepted.push(optimization);
  }

  const acceptedExecutable = new Map();
  const parentPauseKeys = new Set();

  for (const [entityKey, group] of executableByEntity.entries()) {
    const winner = selectWinningExecutable(group);
    if (!winner) continue;

    acceptedExecutable.set(entityKey, winner);
    if (winner.type === 'status' && isPauseAction(winner.action)) {
      parentPauseKeys.add(entityKey);
    }

    for (const optimization of group) {
      if (optimization.id === winner.id) continue;
      suppressed.push({
        optimization,
        reason: 'same-target-dominated',
        optimizationId: winner.id,
      });
    }
  }

  for (const [entityKey, optimization] of acceptedExecutable.entries()) {
    const parentKeys = getParentKeys(optimization, hierarchy);
    const suppressedByParent = parentKeys.find(key => parentPauseKeys.has(key));
    if (suppressedByParent) {
      suppressed.push({
        optimization,
        reason: 'parent-paused',
        optimizationId: acceptedExecutable.get(suppressedByParent)?.id || null,
      });
      continue;
    }

    accepted.push(optimization);
  }

  accepted.sort((left, right) => new Date(left.timestamp || 0).getTime() - new Date(right.timestamp || 0).getTime());
  return {
    optimizations: accepted,
    suppressed,
  };
}

module.exports = {
  arbitrateOptimizations,
};
