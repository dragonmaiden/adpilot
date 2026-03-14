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
const SYSTEM_WINDOW_HOURS = 24;
const STALE_BACKLOG_HOURS = 18;
const MAX_ACTIVITY_ITEMS = 10;
const MAX_CLUSTER_ITEMS = 60;

const PRIORITY_RANK = Object.freeze({
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
});

const ACTIVITY_STATUS_PRIORITY = Object.freeze({
  executed: 0,
  awaiting_telegram: 1,
  needs_approval: 2,
  expired: 3,
  rejected: 4,
  advisory: 5,
  unknown: 6,
});

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
    hasOpenApprovals: false,
    hasAwaitingTelegram: false,
    hasLatestScanApproval: false,
    latestOpenAt: null,
    firstSeenAt: timestampMs > 0 ? new Date(timestampMs).toISOString() : null,
    lastSeenAt: timestampMs > 0 ? new Date(timestampMs).toISOString() : null,
    latestTimestampMs: timestampMs,
    latestOpenTimestampMs: 0,
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

  if (isOpenApprovalStatus(status)) {
    cluster.hasOpenApprovals = true;
    cluster.hasAwaitingTelegram = cluster.hasAwaitingTelegram || status === 'awaiting_telegram';
    cluster.hasLatestScanApproval = cluster.hasLatestScanApproval || (
      status === 'needs_approval'
      && Number(optimization?.scanId || 0) === Number(latestScanId || 0)
    );
    if (timestampMs >= cluster.latestOpenTimestampMs) {
      cluster.latestOpenTimestampMs = timestampMs;
      cluster.latestOpenAt = timestampMs > 0 ? new Date(timestampMs).toISOString() : cluster.latestOpenAt;
    }
  }
}

function finalizeCluster(cluster, nowMs) {
  const latestOptimization = cluster.latestOptimization || {};
  const recentLatestOptimization = cluster.recentLatestOptimization || latestOptimization;
  const openCount = (cluster.statusCounts.needs_approval || 0) + (cluster.statusCounts.awaiting_telegram || 0);
  const recentOpenCount = (cluster.recentStatusCounts.needs_approval || 0) + (cluster.recentStatusCounts.awaiting_telegram || 0);
  const backlogAgeHours = cluster.latestOpenTimestampMs > 0
    ? Math.round(((nowMs - cluster.latestOpenTimestampMs) / (60 * 60 * 1000)) * 10) / 10
    : null;

  return {
    key: cluster.key,
    type: cluster.type,
    level: cluster.level,
    targetId: cluster.targetId,
    targetName: cluster.targetName,
    direction: cluster.direction,
    priority: cluster.priority,
    currentStatus: cluster.hasAwaitingTelegram
      ? 'awaiting_telegram'
      : (cluster.hasOpenApprovals ? 'needs_approval' : cluster.latestStatus),
    action: latestOptimization.action ?? '',
    reason: latestOptimization.reason ?? '',
    impact: latestOptimization.impact ?? '',
    executionResult: latestOptimization.executionResult ?? null,
    latestOptimizationId: latestOptimization.id ?? '',
    count: cluster.count,
    recentCount: cluster.recentCount,
    statusCounts: cluster.statusCounts,
    recentStatusCounts: cluster.recentStatusCounts,
    firstSeenAt: cluster.firstSeenAt,
    lastSeenAt: cluster.lastSeenAt,
    latestOpenAt: cluster.latestOpenAt,
    latestScanId: cluster.latestScanId,
    openCount,
    recentOpenCount,
    hasOpenApprovals: cluster.hasOpenApprovals,
    hasAwaitingTelegram: cluster.hasAwaitingTelegram,
    hasLatestScanApproval: cluster.hasLatestScanApproval,
    stale: cluster.hasOpenApprovals && backlogAgeHours !== null && backlogAgeHours >= STALE_BACKLOG_HOURS,
    backlogAgeHours,
    latestStatus: cluster.latestStatus,
    latestRecentStatus: getOptimizationStatus(recentLatestOptimization),
    latestRecentAt: cluster.latestRecentTimestampMs > 0 ? new Date(cluster.latestRecentTimestampMs).toISOString() : null,
  };
}

