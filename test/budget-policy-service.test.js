const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDefaultChampionPolicy,
  classifyControlSurface,
  evaluateBudgetSnapshot,
  createDecisionTrace,
  computeReward,
} = require('../server/services/budgetPolicyService');

function createScaleSnapshot(overrides = {}) {
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
    weekday: {
      status: 'stable',
      reason: '',
    },
    trend: {
      status: 'stable',
      reason: '',
    },
    risk: {
      activeCampaignCount: 1,
      activeAdCount: 4,
      severeFatigueBlock: false,
      hasConcentrationRisk: false,
      hasCreativeDepthRisk: false,
      fatiguedAds: [],
    },
    controlSurface: 'campaign_budget_controlled',
    reviewWindowHours: 72,
    ...overrides,
  };
}

test('classifyControlSurface distinguishes campaign and ad set budget ownership', () => {
  assert.equal(
    classifyControlSurface({
      level: 'campaign',
      campaign: { id: 'c1', daily_budget: '11000' },
      adSets: [],
    }),
    'campaign_budget_controlled'
  );

  assert.equal(
    classifyControlSurface({
      level: 'adset',
      campaign: { id: 'c1', daily_budget: '11000' },
      adSet: { id: 'a1', campaign_id: 'c1' },
    }),
    'campaign_budget_controlled'
  );

  assert.equal(
    classifyControlSurface({
      level: 'adset',
      campaign: { id: 'c1' },
      adSet: { id: 'a1', campaign_id: 'c1', daily_budget: '4000' },
    }),
    'adset_budget_controlled'
  );
});

test('evaluateBudgetSnapshot suppresses ad set budget changes when the campaign owns budget control', () => {
  const policy = buildDefaultChampionPolicy({ maxBudgetChangePercent: 20 });
  const evaluation = evaluateBudgetSnapshot(
    createScaleSnapshot({
      targetId: 'a1',
      targetName: 'Ad Set 1',
      targetLevel: 'adset',
      controlSurface: 'campaign_budget_controlled',
    }),
    policy,
    {
      maxBudgetChangePercent: 20,
      cpaWarningThreshold: 30,
      cpaPauseThreshold: 50,
      minSpendForDecision: 20,
    }
  );

  assert.equal(evaluation.verdict, 'suppress');
  assert.equal(evaluation.shouldCreateOptimization, false);
  assert.match(evaluation.reasoning, /campaign level/i);
});

test('createDecisionTrace captures the structured policy evaluation context', () => {
  const policy = buildDefaultChampionPolicy({ maxBudgetChangePercent: 20 });
  const snapshot = createScaleSnapshot();
  const evaluation = evaluateBudgetSnapshot(snapshot, policy, {
    maxBudgetChangePercent: 20,
    cpaWarningThreshold: 30,
    cpaPauseThreshold: 50,
    minSpendForDecision: 20,
  });
  const trace = createDecisionTrace({
    scanId: 123,
    mode: 'champion',
    policy,
    snapshot,
    evaluation,
  });

  assert.match(trace.traceId, /^trace_123_/);
  assert.equal(trace.policyVersionId, policy.id);
  assert.equal(trace.entity.targetName, 'Winner');
  assert.equal(trace.verdict, 'scale');
  assert.ok(Array.isArray(trace.gates));
  assert.ok(Array.isArray(trace.penalties));
  assert.ok(Array.isArray(trace.specialists));
  assert.ok(Array.isArray(trace.regimeTags));
  assert.ok(trace.synthesis);
});

test('evaluateBudgetSnapshot emits specialist summaries, regime tags, and synthesis metadata', () => {
  const policy = buildDefaultChampionPolicy({ maxBudgetChangePercent: 20 });
  const evaluation = evaluateBudgetSnapshot(createScaleSnapshot({
    risk: {
      activeCampaignCount: 1,
      activeAdCount: 2,
      severeFatigueBlock: false,
      hasConcentrationRisk: true,
      hasCreativeDepthRisk: true,
      fatiguedAds: [{ id: 'ad1', name: 'Fatigued Ad' }],
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
  }), policy, {
    maxBudgetChangePercent: 20,
    cpaWarningThreshold: 30,
    cpaPauseThreshold: 50,
    minSpendForDecision: 20,
  });

  assert.ok(Array.isArray(evaluation.specialists));
  assert.ok(evaluation.specialists.some(entry => entry.key === 'economics'));
  assert.ok(evaluation.specialists.some(entry => entry.key === 'structure'));
  assert.ok(Array.isArray(evaluation.regimeTags));
  assert.ok(evaluation.regimeTags.includes('concentrated_account'));
  assert.ok(evaluation.regimeTags.includes('thin_creative_depth'));
  assert.ok(evaluation.synthesis);
  assert.ok(typeof evaluation.synthesis.frictionScore === 'number');
});

test('computeReward applies CPA, volatility, confidence, reversal, and churn penalties', () => {
  const reward = computeReward({
    baseline: {
      cpa: 10,
      estimatedTrueNetProfit: 100000,
    },
    horizon: {
      cpa: 13,
      estimatedTrueNetProfit: 230000,
      volatilityScore: 0.2,
      confidencePenalty: 10000,
    },
    policy: buildDefaultChampionPolicy(),
    reversalDetected: true,
    churnCount: 2,
  });

  assert.equal(reward.realizedProfitDelta, 130000);
  assert.ok(reward.total < reward.realizedProfitDelta);
  assert.ok(reward.components.some(component => component.type === 'cpa_penalty'));
  assert.ok(reward.components.some(component => component.type === 'volatility_penalty'));
  assert.ok(reward.components.some(component => component.type === 'confidence_penalty'));
  assert.ok(reward.components.some(component => component.type === 'reversal_penalty'));
  assert.ok(reward.components.some(component => component.type === 'churn_penalty'));
});
