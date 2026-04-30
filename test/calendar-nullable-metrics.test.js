const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('calendar financial rates preserve unavailable denominator states', () => {
  const service = fs.readFileSync(path.join(__dirname, '..', 'server/services/calendarService.js'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public/live/pages/calendar.js'), 'utf8');

  assert.match(service, /ratioPercentOrNull\(dayTotals\.trueNetProfit, dayTotals\.netRevenue\)/);
  assert.match(service, /ratioPercentOrNull\(dayTotals\.refundedAmount, dayTotals\.grossRevenue\)/);
  assert.match(service, /ratioOrNull\(dayTotals\.netRevenue, dayTotals\.adSpendKRW\)/);
  assert.doesNotMatch(client, /formatPercent\(summary\.(margin|refundRate) \|\| 0\)/);
  assert.doesNotMatch(client, /Number\(summary\.roas \|\| 0\)/);
});
