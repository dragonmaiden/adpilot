const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

function createTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adpilot-imweb-install-'));
}

async function withMockedService(overrides, run) {
  const servicePath = require.resolve('../server/services/imwebAppInstallService');
  const dependencyEntries = [
    [require.resolve('../server/config'), overrides.config],
    [require.resolve('../server/runtime/paths'), overrides.runtimePaths],
    [require.resolve('../server/modules/imwebClient'), overrides.imwebClient],
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

  const originalService = require.cache[servicePath] || null;
  delete require.cache[servicePath];

  try {
    const service = require(servicePath);
    return await run(service);
  } finally {
    delete require.cache[servicePath];
    if (originalService) {
      require.cache[servicePath] = originalService;
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

function createConfig(overrides = {}) {
  return {
    imweb: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      siteCode: 'S20260108741f7ad4afc71',
      baseUrl: 'https://openapi.imweb.me',
      appBaseUrl: '',
      serviceUrl: '',
      redirectUri: '',
      installScope: 'site-info:read site-info:write order:read',
      integrationConfig: null,
      ...overrides,
    },
  };
}

function createReq({ host = 'adpilot-6bxs.onrender.com', protocol = 'https', query = {} } = {}) {
  return {
    protocol,
    query,
    get(name) {
      const lower = String(name || '').toLowerCase();
      if (lower === 'host') return host;
      return '';
    },
  };
}

test('beginInstall builds the Imweb authorize URL and persists a pending OAuth state', async () => {
  const dataDir = createTempDataDir();

  await withMockedService({
    config: createConfig(),
    runtimePaths: { dataDir },
    imwebClient: {},
  }, async service => {
    const result = service.beginInstall({
      req: createReq(),
      siteCode: 'S20260108741f7ad4afc71',
    });

    assert.equal(result.siteCode, 'S20260108741f7ad4afc71');
    assert.equal(result.redirectUri, 'https://adpilot-6bxs.onrender.com/imweb/oauth/callback');
    assert.equal(result.serviceUrl, 'https://adpilot-6bxs.onrender.com/imweb/install');
    assert.equal(result.scope, 'site-info:read site-info:write order:read');
    assert.ok(result.state);

    const authorizeUrl = new URL(result.authorizeUrl);
    assert.equal(authorizeUrl.origin, 'https://openapi.imweb.me');
    assert.equal(authorizeUrl.pathname, '/oauth2/authorize');
    assert.equal(authorizeUrl.searchParams.get('responseType'), 'code');
    assert.equal(authorizeUrl.searchParams.get('clientId'), 'client-id');
    assert.equal(authorizeUrl.searchParams.get('redirectUri'), 'https://adpilot-6bxs.onrender.com/imweb/oauth/callback');
    assert.equal(authorizeUrl.searchParams.get('scope'), 'site-info:read site-info:write order:read');
    assert.equal(authorizeUrl.searchParams.get('siteCode'), 'S20260108741f7ad4afc71');

    const stateFile = path.join(dataDir, 'imweb_app_install_state.json');
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(persisted.pendingStates[result.state]);
  });
});

test('finalizeInstall exchanges the code, completes the integration, and records the installed site', async () => {
  const dataDir = createTempDataDir();
  const calls = [];

  await withMockedService({
    config: createConfig(),
    runtimePaths: { dataDir },
    imwebClient: {
      authorizeWithCode: async (payload) => {
        calls.push(['authorizeWithCode', payload]);
        return { accessToken: 'access-123', refreshToken: 'refresh-123', scope: 'site-info:read site-info:write order:read' };
      },
      getSiteInfo: async (payload) => {
        calls.push(['getSiteInfo', payload]);
        return {
          siteCode: 'S20260108741f7ad4afc71',
          ownerUid: 'owner@shue.kr',
          unitList: ['u20260108695f4cab3dea1'],
        };
      },
      completeIntegration: async (payload) => {
        calls.push(['completeIntegration', payload]);
        return true;
      },
      getAuthState: () => ({ status: 'connected', tokenSource: 'oauth_install' }),
    },
  }, async service => {
    const install = service.beginInstall({
      req: createReq(),
      siteCode: 'S20260108741f7ad4afc71',
    });

    const result = await service.finalizeInstall({
      req: createReq(),
      code: 'auth-code-123',
      state: install.state,
    });

    assert.equal(result.siteCode, 'S20260108741f7ad4afc71');
    assert.equal(result.integrationStatus, 'completed');
    assert.equal(result.installedSite.ownerUid, 'owner@shue.kr');
    assert.deepEqual(result.installedSite.unitList, ['u20260108695f4cab3dea1']);
    assert.deepEqual(calls.map(([name]) => name), ['authorizeWithCode', 'getSiteInfo', 'completeIntegration']);
    assert.equal(calls[0][1].redirectUri, 'https://adpilot-6bxs.onrender.com/imweb/oauth/callback');
    assert.equal(calls[1][1].siteCode, 'S20260108741f7ad4afc71');
    assert.equal(calls[2][1].siteCode, 'S20260108741f7ad4afc71');
  });
});

test('finalizeInstall treats 30128 as an already-complete Imweb install', async () => {
  const dataDir = createTempDataDir();

  await withMockedService({
    config: createConfig(),
    runtimePaths: { dataDir },
    imwebClient: {
      authorizeWithCode: async () => ({ accessToken: 'access-123', refreshToken: 'refresh-123', scope: 'site-info:read site-info:write order:read' }),
      getSiteInfo: async () => ({
        siteCode: 'S20260108741f7ad4afc71',
        ownerUid: 'owner@shue.kr',
        unitList: ['u20260108695f4cab3dea1'],
      }),
      completeIntegration: async () => {
        throw new Error('Imweb PATCH /site-info/integration-complete failed (HTTP 404): 30128: only apps in progress can complete');
      },
      getAuthState: () => ({ status: 'connected', tokenSource: 'oauth_install' }),
    },
  }, async service => {
    const install = service.beginInstall({
      req: createReq(),
      siteCode: 'S20260108741f7ad4afc71',
    });

    const result = await service.finalizeInstall({
      req: createReq(),
      code: 'auth-code-123',
      state: install.state,
    });

    assert.equal(result.integrationStatus, 'already_complete');
  });
});

test('beginInstall refuses site codes that do not match the configured single-site runtime', async () => {
  const dataDir = createTempDataDir();

  await withMockedService({
    config: createConfig({ siteCode: 'S20260108741f7ad4afc71' }),
    runtimePaths: { dataDir },
    imwebClient: {},
  }, async service => {
    assert.throws(() => service.beginInstall({
      req: createReq(),
      siteCode: 'S202601099999999999999',
    }), /Refusing install/);
  });
});
