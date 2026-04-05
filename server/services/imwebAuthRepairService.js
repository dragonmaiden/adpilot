const crypto = require('crypto');

const IMWEB_AUTH_REPAIR_PATH = '/imweb/oauth/start';
const IMWEB_AUTH_CALLBACK_PATH = '/imweb/oauth/callback';
const IMWEB_AUTH_REPAIR_SCOPES = Object.freeze(['site-info:write', 'order:read', 'payment:read']);

function buildAuthorizeUrl({ baseUrl, clientId, siteCode, origin, state }) {
  const normalizedBaseUrl = String(baseUrl || '').trim();
  const normalizedClientId = String(clientId || '').trim();
  const normalizedSiteCode = String(siteCode || '').trim();
  const normalizedOrigin = String(origin || '').trim().replace(/\/+$/, '');

  if (!normalizedBaseUrl) throw new Error('baseUrl is required');
  if (!normalizedClientId) throw new Error('clientId is required');
  if (!normalizedSiteCode) throw new Error('siteCode is required');
  if (!normalizedOrigin) throw new Error('origin is required');

  const url = new URL('/oauth2/authorize', normalizedBaseUrl);
  url.searchParams.set('responseType', 'code');
  url.searchParams.set('clientId', normalizedClientId);
  url.searchParams.set('redirectUri', `${normalizedOrigin}${IMWEB_AUTH_CALLBACK_PATH}`);
  url.searchParams.set('scope', IMWEB_AUTH_REPAIR_SCOPES.join(' '));
  url.searchParams.set('state', String(state || crypto.randomBytes(12).toString('hex')));
  url.searchParams.set('siteCode', normalizedSiteCode);
  return url.toString();
}

function parseOAuthError(query = {}) {
  const code = String(query.errorCode || query.error || '').trim();
  const message = String(query.message || query.error_description || '').trim();
  if (!code && !message) return null;
  return { code, message };
}

function isReauthorizationRequired(authState = {}) {
  const status = String(authState.status || '').trim();
  const lastError = String(authState.lastError || '').trim();

  if (status === 'misconfigured') return false;
  if (status === 'connected') return false;
  if (status === 'missing' || status === 'refresh_only') return true;

  if (status === 'error') {
    return true;
  }

  return /30170|No Imweb refresh token available|No Imweb tokens available/i.test(lastError);
}

function buildRepairMetadata(authState = {}) {
  return {
    mode: 'oauth_code_repair',
    path: IMWEB_AUTH_REPAIR_PATH,
    callbackPath: IMWEB_AUTH_CALLBACK_PATH,
    scopes: [...IMWEB_AUTH_REPAIR_SCOPES],
    reauthorizationRequired: isReauthorizationRequired(authState),
  };
}

module.exports = {
  IMWEB_AUTH_REPAIR_PATH,
  IMWEB_AUTH_CALLBACK_PATH,
  IMWEB_AUTH_REPAIR_SCOPES,
  buildAuthorizeUrl,
  parseOAuthError,
  isReauthorizationRequired,
  buildRepairMetadata,
};
