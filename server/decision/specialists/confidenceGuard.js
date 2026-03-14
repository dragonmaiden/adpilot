function evaluateConfidence(context) {
  const { snapshot, specialistWeights, derived } = context;
  const blockers = [];
  const cautions = [];

  if (!derived.evidenceStrong) blockers.push('Recent delivery evidence is too thin to scale confidently');
  if (derived.avgCpa == null) blockers.push('Recent CPA is unavailable');

  if (snapshot.economics.confidence === 'medium') {
    cautions.push('Economics are directionally useful but not fully locked');
  } else if (snapshot.economics.confidence === 'low') {
    cautions.push('Economics confidence is low');
  }

  const status = blockers.length > 0 ? 'block' : cautions.length > 0 ? 'caution' : 'pass';
  const score = blockers.length > 0 ? -2 : cautions.length > 0 ? 0 : 2;

  return {
    key: 'confidence',
    label: 'Signal confidence',
    status,
    weight: specialistWeights.confidence,
    score,
    summary: blockers[0] || cautions[0] || 'Evidence strength is sufficient for a budget decision',
    gates: [
      {
        key: 'evidence_strength',
        passed: derived.evidenceStrong,
        detail: `${snapshot.evidence.observationDays} days · ${snapshot.evidence.purchaseDays} purchase days · ${snapshot.evidence.purchases} purchases`,
      },
    ],
    blockers,
    cautions,
    penalties: [],
    decisionHint: blockers.length > 0 ? 'suppress' : null,
  };
}

module.exports = evaluateConfidence;
