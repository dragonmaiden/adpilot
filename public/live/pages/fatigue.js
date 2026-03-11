(function () {
  const live = window.AdPilotLive;
  const { esc, formatUsd, tr, getLocale, localizeCreativeText } = live.shared;
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
    if (inactiveCount) {
      inactiveCount.textContent = tr(
        `${inactive.length} with data · ${noData.length} archived`,
        `데이터 있음 ${inactive.length.toLocaleString(getLocale())}개 · 보관 ${noData.length.toLocaleString(getLocale())}개`
      );
    }

    if (lessonsSummaryEl) {
      const summary = postmortem?.lessonsSummary || {};
      const lessonLabels = {
        no_conversions: { icon: '⚠️', title: tr('Zero conversions', '전환 없음'), color: '#f87171', tip: tr('Test a different offer, audience, or hook before adding more spend.', '지출을 늘리기 전에 다른 오퍼, 오디언스, 후킹 포인트를 테스트하세요.') },
        high_cpa: { icon: '💸', title: tr('High CPA', '높은 CPA'), color: '#facc15', tip: tr('Acquisition cost rose above a healthy range. Tighten targeting or refresh the creative.', '획득 비용이 정상 범위를 넘었습니다. 타게팅을 조이거나 크리에이티브를 교체하세요.') },
        ctr_decay: { icon: '📉', title: tr('CTR decay', 'CTR 하락'), color: '#fb923c', tip: tr('The ad lost click momentum. Rotate or replace before spend drifts.', '광고 클릭 모멘텀이 떨어졌습니다. 지출이 새기 전에 교체하거나 회전하세요.') },
        high_frequency: { icon: '🔁', title: tr('Audience saturation', '오디언스 포화'), color: '#c084fc', tip: tr('Frequency is climbing. Open new audiences or rotate the creative set.', '빈도가 상승 중입니다. 새 오디언스를 열거나 크리에이티브 세트를 교체하세요.') },
        clicks_no_purchase: { icon: '🛒', title: tr('Clicks without sales', '클릭 대비 판매 없음'), color: '#38bdf8', tip: tr('The ad got attention but did not close. Review landing page, pricing, or checkout.', '광고는 관심을 끌었지만 구매로 이어지지 않았습니다. 랜딩, 가격, 결제를 점검하세요.') },
        general: { icon: '📝', title: tr('Manual pause', '수동 중지'), color: '#94a3b8', tip: tr('Use this as a reference when deciding which creative patterns to revisit.', '어떤 크리에이티브 패턴을 다시 볼지 판단할 때 참고하세요.') },
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
      inactiveContainer.innerHTML = `<div class="empty-state">${esc(tr('No paused ads in this window.', '이 기간에 중지된 광고가 없습니다.'))}</div>`;
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
            return `<div style="font-size:0.8rem;color:var(--color-text-muted);margin-top:4px">${typeIcons[lesson.type] || '•'} ${esc(localizeCreativeText(lesson.text))}</div>`;
          }).join('');

          return `
            <div style="background:var(--color-surface-alt);border-radius:10px;padding:14px 16px;border:1px solid var(--color-divider);opacity:0.92">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                <div style="font-weight:600;font-size:0.88rem">${esc(ad.name)}</div>
                <div class="inactive-ad-meta">
                  <span>${tr(`${formatUsd(ad.spend || 0, 2)} spent`, `${formatUsd(ad.spend || 0, 2)} 지출`)}</span>
                  <span>·</span>
                  <span>${tr(`${getAttributedPurchases(ad)} Meta-attributed purchase${getAttributedPurchases(ad) !== 1 ? 's' : ''}`, `메타 귀속 구매 ${getAttributedPurchases(ad).toLocaleString(getLocale())}건`)}</span>
                  <span>·</span>
                  <span>${Number(ad.avgCTR || 0).toFixed(2)}% CTR</span>
                  ${ad.cpa ? `<span>·</span><span>${formatUsd(ad.cpa, 2)} CPA</span>` : ''}
                </div>
              </div>
              ${lessonHTML}
              <div style="font-size:0.72rem;color:var(--color-text-faint);margin-top:6px">${tr(`${ad.daysOfData} days of data`, `${ad.daysOfData}일 데이터`)} · ${esc(ad.campaignName)}</div>
            </div>
          `;
        }).join('')}
        ${noData.length > 0 ? `
          <div style="margin-top:8px;padding:12px 16px;background:var(--color-surface-alt);border-radius:10px;border:1px solid var(--color-divider);opacity:0.7">
            <div style="font-weight:600;font-size:0.85rem;margin-bottom:6px">💭 ${tr(`${noData.length} archived ads (no recent data)`, `보관된 광고 ${noData.length.toLocaleString(getLocale())}개 (최근 데이터 없음)`)}</div>
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
          ? tr(`Recent ${postmortem.windowDays} day creative health view`, `최근 ${postmortem.windowDays}일 크리에이티브 상태 보기`)
          : tr('All available creative health history', '사용 가능한 전체 크리에이티브 상태 이력');
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
          grid.innerHTML = `<div class="empty-state">${esc(tr('No active ads to analyze for creative health.', '크리에이티브 상태를 분석할 활성 광고가 없습니다.'))}</div>`;
          if (fatigueBadgeEl) {
            fatigueBadgeEl.textContent = tr('0 ads need attention · 0 healthy', '주의 필요 0개 · 정상 0개');
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
            const actionBase = localizeCreativeText(fatigue.summary || tr(`Recent CTR ${recentCtr.toFixed(2)}%, frequency ${freq.toFixed(1)}.`, `최근 CTR ${recentCtr.toFixed(2)}%, 빈도 ${freq.toFixed(1)}.`));

            return {
              name: ad.name,
              status,
              frequency: freq.toFixed(2),
              ctrDecay: ctrDecay.toFixed(1),
              cpmRise: cpmRise.toFixed(1),
              recentCtr: recentCtr.toFixed(2),
              days,
              action: actionBase,
            };
          });

          if (fatigueBadgeEl) {
            const needsAttention = fatigueAds.filter(ad => ad.status !== 'healthy').length;
            const healthy = fatigueAds.filter(ad => ad.status === 'healthy').length;
            fatigueBadgeEl.textContent = tr(
              `${needsAttention} ad${needsAttention !== 1 ? 's' : ''} need${needsAttention === 1 ? 's' : ''} attention · ${healthy} healthy`,
              `주의 필요 ${needsAttention.toLocaleString(getLocale())}개 · 정상 ${healthy.toLocaleString(getLocale())}개`
            );
          }

          grid.innerHTML = fatigueAds.map(ad => `
            <div class="fatigue-card ${ad.status}">
              <div class="fatigue-header">
                <span class="fatigue-name">${esc(ad.name)}</span>
                <span class="badge badge-${ad.status === 'danger' ? 'error' : ad.status === 'warning' ? 'warning' : 'success'}">${ad.status === 'danger' ? tr('Danger', '위험') : ad.status === 'warning' ? tr('Warning', '주의') : tr('Healthy', '정상')}</span>
              </div>
              <div class="fatigue-metrics">
                <div class="fatigue-metric">
                  <span class="fatigue-metric-label">${esc(tr('Frequency', '빈도'))}</span>
                  <span class="fatigue-metric-value">${ad.frequency}</span>
                </div>
                <div class="fatigue-metric">
                  <span class="fatigue-metric-label">${esc(tr('CTR Decay', 'CTR 하락'))}</span>
                  <span class="fatigue-metric-value" style="color:${parseFloat(ad.ctrDecay) >= 30 ? 'var(--color-error)' : parseFloat(ad.ctrDecay) >= 20 ? 'var(--color-warning)' : 'var(--color-success)'}">${ad.ctrDecay}%</span>
                </div>
                <div class="fatigue-metric">
                  <span class="fatigue-metric-label">${esc(tr('CPM Rise', 'CPM 상승'))}</span>
                  <span class="fatigue-metric-value" style="color:${parseFloat(ad.cpmRise) >= 40 ? 'var(--color-error)' : parseFloat(ad.cpmRise) >= 20 ? 'var(--color-warning)' : 'var(--color-success)'}">${ad.cpmRise}%</span>
                </div>
                <div class="fatigue-metric">
                  <span class="fatigue-metric-label">${esc(tr('Recent CTR', '최근 CTR'))}</span>
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
