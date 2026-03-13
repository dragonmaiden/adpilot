const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const runtimePaths = require('../runtime/paths');
const imweb = require('../modules/imwebClient');

const STATE_FILE = path.join(runtimePaths.dataDir, 'imweb_app_install_state.json');
const STATE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_SCOPE = 'site-info:read site-info:write order:read';

function asString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function trimTrailingSlash(value) {
  return asString(value).replace(/\/+$/, '');
}

function createEmptyState() {
  return {
    pendingStates: {},
    installedSites: {},
  };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return createEmptyState();
  }

  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      pendingStates: raw?.pendingStates && typeof raw.pendingStates === 'object'
        ? raw.pendingStates
        : {},
      installedSites: raw?.installedSites && typeof raw.installedSites === 'object'
        ? raw.installedSites
        : {},
    };
  } catch (_) {
    return createEmptyState();
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function buildPublicBaseUrl(req) {
  const configured = trimTrailingSlash(config.imweb.appBaseUrl);
  if (configured) return configured;

  const forwardedProto = asString(req?.get?.('x-forwarded-proto'));
  const forwardedHost = asString(req?.get?.('x-forwarded-host'));
  const host = forwardedHost || asString(req?.get?.('host'));
  const protocol = forwardedProto || req?.protocol || 'https';
  if (!host) {
    throw new Error('Unable to determine public app host');
  }

  return `${protocol}://${host}`;
}

function getServiceUrl(req) {
  const configured = trimTrailingSlash(config.imweb.serviceUrl);
  return configured || `${buildPublicBaseUrl(req)}/imweb/install`;
}

function getRedirectUri(req) {
  const configured = trimTrailingSlash(config.imweb.redirectUri);
  return configured || `${buildPublicBaseUrl(req)}/imweb/oauth/callback`;
}

function getInstallScope() {
  return asString(config.imweb.installScope) || DEFAULT_SCOPE;
}

function getIntegrationConfig() {
  return config.imweb.integrationConfig && typeof config.imweb.integrationConfig === 'object'
    ? config.imweb.integrationConfig
    : null;
}

function validateSiteCode(siteCode) {
  const candidate = asString(siteCode);
  if (!candidate) {
    throw new Error('siteCode is required for Imweb install');
  }

  const configuredSiteCode = asString(config.imweb.siteCode);
  if (configuredSiteCode && configuredSiteCode !== candidate) {
    throw new Error(`AdPilot is currently configured for site ${configuredSiteCode}. Refusing install for ${candidate}.`);
  }

  return candidate;
}

function createPendingState({ siteCode, redirectUri, scope }) {
  const stateId = crypto.randomUUID();
  const state = loadState();
  state.pendingStates[stateId] = {
    siteCode,
    redirectUri,
    scope,
    createdAt: new Date().toISOString(),
  };
  saveState(state);
  return stateId;
}

function consumePendingState(stateId) {
  const normalized = asString(stateId);
  if (!normalized) {
    throw new Error('Missing OAuth state');
  }

  const state = loadState();
  const pending = state.pendingStates[normalized];
  delete state.pendingStates[normalized];
  saveState(state);

  if (!pending) {
    throw new Error('Unknown or already-used OAuth state');
  }

  const createdAt = Date.parse(pending.createdAt || '');
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > STATE_TTL_MS) {
    throw new Error('Expired OAuth state');
  }

  return pending;
}

function saveInstalledSite(metadata) {
  const siteCode = validateSiteCode(metadata?.siteCode);
  const state = loadState();
  state.installedSites[siteCode] = {
    ...(state.installedSites[siteCode] || {}),
    ...metadata,
    siteCode,
    updatedAt: new Date().toISOString(),
  };
  saveState(state);
  return state.installedSites[siteCode];
}

function getInstalledSite(siteCode = config.imweb.siteCode) {
  const normalized = asString(siteCode);
  if (!normalized) return null;
  const state = loadState();
  return state.installedSites[normalized] || null;
}

function buildAuthorizeUrl({ siteCode, redirectUri, scope, state }) {
  const url = new URL('/oauth2/authorize', config.imweb.baseUrl);
  url.searchParams.set('responseType', 'code');
  url.searchParams.set('clientId', config.imweb.clientId);
  url.searchParams.set('redirectUri', redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('siteCode', siteCode);
  return url.toString();
}

function beginInstall({ req, siteCode }) {
  if (!config.imweb.clientId || !config.imweb.clientSecret) {
    throw new Error('Imweb client credentials are missing');
  }

  const normalizedSiteCode = validateSiteCode(siteCode || req?.query?.siteCode || config.imweb.siteCode);
  const redirectUri = getRedirectUri(req);
  const scope = getInstallScope();
  const state = createPendingState({
    siteCode: normalizedSiteCode,
    redirectUri,
    scope,
  });

  return {
    siteCode: normalizedSiteCode,
    redirectUri,
    serviceUrl: getServiceUrl(req),
    scope,
    state,
    authorizeUrl: buildAuthorizeUrl({
      siteCode: normalizedSiteCode,
      redirectUri,
      scope,
      state,
    }),
  };
}

async function finalizeInstall({ req, code, state: stateId }) {
  const pending = consumePendingState(stateId);
  const tokenData = await imweb.authorizeWithCode({
    code,
    redirectUri: pending.redirectUri,
    source: 'oauth_install',
  });

  const siteInfo = await imweb.getSiteInfo({
    accessToken: tokenData.accessToken,
    siteCode: pending.siteCode,
  });

  let integrationStatus = 'completed';
  try {
    await imweb.completeIntegration({
      accessToken: tokenData.accessToken,
      siteCode: pending.siteCode,
      configData: getIntegrationConfig(),
    });
  } catch (err) {
    if (/30128/.test(err.message)) {
      integrationStatus = 'already_complete';
    } else {
      throw err;
    }
  }

  const installedSite = saveInstalledSite({
    siteCode: pending.siteCode,
    ownerUid: siteInfo?.ownerUid || null,
    firstOrderTime: siteInfo?.firstOrderTime || null,
    unitList: Array.isArray(siteInfo?.unitList) ? siteInfo.unitList : [],
    integrationStatus,
    scope: tokenData.scope || pending.scope,
    redirectUri: pending.redirectUri,
    serviceUrl: getServiceUrl(req),
    completedAt: new Date().toISOString(),
  });

  return {
    siteCode: pending.siteCode,
    redirectUri: pending.redirectUri,
    serviceUrl: getServiceUrl(req),
    scope: tokenData.scope || pending.scope,
    integrationStatus,
    installedSite,
    authState: imweb.getAuthState(),
  };
}

module.exports = {
  getServiceUrl,
  getRedirectUri,
  getInstallScope,
  getInstalledSite,
  beginInstall,
  finalizeInstall,
};
