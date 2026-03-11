const test = require('node:test');
const assert = require('node:assert/strict');

const OptimizationEngine = require('../server/modules/optimizer');

const REFERENCE_DATE = '2026-03-11';

function createActions(purchases) {
  if (purchases <= 0) return [];
  return [
    { action_type: 'purchase', value: String(purchases) },
    { action_type: 'offsite_conversion.fb_pixel_purchase', value: String(purchases) },
    { action_type: 'omni_purchase', value: String(purchases) },
  ];
}

function buildInsights({ baselineSpend, baselinePurchases, wednesdaySpend, wednesdayPurchases }) {
  const rows = [];
  const start = new Date('2026-02-26T00:00:00Z');
  const end = new Date('2026-03-11T00:00:00Z');

  for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    const weekday = cursor.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    const spend = weekday === 'Wednesday' ? wednesdaySpend : baselineSpend;
    const purchases = weekday === 'Wednesday' ? wednesdayPurchases : baselinePurchases;
    rows.push({
      campaign_id: 'c1',
      date_start: date,
      spend: String(spend),
      actions: createActions(purchases),
    });
  }

  return rows;
}

function createCampaign() {
  return {
    id: 'c1',
    name: 'Test Campaign',
    status: 'ACTIVE',
    daily_budget: '11000',
  };
}

function createProfitContext() {
  return {
    hasReliableCoverage: true,
    trueNetProfit: 1844935,
    margin: 0.354,
  };
}

const freshRevenueSource = { status: 'connected', stale: false };
const staleRevenueSource = { status: 'error', stale: true };

test('analyzeCampaigns suppresses scale-up when the current weekday is materially weak', () => {
  const engine = new OptimizationEngine(1);
  const insights = buildInsights({
    baselineSpend: 60,
    baselinePurchases: 5,
    wednesdaySpend: 100,
    wednesdayPurchases: 4,
  });

  engine.analyzeCampaigns([createCampaign()], insights, createProfitContext(), freshRevenueSource, REFERENCE_DATE);

  assert.equal(engine.actions.length, 0);
});

test('analyzeCampaigns downgrades scale-up to low priority when the current weekday is mildly weak', () => {
  const engine = new OptimizationEngine(2);
  const insights = buildInsights({
    baselineSpend: 60,
    baselinePurchases: 5,
    wednesdaySpend: 75,
    wednesdayPurchases: 5,
  });

  engine.analyzeCampaigns([createCampaign()], insights, createProfitContext(), freshRevenueSource, REFERENCE_DATE);

  assert.equal(engine.actions.length, 1);
  assert.equal(engine.actions[0].priority, 'low');
  assert.match(engine.actions[0].reason, /Meta-attributed purchases/);
  assert.match(engine.actions[0].reason, /Wednesday is softer than the weekday baseline/);
});

test('analyzeCampaigns allows a medium-priority scale-up when the current weekday is healthy', () => {
  const engine = new OptimizationEngine(3);
  const insights = buildInsights({
    baselineSpend: 60,
    baselinePurchases: 5,
    wednesdaySpend: 55,
    wednesdayPurchases: 5,
  });

  engine.analyzeCampaigns([createCampaign()], insights, createProfitContext(), freshRevenueSource, REFERENCE_DATE);

  assert.equal(engine.actions.length, 1);
  assert.equal(engine.actions[0].priority, 'medium');
  assert.match(engine.actions[0].action, /\$22\.00/);
});

test('analyzeCampaigns blocks profit-backed scale-up when the Imweb revenue source is stale', () => {
  const engine = new OptimizationEngine(4);
  const insights = buildInsights({
    baselineSpend: 60,
    baselinePurchases: 5,
    wednesdaySpend: 55,
    wednesdayPurchases: 5,
  });

  engine.analyzeCampaigns([createCampaign()], insights, createProfitContext(), staleRevenueSource, REFERENCE_DATE);

  assert.equal(engine.actions.length, 0);
});
