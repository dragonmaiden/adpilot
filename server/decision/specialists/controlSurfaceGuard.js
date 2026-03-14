function evaluateControlSurface(context) {
  const blockers = [];
  const snapshot = context.snapshot;

  if (snapshot.controlSurface === 'mixed_or_unsupported') {
    blockers.push('Budget ownership is mixed or unsupported for this target');
  }

  if (snapshot.targetLevel === 'campaign' && snapshot.controlSurface !== 'campaign_budget_controlled') {
    blockers.push('Campaign budget is not the active control surface for this target');
  }

  if (snapshot.targetLevel === 'adset' && snapshot.controlSurface !== 'adset_budget_controlled') {
    blockers.push('Ad set budget is controlled at the campaign level');
  }

  return {
    key: 'control_surface',
    label: 'Control surface',
    status: blockers.length > 0 ? 'block' : 'pass',
    weight: context.specialistWeights.controlSurface,
    score: blockers.length > 0 ? -3 : 1,
    summary: blockers[0] || 'Budget ownership is clear',
    gates: [
      {
        key: 'control_surface',
        passed: blockers.length === 0,
        detail: snapshot.controlSurface,
      },
    ],
    blockers,
    cautions: [],
    penalties: [],
    decisionHint: blockers.length > 0 ? 'suppress' : null,
  };
}

module.exports = evaluateControlSurface;
