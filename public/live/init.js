(function () {
  const live = window.AdPilotLive;
  const { checkBackendAvailable, api } = live.api;
  const { initSeriesWindowControls } = live.seriesWindows;

  let overviewPollId = null;
  let secondaryPollId = null;
  let bootstrapPollId = null;

  function isPageRefreshable(pageName) {
    return ['overview', 'calendar', 'settings'].includes(pageName);
  }

  async function refreshPageIfActive(pageName) {
    if (!live.isLiveEnabled()) return;
    if (!isPageRefreshable(pageName)) return;
    await live.refresh(pageName);
  }

  async function refreshStartupState() {
    const activePage = live.getActivePage();
    await live.refresh('overview');
    if (activePage && activePage !== 'overview') {
      await refreshPageIfActive(activePage);
    }
  }

  function startPolling() {
    if (!overviewPollId) {
      overviewPollId = setInterval(async () => {
        await live.refresh('overview');
      }, 30000);
    }

    if (!secondaryPollId) {
      secondaryPollId = setInterval(async () => {
        await refreshPageIfActive(live.getActivePage());
      }, 120000);
    }
  }

  function stopBootstrapPolling() {
    if (!bootstrapPollId) return;
    clearInterval(bootstrapPollId);
    bootstrapPollId = null;
  }

  function startBootstrapPolling() {
    if (bootstrapPollId) return;

    const startedAt = Date.now();
    bootstrapPollId = setInterval(async () => {
      const health = await api('/health');
      if (!health) return;

      if (Date.now() - startedAt > 90000) {
        stopBootstrapPolling();
        return;
      }

      const hasCompletedScan = Boolean(health.lastScan);
      if (!health.isScanning && hasCompletedScan) {
        stopBootstrapPolling();
      }

      await live.refresh('overview');

      if (!health.isScanning && hasCompletedScan) {
        const activePage = live.getActivePage();
        if (activePage && activePage !== 'overview') {
          await refreshPageIfActive(activePage);
        }
      }
    }, 3000);
  }

  async function handlePageActivated(pageName) {
    if (!live.isLiveEnabled()) return;
    await refreshPageIfActive(pageName);
  }

  async function startLiveMode() {
    const available = await checkBackendAvailable();
    if (!available) {
      console.log('[LIVE] Backend not available, running in static mode');
      live.setLiveEnabled(false);
      return false;
    }

    console.log('[LIVE] Backend connected — enabling live mode');
    live.setLiveEnabled(true);

    try {
      await refreshStartupState();
    } catch (e) {
      console.warn('[LIVE] startup refresh error:', e.message);
    }

    const health = await api('/health');
    if (health?.isScanning || !health?.lastScan) {
      startBootstrapPolling();
    }

    startPolling();
    return true;
  }

  document.addEventListener('DOMContentLoaded', () => {
    live.setPageActivatedHandler(handlePageActivated);
    initSeriesWindowControls();

    startLiveMode();
  });
})();
