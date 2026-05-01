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
  assert.deepEqual({
    reportDate: plan.totals.reportDate,
    orders: plan.totals.orders,
    revenue: plan.totals.revenue,
    refunds: plan.totals.refunds,
    netRevenue: plan.totals.netRevenue,
    cogs: plan.totals.cogs,
    shipping: plan.totals.shipping,
    cogsWithShipping: plan.totals.cogsWithShipping,
    adSpendKrw: plan.totals.adSpendKrw,
    paymentFees: plan.totals.paymentFees,
    trueNetProfit: plan.totals.trueNetProfit,
    profitAvailable: plan.totals.profitAvailable,
    roas: plan.totals.roas,
  }, {
    reportDate: '2026-04-30',
    orders: 50,
    revenue: 13360120,
    refunds: 1729520,
    netRevenue: 11630600,
    cogs: 8000000,
    shipping: 100000,
    cogsWithShipping: 8100000,
    adSpendKrw: 0,
    paymentFees: 697836,
    trueNetProfit: 2832764,
    profitAvailable: true,
    roas: null,
  });
  assert.ok(Math.abs(plan.totals.marginPct - 24.3561) < 0.001);
  assert.ok(Math.abs(plan.totals.refundRatePct - 12.9454) < 0.001);
  assert.ok(Math.abs(plan.totals.cogsSharePct - 69.6439) < 0.001);
  assert.match(plan.text, /📊 <b>Summary Report on 30th April<\/b>/);
  assert.match(plan.text, /<i>.+<\/i>/);
  assert.match(plan.text, /📦 <b>Total Orders:<\/b> 50/);
  assert.match(plan.text, /💰 <b>Total Revenue:<\/b> ₩13,360,120/);
  assert.match(plan.text, /📈 <b>Total Profits:<\/b> ₩2,832,764/);
  assert.match(plan.text, /📐 <b>Net Profit Margin:<\/b> 24%/);
  assert.match(plan.text, /❌ <b>Total Refunds:<\/b> ₩1,729,520/);
  assert.match(plan.text, /🧾 <b>Total Costs:<\/b> ₩8,797,836/);
  assert.match(plan.text, /└ COGS: ₩8,000,000/);
  assert.match(plan.text, /└ Shipping: ₩100,000/);
  assert.match(plan.text, /└ Payment Fees: ₩697,836/);
  assert.match(plan.text, /└ Ad Spend: ₩0/);
  assert.doesNotMatch(plan.text, /net margin landed/);
  assert.doesNotMatch(plan.text, /Refund watch/);
  assert.doesNotMatch(plan.text, /Cost watch/);
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
  assert.match(plan.text, /📐 <b>Net Profit Margin:<\/b> N\/A/);
  assert.match(plan.text, /⏳ <b>Watch:<\/b> profit is pending final COGS coverage/);
});

test('daily report adds data and Telegram audit warnings without changing core totals', () => {
  const plan = buildDailySummaryReportPlan(
    buildLatestData({
      sourceAudit: {
        reconciliation: {
          status: 'mismatch',
          failedChecks: ['imweb_orders_to_revenue_gross', 'true_net_profit_identity'],
        },
      },
      orderNotificationAudit: {
        status: 'failed',
        summary: {
          missingDeliveryCount: 1,
          staleNotificationCount: 1,
        },
      },
    }),
    { dailyReport: { reportDate: null, sentAt: null } },
    new Date('2026-04-30T15:00:00.000Z')
  );

  assert.equal(plan.shouldSend, true);
  assert.match(plan.text, /<i>.*(?:Data check needed|Audit review needed|Pipeline needs a look).*<\/i>/);
  assert.match(plan.text, /⚠️ <b>Data check:<\/b> 2 source audit issues/);
  assert.match(plan.text, /⚠️ <b>Telegram audit:<\/b> 2 order alert issues/);
  assert.match(plan.text, /📦 <b>Total Orders:<\/b> 50/);
});

test('daily report uses the insight block for campaign watch items', () => {
  const plan = buildDailySummaryReportPlan(
    buildLatestData({
      campaignInsights: [
        {
          campaign_id: 'c-watch',
          campaign_name: 'Cold Prospecting',
          date_start: '2026-04-30',
          spend: '100',
          actions: [],
        },
        {
          campaign_id: 'c-best',
          campaign_name: 'Retargeting <VIP>',
          date_start: '2026-04-30',
          spend: '40',
          actions: [{ action_type: 'purchase', value: '2' }],
        },
      ],
    }),
    { dailyReport: { reportDate: null, sentAt: null } },
    new Date('2026-04-30T15:00:00.000Z')
  );

  assert.match(plan.text, /🧾 <b>Total Costs:<\/b> ₩9,007,836/);
  assert.match(plan.text, /└ Ad Spend: ₩210,000/);
  assert.match(plan.text, /👀 <b>Campaign watch:<\/b> Cold Prospecting spent ₩150,000 with 0 Meta purchases/);
  assert.match(plan.text, /🎯 <b>Best Meta signal:<\/b> Retargeting &lt;VIP&gt; drove 2 purchases at ₩30,000 CPA/);
});

test('daily report celebrates record orders, record sales, and above-average profit when history supports it', () => {
  const dailyRevenue = {};
  const dailyCOGS = {};

  for (let day = 23; day <= 29; day += 1) {
    const date = `2026-04-${day}`;
    dailyRevenue[date] = {
      revenue: 1000000 + ((day - 23) * 50000),
      refunded: 0,
      orders: 5 + (day - 23),
    };
    dailyCOGS[date] = {
      cost: 500000,
      shipping: 50000,
      purchases: 5 + (day - 23),
      costCoverageRatio: 1,
    };
  }

  dailyRevenue['2026-04-30'] = { revenue: 2000000, refunded: 0, orders: 20 };
  dailyCOGS['2026-04-30'] = { cost: 600000, shipping: 50000, purchases: 20, costCoverageRatio: 1 };

  const plan = buildDailySummaryReportPlan(
    buildLatestData({
      revenueData: { dailyRevenue },
      cogsData: { dailyCOGS },
      campaignInsights: [],
    }),
    { dailyReport: { reportDate: null, sentAt: null } },
    new Date('2026-04-30T15:00:00.000Z')
  );

  assert.deepEqual(plan.totals.historicalSignals.map(signal => signal.type), [
    'record_orders',
    'record_revenue',
    'profit_above_recent_average',
  ]);
  assert.match(plan.text, /🏆 <b>New orders high:<\/b> 20 orders beat the previous best of 11/);
  assert.match(plan.text, /🏆 <b>New sales high:<\/b> ₩2,000,000 beat the previous best of ₩1,300,000/);
  assert.match(plan.text, /🎉 <b>Profit signal:<\/b> ₩1,230,000 is \d+% above the recent 7-day average/);
});
