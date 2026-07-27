const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFeaturedProfitSummary,
  buildFinancialProjection,
} = require('../server/services/financialProjectionService');
const { buildEconomicsLedger } = require('../server/services/economicsLedgerService');
const transforms = require('../server/transforms/charts');

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

test('financial projection applies each date FX rate to Meta spend and selected campaign totals', () => {
  const data = {
    fx: {
      base: 'USD',
      quote: 'KRW',
      source: 'latest-test-rate',
      usdToKrwRate: 1600,
      rateDate: '2026-07-03',
      fetchedAt: '2026-07-03T12:00:00.000Z',
      stale: false,
    },
    revenueData: {
      dailyRevenue: {
        '2026-07-01': { revenue: 100_000, refunded: 0, orders: 1 },
        '2026-07-02': { revenue: 200_000, refunded: 0, orders: 1 },
      },
      hourlyOrders: [],
    },
    campaignInsights: [
      { campaign_id: 'c1', campaign_name: 'Meta', date_start: '2026-07-01', spend: '10', actions: [] },
      { campaign_id: 'c1', campaign_name: 'Meta', date_start: '2026-07-02', spend: '30', actions: [] },
    ],
    cogsData: {
      dailyCOGS: {},
    },
  };
  const projection = buildFinancialProjection(data, {
    usdToKrwRatesByDate: {
      '2026-07-01': { usdToKrwRate: 1400, rateDate: '2026-07-01' },
      '2026-07-02': { usdToKrwRate: 1500, rateDate: '2026-07-02' },
    },
  });

  assert.deepEqual(
    projection.dailyMerged.map(day => ({
      date: day.date,
      spendKrw: day.spendKrw,
      usdToKrwRate: day.usdToKrwRate,
      fxRateDate: day.fxRateDate,
    })),
    [
      {
        date: '2026-07-01',
        spendKrw: 14_000,
        usdToKrwRate: 1400,
        fxRateDate: '2026-07-01',
      },
      {
        date: '2026-07-02',
        spendKrw: 45_000,
        usdToKrwRate: 1500,
        fxRateDate: '2026-07-02',
      },
    ]
  );
  assert.deepEqual(
    projection.profitWaterfall.map(day => day.adSpendKRW),
    [14_000, 45_000]
  );

  const [campaign] = transforms.buildCampaignProfit(
    data.campaignInsights,
    [{ id: 'c1', name: 'Meta' }],
    100_000,
    { totalCOGS: 0, totalShipping: 0 },
    200_000,
    projection.transformOptions
  );
  assert.equal(campaign.spendKRW, 59_000);
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

test('featured profit summary prefers today partial COGS estimate over older completed profit', () => {
  const rows = [
    {
      date: '2026-05-19',
      trueNetProfit: 265434,
      hasCOGS: true,
      hasPartialCOGS: false,
      cogsCoverageRatio: 1,
    },
    {
      date: '2026-05-20',
      trueNetProfit: 338357,
      hasCOGS: false,
      hasPartialCOGS: true,
      cogsCoverageRatio: 0.857,
    },
    {
      date: '2026-05-21',
      trueNetProfit: 650616,
      hasCOGS: false,
      hasPartialCOGS: true,
      cogsCoverageRatio: 0.8,
    },
  ];
  const coverage = {
    confidence: { level: 'high', label: 'High confidence', color: '#4ade80' },
  };
  const summary = buildFeaturedProfitSummary(rows, coverage, '2026-05-21');

  assert.equal(summary.date, '2026-05-21');
  assert.equal(summary.trueNetProfit, 650616);
  assert.equal(summary.summaryType, 'estimated');
  assert.equal(summary.isEstimated, true);
  assert.equal(summary.hasPartialCOGS, true);
  assert.equal(summary.cogsCoverageRatio, 0.8);

  const afterMidnightSummary = buildFeaturedProfitSummary(rows, coverage, '2026-05-22');

  assert.equal(afterMidnightSummary.date, '2026-05-21');
  assert.equal(afterMidnightSummary.trueNetProfit, 650616);
  assert.equal(afterMidnightSummary.summaryType, 'latest_estimated');
  assert.equal(afterMidnightSummary.isEstimated, true);
  assert.equal(afterMidnightSummary.hasPartialCOGS, true);
  assert.equal(afterMidnightSummary.cogsCoverageRatio, 0.8);
});
