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

test('ai operations groups raw rows into live, cleanup, and research buckets instead of keeping every old approval open', async () => {
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
        timestamp: '2026-03-13T18:00:00.000Z',
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
        timestamp: '2026-03-13T19:00:00.000Z',
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
      assert.equal(response.summary.blockedFamilies, 1);
      assert.equal(response.summary.openBacklogFamilies, 1);
      assert.equal(response.summary.openBacklogItems, 1);
      assert.equal(response.summary.researchFamilies, 1);
      assert.equal(response.summary.watchingFamilies, 1);
      assert.equal(response.summary.archivedFamilies, 0);
      assert.equal(response.summary.compressionRatio, 1.7);
      assert.equal(response.quality.level, 'medium');

      assert.equal(response.queue.immediate.length, 1);
      assert.equal(response.queue.immediate[0].targetName, 'Winner');
      assert.equal(response.queue.immediate[0].currentStatus, 'action_now');
      assert.equal(response.queue.backlog.length, 1);
      assert.equal(response.queue.backlog[0].targetName, 'Older Winner');
      assert.equal(response.queue.backlog[0].currentStatus, 'cleanup');
      assert.equal(response.queue.backlog[0].count, 2);
      assert.equal(response.queue.backlog[0].stale, true);
      assert.equal(response.queue.backlog[0].actionableNow, false);
      assert.equal(response.queue.research.length, 1);
      assert.equal(response.queue.research[0].targetName, 'Overall Profitability');

      const profitabilityCluster = response.clusters.find(cluster => cluster.targetName === 'Overall Profitability');
      assert.ok(profitabilityCluster);
      assert.equal(profitabilityCluster.currentStatus, 'research');

      assert.equal(response.activity.length, 2);
      assert.equal(response.decisionMarkers.length, 2);
      assert.equal(response.systemChatter.scanCount, 3);
    });
  } finally {
    Date.now = originalDateNow;
  }
});

test('delivery failures and resolved approvals do not remain live owner approvals', async () => {
  const originalDateNow = Date.now;
  Date.now = () => new Date('2026-03-14T08:00:00.000Z').getTime();

  try {
    const optimizations = [
      {
        id: 'opt-failed',
        type: 'budget',
        level: 'campaign',
        targetId: 'c1',
        targetName: 'Failed Delivery Campaign',
        action: 'Increase daily budget by $20.00 (20%)',
        priority: 'medium',
        timestamp: '2026-03-14T07:30:00.000Z',
        scanId: 200,
        executionResult: 'Failed to send Telegram approval request',
      },
      {
        id: 'opt-open-old',
        type: 'budget',
        level: 'campaign',
        targetId: 'c2',
        targetName: 'Resolved Campaign',
        action: 'Increase daily budget by $20.00 (20%)',
        priority: 'medium',
        timestamp: '2026-03-14T06:00:00.000Z',
        scanId: 199,
      },
      {
        id: 'opt-expired-new',
        type: 'budget',
        level: 'campaign',
        targetId: 'c2',
        targetName: 'Resolved Campaign',
        action: 'Increase daily budget by $20.00 (20%)',
        priority: 'medium',
        timestamp: '2026-03-14T07:00:00.000Z',
        scanId: 200,
        approvalStatus: 'expired',
        executionResult: 'Expired: Timeout — no response',
      },
    ];

    await withMockedService({
      scheduler: {
        getAllOptimizations: () => optimizations,
        getScanHistory: () => [{ scanId: 200, time: '2026-03-14T07:00:00.000Z', optimizations: 2, errors: 0 }],
      },
      contracts: {
        aiOperations: payload => ({ apiVersion: 'v1', ...payload }),
      },
      recommendationQualityService: {
        getRecommendationQualityResponse: () => ({
          summary: {
            expiredApprovals: 1,
            failedApprovalRequests: 1,
            duplicateApprovalClusters: 0,
            staleHighPriorityAlerts: 0,
          },
        }),
      },
    }, async service => {
      const response = service.getAiOperationsResponse();

      assert.equal(response.summary.actionNowFamilies, 0);
      assert.equal(response.summary.blockedFamilies, 1);
      assert.equal(response.summary.resolvedFamilies, 1);

      assert.equal(response.queue.immediate.length, 0);
      assert.equal(response.queue.backlog.length, 1);
      assert.equal(response.queue.backlog[0].targetName, 'Failed Delivery Campaign');
      assert.equal(response.queue.backlog[0].currentStatus, 'cleanup');

      const resolvedCluster = response.clusters.find(cluster => cluster.targetName === 'Resolved Campaign');
      assert.ok(resolvedCluster);
      assert.equal(resolvedCluster.currentStatus, 'resolved');
      assert.equal(resolvedCluster.hasOpenApprovals, false);
      assert.equal(resolvedCluster.actionableNow, false);
    });
  } finally {
    Date.now = originalDateNow;
  }
});

