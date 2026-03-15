const { asNumber, round } = require('./utils');

function weightedScore(entry) {
  return round(asNumber(entry.score, 0) * asNumber(entry.weight, 1), 3);
}

function flatten(entries, key) {
  return entries.flatMap(entry => Array.isArray(entry[key]) ? entry[key] : []);
}

function buildPenaltyWeight(penalties) {
  return penalties.reduce((sum, penalty) => sum + asNumber(penalty.weight, 0), 0);
}

function synthesizeDecision(context, specialists) {
  const gates = flatten(specialists, 'gates');
  const penalties = flatten(specialists, 'penalties');
  const scaleBlockers = flatten(specialists, 'blockers');
  const cautions = flatten(specialists, 'cautions');
  const specialistSummary = specialists.map(entry => ({
    key: entry.key,
    label: entry.label,
    status: entry.status,
    weight: entry.weight,
    score: entry.score,
    weightedScore: weightedScore(entry),
    summary: entry.summary,
    decisionHint: entry.decisionHint || null,
  }));

  const weightedNegativeScore = specialistSummary
    .filter(entry => entry.weightedScore < 0)
    .reduce((sum, entry) => sum + Math.abs(entry.weightedScore), 0);
  const penaltyWeight = buildPenaltyWeight(penalties);
  const frictionScore = round(weightedNegativeScore + (penaltyWeight * context.synthesizer.cautionPenaltyMultiplier), 3);
  const reduceSizer = specialists.find(entry => entry.key === 'reduce_sizer');
  const scaleSizer = specialists.find(entry => entry.key === 'scale_sizer');
  const reviewWindowHours = context.derived.reviewWindowHours;
  const rewardWindowHours = context.derived.rewardWindowHours;
  const currentBudgetCents = context.snapshot.currentBudgetCents;

  if (context.derived.reduceRecommended) {
    if (scaleBlockers.length > 0) {
      return {
        verdict: 'suppress',
        shouldCreateOptimization: false,
        actionPercent: 0,
        actionDollars: 0,
        priority: 'low',
        confidence: context.derived.reliableEconomics ? 'medium' : 'low',
        blockers: scaleBlockers,
        cautions,
        penalties,
        gates,
        specialists: specialistSummary,
        regimeTags: context.regimeTags,
        synthesis: {
          frictionScore,
          weightedNegativeScore,
          penaltyWeight,
          activeReducer: false,
          activeScaler: false,
        },
        rationaleSummary: scaleBlockers[0],
        reasoning: scaleBlockers.join('; '),
        impactSummary: 'No budget change should be proposed from this context.',
        reviewWindowHours,
        rewardWindowHours,
      };
    }

    const actionPercent = asNumber(reduceSizer?.reducePercent, 0);
    const impactBudget = currentBudgetCents > 0
      ? Math.round(currentBudgetCents * (actionPercent / 100))
      : 0;
    const rationaleSummary = `CPA ${context.derived.avgCpa.toFixed(2)} is above the policy warning threshold of ${asNumber(context.reduceParams.cpaWarningThreshold, 30).toFixed(2)}`;
    return {
      verdict: 'reduce',
      shouldCreateOptimization: context.snapshot.targetLevel === 'campaign' || context.snapshot.targetLevel === 'adset',
      actionPercent,
      actionDollars: impactBudget / 100,
      priority: context.derived.reduceCritical ? 'critical' : 'high',
      confidence: context.derived.reliableEconomics ? 'medium' : 'low',
      blockers: [],
      cautions,
      penalties,
      gates,
      specialists: specialistSummary,
      regimeTags: context.regimeTags,
      synthesis: {
        frictionScore,
        weightedNegativeScore,
        penaltyWeight,
        activeReducer: true,
        activeScaler: false,
      },
      rationaleSummary,
      reasoning: rationaleSummary,
      impactSummary: `Reduce spend by about $${(impactBudget / 100).toFixed(2)} per day and review again within ${reviewWindowHours} hours.`,
      reviewWindowHours,
      rewardWindowHours,
    };
  }

  if (scaleBlockers.length > 0 || frictionScore >= context.synthesizer.frictionSuppressThreshold) {
    const blockers = scaleBlockers.length > 0
      ? scaleBlockers
      : ['Combined friction across economics, trust, and creative readiness is too high to scale'];
    return {
      verdict: 'suppress',
      shouldCreateOptimization: false,
      actionPercent: 0,
      actionDollars: 0,
      priority: 'low',
      confidence: context.derived.reliableEconomics ? 'medium' : 'low',
      blockers,
      cautions,
      penalties,
      gates,
      specialists: specialistSummary,
      regimeTags: context.regimeTags,
      synthesis: {
        frictionScore,
        weightedNegativeScore,
        penaltyWeight,
        activeReducer: false,
        activeScaler: false,
      },
      rationaleSummary: blockers[0],
      reasoning: blockers.join('; '),
      impactSummary: 'No budget increase should be proposed from this context.',
      reviewWindowHours,
      rewardWindowHours,
    };
  }

  const actionPercent = asNumber(scaleSizer?.recommendActionPercent?.(frictionScore), 0);
  const actionBudgetDelta = currentBudgetCents > 0
    ? Math.round(currentBudgetCents * (actionPercent / 100))
    : 0;
  const confidence = context.snapshot.economics.confidence === 'high' && frictionScore < context.synthesizer.frictionCautionThreshold
    ? 'high'
    : frictionScore >= context.synthesizer.frictionLowConfidenceThreshold ? 'low' : 'medium';
  const rationaleSummary = `CPA ${context.derived.avgCpa.toFixed(2)} supports scaling against target ${context.snapshot.economics.targetCpa != null ? context.snapshot.economics.targetCpa.toFixed(2) : 'n/a'} with ${context.snapshot.purchases} purchases in view.`;
  const impactLabel = actionBudgetDelta > 0
    ? `Increase budget by about $${(actionBudgetDelta / 100).toFixed(2)} per day and review again within ${reviewWindowHours} hours.`
    : `Hold current budget and review again within ${reviewWindowHours} hours.`;

  return {
    verdict: actionBudgetDelta > 0 ? 'scale' : 'hold',
    shouldCreateOptimization: actionBudgetDelta > 0,
    actionPercent,
    actionDollars: actionBudgetDelta / 100,
    priority: (cautions.length > 0 || penalties.length > 0 || frictionScore >= context.synthesizer.frictionCautionThreshold) ? 'low' : 'medium',
    confidence,
    blockers: [],
    cautions,
    penalties,
    gates,
    specialists: specialistSummary,
    regimeTags: context.regimeTags,
    synthesis: {
      frictionScore,
      weightedNegativeScore,
      penaltyWeight,
      activeReducer: false,
      activeScaler: actionBudgetDelta > 0,
    },
    rationaleSummary,
    reasoning: cautions.length > 0 ? `${rationaleSummary} Caveats: ${cautions.join('; ')}.` : rationaleSummary,
    impactSummary: impactLabel,
    reviewWindowHours,
    rewardWindowHours,
  };
}

module.exports = {
  synthesizeDecision,
};
