const test = require('node:test');
const assert = require('node:assert/strict');

const scheduler = require('../server/modules/scheduler');
const { getOverviewResponse } = require('../server/services/overviewService');

test('overview withholds financial headlines when a required source is stale', async () => {
  const original = {
    getLatestData: scheduler.getLatestData,
    getLastScanResult: scheduler.getLastScanResult,
    getLastScanTime: scheduler.getLastScanTime,
    getIsScanning: scheduler.getIsScanning,
    getSourceHealth: scheduler.getSourceHealth,
  };
  const data = {
    fx: { usdToKrwRate: 1300 },
    revenueData: {
      totalRevenue: 100000,
      totalRefunded: 0,
      netRevenue: 100000,
      totalOrders: 1,
      dailyRevenue: { '2026-09-26': { revenue: 100000, refunded: 0, orders: 1 } },
    },
    cogsData: {
      totalCOGSWithShipping: 30000,
      purchaseCount: 1,
      dailyCOGS: { '2026-09-26': { cost: 26000, shipping: 4000, purchases: 1, costCoverageRatio: 1 } },
    },
    campaignInsights: [],
    sources: {
      metaInsights: { status: 'error', stale: true, hasData: true },
      cogs: { status: 'connected', stale: false, hasData: true },
      imweb: { status: 'connected', stale: false, hasData: true },
    },
  };
  try {
    scheduler.getLatestData = () => data;
    scheduler.getLastScanResult = () => ({ stats: {} });
    scheduler.getLastScanTime = () => new Date('2026-09-26T15:00:00Z');
    scheduler.getIsScanning = () => false;
    scheduler.getSourceHealth = () => data.sources;

    const staleMeta = await getOverviewResponse();
    assert.equal(staleMeta.kpis.adSpendKRW, null);
    assert.equal(staleMeta.kpis.grossProfit, null);
    assert.equal(staleMeta.kpis.grossMargin, null);
    assert.equal(staleMeta.kpis.roas, null);
    assert.equal(staleMeta.kpis.cogs, 30000);

    data.sources.metaInsights = { status: 'connected', stale: false, hasData: true };
    const fresh = await getOverviewResponse();
    assert.equal(fresh.kpis.grossProfit, 70000);

    data.sources.cogs = { status: 'error', stale: true, hasData: true };
    const staleCogs = await getOverviewResponse();
    assert.equal(staleCogs.kpis.cogs, null);
    assert.equal(staleCogs.kpis.purchases, null);
    assert.equal(staleCogs.kpis.cpa, null);
    assert.equal(staleCogs.kpis.grossProfit, null);
  } finally {
    Object.assign(scheduler, original);
  }
});
