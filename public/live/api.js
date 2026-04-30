(function () {
  const live = window.AdPilotLive;

  if (!live) {
    throw new Error('AdPilotLive core must load before API helpers.');
  }

  const API_BASE = window.location.origin + '/api';
  const API_KEY_STORAGE_KEY = 'adpilot_key';
  let apiKeyPrompted = false;

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
    const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : 0;
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
      return res.json();
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
