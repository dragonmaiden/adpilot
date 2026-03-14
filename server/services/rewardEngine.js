const { asNumber } = require('../decision/utils');
const { REWARD_WINDOW_HOURS } = require('../decision/contextBuilder');

function buildDefaultRewardPolicy() {
  return {
    parameters: {
      reward: {
        horizonHours: REWARD_WINDOW_HOURS,
        cpaPenaltyRatio: 0.15,
        negativeRewardMultiplier: 0.75,
        missedUpsidePenaltyMultiplier: 0.5,
        contradictionPenaltyMultiplier: 1,
      },
    },
  };
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
  policy = buildDefaultRewardPolicy(),
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
  REWARD_WINDOW_HOURS,
  bucketReward,
  computeReward,
};
