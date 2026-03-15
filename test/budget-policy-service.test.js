const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDefaultChampionPolicy,
  evaluateBudgetSnapshot,
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
    risk: {
      activeCampaignCount: 1,
      activeAdCount: 4,
      severeFatigueBlock: false,
      hasConcentrationRisk: false,
      hasCreativeDepthRisk: false,
      fatiguedAds: [],
    },
    reviewWindowHours: 72,
    ...overrides,
  };
}

test('evaluateBudgetSnapshot ignores retired delivery-management fields when economics support scaling', () => {
  const policy = buildDefaultChampionPolicy({ maxBudgetChangePercent: 20 });
  const evaluation = evaluateBudgetSnapshot(
    createScaleSnapshot({
      weekday: {
        status: 'suppress',
        reason: 'Legacy weekday pacing softening',
      },
      trend: {
        status: 'suppress',
        reason: 'Legacy short-term Meta trend wobble',
      },
      controlSurface: 'mixed_or_unsupported',
    }),
    policy,
    {
      maxBudgetChangePercent: 20,
      cpaWarningThreshold: 30,
      cpaPauseThreshold: 50,
      minSpendForDecision: 20,
    }
  );

  assert.equal(evaluation.verdict, 'scale');
  assert.equal(evaluation.shouldCreateOptimization, true);
  assert.doesNotMatch(evaluation.reasoning, /weekday|trend|control surface|campaign level/i);
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
