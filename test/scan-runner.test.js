const test = require('node:test');
const assert = require('node:assert/strict');

const { __private } = require('../server/modules/scanRunner');

test('resolveAdInsightsSince caps ad insight scans to a recent rolling window', () => {
  assert.equal(__private.resolveAdInsightsSince('2026-02-01', '2026-03-15'), '2026-02-01');
});

test('resolveAdInsightsSince uses the rolling window when business history is older than the recent cap', () => {
  assert.equal(__private.resolveAdInsightsSince('2025-11-01', '2026-03-15'), '2026-01-30');
  assert.equal(__private.resolveAdInsightsSince('2025-11-01', '2026-03-15', 30), '2026-02-14');
});
