const scheduler = require('../modules/scheduler');
const contracts = require('../contracts/v1');

/**
 * Count occurrences of each value for a given key in an array of objects.
 */
function countBy(arr, key) {
  return arr.reduce((acc, item) => {
    acc[item[key]] = (acc[item[key]] || 0) + 1;
    return acc;
  }, {});
}

/**
 * Build the /api/optimizations response — filtered list with stats.
 */
function getOptimizationsResponse(query) {
  const opts = scheduler.getAllOptimizations();
  const limit = parseInt(query.limit) || 50;
  const type = query.type || 'all';
  const priority = query.priority || 'all';

  let filtered = opts;
  if (type !== 'all') filtered = filtered.filter(o => o.type === type);
  if (priority !== 'all') filtered = filtered.filter(o => o.priority === priority);

  // Most recent first
  filtered = filtered.slice().reverse().slice(0, limit);

  return contracts.optimizations({
    total: opts.length,
    showing: filtered.length,
    optimizations: filtered,
    stats: {
      byType: countBy(opts, 'type'),
      byPriority: countBy(opts, 'priority'),
      executed: opts.filter(o => o.executed).length,
      pending: opts.filter(o => !o.executed).length,
    },
  });
}

/**
 * Build the /api/optimizations/timeline response — timeline + scan aggregation.
 */
function getTimelineResponse() {
  const opts = scheduler.getAllOptimizations();
  const scans = scheduler.getScanHistory();

  // Group all opts by type for the timeline
  const timeline = opts.map(o => ({
    time: o.timestamp,
    scanId: o.scanId,
    type: o.type,
    priority: o.priority,
    action: o.action,
    target: o.targetName,
    executed: o.executed,
    result: o.executionResult,
    // Derive direction: budget increase = up, budget decrease/pause = down
    direction: o.action.includes('Increase') || o.action.includes('scale') || o.action.includes('Resume')
      ? 'up'
      : o.action.includes('Reduce') || o.action.includes('Pause') || o.action.includes('Reallocate')
        ? 'down'
        : 'neutral',
  }));

  // Aggregate by scan for the bar chart
  const scanTimeline = scans.map(s => {
    const scanOpts = opts.filter(o => o.scanId === s.scanId);
    const budgetUp = scanOpts.filter(o => o.type === 'budget' && (o.action.includes('Increase') || o.action.includes('scale'))).length;
    const budgetDown = scanOpts.filter(o => o.type === 'budget' && (o.action.includes('Reduce') || o.action.includes('Reallocate'))).length;
    const pauses = scanOpts.filter(o => o.type === 'status').length;
    const fatigue = scanOpts.filter(o => o.type === 'creative' || o.type === 'targeting').length;
    const bids = scanOpts.filter(o => o.type === 'bid').length;
    const schedule = scanOpts.filter(o => o.type === 'schedule').length;

    return {
      time: s.time,
      scanId: s.scanId,
      total: s.optimizations,
      budgetUp,
      budgetDown,
      pauses,
      fatigue,
      bids,
      schedule,
    };
  });

  return contracts.optimizationTimeline({
    timeline,
    scanTimeline,
    totalOptimizations: opts.length,
    totalScans: scans.length,
  });
}

module.exports = { getOptimizationsResponse, getTimelineResponse };
