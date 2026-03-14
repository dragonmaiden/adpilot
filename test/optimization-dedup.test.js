const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterDuplicateApprovalOptimizations,
} = require('../server/services/optimizationDedupService');

function buildOptimization(overrides = {}) {
  return {
    id: overrides.id || 'opt-test',
    type: 'budget',
    level: 'campaign',
    targetId: 'campaign-1',
    targetName: 'Campaign 1',
    action: 'Increase daily budget by $22.00 (20%)',
    reason: 'Last 7d CPA is $4.01 with 201 purchases — room to scale',
    priority: 'medium',
    executed: false,
    approvalStatus: null,
    approvalRequestedAt: null,
    executionResult: null,
    timestamp: '2026-03-12T00:00:00.000Z',
    ...overrides,
  };
}

test('suppresses a repeated approval when an equivalent request is already pending', () => {
  const existing = [
    buildOptimization({
      id: 'opt-existing',
      approvalStatus: 'pending',
      approvalRequestedAt: '2026-03-12T08:00:00.000Z',
    }),
  ];
  const next = [buildOptimization({ id: 'opt-next', timestamp: '2026-03-12T08:05:00.000Z' })];

  const result = filterDuplicateApprovalOptimizations(next, existing, new Date('2026-03-12T08:05:00.000Z'));

  assert.equal(result.optimizations.length, 0);
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.suppressed[0].reason, 'pending');
  assert.equal(result.suppressed[0].optimizationId, 'opt-existing');
});

test('suppresses a repeated approval when the same request recently expired', () => {
  const existing = [
    buildOptimization({
      id: 'opt-expired',
      approvalStatus: 'expired',
      approvalRequestedAt: '2026-03-12T01:00:00.000Z',
      executionResult: 'Expired: Timeout — no response',
    }),
  ];
  const next = [buildOptimization({ id: 'opt-next', timestamp: '2026-03-12T03:00:00.000Z' })];

  const result = filterDuplicateApprovalOptimizations(next, existing, new Date('2026-03-12T03:00:00.000Z'));

  assert.equal(result.optimizations.length, 0);
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.suppressed[0].reason, 'expired');
});

test('allows the same approval action again after the expiry cooldown has passed', () => {
  const existing = [
    buildOptimization({
      id: 'opt-expired',
      approvalStatus: 'expired',
      approvalRequestedAt: '2026-03-11T00:00:00.000Z',
      executionResult: 'Expired: Timeout — no response',
    }),
  ];
  const next = [buildOptimization({ id: 'opt-next', timestamp: '2026-03-12T03:00:00.000Z' })];

  const result = filterDuplicateApprovalOptimizations(next, existing, new Date('2026-03-12T03:00:00.000Z'));

  assert.equal(result.optimizations.length, 1);
  assert.equal(result.suppressed.length, 0);
});

test('suppresses a repeated approval shortly after Telegram request delivery failed', () => {
  const existing = [
    buildOptimization({
      id: 'opt-failed-send',
      executionResult: 'Failed to send Telegram approval request',
      timestamp: '2026-03-12T08:00:00.000Z',
    }),
  ];
  const next = [buildOptimization({ id: 'opt-next', timestamp: '2026-03-12T08:20:00.000Z' })];

  const result = filterDuplicateApprovalOptimizations(next, existing, new Date('2026-03-12T08:20:00.000Z'));

  assert.equal(result.optimizations.length, 0);
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.suppressed[0].reason, 'failed_request');
});

test('suppresses same-direction same-step budget approvals even when the dollar amount changes', () => {
  const existing = [
    buildOptimization({
      id: 'opt-expired',
      approvalStatus: 'expired',
      approvalRequestedAt: '2026-03-12T01:00:00.000Z',
      executionResult: 'Expired: Timeout — no response',
    }),
  ];
  const next = [
    buildOptimization({
      id: 'opt-next',
      action: 'Increase daily budget by $24.00 (20%)',
      timestamp: '2026-03-12T03:00:00.000Z',
    }),
  ];

  const result = filterDuplicateApprovalOptimizations(next, existing, new Date('2026-03-12T03:00:00.000Z'));

  assert.equal(result.optimizations.length, 0);
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.suppressed[0].reason, 'expired');
});

test('treats a materially different budget step as a new approval request', () => {
  const existing = [
    buildOptimization({
      id: 'opt-expired',
      approvalStatus: 'expired',
      approvalRequestedAt: '2026-03-12T01:00:00.000Z',
      executionResult: 'Expired: Timeout — no response',
    }),
  ];
  const next = [
    buildOptimization({
      id: 'opt-next',
      action: 'Increase daily budget by $18.00 (15%)',
      timestamp: '2026-03-12T03:00:00.000Z',
    }),
  ];

  const result = filterDuplicateApprovalOptimizations(next, existing, new Date('2026-03-12T03:00:00.000Z'));

  assert.equal(result.optimizations.length, 1);
  assert.equal(result.suppressed.length, 0);
});

test('suppresses duplicate approval actions generated within the same scan batch', () => {
  const next = [
    buildOptimization({ id: 'opt-1' }),
    buildOptimization({ id: 'opt-2', reason: 'Same action, slightly different reason text' }),
  ];

  const result = filterDuplicateApprovalOptimizations(next, [], new Date('2026-03-12T08:05:00.000Z'));

  assert.equal(result.optimizations.length, 1);
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.suppressed[0].reason, 'duplicate-in-scan');
});
