(function () {
  const live = window.AdPilotLive;
  const { checkBackendAvailable, triggerScan, api } = live.api;
  const { registerSeriesWindowRefresher, initSeriesWindowControls } = live.seriesWindows;
  const { tr } = live.shared;

  let overviewPollId = null;
  let optimizationPollId = null;
  let secondaryPollId = null;
  let scanPollId = null;
  let bootstrapPollId = null;

  function renderStaticCampaignsView() {
    const activeContainer = document.getElementById('activeAdsContainer');
    const activeCount = document.getElementById('activeCount');
    const inactiveContainer = document.getElementById('inactiveAdsContainer');
    const inactiveCount = document.getElementById('inactiveCount');
    const lessonsSummaryEl = document.getElementById('lessonsSummary');

    if (activeContainer) {
      if (activeCount) activeCount.textContent = tr('Backend offline', '백엔드 오프라인');
      activeContainer.innerHTML = `<div class="empty-state">${tr('Backend offline — live ad data unavailable. Start the server to connect.', '백엔드 오프라인 — 실시간 광고 데이터를 사용할 수 없습니다. 연결하려면 서버를 실행하세요.')}</div>`;
    }
    if (lessonsSummaryEl) lessonsSummaryEl.innerHTML = '';
    if (inactiveContainer) {
      if (inactiveCount) inactiveCount.textContent = '—';
      inactiveContainer.innerHTML = `<div class="empty-state">${tr('Backend offline — paused ad data unavailable.', '백엔드 오프라인 — 중지 광고 데이터를 사용할 수 없습니다.')}</div>`;
    }
  }

  function showLiveIndicator() {
    const statusLabel = document.querySelector('.status-label');
    if (statusLabel) {
      statusLabel.innerHTML = `${tr('Agent Active', '에이전트 활성')} <span id="liveDot" class="live-dot"></span>`;
    }
  }

  function wireScanButton() {
    const scanBtn = document.getElementById('runScanBtn');
    if (!scanBtn || scanBtn.dataset.liveBound === 'true') return;

    scanBtn.dataset.liveBound = 'true';
    scanBtn.addEventListener('click', async () => {
      const label = scanBtn.querySelector('span');
      if (label) label.textContent = tr('Scanning...', '스캔 중...');
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
          if (label) label.textContent = typeof window.t === 'function' ? window.t('header.runScan') : tr('Run Scan Now', '스캔 실행');
          scanBtn.disabled = false;
          const lastScanEl = document.getElementById('lastScan');
          if (lastScanEl) lastScanEl.textContent = tr('just now', '방금 전');
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
        await live.refresh('campaigns');
        await live.refresh('analytics');
        await live.refresh('fatigue');
        await live.refresh('budget');
        if (live.getActivePage() === 'calendar') {
          await live.refresh('calendar');
        }
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
        await live.refresh('optimizations');
        await live.refresh('campaigns');
        await live.refresh('analytics');
        await live.refresh('calendar');
        await live.refresh('settings');
      }
    }, 3000);
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

    const health = await api('/health');
    if (health?.isScanning || !health?.lastScan) {
      startBootstrapPolling();
    }

    startPolling();
    return true;
  }

  document.addEventListener('DOMContentLoaded', () => {
    live.setPageActivatedHandler(handlePageActivated);
    registerSeriesWindowRefresher('overview', () => live.refresh('overview'));
    registerSeriesWindowRefresher('campaigns', () => live.refresh('campaigns'));
    registerSeriesWindowRefresher('profit-structure', () => live.refresh('analytics'));
    registerSeriesWindowRefresher('media-profitability', () => live.refresh('analytics'));
    registerSeriesWindowRefresher('revenue-quality', () => live.refresh('analytics'));
    initSeriesWindowControls();

    setTimeout(() => {
      startLiveMode();
    }, 1500);
  });
})();
