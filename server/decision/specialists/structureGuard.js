function evaluateStructure(context) {
  const { snapshot, penaltyWeights, specialistWeights } = context;
  const cautions = [];
  const penalties = [];

  if (snapshot.risk.hasConcentrationRisk) {
    cautions.push(`${snapshot.risk.activeCampaignCount} active campaign is carrying spend`);
    penalties.push({
      type: 'concentration',
      weight: penaltyWeights.concentration,
      detail: `${snapshot.risk.activeCampaignCount} active campaign carrying spend`,
    });
  }

  if (snapshot.risk.hasCreativeDepthRisk) {
    cautions.push(`Only ${snapshot.risk.activeAdCount} active ads are available to absorb extra budget`);
    penalties.push({
      type: 'creative_depth',
      weight: penaltyWeights.creativeDepth,
      detail: `${snapshot.risk.activeAdCount} active ads available`,
    });
  }

  const status = cautions.length > 0 ? 'caution' : 'pass';
  const score = cautions.length > 0 ? -1 : 1;

  return {
    key: 'structure',
    label: 'Structure',
    status,
    weight: specialistWeights.structure,
    score,
    summary: cautions[0] || 'Structure can absorb budget changes',
    gates: [],
    blockers: [],
    cautions,
    penalties,
    decisionHint: null,
  };
}

module.exports = evaluateStructure;
