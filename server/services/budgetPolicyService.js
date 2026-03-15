const { buildDecisionContext, DEFAULT_REVIEW_WINDOW_HOURS } = require('../decision/contextBuilder');
const { evaluateSpecialists } = require('../decision/specialists');
const { synthesizeDecision } = require('../decision/synthesizer');
const { asNumber } = require('../decision/utils');

const DEFAULT_POLICY_ID = 'budget-policy-champion-v1';

function buildDefaultChampionPolicy(rules = {}) {
  const maxBudgetChangePercent = asNumber(rules.maxBudgetChangePercent, 20);
  const cpaWarningThreshold = asNumber(rules.cpaWarningThreshold, 30);
  const cpaPauseThreshold = asNumber(rules.cpaPauseThreshold, 50);
  return {
    id: DEFAULT_POLICY_ID,
    label: 'Champion Budget Policy v1',
    reviewWindowHours: DEFAULT_REVIEW_WINDOW_HOURS,
    parameters: {
      scale: {
        minObservationDays: 3,
        minPurchases: 8,
        minPurchaseDays: 4,
        minCoverageRatio: 0.8,
        minEstimatedMargin: 0.08,
        cautionStepPercentCap: Math.min(maxBudgetChangePercent, 10),
        maxStepPercent: maxBudgetChangePercent,
      },
      reduce: {
        cpaWarningThreshold,
        cpaPauseThreshold,
        maxReductionPercent: Math.min(maxBudgetChangePercent, 15),
      },
      penalties: {
        concentration: 1,
        fatigue: 1,
        creativeDepth: 1,
        confidence: 1,
        measurementTrust: 1.25,
      },
      specialists: {
        measurementTrust: 1.25,
        economics: 1.2,
        confidence: 1.05,
        fatigue: 1.1,
        structure: 1,
        scaleSizer: 1,
        reduceSizer: 1,
      },
      synthesizer: {
        frictionCautionThreshold: 2.2,
        frictionLowConfidenceThreshold: 3.5,
        frictionSuppressThreshold: 5,
        cautionPenaltyMultiplier: 0.75,
      },
    },
  };
}

function evaluateBudgetSnapshot(snapshotInput, policy, rules = {}) {
  const activePolicy = policy || buildDefaultChampionPolicy(rules);
  const context = buildDecisionContext(snapshotInput, activePolicy, rules);
  const specialists = evaluateSpecialists(context);
  return synthesizeDecision(context, specialists);
}

module.exports = {
  DEFAULT_POLICY_ID,
  DEFAULT_REVIEW_WINDOW_HOURS,
  buildDefaultChampionPolicy,
  evaluateBudgetSnapshot,
};
