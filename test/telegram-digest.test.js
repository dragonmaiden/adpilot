const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildScanSummaryPlan,
  buildNotificationDecision,
  shouldSendStartupMessage,
} = require('../server/services/telegramDigestService');

const REFERENCE_NOW = new Date('2026-03-11T14:00:00Z');

function createActions(purchases) {
  if (purchases <= 0) return [];
  return [
    { action_type: 'purchase', value: String(purchases) },
    { action_type: 'offsite_conversion.fb_pixel_purchase', value: String(purchases) },
    { action_type: 'omni_purchase', value: String(purchases) },
  ];
}

function buildCampaignInsights({ baselineSpend, baselinePurchases, wednesdaySpend, wednesdayPurchases }) {
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
      clicks: '100',
      impressions: '1000',
      actions: createActions(purchases),
    });
  }

  return rows;
}

function buildAdInsights() {
  const start = new Date('2026-03-05T00:00:00Z');
  const rows = [];
  const weakCtr = [25, 22, 20, 18, 17, 16, 15];
  const stableCtr = [13, 13, 12.5, 12.8, 12.7, 12.6, 12.8];

  for (let i = 0; i < weakCtr.length; i += 1) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + i);
    rows.push({
      ad_id: 'ad-warning',
      date_start: date.toISOString().slice(0, 10),
      spend: '10',
      ctr: String(weakCtr[i]),
      cpm: '40',
      frequency: '1.1',
      clicks: '40',
      impressions: '300',
      actions: createActions(1),
    });
    rows.push({
      ad_id: 'ad-healthy',
      date_start: date.toISOString().slice(0, 10),
      spend: '50',
      ctr: String(stableCtr[i]),
      cpm: '28',
      frequency: '1.1',
      clicks: '80',
      impressions: '600',
      actions: createActions(2),
    });
  }

  return rows;
}

function buildLatestData() {
  return {
    campaigns: [{ id: 'c1', name: 'Test Campaign', status: 'ACTIVE' }],
    ads: [
      { id: 'ad-healthy', name: 'Winner Creative', status: 'ACTIVE' },
      { id: 'ad-warning', name: 'Support Creative', status: 'ACTIVE' },
    ],
    campaignInsights: buildCampaignInsights({
      baselineSpend: 60,
      baselinePurchases: 5,
      wednesdaySpend: 100,
      wednesdayPurchases: 4,
    }),
    adInsights: buildAdInsights(),
    revenueData: {
      totalRevenue: 1000000,
      totalRefunded: 150000,
      dailyRevenue: {
        '2026-03-05': { revenue: 600000, refunded: 0, orders: 4 },
        '2026-03-06': { revenue: 700000, refunded: 0, orders: 5 },
        '2026-03-07': { revenue: 800000, refunded: 0, orders: 6 },
        '2026-03-08': { revenue: 900000, refunded: 0, orders: 7 },
        '2026-03-09': { revenue: 850000, refunded: 100000, orders: 6 },
        '2026-03-10': { revenue: 820000, refunded: 50000, orders: 5 },
        '2026-03-11': { revenue: 780000, refunded: 0, orders: 4 },
      },
    },
    cogsData: {
      dailyCOGS: {
        '2026-03-05': { purchases: 4, cogs: 200000, shipping: 12000 },
        '2026-03-06': { purchases: 5, cogs: 230000, shipping: 12000 },
        '2026-03-07': { purchases: 6, cogs: 260000, shipping: 16000 },
        '2026-03-08': { purchases: 7, cogs: 290000, shipping: 16000 },
        '2026-03-09': { purchases: 6, cogs: 255000, shipping: 12000 },
        '2026-03-10': { purchases: 5, cogs: 225000, shipping: 12000 },
        '2026-03-11': { purchases: 4, cogs: 180000, shipping: 8000 },
      },
    },
    sources: {
      metaInsights: { status: 'connected' },
      imweb: { status: 'connected' },
      cogs: { status: 'connected' },
    },
  };
}

test('startup message is throttled when a recent startup notification was sent', () => {
  const state = { startup: { sentAt: '2026-03-11T10:00:00Z' } };
  assert.equal(shouldSendStartupMessage(state, new Date('2026-03-11T12:00:00Z')), false);
  assert.equal(shouldSendStartupMessage(state, new Date('2026-03-11T18:30:00Z')), true);
});

test('duplicate digest summaries are suppressed during cooldown', () => {
  const decision = buildNotificationDecision({
    category: 'digest',
    fingerprint: 'same',
    state: { summary: { fingerprint: 'same', sentAt: '2026-03-11T13:00:00Z' } },
    now: REFERENCE_NOW,
  });

  assert.equal(decision.shouldSend, false);
  assert.equal(decision.reason, 'duplicate-digest');
});

test('scan summary plan writes a higher-signal digest instead of a generic room-to-scale ping', () => {
  const plan = buildScanSummaryPlan({
    stats: {
      activeCampaigns: 1,
      activeAds: 2,
      totalSpend7d: '880.00',
    },
    optimizations: [
      {
        id: 'opt1',
        type: 'budget',
        level: 'account',
        targetName: 'Overall Profitability',
        action: 'True net profit is ₩2,050,000 — room to scale',
        reason: 'Last 7d true net profit is ₩2,050,000 on ₩5,500,000 net revenue (37.3% true net margin)',
        priority: 'medium',
        executed: false,
      },
    ],
  }, buildLatestData(), { summary: { fingerprint: null, sentAt: null } }, REFERENCE_NOW);

  assert.equal(plan.shouldSend, true);
  assert.equal(plan.category, 'digest');
  assert.match(plan.text, /Treat scaling as contribution-margin constrained, not ROAS-only/i);
  assert.match(plan.text, /Account performance is overly concentrated in one campaign and one lead creative/i);
  assert.match(plan.text, /Refund rate 15.0%/i);
});
