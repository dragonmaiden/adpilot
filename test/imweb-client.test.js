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
      business: {
        startDate: '2026-02-01',
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

test('getAllOrders requests every page from the first KST business day through one stable end time', async () => {
  const orderRequests = [];

  await withImwebClient(async (url, options = {}) => {
    if (url.endsWith('/oauth2/token')) return successfulTokenResponse();

    orderRequests.push({ url, options });
    const page = Number(new URL(url).searchParams.get('page'));
    const list = page === 1
      ? Array.from({ length: 100 }, (_, index) => ({ orderNo: `order-${index + 1}` }))
      : [{ orderNo: 'order-101' }];

    return new Response(JSON.stringify({
      statusCode: 200,
      data: {
        totalCount: 101,
        list,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, async client => {
    const endTime = new Date('2026-07-25T02:30:00.000Z');
    const orders = await client.getAllOrders({ endTime });

    assert.equal(orders.length, 101);
    assert.equal(orderRequests.length, 2);
    for (const [index, request] of orderRequests.entries()) {
      const url = new URL(request.url);
      assert.equal(request.options.method, 'GET');
      assert.equal(url.pathname, '/orders');
      assert.equal(url.searchParams.get('page'), String(index + 1));
      assert.equal(url.searchParams.get('limit'), '100');
      assert.equal(url.searchParams.get('startWtime'), '2026-01-31T15:00:00.000Z');
      assert.equal(url.searchParams.get('endWtime'), '2026-07-25T02:30:00.000Z');
    }
  });
});

test('getOrderHistoryTimeRange rejects a malformed business start date', async () => {
  await withImwebClient(async url => {
    if (url.endsWith('/oauth2/token')) return successfulTokenResponse();
    throw new Error(`Unexpected request: ${url}`);
  }, async client => {
    const originalStartDate = require(configPath).business.startDate;
    require(configPath).business.startDate = 'February 1';

    try {
      await assert.rejects(
        client.getAllOrders({ endTime: new Date('2026-07-25T02:30:00.000Z') }),
        /BUSINESS_START_DATE must use YYYY-MM-DD format/
      );
    } finally {
      require(configPath).business.startDate = originalStartDate;
    }
  });
});

test('confirmBankTransferPayment checks the order and calls the official Imweb confirmation endpoint', async () => {
  const requests = [];

  await withImwebClient(async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/oauth2/token')) return successfulTokenResponse();
    if (options.method === 'GET') {
      return new Response(JSON.stringify({
        statusCode: 200,
        data: {
          order: {
            orderNo: '202607237401269',
            mtime: '2026-07-23T06:50:00.000Z',
            payments: [{
              paidPrice: 245000,
              paymentStatus: 'PAYMENT_PREPARATION',
              method: 'BANKTRANSFER',
            }],
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      statusCode: 200,
      data: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, async client => {
    const result = await client.confirmBankTransferPayment('202607237401269');

    assert.deepEqual(result, {
      confirmed: true,
      alreadyConfirmed: false,
      orderNo: '202607237401269',
    });
    const confirmationRequest = requests.find(request => request.options.method === 'PATCH');
    assert.equal(
      confirmationRequest.url,
      'https://openapi.imweb.me/payments/202607237401269/bank-transfer/confirm'
    );
    assert.equal(confirmationRequest.options.body, undefined);
    assert.equal(confirmationRequest.options.headers.Authorization, 'Bearer new-access-token');
    assert.equal(confirmationRequest.options.headers['x-site-code'], 'site-code');
  });
});

test('confirmBankTransferPayment treats an already-paid order as reconciled without another write', async () => {
  const requests = [];

  await withImwebClient(async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/oauth2/token')) return successfulTokenResponse();
    return new Response(JSON.stringify({
      statusCode: 200,
      data: {
        order: {
          orderNo: '202607237401269',
          mtime: '2026-07-23T06:51:00.000Z',
          payments: [{
            paidPrice: 245000,
            paymentStatus: 'PAYMENT_COMPLETE',
            paymentCompleteTime: '2026-07-23T06:51:00.000Z',
            method: 'BANKTRANSFER',
          }],
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, async client => {
    const result = await client.confirmBankTransferPayment('202607237401269');

    assert.equal(result.confirmed, true);
    assert.equal(result.alreadyConfirmed, true);
    assert.equal(requests.filter(request => request.options.method === 'PATCH').length, 0);
  });
});

test('confirmBankTransferPayment refuses to mutate an order outside the pending bank-transfer state', async () => {
  const requests = [];

  await withImwebClient(async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/oauth2/token')) return successfulTokenResponse();
    return new Response(JSON.stringify({
      statusCode: 200,
      data: {
        order: {
          orderNo: '202607237401269',
          mtime: '2026-07-23T06:50:00.000Z',
          payments: [{
            paidPrice: 245000,
            paymentStatus: 'PAYMENT_PREPARATION',
            method: 'CARD',
          }],
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, async client => {
    await assert.rejects(
      client.confirmBankTransferPayment('202607237401269'),
      /is not awaiting a bank-transfer payment/
    );
    assert.equal(requests.filter(request => request.options.method === 'PATCH').length, 0);
  });
});

test('confirmBankTransferPayment does not treat a pending virtual account as a manual bank transfer', async () => {
  const requests = [];

  await withImwebClient(async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/oauth2/token')) return successfulTokenResponse();
    return new Response(JSON.stringify({
      statusCode: 200,
      data: {
        order: {
          orderNo: '202607237401270',
          mtime: '2026-07-23T06:50:00.000Z',
          payments: [{
            paidPrice: 245000,
            paymentStatus: 'PAYMENT_PREPARATION',
            method: 'VBANK',
          }],
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, async client => {
    await assert.rejects(
      client.confirmBankTransferPayment('202607237401270'),
      /is not awaiting a bank-transfer payment/
    );
    assert.equal(requests.filter(request => request.options.method === 'PATCH').length, 0);
  });
});
