const {
  evaluateBudgetSnapshot,
  buildStructuredCandidates,
  buildPolicyDiff,
  summarizePolicyDiff,
} = require('./budgetPolicyService');

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function estimateCounterfactualReward(candidateVerdict, actualVerdict, actualReward, rewardParams = {}) {
  const negativeRewardMultiplier = asNumber(rewardParams.negativeRewardMultiplier, 0.75);
  const missedUpsidePenaltyMultiplier = asNumber(rewardParams.missedUpsidePenaltyMultiplier, 0.5);
  const contradictionPenaltyMultiplier = asNumber(rewardParams.contradictionPenaltyMultiplier, 1);
  const reward = asNumber(actualReward, 0);

  if (candidateVerdict === actualVerdict) {
    return reward;
  }

  if ((candidateVerdict === 'hold' || candidateVerdict === 'suppress') && reward < 0) {
    return Math.round(Math.abs(reward) * negativeRewardMultiplier);
  }

  if ((candidateVerdict === 'hold' || candidateVerdict === 'suppress') && reward > 0) {
    return Math.round(-reward * missedUpsidePenaltyMultiplier);
  }

  if (candidateVerdict === 'reduce' && actualVerdict === 'scale') {
    return reward < 0
      ? Math.round(Math.abs(reward) * negativeRewardMultiplier)
      : Math.round(-reward * missedUpsidePenaltyMultiplier);
  }

  if (candidateVerdict === 'scale' && actualVerdict === 'reduce') {
    return Math.round(-Math.abs(reward) * contradictionPenaltyMultiplier);
  }

  return Math.round(-Math.abs(reward) * 0.5);
}

function buildReplaySample(outcomes, tracesById) {
  return (Array.isArray(outcomes) ? outcomes : [])
    .filter(outcome => outcome?.status === 'complete' && Number.isFinite(Number(outcome?.finalReward?.total)))
    .map(outcome => {
      const trace = tracesById.get(outcome.traceId);
      if (!trace || !trace.inputSnapshot) return null;
      if (trace.inputSnapshot?.measurementTrust?.shouldFreezeBudgetChanges) return null;
      return {
        outcome,
        trace,
      };
    })
    .filter(Boolean);
}

function buildBootstrapReplaySample(traces) {
  return (Array.isArray(traces) ? traces : [])
    .filter(trace =>
      trace?.mode === 'champion'
      && trace?.inputSnapshot
      && !trace?.inputSnapshot?.measurementTrust?.shouldFreezeBudgetChanges
    )
    .slice(-250)
    .map(trace => ({
      trace,
      outcome: null,
    }));
}

function deriveProxyIdealVerdict(snapshot, rules = {}) {
  const avgCpa = asNumber(snapshot?.avgCpa, null);
  const targetCpa = asNumber(snapshot?.economics?.targetCpa, null);
  const breakEvenCpa = asNumber(snapshot?.economics?.breakEvenCpa, null);
  const reliableEconomics = Boolean(snapshot?.economics?.hasReliableEstimate);
  const coverageRatio = asNumber(snapshot?.economics?.coverageRatio, 0);
  const estimatedMargin = asNumber(snapshot?.economics?.estimatedMargin, 0);
  const estimatedProfit = asNumber(snapshot?.economics?.estimatedTrueNetProfit, 0);
  const trustFrozen = Boolean(snapshot?.measurementTrust?.shouldFreezeBudgetChanges);
  const evidence = snapshot?.evidence || {};
  const evidenceStrong = (
    asNumber(evidence.observationDays, 0) >= 3
    && asNumber(evidence.purchaseDays, 0) >= 3
    && asNumber(evidence.purchases, 0) >= 8
    && asNumber(evidence.spend, 0) >= asNumber(rules.minSpendForDecision, 20)
  );

  if (trustFrozen) return 'suppress';
  if (snapshot?.controlSurface === 'mixed_or_unsupported') return 'suppress';
  if (snapshot?.targetLevel === 'adset' && snapshot?.controlSurface !== 'adset_budget_controlled') return 'suppress';
  if (!reliableEconomics || coverageRatio < 0.8 || estimatedMargin < 0.08 || estimatedProfit <= 0) return 'suppress';
  if (snapshot?.risk?.severeFatigueBlock) return 'suppress';
  if (snapshot?.weekday?.status === 'suppress' || snapshot?.trend?.status === 'suppress') return 'suppress';

  if (avgCpa != null) {
    if (breakEvenCpa != null && avgCpa > breakEvenCpa) return 'reduce';
    if (targetCpa != null && avgCpa > targetCpa * 1.05) return 'reduce';
  }

  const positiveHeadroom = (avgCpa != null && targetCpa != null && targetCpa > 0)
    ? (targetCpa - avgCpa) / targetCpa
    : 0;

  if (evidenceStrong && positiveHeadroom >= 0.15) {
    return 'scale';
  }

  return 'hold';
}

