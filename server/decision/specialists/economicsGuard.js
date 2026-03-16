function evaluateEconomics(context) {
  const { snapshot, reduceParams, penaltyWeights, specialistWeights, derived } = context;
  const blockers = [];
  const cautions = [];
  const penalties = [];

  if (!derived.reliableEconomics) blockers.push('Campaign economics are not reliable enough');
  if (!derived.healthyCoverage) blockers.push('COGS coverage is below the minimum scale threshold');
  if (!derived.healthyMargin) blockers.push('Estimated contribution margin is below the minimum scale threshold');
  if (snapshot.economics.estimatedTrueNetProfit <= 0) blockers.push('Estimated contribution profit is not positive');

  if (derived.avgCpa != null && snapshot.economics.breakEvenCpa != null && derived.avgCpa > snapshot.economics.breakEvenCpa) {
    blockers.push(`CPA ${derived.avgCpa.toFixed(2)} is above break-even ${snapshot.economics.breakEvenCpa.toFixed(2)}`);
  } else if (derived.avgCpa != null && snapshot.economics.targetCpa != null && derived.avgCpa > snapshot.economics.targetCpa) {
    blockers.push(`CPA ${derived.avgCpa.toFixed(2)} is above target ${snapshot.economics.targetCpa.toFixed(2)}`);
  }

  if (snapshot.economics.confidence !== 'high') {
    cautions.push(snapshot.economics.confidenceLabel);
    penalties.push({
      type: 'confidence',
      weight: penaltyWeights.confidence,
      detail: snapshot.economics.confidenceLabel,
    });
  }

  if (!blockers.length && derived.positiveHeadroomRatio < 0.15 && snapshot.economics.targetCpa != null) {
    cautions.push(`CPA headroom is only ${(derived.positiveHeadroomRatio * 100).toFixed(1)}% versus target`);
  }

  const status = blockers.length > 0 ? 'block' : cautions.length > 0 ? 'caution' : 'pass';
  const score = blockers.length > 0 ? -3 : cautions.length > 0 ? 0 : 3;
  const summary = blockers[0]
    || cautions[0]
    || `Contribution margin ${(snapshot.economics.estimatedMargin * 100).toFixed(1)}% with positive estimated profit`;

  return {
    key: 'economics',
    label: 'Economics',
    status,
    weight: specialistWeights.economics,
    score,
    summary,
    gates: [
      {
        key: 'economics_reliable',
        passed: derived.reliableEconomics,
        detail: snapshot.economics.confidenceLabel,
      },
      {
        key: 'coverage',
        passed: derived.healthyCoverage,
        detail: `${(snapshot.economics.coverageRatio * 100).toFixed(1)}%`,
      },
      {
        key: 'margin',
        passed: derived.healthyMargin,
        detail: `${(snapshot.economics.estimatedMargin * 100).toFixed(1)}%`,
      },
    ],
    blockers,
    cautions,
    penalties,
    decisionHint: derived.reduceRecommended ? 'reduce' : null,
    reduceRecommended: derived.reduceRecommended,
    reduceCritical: derived.reduceCritical,
    reducePercent: Math.min(context.rules.maxBudgetChangePercent || 20, reduceParams.maxReductionPercent || 15),
  };
}

module.exports = evaluateEconomics;
