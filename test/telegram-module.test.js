const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDailyProfitChart } = require('../server/services/profitChartService');
const { buildDailyReportCorrectionPlan } = require('../server/services/dailyTelegramReportService');
test.beforeEach(() => {
  test.mock.method(require('../server/services/fxService'), 'getUsdToKrwRatesForRange', async () => ({ ratesByDate: {} }));
  test.mock.method(require('../server/services/paywayFinancialService'), 'getPaywayFinancialSummary', async () => ({
    ready: true, totals: { feesComplete: true }, daily: [],
  }));
});
test.afterEach(() => test.mock.restoreAll());

const ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_REQUEST_TIMEOUT_MS',
];

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

async function withTelegramModule(env, fetchImpl, run, overrides = {}) {
  const originalEnv = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    if (Object.hasOwn(env, key)) {
      process.env[key] = env[key];
    } else {
      delete process.env[key];
    }
  }
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;

  clearModule('../server/config');
  clearModule('../server/modules/telegram');
  clearModule('../server/modules/telegramState');
  clearModule('../server/db/financialLedgerRepository');
  if (overrides.telegramState) {
    installMockModule('../server/modules/telegramState', overrides.telegramState);
  }
  if (overrides.financialLedgerRepository) {
    installMockModule('../server/db/financialLedgerRepository', overrides.financialLedgerRepository);
  }

  try {
    const telegram = require('../server/modules/telegram');
    return await run(telegram);
  } finally {
    global.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (originalEnv[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    clearModule('../server/modules/telegram');
    clearModule('../server/modules/telegramState');
    clearModule('../server/db/financialLedgerRepository');
    clearModule('../server/config');
  }
}

function validEnv(overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz',
    TELEGRAM_CHAT_ID: '-100111222333',
    TELEGRAM_REQUEST_TIMEOUT_MS: '5',
    ...overrides,
  };
}

function buildDailyReportLatestData(cogsRow) {
  return {
    fx: { usdToKrwRate: 1500 },
    revenueData: {
      dailyRevenue: {
        '2026-04-30': { revenue: 13360120, refunded: 1729520, orders: 50 },
      },
    },
    campaignInsights: [],
    cogsData: {
      dailyCOGS: {
        '2026-04-30': cogsRow,
      },
    },
  };
}

test('probeConnection verifies the configured Telegram chat', async () => {
  const requests = [];
  await withTelegramModule(validEnv(), async url => {
    requests.push(url);
    if (url.includes('/getMe')) {
      return {
        ok: true,
        json: async () => ({ ok: true, result: { id: 8702525178, username: 'Shuekimchi_bot' } }),
      };
    }
    if (url.includes('/getChat')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: { id: -100111222333, type: 'supergroup', title: 'Shue Orders' },
        }),
      };
    }
    throw new Error(`Unexpected Telegram endpoint: ${url}`);
  }, async telegram => {
    const result = await telegram.probeConnection();
    const status = telegram.getStatus();

    assert.equal(result.username, 'Shuekimchi_bot');
    assert.equal(requests.length, 2);
    assert.match(requests[1], /getChat\?chat_id=-100111222333$/);
    assert.equal(status.status, 'connected');
    assert.equal(status.chatAccessible, true);
    assert.equal(status.chatType, 'supergroup');
    assert.equal(status.chatTitle, 'Shue Orders');
    assert.equal(status.lastError, null);
  });
});

test('probeConnection reports an unreachable Telegram chat separately from bot auth', async () => {
  await withTelegramModule(validEnv(), async url => {
    if (url.includes('/getMe')) {
      return {
        ok: true,
        json: async () => ({ ok: true, result: { id: 8702525178, username: 'Shuekimchi_bot' } }),
      };
    }
    if (url.includes('/getChat')) {
      return {
        ok: true,
        json: async () => ({ ok: false, description: 'Bad Request: chat not found' }),
      };
    }
    throw new Error(`Unexpected Telegram endpoint: ${url}`);
  }, async telegram => {
    const result = await telegram.probeConnection();
    const status = telegram.getStatus();

    assert.equal(result, null);
    assert.equal(status.status, 'error');
    assert.equal(status.botUsername, 'Shuekimchi_bot');
    assert.equal(status.chatAccessible, false);
    assert.equal(status.chatType, null);
    assert.match(status.lastError, /Telegram chat not found/);
  });
});

test('sendMessage fails fast when Telegram does not respond', async () => {
  await withTelegramModule(validEnv(), (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  }), async telegram => {
    const startedAt = Date.now();
    const result = await telegram.sendMessage('hello');

    assert.equal(result.ok, false);
    assert.equal(result.error_code, 'TIMEOUT');
    assert.match(result.description, /timed out after 5ms/);
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(telegram.getStatus().status, 'error');
  });
});