function scoreProxyDecision(snapshot, decision, rules = {}) {
  const ideal = deriveProxyIdealVerdict(snapshot, rules);
  const verdict = decision?.verdict || 'hold';
  const purchases = asNumber(snapshot?.purchases, 0);
  const profit = Math.max(0, asNumber(snapshot?.economics?.estimatedTrueNetProfit, 0));
  const evidenceFactor = Math.max(0.5, Math.min(2.5, purchases / 25 || 0.5));
  const profitFactor = Math.max(0.6, Math.min(3, profit / 500000 || 0.6));
  const base = Math.round(15000 * evidenceFactor * profitFactor);
  const mild = Math.round(base * 0.35);

  if (ideal === 'scale') {
    if (verdict === 'scale') return base;
    if (verdict === 'hold') return mild;
    if (verdict === 'suppress') return -Math.round(base * 1.1);
    if (verdict === 'reduce') return -Math.round(base * 1.25);
  }

  if (ideal === 'reduce') {
    if (verdict === 'reduce') return base;
    if (verdict === 'suppress') return Math.round(base * 0.7);
    if (verdict === 'hold') return mild;
    if (verdict === 'scale') return -Math.round(base * 1.2);
  }

  if (ideal === 'suppress') {
    if (verdict === 'suppress') return base;
    if (verdict === 'hold') return Math.round(base * 0.8);
    if (verdict === 'reduce') return Math.round(base * 0.55);
    if (verdict === 'scale') return -Math.round(base * 1.4);
  }

  if (verdict === 'hold') return base;
  if (verdict === 'suppress') return Math.round(base * 0.6);
  if (verdict === 'reduce') return Math.round(base * 0.2);
  if (verdict === 'scale') return -Math.round(base * 0.5);
  return 0;
}

function summarizeScores(samples) {
  const totals = samples.reduce((summary, sample) => {
    summary.total += asNumber(sample.reward, 0);
    summary.negative = Math.min(summary.negative, asNumber(sample.reward, 0));
    summary.count += 1;
    return summary;
  }, {
    total: 0,
    negative: Number.POSITIVE_INFINITY,
    count: 0,
  });

  return {
    totalScore: Math.round(totals.total),
    averageScore: totals.count > 0 ? Math.round(totals.total / totals.count) : 0,
    sampleSize: totals.count,
    worstReward: totals.count > 0 ? Math.round(totals.negative) : 0,
  };
}

