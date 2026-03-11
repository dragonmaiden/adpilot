(function () {
  const live = window.AdPilotLive;
  const { esc, formatUsd } = live.shared;
  const { fetchPostmortem, fetchAnalytics } = live.api;
  const ANALYSIS_WINDOW_KEY = '14d';

  function getAttributedPurchases(subject) {
    return Number(subject?.attributedPurchases ?? subject?.metaPurchases ?? 0);
  }

  function renderCreativeLearnings(postmortem) {
    const lessonsSummaryEl = document.getElementById('fatigueLessonsSummary');
    const inactiveContainer = document.getElementById('fatigueInactiveAdsContainer');
    const inactiveCount = document.getElementById('fatigueInactiveCount');
    if (!inactiveContainer) return;

    const inactive = postmortem?.inactive || [];
    const noData = postmortem?.noData || [];
    if (inactiveCount) inactiveCount.textContent = `${inactive.length} with data · ${noData.length} archived`;

    if (lessonsSummaryEl) {
      const summary = postmortem?.lessonsSummary || {};
      const lessonLabels = {
        no_conversions: { icon: '⚠️', title: 'Zero conversions', color: '#f87171', tip: 'Test a different offer, audience, or hook before adding more spend.' },
        high_cpa: { icon: '💸', title: 'High CPA', color: '#facc15', tip: 'Acquisition cost rose above a healthy range. Tighten targeting or refresh the creative.' },
        ctr_decay: { icon: '📉', title: 'CTR decay', color: '#fb923c', tip: 'The ad lost click momentum. Rotate or replace before spend drifts.' },
        high_frequency: { icon: '🔁', title: 'Audience saturation', color: '#c084fc', tip: 'Frequency is climbing. Open new audiences or rotate the creative set.' },
        clicks_no_purchase: { icon: '🛒', title: 'Clicks without sales', color: '#38bdf8', tip: 'The ad got attention but did not close. Review landing page, pricing, or checkout.' },
        general: { icon: '📝', title: 'Manual pause', color: '#94a3b8', tip: 'Use this as a reference when deciding which creative patterns to revisit.' },
      };
      const keys = Object.keys(summary).filter(key => key !== 'no_data');
      lessonsSummaryEl.innerHTML = keys.length > 0 ? `
        <div class="lessons-summary-grid">
          ${keys.map(key => {
            const info = lessonLabels[key] || { icon: 'ℹ️', title: key, color: '#94a3b8', tip: '' };
            const count = Number(summary[key].count) || 0;
            return `
              <div class="lesson-pill" style="--lesson-color:${info.color}">
                <div class="lesson-pill-count">${info.icon} <strong>${count}</strong></div>
                <div class="lesson-pill-title">${esc(info.title)}</div>
                <div class="lesson-pill-detail">${esc(info.tip)}</div>
              </div>
            `;
          }).join('')}
        </div>
      ` : '';
    }

    if (inactive.length === 0 && noData.length === 0) {
      inactiveContainer.innerHTML = '<div class="empty-state">No paused ads in this window.</div>';
      return;
    }

    inactiveContainer.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:8px">
        ${inactive.map(ad => {
          const lessonHTML = (ad.lessons || []).map(lesson => {
            const typeIcons = {
              no_conversions: '⚠️',
              high_cpa: '💸',
              ctr_decay: '📉',
              high_frequency: '🔁',
              clicks_no_purchase: '🛒',
              general: '📝',
              no_data: '💭',
            };
            return `<div style="font-size:0.8rem;color:var(--color-text-muted);margin-top:4px">${typeIcons[lesson.type] || '•'} ${esc(lesson.text)}</div>`;
          }).join('');

          return `
            <div style="background:var(--color-surface-alt);border-radius:10px;padding:14px 16px;border:1px solid var(--color-divider);opacity:0.92">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                <div style="font-weight:600;font-size:0.88rem">${esc(ad.name)}</div>
                <div class="inactive-ad-meta">
                  <span>${formatUsd(ad.spend || 0, 2)} spent</span>
                  <span>·</span>
                  <span>${getAttributedPurchases(ad)} Meta-attributed purchase${getAttributedPurchases(ad) !== 1 ? 's' : ''}</span>
                  <span>·</span>
                  <span>${Number(ad.avgCTR || 0).toFixed(2)}% CTR</span>
                  ${ad.cpa ? `<span>·</span><span>${formatUsd(ad.cpa, 2)} CPA</span>` : ''}
                </div>
              </div>
              ${lessonHTML}
              <div style="font-size:0.72rem;color:var(--color-text-faint);margin-top:6px">${ad.daysOfData} days of data · ${esc(ad.campaignName)}</div>
            </div>
          `;
        }).join('')}
        ${noData.length > 0 ? `
          <div style="margin-top:8px;padding:12px 16px;background:var(--color-surface-alt);border-radius:10px;border:1px solid var(--color-divider);opacity:0.7">
            <div style="font-weight:600;font-size:0.85rem;margin-bottom:6px">💭 ${noData.length} archived ads (no recent data)</div>
            <div style="font-size:0.78rem;color:var(--color-text-faint);line-height:1.6">
              ${noData.map(ad => esc(ad.name)).join(' · ')}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  async function refreshFatiguePage() {
    try {
      const postmortem = await fetchPostmortem(ANALYSIS_WINDOW_KEY);
      if (!postmortem) return;

      const grid = document.getElementById('fatigueGrid');
      const windowNoteEl = document.getElementById('fatigueWindowNote');
      if (windowNoteEl) {
        windowNoteEl.textContent = postmortem.windowDays
          ? `Recent ${postmortem.windowDays} day creative health view`
          : 'All available creative health history';
      }
      if (grid) {
        const active = (postmortem.active || []).slice().sort((left, right) => {
          const weight = { danger: 2, warning: 1, healthy: 0 };
          const statusGap = (weight[right.fatigue?.status] || 0) - (weight[left.fatigue?.status] || 0);
          if (statusGap !== 0) return statusGap;
          return Number(right.spend || 0) - Number(left.spend || 0);
        });
        const fatigueBadgeEl = document.querySelector('[data-fatigue-badge]');

        if (active.length === 0) {
          grid.innerHTML = '<div class="empty-state">No active ads to analyze for creative health.</div>';
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

      renderCreativeLearnings(postmortem);

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
