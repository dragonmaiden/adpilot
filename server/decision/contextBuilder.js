const { asNumber, ratio, uniqueStrings } = require('./utils');

const DEFAULT_REVIEW_WINDOW_HOURS = 72;
const REWARD_WINDOW_HOURS = 72;

function nowIso() {
  return new Date().toISOString();
}

function normalizeBudgetSnapshot(snapshot) {
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
    risk: {
      activeCampaignCount: asNumber(snapshot?.risk?.activeCampaignCount, 0),
      activeAdCount: asNumber(snapshot?.risk?.activeAdCount, 0),
      severeFatigueBlock: Boolean(snapshot?.risk?.severeFatigueBlock),
      hasConcentrationRisk: Boolean(snapshot?.risk?.hasConcentrationRisk),
      hasCreativeDepthRisk: Boolean(snapshot?.risk?.hasCreativeDepthRisk),
      fatiguedAds: Array.isArray(snapshot?.risk?.fatiguedAds) ? snapshot.risk.fatiguedAds.slice(0, 5) : [],
    },
    measurementTrust: {
      level: snapshot?.measurementTrust?.level ?? 'low',
      label: snapshot?.measurementTrust?.label ?? 'Freeze budget changes',
      shouldFreezeBudgetChanges: Boolean(snapshot?.measurementTrust?.shouldFreezeBudgetChanges),
      canScale: Boolean(snapshot?.measurementTrust?.canScale),
      shouldProceedWithBudgetChanges: Boolean(snapshot?.measurementTrust?.shouldProceedWithBudgetChanges),
      hasReliableCoverage: Boolean(snapshot?.measurementTrust?.hasReliableCoverage),
      hasFreshRevenue: Boolean(snapshot?.measurementTrust?.hasFreshRevenue),
      coverageRatio: asNumber(snapshot?.measurementTrust?.coverageRatio, 0),
      confidence: snapshot?.measurementTrust?.confidence ?? 'low',
      reason: snapshot?.measurementTrust?.reason ?? '',
      blockingIssues: Array.isArray(snapshot?.measurementTrust?.blockingIssues)
        ? snapshot.measurementTrust.blockingIssues.slice(0, 4)
        : [],
      cautionIssues: Array.isArray(snapshot?.measurementTrust?.cautionIssues)
        ? snapshot.measurementTrust.cautionIssues.slice(0, 4)
        : [],
      degradedSources: Array.isArray(snapshot?.measurementTrust?.degradedSources)
        ? snapshot.measurementTrust.degradedSources.slice(0, 4)
        : [],
    },
    reviewWindowHours: asNumber(snapshot?.reviewWindowHours, DEFAULT_REVIEW_WINDOW_HOURS),
    timestamp: snapshot?.timestamp ?? nowIso(),
  };
}

function buildSpecialistWeights(parameters = {}) {
  const specialistWeights = parameters.specialists || {};
  return {
    measurementTrust: asNumber(specialistWeights.measurementTrust, 1.2),
    economics: asNumber(specialistWeights.economics, 1),
    confidence: asNumber(specialistWeights.confidence, 1),
    fatigue: asNumber(specialistWeights.fatigue, 1),
    structure: asNumber(specialistWeights.structure, 1),
    scaleSizer: asNumber(specialistWeights.scaleSizer, 1),
    reduceSizer: asNumber(specialistWeights.reduceSizer, 1),
  };
}

function buildRegimeTags(snapshot, derived) {
  const tags = [
    snapshot.targetLevel === 'campaign' ? 'campaign_target' : 'adset_target',
    snapshot.measurementTrust.level ? `trust_${snapshot.measurementTrust.level}` : null,
    snapshot.measurementTrust.shouldFreezeBudgetChanges ? 'trust_frozen' : 'trust_open',
    derived.reliableEconomics ? 'economics_reliable' : 'economics_unreliable',
    snapshot.economics.confidence ? `${snapshot.economics.confidence}_confidence` : null,
    derived.evidenceStrong ? 'evidence_strong' : 'evidence_thin',
    snapshot.economics.estimatedTrueNetProfit > 0 ? 'profit_positive' : 'profit_nonpositive',
  ];

  if (snapshot.risk.hasConcentrationRisk) tags.push('concentrated_account');
  if (snapshot.risk.hasCreativeDepthRisk) tags.push('thin_creative_depth');
  if (snapshot.risk.severeFatigueBlock) tags.push('fatigue_blocked');
  else if (snapshot.risk.fatiguedAds.length > 0) tags.push('fatigue_pressure');
  if (derived.reduceRecommended) tags.push('reduction_pressure');
  if (derived.positiveHeadroomRatio >= 0.15) tags.push('scaling_headroom');
  if (snapshot.avgCpa != null && snapshot.economics.targetCpa != null && snapshot.avgCpa <= snapshot.economics.targetCpa) {
    tags.push('cpa_within_target');
  }
  if (snapshot.avgCpa != null && snapshot.economics.breakEvenCpa != null && snapshot.avgCpa > snapshot.economics.breakEvenCpa) {
    tags.push('cpa_above_break_even');
  }

  return uniqueStrings(tags);
}

