const test = require('node:test');
const assert = require('node:assert/strict');

async function withMockedService(overrides, run) {
  const servicePath = require.resolve('../server/services/operatorSummaryService');
  const dependencyEntries = [
    [require.resolve('../server/modules/scheduler'), overrides.scheduler],
    [require.resolve('../server/runtime/runtimeSettings'), overrides.runtimeSettings],
    [require.resolve('../server/contracts/v1'), overrides.contracts],
    [require.resolve('../server/services/overviewService'), overrides.overviewService],
    [require.resolve('../server/services/analyticsService'), overrides.analyticsService],
    [require.resolve('../server/services/campaignService'), overrides.campaignService],
    [require.resolve('../server/services/optimizationService'), overrides.optimizationService],
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

test('operator summary composes live business context into one read-only brief', async () => {
  const originalDateNow = Date.now;
  Date.now = () => new Date('2026-03-13T08:00:00.000Z').getTime();

  try {
    await withMockedService({
    scheduler: {
      getLatestData: () => ({
        cogsData: {
          sheets: [{ label: '3월', sheetName: '3월 주문' }],
          purchaseCount: 18,
          itemCount: 21,
          incompletePurchaseCount: 2,
          missingCostItemCount: 2,
          validation: {
            rowsWithWarnings: 3,
            missingValueRows: 2,
            malformedOrderNumberRows: 1,
            samples: [{ rowNumber: 24, productName: '테스트 상품' }],
          },
        },
      }),
      getSourceHealth: () => ({
        metaStructure: { status: 'connected', stale: false, hasData: true, lastSuccessAt: '2026-03-13T07:21:55.959Z' },
        metaInsights: { status: 'connected', stale: false, hasData: true, lastSuccessAt: '2026-03-13T07:22:21.227Z' },
        imweb: { status: 'connected', stale: false, hasData: true, lastSuccessAt: '2026-03-13T07:22:24.326Z' },
        cogs: { status: 'connected', stale: false, hasData: true, lastSuccessAt: '2026-03-13T07:22:27.080Z' },
      }),
      getNextScheduledRunAt: () => new Date('2026-03-13T08:00:00.000Z'),
    },
    runtimeSettings: {
      getSettings: () => ({
        rules: { autonomousMode: true },
        scheduler: { scanIntervalMinutes: 30 },
      }),
    },
    contracts: {
      operatorSummary: payload => ({ apiVersion: 'v1', ...payload }),
    },
    overviewService: {
      getOverviewResponse: async () => ({
        ready: true,
        lastScan: '2026-03-13T07:22:27.080Z',
        isScanning: false,
        scanStats: { activeCampaigns: 2, activeAds: 5, activeAdSets: 3 },
        kpis: {
          revenue: 12000000,
          netRevenue: 10500000,
          refunded: 500000,
          refundRate: 4.2,
          cancelRate: 1.1,
          adSpend: 3200,
          adSpendKRW: 4640000,
          purchases: 88,
          cpa: 36.4,
          ctr: 2.4,
          roas: 2.26,
          grossProfit: 2900000,
          grossMargin: 27.6,
          aov: 136000,
          cogs: 4100000,
          cogsRate: 39.0,
        },
      }),
    },
    analyticsService: {
      getAnalyticsResponse: () => ({
        profitAnalysis: {
          todaySummary: {
            date: '2026-03-13',
            trueNetProfit: 220000,
            verdict: 'Profitable',
            hasCOGS: true,
          },
          runRate: {
            daysUsed: 14,
            avgDailyNetProfit: 180000,
            projectedMonthlyNetProfit: 5400000,
          },
          coverage: {
            coverageRatio: 0.92,
            coverageWeight: 0.9,
            hasReliableCoverage: true,
            confidence: 'high',
          },
        },
      }),
    },
    campaignService: {
      getEnrichedCampaigns: () => ({
        windowKey: '7d',
        campaigns: [
          { id: 'c1', name: 'Winner', status: 'ACTIVE', metricsWindow: { spend: 1200, attributedPurchases: 30, cpa: 40, ctr: 2.8 } },
          { id: 'c2', name: 'Scaler', status: 'ACTIVE', metricsWindow: { spend: 900, attributedPurchases: 28, cpa: 32.1, ctr: 2.6 } },
          { id: 'c3', name: 'Weak', status: 'PAUSED', metricsWindow: { spend: 700, attributedPurchases: 0, cpa: null, ctr: 1.2 } },
        ],
      }),
    },
    optimizationService: {
      getOptimizationsResponse: () => ({
        optimizations: [
          { id: 'o1', status: 'needs_approval', actionable: true, priority: 'medium', targetName: 'Scaler', action: 'Increase daily budget by $20', reason: 'Strong CPA', timestamp: '2026-03-13T07:25:00.000Z' },
          { id: 'o2', status: 'advisory', actionable: false, priority: 'high', targetName: 'Weak', action: 'Refresh creative', reason: 'CTR decayed', impact: 'Likely to recover click-through rate', timestamp: '2026-03-13T07:24:00.000Z' },
          { id: 'o3', status: 'expired', actionable: false, priority: 'medium', targetName: 'Old Budget Request', action: 'Increase daily budget by $15', reason: 'Old approval', timestamp: '2026-03-12T02:00:00.000Z' },
          { id: 'o4', status: 'advisory', actionable: false, priority: 'low', targetName: 'Winner', action: 'Monitor', reason: 'Stable', timestamp: '2026-03-13T07:23:00.000Z' },
          { id: 'o5', status: 'advisory', actionable: false, priority: 'critical', targetName: 'Old Alert', action: 'Stale alert', reason: 'Old state', timestamp: '2026-03-10T07:23:00.000Z' },
        ],
        stats: { actionable: 1, advisory: 3, expired: 1 },
      }),
    },
    }, async service => {
      const summary = await service.getOperatorSummaryResponse();

      assert.equal(summary.ready, true);
      assert.equal(summary.scan.intervalMinutes, 30);
      assert.equal(summary.scan.activeCampaigns, 2);
      assert.equal(summary.kpis.netRevenue, 10500000);
      assert.equal(summary.profit.coverage.confidence, 'high');
      assert.equal(summary.profit.coverage.confidenceLabel, 'High confidence');
      assert.equal(summary.campaigns.topSpenders[0].name, 'Winner');
      assert.equal(summary.campaigns.strongest[0].name, 'Scaler');
      assert.equal(summary.campaigns.weakest[0].name, 'Weak');
      assert.equal(summary.optimizations.pendingApprovals.length, 1);
      assert.equal(summary.optimizations.activeAlerts.length, 1);
      assert.equal(summary.operations.sheets[0].sheetName, '3월 주문');
      assert.match(summary.notes[0], /primary read-only operator brief/i);
    });
  } finally {
    Date.now = originalDateNow;
  }
});
