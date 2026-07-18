const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const clientPath = require.resolve('../server/modules/imwebClient');
const configPath = require.resolve('../server/config');
const runtimePathsPath = require.resolve('../server/runtime/paths');
const telegramPath = require.resolve('../server/modules/telegram');

function successfulTokenResponse() {
  return new Response(JSON.stringify({
    statusCode: 200,
    data: {
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresIn: 7200,
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function withImwebClient(fetchImpl, run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adpilot-imweb-client-'));
  const tokenFilePath = path.join(tempDir, 'imweb_tokens.json');
  fs.writeFileSync(tokenFilePath, JSON.stringify({
    access_token: 'expired-access-token',
    refresh_token: 'current-refresh-token',
    expires_at: Date.now() - 1,
    chain_started_at: Date.now() - 86_400_000,
  }));

  const originalEntries = new Map([
    [clientPath, require.cache[clientPath] || null],
    [configPath, require.cache[configPath] || null],
    [runtimePathsPath, require.cache[runtimePathsPath] || null],
    [telegramPath, require.cache[telegramPath] || null],
  ]);
  const originalFetch = global.fetch;

  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
      imweb: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        siteCode: 'site-code',
        baseUrl: 'https://openapi.imweb.me',
      },
    },
  };
  require.cache[runtimePathsPath] = {
    id: runtimePathsPath,
    filename: runtimePathsPath,
    loaded: true,
    exports: { imwebTokenFile: tokenFilePath },
  };
  require.cache[telegramPath] = {
    id: telegramPath,
    filename: telegramPath,
    loaded: true,
    exports: { sendMessage: async () => ({ ok: true }) },
  };
  delete require.cache[clientPath];
  global.fetch = fetchImpl;

  try {
    const client = require(clientPath);
    client.loadTokens();
    await run(client, tokenFilePath);
  } finally {
    global.fetch = originalFetch;
    for (const [modulePath, originalEntry] of originalEntries) {
      if (originalEntry) require.cache[modulePath] = originalEntry;
      else delete require.cache[modulePath];
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('concurrent Imweb refresh callers share one rotating-token request', async () => {
  let fetchCount = 0;

  await withImwebClient(async () => {
    fetchCount++;
    await new Promise(resolve => setImmediate(resolve));
    return successfulTokenResponse();
  }, async (client, tokenFilePath) => {
    await Promise.all([
      client.refreshAccessToken(),
      client.refreshAccessToken(),
      client.refreshAccessToken(),
    ]);

    assert.equal(fetchCount, 1);
    const savedTokens = JSON.parse(fs.readFileSync(tokenFilePath, 'utf8'));
    assert.equal(savedTokens.refresh_token, 'new-refresh-token');
    assert.equal(client.getAuthState().status, 'connected');
  });
});

test('Imweb refresh retries a pre-request DNS failure', async () => {
  let fetchCount = 0;

  await withImwebClient(async () => {
    fetchCount++;
    if (fetchCount === 1) {
      const dnsError = Object.assign(new Error('getaddrinfo EAI_AGAIN openapi.imweb.me'), {
        code: 'EAI_AGAIN',
      });
      throw new TypeError('fetch failed', { cause: dnsError });
    }
    return successfulTokenResponse();
  }, async client => {
    await client.refreshAccessToken();

    assert.equal(fetchCount, 2);
    assert.equal(client.getAuthState().lastError, null);
  });
});

test('Imweb refresh preserves the underlying cause without replaying an ambiguous socket failure', async () => {
  let fetchCount = 0;

  await withImwebClient(async () => {
    fetchCount++;
    const socketError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    throw new TypeError('fetch failed', { cause: socketError });
  }, async client => {
    await assert.rejects(
      client.refreshAccessToken(),
      /Imweb token refresh network error: fetch failed <- ECONNRESET: socket hang up/
    );

    assert.equal(fetchCount, 1);
    assert.match(client.getAuthState().lastError, /ECONNRESET: socket hang up/);
  });
});

test('Imweb refresh does not retry a rejected refresh token', async () => {
  let fetchCount = 0;

  await withImwebClient(async () => {
    fetchCount++;
    return new Response(JSON.stringify({
      statusCode: 400,
      error: {
        errorCode: 30170,
        message: 'invalid refresh token',
      },
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }, async client => {
    await assert.rejects(
      client.refreshAccessToken(),
      /Imweb token refresh failed \(HTTP 400\): 30170: invalid refresh token/
    );

    assert.equal(fetchCount, 1);
    assert.match(client.getAuthState().lastError, /30170/);
  });
});
