function evaluateMeasurementTrust(context) {
  const { snapshot, penaltyWeights, specialistWeights } = context;
  const trust = snapshot.measurementTrust || {};
  const blockers = [];
  const cautions = [];
  const penalties = [];

  if (trust.shouldFreezeBudgetChanges) {
    blockers.push(trust.reason || 'Measurement trust is too weak for budget changes');
  } else if (trust.level === 'medium') {
    cautions.push(trust.reason || 'Measurement trust is directional only');
    penalties.push({
      type: 'measurement_trust',
      weight: penaltyWeights.measurementTrust,
      detail: trust.reason || trust.label || 'Directional trust only',
    });
  }

  const status = blockers.length > 0 ? 'block' : cautions.length > 0 ? 'caution' : 'pass';
  const score = blockers.length > 0 ? -3 : cautions.length > 0 ? -1 : 2;

  return {
    key: 'measurement_trust',
    label: 'Measurement trust',
    status,
    weight: specialistWeights.measurementTrust,
    score,
    summary: blockers[0] || cautions[0] || 'Measurement inputs are healthy enough for budget decisions',
    gates: [
      {
        key: 'measurement_trust',
        passed: !trust.shouldFreezeBudgetChanges,
        detail: trust.label || trust.level || 'unknown',
      },
      {
        key: 'fresh_revenue',
        passed: Boolean(trust.hasFreshRevenue),
        detail: trust.hasFreshRevenue ? 'Fresh revenue connected' : 'Revenue feed degraded',
      },
    ],
    blockers,
    cautions,
    penalties,
    decisionHint: blockers.length > 0 ? 'suppress' : null,
  };
}

module.exports = evaluateMeasurementTrust;
