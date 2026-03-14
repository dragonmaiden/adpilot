const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDefaultChampionPolicy,
  evaluateBudgetSnapshot,
  createDecisionTrace,
} = require('../server/services/budgetPolicyService');
const { runStructuredSearch } = require('../server/services/policyLabReplayService');

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
      confidence: 'high',
      confidenceLabel: 'High confidence',
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
  };
}

test('runStructuredSearch can surface a promotion-ready challenger when replay says champion scaling was harmful', () => {
  const rules = {
    maxBudgetChangePercent: 20,
    cpaWarningThreshold: 30,
    cpaPauseThreshold: 50,
    minSpendForDecision: 20,
  };
  const championPolicy = buildDefaultChampionPolicy(rules);
  const snapshot = createSnapshot();
  const championDecision = evaluateBudgetSnapshot(snapshot, championPolicy, rules);
  const championTrace = createDecisionTrace({
    scanId: 999,
    mode: 'champion',
    policy: championPolicy,
    snapshot,
    evaluation: championDecision,
  });

  assert.equal(championTrace.verdict, 'scale');

  const research = runStructuredSearch({
    championPolicy,
    traces: [championTrace],
    outcomes: [{
      id: 'outcome_1',
      traceId: championTrace.traceId,
      verdict: championTrace.verdict,
      status: 'complete',
      finalReward: {
        total: -120000,
      },
    }],
    rules,
  });

  assert.equal(research.replaySampleSize, 1);
  assert.ok(research.experiments.length > 0);
  assert.ok(research.experiments.some(experiment => experiment.status === 'promotion_ready'));
});

test('runStructuredSearch falls back to bootstrap replay from live traces when no outcomes exist yet', () => {
  const rules = {
    maxBudgetChangePercent: 20,
    cpaWarningThreshold: 30,
    cpaPauseThreshold: 50,
    minSpendForDecision: 20,
  };
  const championPolicy = buildDefaultChampionPolicy(rules);
  const snapshot = createSnapshot();
  const championDecision = evaluateBudgetSnapshot(snapshot, championPolicy, rules);
  const championTrace = createDecisionTrace({
    scanId: 1001,
    mode: 'champion',
    policy: championPolicy,
    snapshot,
    evaluation: championDecision,
  });

  const research = runStructuredSearch({
    championPolicy,
    traces: [championTrace],
    outcomes: [],
    rules,
  });

  assert.equal(research.scoreMode, 'bootstrap_proxy');
  assert.equal(research.replaySampleSize, 1);
  assert.ok(research.experiments.length > 0);
  assert.ok(research.experiments.every(experiment => experiment.scoreMode === 'bootstrap_proxy'));
});
