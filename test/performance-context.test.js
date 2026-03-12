const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterRecentInsights,
  buildProfitContext,
} = require('../server/domain/performanceContext');

function createActions(purchases) {
  if (purchases <= 0) return [];
  return [
    { action_type: 'purchase', value: String(purchases) },
    { action_type: 'offsite_conversion.fb_pixel_purchase', value: String(purchases) },
    { action_type: 'omni_purchase', value: String(purchases) },
  ];
}

test('filterRecentInsights can exclude the current incomplete day', () => {
  const rows = [
    { campaign_id: 'c1', date_start: '2026-03-09', spend: '10', actions: createActions(1) },
    { campaign_id: 'c1', date_start: '2026-03-10', spend: '10', actions: createActions(1) },
    { campaign_id: 'c1', date_start: '2026-03-11', spend: '40', actions: createActions(0) },
  ];

  const visible = filterRecentInsights(rows, 'campaign_id', 'c1', 3, '2026-03-11', {
    includeCurrentDay: false,
  });

  assert.deepEqual(visible.map(row => row.date_start), ['2026-03-08', '2026-03-09', '2026-03-10'].filter(date => rows.some(row => row.date_start === date)));
});

test('buildProfitContext uses weighted COGS coverage instead of full-day-only coverage', () => {
  const campaignInsights = [
    { campaign_id: 'c1', date_start: '2026-03-09', spend: '10', actions: createActions(1) },
    { campaign_id: 'c1', date_start: '2026-03-10', spend: '10', actions: createActions(1) },
    { campaign_id: 'c1', date_start: '2026-03-11', spend: '10', actions: createActions(1) },
  ];
  const revenueData = {
    dailyRevenue: {
      '2026-03-09': { revenue: 100000, refunded: 0, orders: 1 },
      '2026-03-10': { revenue: 100000, refunded: 0, orders: 1 },
      '2026-03-11': { revenue: 100000, refunded: 0, orders: 1 },
    },
  };
  const cogsData = {
    dailyCOGS: {
      '2026-03-09': { cost: 20000, shipping: 3000, costCoverageRatio: 1 },
      '2026-03-10': { cost: 20000, shipping: 3000, costCoverageRatio: 0.75 },
      '2026-03-11': { cost: 20000, shipping: 3000, costCoverageRatio: 0.75 },
    },
  };

  const context = buildProfitContext(campaignInsights, revenueData, cogsData, 3, '2026-03-11', {
    includeCurrentDay: true,
    minCoverageRatio: 0.8,
  });

  assert.equal(context.coveredDays, 1);
  assert.equal(context.partialCoveredDays, 2);
  assert.equal(context.coverageWeight, 2.5);
  assert.equal(context.coverageRatio, 2.5 / 3);
  assert.equal(context.hasReliableCoverage, true);
});