function evaluateCandidatePolicy(candidatePolicy, championPolicy, replaySample, rules = {}) {
  const rewardParams = championPolicy?.parameters?.reward || {};
  const scoredSamples = replaySample.map(sample => {
    const candidateDecision = evaluateBudgetSnapshot(sample.trace.inputSnapshot, candidatePolicy, rules);
    const championVerdict = sample.trace.verdict || sample.outcome.verdict || 'hold';
    const candidateVerdict = candidateDecision.verdict || 'hold';
    const reward = sample.outcome?.finalReward
      ? estimateCounterfactualReward(
          candidateVerdict,
          championVerdict,
          sample.outcome?.finalReward?.total,
          rewardParams
        )
      : scoreProxyDecision(sample.trace.inputSnapshot, candidateDecision, rules);
    return {
      traceId: sample.trace.traceId,
      reward,
      candidateVerdict,
      championVerdict,
      diverged: candidateVerdict !== championVerdict,
    };
  });

  const summary = summarizeScores(scoredSamples);
  const championTotal = replaySample.reduce((sum, sample) => {
    if (sample.outcome?.finalReward) {
      return sum + asNumber(sample.outcome?.finalReward?.total, 0);
    }
    return sum + scoreProxyDecision(sample.trace.inputSnapshot, { verdict: sample.trace.verdict || 'hold' }, rules);
  }, 0);
  const divergenceRate = summary.sampleSize > 0
    ? scoredSamples.filter(sample => sample.diverged).length / summary.sampleSize
    : 0;
  const approvalLoadRatio = replaySample.filter(sample => ['scale', 'reduce'].includes(sample.trace.verdict)).length > 0
    ? scoredSamples.filter(sample => ['scale', 'reduce'].includes(sample.candidateVerdict)).length
      / replaySample.filter(sample => ['scale', 'reduce'].includes(sample.trace.verdict)).length
    : 1;

  return {
    scoreSummary: {
      ...summary,
      championTotalScore: Math.round(championTotal),
      improvementRatio: championTotal !== 0 ? (summary.totalScore - championTotal) / Math.abs(championTotal) : 0,
      divergenceRate: Number(divergenceRate.toFixed(3)),
      approvalLoadRatio: Number(approvalLoadRatio.toFixed(3)),
    },
    scoredSamples,
  };
}

function runStructuredSearch({ championPolicy, outcomes, traces, rules = {}, candidateCount = 3 }) {
  const realizedReplaySample = buildReplaySample(
    outcomes,
    new Map((Array.isArray(traces) ? traces : []).map(trace => [trace.traceId, trace]))
  );
  const replaySample = realizedReplaySample.length > 0
    ? realizedReplaySample
    : buildBootstrapReplaySample(traces);
  const scoreMode = realizedReplaySample.length > 0 ? 'realized_replay' : 'bootstrap_proxy';
  if (replaySample.length === 0) {
    return {
      replaySampleSize: 0,
      scoreMode,
      experiments: [],
      bestExperiment: null,
    };
  }
  const candidates = buildStructuredCandidates(championPolicy, candidateCount);

  const experiments = candidates.map(candidatePolicy => {
    const result = evaluateCandidatePolicy(candidatePolicy, championPolicy, replaySample, rules);
    const improvementRatio = asNumber(result.scoreSummary.improvementRatio, 0);
    const promotionReady = (
      scoreMode === 'realized_replay'
      && result.scoreSummary.sampleSize > 0
      && improvementRatio >= 0.05
      && result.scoreSummary.worstReward >= asNumber(result.scoreSummary.championTotalScore, 0) * -0.5
      && result.scoreSummary.approvalLoadRatio <= 1.1
    );

    const nextPolicy = {
      ...candidatePolicy,
      diffSummary: buildPolicyDiff(championPolicy, candidatePolicy),
      scoreSummary: {
        ...result.scoreSummary,
        promotionReady,
      },
      summaryLine: summarizePolicyDiff(buildPolicyDiff(championPolicy, candidatePolicy)),
      status: promotionReady ? 'promotion_ready' : 'challenger',
    };

    return {
      id: `experiment_${Date.now()}_${candidatePolicy.id}`,
      policyId: nextPolicy.id,
      parentPolicyId: championPolicy.id,
      createdAt: new Date().toISOString(),
      mutationStrategy: 'structured_search',
      status: nextPolicy.status,
      diffSummary: nextPolicy.diffSummary,
      replaySummary: nextPolicy.scoreSummary,
      scoredSamples: result.scoredSamples.slice(0, 25),
      scoreMode,
      promotionNotes: promotionReady
        ? 'Replay score cleared the promotion gate. Generate a manual PR bundle.'
        : scoreMode === 'bootstrap_proxy'
        ? 'Candidate is active on bootstrap replay and will tighten once real executed outcomes accumulate.'
        : 'Candidate stays in challenger mode until replay and live evidence improve.',
    };
  });

  experiments.sort((left, right) => {
    const leftScore = asNumber(left.replaySummary?.improvementRatio, 0);
    const rightScore = asNumber(right.replaySummary?.improvementRatio, 0);
    return rightScore - leftScore;
  });

  return {
    replaySampleSize: replaySample.length,
    scoreMode,
    experiments,
    bestExperiment: experiments[0] || null,
  };
}

module.exports = {
  runStructuredSearch,
  evaluateCandidatePolicy,
};