test('sendDailySummaryReport records partial COGS metadata for the correction sweep', async () => {
  const requests = [];
  const records = [];
  const financialLedgerRepository = {
    recordTelegramReportDelivery: async payload => {
      records.push(payload);
      return { ok: true };
    },
  };
  const telegramState = {
    getState: () => ({ dailyReport: { reportDate: null, sentAt: null } }),
    markDailyReportSent: () => {},
  };

  await withTelegramModule(validEnv(), async (url, options = {}) => {
    requests.push({ url, body: Object.fromEntries(options.body), headers: options.headers });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 88 } }) };
  }, async telegram => {
    const result = await telegram.sendDailySummaryReport(
      buildDailyReportLatestData({
        cost: 4000000,
        shipping: 50000,
        purchases: 6,
        costCoverageRatio: 0.5,
      }),
      {
        now: new Date('2026-04-30T14:30:00.000Z'),
        sentAt: '2026-04-30T14:30:01.000Z',
      }
    );

    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /sendPhoto$/);
    assert.match(requests[0].body.caption, /⚠️ ₩6,882,764 est\. \(50% COGS\)/);
    assert.equal(requests[0].body.photo.type, 'image/png');
    assert.ok(requests[0].body.photo.size > 0);
    assert.equal(requests[0].headers['Content-Type'], undefined);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'sent');
    assert.equal(records[0].metadata.telegramMessageId, 88);
    assert.equal(records[0].metadata.profitAvailable, false);
    assert.equal(records[0].metadata.profitIsEstimated, true);
    assert.equal(records[0].metadata.cogsCoverageRatio, 0.5);
    assert.equal(records[0].metadata.messageType, 'photo');
    assert.equal(records[0].metadata.chartPending, true);
  }, { financialLedgerRepository, telegramState });
});

test('refreshPendingDailyReports edits stale COGS-pending reports once profit is available', async () => {
  const requests = [];
  const records = [];
  const financialLedgerRepository = {
    listPendingCogsDailyReportDeliveries: async () => ({
      ok: true,
      reports: [{
        reportDate: '2026-04-30',
        status: 'sent',
        payload: '📈 <b>Total Profits:</b> N/A (COGS pending)',
        sentAt: '2026-04-30T14:30:00.000Z',
        metadata: { telegramMessageId: 77 },
      }],
    }),
    recordTelegramReportDelivery: async payload => {
      records.push(payload);
      return { ok: true };
    },
  };

  await withTelegramModule(validEnv(), async (url, options = {}) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 77 } }) };
  }, async telegram => {
    const result = await telegram.refreshPendingDailyReports(buildDailyReportLatestData({
      cost: 8000000,
      shipping: 100000,
      purchases: 6,
      costCoverageRatio: 1,
    }));

    assert.equal(result.corrected, 1);
    assert.equal(result.failed, 0);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /editMessageText$/);
    assert.equal(requests[0].body.message_id, 77);
    assert.match(requests[0].body.text, /📈 <b>Total Profits:<\/b> ₩2,832,764/);
    assert.doesNotMatch(requests[0].body.text, /N\/A \(COGS pending\)/);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'corrected');
    assert.equal(records[0].sentAt, '2026-04-30T14:30:00.000Z');
    assert.equal(records[0].metadata.correctionDelivery, 'edited_message');
    assert.equal(records[0].metadata.telegramMessageId, 77);
  }, { financialLedgerRepository });
});

test('refreshPendingDailyReports edits stale COGS-pending reports once partial COGS is available', async () => {
  const requests = [];
  const records = [];
  const financialLedgerRepository = {
    listPendingCogsDailyReportDeliveries: async () => ({
      ok: true,
      reports: [{
        reportDate: '2026-04-30',
        status: 'sent',
        payload: '📈 <b>Total Profits:</b> N/A (COGS pending)',
        sentAt: '2026-04-30T14:30:00.000Z',
        metadata: { telegramMessageId: 87 },
      }],
    }),
    recordTelegramReportDelivery: async payload => {
      records.push(payload);
      return { ok: true };
    },
  };

  await withTelegramModule(validEnv(), async (url, options = {}) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 87 } }) };
  }, async telegram => {
    const result = await telegram.refreshPendingDailyReports(buildDailyReportLatestData({
      cost: 4000000,
      shipping: 50000,
      purchases: 6,
      costCoverageRatio: 0.5,
    }));

    assert.equal(result.corrected, 1);
    assert.equal(result.failed, 0);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /editMessageText$/);
    assert.equal(requests[0].body.message_id, 87);
    assert.match(requests[0].body.text, /📈 <b>Total Profits:<\/b> ⚠️ ₩6,882,764 est\. \(50% COGS\)/);
    assert.doesNotMatch(requests[0].body.text, /N\/A \(COGS pending\)/);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'corrected');
    assert.equal(records[0].metadata.correctionReason, 'cogs-partial-estimate');
    assert.equal(records[0].metadata.profitAvailable, false);
    assert.equal(records[0].metadata.profitIsEstimated, true);
    assert.equal(records[0].metadata.cogsCoverageRatio, 0.5);
  }, { financialLedgerRepository });
});

