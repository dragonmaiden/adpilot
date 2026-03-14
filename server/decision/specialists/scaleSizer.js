const { asNumber, clamp } = require('../utils');

function evaluateScaleSizer(context) {
  const { snapshot, scaleParams, specialistWeights, derived } = context;
  const hasExplicitHeadroom = snapshot.economics.targetCpa != null;
  const profitableWithoutTarget = !hasExplicitHeadroom
    && derived.reliableEconomics
    && snapshot.economics.estimatedTrueNetProfit > 0
    && snapshot.economics.estimatedMargin >= asNumber(scaleParams.minEstimatedMargin, 0.08);
  const headroomScore = profitableWithoutTarget
    ? 1
    : derived.positiveHeadroomRatio >= 0.2 ? 2 : derived.positiveHeadroomRatio >= 0.1 ? 1 : 0;
  const score = headroomScore > 0 ? headroomScore : 0;

  return {
    key: 'scale_sizer',
    label: 'Scale sizing',
    status: headroomScore > 0 ? 'pass' : 'caution',
    weight: specialistWeights.scaleSizer,
    score,
    summary: profitableWithoutTarget
      ? 'Profitability supports cautious scaling even without an explicit target CPA'
      : derived.positiveHeadroomRatio > 0
      ? `${(derived.positiveHeadroomRatio * 100).toFixed(1)}% CPA headroom versus target`
      : 'No clear scale headroom detected',
    gates: [],
    blockers: [],
    cautions: headroomScore > 0 ? [] : ['Scale headroom is limited'],
    penalties: [],
    decisionHint: headroomScore > 0 ? 'scale' : 'hold',
    recommendActionPercent(frictionScore) {
      const cautiousCap = asNumber(scaleParams.cautionStepPercentCap, 10);
      const maxStep = asNumber(scaleParams.maxStepPercent, asNumber(context.rules.maxBudgetChangePercent, 20));
      const safeMax = Math.min(maxStep, asNumber(context.rules.maxBudgetChangePercent, 20));
      if (snapshot.currentBudgetCents <= 0) return 0;
      if (frictionScore >= context.synthesizer.frictionLowConfidenceThreshold) {
        return clamp(cautiousCap, 1, safeMax);
      }
      if (frictionScore >= context.synthesizer.frictionCautionThreshold) {
        return clamp(Math.min(cautiousCap, safeMax), 1, safeMax);
      }
      return clamp(safeMax, 1, safeMax);
    },
  };
}

module.exports = evaluateScaleSizer;
