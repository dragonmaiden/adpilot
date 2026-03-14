const DEFAULT_POLICY_ID = 'budget-policy-champion-v1';
const DEFAULT_REVIEW_WINDOW_HOURS = 72;
const REWARD_WINDOW_HOURS = 72;

function nowIso() {
  return new Date().toISOString();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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
        weekdayCautionRatio: 1.15,
        weekdaySuppressRatio: 1.4,
        trendCautionRatio: 1.2,
        trendSuppressRatio: 1.45,
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
    'parameters.scale.weekdayCautionRatio',
    'parameters.scale.weekdaySuppressRatio',
    'parameters.scale.trendCautionRatio',
    'parameters.scale.trendSuppressRatio',
    'parameters.scale.cautionStepPercentCap',
    'parameters.scale.maxStepPercent',
    'parameters.reduce.cpaWarningThreshold',
    'parameters.reduce.maxReductionPercent',
    'parameters.penalties.concentration',
    'parameters.penalties.fatigue',
    'parameters.penalties.creativeDepth',
    'parameters.penalties.confidence',
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

function classifyControlSurface({ level, campaign, adSet, adSets = [] }) {
  if (level === 'adset') {
    if (adSet?.daily_budget) return 'adset_budget_controlled';
    if (campaign?.daily_budget) return 'campaign_budget_controlled';
    return 'mixed_or_unsupported';
  }

  if (campaign?.daily_budget) return 'campaign_budget_controlled';

  const hasDailyBudgetedAdSets = (Array.isArray(adSets) ? adSets : [])
    .some(entry => entry?.campaign_id === campaign?.id && entry?.daily_budget);
  if (hasDailyBudgetedAdSets) {
    return 'adset_budget_controlled';
  }

  return 'mixed_or_unsupported';
}

function buildPenalty(type, weight, detail) {
  return {
    type,
    weight: asNumber(weight, 0),
    detail,
  };
}

function normalizeInputSnapshot(snapshot) {
  return {
    targetId: snapshot?.targetId ?? '',
    targetName: snapshot?.targetName ?? '',
    targetLevel: snapshot?.targetLevel ?? 'campaign',
    currentBudgetCents: asNumber(snapshot?.currentBudgetCents, 0),
    avgCpa: snapshot?.avgCpa == null ? null : asNumber(snapshot.avgCpa, null),
    spend: asNumber(snapshot?.spend, 0),
    purchases: asNumber(snapshot?.purchases, 0),
    evidence: {
      observationDays: asNumber(snapshot?.evidence?.observationDays, 0),
      purchaseDays: asNumber(snapshot?.evidence?.purchaseDays, 0),
      spend: asNumber(snapshot?.evidence?.spend, 0),
      purchases: asNumber(snapshot?.evidence?.purchases, 0),
      cpa: snapshot?.evidence?.cpa == null ? null : asNumber(snapshot.evidence.cpa, null),
    },
    economics: {
      targetCpa: snapshot?.economics?.targetCpa == null ? null : asNumber(snapshot.economics.targetCpa, null),
      breakEvenCpa: snapshot?.economics?.breakEvenCpa == null ? null : asNumber(snapshot.economics.breakEvenCpa, null),
      estimatedRevenue: asNumber(snapshot?.economics?.estimatedRevenue, 0),
      estimatedTrueNetProfit: asNumber(snapshot?.economics?.estimatedTrueNetProfit, 0),
      estimatedMargin: asNumber(snapshot?.economics?.estimatedMargin, 0),
      coverageRatio: asNumber(snapshot?.economics?.coverageRatio, 0),
      confidence: snapshot?.economics?.confidence ?? 'low',
      confidenceLabel: snapshot?.economics?.confidenceLabel ?? 'Low confidence',
      hasReliableEstimate: Boolean(snapshot?.economics?.hasReliableEstimate),
    },
    weekday: {
      status: snapshot?.weekday?.status ?? 'neutral',
      reason: snapshot?.weekday?.reason ?? '',
      weaknessRatio: snapshot?.weekday?.weaknessRatio == null ? null : asNumber(snapshot.weekday.weaknessRatio, null),
    },
    trend: {
      status: snapshot?.trend?.status ?? 'neutral',
      reason: snapshot?.trend?.reason ?? '',
      weaknessRatio: snapshot?.trend?.weaknessRatio == null ? null : asNumber(snapshot.trend.weaknessRatio, null),
    },
    risk: {
      activeCampaignCount: asNumber(snapshot?.risk?.activeCampaignCount, 0),
      activeAdCount: asNumber(snapshot?.risk?.activeAdCount, 0),
      severeFatigueBlock: Boolean(snapshot?.risk?.severeFatigueBlock),
      hasConcentrationRisk: Boolean(snapshot?.risk?.hasConcentrationRisk),
      hasCreativeDepthRisk: Boolean(snapshot?.risk?.hasCreativeDepthRisk),
      fatiguedAds: Array.isArray(snapshot?.risk?.fatiguedAds) ? snapshot.risk.fatiguedAds.slice(0, 5) : [],
    },
    controlSurface: snapshot?.controlSurface ?? 'mixed_or_unsupported',
    reviewWindowHours: asNumber(snapshot?.reviewWindowHours, DEFAULT_REVIEW_WINDOW_HOURS),
    timestamp: snapshot?.timestamp ?? nowIso(),
  };
}

function evaluateBudgetSnapshot(snapshotInput, policy, rules = {}) {
  const snapshot = normalizeInputSnapshot(snapshotInput);
  const activePolicy = policy || buildDefaultChampionPolicy(rules);
  const reviewWindowHours = asNumber(snapshot.reviewWindowHours, activePolicy.reviewWindowHours || DEFAULT_REVIEW_WINDOW_HOURS);
  const gates = [];
  const penalties = [];
  const blockers = [];
  const cautions = [];
  const scaleParams = activePolicy.parameters?.scale || {};
  const reduceParams = activePolicy.parameters?.reduce || {};
  const penaltyWeights = activePolicy.parameters?.penalties || {};

  const evidenceStrong = (
    snapshot.evidence.observationDays >= asNumber(scaleParams.minObservationDays, 3)
    && snapshot.evidence.purchases >= asNumber(scaleParams.minPurchases, 8)
    && snapshot.evidence.purchaseDays >= asNumber(scaleParams.minPurchaseDays, 3)
    && snapshot.evidence.spend >= asNumber(rules.minSpendForDecision, 20)
  );
  gates.push({
    key: 'evidence_strength',
    passed: evidenceStrong,
    detail: `${snapshot.evidence.observationDays} days · ${snapshot.evidence.purchaseDays} purchase days · ${snapshot.evidence.purchases} purchases`,
  });

  const reliableEconomics = Boolean(snapshot.economics.hasReliableEstimate);
  gates.push({
    key: 'economics_reliable',
    passed: reliableEconomics,
    detail: snapshot.economics.confidenceLabel,
  });

  const hasHealthyCoverage = snapshot.economics.coverageRatio >= asNumber(scaleParams.minCoverageRatio, 0.8);
  gates.push({
    key: 'coverage',
    passed: hasHealthyCoverage,
    detail: `${(snapshot.economics.coverageRatio * 100).toFixed(1)}%`,
  });

  const hasHealthyMargin = snapshot.economics.estimatedMargin >= asNumber(scaleParams.minEstimatedMargin, 0.08);
  gates.push({
    key: 'margin',
    passed: hasHealthyMargin,
    detail: `${(snapshot.economics.estimatedMargin * 100).toFixed(1)}%`,
  });

  if (snapshot.controlSurface === 'mixed_or_unsupported') {
    blockers.push('Budget ownership is mixed or unsupported for this target');
  }

  if (snapshot.targetLevel === 'campaign' && snapshot.controlSurface !== 'campaign_budget_controlled') {
    blockers.push('Campaign budget is not the active control surface for this target');
  }

  if (snapshot.targetLevel === 'adset' && snapshot.controlSurface !== 'adset_budget_controlled') {
    blockers.push('Ad set budget is controlled at the campaign level');
  }

  const avgCpa = snapshot.avgCpa;
  if (avgCpa != null && avgCpa > asNumber(reduceParams.cpaWarningThreshold, 30)) {
    if (blockers.length > 0) {
      return {
        verdict: 'suppress',
        shouldCreateOptimization: false,
        actionPercent: 0,
        actionDollars: 0,
        priority: 'low',
        confidence: reliableEconomics ? 'medium' : 'low',
        blockers,
        cautions,
        penalties,
        gates,
        rationaleSummary: blockers[0],
        reasoning: blockers.join('; '),
        impactSummary: 'No budget change should be proposed from this context.',
        reviewWindowHours,
        rewardWindowHours: asNumber(activePolicy.parameters?.reward?.horizonHours, REWARD_WINDOW_HOURS),
      };
    }

    const reducePercent = clamp(
      asNumber(reduceParams.maxReductionPercent, 15),
      1,
      asNumber(rules.maxBudgetChangePercent, 20)
    );
    const verdict = 'reduce';
    const actionPercent = reducePercent;
    const currentBudgetCents = snapshot.currentBudgetCents;
    const impactBudget = currentBudgetCents > 0
      ? Math.round(currentBudgetCents * (actionPercent / 100))
      : 0;
    const rationaleSummary = `CPA ${avgCpa.toFixed(2)} is above the policy warning threshold of ${asNumber(reduceParams.cpaWarningThreshold, 30).toFixed(2)}`;
    return {
      verdict,
      shouldCreateOptimization: snapshot.targetLevel === 'campaign' || snapshot.targetLevel === 'adset',
      actionPercent,
      actionDollars: impactBudget / 100,
      priority: avgCpa > asNumber(reduceParams.cpaPauseThreshold, 50) ? 'critical' : 'high',
      confidence: reliableEconomics ? 'medium' : 'low',
      blockers,
      cautions,
      penalties,
      gates,
      rationaleSummary,
      reasoning: rationaleSummary,
      impactSummary: `Reduce spend by about $${(impactBudget / 100).toFixed(2)} per day and review again within ${reviewWindowHours} hours.`,
      reviewWindowHours,
      rewardWindowHours: asNumber(activePolicy.parameters?.reward?.horizonHours, REWARD_WINDOW_HOURS),
    };
  }

  if (!evidenceStrong) blockers.push('Recent delivery evidence is too thin to scale confidently');
  if (avgCpa == null) blockers.push('Recent CPA is unavailable');
  if (!reliableEconomics) blockers.push('Campaign economics are not reliable enough');
  if (!hasHealthyCoverage) blockers.push('COGS coverage is below the minimum scale threshold');
  if (!hasHealthyMargin) blockers.push('Estimated contribution margin is below the minimum scale threshold');

  if (snapshot.economics.estimatedTrueNetProfit <= 0) {
    blockers.push('Estimated contribution profit is not positive');
  }

  if (avgCpa != null && snapshot.economics.breakEvenCpa != null && avgCpa > snapshot.economics.breakEvenCpa) {
    blockers.push(`CPA ${avgCpa.toFixed(2)} is above break-even ${snapshot.economics.breakEvenCpa.toFixed(2)}`);
  } else if (avgCpa != null && snapshot.economics.targetCpa != null && avgCpa > snapshot.economics.targetCpa) {
    blockers.push(`CPA ${avgCpa.toFixed(2)} is above target ${snapshot.economics.targetCpa.toFixed(2)}`);
  }

  if (snapshot.weekday.status === 'suppress') blockers.push(snapshot.weekday.reason || 'Weekday delivery is materially soft');
  if (snapshot.trend.status === 'suppress') blockers.push(snapshot.trend.reason || 'Recent trend is materially soft');

  if (snapshot.weekday.status === 'caution') cautions.push(snapshot.weekday.reason || 'Weekday delivery is soft');
  if (snapshot.trend.status === 'caution') cautions.push(snapshot.trend.reason || 'Recent trend is soft');

  if (snapshot.economics.confidence !== 'high') {
    const penalty = buildPenalty('confidence', penaltyWeights.confidence, snapshot.economics.confidenceLabel);
    penalties.push(penalty);
    cautions.push(snapshot.economics.confidenceLabel);
  }

  if (snapshot.risk.severeFatigueBlock) {
    blockers.push(`${snapshot.risk.fatiguedAds.length}/${snapshot.risk.activeAdCount} active ads show severe fatigue`);
  } else if (snapshot.risk.fatiguedAds.length > 0) {
    penalties.push(buildPenalty('fatigue', penaltyWeights.fatigue, `${snapshot.risk.fatiguedAds.length} fatigued ads`));
    cautions.push(`${snapshot.risk.fatiguedAds.length}/${snapshot.risk.activeAdCount} active ads show fatigue`);
  }

  if (snapshot.risk.hasConcentrationRisk) {
    penalties.push(buildPenalty('concentration', penaltyWeights.concentration, `${snapshot.risk.activeCampaignCount} active campaign carrying spend`));
    cautions.push(`${snapshot.risk.activeCampaignCount} active campaign is carrying spend`);
  }

  if (snapshot.risk.hasCreativeDepthRisk) {
    penalties.push(buildPenalty('creative_depth', penaltyWeights.creativeDepth, `${snapshot.risk.activeAdCount} active ads available`));
    cautions.push(`Only ${snapshot.risk.activeAdCount} active ads are available to absorb extra budget`);
  }

  if (blockers.length > 0) {
    return {
      verdict: 'suppress',
      shouldCreateOptimization: false,
      actionPercent: 0,
      actionDollars: 0,
      priority: 'low',
      confidence: reliableEconomics ? 'medium' : 'low',
      blockers,
      cautions,
      penalties,
      gates,
      rationaleSummary: blockers[0],
      reasoning: blockers.join('; '),
      impactSummary: 'No budget increase should be proposed from this context.',
      reviewWindowHours,
      rewardWindowHours: asNumber(activePolicy.parameters?.reward?.horizonHours, REWARD_WINDOW_HOURS),
    };
  }

  const totalPenaltyWeight = penalties.reduce((sum, penalty) => sum + asNumber(penalty.weight, 0), 0);
  const cautionCount = cautions.length + (totalPenaltyWeight > 0 ? 1 : 0);
  const actionPercent = cautionCount >= 3
    ? Math.min(asNumber(scaleParams.cautionStepPercentCap, 10), asNumber(rules.maxBudgetChangePercent, 20))
    : Math.min(asNumber(scaleParams.maxStepPercent, asNumber(rules.maxBudgetChangePercent, 20)), asNumber(rules.maxBudgetChangePercent, 20));
  const actionBudgetDelta = snapshot.currentBudgetCents > 0
    ? Math.round(snapshot.currentBudgetCents * (actionPercent / 100))
    : 0;
  const confidence = snapshot.economics.confidence === 'high' && cautionCount === 0
    ? 'high'
    : cautionCount >= 3 ? 'low' : 'medium';
  const rationaleSummary = `CPA ${avgCpa.toFixed(2)} supports scaling against target ${snapshot.economics.targetCpa != null ? snapshot.economics.targetCpa.toFixed(2) : 'n/a'} with ${snapshot.purchases} purchases in view.`;
  const impactLabel = actionBudgetDelta > 0
    ? `Increase budget by about $${(actionBudgetDelta / 100).toFixed(2)} per day and review again within ${reviewWindowHours} hours.`
    : `Hold current budget and review again within ${reviewWindowHours} hours.`;

  return {
    verdict: actionBudgetDelta > 0 ? 'scale' : 'hold',
    shouldCreateOptimization: actionBudgetDelta > 0,
    actionPercent,
    actionDollars: actionBudgetDelta / 100,
    priority: cautionCount > 0 ? 'low' : 'medium',
    confidence,
    blockers,
    cautions,
    penalties,
    gates,
    rationaleSummary,
    reasoning: cautions.length > 0 ? `${rationaleSummary} Caveats: ${cautions.join('; ')}.` : rationaleSummary,
    impactSummary: impactLabel,
    reviewWindowHours,
    rewardWindowHours: asNumber(activePolicy.parameters?.reward?.horizonHours, REWARD_WINDOW_HOURS),
  };
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
    controlSurface: normalizedSnapshot.controlSurface,
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
      ['parameters.scale.trendCautionRatio', clamp(asNumber(getAtPath(champion, 'parameters.scale.trendCautionRatio'), 1.2) + 0.05, 1.05, 2)],
      ['parameters.penalties.confidence', clamp(asNumber(getAtPath(champion, 'parameters.penalties.confidence'), 1) + 0.25, 0, 3)],
    ],
    [
      ['parameters.scale.minCoverageRatio', clamp(asNumber(getAtPath(champion, 'parameters.scale.minCoverageRatio'), 0.8) + 0.05, 0.5, 0.98)],
      ['parameters.scale.cautionStepPercentCap', clamp(asNumber(getAtPath(champion, 'parameters.scale.cautionStepPercentCap'), 10) - 2, 5, 20)],
      ['parameters.penalties.fatigue', clamp(asNumber(getAtPath(champion, 'parameters.penalties.fatigue'), 1) + 0.5, 0, 3)],
    ],
    [
      ['parameters.reduce.cpaWarningThreshold', clamp(asNumber(getAtPath(champion, 'parameters.reduce.cpaWarningThreshold'), 30) - 2, 10, 100)],
      ['parameters.scale.weekdaySuppressRatio', clamp(asNumber(getAtPath(champion, 'parameters.scale.weekdaySuppressRatio'), 1.4) - 0.1, 1.1, 2)],
      ['parameters.penalties.concentration', clamp(asNumber(getAtPath(champion, 'parameters.penalties.concentration'), 1) + 0.5, 0, 3)],
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

function bucketReward(value) {
  if (!Number.isFinite(value)) return 'unknown';
  if (value >= 100000) return 'strong_positive';
  if (value > 0) return 'positive';
  if (value <= -100000) return 'strong_negative';
  if (value < 0) return 'negative';
  return 'flat';
}

function computeReward({
  baseline = {},
  horizon = {},
  policy = buildDefaultChampionPolicy(),
  reversalDetected = false,
  churnCount = 0,
}) {
  const rewardParams = policy.parameters?.reward || {};
  const baselineCpa = baseline.cpa == null ? null : asNumber(baseline.cpa, null);
  const horizonCpa = horizon.cpa == null ? null : asNumber(horizon.cpa, null);
  const baselineProfit = asNumber(baseline.estimatedTrueNetProfit, 0);
  const horizonProfit = asNumber(horizon.estimatedTrueNetProfit, 0);
  const realizedProfitDelta = horizonProfit - baselineProfit;
  let score = realizedProfitDelta;
  const components = [];

  components.push({
    type: 'profit_delta',
    value: realizedProfitDelta,
  });

  if (baselineCpa != null && horizonCpa != null && horizonCpa > baselineCpa * (1 + asNumber(rewardParams.cpaPenaltyRatio, 0.15))) {
    const cpaPenalty = Math.round((horizonCpa - baselineCpa) * 1000);
    score -= cpaPenalty;
    components.push({ type: 'cpa_penalty', value: -cpaPenalty });
  }

  if (asNumber(horizon.volatilityScore, 0) > 0) {
    const volatilityPenalty = Math.round(asNumber(horizon.volatilityScore, 0) * 1000);
    score -= volatilityPenalty;
    components.push({ type: 'volatility_penalty', value: -volatilityPenalty });
  }

  if (asNumber(horizon.confidencePenalty, 0) > 0) {
    const confidencePenalty = Math.round(asNumber(horizon.confidencePenalty, 0));
    score -= confidencePenalty;
    components.push({ type: 'confidence_penalty', value: -confidencePenalty });
  }

  if (reversalDetected) {
    const reversalPenalty = 25000;
    score -= reversalPenalty;
    components.push({ type: 'reversal_penalty', value: -reversalPenalty });
  }

  if (churnCount > 0) {
    const churnPenalty = churnCount * 5000;
    score -= churnPenalty;
    components.push({ type: 'churn_penalty', value: -churnPenalty });
  }

  return {
    total: Math.round(score),
    components,
    rewardBucket: bucketReward(score),
    realizedProfitDelta,
  };
}

module.exports = {
  DEFAULT_POLICY_ID,
  DEFAULT_REVIEW_WINDOW_HOURS,
  REWARD_WINDOW_HOURS,
  buildDefaultChampionPolicy,
  buildPolicyDiff,
  classifyControlSurface,
  normalizeInputSnapshot,
  evaluateBudgetSnapshot,
  createDecisionTrace,
  buildStructuredCandidates,
  summarizePolicyDiff,
  computeReward,
  bucketReward,
};