test('refreshPendingDailyReports edits estimated partial-COGS reports once profit is available', async () => {
  const requests = [];
  const records = [];
  const financialLedgerRepository = {
    listPendingCogsDailyReportDeliveries: async () => ({
      ok: true,
      reports: [{
        reportDate: '2026-04-30',
        status: 'sent',
        payload: '📈 <b>Total Profits:</b> ₩6,882,764 est. (50% COGS)',
        sentAt: '2026-04-30T14:30:00.000Z',
        metadata: { telegramMessageId: 89, profitIsEstimated: true, cogsCoverageRatio: 0.5 },
      }],
    }),
    recordTelegramReportDelivery: async payload => {
      records.push(payload);
      return { ok: true };
    },
  };

  await withTelegramModule(validEnv(), async (url, options = {}) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 89 } }) };
  }, async telegram => {
    const result = await telegram.refreshPendingDailyReports(buildDailyReportLatestData({
      cost: 8000000,
      shipping: 100000,
      purchases: 6,
      costCoverageRatio: 1,
    }));

    assert.equal(result.corrected, 1);
    assert.equal(result.failed, 0);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /editMessageText$/);
    assert.equal(requests[0].body.message_id, 89);
    assert.match(requests[0].body.text, /📈 <b>Total Profits:<\/b> ₩2,832,764/);
    assert.doesNotMatch(requests[0].body.text, /est\./);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'corrected');
    assert.equal(records[0].metadata.correctionDelivery, 'edited_message');
    assert.equal(records[0].metadata.telegramMessageId, 89);
    assert.equal(records[0].metadata.profitAvailable, true);
    assert.equal(records[0].metadata.profitIsEstimated, false);
    assert.equal(records[0].metadata.cogsCoverageRatio, 1);
  }, { financialLedgerRepository });
});

test('photo report corrections update the chart and caption together and skip unchanged charts', async () => {
  const requests = [];
  const records = [];
  const data = buildDailyReportLatestData({ cost: 8000000, shipping: 100000, purchases: 6, costCoverageRatio: 1 });
  const report = {
    reportDate: '2026-04-30', payload: 'Old estimate',
    metadata: { telegramMessageId: 90, messageType: 'photo', chartPending: true },
  };
  const repository = {
    listPendingCogsDailyReportDeliveries: async () => ({ reports: [report] }),
    recordTelegramReportDelivery: async record => records.push(record),
  };
  await withTelegramModule(validEnv(), async (url, options) => {
    requests.push({ url, form: options.body });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 90 } }) };
  }, async telegram => {
    const result = await telegram.refreshPendingDailyReports(data);
    assert.equal(result.corrected, 1);
    assert.match(requests[0].url, /editMessageMedia$/);
    assert.equal(requests[0].form.get('message_id'), '90');
    const media = JSON.parse(requests[0].form.get('media'));
    assert.equal(media.media, 'attach://photo');
    assert.equal(media.parse_mode, 'HTML');
    assert.match(media.caption, /₩2,832,764/);
    assert.equal(records[0].metadata.chartPending, false);
    assert.equal(records[0].metadata.messageType, 'photo');
    report.metadata = records[0].metadata;
    report.payload = records[0].payload;
    const unchanged = await telegram.refreshPendingDailyReports(data);
    assert.equal(unchanged.waiting, 1);
    assert.equal(requests.length, 1);
  }, { financialLedgerRepository: repository });
});

