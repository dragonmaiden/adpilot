const scheduler = require('../modules/scheduler');
const contracts = require('../contracts/v1');
const recommendationQualityService = require('./recommendationQualityService');
const {
  getOptimizationDirection,
  getOptimizationStatus,
  isOpenApprovalStatus,
} = require('../domain/optimizationSemantics');
const {
  getApprovalDedupKey,
} = require('./optimizationDedupService');

const WINDOW_HOURS = 72;
const FLOW_WINDOW_HOURS = 24;
const SYSTEM_WINDOW_HOURS = 24;
const ACTION_WINDOW_HOURS = 6;
const STALE_RECOMMENDATION_HOURS = 18;
const AWAITING_REPLY_GRACE_MS = 20 * 60 * 1000;
const MAX_ACTIVITY_ITEMS = 10;
const MAX_CLUSTER_ITEMS = 60;

const PRIORITY_RANK = Object.freeze({
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
});

const ACTIVITY_STATUS_PRIORITY = Object.freeze({
  action_now: 0,
  awaiting_reply: 1,
  fix_inputs: 2,
  hold: 3,
  portfolio_guidance: 4,
  cleanup: 5,
  research: 6,
  resolved: 7,
  archived: 8,
  unknown: 9,
});

const FIX_INPUT_DECISION_KINDS = new Set([
  'freeze_due_to_low_trust',
  'fix_measurement_inputs',
  'fix_creative_inputs',
]);

const HOLD_DECISION_KINDS = new Set([
  'hold_budget',
]);

const PORTFOLIO_GUIDANCE_DECISION_KINDS = new Set([
  'reallocate_budget',
  'portfolio_scale',
  'portfolio_reduce',
]);

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function parseTimestamp(value) {
  const timestampMs = new Date(value || 0).getTime();
  return Number.isFinite(timestampMs) ? timestampMs : 0;
}

function getReferenceTimestamp(optimization) {
  return parseTimestamp(
    optimization?.approvalRequestedAt
    || optimization?.timestamp
    || optimization?.requestedAt
    || optimization?.updatedAt
  );
}

function isRecentTimestamp(timestampMs, nowMs, windowMs) {
  return timestampMs > 0 && (nowMs - timestampMs) <= windowMs;
}

function canonicalizeActionText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/₩[\d,]+(?:\.\d+)?/g, '₩x')
    .replace(/\$[\d,]+(?:\.\d+)?/g, '$x')
    .replace(/\b\d+(?:\.\d+)?x\b/g, 'x')
    .replace(/\b\d+(?:\.\d+)?%\b/g, 'x%')
    .replace(/\b\d+(?:\.\d+)?\b/g, 'n');
}

function getClusterKey(optimization) {
  const approvalKey = getApprovalDedupKey(optimization);
  if (approvalKey) {
    return `approval|${approvalKey}`;
  }

  return [
    normalizeText(optimization?.type),
    normalizeText(optimization?.level),
    normalizeText(optimization?.targetId || optimization?.targetName),
    canonicalizeActionText(optimization?.action || optimization?.reason),
  ].join('|');
}

function getPriorityRank(priority) {
  return PRIORITY_RANK[String(priority || 'low').toLowerCase()] ?? PRIORITY_RANK.low;
}

function comparePriority(left, right) {
  return getPriorityRank(left) - getPriorityRank(right);
}

function getActivityStatusRank(status) {
  return ACTIVITY_STATUS_PRIORITY[String(status || 'unknown').toLowerCase()] ?? ACTIVITY_STATUS_PRIORITY.unknown;
}

function getLatestScanId(scans, optimizations) {
  const fromScans = (Array.isArray(scans) ? scans : []).reduce((max, scan) => {
    const scanId = Number(scan?.scanId || 0);
    return scanId > max ? scanId : max;
  }, 0);

  return (Array.isArray(optimizations) ? optimizations : []).reduce((max, optimization) => {
    const scanId = Number(optimization?.scanId || 0);
    return scanId > max ? scanId : max;
  }, fromScans);
}

