function evaluateTrend(context) {
  const { snapshot, specialistWeights } = context;
  const blockers = [];
  const cautions = [];

  if (snapshot.weekday.status === 'suppress') blockers.push(snapshot.weekday.reason || 'Weekday delivery is materially soft');
  if (snapshot.trend.status === 'suppress') blockers.push(snapshot.trend.reason || 'Recent trend is materially soft');
  if (snapshot.weekday.status === 'caution') cautions.push(snapshot.weekday.reason || 'Weekday delivery is soft');
  if (snapshot.trend.status === 'caution') cautions.push(snapshot.trend.reason || 'Recent trend is soft');

  const status = blockers.length > 0 ? 'block' : cautions.length > 0 ? 'caution' : 'pass';
  const score = blockers.length > 0 ? -2 : cautions.length > 0 ? -1 : 1;

  return {
    key: 'trend',
    label: 'Trend',
    status,
    weight: specialistWeights.trend,
    score,
    summary: blockers[0] || cautions[0] || 'Recent trend and weekday context are stable',
    gates: [],
    blockers,
    cautions,
    penalties: [],
    decisionHint: blockers.length > 0 ? 'suppress' : null,
  };
}

module.exports = evaluateTrend;
