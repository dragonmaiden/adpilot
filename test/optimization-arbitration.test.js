const test = require('node:test');
const assert = require('node:assert/strict');

const { arbitrateOptimizations } = require('../server/services/optimizationArbitrationService');

function buildOptimization(overrides = {}) {
  return {
    id: overrides.id || 'opt-test',
    timestamp: overrides.timestamp || '2026-03-12T00:00:00.000Z',
    type: 'budget',
    level: 'campaign',
    targetId: 'campaign-1',
    targetName: 'Campaign 1',
    action: 'Reduce daily budget by 15%',
    priority: 'high',
    executed: false,
    approvalStatus: null,
    executionResult: null,
    ...overrides,
  };
}

test('pause actions dominate other executable actions on the same target', () => {
  const result = arbitrateOptimizations([
    buildOptimization({ id: 'budget-cut' }),
    buildOptimization({
      id: 'pause',
      type: 'status',
      action: 'Pause campaign — CPA critically high',
      priority: 'critical',
    }),
  ]);

  assert.equal(result.optimizations.length, 1);
  assert.equal(result.optimizations[0].id, 'pause');
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.suppressed[0].optimizationId, 'pause');
});

test('parent campaign pause suppresses child executable actions', () => {
  const result = arbitrateOptimizations([
    buildOptimization({
      id: 'campaign-pause',
      type: 'status',
      action: 'Pause campaign — CPA critically high',
      priority: 'critical',
    }),
    buildOptimization({
      id: 'adset-budget',
      level: 'adset',
      targetId: 'adset-1',
      targetName: 'Ad Set 1',
      action: 'Reduce budget — CPA 60% above campaign average',
    }),
  ], {
    adSets: [{ id: 'adset-1', campaign_id: 'campaign-1' }],
    ads: [],
  });

  assert.equal(result.optimizations.length, 1);
  assert.equal(result.optimizations[0].id, 'campaign-pause');
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.suppressed[0].reason, 'parent-paused');
});

test('advisory actions remain when a target has a stronger executable winner', () => {
  const result = arbitrateOptimizations([
    buildOptimization({ id: 'budget-cut' }),
    buildOptimization({
      id: 'targeting-note',
      type: 'targeting',
      action: 'Expand audience — frequency is 4.5',
      priority: 'high',
    }),
  ]);

  assert.equal(result.optimizations.length, 2);
  assert.equal(result.suppressed.length, 0);
});
