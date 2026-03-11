(function () {
  const live = window.AdPilotLive;
  const { checkBackendAvailable, triggerScan, api } = live.api;
  const { registerSeriesWindowRefresher, initSeriesWindowControls } = live.seriesWindows;

  let overviewPollId = null;
  let optimizationPollId = null;
  let secondaryPollId = null;
  let scanPollId = null;

  function renderStaticCampaignsView() {
    const activeContainer = document.getElementById('activeAdsContainer');
    const activeCount = document.getElementById('activeCount');
    const inactiveContainer = document.getElementById('inactiveAdsContainer');
    const inactiveCount = document.getElementById('inactiveCount');
    const lessonsSummaryEl = document.getElementById('lessonsSummary');

    if (activeContainer) {
      if (activeCount) activeCount.textContent = 'Backend offline';
      activeContainer.innerHTML = '<div class="empty-state">Backend offline — live ad data unavailable. Start the server to connect.</div>';
    }
    if (lessonsSummaryEl) lessonsSummaryEl.innerHTML = '';
    if (inactiveContainer) {
      if (inactiveCount) inactiveCount.textContent = '—';
      inactiveContainer.innerHTML = '<div class="empty-state">Backend offline — paused ad data unavailable.</div>';
    }
  }

  function showLiveIndicator() {
    const statusLabel = document.querySelector('.status-label');
    if (statusLabel) {
      statusLabel.innerHTML = 'Agent Active <span id="liveDot" class="live-dot"></span>';
    }
  }

  function wireScanButton() {
    const scanBtn = document.getElementById('runScanBtn');
    if (!scanBtn || scanBtn.dataset.liveBound === 'true') return;

    scanBtn.dataset.liveBound = 'true';
    scanBtn.addEventListener('click', async () => {
      const label = scanBtn.querySelector('span');
      if (label) label.textContent = 'Scanning...';
      scanBtn.disabled = true;
      await triggerScan();

      if (scanPollId) {
        clearInterval(scanPollId);
      }

      scanPollId = setInterval(async () => {
        const health = await api('/health');
        if (health && !health.isScanning) {
          clearInterval(scanPollId);
          scanPollId = null;
          if (label) label.textContent = 'Run Scan Now';
          scanBtn.disabled = false;
          const lastScanEl = document.getElementById('lastScan');
          if (lastScanEl) lastScanEl.textContent = 'just now';
          await live.refresh('overview');
          await live.refresh('optimizations');
          await live.refresh('campaigns');
          await live.refresh('analytics');
          await live.refresh('calendar');
        }
      }, 3000);
    });
  }

  function startPolling() {
    if (!overviewPollId) {
      overviewPollId = setInterval(async () => {
        await live.refresh('overview');
      }, 30000);
    }

    if (!optimizationPollId) {
      optimizationPollId = setInterval(async () => {
        await live.refresh('optimizations');
      }, 60000);
    }

    if (!secondaryPollId) {
      secondaryPollId = setInterval(async () => {
        await live.refresh('analytics');
        await live.refresh('fatigue');
        await live.refresh('budget');
        if (live.getActivePage() === 'calendar') {
          await live.refresh('calendar');
        }
      }, 120000);
    }
  }

  async function handlePageActivated(pageName) {
    if (!live.isLiveEnabled()) return;

    if (pageName === 'overview' || pageName === 'campaigns' || pageName === 'calendar' || pageName === 'settings') {
      await live.refresh(pageName);
    }
  }

  async function startLiveMode() {
    const available = await checkBackendAvailable();
    if (!available) {
      console.log('[LIVE] Backend not available, running in static mode');
      live.setLiveEnabled(false);
      renderStaticCampaignsView();
      return false;
    }

    console.log('[LIVE] Backend connected — enabling live mode');
    live.setLiveEnabled(true);
    showLiveIndicator();
    wireScanButton();

    try { await live.refresh('overview'); } catch (e) { console.warn('[LIVE] overview refresh error:', e.message); }
    try { await live.refresh('optimizations'); } catch (e) { console.warn('[LIVE] optimizations refresh error:', e.message); }
    try { await live.refresh('campaigns'); } catch (e) { console.warn('[LIVE] campaigns refresh error:', e.message); }
    try { await live.refresh('analytics'); } catch (e) { console.warn('[LIVE] analytics refresh error:', e.message); }
    try { await live.refresh('calendar'); } catch (e) { console.warn('[LIVE] calendar refresh error:', e.message); }
    try { await live.refresh('settings'); } catch (e) { console.warn('[LIVE] settings refresh error:', e.message); }

    startPolling();
    return true;
  }

  document.addEventListener('DOMContentLoaded', () => {
    live.setPageActivatedHandler(handlePageActivated);
    registerSeriesWindowRefresher('overview', () => live.refresh('overview'));
    registerSeriesWindowRefresher('profit-structure', () => live.refresh('analytics'));
    registerSeriesWindowRefresher('media-profitability', () => live.refresh('analytics'));
    registerSeriesWindowRefresher('revenue-quality', () => live.refresh('analytics'));
    initSeriesWindowControls();

    setTimeout(() => {
      startLiveMode();
    }, 1500);
  });
})();
