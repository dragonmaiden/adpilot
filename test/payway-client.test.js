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

test('parsePaymentHistoryHtml ignores the static Payway table header', () => {
  const html = `
    <table>
      <thead>
        <tr>
          <th>NO</th>
          <th>거래일자</th>
          <th>승인상태</th>
          <th>가맹점명</th>
          <th>단말기번호</th>
          <th>카드사</th>
          <th>할부</th>
          <th>카드번호</th>
          <th>승인번호</th>
          <th>승인금액</th>
          <th>취소금액</th>
          <th>거래금액</th>
        </tr>
      </thead>
    </table>
  `;

  assert.deepEqual(paywayClient.parsePaymentHistoryHtml(html), []);
});

test('parsePaymentHistoryAjaxResponse extracts Payway AJAX payment rows', () => {
  const payments = paywayClient.parsePaymentHistoryAjaxResponse({
    T1: [{ cnt: 1, amt: '254000.0000' }],
    T2: [
      {
        no: 1,
        pay_dt: '2026-05-19 06:25:20',
        cancel_yn: '0',
        mc_nm: 'SHUE',
        tmid: 'TMN009889',
        card_nm: '신한',
        cardno: '1234********5678',
        authno: '87654321',
        amt: '254,000',
        fee: '7,620',
      },
    ],
    'T-CNT': 1,
  });

  assert.equal(payments.length, 1);
  assert.equal(payments[0].status, '승인');
  assert.equal(payments[0].terminal, 'TMN009889');
  assert.equal(payments[0].approvalNo, '87654321');
  assert.equal(payments[0].transactionAmount, 254000);
  assert.equal(payments[0].cancelAmount, 0);
  assert.equal(payments[0].feeAmount, 7620);
  assert.equal(payments[0].transactionAtIso, '2026-05-18T21:25:20.000Z');
  assert.equal(paywayClient.isApprovedPaywayPayment(payments[0]), true);
});

