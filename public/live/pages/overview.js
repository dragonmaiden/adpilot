(function () {
  const live = window.AdPilotLive;
  const { timeSince, tr, getLocale, localizeSystemText } = live.shared;
  const { fetchOverview, fetchAnalytics } = live.api;
  const { sliceRowsByWindow, updateSeriesWindowBadges } = live.seriesWindows;

  function initOverviewPage() {
    document.querySelectorAll('[data-nav-target]').forEach(button => {
      if (button.dataset.navBound === 'true') return;
      button.dataset.navBound = 'true';
      button.addEventListener('click', event => {
        event.preventDefault();
        const target = button.dataset.navTarget;
        const nav = document.querySelector(`.nav-item[data-page="${target}"]`);
        if (nav) nav.click();
      });
    });
  }

  function getLatestTimestamp(values) {
    let latest = null;
    let latestTime = 0;
    for (const value of values) {
      if (!value) continue;
      const time = new Date(value).getTime();
      if (!Number.isFinite(time) || time <= latestTime) continue;
      latest = value;
      latestTime = time;
    }
    return latest;
  }

  function combineMetaSourceHealth(dataSources) {
    const structure = dataSources?.metaStructure || null;
    const insights = dataSources?.metaInsights || null;
    const parts = [structure, insights].filter(Boolean);

    if (parts.length === 0) {
      return null;
    }

    const latestSuccessAt = getLatestTimestamp(parts.map(part => part?.lastSuccessAt));
    const firstError = parts.map(part => part?.lastError).find(Boolean) || null;
    const hasData = parts.some(part => part?.hasData);

    if (parts.some(part => part?.status === 'error')) {
        return {
          status: 'error',
          stale: hasData,
          hasData,
          lastSuccessAt: latestSuccessAt,
          lastError: firstError,
        };
    }

    if (parts.some(part => part?.stale || part?.status === 'loaded')) {
        return {
          status: 'loaded',
          stale: true,
          hasData,
          lastSuccessAt: latestSuccessAt,
          lastError: null,
        };
    }

    if (parts.every(part => part?.status === 'connected' || part?.status === 'ok')) {
        return {
          status: 'connected',
          stale: false,
          hasData,
          lastSuccessAt: latestSuccessAt,
          lastError: null,
        };
    }

    if (hasData) {
        return {
          status: 'loaded',
          stale: false,
          hasData,
          lastSuccessAt: latestSuccessAt,
          lastError: null,
        };
    }

    return {
      status: 'unknown',
      stale: false,
      hasData: false,
      lastSuccessAt: latestSuccessAt,
      lastError: firstError,
    };
  }

  function getSourceBadgeMeta(source, labels) {
    if (source?.status === 'error') {
      return {
        badgeClass: 'is-error',
        stateText: tr('Error', '오류'),
        severity: 'error',
        title: source?.lastError
          ? localizeSystemText(source.lastError)
          : tr(`${labels.short} sync needs attention.`, `${labels.krShort} 동기화 점검이 필요합니다.`),
      };
    }

    if (source?.stale || source?.status === 'loaded') {
      return {
        badgeClass: 'is-warning',
        stateText: tr('Cached', '캐시'),
        severity: 'warning',
        title: source?.lastSuccessAt
          ? tr(`${labels.short} is using cached data from ${timeSince(new Date(source.lastSuccessAt))} ago.`, `${labels.krShort} 캐시 데이터를 ${timeSince(new Date(source.lastSuccessAt))} 전 기준으로 사용 중입니다.`)
          : tr(`${labels.short} is using cached data.`, `${labels.krShort} 캐시 데이터를 사용 중입니다.`),
      };
    }

    if (source?.status === 'connected' || source?.status === 'ok') {
      return {
        badgeClass: 'is-success',
        stateText: tr('Fresh', '최신'),
        severity: 'success',
        title: source?.lastSuccessAt
          ? tr(`${labels.short} synced ${timeSince(new Date(source.lastSuccessAt))} ago.`, `${labels.krShort} ${timeSince(new Date(source.lastSuccessAt))} 전에 동기화되었습니다.`)
          : tr(`${labels.short} is up to date.`, `${labels.krShort} 데이터가 최신입니다.`),
      };
    }

    return {
      badgeClass: '',
      stateText: tr('Waiting', '대기'),
      severity: 'neutral',
      title: tr(`Waiting for the first successful ${labels.short} sync.`, `첫 ${labels.krShort} 동기화를 기다리는 중입니다.`),
    };
  }

  function updateSourceBadge(badgeId, stateId, source, labels) {
    const badgeEl = document.getElementById(badgeId);
    const stateEl = document.getElementById(stateId);
    const badgeMeta = getSourceBadgeMeta(source, labels);

    if (badgeEl) {
      badgeEl.classList.remove('is-success', 'is-warning', 'is-error');
      if (badgeMeta.badgeClass) badgeEl.classList.add(badgeMeta.badgeClass);
      badgeEl.title = badgeMeta.title;
    }

    if (stateEl) {
      stateEl.textContent = badgeMeta.stateText;
    }

    return badgeMeta;
  }

  function setHeaderNotice(noticeEl, text, isError = false) {
    if (!noticeEl) return;
    noticeEl.classList.toggle('is-error', Boolean(isError));
    noticeEl.hidden = !text;
    noticeEl.textContent = text || '';
    noticeEl.title = text || '';
  }

  function updateHeaderSourceIndicators(dataSources) {
    const noticeEl = document.getElementById('dataFreshnessNotice');
    const metaSource = combineMetaSourceHealth(dataSources);
    const metaStatus = updateSourceBadge('metaConnectedBadge', 'metaConnectedState', metaSource, {
      short: 'Meta Ads',
      krShort: 'Meta 광고',
    });
    const imwebStatus = updateSourceBadge('imwebConnectedBadge', 'imwebConnectedState', dataSources?.imweb || null, {
      short: 'Imweb',
      krShort: 'Imweb',
    });
    const cogsStatus = updateSourceBadge('cogsConnectedBadge', 'cogsConnectedState', dataSources?.cogs || null, {
      short: 'Google Sheets',
      krShort: 'Google Sheets',
    });

    const errors = [];
    const warnings = [];
    const sourceEntries = [
      { name: tr('Meta Ads', 'Meta 광고'), meta: metaStatus },
      { name: 'Imweb', meta: imwebStatus },
      { name: 'Google Sheets', meta: cogsStatus },
    ];

    for (const entry of sourceEntries) {
      if (entry.meta.severity === 'error') errors.push(entry.name);
      if (entry.meta.severity === 'warning') warnings.push(entry.name);
    }

    if (errors.length > 0 && warnings.length > 0) {
      setHeaderNotice(noticeEl, tr(
        `${errors.join(', ')} need attention. Using cached data for ${warnings.join(', ')}.`,
        `${errors.join(', ')} 점검이 필요합니다. ${warnings.join(', ')} 캐시 데이터를 사용 중입니다.`
      ), true);
      return;
    }

    if (errors.length > 0) {
      setHeaderNotice(noticeEl, tr(
        `${errors.join(', ')} sync is currently unavailable.`,
        `${errors.join(', ')} 동기화를 현재 사용할 수 없습니다.`
      ), true);
      return;
    }

    if (warnings.length > 0) {
      setHeaderNotice(noticeEl, tr(
        `Using cached data for ${warnings.join(', ')}.`,
        `${warnings.join(', ')} 캐시 데이터를 사용 중입니다.`
      ));
      return;
    }

    setHeaderNotice(noticeEl, '');
  }

  async function refreshOverviewPage() {
    try {
      const [data, analyticsData] = await Promise.all([
        fetchOverview(),
        fetchAnalytics(),
      ]);
      if (!data) return;

      const k = data.kpis;
      updateHeaderSourceIndicators(data.dataSources || null);

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
        revenueSubEl.textContent = tr(
          `${orders} orders · ₩${aov.toLocaleString(getLocale())} AOV`,
          `${orders.toLocaleString(getLocale())}건 주문 · 객단가 ₩${aov.toLocaleString(getLocale())}`
        );
      }

      const cogsEl = document.querySelector('[data-kpi="cogs"] .kpi-value');
      if (cogsEl) {
        cogsEl.textContent = k.cogs != null ? '₩' + Math.round(k.cogs).toLocaleString() : '—';
      }
      const cogsSubEl = document.querySelector('[data-kpi="cogs"] .kpi-delta span');
      if (cogsSubEl && k.cogs != null) {
        cogsSubEl.textContent = tr(
          `${(k.cogsRate || 0).toFixed(1)}% of revenue · Google Sheets`,
          `매출 대비 ${(k.cogsRate || 0).toFixed(1)}% · Google Sheets`
        );
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
          spendSubEl.textContent = tr(
            `${usdText} · ${fxDate} FX ₩${fxRate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/USD`,
            `${usdText} · ${fxDate} 환율 ₩${fxRate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/USD`
          );
        } else {
          spendSubEl.textContent = tr(`${usdText} · ${data.days || '—'} days`, `${usdText} · ${data.days || '—'}일`);
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
        profitSubEl.textContent = tr(
          `₩${Math.round(k.netRevenue || 0).toLocaleString(getLocale())} net · ${k.grossMargin}% margin`,
          `순매출 ₩${Math.round(k.netRevenue || 0).toLocaleString(getLocale())} · 마진 ${k.grossMargin}%`
        );
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
        purchasesSubEl.textContent = tr(`${avgPerDay} avg/day`, `일평균 ${avgPerDay}`);
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
          if (label) label.textContent = tr('Scanning...', '스캔 중...');
          scanBtn.disabled = true;
        } else {
          if (label) label.textContent = typeof window.t === 'function' ? window.t('header.runScan') : tr('Run Scan Now', '스캔 실행');
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
      const dailyProfit = sliceRowsByWindow((data.charts && data.charts.dailyProfit) || [], 'overview');
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

      if (dailyProfit.length > 0 && typeof brandChart !== 'undefined' && brandChart) {
        const profitLabels = dailyProfit.map(row => row.date);
        const profitValues = dailyProfit.map(row => Number(row.profit || 0));
        brandChart.data.labels = profitLabels;
        brandChart.data.datasets[0].data = profitValues;
        brandChart.data.datasets[0].pointBackgroundColor = profitValues.map(value => value >= 0 ? '#4ade80' : '#f87171');
        brandChart.data.datasets[0].pointBorderColor = profitValues.map(value => value >= 0 ? '#4ade80' : '#f87171');
        brandChart.data.datasets[0].borderColor = profitValues.some(value => value < 0) ? '#20808D' : '#4ade80';
        brandChart.update();
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
    } catch (e) {
      console.warn('[LIVE] refreshOverviewPage error:', e.message);
    }
  }

  live.registerPage('overview', {
    init: initOverviewPage,
    refresh: refreshOverviewPage,
  });
})();