test('ai operations elevates fix-input and hold advisories into their own operator lanes', async () => {
  const originalDateNow = Date.now;
  Date.now = () => new Date('2026-03-14T08:00:00.000Z').getTime();

  try {
    const optimizations = [
      {
        id: 'opt-fix-inputs',
        type: 'budget',
        level: 'account',
        targetId: 'account',
        targetName: 'Measurement Trust',
        action: 'Freeze budget changes — measurement trust is too weak',
        reason: 'Fresh revenue data is unavailable',
        priority: 'high',
        timestamp: '2026-03-14T07:20:00.000Z',
        scanId: 300,
        decisionKind: 'freeze_due_to_low_trust',
        decisionDomain: 'measurement_trust',
      },
      {
        id: 'opt-hold',
        type: 'budget',
        level: 'account',
        targetId: 'account',
        targetName: 'Meta Delivery',
        action: 'Hold budget — let Meta continue delivery',
        reason: 'No campaign crossed the current scale or reduce guardrails',
        priority: 'low',
        timestamp: '2026-03-14T07:25:00.000Z',
        scanId: 300,
        decisionKind: 'hold_budget',
        decisionDomain: 'macro_budget',
      },
      {
        id: 'opt-research',
        type: 'budget',
        level: 'account',
        targetId: 'account',
        targetName: 'Overall Profitability',
        action: 'True net profit is ₩150,000 — room to feed Meta more budget',
        reason: 'Portfolio margin is healthy',
        priority: 'medium',
        timestamp: '2026-03-14T07:10:00.000Z',
        scanId: 300,
        decisionKind: 'portfolio_scale',
        decisionDomain: 'portfolio_guardrails',
      },
    ];

    await withMockedService({
      scheduler: {
        getAllOptimizations: () => optimizations,
        getScanHistory: () => [{ scanId: 300, time: '2026-03-14T07:30:00.000Z', optimizations: 3, errors: 0 }],
      },
      contracts: {
        aiOperations: payload => ({ apiVersion: 'v1', ...payload }),
      },
      recommendationQualityService: {
        getRecommendationQualityResponse: () => ({
          summary: {
            expiredApprovals: 0,
            failedApprovalRequests: 0,
            duplicateApprovalClusters: 0,
            staleHighPriorityAlerts: 0,
          },
        }),
      },
    }, async service => {
      const response = service.getAiOperationsResponse();

      assert.equal(response.summary.actionNowFamilies, 0);
      assert.equal(response.summary.fixInputFamilies, 1);
      assert.equal(response.summary.holdFamilies, 1);
      assert.equal(response.summary.portfolioGuidanceFamilies, 1);
      assert.equal(response.summary.researchFamilies, 0);

      assert.equal(response.queue.fixInputs.length, 1);
      assert.equal(response.queue.fixInputs[0].currentStatus, 'fix_inputs');
      assert.equal(response.queue.fixInputs[0].targetName, 'Measurement Trust');

      assert.equal(response.queue.hold.length, 1);
      assert.equal(response.queue.hold[0].currentStatus, 'hold');
      assert.equal(response.queue.hold[0].targetName, 'Meta Delivery');

      assert.equal(response.queue.portfolioGuidance.length, 1);
      assert.equal(response.queue.portfolioGuidance[0].currentStatus, 'portfolio_guidance');
      assert.equal(response.queue.portfolioGuidance[0].targetName, 'Overall Profitability');

      const portfolioCluster = response.clusters.find(cluster => cluster.targetName === 'Overall Profitability');
      assert.ok(portfolioCluster);
      assert.equal(portfolioCluster.currentStatus, 'portfolio_guidance');
    });
  } finally {
    Date.now = originalDateNow;
  }
});
