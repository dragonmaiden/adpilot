const { buildDecisionContext, normalizeBudgetSnapshot, DEFAULT_REVIEW_WINDOW_HOURS, REWARD_WINDOW_HOURS } = require('../decision/contextBuilder');
const { evaluateSpecialists } = require('../decision/specialists');
const { synthesizeDecision } = require('../decision/synthesizer');
const { asNumber, clamp } = require('../decision/utils');
const { computeReward, bucketReward } = require('./rewardEngine');

const DEFAULT_POLICY_ID = 'budget-policy-champion-v1';

function nowIso() {
  return new Date().toISOString();
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getAtPath(object, path) {
  return String(path || '')
    .split('.')
    .reduce((current, key) => (current && current[key] !== undefined ? current[key] : undefined), object);
}

function setAtPath(object, path, value) {
  const parts = String(path || '').split('.');
  let current = object;
  while (parts.length > 1) {
    const key = parts.shift();
    if (!current[key] || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  current[parts[0]] = value;
}

function buildDefaultChampionPolicy(rules = {}) {
  const maxBudgetChangePercent = asNumber(rules.maxBudgetChangePercent, 20);
  const cpaWarningThreshold = asNumber(rules.cpaWarningThreshold, 30);
  const cpaPauseThreshold = asNumber(rules.cpaPauseThreshold, 50);
  return {
    id: DEFAULT_POLICY_ID,
    label: 'Champion Budget Policy v1',
    status: 'champion',
    mutationStrategy: 'manual_seed',
    parentPolicyId: null,
    createdAt: nowIso(),
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
      reward: {
        horizonHours: REWARD_WINDOW_HOURS,
        cpaPenaltyRatio: 0.15,
        negativeRewardMultiplier: 0.75,
        missedUpsidePenaltyMultiplier: 0.5,
        contradictionPenaltyMultiplier: 1,
      },
    },
    scoreSummary: null,
    diffSummary: [],
  };
}

function buildPolicyDiff(basePolicy, nextPolicy) {
  if (!basePolicy || !nextPolicy) return [];

  const paths = [
    'parameters.scale.minPurchases',
    'parameters.scale.minPurchaseDays',
    'parameters.scale.minCoverageRatio',
    'parameters.scale.minEstimatedMargin',
    'parameters.scale.cautionStepPercentCap',
    'parameters.scale.maxStepPercent',
    'parameters.reduce.cpaWarningThreshold',
    'parameters.reduce.maxReductionPercent',
    'parameters.penalties.concentration',
    'parameters.penalties.fatigue',
    'parameters.penalties.creativeDepth',
    'parameters.penalties.confidence',
    'parameters.penalties.measurementTrust',
    'parameters.specialists.measurementTrust',
    'parameters.specialists.economics',
    'parameters.specialists.confidence',
    'parameters.specialists.fatigue',
    'parameters.specialists.structure',
    'parameters.specialists.scaleSizer',
    'parameters.specialists.reduceSizer',
    'parameters.synthesizer.frictionCautionThreshold',
    'parameters.synthesizer.frictionLowConfidenceThreshold',
    'parameters.synthesizer.frictionSuppressThreshold',
    'parameters.synthesizer.cautionPenaltyMultiplier',
  ];

  return paths.reduce((changes, path) => {
    const from = getAtPath(basePolicy, path);
    const to = getAtPath(nextPolicy, path);
    if (from !== to) {
      changes.push({ path, from, to });
    }
    return changes;
  }, []);
}

function normalizeInputSnapshot(snapshot) {
  return normalizeBudgetSnapshot(snapshot);
}

function evaluateBudgetSnapshot(snapshotInput, policy, rules = {}) {
  const activePolicy = policy || buildDefaultChampionPolicy(rules);
  const context = buildDecisionContext(snapshotInput, activePolicy, rules);
  const specialists = evaluateSpecialists(context);
  return synthesizeDecision(context, specialists);
}

function createDecisionTrace({ scanId, mode = 'champion', policy, snapshot, evaluation, optimizationId = null, strategyContext = null }) {
  const normalizedSnapshot = normalizeInputSnapshot(snapshot);
  const timestamp = normalizedSnapshot.timestamp || nowIso();
  return {
    traceId: `trace_${scanId || Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    scanId: scanId ?? null,
    timestamp,
    mode,
    policyVersionId: policy?.id ?? DEFAULT_POLICY_ID,
    policyLabel: policy?.label ?? 'Budget Policy',
    controlSurface: normalizedSnapshot.controlSurface ?? null,
    entity: {
      targetId: normalizedSnapshot.targetId,
      targetName: normalizedSnapshot.targetName,
      level: normalizedSnapshot.targetLevel,
    },
    inputSnapshot: normalizedSnapshot,
    gates: evaluation?.gates ?? [],
    penalties: evaluation?.penalties ?? [],
    verdict: evaluation?.verdict ?? 'hold',
    confidence: evaluation?.confidence ?? 'low',
    blockers: evaluation?.blockers ?? [],
    cautions: evaluation?.cautions ?? [],
    rationaleSummary: evaluation?.rationaleSummary ?? '',
    reasoning: evaluation?.reasoning ?? '',
    impactSummary: evaluation?.impactSummary ?? '',
    shouldCreateOptimization: Boolean(evaluation?.shouldCreateOptimization),
    actionPercent: evaluation?.actionPercent ?? 0,
    actionDollars: evaluation?.actionDollars ?? 0,
    specialists: evaluation?.specialists ?? [],
    regimeTags: evaluation?.regimeTags ?? [],
    synthesis: evaluation?.synthesis ?? null,
    optimizationId,
    reviewWindowHours: evaluation?.reviewWindowHours ?? DEFAULT_REVIEW_WINDOW_HOURS,
    rewardWindowHours: evaluation?.rewardWindowHours ?? REWARD_WINDOW_HOURS,
    strategyContext: strategyContext ?? null,
  };
}

function summarizePolicyDiff(diffSummary) {
  if (!Array.isArray(diffSummary) || diffSummary.length === 0) {
    return 'No parameter changes';
  }

  return diffSummary
    .slice(0, 3)
    .map(change => `${change.path.split('.').slice(-1)[0]}: ${change.from} -> ${change.to}`)
    .join(' · ');
}

function buildStructuredCandidates(championPolicy, count = 3) {
  const champion = deepClone(championPolicy);
  const templates = [
    [
      ['parameters.scale.minPurchases', clamp(asNumber(getAtPath(champion, 'parameters.scale.minPurchases'), 8) - 1, 5, 20)],
      ['parameters.scale.minEstimatedMargin', clamp(asNumber(getAtPath(champion, 'parameters.scale.minEstimatedMargin'), 0.08) + 0.02, 0.04, 0.3)],
      ['parameters.penalties.confidence', clamp(asNumber(getAtPath(champion, 'parameters.penalties.confidence'), 1) + 0.25, 0, 3)],
      ['parameters.penalties.measurementTrust', clamp(asNumber(getAtPath(champion, 'parameters.penalties.measurementTrust'), 1.25) + 0.25, 0.5, 3)],
      ['parameters.specialists.measurementTrust', clamp(asNumber(getAtPath(champion, 'parameters.specialists.measurementTrust'), 1.25) + 0.15, 0.5, 2.5)],
      ['parameters.specialists.confidence', clamp(asNumber(getAtPath(champion, 'parameters.specialists.confidence'), 1.05) + 0.15, 0.5, 2.5)],
      ['parameters.synthesizer.frictionLowConfidenceThreshold', clamp(asNumber(getAtPath(champion, 'parameters.synthesizer.frictionLowConfidenceThreshold'), 3.5) - 0.35, 2, 6)],
    ],
    [
      ['parameters.scale.minCoverageRatio', clamp(asNumber(getAtPath(champion, 'parameters.scale.minCoverageRatio'), 0.8) + 0.05, 0.5, 0.98)],
      ['parameters.scale.cautionStepPercentCap', clamp(asNumber(getAtPath(champion, 'parameters.scale.cautionStepPercentCap'), 10) - 2, 5, 20)],
      ['parameters.penalties.fatigue', clamp(asNumber(getAtPath(champion, 'parameters.penalties.fatigue'), 1) + 0.5, 0, 3)],
      ['parameters.specialists.fatigue', clamp(asNumber(getAtPath(champion, 'parameters.specialists.fatigue'), 1.1) + 0.2, 0.5, 2.5)],
      ['parameters.synthesizer.cautionPenaltyMultiplier', clamp(asNumber(getAtPath(champion, 'parameters.synthesizer.cautionPenaltyMultiplier'), 0.75) + 0.05, 0.25, 2)],
    ],
    [
      ['parameters.reduce.cpaWarningThreshold', clamp(asNumber(getAtPath(champion, 'parameters.reduce.cpaWarningThreshold'), 30) - 2, 10, 100)],
      ['parameters.scale.maxStepPercent', clamp(asNumber(getAtPath(champion, 'parameters.scale.maxStepPercent'), 20) - 2, 5, 40)],
      ['parameters.penalties.concentration', clamp(asNumber(getAtPath(champion, 'parameters.penalties.concentration'), 1) + 0.5, 0, 3)],
      ['parameters.specialists.structure', clamp(asNumber(getAtPath(champion, 'parameters.specialists.structure'), 1) + 0.2, 0.5, 2.5)],
      ['parameters.specialists.economics', clamp(asNumber(getAtPath(champion, 'parameters.specialists.economics'), 1.2) + 0.15, 0.5, 2.5)],
    ],
  ];

  return templates.slice(0, count).map((changes, index) => {
    const candidate = deepClone(champion);
    changes.forEach(([path, value]) => setAtPath(candidate, path, value));
    candidate.id = `${champion.id}-cand-${index + 1}`;
    candidate.label = `Challenger ${index + 1}`;
    candidate.status = 'challenger';
    candidate.parentPolicyId = champion.id;
    candidate.createdAt = nowIso();
    candidate.mutationStrategy = 'structured_search';
    candidate.diffSummary = buildPolicyDiff(champion, candidate);
    candidate.scoreSummary = null;
    candidate.summaryLine = summarizePolicyDiff(candidate.diffSummary);
    return candidate;
  });
}

module.exports = {
  DEFAULT_POLICY_ID,
  DEFAULT_REVIEW_WINDOW_HOURS,
  REWARD_WINDOW_HOURS,
  buildDefaultChampionPolicy,
  buildPolicyDiff,
  normalizeInputSnapshot,
  evaluateBudgetSnapshot,
  createDecisionTrace,
  buildStructuredCandidates,
  summarizePolicyDiff,
  computeReward,
  bucketReward,
};
