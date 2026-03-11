(function () {
  const live = window.AdPilotLive;
  const { esc } = live.shared;
  const { fetchPostmortem, fetchAnalytics } = live.api;
  const ANALYSIS_WINDOW_KEY = '14d';

  async function refreshFatiguePage() {
    try {
      const postmortem = await fetchPostmortem(ANALYSIS_WINDOW_KEY);
      if (!postmortem) return;

      const grid = document.getElementById('fatigueGrid');
      const windowNoteEl = document.getElementById('fatigueWindowNote');
      if (windowNoteEl) {
        windowNoteEl.textContent = postmortem.windowDays
          ? `Recent ${postmortem.windowDays} day fatigue view`
          : 'All available fatigue history';
      }
      if (grid) {
        const active = postmortem.active || [];
        const fatigueBadgeEl = document.querySelector('[data-fatigue-badge]');

        if (active.length === 0) {
          grid.innerHTML = '<div class="empty-state">No active ads to analyze for fatigue.</div>';
          if (fatigueBadgeEl) {
            fatigueBadgeEl.textContent = '0 ads need attention · 0 healthy';
          }
        } else {
          const fatigueAds = active.map(ad => {
            const fatigue = ad.fatigue || {};
            const status = fatigue.status || 'healthy';
            const freq = Number(fatigue.lastFrequency ?? ad.lastFrequency ?? 0);
            const ctrDecay = Number(fatigue.ctrDecayPercent || 0);
            const cpmRise = Number(fatigue.cpmRisePercent || 0);
            const recentCtr = Number(fatigue.recentCTR ?? ad.lastCTR ?? ad.avgCTR ?? 0);
            const days = Number(fatigue.daysOfData ?? ad.daysOfData ?? 0);
            const actionBase = fatigue.summary || `Recent CTR ${recentCtr.toFixed(2)}%, frequency ${freq.toFixed(1)}.`;

            return {
              name: ad.name,
              status,
              frequency: freq.toFixed(2),
              ctrDecay: ctrDecay.toFixed(1),
              cpmRise: cpmRise.toFixed(1),
              recentCtr: recentCtr.toFixed(2),
              days,
              action: `${actionBase} Recent CTR ${recentCtr.toFixed(2)}%.`,
            };
          });

          if (fatigueBadgeEl) {
            const needsAttention = fatigueAds.filter(ad => ad.status !== 'healthy').length;
            const healthy = fatigueAds.filter(ad => ad.status === 'healthy').length;
            fatigueBadgeEl.textContent = `${needsAttention} ad${needsAttention !== 1 ? 's' : ''} need${needsAttention === 1 ? 's' : ''} attention · ${healthy} healthy`;
          }

          grid.innerHTML = fatigueAds.map(ad => `
            <div class="fatigue-card ${ad.status}">
              <div class="fatigue-header">
                <span class="fatigue-name">${esc(ad.name)}</span>
                <span class="badge badge-${ad.status === 'danger' ? 'error' : ad.status === 'warning' ? 'warning' : 'success'}">${ad.status.charAt(0).toUpperCase() + ad.status.slice(1)}</span>
              </div>
              <div class="fatigue-metrics">
                <div class="fatigue-metric">
                  <span class="fatigue-metric-label">Frequency</span>
                  <span class="fatigue-metric-value">${ad.frequency}</span>
                </div>
                <div class="fatigue-metric">
                  <span class="fatigue-metric-label">CTR Decay</span>
                  <span class="fatigue-metric-value" style="color:${parseFloat(ad.ctrDecay) >= 30 ? 'var(--color-error)' : parseFloat(ad.ctrDecay) >= 20 ? 'var(--color-warning)' : 'var(--color-success)'}">${ad.ctrDecay}%</span>
                </div>
                <div class="fatigue-metric">
                  <span class="fatigue-metric-label">CPM Rise</span>
                  <span class="fatigue-metric-value" style="color:${parseFloat(ad.cpmRise) >= 40 ? 'var(--color-error)' : parseFloat(ad.cpmRise) >= 20 ? 'var(--color-warning)' : 'var(--color-success)'}">${ad.cpmRise}%</span>
                </div>
                <div class="fatigue-metric">
                  <span class="fatigue-metric-label">Recent CTR</span>
                  <span class="fatigue-metric-value">${ad.recentCtr}%</span>
                </div>
              </div>
              <div class="fatigue-action">
                <i data-lucide="${ad.status === 'danger' ? 'alert-triangle' : ad.status === 'warning' ? 'eye' : 'check-circle'}"></i>
                <span>${esc(ad.action)}</span>
              </div>
            </div>
          `).join('');

          if (window.lucide) {
            lucide.createIcons({ nodes: [grid] });
          }
        }
      }

      const analyticsData = await fetchAnalytics();
      if (analyticsData && typeof fatigueChart !== 'undefined' && fatigueChart) {
        const trend = analyticsData.charts?.fatigueTrend || [];
        if (trend.length >= 2) {
          fatigueChart.data.labels = trend.map(row => row.date || '');
          fatigueChart.data.datasets[0].data = trend.map(row => row.ctr || 0);
          fatigueChart.data.datasets[1].data = trend.map(row => row.frequency || 0);
          fatigueChart.update();
        }
      }
    } catch (e) {
      console.warn('[LIVE] refreshFatiguePage error:', e.message);
    }
  }

  live.registerPage('fatigue', {
    refresh: refreshFatiguePage,
  });
})();
