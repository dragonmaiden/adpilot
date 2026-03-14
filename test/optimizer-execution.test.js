const test = require('node:test');
const assert = require('node:assert/strict');

async function withMockedOptimizer(overrides, run) {
  const optimizerPath = require.resolve('../server/modules/optimizer');
  const dependencyEntries = [
    [require.resolve('../server/modules/metaClient'), overrides.metaClient],
    [require.resolve('../server/runtime/runtimeSettings'), overrides.runtimeSettings],
    [require.resolve('../server/modules/telegram'), overrides.telegram || {}],
    [require.resolve('../server/services/policyLabService'), overrides.policyLabService || { seedBudgetOutcomeFromAction: () => null }],
    [require.resolve('../server/services/observabilityService'), overrides.observabilityService || { captureMessage: () => null, captureException: () => null }],
  ];

  const originalEntries = new Map();
  for (const [dependencyPath, dependencyExports] of dependencyEntries) {
    originalEntries.set(dependencyPath, require.cache[dependencyPath] || null);
    require.cache[dependencyPath] = {
      id: dependencyPath,
      filename: dependencyPath,
      loaded: true,
      exports: dependencyExports,
    };
  }

  const originalOptimizer = require.cache[optimizerPath] || null;
  delete require.cache[optimizerPath];

  try {
    const OptimizationEngine = require(optimizerPath);
    return await run(OptimizationEngine);
  } finally {
    delete require.cache[optimizerPath];
    if (originalOptimizer) {
      require.cache[optimizerPath] = originalOptimizer;
    }

    for (const [dependencyPath] of dependencyEntries) {
      const originalEntry = originalEntries.get(dependencyPath);
      if (originalEntry) {
        require.cache[dependencyPath] = originalEntry;
      } else {
        delete require.cache[dependencyPath];
      }
    }
  }
}

test('executeAction honors the exact increase percentage from the approval text', async () => {
  let updatedBudget = null;

  await withMockedOptimizer({
    metaClient: {
      getCampaigns: async () => [{ id: 'c1', daily_budget: '11000' }],
      getAdAccount: async () => ({
        account_status: 1,
        disable_reason: 0,
        min_campaign_group_spend_cap: '10000',
      }),
      updateCampaignBudget: async (_targetId, nextBudget) => {
        updatedBudget = nextBudget;
        return { success: true };
      },
    },
    runtimeSettings: {
      getRules: () => ({
        autonomousMode: true,
        maxBudgetChangePercent: 20,
      }),
    },
  }, async OptimizationEngine => {
    const engine = new OptimizationEngine(101);
    const action = {
      type: 'budget',
      level: 'campaign',
      targetId: 'c1',
      action: 'Increase daily budget by $11.00 (10%)',
    };

    await engine.executeAction(action);

    assert.equal(updatedBudget, 12100);
    assert.equal(action.executed, true);
    assert.equal(action.executionResult, 'Success');
  });
});

test('executeAction blocks campaign budget reductions below the Meta minimum budget floor', async () => {
  let updateCalls = 0;

  await withMockedOptimizer({
    metaClient: {
      getCampaigns: async () => [{ id: 'c1', daily_budget: '11000' }],
      getAdAccount: async () => ({
        account_status: 1,
        disable_reason: 0,
        min_campaign_group_spend_cap: '10000',
      }),
      updateCampaignBudget: async () => {
        updateCalls += 1;
        return { success: true };
      },
    },
    runtimeSettings: {
      getRules: () => ({
        autonomousMode: true,
        maxBudgetChangePercent: 20,
      }),
    },
  }, async OptimizationEngine => {
    const engine = new OptimizationEngine(102);
    const action = {
      type: 'budget',
      level: 'campaign',
      targetId: 'c1',
      action: 'Reduce daily budget by 15%',
    };

    await engine.executeAction(action);

    assert.equal(updateCalls, 0);
    assert.equal(action.executed, false);
    assert.match(action.executionResult, /Meta minimum of \$100\.00\/day/);
  });
});