function buildDecisionContext(snapshotInput, policy, rules = {}) {
  const snapshot = normalizeBudgetSnapshot(snapshotInput);
  const activePolicy = policy || { parameters: {} };
  const scaleParams = activePolicy.parameters?.scale || {};
  const reduceParams = activePolicy.parameters?.reduce || {};
  const penaltyWeights = activePolicy.parameters?.penalties || {};
  const synthesizer = activePolicy.parameters?.synthesizer || {};
  const specialistWeights = buildSpecialistWeights(activePolicy.parameters || {});

  const evidenceStrong = (
    snapshot.evidence.observationDays >= asNumber(scaleParams.minObservationDays, 3)
    && snapshot.evidence.purchases >= asNumber(scaleParams.minPurchases, 8)
    && snapshot.evidence.purchaseDays >= asNumber(scaleParams.minPurchaseDays, 3)
    && snapshot.evidence.spend >= asNumber(rules.minSpendForDecision, 20)
  );
  const reliableEconomics = Boolean(snapshot.economics.hasReliableEstimate);
  const healthyCoverage = snapshot.economics.coverageRatio >= asNumber(scaleParams.minCoverageRatio, 0.8);
  const healthyMargin = snapshot.economics.estimatedMargin >= asNumber(scaleParams.minEstimatedMargin, 0.08);
  const trustHealthy = !snapshot.measurementTrust.shouldFreezeBudgetChanges;
  const avgCpa = snapshot.avgCpa;
  const positiveHeadroomRatio = (avgCpa != null && snapshot.economics.targetCpa != null && snapshot.economics.targetCpa > 0)
    ? ratio(snapshot.economics.targetCpa - avgCpa, snapshot.economics.targetCpa, 0)
    : 0;
  const reduceRecommended = avgCpa != null && avgCpa > asNumber(reduceParams.cpaWarningThreshold, 30);
  const reduceCritical = avgCpa != null && avgCpa > asNumber(reduceParams.cpaPauseThreshold, 50);

  const derived = {
    avgCpa,
    evidenceStrong,
    reliableEconomics,
    healthyCoverage,
    healthyMargin,
    trustHealthy,
    positiveHeadroomRatio,
    reduceRecommended,
    reduceCritical,
    reviewWindowHours: asNumber(snapshot.reviewWindowHours, activePolicy.reviewWindowHours || DEFAULT_REVIEW_WINDOW_HOURS),
    rewardWindowHours: asNumber(activePolicy.parameters?.reward?.horizonHours, REWARD_WINDOW_HOURS),
  };

  return {
    snapshot,
    policy: activePolicy,
    rules,
    scaleParams,
    reduceParams,
    penaltyWeights,
    synthesizer: {
      frictionCautionThreshold: asNumber(synthesizer.frictionCautionThreshold, 2.2),
      frictionLowConfidenceThreshold: asNumber(synthesizer.frictionLowConfidenceThreshold, 3.5),
      frictionSuppressThreshold: asNumber(synthesizer.frictionSuppressThreshold, 5),
      cautionPenaltyMultiplier: asNumber(synthesizer.cautionPenaltyMultiplier, 0.75),
    },
    specialistWeights,
    derived,
    regimeTags: buildRegimeTags(snapshot, derived),
  };
}

module.exports = {
  DEFAULT_REVIEW_WINDOW_HOURS,
  REWARD_WINDOW_HOURS,
  normalizeBudgetSnapshot,
  buildDecisionContext,
};