function isLatestScanCluster(cluster, latestScanId) {
  return Number(cluster?.latestScanId || 0) === Number(latestScanId || 0);
}

function getDecisionKind(optimization = {}) {
  return String(optimization?.decisionKind || '').trim().toLowerCase();
}

function getDecisionDomain(optimization = {}) {
  return String(optimization?.decisionDomain || '').trim().toLowerCase();
}

function getAdvisoryOwnerState(optimization, latestScan, ageHours) {
  const decisionKind = getDecisionKind(optimization);
  const decisionDomain = getDecisionDomain(optimization);
  const actionText = normalizeText(optimization?.action).toLowerCase();

  if (
    FIX_INPUT_DECISION_KINDS.has(decisionKind)
    || decisionDomain === 'measurement_trust'
    || decisionDomain === 'creative_inputs'
    || actionText.startsWith('freeze budget changes')
    || actionText.includes('stronger creative inputs')
  ) {
    return {
      state: 'fix_inputs',
      actionableNow: false,
      queueBucket: 'fix_inputs',
      reason: 'Inputs or trust need work before another budget decision',
      ageHours,
    };
  }

  if (HOLD_DECISION_KINDS.has(decisionKind) || actionText.startsWith('hold budget')) {
    return {
      state: 'hold',
      actionableNow: false,
      queueBucket: 'hold',
      reason: 'Meta should keep delivering unchanged for now',
      ageHours,
    };
  }

  if (
    PORTFOLIO_GUIDANCE_DECISION_KINDS.has(decisionKind)
    || decisionDomain === 'portfolio_guardrails'
    || decisionDomain === 'portfolio_allocation'
  ) {
    return {
      state: 'portfolio_guidance',
      actionableNow: false,
      queueBucket: 'portfolio_guidance',
      reason: 'Portfolio-level budget guidance is available for the next planning pass',
      ageHours,
    };
  }

  if (latestScan) {
    return {
      state: 'research',
      actionableNow: false,
      queueBucket: 'research',
      reason: 'Fresh advisory context is available for audit, not approval',
      ageHours,
    };
  }

  return {
    state: 'archived',
    actionableNow: false,
    queueBucket: 'archive',
    reason: 'Older advisory signal archived from the default owner view',
    ageHours,
  };
}

