const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDefaultChampionPolicy,
  evaluateBudgetSnapshot,
  createDecisionTrace,
} = require('../server/services/budgetPolicyService');

async function withMockedPolicyLabService(overrides, run) {
  const servicePath = require.resolve('../server/services/policyLabService');
  const dependencyEntries = [
    [require.resolve('../server/modules/scanStore'), overrides.scanStore],
    [require.resolve('../server/modules/snapshotRepository'), overrides.snapshotRepository],
    [require.resolve('../server/modules/policyLabStore'), overrides.policyLabStore],
    [require.resolve('../server/runtime/runtimeSettings'), overrides.runtimeSettings],
    [require.resolve('../server/services/policyLabReplayService'), overrides.policyLabReplayService || { runStructuredSearch: () => ({ replaySampleSize: 0, scoreMode: 'bootstrap_proxy', experiments: [] }) }],
    [require.resolve('../server/services/recommendationQualityService'), overrides.recommendationQualityService],
    [require.resolve('../server/services/observabilityService'), overrides.observabilityService],
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

function createSnapshot() {
  return {
    targetId: 'c1',
    targetName: 'Winner',
    targetLevel: 'campaign',
    currentBudgetCents: 11000,
    avgCpa: 10,
    spend: 100,
    purchases: 10,
    evidence: {
      observationDays: 7,
      purchaseDays: 7,
      spend: 100,
      purchases: 10,
      cpa: 10,
    },
    economics: {
      targetCpa: 18,
      breakEvenCpa: 24,
      estimatedRevenue: 800000,
      estimatedTrueNetProfit: 180000,
      estimatedMargin: 0.22,
      coverageRatio: 0.82,
      confidence: 'medium',
      confidenceLabel: 'Medium confidence',
      hasReliableEstimate: true,
    },
    risk: {
      activeCampaignCount: 1,
      activeAdCount: 2,
      severeFatigueBlock: false,
      hasConcentrationRisk: true,
      hasCreativeDepthRisk: true,
      fatiguedAds: [{ id: 'ad1', name: 'Fatigued Ad' }],
    },
    reviewWindowHours: 72,
  };
}

test('getPolicyLabResponse exposes experiment funnel, specialist scoreboard, and regime performance', async () => {
  const policy = buildDefaultChampionPolicy({ maxBudgetChangePercent: 20 });
  const evaluation = evaluateBudgetSnapshot(createSnapshot(), policy, {
    maxBudgetChangePercent: 20,
    cpaWarningThreshold: 30,
    cpaPauseThreshold: 50,
    minSpendForDecision: 20,
  });
  const trace = createDecisionTrace({
    scanId: 777,
    mode: 'champion',
    policy,
    snapshot: createSnapshot(),
    evaluation,
  });

  const policies = [
    policy,
    {
      ...policy,
      id: 'budget-policy-champion-v1-cand-1',
      label: 'Candidate 1',
      status: 'active_candidate',
      scoreSummary: { improvementRatio: 0.08 },
    },
  ];

  await withMockedPolicyLabService({
    scanStore: {
      getAllOptimizations: () => [],
    },
    snapshotRepository: {
      getSnapshotsList: () => [],
      getSnapshot: () => null,
    },
    policyLabStore: {
      getPolicies: () => policies,
      getMetaState: () => ({
        championPolicyId: policy.id,
        activeShadowPolicyId: 'budget-policy-champion-v1-cand-1',
        lastResearchRunAt: '2026-03-14T06:00:00.000Z',
        lastResearchSummary: {
          replaySampleSize: 4,
          experimentCount: 2,
          bestPolicyId: 'budget-policy-champion-v1-cand-1',
          bestImprovementRatio: 0.08,
          scoreMode: 'bootstrap_proxy',
        },
      }),
      getDecisionTraces: () => [trace],
      getExperiments: () => [{
        id: 'experiment_1',
        policyId: 'budget-policy-champion-v1-cand-1',
        label: 'Candidate 1',
        status: 'active_candidate',
        createdAt: '2026-03-14T06:00:00.000Z',
        replaySummary: {
          sampleSize: 4,
          improvementRatio: 0.08,
          divergenceRate: 0.25,
          approvalLoadRatio: 1,
        },
      }],
      getBudgetOutcomes: () => [{
        id: 'outcome_1',
        traceId: trace.traceId,
        status: 'complete',
        executedAt: '2026-03-13T06:00:00.000Z',
        lastEvaluatedAt: '2026-03-14T06:00:00.000Z',
        finalReward: {
          total: 120000,
          realizedProfitDelta: 150000,
        },
      }],
      getShadowDecisionLog: () => [{
        id: 'shadow_1',
        diverged: true,
        timestamp: '2026-03-14T06:15:00.000Z',
      }],
      getObservabilityEvents: () => [],
      upsertPolicy: () => null,
      updateMetaState: () => null,
    },
    runtimeSettings: {
      getRules: () => ({
        maxBudgetChangePercent: 20,
        cpaWarningThreshold: 30,
        cpaPauseThreshold: 50,
        minSpendForDecision: 20,
      }),
    },
    recommendationQualityService: {
      getRecommendationQualityResponse: () => ({ summary: {} }),
    },
    observabilityService: {
      getStatus: () => ({ enabled: false, lastEventAt: null }),
      captureMessage: () => null,
      captureException: () => null,
    },
  }, async service => {
    const response = service.getPolicyLabResponse();

    assert.equal(response.summary.harnessStatus.activeCandidates, 1);
    assert.equal(response.summary.harnessStatus.candidatePool, 1);
    assert.equal(response.summary.maturityState, 'early_real_data');
    assert.equal(response.summary.usesRealOutcomes, true);
    assert.ok(Array.isArray(response.specialistScoreboard));
    assert.ok(response.specialistScoreboard.some(entry => entry.key === 'structure'));
    assert.ok(Array.isArray(response.regimePerformance));
    assert.ok(response.regimePerformance.some(entry => entry.tag === 'concentrated_account'));
    assert.equal(response.experimentFunnel.activeCandidates, 1);
  });
});

test('getPolicyLabResponse labels proxy-only learning honestly when no completed outcomes exist', async () => {
  const policy = buildDefaultChampionPolicy({ maxBudgetChangePercent: 20 });
  const evaluation = evaluateBudgetSnapshot(createSnapshot(), policy, {
    maxBudgetChangePercent: 20,
    cpaWarningThreshold: 30,
    cpaPauseThreshold: 50,
    minSpendForDecision: 20,
  });
  const trace = createDecisionTrace({
    scanId: 778,
    mode: 'champion',
    policy,
    snapshot: createSnapshot(),
    evaluation,
  });

  await withMockedPolicyLabService({
    scanStore: {
      getAllOptimizations: () => [],
    },
    snapshotRepository: {
      getSnapshotsList: () => [],
      getSnapshot: () => null,
    },
    policyLabStore: {
      getPolicies: () => [policy],
      getMetaState: () => ({
        championPolicyId: policy.id,
        activeShadowPolicyId: null,
        lastResearchRunAt: '2026-03-14T06:00:00.000Z',
        lastResearchSummary: {
          replaySampleSize: 8,
          experimentCount: 3,
          bestPolicyId: null,
          bestImprovementRatio: 0,
          scoreMode: 'bootstrap_proxy',
        },
      }),
      getDecisionTraces: () => [trace],
      getExperiments: () => [],
      getBudgetOutcomes: () => [],
      getShadowDecisionLog: () => [],
      getObservabilityEvents: () => [],
      upsertPolicy: () => null,
      updateMetaState: () => null,
    },
    runtimeSettings: {
      getRules: () => ({
        maxBudgetChangePercent: 20,
        cpaWarningThreshold: 30,
        cpaPauseThreshold: 50,
        minSpendForDecision: 20,
      }),
    },
    recommendationQualityService: {
      getRecommendationQualityResponse: () => ({ summary: {} }),
    },
    observabilityService: {
      getStatus: () => ({ enabled: false, lastEventAt: null }),
      captureMessage: () => null,
      captureException: () => null,
    },
  }, async service => {
    const response = service.getPolicyLabResponse();

    assert.equal(response.summary.maturityState, 'proxy_only');
    assert.equal(response.summary.maturityLabel, 'Proxy-scored only');
    assert.equal(response.summary.usesRealOutcomes, false);
    assert.match(response.summary.maturityHeadline, /live traces/i);
  });
});
