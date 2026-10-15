const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { getDailySourceDates, buildDailyMerged } = require('../server/transforms/charts');

test('financial calculations load without scheduler, configuration, persistence, or delivery modules', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const Module = require('module');
    const original = Module._load;
    Module._load = function(request, parent, ...args) {
      const resolved = Module._resolveFilename(request, parent);
      if (/server[\\\\/](modules|runtime|services)[\\\\/]|server[\\\\/]config\\.js/.test(resolved)) {
        throw new Error('Financial calculation loaded runtime dependency: ' + resolved);
      }
      return original.call(this, request, parent, ...args);
    };
    const { buildSummaryFinancialDays, buildSelectionSummary } = require('./server/domain/financialSummary');
    const days = buildSummaryFinancialDays({ dailyMerged: [], profitWaterfall: [] }, [], { ready: true, daily: [], totals: { feesComplete: true } });
    if (days.length || buildSelectionSummary(days, [], {}).netRevenue !== 0) throw new Error('Invalid empty window');
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('history discovery includes revenue, refund, spend-only and COGS-only days without projections', () => {
  const revenue = { '2026-10-03': { revenue: 100, refunded: 20 }, '2026-10-04': { refunded: 50 } };
  const insights = [{ date_start: '2026-10-01', spend: '1' }, { date_start: '2026-10-03', spend: '2' }];
  const cogs = { '2026-10-02': { cost: 10 }, '2026-10-03': { cost: 30 } };
  const dates = getDailySourceDates(revenue, insights, cogs);
  assert.deepEqual(dates, ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
  assert.deepEqual(buildDailyMerged(revenue, insights, cogs).map(row => row.date), dates);
});
