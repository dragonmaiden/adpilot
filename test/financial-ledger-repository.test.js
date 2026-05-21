const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCogsSnapshots,
  buildMetaSnapshots,
  buildRevenueSnapshots,
} = require('../server/db/financialLedgerRepository');

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch (_) {
    // Module was not loaded.
  }
}

function installMockModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

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

test('financial ledger includes estimated daily reports in COGS correction candidates', async () => {
  const queries = [];
  const postgres = {
    isConfigured: () => true,
    query: async (text, params) => {
      queries.push({ text, params });
      return {
        rows: [{
          report_date: '2026-04-30',
          status: 'sent',
          payload: '📈 <b>Total Profits:</b> ₩6,882,764 est. (50% COGS)',
          metadata: { profitIsEstimated: true, telegramMessageId: 89 },
        }],
      };
    },
  };

  clearModule('../server/db/financialLedgerRepository');
  installMockModule('../server/db/postgres', postgres);

  try {
    const { listPendingCogsDailyReportDeliveries } = require('../server/db/financialLedgerRepository');
    const result = await listPendingCogsDailyReportDeliveries({ limit: 200 });

    assert.equal(result.ok, true);
    assert.equal(queries.length, 1);
    assert.equal(queries[0].params[0], 120);
    assert.ok(queries[0].text.includes("payload like '%N/A (COGS pending)%'"));
    assert.ok(queries[0].text.includes("metadata->>'profitIsEstimated' = 'true'"));
    assert.deepEqual(result.reports[0].metadata, {
      profitIsEstimated: true,
      telegramMessageId: 89,
    });
  } finally {
    clearModule('../server/db/financialLedgerRepository');
    clearModule('../server/db/postgres');
  }
});
