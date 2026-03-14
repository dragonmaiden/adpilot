const test = require('node:test');
const assert = require('node:assert/strict');

async function withMockedObservabilityService(run) {
  const servicePath = require.resolve('../server/services/observabilityService');
  const configPath = require.resolve('../server/config');
  const storePath = require.resolve('../server/modules/policyLabStore');

  const originalConfig = require.cache[configPath] || null;
  const originalStore = require.cache[storePath] || null;
  const originalService = require.cache[servicePath] || null;
  const recordedEvents = [];

  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
      sentry: {
        dsn: '',
        environment: 'test',
        release: 'test',
      },
    },
  };
  require.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: {
      addObservabilityEvent(event) {
        recordedEvents.push(event);
        return event;
      },
    },
  };
  delete require.cache[servicePath];

  try {
    const service = require(servicePath);
    return await run(service, recordedEvents);
  } finally {
    delete require.cache[servicePath];
    if (originalService) require.cache[servicePath] = originalService;
    if (originalConfig) require.cache[configPath] = originalConfig;
    else delete require.cache[configPath];
    if (originalStore) require.cache[storePath] = originalStore;
    else delete require.cache[storePath];
  }
}

test('captureMessage records a local observability event even when Sentry is disabled', async () => {
  await withMockedObservabilityService(async (service, recordedEvents) => {
    service.initObservability('test-service');
    service.captureMessage('Replay loop completed', 'warning', {
      category: 'policy_lab.research',
      title: 'Research loop warning',
      tags: {
        candidate_version: 'cand-1',
      },
    });

    assert.equal(recordedEvents.length, 1);
    assert.equal(recordedEvents[0].message, 'Replay loop completed');
    assert.equal(recordedEvents[0].level, 'warning');
    assert.equal(recordedEvents[0].tags.candidate_version, 'cand-1');
    assert.equal(service.getStatus().enabled, false);
    assert.ok(service.getStatus().lastEventAt);
  });
});
