const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCogsSnapshots,
  buildMetaSnapshots,
  buildRevenueSnapshots,
} = require('../server/db/financialLedgerRepository');

test('financial ledger builds daily source snapshots without recalculating UI metrics', () => {
  const latestData = {
    revenueData: {
      dailyRevenue: {
        '2026-04-30': { revenue: 1300000, refunded: 0, orders: 6 },
      },
    },
    cogsData: {
      dailyCOGS: {
        '2026-04-30': { cost: 631000, shipping: 24000, purchases: 6 },
      },
    },
    campaignInsights: [
      {
        campaign_id: 'campaign-1',
        date_start: '2026-04-30',
        spend: '10.25',
        clicks: '20',
        impressions: '1000',
        actions: [{ action_type: 'purchase', value: '2' }],
      },
      {
        campaign_id: 'campaign-2',
        date_start: '2026-04-30',
        spend: '5.75',
        clicks: '10',
        impressions: '500',
        actions: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '1' }],
      },
    ],
  };

  assert.deepEqual(buildRevenueSnapshots(latestData), [
    {
      source: 'imweb_revenue',
      date: '2026-04-30',
      totals: { revenue: 1300000, refunded: 0, orders: 6 },
    },
  ]);
  assert.deepEqual(buildCogsSnapshots(latestData), [
    {
      source: 'cogs',
      date: '2026-04-30',
      totals: { cost: 631000, shipping: 24000, purchases: 6 },
    },
  ]);
  assert.deepEqual(buildMetaSnapshots(latestData), [
    {
      source: 'meta_ads',
      date: '2026-04-30',
      totals: {
        rows: 2,
        spendUsd: 16,
        purchases: 3,
        clicks: 30,
        impressions: 1500,
      },
    },
  ]);
});
