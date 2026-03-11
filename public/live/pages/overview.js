(function () {
  const live = window.AdPilotLive;
  const { esc, safeOptType, timeSince } = live.shared;
  const { fetchOverview, fetchAnalytics, fetchOptimizations } = live.api;
  const { sliceRowsByWindow, updateSeriesWindowBadges } = live.seriesWindows;

  function updateImwebSourceIndicators(source) {
    const badgeEl = document.getElementById('imwebConnectedBadge');
    const labelEl = document.getElementById('imwebConnectedLabel');
    const noticeEl = document.getElementById('dataFreshnessNotice');

    if (badgeEl) {
      badgeEl.classList.remove('is-success', 'is-warning', 'is-error');
    }

    if (source?.stale) {
      if (badgeEl) badgeEl.classList.add('is-warning');
      if (labelEl) labelEl.textContent = 'Imweb stale';
      if (badgeEl) {
        const suffix = source.lastSuccessAt ? ` Last successful sync ${timeSince(new Date(source.lastSuccessAt))}.` : '';
        badgeEl.title = `Revenue/order metrics are cached.${suffix}`;
      }
      if (noticeEl) {
        noticeEl.hidden = false;
        noticeEl.textContent = 'Revenue data is cached from the last successful Imweb sync.';
      }
      return;
    }

    if (source?.status === 'error') {
      if (badgeEl) badgeEl.classList.add('is-error');
      if (labelEl) labelEl.textContent = 'Imweb error';
      if (badgeEl && source.lastError) badgeEl.title = source.lastError;
      if (noticeEl) {
        noticeEl.hidden = false;
        noticeEl.textContent = 'Imweb sync is currently unavailable.';
      }
      return;
    }

    if (badgeEl) badgeEl.classList.add('is-success');
    if (labelEl) labelEl.textContent = 'Imweb';
    if (badgeEl) badgeEl.title = source?.lastSuccessAt ? `Last successful Imweb sync ${timeSince(new Date(source.lastSuccessAt))}.` : 'Imweb data is up to date.';
    if (noticeEl) {
      noticeEl.hidden = true;
      noticeEl.textContent = '';
    }
  }

  async function updateActivityFeed() {
    try {
      const data = await fetchOptimizations(8);
      if (!data || !data.optimizations) return;

      const feed = document.getElementById('activityFeed');
      if (!feed) return;

      if (data.optimizations.length === 0) {
        feed.innerHTML = '<div class="activity-item"><div class="activity-content"><div class="activity-title">No activity yet</div><div class="activity-detail">Waiting for first scan to generate optimization data.</div></div></div>';
        return;
      }

      const iconMap = {
        budget: 'wallet',
        bid: 'trending-up',
        creative: 'image',
        status: 'power',
        schedule: 'clock',
        targeting: 'users',
      };

      feed.innerHTML = data.optimizations.slice(0, 8).map(opt => `
        <div class="activity-item">
          <div class="activity-icon ${safeOptType(opt.type)}">
            <i data-lucide="${iconMap[safeOptType(opt.type)] || 'zap'}"></i>
          </div>
          <div class="activity-content">
            <div class="activity-title">${esc(opt.action || opt.title || '—')}</div>
            <div class="activity-detail">${esc(opt.reason || opt.impact || '')}</div>
          </div>
          <div class="activity-time">${timeSince(new Date(opt.timestamp))}</div>
        </div>
      `).join('');

      if (window.lucide) {
        lucide.createIcons({ nodes: [feed] });
      }
    } catch (e) {
      console.warn('[LIVE] updateActivityFeed error:', e.message);
    }
  }

  async function refreshOverviewPage() {
    try {
      const [data, analyticsData] = await Promise.all([
        fetchOverview(),
        fetchAnalytics(),
      ]);
      if (!data) return;

      const k = data.kpis;
      updateImwebSourceIndicators(data.dataSources?.imweb || null);

      const revenueEl = document.querySelector('[data-kpi="revenue"] .kpi-value');
      if (revenueEl) {
        revenueEl.dataset.target = Math.round(k.revenue || 0);
        revenueEl.dataset.prefix = '₩';
        revenueEl.textContent = '₩' + Math.round(k.revenue || 0).toLocaleString();
      }
      const revenueSubEl = document.querySelector('[data-kpi="revenue"] .kpi-delta span');
      if (revenueSubEl) {
        const orders = k.totalOrders || 0;
        const aov = Math.round(k.aov || 0);
        revenueSubEl.textContent = orders + ' orders · ₩' + aov.toLocaleString() + ' AOV';
      }

      const cogsEl = document.querySelector('[data-kpi="cogs"] .kpi-value');
      if (cogsEl) {
        cogsEl.textContent = k.cogs != null ? '₩' + Math.round(k.cogs).toLocaleString() : '—';
      }
      const cogsSubEl = document.querySelector('[data-kpi="cogs"] .kpi-delta span');
      if (cogsSubEl && k.cogs != null) {
        cogsSubEl.textContent = (k.cogsRate || 0).toFixed(1) + '% of revenue · Google Sheets';
      }

      const spendEl = document.querySelector('[data-kpi="adspend"] .kpi-value');
      if (spendEl) {
        spendEl.dataset.target = Math.round(k.adSpendKRW || 0);
        spendEl.dataset.prefix = '₩';
        spendEl.textContent = '₩' + Math.round(k.adSpendKRW || 0).toLocaleString();
      }
      const spendSubEl = document.querySelector('[data-kpi="adspend"] .kpi-delta span');
      if (spendSubEl) {
        const fxRate = Number(data.fx?.usdToKrwRate || 0);
        const fxDate = data.fx?.rateDate || '';
        const usdText = '$' + Number(k.adSpend || 0).toFixed(2);
        if (fxRate > 0 && fxDate) {
          spendSubEl.textContent = `${usdText} · ${fxDate} FX ₩${fxRate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/USD`;
        } else {
          spendSubEl.textContent = `${usdText} · ${(data.days || '—')} days`;
        }
      }

      const profitEl = document.querySelector('[data-kpi="profit"] .kpi-value');
      if (profitEl) {
        const profit = k.grossProfit || 0;
        profitEl.textContent = profit >= 0
          ? '₩' + Math.round(profit).toLocaleString()
          : '-₩' + Math.abs(Math.round(profit)).toLocaleString();
      }
      const profitSubEl = document.querySelector('[data-kpi="profit"] .kpi-delta span');
      if (profitSubEl && k.grossMargin != null) {
        profitSubEl.textContent = '₩' + Math.round(k.netRevenue || 0).toLocaleString() + ' net · ' + k.grossMargin + '% margin';
      }

      const roasEl = document.querySelector('[data-kpi="roas"] .kpi-value');
      if (roasEl) {
        roasEl.dataset.target = k.roas != null ? k.roas.toFixed(2) : '0';
        roasEl.dataset.prefix = '';
        roasEl.dataset.suffix = 'x';
        roasEl.textContent = k.roas != null ? k.roas.toFixed(2) + 'x' : '—';
      }

      const purchasesEl = document.querySelector('[data-kpi="purchases"] .kpi-value');
      if (purchasesEl) {
        purchasesEl.dataset.target = k.purchases || 0;
        purchasesEl.dataset.prefix = '';
        purchasesEl.textContent = (k.purchases || 0).toString();
      }
      const purchasesSubEl = document.querySelector('[data-kpi="purchases"] .kpi-delta span');
      if (purchasesSubEl && data.days) {
        const avgPerDay = ((k.purchases || 0) / data.days).toFixed(1);
        purchasesSubEl.textContent = avgPerDay + ' avg/day';
      }

      const ctrEl = document.querySelector('[data-kpi="ctr"] .kpi-value');
      if (ctrEl) {
        ctrEl.dataset.target = (k.ctr || 0).toFixed(2);
        ctrEl.dataset.prefix = '';
        ctrEl.dataset.suffix = '%';
        ctrEl.textContent = (k.ctr || 0).toFixed(2) + '%';
      }

      const cpaEl = document.querySelector('[data-kpi="cpa"] .kpi-value');
      if (cpaEl) {
        cpaEl.dataset.target = k.cpa != null ? k.cpa.toFixed(2) : '0';
        cpaEl.dataset.prefix = '$';
        cpaEl.textContent = k.cpa != null ? '$' + k.cpa.toFixed(2) : '—';
      }

      if (data.lastScan) {
        const ago = timeSince(new Date(data.lastScan));
        const lastScanEl = document.getElementById('lastScan');
        if (lastScanEl) lastScanEl.textContent = ago;
      }
      const scanBtn = document.getElementById('runScanBtn');
      if (scanBtn) {
        const label = scanBtn.querySelector('span');
        if (data.isScanning) {
          if (label) label.textContent = 'Scanning...';
          scanBtn.disabled = true;
        } else {
          if (label) label.textContent = 'Run Scan Now';
          scanBtn.disabled = false;
        }
      }
      const liveDot = document.getElementById('liveDot');
      if (liveDot) {
        liveDot.classList.add('pulse');
        setTimeout(() => {
          liveDot.classList.remove('pulse');
        }, 1000);
      }

      const dailyMerged = sliceRowsByWindow((data.charts && data.charts.dailyMerged) || [], 'overview');
      const hourlyOrders = analyticsData?.charts?.hourlyOrders || [];
      updateSeriesWindowBadges('overview', dailyMerged);

      if (dailyMerged.length > 0) {
        const labels = dailyMerged.map(row => row.date);

        if (typeof spendRevenueChart !== 'undefined' && spendRevenueChart) {
          spendRevenueChart.data.labels = labels;
          spendRevenueChart.data.datasets[0].data = dailyMerged.map(row => row.revenue || 0);
          spendRevenueChart.data.datasets[1].data = dailyMerged.map(row => row.spendKrw || 0);
          spendRevenueChart.update();
        }

        if (typeof roasChart !== 'undefined' && roasChart) {
          const roasData = dailyMerged.map(row => row.roas || 0);
          const colors = typeof getChartColors === 'function' ? getChartColors() : {};
          const gold = colors.gold || '#FFC553';
          roasChart.data.labels = labels;
          roasChart.data.datasets[0].data = roasData;
          roasChart.data.datasets[0].pointBackgroundColor = roasData.map(value => value >= 3 ? '#4ade80' : value >= 1 ? gold : '#ef4444');
          roasChart.update();
        }

        if (typeof impactChart !== 'undefined' && impactChart) {
          impactChart.data.labels = labels;
          impactChart.data.datasets[0].data = dailyMerged.map(row => row.ctr || 0);
          impactChart.data.datasets[1].data = dailyMerged.map(row => row.cpc || 0);
          impactChart.update();
        }
      }

      const sparkIds = ['sparkRevenue', 'sparkSpend', 'sparkRoas', 'sparkPurchases', 'sparkCtr', 'sparkCpa', 'sparkCogs'];
      sparkIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
      });

      if (dailyMerged.length >= 2) {
        const last12 = dailyMerged.slice(-12);
        const colors = typeof getChartColors === 'function' ? getChartColors() : { primary: '#20808D', secondary: '#A84B2F' };
        if (typeof createSparkline === 'function') {
          createSparkline('sparkRevenue', last12.map(row => row.revenue || 0), '#4ade80');
          createSparkline('sparkSpend', last12.map(row => row.spendKrw || 0), colors.primary);
          createSparkline('sparkRoas', last12.map(row => row.roas || 0), colors.primary);
          createSparkline('sparkPurchases', last12.map(row => row.purchases || 0), '#4ade80');
          createSparkline('sparkCtr', last12.map(row => row.ctr || 0), colors.primary);
          createSparkline('sparkCpa', last12.map(row => row.cpa || 0), colors.secondary);
        }
      }

      if (hourlyOrders.length > 0 && typeof hourChartInstance !== 'undefined' && hourChartInstance) {
        const peakHours = hourlyOrders
          .slice()
          .sort((left, right) => (right.orders || 0) - (left.orders || 0))
          .slice(0, 3)
          .map(row => row.hour);

        hourChartInstance.data.labels = hourlyOrders.map(row => row.hour + ':00');
        hourChartInstance.data.datasets[0].data = hourlyOrders.map(row => row.orders || 0);
        hourChartInstance.data.datasets[0].backgroundColor = hourlyOrders.map(row =>
          peakHours.includes(row.hour) ? 'rgba(255, 197, 83, 0.9)' : 'rgba(32, 128, 141, 0.6)'
        );
        hourChartInstance.update();
      }

      await updateActivityFeed();
    } catch (e) {
      console.warn('[LIVE] refreshOverviewPage error:', e.message);
    }
  }

  live.registerPage('overview', {
    refresh: refreshOverviewPage,
  });
})();
