const test = require('node:test');
const assert = require('node:assert/strict');

async function withMockedService(overrides, run) {
  const servicePath = require.resolve('../server/services/aiOperationsService');
  const dependencyEntries = [
    [require.resolve('../server/modules/scheduler'), overrides.scheduler],
    [require.resolve('../server/contracts/v1'), overrides.contracts],
    [require.resolve('../server/services/recommendationQualityService'), overrides.recommendationQualityService],
  ];

  const originalEntries = new Map();
  for (const [dependencyPath, dependencyExports] of dependencyEntries) {
    originalEntries.set(dependencyPath, require.cache[dependencyPath] || null);
    require.cache[dependencyPath] = {
      id: dependencyPath,
      filename: dependencyPath,
      loaded: true,
      exports: dependencyExports,
    };
  }

  const originalService = require.cache[servicePath] || null;
  delete require.cache[servicePath];

  try {
    const service = require(servicePath);
    return await run(service);
  } finally {
    delete require.cache[servicePath];
    if (originalService) {
      require.cache[servicePath] = originalService;
    }

    for (const [dependencyPath] of dependencyEntries) {
      const originalEntry = originalEntries.get(dependencyPath);
      if (originalEntry) {
        require.cache[dependencyPath] = originalEntry;
      } else {
        delete require.cache[dependencyPath];
      }
    }
  }
}

test('ai operations groups raw rows into clusters and separates queue from backlog', async () => {
  const originalDateNow = Date.now;
  Date.now = () => new Date('2026-03-14T08:00:00.000Z').getTime();

  try {
    const optimizations = [
      {
        id: 'opt-immediate',
        type: 'budget',
        level: 'campaign',
        targetId: 'c1',
        targetName: 'Winner',
        action: 'Increase daily budget by $26.00 (20%)',
        priority: 'medium',
        timestamp: '2026-03-14T07:00:00.000Z',
        scanId: 200,
      },
      {
        id: 'opt-backlog-a',
        type: 'budget',
        level: 'campaign',
        targetId: 'c2',
        targetName: 'Older Winner',
        action: 'Increase daily budget by $22.00 (20%)',
        priority: 'medium',
        timestamp: '2026-03-13T08:00:00.000Z',
        scanId: 180,
      },
      {
        id: 'opt-backlog-b',
        type: 'budget',
        level: 'campaign',
        targetId: 'c2',
        targetName: 'Older Winner',
        action: 'Increase daily budget by $24.00 (20%)',
        priority: 'medium',
        timestamp: '2026-03-13T09:00:00.000Z',
        scanId: 181,
      },
      {
        id: 'opt-advisory-a',
        type: 'budget',
        level: 'account',
        targetId: 'account',
        targetName: 'Overall Profitability',
        action: 'True net profit is ₩3,588,529 — room to scale',
        reason: 'Margins are strong',
        impact: 'Consider increasing total ad spend by 10-20%',
        priority: 'medium',
        timestamp: '2026-03-14T06:00:00.000Z',
        scanId: 200,
      },
      {
        id: 'opt-advisory-b',
        type: 'budget',
        level: 'account',
        targetId: 'account',
        targetName: 'Overall Profitability',
        action: 'True net profit is ₩3,588,485 — room to scale',
        reason: 'Margins are strong',
        impact: 'Consider increasing total ad spend by 10-20%',
        priority: 'medium',
        timestamp: '2026-03-14T05:00:00.000Z',
        scanId: 199,
      },
    ];

    const scans = [
      { scanId: 200, time: '2026-03-14T07:00:00.000Z', optimizations: 2, errors: 0 },
      { scanId: 199, time: '2026-03-14T06:30:00.000Z', optimizations: 1, errors: 0 },
      { scanId: 181, time: '2026-03-13T09:00:00.000Z', optimizations: 1, errors: 0 },
    ];

    await withMockedService({
      scheduler: {
        getAllOptimizations: () => optimizations,
        getScanHistory: () => scans,
      },
      contracts: {
        aiOperations: payload => ({ apiVersion: 'v1', ...payload }),
      },
      recommendationQualityService: {
        getRecommendationQualityResponse: () => ({
          summary: {
            expiredApprovals: 2,
            failedApprovalRequests: 1,
            duplicateApprovalClusters: 1,
            staleHighPriorityAlerts: 0,
          },
        }),
      },
    }, async service => {
      const response = service.getAiOperationsResponse();

      assert.equal(response.summary.rawRecommendationCount, 5);
      assert.equal(response.summary.clusterCount, 3);
      assert.equal(response.summary.actionNowFamilies, 1);
      assert.equal(response.summary.openBacklogFamilies, 1);
      assert.equal(response.summary.openBacklogItems, 2);
      assert.equal(response.summary.compressionRatio, 1.7);
      assert.equal(response.quality.level, 'medium');

      assert.equal(response.queue.immediate.length, 1);
      assert.equal(response.queue.immediate[0].targetName, 'Winner');
      assert.equal(response.queue.backlog.length, 1);
      assert.equal(response.queue.backlog[0].targetName, 'Older Winner');
      assert.equal(response.queue.backlog[0].count, 2);
      assert.equal(response.queue.backlog[0].stale, true);

      const profitabilityCluster = response.clusters.find(cluster => cluster.targetName === 'Overall Profitability');
      assert.ok(profitabilityCluster);
      assert.equal(profitabilityCluster.count, 2);

      assert.equal(response.activity.length, 2);
      assert.equal(response.decisionMarkers.length, 2);
      assert.equal(response.systemChatter.scanCount, 3);
    });
  } finally {
    Date.now = originalDateNow;
  }
});
