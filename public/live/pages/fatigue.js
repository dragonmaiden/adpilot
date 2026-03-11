(function () {
  const live = window.AdPilotLive;
  const { esc } = live.shared;
  const { fetchPostmortem, fetchAnalytics } = live.api;

  async function refreshFatiguePage() {
    try {
      const postmortem = await fetchPostmortem();
      if (!postmortem) return;

      const grid = document.getElementById('fatigueGrid');
      if (grid) {
        const active = postmortem.active || [];

        if (active.length === 0) {
          grid.innerHTML = '<div class="empty-state">No active ads to analyze for fatigue.</div>';
        } else {
          const fatigueAds = active.map(ad => {
            let status = 'healthy';

            const freq = ad.lastFrequency || 1;
            const ctr = ad.avgCTR || 0;
            const cpm = ad.avgCPM || 0;

            if (freq > 2.5 || ctr < 5) status = 'danger';
            else if (freq > 1.8 || ctr < 8) status = 'warning';

            return {
              name: ad.name,
              status,
              frequency: freq.toFixed(2),
              ctrDecay: ctr.toFixed(2),
              cpmRise: cpm.toFixed(2),
              days: ad.daysOfData || 0,
              action: status === 'danger'
                ? `Frequency ${freq.toFixed(1)} is high. CTR at ${ctr.toFixed(1)}% — consider pausing or refreshing.`
                : status === 'warning'
                ? `Frequency ${freq.toFixed(1)} — monitor closely. ${ctr.toFixed(1)}% CTR.`
                : `Healthy. ${ctr.toFixed(1)}% CTR, ${freq.toFixed(1)}x frequency. No fatigue signs.`,
            };
          });

          const fatigueBadgeEl = document.querySelector('[data-fatigue-badge]');
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
                  <span class="fatigue-metric-label">Avg CTR</span>
                  <span class="fatigue-metric-value" style="color:${parseFloat(ad.ctrDecay) < 5 ? 'var(--color-error)' : parseFloat(ad.ctrDecay) < 8 ? 'var(--color-warning)' : 'var(--color-success)'}">${ad.ctrDecay}%</span>
                </div>
                <div class="fatigue-metric">
                  <span class="fatigue-metric-label">Avg CPM</span>
                  <span class="fatigue-metric-value">$${ad.cpmRise}</span>
                </div>
                <div class="fatigue-metric">
                  <span class="fatigue-metric-label">Active Days</span>
                  <span class="fatigue-metric-value">${ad.days}d</span>
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