test('historical COGS completion refreshes a chart even when the report day remains pending', async () => {
  const data = buildDailyReportLatestData({ cost: 4000000, shipping: 50000, purchases: 6, costCoverageRatio: 0.5 });
  const oldChart = await buildDailyProfitChart(data, '2026-04-30');
  const oldPlan = buildDailyReportCorrectionPlan(data, '2026-04-30', { allowEstimated: true });
  const report = {
    reportDate: '2026-04-30', payload: oldPlan.text,
    metadata: { telegramMessageId: 91, messageType: 'photo', chartPending: true, profitIsEstimated: true, chartFingerprint: oldChart.fingerprint },
  };
  data.revenueData.dailyRevenue['2026-04-29'] = { revenue: 100000, refunded: 0, orders: 1 };
  data.cogsData.dailyCOGS['2026-04-29'] = { cost: 10000, shipping: 0, costCoverageRatio: 1 };
  let calls = 0;
  await withTelegramModule(validEnv(), async url => {
    assert.match(url, /editMessageMedia$/);
    calls += 1;
    return { ok: true, json: async () => ({ ok: true }) };
  }, async telegram => {
    const result = await telegram.refreshPendingDailyReports(data);
    assert.equal(result.corrected, 1);
    assert.equal(calls, 1);
  }, { financialLedgerRepository: {
    listPendingCogsDailyReportDeliveries: async () => ({ reports: [report] }),
    recordTelegramReportDelivery: async record => assert.equal(record.metadata.chartPending, true),
  } });
});

test('failed photo edits stay failed without posting duplicate summaries', async () => {
  let calls = 0;
  await withTelegramModule(validEnv(), async () => {
    calls += 1;
    return { ok: true, json: async () => ({ ok: false, description: 'Cannot edit photo' }) };
  }, async telegram => {
    const result = await telegram.refreshPendingDailyReports(buildDailyReportLatestData({ cost: 8000000, shipping: 100000, costCoverageRatio: 1 }));
    assert.equal(result.failed, 1);
    assert.equal(calls, 1);
  }, { financialLedgerRepository: {
    listPendingCogsDailyReportDeliveries: async () => ({ reports: [{ reportDate: '2026-04-30', metadata: { telegramMessageId: 92, messageType: 'photo', chartPending: true } }] }),
    recordTelegramReportDelivery: async () => assert.fail('Failed edit cannot be recorded as corrected'),
  } });
});

test('Telegram already-unchanged response still persists refreshed chart metadata', async () => {
  const records = [];
  await withTelegramModule(validEnv(), async () => ({
    ok: true, json: async () => ({ ok: false, description: 'Bad Request: message is not modified' }),
  }), async telegram => {
    const result = await telegram.refreshPendingDailyReports(buildDailyReportLatestData({ cost: 8000000, shipping: 100000, costCoverageRatio: 1 }));
    assert.equal(result.corrected, 1);
    assert.equal(records[0].metadata.chartPending, false);
    assert.ok(records[0].metadata.chartFingerprint);
  }, { financialLedgerRepository: {
    listPendingCogsDailyReportDeliveries: async () => ({ reports: [{ reportDate: '2026-04-30', metadata: { telegramMessageId: 92, messageType: 'photo', chartPending: true } }] }),
    recordTelegramReportDelivery: async record => records.push(record),
  } });
});

test('failed photo sends do not mark the day as sent or attempt a duplicate text send', async () => {
  let calls = 0;
  await withTelegramModule(validEnv(), async url => {
    assert.match(url, /sendPhoto$/);
    calls += 1;
    throw new Error('network unavailable');
  }, async telegram => {
    const result = await telegram.sendDailySummaryReport(buildDailyReportLatestData({ cost: 100, costCoverageRatio: 1 }), { now: new Date('2026-04-30T14:30:00Z') });
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
  }, {
    telegramState: { getState: () => ({}), markDailyReportSent: () => assert.fail('Must not mark failed delivery sent') },
    financialLedgerRepository: { recordTelegramReportDelivery: async record => assert.equal(record.status, 'failed') },
  });
});

test('unavailable chart keeps the summary deliverable with explicit text fallback metadata', async () => {
  const data = buildDailyReportLatestData({ cost: 100, costCoverageRatio: 1 });
  data.sources = { imweb: { stale: true } };
  await withTelegramModule(validEnv(), async (url, options) => {
    assert.match(url, /sendMessage$/);
    assert.match(JSON.parse(options.body).text, /Chart unavailable; summary sent as text/);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 93 } }) };
  }, async telegram => {
    assert.equal((await telegram.sendDailySummaryReport(data, { now: new Date('2026-04-30T14:30:00Z') })).ok, true);
  }, {
    telegramState: { getState: () => ({}), markDailyReportSent: () => {} },
    financialLedgerRepository: { recordTelegramReportDelivery: async record => {
      assert.equal(record.metadata.messageType, 'text');
      assert.match(record.metadata.chartError, /stale/);
      assert.match(record.payload, /Chart unavailable; summary sent as text/);
    } },
  });
});
