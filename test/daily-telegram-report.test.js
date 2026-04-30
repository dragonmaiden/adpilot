const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDailySummaryReportPlan,
  formatReportDate,
  getNextKstMidnightAt,
  resolveDailyReportDate,
} = require('../server/services/dailyTelegramReportService');

function buildLatestData(overrides = {}) {
  return {
    fx: {
      usdToKrwRate: 1500,
      source: 'test-rate',
      rateDate: '2026-04-30',
    },
    revenueData: {
      dailyRevenue: {
        '2026-04-30': { revenue: 13360120, refunded: 1729520, orders: 50 },
      },
    },
    campaignInsights: [
      { campaign_id: 'c1', campaign_name: 'Meta', date_start: '2026-04-30', spend: '0', actions: [] },
    ],
    cogsData: {
      dailyCOGS: {
        '2026-04-30': { cost: 8000000, shipping: 100000, purchases: 6, costCoverageRatio: 1 },
      },
    },
    ...overrides,
  };
}

test('daily report resolves the completed KST day at midnight', () => {
  const midnightKst = new Date('2026-04-30T15:00:00.000Z');

  assert.equal(resolveDailyReportDate(midnightKst), '2026-04-30');
  assert.equal(formatReportDate('2026-04-30'), '30th April');
  assert.equal(
    getNextKstMidnightAt(new Date('2026-04-30T14:59:00.000Z')).toISOString(),
    '2026-04-30T15:00:00.000Z'
  );
});

test('daily report message uses canonical financial projection totals', () => {
  const plan = buildDailySummaryReportPlan(
    buildLatestData(),
    { dailyReport: { reportDate: null, sentAt: null } },
    new Date('2026-04-30T15:00:00.000Z')
  );

  assert.equal(plan.shouldSend, true);
  assert.equal(plan.reportDate, '2026-04-30');
  assert.deepEqual(plan.totals, {
    reportDate: '2026-04-30',
    orders: 50,
    revenue: 13360120,
    refunds: 1729520,
    trueNetProfit: 2832764,
    profitAvailable: true,
  });
  assert.match(plan.text, /📊 <b>Summary Report on 30th April<\/b>/);
  assert.match(plan.text, /📦 <b>Total Orders:<\/b> 50/);
  assert.match(plan.text, /💰 <b>Total Revenue:<\/b> ₩13,360,120/);
  assert.match(plan.text, /📈 <b>Total Profits:<\/b> ₩2,832,764/);
  assert.match(plan.text, /❌ <b>Total Refunds:<\/b> ₩1,729,520/);
});

test('daily report skips duplicate report dates', () => {
  const plan = buildDailySummaryReportPlan(
    buildLatestData(),
    { dailyReport: { reportDate: '2026-04-30', sentAt: '2026-04-30T15:01:00.000Z' } },
    new Date('2026-04-30T15:00:00.000Z')
  );

  assert.equal(plan.shouldSend, false);
  assert.equal(plan.reason, 'daily-report-already-sent');
  assert.equal(plan.reportDate, '2026-04-30');
});

test('daily report refuses to print zero revenue when revenue source is stale for a COGS-active day', () => {
  const plan = buildDailySummaryReportPlan(
    buildLatestData({
      revenueData: { dailyRevenue: {} },
      sources: {
        imweb: {
          status: 'error',
          stale: true,
          lastError: 'Imweb token refresh failed',
        },
      },
    }),
    { dailyReport: { reportDate: null, sentAt: null } },
    new Date('2026-04-30T15:00:00.000Z')
  );

  assert.equal(plan.shouldSend, false);
  assert.equal(plan.reason, 'revenue-missing-for-cogs-activity');
  assert.equal(plan.reportDate, '2026-04-30');
  assert.equal(plan.diagnostics.hasCogsActivity, true);
  assert.equal(plan.diagnostics.cogsPurchases, 6);
});

test('daily report does not fake profit when COGS are pending for a sales day', () => {
  const latestData = buildLatestData({ cogsData: { dailyCOGS: {} } });
  const plan = buildDailySummaryReportPlan(
    latestData,
    { dailyReport: { reportDate: null, sentAt: null } },
    new Date('2026-04-30T15:00:00.000Z')
  );

  assert.equal(plan.totals.profitAvailable, false);
  assert.match(plan.text, /📈 <b>Total Profits:<\/b> N\/A \(COGS pending\)/);
});