function ownerStateForCluster(cluster, nowMs, latestScanId) {
  const ageMs = cluster.latestTimestampMs > 0 ? Math.max(0, nowMs - cluster.latestTimestampMs) : Number.POSITIVE_INFINITY;
  const ageHours = Number.isFinite(ageMs)
    ? Math.round((ageMs / (60 * 60 * 1000)) * 10) / 10
    : null;
  const latestStatus = cluster.latestStatus;
  const latestScan = isLatestScanCluster(cluster, latestScanId);
  const withinFlowWindow = isRecentTimestamp(cluster.latestTimestampMs, nowMs, FLOW_WINDOW_HOURS * 60 * 60 * 1000);
  const withinActionWindow = isRecentTimestamp(cluster.latestTimestampMs, nowMs, ACTION_WINDOW_HOURS * 60 * 60 * 1000);
  const withinStaleWindow = isRecentTimestamp(cluster.latestTimestampMs, nowMs, STALE_RECOMMENDATION_HOURS * 60 * 60 * 1000);

  if (latestStatus === 'awaiting_telegram') {
    if (ageMs <= AWAITING_REPLY_GRACE_MS) {
      return {
        state: 'awaiting_reply',
        actionableNow: true,
        queueBucket: 'immediate',
        reason: 'Telegram approval is still within the active reply window',
        ageHours,
      };
    }

    return {
      state: 'cleanup',
      actionableNow: false,
      queueBucket: 'cleanup',
      reason: 'Telegram reply window looks stale; resend or rerun instead of treating this as still pending',
      ageHours,
    };
  }

  if (latestStatus === 'delivery_failed') {
    return {
      state: 'cleanup',
      actionableNow: false,
      queueBucket: 'cleanup',
      reason: 'Approval delivery failed; this should not appear as an open approval',
      ageHours,
    };
  }

  if (latestStatus === 'execution_failed') {
    return {
      state: 'cleanup',
      actionableNow: false,
      queueBucket: 'cleanup',
      reason: 'Approval completed but execution failed on the downstream platform',
      ageHours,
    };
  }

  if (latestStatus === 'needs_approval') {
    if (latestScan && withinActionWindow) {
      return {
        state: 'action_now',
        actionableNow: true,
        queueBucket: 'immediate',
        reason: 'Latest-scan executable recommendation is still inside the active review window',
        ageHours,
      };
    }

    if (withinStaleWindow) {
      return {
        state: 'cleanup',
        actionableNow: false,
        queueBucket: 'cleanup',
        reason: latestScan
          ? 'Review window has gone stale; rerun before asking for approval again'
          : 'Older recommendation was not refreshed in the latest scan',
        ageHours,
      };
    }

    return {
      state: 'archived',
      actionableNow: false,
      queueBucket: 'archive',
      reason: 'Older unresolved recommendation has been archived until a fresh scan resurfaces it',
      ageHours,
    };
  }

  if (latestStatus === 'advisory') {
    if (withinFlowWindow) {
      return getAdvisoryOwnerState(cluster.latestOptimization || {}, latestScan, ageHours);
    }

    return {
      state: 'archived',
      actionableNow: false,
      queueBucket: 'archive',
      reason: 'Older advisory signal archived out of the owner view',
      ageHours,
    };
  }

  if (['executed', 'expired', 'rejected'].includes(latestStatus)) {
    if (withinFlowWindow) {
      return {
        state: 'resolved',
        actionableNow: false,
        queueBucket: 'resolved',
        reason: 'Recent lifecycle update already resolved this family',
        ageHours,
      };
    }

    return {
      state: 'archived',
      actionableNow: false,
      queueBucket: 'archive',
      reason: 'Resolved history is archived after the recent review window',
      ageHours,
    };
  }

  return {
    state: withinFlowWindow ? 'research' : 'archived',
    actionableNow: false,
    queueBucket: withinFlowWindow ? 'research' : 'archive',
    reason: withinFlowWindow
      ? 'Recent signal is available for audit'
      : 'Older family archived from the default owner view',
    ageHours,
  };
}

function createCluster(optimization) {
  const timestampMs = getReferenceTimestamp(optimization);
  const status = getOptimizationStatus(optimization);
  return {
    key: getClusterKey(optimization),
    type: optimization?.type ?? '',
    level: optimization?.level ?? '',
    targetId: optimization?.targetId ?? '',
    targetName: optimization?.targetName ?? '',
    direction: getOptimizationDirection(optimization?.action),
    priority: optimization?.priority ?? 'low',
    statusCounts: {},
    recentStatusCounts: {},
    count: 0,
    recentCount: 0,
    firstSeenAt: timestampMs > 0 ? new Date(timestampMs).toISOString() : null,
    lastSeenAt: timestampMs > 0 ? new Date(timestampMs).toISOString() : null,
    latestTimestampMs: timestampMs,
    latestRecentTimestampMs: 0,
    latestScanId: optimization?.scanId ?? null,
    latestStatus: status,
    latestOptimization: optimization,
    recentLatestOptimization: null,
    highestPriorityOptimization: optimization,
  };
}