test('parsePaymentHistoryAjaxResponse handles compact Payway payment timestamps', () => {
  const payments = paywayClient.parsePaymentHistoryAjaxResponse({
    T1: [{ cnt: 1, amt: '171000.0000' }],
    T2: [
      {
        pay_dt: '20260519205435',
        cancel_yn: 0,
        mc_nm: 'SHUE',
        tmid: 'TMN009889',
        authno: 'A1234567',
        amt: '171000.0000',
        fee: '10260',
      },
    ],
  });

  assert.equal(payments.length, 1);
  assert.equal(payments[0].transactionAt, '2026-05-19 20:54:35');
  assert.equal(payments[0].transactionAtIso, '2026-05-19T11:54:35.000Z');
  assert.equal(payments[0].transactionAmount, 171000);
  assert.equal(payments[0].feeAmount, 10260);
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

test('fetchPaymentHistory requests Payway AJAX rows for the KST payment window', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });

    if (calls.length === 1) {
      assert.equal(url, 'https://payway.kr/ajax.php');
      assert.equal(options.method, 'POST');
      assert.equal(new URLSearchParams(options.body).get('cmd'), 'LOGIN');
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'set-cookie': 'PAYWAYSESSID=session-1; Path=/' }),
        text: async () => JSON.stringify({ res: 'OK' }),
      };
    }

    assert.equal(url, 'https://payway.kr/ajax.php');
    assert.equal(options.method, 'POST');
    assert.match(options.headers.Cookie, /PAYWAYSESSID=session-1/);
    const params = new URLSearchParams(options.body);
    assert.equal(params.get('qry'), 'asp_usr_pay_lst');
    assert.equal(params.get('rtnType'), 'json3');
    const historyCallIndex = calls.length - 2;
    const expectedTerminal = historyCallIndex === 0 ? '' : 'TMN009889';
    const jData = JSON.parse(params.get('jData'));
    assert.deepEqual(jData, {
      st: '2026-05-18',
      ed: '2026-05-19',
      pay_sta: 'ALL',
      kf: expectedTerminal ? 'terminal' : '',
      k: expectedTerminal,
      rows: '150',
      page: 1,
      pageSize: 150,
    });

    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({
        T2: [
          {
            pay_dt: '2026-05-19 06:25:20',
            cancel_yn: '0',
            mc_nm: 'SHUE',
            tmid: 'TMN009889',
            authno: '87654321',
            amt: '254000',
          },
        ],
      }),
    };
  };

  try {
    await withMockedPaywayClient({
      payway: {
        enabled: true,
        baseUrl: 'https://payway.kr',
        mid: 'TMN009889',
        dashboardId: 'merchant',
        dashboardPassword: 'secret',
        requestTimeoutMs: 1000,
      },
    }, async client => {
      const payments = await client.fetchPaymentHistory({
        now: new Date('2026-05-18T22:24:00.000Z'),
      });

      assert.equal(payments.length, 1);
      assert.equal(payments[0].transactionAmount, 254000);
      assert.equal(calls.length, 3);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchPaymentHistory requests each configured Payway terminal id', async () => {
  const originalFetch = global.fetch;
  const requestedTerminals = [];
  global.fetch = async (url, options) => {
    if (options.method === 'POST' && new URLSearchParams(options.body).get('cmd') === 'LOGIN') {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'set-cookie': 'PAYWAYSESSID=session-2; Path=/' }),
        text: async () => JSON.stringify({ res: 'OK' }),
      };
    }

    assert.equal(url, 'https://payway.kr/ajax.php');
    const params = new URLSearchParams(options.body);
    const jData = JSON.parse(params.get('jData'));
    requestedTerminals.push(jData.k);
    const rows = jData.k
      ? [
        {
          pay_dt: '2026-06-02 09:23:56',
          cancel_yn: '0',
          mc_nm: 'SHUE',
          tmid: jData.k,
          authno: jData.k === 'TMN025656' ? '22223333' : '11112222',
          amt: jData.k === 'TMN025656' ? '96900' : '100800',
        },
      ]
      : [
        {
          pay_dt: '2026-06-02 09:23:56',
          cancel_yn: '0',
          mc_nm: 'SHUE',
          tmid: 'TMN009889',
          authno: '11112222',
          amt: '100800',
        },
        {
          pay_dt: '2026-06-02 09:23:56',
          cancel_yn: '0',
          mc_nm: 'SHUE',
          tmid: 'TMN025656',
          authno: '22223333',
          amt: '96900',
        },
      ];

    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({
        T2: rows,
      }),
    };
  };

  try {
    await withMockedPaywayClient({
      payway: {
        enabled: true,
        baseUrl: 'https://payway.kr',
        mid: 'TMN009889, TMN025656, TMN009889',
        dashboardId: 'merchant',
        dashboardPassword: 'secret',
        requestTimeoutMs: 1000,
      },
    }, async client => {
      assert.deepEqual(client.getConfiguredTerminalIds(), ['TMN009889', 'TMN025656']);

      const payments = await client.fetchPaymentHistory({
        now: new Date('2026-06-02T00:25:00.000Z'),
      });

      assert.deepEqual(requestedTerminals, ['', 'TMN009889', 'TMN025656']);
      assert.deepEqual(payments.map(payment => payment.terminal), ['TMN009889', 'TMN025656']);
      assert.deepEqual(payments.map(payment => payment.transactionAmount), [100800, 96900]);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchPaymentHistory keeps successful rows when a stale terminal query fails', async () => {
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  const requestedTerminals = [];
  const warnings = [];

  console.warn = message => {
    warnings.push(String(message));
  };

  global.fetch = async (url, options) => {
    if (options.method === 'POST' && new URLSearchParams(options.body).get('cmd') === 'LOGIN') {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'set-cookie': 'PAYWAYSESSID=session-3; Path=/' }),
        text: async () => JSON.stringify({ res: 'OK' }),
      };
    }

    assert.equal(url, 'https://payway.kr/ajax.php');
    const params = new URLSearchParams(options.body);
    const jData = JSON.parse(params.get('jData'));
    requestedTerminals.push(jData.k);

    if (jData.k === 'TMN009889') {
      return {
        ok: false,
        status: 500,
        headers: new Headers(),
        text: async () => 'stale terminal filter failed',
      };
    }

    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({
        T2: [
          {
            pay_dt: '2026-06-02 09:33:56',
            cancel_yn: '0',
            mc_nm: 'SHUE',
            tmid: 'TMN777777',
            authno: '66667777',
            amt: '96900',
          },
        ],
      }),
    };
  };

  try {
    await withMockedPaywayClient({
      payway: {
        enabled: true,
        baseUrl: 'https://payway.kr',
        mid: 'TMN009889',
        dashboardId: 'merchant',
        dashboardPassword: 'secret',
        requestTimeoutMs: 1000,
      },
    }, async client => {
      const payments = await client.fetchPaymentHistory({
        now: new Date('2026-06-02T00:35:00.000Z'),
      });

      assert.deepEqual(requestedTerminals, ['', 'TMN009889']);
      assert.equal(payments.length, 1);
      assert.equal(payments[0].terminal, 'TMN777777');
      assert.equal(payments[0].transactionAmount, 96900);
      assert.match(warnings[0], /supplemental payment history request/);
    });
  } finally {
    console.warn = originalWarn;
    global.fetch = originalFetch;
  }
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
      watchMinutes: 60,
      configuredWatchMinutes: 10,
      minimumWatchMinutes: 60,
      pollIntervalSeconds: 30,
      matchLeadMinutes: 2,
      strictTerminalMatch: false,
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
