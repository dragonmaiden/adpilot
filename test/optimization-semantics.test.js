const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getOptimizationStatus,
  isExecutableOptimization,
} = require('../server/domain/optimizationSemantics');

test('account-level budget room-to-scale suggestions are advisory only', () => {
  const optimization = {
    type: 'budget',
    level: 'account',
    action: 'True net profit is ₩1,976,635 — room to scale',
    executed: false,
    approvalStatus: null,
  };

  assert.equal(isExecutableOptimization(optimization), false);
  assert.equal(getOptimizationStatus(optimization), 'advisory');
});

test('campaign-level budget changes remain executable and need approval', () => {
  const optimization = {
    type: 'budget',
    level: 'campaign',
    action: 'Increase daily budget by $22.00 (20%)',
    executed: false,
    approvalStatus: null,
  };

  assert.equal(isExecutableOptimization(optimization), true);
  assert.equal(getOptimizationStatus(optimization), 'needs_approval');
});

test('pending Telegram approvals are surfaced as awaiting_telegram', () => {
  const optimization = {
    type: 'status',
    level: 'campaign',
    action: 'Pause campaign',
    executed: false,
    approvalStatus: 'pending',
  };

  assert.equal(getOptimizationStatus(optimization), 'awaiting_telegram');
});