function incrementCounter(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function updateCluster(cluster, optimization, nowMs, windowMs, latestScanId) {
  const timestampMs = getReferenceTimestamp(optimization);
  const status = getOptimizationStatus(optimization);
  const recent = isRecentTimestamp(timestampMs, nowMs, windowMs);
  void latestScanId;

  cluster.count += 1;
  incrementCounter(cluster.statusCounts, status);

  if (recent) {
    cluster.recentCount += 1;
    incrementCounter(cluster.recentStatusCounts, status);
    if (!cluster.recentLatestOptimization || timestampMs >= cluster.latestRecentTimestampMs) {
      cluster.recentLatestOptimization = optimization;
      cluster.latestRecentTimestampMs = timestampMs;
    }
  }

  if (!cluster.firstSeenAt || (timestampMs > 0 && timestampMs < parseTimestamp(cluster.firstSeenAt))) {
    cluster.firstSeenAt = timestampMs > 0 ? new Date(timestampMs).toISOString() : cluster.firstSeenAt;
  }

  if (!cluster.lastSeenAt || timestampMs >= cluster.latestTimestampMs) {
    cluster.lastSeenAt = timestampMs > 0 ? new Date(timestampMs).toISOString() : cluster.lastSeenAt;
    cluster.latestTimestampMs = timestampMs;
    cluster.latestOptimization = optimization;
    cluster.latestStatus = status;
    cluster.latestScanId = optimization?.scanId ?? cluster.latestScanId;
    cluster.direction = getOptimizationDirection(optimization?.action);
  }

  if (comparePriority(optimization?.priority, cluster.highestPriorityOptimization?.priority) < 0) {
    cluster.highestPriorityOptimization = optimization;
    cluster.priority = optimization?.priority ?? cluster.priority;
  }
}

function finalizeCluster(cluster, nowMs, latestScanId) {
  const latestOptimization = cluster.latestOptimization || {};
  const recentLatestOptimization = cluster.recentLatestOptimization || latestOptimization;
  const ownerState = ownerStateForCluster(cluster, nowMs, latestScanId);
  const latestStatus = cluster.latestStatus;
  const hasOpenApprovals = isOpenApprovalStatus(latestStatus);
  const hasAwaitingTelegram = latestStatus === 'awaiting_telegram';
  const hasLatestScanApproval = latestStatus === 'needs_approval' && isLatestScanCluster(cluster, latestScanId);
  const historicalOpenCount = (cluster.statusCounts.needs_approval || 0) + (cluster.statusCounts.awaiting_telegram || 0);
  const recentOpenCount = (cluster.recentStatusCounts.needs_approval || 0) + (cluster.recentStatusCounts.awaiting_telegram || 0);
  const openCount = ownerState.actionableNow ? 1 : 0;

  return {
    key: cluster.key,
    type: cluster.type,
    level: cluster.level,
    targetId: cluster.targetId,
    targetName: cluster.targetName,
    direction: cluster.direction,
    priority: cluster.priority,
    currentStatus: ownerState.state,
    action: latestOptimization.action ?? '',
    reason: latestOptimization.reason ?? '',
    impact: latestOptimization.impact ?? '',
    decisionKind: latestOptimization.decisionKind ?? null,
    decisionDomain: latestOptimization.decisionDomain ?? null,
    executionResult: latestOptimization.executionResult ?? null,
    latestOptimizationId: latestOptimization.id ?? '',
    count: cluster.count,
    recentCount: cluster.recentCount,
    statusCounts: cluster.statusCounts,
    recentStatusCounts: cluster.recentStatusCounts,
    firstSeenAt: cluster.firstSeenAt,
    lastSeenAt: cluster.lastSeenAt,
    latestOpenAt: hasOpenApprovals ? cluster.lastSeenAt : null,
    latestScanId: cluster.latestScanId,
    openCount,
    historicalOpenCount,
    recentOpenCount,
    hasOpenApprovals,
    hasAwaitingTelegram,
    hasLatestScanApproval,
    actionableNow: ownerState.actionableNow,
    queueBucket: ownerState.queueBucket,
    stateReason: ownerState.reason,
    stale: ownerState.state === 'cleanup' && latestStatus === 'needs_approval',
    backlogAgeHours: ownerState.ageHours,
    latestStatus,
    latestRecentStatus: getOptimizationStatus(recentLatestOptimization),
    latestRecentAt: cluster.latestRecentTimestampMs > 0 ? new Date(cluster.latestRecentTimestampMs).toISOString() : null,
    latestTimestampMs: cluster.latestTimestampMs,
  };
}

function sortClusters(left, right) {
  const stateDiff = getActivityStatusRank(left.currentStatus) - getActivityStatusRank(right.currentStatus);
  if (stateDiff !== 0) {
    return stateDiff;
  }

  const priorityDiff = comparePriority(left.priority, right.priority);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  if (left.count !== right.count) {
    return right.count - left.count;
  }

  return String(right.lastSeenAt || '').localeCompare(String(left.lastSeenAt || ''));
}

function buildActivityTitle(cluster) {
  const counts = cluster.recentStatusCounts || {};
  const currentStatus = cluster.currentStatus;

  if (currentStatus === 'action_now') return cluster.recentCount > 1 ? 'Decision resurfaced in latest scans' : 'Decision needed now';
  if (currentStatus === 'awaiting_reply') return 'Waiting for Telegram reply';
  if (currentStatus === 'fix_inputs') return cluster.recentCount > 1 ? 'Input fix repeated' : 'Fix inputs before the next budget change';
  if (currentStatus === 'hold') return 'Hold and let Meta continue';
  if (currentStatus === 'portfolio_guidance') {
    return cluster.recentCount > 1 ? 'Portfolio guidance repeated' : 'Portfolio guidance ready';
  }
  if (currentStatus === 'cleanup') {
    if (cluster.latestStatus === 'delivery_failed') return 'Approval delivery failed';
    if (cluster.latestStatus === 'execution_failed') return 'Execution failed after approval';
    return 'Cleanup needed';
  }
  if (currentStatus === 'research') return cluster.recentCount > 1 ? 'Advisory context repeated' : 'Fresh advisory context';
  if (currentStatus === 'resolved') {
    if (counts.executed > 0) return counts.executed > 1 ? 'Multiple executions landed' : 'Optimization executed';
    if (cluster.latestStatus === 'expired') return counts.expired > 1 ? 'Approvals expired repeatedly' : 'Approval expired';
    if (cluster.latestStatus === 'rejected') return counts.rejected > 1 ? 'Approvals were rejected' : 'Approval rejected';
    return 'Decision resolved';
  }
  return 'Archived decision';
}

function buildActivitySummary(cluster) {
  const counts = cluster.recentStatusCounts || {};
  const parts = [];

  if (cluster.recentCount > 1) {
    parts.push(`Seen ${cluster.recentCount} times in ${WINDOW_HOURS}h`);
  }
  if (cluster.stateReason) parts.push(cluster.stateReason);
  if (counts.expired > 0) parts.push(`${counts.expired} expired`);
  if (counts.rejected > 0) parts.push(`${counts.rejected} rejected`);
  if (counts.executed > 0) parts.push(`${counts.executed} executed`);
  if (counts.delivery_failed > 0) parts.push(`${counts.delivery_failed} delivery failure`);
  if (counts.execution_failed > 0) parts.push(`${counts.execution_failed} execution failure`);

  return parts.join(' · ');
}

function shouldIncludeInActivity(cluster, nowMs) {
  if (!isRecentTimestamp(cluster.latestTimestampMs, nowMs, FLOW_WINDOW_HOURS * 60 * 60 * 1000)) {
    return false;
  }

  if (['action_now', 'awaiting_reply', 'fix_inputs', 'hold', 'portfolio_guidance', 'cleanup', 'resolved'].includes(cluster.currentStatus)) {
    return true;
  }

  return cluster.currentStatus === 'research' && getPriorityRank(cluster.priority) <= PRIORITY_RANK.high;
}

function buildActivityEntries(clusters, nowMs) {
  return clusters
    .filter(cluster => shouldIncludeInActivity(cluster, nowMs))
    .map(cluster => ({
      id: `activity:${cluster.key}`,
      clusterKey: cluster.key,
      kind: cluster.currentStatus,
      title: buildActivityTitle(cluster),
      targetName: cluster.targetName,
      action: cluster.action,
      detail: buildActivitySummary(cluster),
      timestamp: cluster.lastSeenAt,
      priority: cluster.priority,
      count: cluster.recentCount,
    }))
    .sort((left, right) => {
      const statusDiff = getActivityStatusRank(left.kind) - getActivityStatusRank(right.kind);
      if (statusDiff !== 0) {
        return statusDiff;
      }
      const priorityDiff = comparePriority(left.priority, right.priority);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return String(right.timestamp || '').localeCompare(String(left.timestamp || ''));
    })
    .slice(0, MAX_ACTIVITY_ITEMS);
}

function buildSystemChatter(scans, nowMs, windowMs) {
  const recentScans = (Array.isArray(scans) ? scans : [])
    .filter(scan => isRecentTimestamp(parseTimestamp(scan?.time), nowMs, windowMs))
    .sort((left, right) => String(right?.time || '').localeCompare(String(left?.time || '')));

  const scanCount = recentScans.length;
  const scansWithSuggestions = recentScans.filter(scan => Number(scan?.optimizations || 0) > 0).length;
  const quietScans = recentScans.filter(scan => Number(scan?.optimizations || 0) === 0).length;
  const scansWithErrors = recentScans.filter(scan => Number(scan?.errors || 0) > 0).length;
  const totalOptimizations = recentScans.reduce((sum, scan) => sum + Number(scan?.optimizations || 0), 0);
  const lastScan = recentScans[0] || null;

  return {
    windowHours: SYSTEM_WINDOW_HOURS,
    scanCount,
    scansWithSuggestions,
    quietScans,
    scansWithErrors,
    avgOptimizationsPerScan: scanCount > 0 ? Math.round((totalOptimizations / scanCount) * 10) / 10 : 0,
    lastScanAt: lastScan?.time || null,
    lastScanOptimizations: Number(lastScan?.optimizations || 0),
    lastScanErrors: Number(lastScan?.errors || 0),
  };
}

function buildQualityState(summary, rawCount, clusterCount) {
  const issues = [
    summary.failedApprovalRequests > 0 ? 2 : 0,
    summary.staleHighPriorityAlerts > 0 ? 2 : 0,
    summary.duplicateApprovalClusters > 0 ? 1 : 0,
    summary.expiredApprovals >= 3 ? 1 : 0,
    rawCount > 0 && clusterCount > 0 && (rawCount / clusterCount) >= 10 ? 1 : 0,
  ].reduce((sum, score) => sum + score, 0);

  if (issues >= 4) {
    return {
      level: 'low',
      label: 'Needs tuning',
    };
  }
  if (issues >= 2) {
    return {
      level: 'medium',
      label: 'Mixed quality',
    };
  }
  return {
    level: 'high',
    label: 'Healthy',
  };
}

function buildDecisionMarkers(activity) {
  const grouped = new Map();

  for (const entry of activity) {
    const date = String(entry.timestamp || '').slice(0, 10);
    if (!date) continue;

    const existing = grouped.get(date);
    if (!existing) {
      grouped.set(date, {
        date,
        kind: entry.kind,
        count: 1,
        title: entry.title,
        detail: entry.detail,
      });
      continue;
    }

    existing.count += 1;
    if (getActivityStatusRank(entry.kind) < getActivityStatusRank(existing.kind)) {
      existing.kind = entry.kind;
      existing.title = entry.title;
      existing.detail = entry.detail;
    }
  }

  return Array.from(grouped.values())
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));
}

