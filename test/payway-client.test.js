const test = require('node:test');
const assert = require('node:assert/strict');

const paywayClient = require('../server/modules/paywayClient');

async function withMockedPaywayClient(config, run) {
  const clientPath = require.resolve('../server/modules/paywayClient');
  const configPath = require.resolve('../server/config');
  const originalClient = require.cache[clientPath] || null;
  const originalConfig = require.cache[configPath] || null;

  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: config,
  };
  delete require.cache[clientPath];

  try {
    const mockedClient = require(clientPath);
    return await run(mockedClient);
  } finally {
    delete require.cache[clientPath];
    if (originalClient) {
      require.cache[clientPath] = originalClient;
    }
    if (originalConfig) {
      require.cache[configPath] = originalConfig;
    } else {
      delete require.cache[configPath];
    }
  }
}

test('parsePaymentHistoryHtml extracts approved Payway card rows', () => {
  const html = `
    <table>
      <tbody>
        <tr>
          <td>1</td>
          <td>2026-03-15 12:30:45</td>
          <td>승인</td>
          <td>SHUE</td>
          <td>TMN009889</td>
          <td>신한</td>
          <td>일시불</td>
          <td>1234********5678</td>
          <td>87654321</td>
          <td>111,000</td>
          <td>0</td>
          <td>111,000</td>
          <td>3,300</td>
          <td>107,700</td>
          <td>2026-03-18</td>
          <td>PG</td>
          <td>agent</td>
        </tr>
      </tbody>
    </table>
  `;

  const payments = paywayClient.parsePaymentHistoryHtml(html);

  assert.equal(payments.length, 1);
  assert.equal(payments[0].status, '승인');
  assert.equal(payments[0].terminal, 'TMN009889');
  assert.equal(payments[0].approvalNo, '87654321');
  assert.equal(payments[0].transactionAmount, 111000);
  assert.equal(payments[0].cancelAmount, 0);
  assert.equal(payments[0].transactionAtIso, '2026-03-15T03:30:45.000Z');
  assert.equal(paywayClient.isApprovedPaywayPayment(payments[0]), true);
});

test('isApprovedPaywayPayment rejects cancelled approval rows', () => {
  const [payment] = paywayClient.parsePaymentHistoryHtml(`
    <table>
      <tr>
        <td>2</td>
        <td>2026-03-15 12:31:00</td>
        <td>승인</td>
        <td>SHUE</td>
        <td>TMN009889</td>
        <td>신한</td>
        <td>일시불</td>
        <td>1234********5678</td>
        <td>87654322</td>
        <td>111,000</td>
        <td>111,000</td>
        <td>0</td>
      </tr>
    </table>
  `);

  assert.equal(paywayClient.isApprovedPaywayPayment(payment), false);
});

test('login fails loud when Payway returns a non-JSON dashboard response', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => '<html>login page</html>',
  });

  try {
    await withMockedPaywayClient({
      payway: {
        enabled: true,
        baseUrl: 'https://payway.kr',
        dashboardId: 'merchant',
        dashboardPassword: 'secret',
        requestTimeoutMs: 1000,
      },
    }, async client => {
      await assert.rejects(
        () => client.login(),
        /Payway login failed: HTTP 200/
      );
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('getStatus reports Payway readiness without exposing secrets', async () => {
  await withMockedPaywayClient({
    payway: {
      enabled: true,
      mid: 'TMN009889',
      dashboardId: 'merchant',
      dashboardPassword: 'secret',
      historyPath: '/pay',
      watchMinutes: 10,
      pollIntervalSeconds: 30,
      matchLeadMinutes: 2,
    },
  }, async client => {
    assert.deepEqual(client.getStatus(), {
      status: 'ready',
      enabled: true,
      configured: true,
      reason: null,
      midConfigured: true,
      dashboardCredentialsConfigured: true,
      sessionCookieConfigured: false,
      historyPath: '/pay',
      watchMinutes: 10,
      pollIntervalSeconds: 30,
      matchLeadMinutes: 2,
    });
  });
});

test('getStatus explains disabled and unconfigured Payway states', async () => {
  await withMockedPaywayClient({
    payway: {
      enabled: false,
      mid: '',
      historyPath: '/pay',
    },
  }, async client => {
    const status = client.getStatus();
    assert.equal(status.status, 'disabled');
    assert.equal(status.reason, 'payway_disabled');
    assert.equal(status.configured, false);
  });

  await withMockedPaywayClient({
    payway: {
      enabled: true,
      mid: 'TMN009889',
      historyPath: '/pay',
    },
  }, async client => {
    const status = client.getStatus();
    assert.equal(status.status, 'not_configured');
    assert.equal(status.reason, 'payway_not_configured');
    assert.equal(status.midConfigured, true);
    assert.equal(status.configured, false);
  });
});
