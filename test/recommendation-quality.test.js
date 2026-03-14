const test = require('node:test');
const assert = require('node:assert/strict');

async function withMockedService(overrides, run) {
  const servicePath = require.resolve('../server/services/recommendationQualityService');
  const dependencyEntries = [
    [require.resolve('../server/modules/scanStore'), overrides.scanStore],
    [require.resolve('../server/contracts/v1'), overrides.contracts],
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

test('recommendation quality summarizes recent churn, open approvals, and stale alerts', async () => {
  const originalDateNow = Date.now;
  Date.now = () => new Date('2026-03-14T08:00:00.000Z').getTime();

  try {
    await withMockedService({
      scanStore: {
        getAllOptimizations: () => ([
          {
            id: 'opt-open',
            type: 'budget',
            level: 'campaign',
            targetId: 'c1',
            targetName: 'Winner',
            action: 'Increase daily budget by $22.00 (20%)',
            approvalStatus: null,
            executed: false,
            timestamp: '2026-03-14T07:00:00.000Z',
          },
          {
            id: 'opt-expired-a',
            type: 'budget',
            level: 'campaign',
            targetId: 'c1',
            targetName: 'Winner',
            action: 'Increase daily budget by $24.00 (20%)',
            approvalStatus: 'expired',
            executed: false,
            approvalRequestedAt: '2026-03-14T04:00:00.000Z',
            timestamp: '2026-03-14T04:00:00.000Z',
          },
          {
            id: 'opt-expired-b',
            type: 'budget',
            level: 'campaign',
            targetId: 'c1',
            targetName: 'Winner',
            action: 'Increase daily budget by $26.00 (20%)',
            approvalStatus: 'expired',
            executed: false,
            approvalRequestedAt: '2026-03-14T02:00:00.000Z',
            timestamp: '2026-03-14T02:00:00.000Z',
          },
          {
            id: 'opt-alert-old',
            type: 'creative',
            level: 'ad',
            targetId: 'a1',
            targetName: 'Fatigued Ad',
            action: 'Refresh creative',
            priority: 'high',
            approvalStatus: null,
            executed: false,
            timestamp: '2026-03-11T02:00:00.000Z',
          },
        ]),
      },
      contracts: {
        recommendationQuality: payload => ({ apiVersion: 'v1', ...payload }),
      },
    }, async service => {
      const response = service.getRecommendationQualityResponse();

      assert.equal(response.summary.totalRecentRecommendations, 3);
      assert.equal(response.summary.recentScaleRecommendations, 3);
      assert.equal(response.summary.openApprovals, 1);
      assert.equal(response.summary.expiredApprovals, 2);
      assert.equal(response.summary.staleHighPriorityAlerts, 1);
      assert.equal(response.summary.duplicateApprovalClusters, 1);
      assert.equal(response.duplicateApprovalTargets[0].targetName, 'Winner');
      assert.equal(response.duplicateApprovalTargets[0].count, 3);
    });
  } finally {
    Date.now = originalDateNow;
  }
});