function sortClusters(left, right) {
  if (left.hasOpenApprovals !== right.hasOpenApprovals) {
    return left.hasOpenApprovals ? -1 : 1;
  }

  if (left.stale !== right.stale) {
    return left.stale ? -1 : 1;
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
  const latestStatus = cluster.latestRecentStatus || cluster.currentStatus;

  if (counts.executed > 0) return counts.executed > 1 ? 'Multiple executions landed' : 'Optimization executed';
  if (latestStatus === 'awaiting_telegram') return counts.awaiting_telegram > 1 ? 'Approval requests resurfaced' : 'Approval awaiting reply';
  if (latestStatus === 'needs_approval') return cluster.recentCount > 1 ? 'Recommendation resurfaced' : 'New recommendation';
  if (latestStatus === 'expired') return counts.expired > 1 ? 'Approvals expired repeatedly' : 'Approval expired';
  if (latestStatus === 'rejected') return counts.rejected > 1 ? 'Approvals were rejected' : 'Approval rejected';
  return cluster.recentCount > 1 ? 'Recommendation repeated' : 'Recommendation logged';
}

function buildActivitySummary(cluster) {
  const counts = cluster.recentStatusCounts || {};
  const parts = [];

  if (cluster.recentCount > 1) {
    parts.push(`Seen ${cluster.recentCount} times in ${WINDOW_HOURS}h`);
  }
  if (counts.needs_approval > 0) {
    parts.push(`${counts.needs_approval} open`);
  }
  if (counts.awaiting_telegram > 0) {
    parts.push(`${counts.awaiting_telegram} awaiting reply`);
  }
  if (counts.expired > 0) {
    parts.push(`${counts.expired} expired`);
  }
  if (counts.rejected > 0) {
    parts.push(`${counts.rejected} rejected`);
  }
  if (counts.executed > 0) {
    parts.push(`${counts.executed} executed`);
  }

  return parts.join(' · ');
}

function shouldIncludeInActivity(cluster) {
  const counts = cluster.recentStatusCounts || {};
  const hasNonAdvisory = [
    counts.needs_approval,
    counts.awaiting_telegram,
    counts.executed,
    counts.expired,
    counts.rejected,
  ].some(Boolean);

  if (hasNonAdvisory) {
    return true;
  }

  const priorityRank = getPriorityRank(cluster.priority);
  return priorityRank <= PRIORITY_RANK.high && cluster.recentCount <= 2;
}

function buildActivityEntries(clusters) {
  return clusters
    .filter(cluster => cluster.recentCount > 0)
    .filter(shouldIncludeInActivity)
    .map(cluster => ({
      id: `activity:${cluster.key}`,
      clusterKey: cluster.key,
      kind: cluster.latestRecentStatus || cluster.currentStatus,
      title: buildActivityTitle(cluster),
      targetName: cluster.targetName,
      action: cluster.action,
      detail: buildActivitySummary(cluster),
      timestamp: cluster.latestRecentAt || cluster.lastSeenAt,
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
    itemCount: queue.reduce((sum, cluster) => sum + cluster.openCount, 0),
  };
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
    .map(cluster => finalizeCluster(cluster, nowMs))
    .sort(sortClusters);

  const immediateQueue = clusters.filter(cluster => cluster.hasAwaitingTelegram || cluster.hasLatestScanApproval);
  const immediateKeys = new Set(immediateQueue.map(cluster => cluster.key));
  const backlog = clusters.filter(cluster => cluster.hasOpenApprovals && !immediateKeys.has(cluster.key));
  const activity = buildActivityEntries(clusters);
  const decisionMarkers = buildDecisionMarkers(activity);
  const systemChatter = buildSystemChatter(scans, nowMs, systemWindowMs);
  const qualityState = buildQualityState(qualityResponse.summary || {}, optimizations.length, clusters.length);
  const queueSummary = summarizeQueue(immediateQueue);
  const backlogSummary = summarizeQueue(backlog);

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
      openBacklogFamilies: backlogSummary.familyCount,
      openBacklogItems: backlogSummary.itemCount,
      awaitingTelegram: immediateQueue.filter(cluster => cluster.hasAwaitingTelegram).length,
      staleBacklogFamilies: backlog.filter(cluster => cluster.stale).length,
    },
    quality: {
      ...qualityState,
      summary: qualityResponse.summary || {},
    },
    systemChatter,
    queue: {
      immediate: immediateQueue,
      backlog,
    },
    activity,
    decisionMarkers,
    clusters: clusters.slice(0, MAX_CLUSTER_ITEMS),
  });
}

module.exports = {
  getAiOperationsResponse,
};
