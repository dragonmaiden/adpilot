const { asNumber, clamp } = require('../utils');

function evaluateReduceSizer(context) {
  const { reduceParams, specialistWeights, derived } = context;
  const active = Boolean(derived.reduceRecommended);
  const reducePercent = clamp(
    asNumber(reduceParams.maxReductionPercent, 15),
    1,
    asNumber(context.rules.maxBudgetChangePercent, 20)
  );

  return {
    key: 'reduce_sizer',
    label: 'Reduce sizing',
    status: active ? 'caution' : 'pass',
    weight: specialistWeights.reduceSizer,
    score: active ? -2 : 1,
    summary: active
      ? `CPA is above the warning threshold; reduce by ${reducePercent}% if other guards allow it`
      : 'No reduction signal is active',
    gates: [],
    blockers: [],
    cautions: [],
    penalties: [],
    decisionHint: active ? 'reduce' : null,
    reducePercent,
  };
}

module.exports = evaluateReduceSizer;
