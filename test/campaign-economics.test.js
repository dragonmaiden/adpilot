const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCampaignEconomics } = require('../server/services/campaignEconomicsService');

function createActions(purchases) {
  if (purchases <= 0) return [];
  return [
    { action_type: 'purchase', value: String(purchases) },
    { action_type: 'offsite_conversion.fb_pixel_purchase', value: String(purchases) },
    { action_type: 'omni_purchase', value: String(purchases) },
  ];
}

test('buildCampaignEconomics allocates only the Meta-attributable share of store economics', () => {
  const context = buildCampaignEconomics(
    [
      { id: 'c1', name: 'Scale Winner', status: 'ACTIVE' },
      { id: 'c2', name: 'Small Campaign', status: 'ACTIVE' },
    ],
    [
      { campaign_id: 'c1', date_start: '2026-03-11', spend: '60', actions: createActions(3) },
      { campaign_id: 'c2', date_start: '2026-03-11', spend: '30', actions: createActions(1) },
    ],
    {
      dailyRevenue: {
        '2026-03-11': { revenue: 1000000, refunded: 0, orders: 10 },
      },
    },
    {
      dailyCOGS: {
        '2026-03-11': { cost: 300000, shipping: 50000, costCoverageRatio: 1 },
      },
    },
    { status: 'connected', stale: false },
    {
      days: 7,
      referenceDate: '2026-03-12',
      includeCurrentDay: false,
    }
  );

  const winner = context.campaigns.find(campaign => campaign.campaignId === 'c1');
  const small = context.campaigns.find(campaign => campaign.campaignId === 'c2');

  assert.equal(context.summary.netRevenue, 1000000);
  assert.equal(context.summary.estimatedMetaRevenue, 400000);
  assert.equal(context.summary.totalMetaPurchases, 4);
  assert.equal(context.summary.attributableRevenueShare, 0.4);
  assert.equal(context.summary.confidence, 'medium');

  assert.equal(winner.estimatedRevenue, 300000);
  assert.equal(winner.allocatedCogs, 90000);
  assert.equal(winner.allocatedShipping, 15000);
  assert.equal(winner.allocatedFees, 18000);
  assert.equal(winner.estimatedTrueNetProfit, 90000);
  assert.equal(winner.confidence, 'medium');
  assert.equal(winner.confidenceLabel, 'Medium confidence');
  assert.equal(winner.hasReliableEstimate, true);
  assert.equal(winner.estimatedAov, 100000);
  assert.equal(winner.breakEvenCpa, 40.69);
  assert.equal(winner.targetCpa, 32.55);

  assert.equal(small.estimatedRevenue, 100000);
  assert.equal(small.allocatedCogs, 30000);
  assert.equal(small.allocatedShipping, 5000);
  assert.equal(small.allocatedFees, 6000);
  assert.equal(small.estimatedTrueNetProfit, 15500);
  assert.equal(small.confidence, 'low');
  assert.equal(small.hasReliableEstimate, false);
  assert.match(winner.confidenceReasons[0], /COGS coverage|Meta-attributed purchase|Evidence/i);
});

test('buildCampaignEconomics downgrades estimates when revenue freshness is unavailable', () => {
  const context = buildCampaignEconomics(
    [{ id: 'c1', name: 'Campaign 1', status: 'ACTIVE' }],
    [{ campaign_id: 'c1', date_start: '2026-03-11', spend: '60', actions: createActions(4) }],
    {
      dailyRevenue: {
        '2026-03-11': { revenue: 400000, refunded: 0, orders: 4 },
      },
    },
    {
      dailyCOGS: {
        '2026-03-11': { cost: 100000, shipping: 20000, costCoverageRatio: 1 },
      },
    },
    { status: 'error', stale: true },
    {
      days: 7,
      referenceDate: '2026-03-12',
      includeCurrentDay: false,
    }
  );

  assert.equal(context.summary.hasFreshRevenue, false);
  assert.equal(context.summary.hasReliableCoverage, false);
  assert.equal(context.summary.confidence, 'low');
  assert.equal(context.campaigns[0].confidence, 'low');
  assert.equal(context.campaigns[0].hasReliableEstimate, false);
});
