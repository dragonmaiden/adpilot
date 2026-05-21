const test = require('node:test');
const assert = require('node:assert/strict');

const ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_PRIVATE_CHAT_ID',
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

test('sendPrivateMessage keeps existing group-chat delivery when no private chat is configured', async () => {
  const requests = [];
  await withTelegramModule(validEnv(), async (_url, options = {}) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  }, async telegram => {
    const result = await telegram.sendPrivateMessage('secret');

    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].chat_id, '-100111222333');
    assert.equal(requests[0].protect_content, true);
  });
});

test('sendPrivateMessage uses the configured private chat boundary', async () => {
  const requests = [];
  await withTelegramModule(validEnv({
    TELEGRAM_PRIVATE_CHAT_ID: '-100999888777',
  }), async (_url, options = {}) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 44 } }) };
  }, async telegram => {
    const result = await telegram.sendPrivateMessage('secret');

    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].chat_id, '-100999888777');
    assert.equal(requests[0].protect_content, true);
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
    requests.push({ url, body: JSON.parse(options.body) });
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
    assert.match(requests[0].body.text, /₩6,882,764 est\. \(50% COGS\)/);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'sent');
    assert.equal(records[0].metadata.telegramMessageId, 88);
    assert.equal(records[0].metadata.profitAvailable, false);
    assert.equal(records[0].metadata.profitIsEstimated, true);
    assert.equal(records[0].metadata.cogsCoverageRatio, 0.5);
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
