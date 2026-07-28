const test = require('node:test');
const assert = require('node:assert/strict');

async function withMockedReconciliationService(overrides, run) {
  const servicePath = require.resolve('../server/services/reconciliationService');
  const dependencies = [
    [require.resolve('../server/config'), {
      cardSettlement: { matchWindowMinutes: 3 },
    }],
    [require.resolve('../server/modules/scheduler'), {
      getLatestData: () => ({ orders: [] }),
    }],
    [require.resolve('../server/modules/imwebClient'), {
      getAllOrders: async () => [],
    }],
    [require.resolve('../server/modules/cardSettlementClient'), overrides.cardSettlementClient],
  ];
  const originalService = require.cache[servicePath] || null;
  const originalDependencies = new Map();

  for (const [dependencyPath, exports] of dependencies) {
    originalDependencies.set(dependencyPath, require.cache[dependencyPath] || null);
    require.cache[dependencyPath] = {
      id: dependencyPath,
      filename: dependencyPath,
      loaded: true,
      exports,
    };
  }
  delete require.cache[servicePath];

  try {
    return await run(require(servicePath));
  } finally {
    delete require.cache[servicePath];
    if (originalService) {
      require.cache[servicePath] = originalService;
    }

    for (const [dependencyPath] of dependencies) {
      const original = originalDependencies.get(dependencyPath);
      if (original) {
        require.cache[dependencyPath] = original;
      } else {
        delete require.cache[dependencyPath];
      }
    }
  }
}

function emptySettlementReport() {
  return {
    configured: true,
    spreadsheetId: 'sheet-id',
    gid: '0',
    merchantName: 'SHUE',
    fetchedAt: new Date().toISOString(),
    transactions: [],
    totals: {},
  };
}

test('calendar reconciliation shares in-flight work and reuses the short-lived result', async () => {
  let fetchCount = 0;

  await withMockedReconciliationService({
    cardSettlementClient: {
      fetchCardSettlementReport: async () => {
        fetchCount += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
        return emptySettlementReport();
      },
    },
  }, async service => {
    const [first, second] = await Promise.all([
      service.getReconciliationResponse({ refresh: false }),
      service.getReconciliationResponse({ refresh: false }),
    ]);
    const cached = await service.getReconciliationResponse({ refresh: false });

    assert.equal(fetchCount, 1);
    assert.deepEqual(second, first);
    assert.deepEqual(cached, first);
  });
});

test('explicit reconciliation refresh bypasses the short-lived cache', async () => {
  let fetchCount = 0;

  await withMockedReconciliationService({
    cardSettlementClient: {
      fetchCardSettlementReport: async () => {
        fetchCount += 1;
        return emptySettlementReport();
      },
    },
  }, async service => {
    await service.getReconciliationResponse({ refresh: false });
    await service.getReconciliationResponse({ refresh: true });

    assert.equal(fetchCount, 2);
  });
});
