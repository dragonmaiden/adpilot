const test = require('node:test');
const assert = require('node:assert/strict');

async function withMockedService(overrides, run) {
  const servicePath = require.resolve('../server/services/briefService');
  const dependencyEntries = [
    [require.resolve('../server/contracts/v1'), overrides.contracts],
    [require.resolve('../server/services/operatorSummaryService'), overrides.operatorSummaryService],
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

test('operator brief is a compact digest of the canonical operator summary', async () => {
  const summary = {
    ready: true,
    generatedAt: '2026-03-13T10:40:17.004Z',
    objective: 'Maximize profitable growth while keeping execution approval-gated.',
    scan: {
      lastScan: '2026-03-13T10:40:17.004Z',
      intervalMinutes: 30,
      activeCampaigns: 1,
    },
    kpis: {
      revenue: 28410214,
      netRevenue: 25041302,
      adSpend: 3938.3,
      grossProfit: 8202310,
      grossMargin: 32.8,
      roas: 4.29,
      purchases: 179,
      cpa: 22.0,
    },
    campaigns: {
      activeCount: 1,
      topSpenders: [
        { id: 'c1', name: '260203_판매 테스트', spend: 823.02, purchases: 55, cpa: 14.96, ctr: 10.5 },
      ],
    },
    optimizations: {
      pendingApprovals: [
        {
          id: 'opt1',
          type: 'budget',
          priority: 'medium',
          targetName: '260203_판매 테스트',
          action: 'Increase daily budget by $30.00 (20%)',
          reason: 'Last 7d CPA is $10.63 with 83 Meta-attributed purchases.',
        },
      ],
      activeAlerts: [
        {
          id: 'opt2',
          type: 'creative',
          priority: 'high',
          targetName: 'Creative fatigue',
          action: 'Refresh 2 warning creatives',
          reason: 'CTR decay has persisted for 2 days.',
        },
      ],
    },
    operations: {
      missingCostItemCount: 3,
      incompletePurchaseCount: 3,
      validation: {
        rowsWithWarnings: 4,
        samples: [{ rowNumber: 24, productName: '에VVV 스카이 스카프' }],
      },
    },
    profit: {
      coverage: {
        hasReliableCoverage: true,
        confidence: 'high',
        coverageWeight: 0.92,
      },
    },
    sources: {
      metaStructure: { status: 'connected', stale: false },
      metaInsights: { status: 'connected', stale: false },
      imweb: { status: 'connected', stale: false },
      cogs: { status: 'connected', stale: false },
    },
    links: {
      overview: '/api/overview',
      settings: '/api/settings',
    },
  };

  await withMockedService({
    contracts: {
      operatorBrief: payload => ({ apiVersion: 'v1', ...payload }),
    },
    operatorSummaryService: {
      getOperatorSummaryResponse: async () => summary,
    },
  }, async service => {
    const brief = await service.getOperatorBriefResponse();

    assert.equal(brief.ready, true);
    assert.match(brief.headline, /gross profit/i);
    assert.equal(brief.scorecard.netRevenue, 25041302);
    assert.equal(brief.approvals.pendingCount, 1);
    assert.equal(brief.alerts.activeCount, 1);
    assert.equal(brief.approvals.topPending.action, 'Increase daily budget by $30.00 (20%)');
    assert.equal(brief.alerts.topAlert.action, 'Refresh 2 warning creatives');
    assert.ok(Array.isArray(brief.signals));
    assert.ok(brief.signals.some(signal => signal.type === 'pending_approval'));
    assert.ok(brief.signals.some(signal => signal.type === 'cogs_quality'));
    assert.equal(brief.links.summary, '/api/operator-summary');
    assert.match(brief.notes[0], /thin digest/i);
  });
});
