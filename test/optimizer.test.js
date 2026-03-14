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
  const start = new Date('2026-02-12T00:00:00Z');
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

function createCampaignEconomicsContext(overrides = {}) {
  return {
    campaigns: [
      {
        campaignId: 'c1',
        estimatedRevenue: 520000,
        estimatedTrueNetProfit: 1844935,
        estimatedMargin: 0.354,
        confidence: 'high',
        hasReliableEstimate: true,
        contributionPerSpend: 0.45,
        ...overrides,
      },
    ],
  };
}

test('analyzeCampaigns suppresses scale-up when the current weekday is materially weak', () => {
  const engine = new OptimizationEngine(1);
  const insights = buildInsights({
    baselineSpend: 60,
    baselinePurchases: 5,
    wednesdaySpend: 100,
    wednesdayPurchases: 4,
  });

  engine.analyzeCampaigns([createCampaign()], insights, createCampaignEconomicsContext(), REFERENCE_DATE);

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

  engine.analyzeCampaigns([createCampaign()], insights, createCampaignEconomicsContext(), REFERENCE_DATE);

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

  engine.analyzeCampaigns([createCampaign()], insights, createCampaignEconomicsContext(), REFERENCE_DATE);

  assert.equal(engine.actions.length, 1);
  assert.equal(engine.actions[0].priority, 'medium');
  assert.match(engine.actions[0].action, /\$22\.00/);
});

test('analyzeCampaigns blocks scale-up when campaign-level economics are not reliable', () => {
  const engine = new OptimizationEngine(4);
  const insights = buildInsights({
    baselineSpend: 60,
    baselinePurchases: 5,
    wednesdaySpend: 55,
    wednesdayPurchases: 5,
  });

  engine.analyzeCampaigns([createCampaign()], insights, createCampaignEconomicsContext({
    confidence: 'low',
    hasReliableEstimate: false,
  }), REFERENCE_DATE);

  assert.equal(engine.actions.length, 0);
});

test('analyzeCampaigns ignores an incomplete current day when recent CPA would otherwise look weak', () => {
  const engine = new OptimizationEngine(5);
  const insights = [
    { campaign_id: 'c1', date_start: '2026-03-08', spend: '60', actions: createActions(5), frequency: '1.2' },
    { campaign_id: 'c1', date_start: '2026-03-09', spend: '60', actions: createActions(5), frequency: '1.2' },
    { campaign_id: 'c1', date_start: '2026-03-10', spend: '60', actions: createActions(5), frequency: '1.2' },
    { campaign_id: 'c1', date_start: '2026-03-11', spend: '120', actions: createActions(0), frequency: '1.2' },
    { campaign_id: 'c1', date_start: '2026-03-04', spend: '55', actions: createActions(5), frequency: '1.2' },
    { campaign_id: 'c1', date_start: '2026-02-25', spend: '55', actions: createActions(5), frequency: '1.2' },
    { campaign_id: 'c1', date_start: '2026-02-18', spend: '55', actions: createActions(5), frequency: '1.2' },
  ];

  engine.analyzeCampaigns([createCampaign()], insights, createCampaignEconomicsContext(), REFERENCE_DATE);

  assert.equal(engine.actions.length, 1);
  assert.match(engine.actions[0].action, /\$22\.00/);
});

test('analyzeCampaigns requires stronger evidence before issuing a scale-up', () => {
  const engine = new OptimizationEngine(6);
  const insights = [
    { campaign_id: 'c1', date_start: '2026-03-08', spend: '60', actions: createActions(4), frequency: '1.2' },
    { campaign_id: 'c1', date_start: '2026-03-09', spend: '60', actions: createActions(0), frequency: '1.2' },
    { campaign_id: 'c1', date_start: '2026-03-10', spend: '60', actions: createActions(2), frequency: '1.2' },
    { campaign_id: 'c1', date_start: '2026-03-04', spend: '55', actions: createActions(5), frequency: '1.2' },
    { campaign_id: 'c1', date_start: '2026-02-25', spend: '55', actions: createActions(0), frequency: '1.2' },
    { campaign_id: 'c1', date_start: '2026-02-18', spend: '55', actions: createActions(0), frequency: '1.2' },
  ];

  engine.analyzeCampaigns([createCampaign()], insights, createCampaignEconomicsContext(), REFERENCE_DATE);

  assert.equal(engine.actions.length, 0);
});

