(function () {
  const live = window.AdPilotLive;

  if (!live) {
    throw new Error('AdPilotLive core must load before API helpers.');
  }

  const API_BASE = window.location.origin + '/api';
  const API_KEY_STORAGE_KEY = 'adpilot_key';
  const API_VERSION = 'v1';
  const DEFAULT_TIMEOUT_MS = 10000;
  let apiKeyPrompted = false;

  function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function passContract() {
    return { valid: true };
  }

  function failContract(contract, reason) {
    return { valid: false, reason: `${contract}: ${reason}` };
  }

  function hasArray(value, field) {
    return Array.isArray(value?.[field]);
  }

  function hasObject(value, field) {
    return isPlainObject(value?.[field]);
  }

  function validateVersionedObject(contract, payload) {
    if (!isPlainObject(payload)) return failContract(contract, 'payload is not an object');
    if (payload.apiVersion !== API_VERSION) {
      return failContract(contract, `unexpected apiVersion ${payload.apiVersion}`);
    }
    return passContract();
  }

  function validateHealthPayload(payload) {
    if (!isPlainObject(payload)) return failContract('health', 'payload is not an object');
    return typeof payload.status === 'string' ? passContract() : failContract('health', 'missing status');
  }

  function validateOverviewPayload(payload) {
    const base = validateVersionedObject('overview', payload);
    if (!base.valid) return base;
    if (payload.ready === false) return passContract();
    if (payload.ready !== true) return failContract('overview', 'missing ready=true');
    if (!hasObject(payload, 'kpis')) return failContract('overview', 'missing kpis object');
    if (!hasObject(payload, 'charts')) return failContract('overview', 'missing charts object');
    if (!hasArray(payload.charts, 'dailyMerged')) return failContract('overview', 'missing charts.dailyMerged array');
    if (!hasObject(payload, 'dataSources')) return failContract('overview', 'missing dataSources object');
    if (payload.sourceAudit != null && !isPlainObject(payload.sourceAudit)) return failContract('overview', 'sourceAudit must be an object or null');
    return passContract();
  }

  function validateAnalyticsPayload(payload) {
    const base = validateVersionedObject('analytics', payload);
    if (!base.valid) return base;
    if (!hasObject(payload, 'charts')) return failContract('analytics', 'missing charts object');
    if (!hasArray(payload.charts, 'dailyMerged')) return failContract('analytics', 'missing charts.dailyMerged array');
    if (!hasObject(payload, 'profitAnalysis')) return failContract('analytics', 'missing profitAnalysis object');
    if (!hasArray(payload.profitAnalysis, 'waterfall')) return failContract('analytics', 'missing profitAnalysis.waterfall array');
    if (!hasObject(payload, 'dataSources')) return failContract('analytics', 'missing dataSources object');
    if (payload.sourceAudit != null && !isPlainObject(payload.sourceAudit)) return failContract('analytics', 'sourceAudit must be an object or null');
    return passContract();
  }

  function validateCalendarPayload(payload) {
    const base = validateVersionedObject('calendar-analysis', payload);
    if (!base.valid) return base;
    if (payload.ready === false) return passContract();
    if (!hasObject(payload, 'viewport')) return failContract('calendar-analysis', 'missing viewport object');
    if (!hasArray(payload, 'calendarDays')) return failContract('calendar-analysis', 'missing calendarDays array');
    if (!hasObject(payload, 'selection')) return failContract('calendar-analysis', 'missing selection object');
    if (!hasArray(payload.selection, 'days')) return failContract('calendar-analysis', 'missing selection.days array');
    if (payload.sourceAudit != null && !isPlainObject(payload.sourceAudit)) return failContract('calendar-analysis', 'sourceAudit must be an object or null');
    return passContract();
  }

  function validateSettingsPayload(payload) {
    const base = validateVersionedObject('settings', payload);
    if (!base.valid) return base;
    if (!hasObject(payload, 'sources')) return failContract('settings', 'missing sources object');
    if (payload.sourceAudit != null && !isPlainObject(payload.sourceAudit)) return failContract('settings', 'sourceAudit must be an object or null');
    return passContract();
  }

  function inferContract(path) {
    if (path === '/health') return 'health';
    if (path === '/overview') return 'overview';
    if (path === '/analytics') return 'analytics';
    if (path.startsWith('/calendar-analysis')) return 'calendar-analysis';
    if (path === '/settings') return 'settings';
    return '';
  }

  function validateApiPayload(path, payload, contract = '') {
    const selectedContract = contract || inferContract(path);
    const validators = {
      health: validateHealthPayload,
      overview: validateOverviewPayload,
      analytics: validateAnalyticsPayload,
      'calendar-analysis': validateCalendarPayload,
      settings: validateSettingsPayload,
    };
    const validator = validators[selectedContract];
    return validator ? validator(payload) : passContract();
  }

  function readStorage(storage, key) {
    try {
      return storage.getItem(key) || '';
    } catch (err) {
      return '';
    }
  }

  function writeStorage(storage, key, value) {
    try {
      if (value) {
        storage.setItem(key, value);
      } else {
        storage.removeItem(key);
      }
    } catch (err) {
      // Ignore storage write failures and fall back to in-memory prompt flow.
    }
  }

  function getApiKey() {
    const sessionKey = readStorage(window.sessionStorage, API_KEY_STORAGE_KEY).trim();
    if (sessionKey) return sessionKey;

    const persistedKey = readStorage(window.localStorage, API_KEY_STORAGE_KEY).trim();
    if (persistedKey) {
      writeStorage(window.sessionStorage, API_KEY_STORAGE_KEY, persistedKey);
    }
    return persistedKey;
  }

  function storeApiKey(key) {
    const trimmed = String(key || '').trim();
    writeStorage(window.sessionStorage, API_KEY_STORAGE_KEY, trimmed);
    writeStorage(window.localStorage, API_KEY_STORAGE_KEY, trimmed);
  }

  function clearApiKey() {
    writeStorage(window.sessionStorage, API_KEY_STORAGE_KEY, '');
    writeStorage(window.localStorage, API_KEY_STORAGE_KEY, '');
  }

  function promptForApiKey() {
    if (apiKeyPrompted) return;
    apiKeyPrompted = true;

    const key = window.prompt('Enter your AdPilot API key:');
    const trimmed = key ? key.trim() : '';
    if (trimmed) {
      storeApiKey(trimmed);
      window.location.reload();
    }
  }

  async function api(path, method = 'GET', body = null, options = null) {
    const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    let timeoutId = null;
    try {
      const key = getApiKey();
      const controller = timeoutMs > 0 ? new AbortController() : null;
      const opts = {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        ...(controller ? { signal: controller.signal } : {}),
      };
      if (body) opts.body = JSON.stringify(body);
      if (controller) {
        timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
      }
      const res = await fetch(`${API_BASE}${path}`, opts);
      if (timeoutId) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (res.status === 401) {
        clearApiKey();
        apiKeyPrompted = false;
        promptForApiKey();
        return null;
      }
      if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
      const payload = await res.json();
      const contractResult = validateApiPayload(path, payload, options?.contract || '');
      if (!contractResult.valid) {
        throw new Error(`API contract mismatch: ${contractResult.reason}`);
      }
      return payload;
    } catch (err) {
      console.warn(`[LIVE] API error on ${path}:`, err.message);
      return null;
    } finally {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    }
  }

  async function checkBackendAvailable() {
    const health = await api('/health');
    return !!(health && health.status === 'ok');
  }

  async function fetchOverview() {
    const data = await api('/overview');
    return data && data.ready ? data : null;
  }

  function fetchAnalytics() {
    return api('/analytics');
  }

  function fetchCalendarAnalysis(params) {
    const search = new URLSearchParams(params || {});
    return api(`/calendar-analysis?${search.toString()}`, 'GET', null, { timeoutMs: 15000 });
  }

  function fetchSettings() {
    return api('/settings');
  }

  function fetchReconciliation() {
    return api('/reconciliation');
  }

  live.api = {
    api,
    checkBackendAvailable,
    fetchOverview,
    fetchAnalytics,
    fetchCalendarAnalysis,
    fetchSettings,
    fetchReconciliation,
  };
})();
