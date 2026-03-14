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
      return {
        outcome,
        trace,
      };
    })
    .filter(Boolean);
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
    const reward = estimateCounterfactualReward(
      candidateVerdict,
      championVerdict,
      sample.outcome?.finalReward?.total,
      rewardParams
    );
    return {
      traceId: sample.trace.traceId,
      reward,
      candidateVerdict,
      championVerdict,
      diverged: candidateVerdict !== championVerdict,
    };
  });

  const summary = summarizeScores(scoredSamples);
  const championTotal = replaySample.reduce((sum, sample) => sum + asNumber(sample.outcome?.finalReward?.total, 0), 0);
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
  const replaySample = buildReplaySample(
    outcomes,
    new Map((Array.isArray(traces) ? traces : []).map(trace => [trace.traceId, trace]))
  );
  const candidates = buildStructuredCandidates(championPolicy, candidateCount);

  const experiments = candidates.map(candidatePolicy => {
    const result = evaluateCandidatePolicy(candidatePolicy, championPolicy, replaySample, rules);
    const improvementRatio = asNumber(result.scoreSummary.improvementRatio, 0);
    const promotionReady = (
      result.scoreSummary.sampleSize > 0
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
      promotionNotes: promotionReady
        ? 'Replay score cleared the promotion gate. Generate a manual PR bundle.'
        : 'Candidate stays in challenger/shadow mode until replay and shadow evidence improve.',
    };
  });

  experiments.sort((left, right) => {
    const leftScore = asNumber(left.replaySummary?.improvementRatio, 0);
    const rightScore = asNumber(right.replaySummary?.improvementRatio, 0);
    return rightScore - leftScore;
  });

  return {
    replaySampleSize: replaySample.length,
    experiments,
    bestExperiment: experiments[0] || null,
  };
}

module.exports = {
  runStructuredSearch,
  evaluateCandidatePolicy,
};
