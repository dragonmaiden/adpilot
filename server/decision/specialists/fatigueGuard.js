function evaluateFatigue(context) {
  const { snapshot, penaltyWeights, specialistWeights } = context;
  const blockers = [];
  const cautions = [];
  const penalties = [];

  if (snapshot.risk.severeFatigueBlock) {
    blockers.push(`${snapshot.risk.fatiguedAds.length}/${snapshot.risk.activeAdCount} active ads show severe fatigue`);
  } else if (snapshot.risk.fatiguedAds.length > 0) {
    cautions.push(`${snapshot.risk.fatiguedAds.length}/${snapshot.risk.activeAdCount} active ads show fatigue`);
    penalties.push({
      type: 'fatigue',
      weight: penaltyWeights.fatigue,
      detail: `${snapshot.risk.fatiguedAds.length} fatigued ads`,
    });
  }

  const status = blockers.length > 0 ? 'block' : cautions.length > 0 ? 'caution' : 'pass';
  const score = blockers.length > 0 ? -2 : cautions.length > 0 ? -1 : 1;

  return {
    key: 'fatigue',
    label: 'Fatigue',
    status,
    weight: specialistWeights.fatigue,
    score,
    summary: blockers[0] || cautions[0] || 'No fatigue pressure is blocking scale',
    gates: [],
    blockers,
    cautions,
    penalties,
    decisionHint: blockers.length > 0 ? 'suppress' : null,
  };
}

module.exports = evaluateFatigue;
