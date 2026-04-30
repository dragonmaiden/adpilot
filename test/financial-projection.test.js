const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFinancialProjection } = require('../server/services/financialProjectionService');
const { buildEconomicsLedger } = require('../server/services/economicsLedgerService');

test('financial projection applies one scan FX rate to merged rows and profit waterfall', () => {
  const data = {
    fx: {
      base: 'USD',
      quote: 'KRW',
      source: 'test-rate',
      usdToKrwRate: 1500,
      rateDate: '2026-04-30',
      fetchedAt: '2026-04-30T00:00:00.000Z',
    },
    revenueData: {
      dailyRevenue: {
        '2026-04-30': { revenue: 100000, refunded: 10000, orders: 2 },
      },
      hourlyOrders: [],
    },
    campaignInsights: [
      { campaign_id: 'c1', campaign_name: 'Meta', date_start: '2026-04-30', spend: '10', actions: [] },
    ],
    cogsData: {
      dailyCOGS: {
        '2026-04-30': { cost: 30000, shipping: 5000, costCoverageRatio: 1 },
      },
    },
  };

  const projection = buildFinancialProjection(data);
  const day = projection.dailyMerged[0];
  const waterfall = projection.profitWaterfall[0];

  assert.equal(projection.fx.usdToKrwRate, 1500);
  assert.equal(day.spendKrw, 15000);
  assert.equal(waterfall.adSpendKRW, 15000);
  assert.equal(waterfall.paymentFees, 5400);
  assert.equal(waterfall.trueNetProfit, 34600);
});

test('economics ledger uses the same explicit FX rate for Meta spend rows', () => {
  const ledger = buildEconomicsLedger({
    orders: [],
    cogsData: { orders: [] },
    campaigns: [],
    campaignInsights: [
      { campaign_id: 'c1', campaign_name: 'Meta', date_start: '2026-04-30', spend: '10' },
    ],
    usdToKrwRate: 1500,
  });

  assert.equal(ledger.summary.totalMetaSpendKrw, 15000);
  assert.equal(
    ledger.rows.find(row => row.kind === 'meta_spend')?.amount,
    15000
  );
});
