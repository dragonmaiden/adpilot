const test = require('node:test');
const assert = require('node:assert/strict');

async function withMockedPaywayFinancialService(paywayClient, run) {
  const servicePath = require.resolve('../server/services/paywayFinancialService');
  const clientPath = require.resolve('../server/modules/paywayClient');
  const originalService = require.cache[servicePath] || null;
  const originalClient = require.cache[clientPath] || null;

  require.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: paywayClient,
  };
  delete require.cache[servicePath];

  try {
    return await run(require(servicePath));
  } finally {
    delete require.cache[servicePath];
    if (originalService) {
      require.cache[servicePath] = originalService;
    }
    if (originalClient) {
      require.cache[clientPath] = originalClient;
    } else {
      delete require.cache[clientPath];
    }
  }
}

function makeTransaction(transactionId, date, amount) {
  return {
    transactionId,
    transactionAtIso: `${date}T01:00:00.000Z`,
    status: '승인',
    approvedAmount: amount,
    transactionAmount: amount,
    cancelAmount: 0,
    feeAmount: amount * 0.06,
  };
}

test('Payway summary reuses a fresh containing range for a nested calendar selection', async () => {
  const fetches = [];
  const transactions = [
    makeTransaction('payment-1', '2026-07-01', 100_000),
    makeTransaction('payment-2', '2026-07-02', 50_000),
  ];

  await withMockedPaywayFinancialService({
    isConfigured: () => true,
    fetchPaymentHistory: async range => {
      fetches.push(range);
      return transactions;
    },
  }, async service => {
    const broad = await service.getPaywayFinancialSummary({
      startDate: '2026-07-01',
      endDate: '2026-07-07',
    });
    const nested = await service.getPaywayFinancialSummary({
      startDate: '2026-07-02',
      endDate: '2026-07-02',
    });

    assert.equal(fetches.length, 1);
    assert.deepEqual(nested.range, {
      start: '2026-07-02',
      end: '2026-07-02',
    });
    assert.equal(nested.totals.grossApprovals, 50_000);
    assert.equal(nested.fetchedAt, broad.fetchedAt);
  });
});

test('Payway summary fetches again when no fresh cached range contains the selection', async () => {
  let fetchCount = 0;

  await withMockedPaywayFinancialService({
    isConfigured: () => true,
    fetchPaymentHistory: async () => {
      fetchCount += 1;
      return [];
    },
  }, async service => {
    await service.getPaywayFinancialSummary({
      startDate: '2026-07-01',
      endDate: '2026-07-07',
    });
    await service.getPaywayFinancialSummary({
      startDate: '2026-07-08',
      endDate: '2026-07-08',
    });

    assert.equal(fetchCount, 2);
  });
});
