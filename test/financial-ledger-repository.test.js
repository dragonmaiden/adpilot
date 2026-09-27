const test = require('node:test');
const assert = require('node:assert/strict');

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

test('financial ledger does not duplicate historical daily snapshots on every scan', async () => {
  const queries = [];
  const postgres = {
    isConfigured: () => true,
    withClient: async callback => callback({
      query: async (sql, params) => {
        queries.push({ sql, params });
        return { rows: [] };
      },
    }),
  };
  clearModule('../server/db/financialLedgerRepository');
  installMockModule('../server/db/postgres', postgres);
  try {
    const { persistScanLedger } = require('../server/db/financialLedgerRepository');
    const result = await persistScanLedger({
      scanResult: { scanId: 'scan-1', status: 'success' },
      latestData: {
        revenueData: { dailyRevenue: { '2026-04-30': { revenue: 1300000 } } },
        cogsData: { dailyCOGS: { '2026-04-30': { cost: 631000 } } },
        campaignInsights: [{ date_start: '2026-04-30', spend: '10.25' }],
        orders: [],
      },
    });
    assert.deepEqual(result, { ok: true, imwebOrders: 0 });
    assert.ok(queries.some(query => query.sql.includes('insert into scan_runs')));
    assert.ok(!queries.some(query => query.sql.includes('daily_source_snapshots')));
    assert.equal(queries.at(-1).sql, 'commit');
  } finally {
    clearModule('../server/db/financialLedgerRepository');
    clearModule('../server/db/postgres');
  }
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
    assert.ok(queries[0].text.includes("status in ('sent', 'corrected')"));
    assert.ok(queries[0].text.includes("payload like '%N/A (COGS pending)%'"));
    assert.ok(queries[0].text.includes("metadata->>'profitIsEstimated' = 'true'"));
    assert.ok(queries[0].text.includes("metadata->>'chartPending' = 'true'"));
    assert.deepEqual(result.reports[0].metadata, {
      profitIsEstimated: true,
      telegramMessageId: 89,
    });
  } finally {
    clearModule('../server/db/financialLedgerRepository');
    clearModule('../server/db/postgres');
  }
});

test('recent Telegram report lookup is bounded and includes already-complete reports', async () => {
  const queries = [];
  const postgres = {
    isConfigured: () => true,
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };
  clearModule('../server/db/financialLedgerRepository');
  installMockModule('../server/db/postgres', postgres);
  try {
    const { listRecentDailyReportDeliveries } = require('../server/db/financialLedgerRepository');
    await listRecentDailyReportDeliveries({ sinceDate: '2026-09-13', limit: 21 });
    assert.match(queries[0].sql, /report_date >= \$1::date/);
    assert.match(queries[0].sql, /status in \('sent', 'corrected'\)/);
    assert.deepEqual(queries[0].params, ['2026-09-13', 21]);
  } finally {
    clearModule('../server/db/financialLedgerRepository');
    clearModule('../server/db/postgres');
  }
});