function summarizeQueue(queue) {
  return {
    familyCount: queue.length,
    itemCount: queue.reduce((sum, cluster) => {
      if (cluster.actionableNow) return sum + (cluster.openCount || 0);
      return sum + 1;
    }, 0),
  };
}

function countByState(clusters, state) {
  return clusters.filter(cluster => cluster.currentStatus === state).length;
}

function getAiOperationsResponse() {
  const nowMs = Date.now();
  const windowMs = WINDOW_HOURS * 60 * 60 * 1000;
  const systemWindowMs = SYSTEM_WINDOW_HOURS * 60 * 60 * 1000;
  const optimizations = (scheduler.getAllOptimizations() || []).slice();
  const scans = (scheduler.getScanHistory() || []).slice();
  const latestScanId = getLatestScanId(scans, optimizations);
  const qualityResponse = recommendationQualityService.getRecommendationQualityResponse();

  const clusterMap = new Map();
  optimizations
    .slice()
    .sort((left, right) => getReferenceTimestamp(left) - getReferenceTimestamp(right))
    .forEach(optimization => {
      const key = getClusterKey(optimization);
      const cluster = clusterMap.get(key) || createCluster(optimization);
      updateCluster(cluster, optimization, nowMs, windowMs, latestScanId);
      clusterMap.set(key, cluster);
    });

  const clusters = Array.from(clusterMap.values())
    .map(cluster => finalizeCluster(cluster, nowMs, latestScanId))
    .sort(sortClusters);

  const immediateQueue = clusters.filter(cluster => ['action_now', 'awaiting_reply'].includes(cluster.currentStatus));
  const fixInputsQueue = clusters.filter(cluster => cluster.currentStatus === 'fix_inputs');
  const holdQueue = clusters.filter(cluster => cluster.currentStatus === 'hold');
  const portfolioGuidanceQueue = clusters.filter(cluster => cluster.currentStatus === 'portfolio_guidance');
  const cleanupQueue = clusters.filter(cluster => cluster.currentStatus === 'cleanup');
  const researchQueue = clusters.filter(cluster => cluster.currentStatus === 'research');
  const visibleClusters = clusters.filter(cluster => cluster.currentStatus !== 'archived');
  const activity = buildActivityEntries(clusters, nowMs);
  const decisionMarkers = buildDecisionMarkers(activity);
  const systemChatter = buildSystemChatter(scans, nowMs, systemWindowMs);
  const qualityState = buildQualityState(qualityResponse.summary || {}, optimizations.length, clusters.length);
  const queueSummary = summarizeQueue(immediateQueue);
  const fixInputsSummary = summarizeQueue(fixInputsQueue);
  const holdSummary = summarizeQueue(holdQueue);
  const portfolioGuidanceSummary = summarizeQueue(portfolioGuidanceQueue);
  const cleanupSummary = summarizeQueue(cleanupQueue);
  const researchSummary = summarizeQueue(researchQueue);
  const resolvedFamilies = countByState(clusters, 'resolved');
  const archivedFamilies = countByState(clusters, 'archived');
  const cleanupFamilies = countByState(clusters, 'cleanup');

  return contracts.aiOperations({
    generatedAt: new Date(nowMs).toISOString(),
    windowHours: WINDOW_HOURS,
    latestScanId,
    summary: {
      rawRecommendationCount: optimizations.length,
      clusterCount: clusters.length,
      compressionRatio: clusters.length > 0 ? Math.round((optimizations.length / clusters.length) * 10) / 10 : 0,
      actionNowFamilies: queueSummary.familyCount,
      actionNowItems: queueSummary.itemCount,
      fixInputFamilies: fixInputsSummary.familyCount,
      fixInputItems: fixInputsSummary.itemCount,
      holdFamilies: holdSummary.familyCount,
      holdItems: holdSummary.itemCount,
      portfolioGuidanceFamilies: portfolioGuidanceSummary.familyCount,
      portfolioGuidanceItems: portfolioGuidanceSummary.itemCount,
      cleanupFamilies,
      cleanupItems: cleanupSummary.itemCount,
      researchFamilies: researchSummary.familyCount,
      resolvedFamilies,
      archivedFamilies,
      awaitingTelegram: countByState(clusters, 'awaiting_reply'),
      blockedFamilies: cleanupFamilies,
      blockedItems: cleanupSummary.itemCount,
      staleBacklogFamilies: cleanupFamilies,
      openBacklogFamilies: cleanupSummary.familyCount,
      openBacklogItems: cleanupSummary.itemCount,
      watchingFamilies: researchSummary.familyCount,
      recentChangeCount: activity.length,
    },
    quality: {
      ...qualityState,
      summary: qualityResponse.summary || {},
    },
    systemChatter,
    queue: {
      immediate: immediateQueue,
      fixInputs: fixInputsQueue,
      hold: holdQueue,
      portfolioGuidance: portfolioGuidanceQueue,
      cleanup: cleanupQueue,
      research: researchQueue,
      backlog: cleanupQueue,
    },
    activity,
    decisionMarkers,
    clusters: visibleClusters.slice(0, MAX_CLUSTER_ITEMS),
  });
}

module.exports = {
  getAiOperationsResponse,
};
