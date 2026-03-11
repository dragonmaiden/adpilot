(function () {
  const live = window.AdPilotLive;

  if (!live) {
    throw new Error('AdPilotLive core must load before API helpers.');
  }

  const API_BASE = window.location.origin + '/api';
  let apiKeyPrompted = false;

  function getApiKey() {
    return (sessionStorage.getItem('adpilot_key') || '').trim();
  }

  function promptForApiKey() {
    if (apiKeyPrompted) return;
    apiKeyPrompted = true;

    const key = window.prompt('Enter your AdPilot API key:');
    const trimmed = key ? key.trim() : '';
    if (trimmed) {
      sessionStorage.setItem('adpilot_key', trimmed);
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
        sessionStorage.removeItem('adpilot_key');
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

  function fetchOptimizations(limit = 50) {
    return api(`/optimizations?limit=${limit}`);
  }

  function fetchAnalytics() {
    return api('/analytics');
  }

  function fetchCalendarAnalysis(params) {
    const search = new URLSearchParams(params || {});
    return api(`/calendar-analysis?${search.toString()}`, 'GET', null, { timeoutMs: 15000 });
  }

  function fetchCampaigns(windowKey) {
    const search = new URLSearchParams();
    if (windowKey) search.set('days', windowKey);
    const suffix = search.toString() ? `?${search.toString()}` : '';
    return api(`/campaigns${suffix}`);
  }

  function fetchPostmortem(windowKey) {
    const search = new URLSearchParams();
    if (windowKey) search.set('days', windowKey);
    const suffix = search.toString() ? `?${search.toString()}` : '';
    return api(`/postmortem${suffix}`);
  }

  function fetchSettings() {
    return api('/settings');
  }

  function fetchReconciliation() {
    return api('/reconciliation');
  }

  function fetchSpendDaily() {
    return api('/spend-daily');
  }

  function triggerScan() {
    return api('/scan', 'POST');
  }

  function updateCampaignStatus(campaignId, status) {
    return api(`/campaigns/${campaignId}/status`, 'POST', { status });
  }

  function executeOptimization(optId) {
    return api(`/optimizations/${optId}/execute`, 'POST');
  }

  live.api = {
    api,
    checkBackendAvailable,
    fetchOverview,
    fetchOptimizations,
    fetchAnalytics,
    fetchCalendarAnalysis,
    fetchCampaigns,
    fetchPostmortem,
    fetchSettings,
    fetchReconciliation,
    fetchSpendDaily,
    triggerScan,
    updateCampaignStatus,
    executeOptimization,
  };
})();