test('analyzeCampaigns blocks scale-up when the campaign estimated contribution is negative', () => {
  const engine = new OptimizationEngine(7);
  const insights = buildInsights({
    baselineSpend: 60,
    baselinePurchases: 5,
    wednesdaySpend: 55,
    wednesdayPurchases: 5,
  });

  engine.analyzeCampaigns([createCampaign()], insights, createCampaignEconomicsContext({
    estimatedTrueNetProfit: -120000,
    estimatedMargin: -0.08,
  }), REFERENCE_DATE);

  assert.equal(engine.actions.length, 0);
});

test('analyzeCampaigns downgrades scale-up when concentration and fatigue caveats exist', () => {
  const engine = new OptimizationEngine(9);
  const insights = buildInsights({
    baselineSpend: 60,
    baselinePurchases: 5,
    wednesdaySpend: 55,
    wednesdayPurchases: 5,
  });
  const campaignRiskContext = new Map([
    ['c1', {
      activeCampaignCount: 1,
      activeAdCount: 4,
      fatiguedAds: [{ id: 'ad1', name: 'Fatigued Ad' }],
      severeFatigueBlock: false,
      hasConcentrationRisk: true,
      hasCreativeDepthRisk: false,
    }],
  ]);

  engine.analyzeCampaigns([createCampaign()], insights, createCampaignEconomicsContext(), REFERENCE_DATE, campaignRiskContext);

  assert.equal(engine.actions.length, 1);
  assert.equal(engine.actions[0].priority, 'low');
  assert.match(engine.actions[0].reason, /Scale caveats:/);
  assert.match(engine.actions[0].impact, /\+\d+ to \+\d+/);
});

test('analyzeCampaigns blocks scale-up when fatigue is widespread across active ads', () => {
  const engine = new OptimizationEngine(10);
  const insights = buildInsights({
    baselineSpend: 60,
    baselinePurchases: 5,
    wednesdaySpend: 55,
    wednesdayPurchases: 5,
  });
  const campaignRiskContext = new Map([
    ['c1', {
      activeCampaignCount: 1,
      activeAdCount: 4,
      fatiguedAds: [{ id: 'ad1', name: 'Ad 1' }, { id: 'ad2', name: 'Ad 2' }],
      severeFatigueBlock: true,
      hasConcentrationRisk: true,
      hasCreativeDepthRisk: false,
    }],
  ]);

  engine.analyzeCampaigns([createCampaign()], insights, createCampaignEconomicsContext(), REFERENCE_DATE, campaignRiskContext);

  assert.equal(engine.actions.length, 0);
});

test('analyzeBudgetReallocation follows contribution estimates instead of issuing a CPA-only move', () => {
  const engine = new OptimizationEngine(8);
  const campaigns = [
    { id: 'c1', name: 'Scale Winner', status: 'ACTIVE', daily_budget: '11000' },
    { id: 'c2', name: 'Drag Campaign', status: 'ACTIVE', daily_budget: '9000' },
  ];
  const insights = [
    { campaign_id: 'c1', date_start: '2026-03-08', spend: '55', actions: createActions(5) },
    { campaign_id: 'c1', date_start: '2026-03-09', spend: '55', actions: createActions(5) },
    { campaign_id: 'c1', date_start: '2026-03-10', spend: '55', actions: createActions(5) },
    { campaign_id: 'c2', date_start: '2026-03-08', spend: '60', actions: createActions(5) },
    { campaign_id: 'c2', date_start: '2026-03-09', spend: '60', actions: createActions(5) },
    { campaign_id: 'c2', date_start: '2026-03-10', spend: '60', actions: createActions(5) },
  ];

  engine.analyzeBudgetReallocation(campaigns, insights, {
    campaigns: [
      {
        campaignId: 'c1',
        estimatedTrueNetProfit: 220000,
        estimatedMargin: 0.18,
        contributionPerSpend: 0.3,
        hasReliableEstimate: true,
      },
      {
        campaignId: 'c2',
        estimatedTrueNetProfit: -90000,
        estimatedMargin: -0.06,
        contributionPerSpend: -0.12,
        hasReliableEstimate: true,
      },
    ],
  });

  assert.equal(engine.actions.length, 1);
  assert.match(engine.actions[0].reason, /estimated contribution/i);
  assert.match(engine.actions[0].action, /Reallocate \$45\.00\/day/);
});
