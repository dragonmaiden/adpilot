const test = require('node:test');
const assert = require('node:assert/strict');

const {
  IMWEB_AUTH_REPAIR_PATH,
  IMWEB_AUTH_CALLBACK_PATH,
  IMWEB_AUTH_REPAIR_SCOPES,
  buildAuthorizeUrl,
  parseOAuthError,
  buildRepairMetadata,
} = require('../server/services/imwebAuthRepairService');

test('buildAuthorizeUrl creates the canonical Imweb repair URL with required scopes', () => {
  const url = new URL(buildAuthorizeUrl({
    baseUrl: 'https://openapi.imweb.me',
    clientId: 'client-123',
    siteCode: 'S-site',
    origin: 'https://adpilot-6bxs.onrender.com',
    state: 'fixed-state',
  }));

  assert.equal(url.origin, 'https://openapi.imweb.me');
  assert.equal(url.pathname, '/oauth2/authorize');
  assert.equal(url.searchParams.get('responseType'), 'code');
  assert.equal(url.searchParams.get('clientId'), 'client-123');
  assert.equal(url.searchParams.get('siteCode'), 'S-site');
  assert.equal(url.searchParams.get('state'), 'fixed-state');
  assert.equal(url.searchParams.get('redirectUri'), `https://adpilot-6bxs.onrender.com${IMWEB_AUTH_CALLBACK_PATH}`);
  assert.equal(url.searchParams.get('scope'), IMWEB_AUTH_REPAIR_SCOPES.join(' '));
});

test('parseOAuthError understands Imweb callback errorCode/message responses', () => {
  assert.deepEqual(parseOAuthError({
    errorCode: '30156',
    message: 'scope에 site-info:write 권한이 필요합니다.',
  }), {
    code: '30156',
    message: 'scope에 site-info:write 권한이 필요합니다.',
  });

  assert.deepEqual(parseOAuthError({
    error: 'access_denied',
    error_description: 'user cancelled',
  }), {
    code: 'access_denied',
    message: 'user cancelled',
  });

  assert.equal(parseOAuthError({}), null);
});

test('buildRepairMetadata flags when Imweb reauthorization is required', () => {
  assert.deepEqual(buildRepairMetadata({
    status: 'connected',
    lastError: null,
  }), {
    mode: 'oauth_code_repair',
    path: IMWEB_AUTH_REPAIR_PATH,
    callbackPath: IMWEB_AUTH_CALLBACK_PATH,
    scopes: [...IMWEB_AUTH_REPAIR_SCOPES],
    reauthorizationRequired: false,
  });

  assert.equal(buildRepairMetadata({
    status: 'error',
    lastError: 'Imweb token refresh failed (HTTP 400): 30170: 유효하지 않은 리프레시 토큰입니다.',
  }).reauthorizationRequired, true);

  assert.equal(buildRepairMetadata({
    status: 'missing',
    lastError: null,
  }).reauthorizationRequired, true);
});
