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

async function withTelegramModule(env, fetchImpl, run) {
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
