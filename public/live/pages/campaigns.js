(function () {
  const live = window.AdPilotLive;
  const { esc, formatUsd, formatPercent, formatCompactKrw, formatSignedCompactKrw, timeSince, tr, getLocale, localizeOptimizationText, localizeCreativeText } = live.shared;
  const { fetchCampaigns, fetchLivePerformance, fetchPostmortem, fetchOptimizations, fetchAnalytics, fetchOverview, fetchScans, fetchSpendDaily, updateCampaignStatus } = live.api;
  const { getSeriesWindowMeta } = live.seriesWindows;

  const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
  const EXECUTABLE_TYPES = new Set(['budget', 'bid', 'status']);
  const ACTION_ICON = {
    budget: 'wallet',
    bid: 'gavel',
    creative: 'image',
    status: 'power',
    schedule: 'clock',
    targeting: 'target',
  };
  let liveIntradayChart = null;
  let liveDailyContextChart = null;

  function getIntradayChartColors() {
    const style = getComputedStyle(document.documentElement);
    return {
      text: style.getPropertyValue('--color-text-faint').trim() || '#718096',
      grid: style.getPropertyValue('--color-divider').trim() || 'rgba(148, 163, 184, 0.16)',
      spend: '#A84B2F',
      revenue: '#4ade80',
      contribution: '#20808D',
    };
  }

  function bindNavShortcuts(scope = document) {
    scope.querySelectorAll('[data-nav-target]').forEach(button => {
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

  function priorityBadge(priority) {
    const normalized = String(priority || 'low').toLowerCase();
    const klass = {
      critical: 'badge-danger',
      high: 'badge-warning',
      medium: 'badge-info',
      low: 'badge-neutral',
    }[normalized] || 'badge-neutral';
    const labels = {
      critical: tr('Critical', '치명적'),
      high: tr('High', '높음'),
      medium: tr('Medium', '보통'),
      low: tr('Low', '낮음'),
    };
    return { label: labels[normalized] || normalized, klass };
  }

  function fatigueWeight(status) {
    if (status === 'danger') return 2;
    if (status === 'warning') return 1;
    return 0;
  }

  function getAttributedPurchases(subject) {
    return Number(subject?.attributedPurchases ?? subject?.metaPurchases ?? 0);
  }

  function normalizeActionKey(action) {
    return String(action || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function getPendingExecutableGroups(optData, latestScanId = null) {
    const pending = (optData?.optimizations || [])
      .filter(opt => !opt.executed && EXECUTABLE_TYPES.has(opt.type))
      .filter(opt => latestScanId == null || opt.scanId === latestScanId)
      .slice()
      .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')));

    const groups = new Map();
    for (const opt of pending) {
      const key = [
        String(opt.type || ''),
        String(opt.targetId || opt.targetName || ''),
        normalizeActionKey(opt.action),
      ].join('|');
      const existing = groups.get(key);
      if (existing) {
        existing.repeats += 1;
        continue;
      }
      groups.set(key, { ...opt, repeats: 1 });
    }

    return Array.from(groups.values()).sort((left, right) => {
      const leftPriority = PRIORITY_RANK[left.priority] ?? PRIORITY_RANK.low;
      const rightPriority = PRIORITY_RANK[right.priority] ?? PRIORITY_RANK.low;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      return String(right.timestamp || '').localeCompare(String(left.timestamp || ''));
    });
  }

  function getPaceSnapshot(campaignData, analyticsData) {
    const campaigns = campaignData?.campaigns || [];
    const activeCampaigns = campaigns.filter(campaign => campaign.status === 'ACTIVE');
    const dailySpendSeries = analyticsData?.charts?.dailyMerged || [];
    const referenceDate = analyticsData?.profitAnalysis?.todaySummary?.date
      || (dailySpendSeries.length > 0 ? dailySpendSeries[dailySpendSeries.length - 1].date : null);
    const latestDailySpendRow = dailySpendSeries.find(row => row.date === referenceDate)
      || (dailySpendSeries.length > 0 ? dailySpendSeries[dailySpendSeries.length - 1] : null);
    const latestDailySpend = Number(latestDailySpendRow?.spend || 0);
    const totalDailyBudget = activeCampaigns.reduce((sum, campaign) => {
      return sum + (campaign.dailyBudget ? parseInt(campaign.dailyBudget, 10) / 100 : 0);
    }, 0);
    const pacePct = totalDailyBudget > 0 ? (latestDailySpend / totalDailyBudget) * 100 : 0;

    return {
      activeCampaigns,
      latestDailySpend,
      totalDailyBudget,
      pacePct,
      referenceDate,
    };
  }

  function updateLiveKpi(key, value, detail, tone) {
    const card = document.querySelector(`[data-live-kpi="${key}"]`);
    if (!card) return;
    const valueEl = card.querySelector('.kpi-value');
    const deltaEl = card.querySelector('.kpi-delta');
    const detailEl = deltaEl ? deltaEl.querySelector('span') : null;

    if (valueEl) valueEl.textContent = value;
    if (detailEl) detailEl.textContent = detail;
    if (deltaEl) {
      deltaEl.classList.remove('positive', 'negative', 'neutral');
      deltaEl.classList.add(tone || 'neutral');
    }
  }

  function ensureIntradayChart() {
    const canvas = document.getElementById('liveIntradayChart');
    if (!canvas || typeof Chart === 'undefined') return null;
    if (liveIntradayChart) return liveIntradayChart;

    const colors = getIntradayChartColors();
    liveIntradayChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: tr('Spend', '지출'),
            data: [],
            borderColor: colors.spend,
            backgroundColor: colors.spend + '20',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.35,
            yAxisID: 'y',
          },
          {
            label: tr('Revenue', '매출'),
            data: [],
            borderColor: colors.revenue,
            backgroundColor: colors.revenue + '20',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.35,
            yAxisID: 'y',
          },
          {
            label: tr('Profit', '이익'),
            data: [],
            borderColor: colors.contribution,
            backgroundColor: colors.contribution + '18',
            borderWidth: 2.5,
            pointRadius: 0,
            tension: 0.35,
            fill: false,
            yAxisID: 'y',
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: {
              color: colors.text,
              usePointStyle: true,
              padding: 14,
              font: { size: 11 },
            },
          },
          tooltip: {
            callbacks: {
              label(context) {
                const value = Number(context.raw || 0);
                const label = context.dataset.label || '';
                return `${label}: ${value < 0 ? '-' : ''}${formatCompactKrw(Math.abs(value))}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: colors.text },
          },
          y: {
            position: 'left',
            grid: { color: colors.grid },
            ticks: {
              color: colors.text,
              callback: value => formatCompactKrw(value),
            },
          },
        },
      },
    });

    return liveIntradayChart;
  }

  function ensureDailyContextChart() {
    const canvas = document.getElementById('liveDailyContextChart');
    if (!canvas || typeof Chart === 'undefined') return null;
    if (liveDailyContextChart) return liveDailyContextChart;

    const colors = getIntradayChartColors();
    liveDailyContextChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          {
            label: tr('Spend', '지출'),
            data: [],
            backgroundColor: colors.spend + 'B3',
            borderRadius: 5,
            yAxisID: 'y',
          },
          {
            label: 'CAC',
            data: [],
            type: 'line',
            borderColor: '#38bdf8',
            backgroundColor: 'rgba(56, 189, 248, 0.12)',
            borderWidth: 2,
            pointRadius: 3,
            pointHoverRadius: 5,
            tension: 0.3,
            yAxisID: 'y1',
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: {
              color: colors.text,
              usePointStyle: true,
              padding: 14,
              font: { size: 11 },
            },
          },
          tooltip: {
            callbacks: {
              label(context) {
                const value = Number(context.raw || 0);
                if (context.datasetIndex === 0) {
                  return `${context.dataset.label}: ${formatCompactKrw(value)}`;
                }
                return `${context.dataset.label}: ${formatCompactKrw(value)}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: colors.text },
          },
          y: {
            position: 'left',
            grid: { color: colors.grid },
            ticks: {
              color: colors.text,
              callback: value => formatCompactKrw(value),
            },
          },
          y1: {
            position: 'right',
            grid: { drawOnChartArea: false },
            ticks: {
              color: colors.text,
              callback: value => formatCompactKrw(value),
            },
          },
        },
      },
    });

    return liveDailyContextChart;
  }

  function filterDailyWindow(rows, windowMeta) {
    const list = Array.isArray(rows) ? rows.slice() : [];
    if (!windowMeta?.days) return list;
    return list.slice(-windowMeta.days);
  }

  function renderIntradayMetrics(container, intraday) {
    if (!container) return;
    const summary = intraday?.summary || {};
    const metrics = [
      {
        label: tr('Spend so far', '현재까지 지출'),
        value: formatCompactKrw(summary.spendSoFarKrw || 0),
        meta: summary.totalDailyBudgetKrw > 0
          ? tr(
              `${formatPercent((summary.spendSoFarKrw / Math.max(summary.totalDailyBudgetKrw, 1)) * 100, 0)} of active budget`,
              `활성 예산의 ${formatPercent((summary.spendSoFarKrw / Math.max(summary.totalDailyBudgetKrw, 1)) * 100, 0)}`
            )
          : tr('No active budget pool', '활성 예산 풀 없음'),
      },
      {
        label: tr('Revenue so far', '현재까지 매출'),
        value: formatCompactKrw(summary.revenueSoFarKrw || 0),
        meta: tr('Recognized cash only', '인식된 현금 기준'),
      },
      {
        label: tr('Profit before ads', '광고비 전 이익'),
        value: formatSignedCompactKrw(summary.contributionBeforeAdsKrw || 0),
        meta: tr('Revenue minus COGS, shipping, and fees', '매출에서 원가, 배송, 결제 수수료 차감'),
      },
      {
        label: tr('Profit', '이익'),
        value: formatSignedCompactKrw(summary.profitKrw ?? summary.contributionAfterAdsKrw ?? 0),
        meta: tr('After product costs, fees, and ad spend', '상품 원가, 수수료, 광고비 차감 후'),
      },
      {
        label: 'ROAS',
        value: `${Number(summary.roas || 0).toFixed(2)}x`,
        meta: tr('Revenue / ad spend', '매출 / 광고비'),
      },
      {
        label: 'POAS',
        value: `${Number(summary.poas || 0).toFixed(2)}x`,
        meta: tr('Contribution before ads / ad spend', '광고비 전 기여이익 / 광고비'),
      },
      {
        label: tr('Orders so far', '현재까지 주문'),
        value: Number(summary.ordersSoFar || 0).toLocaleString(getLocale()),
        meta: tr('Recognized paid orders only', '인식된 결제 주문 기준'),
      },
      {
        label: 'AOV',
        value: formatCompactKrw(summary.aovKrw || 0),
        meta: tr('Revenue / orders', '매출 / 주문수'),
      },
    ];

    container.innerHTML = metrics.map(metric => `
      <div class="live-intraday-metric">
        <span>${esc(metric.label)}</span>
        <strong>${esc(metric.value)}</strong>
        <small>${esc(metric.meta)}</small>
      </div>
    `).join('');
  }

  function renderIntradayHighlights(container, intraday) {
    if (!container) return;
    const highlights = Array.isArray(intraday?.highlights) ? intraday.highlights : [];
    if (highlights.length === 0) {
      container.innerHTML = `<div class="empty-state">${esc(tr('No intraday highlights yet.', '아직 당일 하이라이트가 없습니다.'))}</div>`;
      return;
    }

    container.innerHTML = highlights.map(item => `
      <div class="live-intraday-highlight">${esc(item)}</div>
    `).join('');
  }

  function renderIntradayChart(intraday) {
    const chart = ensureIntradayChart();
    if (!chart) return;
    const points = intraday?.chart?.points || [];
    const colors = getIntradayChartColors();
    chart.data.labels = points.map(point => point.label);
    chart.data.datasets[0].data = points.map(point => point.cumulativeSpendKrw);
    chart.data.datasets[1].data = points.map(point => point.cumulativeRevenueKrw);
    chart.data.datasets[2].data = points.map(point => point.cumulativeContributionAfterAdsKrw);
    chart.data.datasets[0].borderColor = colors.spend;
    chart.data.datasets[0].backgroundColor = colors.spend + '20';
    chart.data.datasets[1].borderColor = colors.revenue;
    chart.data.datasets[1].backgroundColor = colors.revenue + '20';
    chart.data.datasets[2].borderColor = colors.contribution;
    chart.data.datasets[2].backgroundColor = colors.contribution + '18';
    chart.options.plugins.legend.labels.color = colors.text;
    chart.options.scales.y.grid.color = colors.grid;
    chart.options.scales.y.ticks.color = colors.text;
    chart.options.scales.x.ticks.color = colors.text;
    chart.update();
  }

  function renderIntradaySection(livePerformance) {
    const asOfEl = document.getElementById('liveIntradayAsOf');
    const takeawayEl = document.getElementById('liveIntradayTakeaway');
    const pillEl = document.getElementById('liveIntradayTakeawayPill');
    const headlineEl = document.getElementById('liveIntradayTakeawayHeadline');
    const detailEl = document.getElementById('liveIntradayTakeawayDetail');
    const confidenceEl = document.getElementById('liveIntradayConfidence');
    const confidenceDetailEl = document.getElementById('liveIntradayConfidenceDetail');
    const metricsEl = document.getElementById('liveIntradayMetrics');
    const highlightsEl = document.getElementById('liveIntradayHighlights');

    const intraday = livePerformance?.intraday;
    if (!intraday) {
      if (asOfEl) asOfEl.textContent = tr('Waiting for intraday data', '당일 데이터 대기 중');
      if (takeawayEl) takeawayEl.dataset.tone = 'neutral';
      if (pillEl) pillEl.textContent = tr('No data yet', '데이터 없음');
      if (headlineEl) headlineEl.textContent = tr('Intraday pace is not ready yet', '당일 페이스가 아직 준비되지 않았습니다');
      if (detailEl) detailEl.textContent = tr('Once scans and order data are available, this card will show whether today is pacing cleanly or burning early.', '스캔과 주문 데이터가 잡히면 오늘이 건강하게 가는지, 초반 소진이 빠른지 이 카드가 보여줍니다.');
      if (confidenceEl) confidenceEl.textContent = '—';
      if (confidenceDetailEl) confidenceDetailEl.textContent = '—';
      if (metricsEl) metricsEl.innerHTML = `<div class="empty-state">${esc(tr('Intraday pace is not ready yet.', '당일 페이스가 아직 준비되지 않았습니다.'))}</div>`;
      if (highlightsEl) highlightsEl.innerHTML = `<div class="empty-state">${esc(tr('Intraday highlights will appear after the next live refresh.', '다음 라이브 갱신 후 당일 하이라이트가 표시됩니다.'))}</div>`;
      return;
    }

    if (asOfEl) {
      asOfEl.textContent = tr(
        `KST · ${intraday.chart?.snapshotCount || 0} spend snapshots today`,
        `KST · 오늘 지출 스냅샷 ${Number(intraday.chart?.snapshotCount || 0).toLocaleString(getLocale())}개`
      );
    }
    if (takeawayEl) takeawayEl.dataset.tone = intraday.takeaway?.tone || 'neutral';
    if (pillEl) {
      pillEl.textContent = intraday.chart?.usingSnapshotSpend
        ? tr('Live scan spend', '라이브 스캔 지출')
        : tr('Current-state fallback', '현재 상태 대체값');
    }
    if (headlineEl) headlineEl.textContent = intraday.takeaway?.headline || tr('Intraday pace ready', '당일 페이스 준비됨');
    if (detailEl) detailEl.textContent = intraday.takeaway?.detail || tr('Today’s pacing story is ready.', '오늘 페이싱 스토리가 준비되었습니다.');
    if (confidenceEl) confidenceEl.textContent = intraday.confidence?.label || '—';
    if (confidenceDetailEl) confidenceDetailEl.textContent = intraday.confidence?.detail || '—';

    renderIntradayMetrics(metricsEl, intraday);
    renderIntradayHighlights(highlightsEl, intraday);
    renderIntradayChart(intraday);
  }

  function renderDailyContextSection(spendData, windowMeta) {
    const chart = ensureDailyContextChart();
    const statsEl = document.getElementById('liveDailyContextStats');
    const rows = filterDailyWindow(spendData || [], windowMeta);

    if (statsEl && rows.length === 0) {
      statsEl.innerHTML = `<div class="empty-state">${esc(tr('Daily context is not ready yet.', '일별 맥락이 아직 준비되지 않았습니다.'))}</div>`;
    }

    if (!chart || rows.length === 0) {
      return;
    }

    const labels = rows.map(row => {
      const dt = new Date(`${row.date}T00:00:00`);
      return dt.toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' });
    });
    const spendValues = rows.map(row => Number(row.spend || 0));
    const cacValues = rows.map(row => Number(row.cac || 0));
    chart.data.labels = labels;
    chart.data.datasets[0].data = spendValues;
    chart.data.datasets[1].data = cacValues;
    chart.update();

    if (statsEl) {
      const totalSpend = spendValues.reduce((sum, value) => sum + value, 0);
      const peakRow = rows.reduce((best, row) => (Number(row.spend || 0) > Number(best.spend || 0) ? row : best), rows[0]);
      const avgCac = cacValues.length > 0
        ? cacValues.reduce((sum, value) => sum + value, 0) / cacValues.length
        : 0;
      const orderTotal = rows.reduce((sum, row) => sum + Number(row.orders || 0), 0);
      statsEl.innerHTML = [
        {
          label: tr('Total spend', '총 지출'),
          value: formatCompactKrw(totalSpend),
          meta: tr(`${rows.length} days in view`, `표시 구간 ${rows.length}일`),
        },
        {
          label: tr('Average CAC', '평균 CAC'),
          value: formatCompactKrw(avgCac),
          meta: tr('Actual daily purchase counts when available', '가능할 때 실제 일별 구매 수 사용'),
        },
        {
          label: tr('Peak spend day', '최대 지출일'),
          value: new Date(`${peakRow.date}T00:00:00`).toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' }),
          meta: formatCompactKrw(Number(peakRow.spend || 0)),
        },
        {
          label: tr('Orders in view', '기간 주문수'),
          value: Number(orderTotal).toLocaleString(getLocale()),
          meta: tr('Use this as backdrop, not the live pacing read', '이건 배경 맥락이지 라이브 페이스 판단은 아닙니다'),
        },
      ].map(item => `
        <div class="live-daily-context-stat">
          <span>${esc(item.label)}</span>
          <strong>${esc(item.value)}</strong>
          <small>${esc(item.meta)}</small>
        </div>
      `).join('');
    }
  }

  function renderLiveKpis(campaignData, postmortem, optData, analyticsData, scansData) {
    const campaigns = campaignData?.campaigns || [];
    const activeCampaigns = campaigns.filter(campaign => campaign.status === 'ACTIVE');
    const fatigueAds = (postmortem?.active || []).filter(ad => ad.fatigue?.status !== 'healthy');
    const warningCount = fatigueAds.filter(ad => ad.fatigue?.status === 'warning').length;
    const dangerCount = fatigueAds.filter(ad => ad.fatigue?.status === 'danger').length;
    const latestScanId = scansData?.lastScan?.scanId ?? null;
    const executablePending = getPendingExecutableGroups(optData, latestScanId);
    const historicalPending = Number(optData?.stats?.pending || 0);
    const olderPending = Math.max(historicalPending - executablePending.length, 0);
    const burnRiskCampaigns = activeCampaigns.filter(campaign => {
      const metrics = campaign.metricsWindow || {};
      return Number(metrics.spend || 0) > 0 && getAttributedPurchases(metrics) === 0;
    });
    const burnRiskSpend = burnRiskCampaigns.reduce((sum, campaign) => sum + Number(campaign.metricsWindow?.spend || 0), 0);
    const pace = getPaceSnapshot(campaignData, analyticsData);
    const paceTone = pace.pacePct >= 100 ? 'negative' : pace.pacePct >= 65 ? 'neutral' : 'positive';

    updateLiveKpi(
      'activeCampaigns',
      activeCampaigns.length.toString(),
      tr(`${campaigns.length} campaigns tracked in this time frame`, `이 기간 추적 캠페인 ${campaigns.length.toLocaleString(getLocale())}개`),
      activeCampaigns.length > 0 ? 'positive' : 'neutral'
    );
    updateLiveKpi(
      'pendingApprovals',
      executablePending.length.toString(),
      olderPending > 0
        ? tr(
            `${executablePending.length} current from the latest scan · ${olderPending} older pending in AI Operations`,
            `최신 스캔 기준 ${executablePending.length.toLocaleString(getLocale())}건 · AI 운영에 이전 대기 ${olderPending.toLocaleString(getLocale())}건`
          )
        : tr(
            `${executablePending.length} current from the latest scan`,
            `최신 스캔 기준 ${executablePending.length.toLocaleString(getLocale())}건`
          ),
      executablePending.length > 0 ? 'warning' : 'positive'
    );
    updateLiveKpi(
      'fatigueAlerts',
      fatigueAds.length.toString(),
      tr(
        `${dangerCount} high risk · ${warningCount} watch closely`,
        `고위험 ${dangerCount.toLocaleString(getLocale())}건 · 주의 ${warningCount.toLocaleString(getLocale())}건`
      ),
      dangerCount > 0 ? 'negative' : fatigueAds.length > 0 ? 'warning' : 'positive'
    );
    updateLiveKpi(
      'spendPace',
      pace.totalDailyBudget > 0 ? `${formatUsd(pace.latestDailySpend, 0)} / ${formatUsd(pace.totalDailyBudget, 0)}` : '—',
      pace.totalDailyBudget > 0
        ? tr(`${pace.pacePct.toFixed(0)}% of today's active budget`, `오늘 활성 예산의 ${pace.pacePct.toFixed(0)}%`)
        : tr('No active budget configured', '활성 예산이 설정되지 않았습니다'),
      paceTone
    );
    updateLiveKpi(
      'burnRisk',
      burnRiskCampaigns.length.toString(),
      burnRiskCampaigns.length > 0
        ? tr(`${formatUsd(burnRiskSpend, 2)} spent without Meta-attributed purchases`, `메타 귀속 구매 없이 ${formatUsd(burnRiskSpend, 2)} 지출`)
        : tr('No active zero-attribution burn risk flagged', '귀속 없는 지출 위험이 감지되지 않았습니다'),
      burnRiskCampaigns.length > 0 ? 'negative' : 'positive'
    );
  }

  function renderActionQueue(container, optData, scansData) {
    if (!container) return;
    const latestScanId = scansData?.lastScan?.scanId ?? null;
    const optimizations = getPendingExecutableGroups(optData, latestScanId);
    const historicalPending = Number(optData?.stats?.pending || 0);
    const olderPending = Math.max(historicalPending - optimizations.length, 0);

    if (optimizations.length === 0) {
      container.innerHTML = `<div class="empty-state">${
        olderPending > 0
          ? tr(
              `No approval-required actions were produced in the most recent scan. ${olderPending} older pending suggestion${olderPending === 1 ? '' : 's'} remain in AI Operations.`,
              `최신 스캔에서 승인 필요한 조치가 생성되지 않았습니다. AI 운영에 이전 대기 제안 ${olderPending.toLocaleString(getLocale())}건이 남아 있습니다.`
            )
          : tr('No approval-required actions were produced in the most recent scan.', '최신 스캔에서 승인 필요한 조치가 생성되지 않았습니다.')
      }</div>`;
      return;
    }

    container.innerHTML = optimizations.slice(0, 6).map(opt => {
      const priority = priorityBadge(opt.priority);
      const repeatNote = opt.repeats > 1
        ? tr(`Repeated across ${opt.repeats} scans`, `${opt.repeats.toLocaleString(getLocale())}번 스캔에서 반복됨`)
        : tr('Single open recommendation', '현재 열린 단일 제안');

      return `
        <div class="live-queue-item">
          <div class="live-queue-icon ${esc(opt.type || 'budget')}">
            <i data-lucide="${ACTION_ICON[opt.type] || 'zap'}"></i>
          </div>
          <div class="live-queue-content">
            <div class="live-queue-top">
            <div class="live-queue-title">${esc(localizeOptimizationText(opt.action || '—'))}</div>
              <div class="live-queue-badges">
                <span class="badge badge-warning">${esc(tr('Awaiting review', '검토 대기'))}</span>
                <span class="badge ${priority.klass}">${esc(priority.label)}</span>
              </div>
            </div>
            <div class="live-queue-target">${esc(opt.targetName || tr('Account-wide', '계정 전체'))}</div>
            <div class="live-queue-detail">${esc(localizeOptimizationText(opt.reason || opt.impact || tr('No reason provided.', '사유가 제공되지 않았습니다.')))}</div>
            <div class="live-queue-meta">${esc(localizeOptimizationText(opt.impact || tr('No impact note provided.', '영향 메모가 없습니다.')))} · ${esc(repeatNote)} · ${opt.timestamp ? tr('Last seen ', '최근 확인 ') + timeSince(new Date(opt.timestamp)) : tr('Just now', '방금 전')}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  function buildSignalCards(campaignData, postmortem, overviewData, analyticsData) {
    const campaigns = campaignData?.campaigns || [];
    const activeCampaigns = campaigns.filter(campaign => campaign.status === 'ACTIVE');
    const pace = getPaceSnapshot(campaignData, analyticsData);
    const bestScaleCandidate = activeCampaigns
      .filter(campaign => getAttributedPurchases(campaign.metricsWindow) > 0)
      .sort((left, right) => {
        const purchaseGap = getAttributedPurchases(right.metricsWindow) - getAttributedPurchases(left.metricsWindow);
        if (purchaseGap !== 0) return purchaseGap;
        return Number(left.metricsWindow?.cpa || Infinity) - Number(right.metricsWindow?.cpa || Infinity);
      })[0] || null;
    const burnRiskCampaign = activeCampaigns
      .filter(campaign => Number(campaign.metricsWindow?.spend || 0) > 0 && getAttributedPurchases(campaign.metricsWindow) === 0)
      .sort((left, right) => Number(right.metricsWindow?.spend || 0) - Number(left.metricsWindow?.spend || 0))[0] || null;
    const fatigueRisk = (postmortem?.active || [])
      .slice()
      .sort((left, right) => {
        const statusGap = fatigueWeight(right.fatigue?.status) - fatigueWeight(left.fatigue?.status);
        if (statusGap !== 0) return statusGap;
        return Number(right.spend || 0) - Number(left.spend || 0);
      })[0] || null;

    const sourceHealth = overviewData?.dataSources || {};
    const sourceEntries = Object.entries(sourceHealth);
    const staleSources = sourceEntries.filter(([, source]) => source?.stale).length;
    const errorSources = sourceEntries.filter(([, source]) => source?.status === 'error').length;
    const healthySources = sourceEntries.filter(([, source]) => source?.status === 'ok' || source?.status === 'connected').length;

    const cards = [
      {
        tone: pace.totalDailyBudget > 0 && pace.pacePct >= 100 ? 'negative' : pace.totalDailyBudget > 0 && pace.pacePct >= 65 ? 'warning' : 'positive',
        label: tr('Budget pace', '예산 속도'),
        title: pace.totalDailyBudget > 0 ? tr(`${pace.pacePct.toFixed(0)}% of budget consumed`, `예산의 ${pace.pacePct.toFixed(0)}% 사용`) : tr('No active budget pool', '활성 예산 풀이 없습니다'),
        detail: pace.totalDailyBudget > 0
          ? tr(`${formatUsd(pace.latestDailySpend, 2)} spent against ${formatUsd(pace.totalDailyBudget, 2)} today`, `오늘 ${formatUsd(pace.totalDailyBudget, 2)} 중 ${formatUsd(pace.latestDailySpend, 2)} 지출`)
          : tr('Set active campaign budgets before relying on pacing.', '페이싱을 보기 전에 활성 캠페인 예산을 설정하세요.')
      },
      {
        tone: bestScaleCandidate ? 'positive' : 'neutral',
        label: tr('Best scale candidate', '확장 후보'),
        title: bestScaleCandidate ? bestScaleCandidate.name : tr('No scale candidate right now', '현재 확장 후보 없음'),
        detail: bestScaleCandidate
          ? tr(`${getAttributedPurchases(bestScaleCandidate.metricsWindow)} Meta-attributed purchases · ${formatUsd(bestScaleCandidate.metricsWindow.cpa || 0, 2)} CPA`, `메타 귀속 구매 ${getAttributedPurchases(bestScaleCandidate.metricsWindow).toLocaleString(getLocale())}건 · CPA ${formatUsd(bestScaleCandidate.metricsWindow.cpa || 0, 2)}`)
          : tr('No active campaign has recent attributed purchase volume in this time frame.', '이 기간에 최근 귀속 구매가 있는 활성 캠페인이 없습니다.')
      },
      {
        tone: burnRiskCampaign ? 'negative' : 'positive',
        label: tr('Cash burn risk', '현금 소진 위험'),
        title: burnRiskCampaign ? burnRiskCampaign.name : tr('No active burn risk flagged', '활성 소진 위험 없음'),
        detail: burnRiskCampaign
          ? tr(`${formatUsd(burnRiskCampaign.metricsWindow.spend || 0, 2)} spent with 0 Meta-attributed purchases`, `메타 귀속 구매 0건으로 ${formatUsd(burnRiskCampaign.metricsWindow.spend || 0, 2)} 지출`)
          : tr('No active campaign is spending without attributed purchases.', '귀속 구매 없이 지출 중인 활성 캠페인이 없습니다.')
      },
      {
        tone: fatigueRisk && fatigueRisk.fatigue?.status === 'danger' ? 'negative' : fatigueRisk && fatigueRisk.fatigue?.status === 'warning' ? 'warning' : 'positive',
        label: tr('Creative pressure', '크리에이티브 압박'),
        title: fatigueRisk ? fatigueRisk.name : tr('Creatives look stable', '크리에이티브 안정적'),
        detail: fatigueRisk
          ? localizeCreativeText(fatigueRisk.fatigue?.summary || `Frequency ${Number(fatigueRisk.lastFrequency || 0).toFixed(1)} · CTR ${Number(fatigueRisk.lastCTR || fatigueRisk.avgCTR || 0).toFixed(2)}%`)
          : tr('No active ad currently shows fatigue pressure.', '현재 피로 압박이 감지된 활성 광고가 없습니다.')
      },
      {
        tone: errorSources > 0 ? 'negative' : staleSources > 0 ? 'warning' : 'positive',
        label: tr('Source health', '소스 상태'),
        title: errorSources > 0 ? tr(`${errorSources} source error${errorSources !== 1 ? 's' : ''}`, `소스 오류 ${errorSources.toLocaleString(getLocale())}건`) : staleSources > 0 ? tr(`${staleSources} cached source${staleSources !== 1 ? 's' : ''}`, `캐시 소스 ${staleSources.toLocaleString(getLocale())}건`) : tr(`${healthySources} sources healthy`, `정상 소스 ${healthySources.toLocaleString(getLocale())}건`),
        detail: overviewData?.lastScan
          ? tr(`Last scan ${timeSince(new Date(overviewData.lastScan))} · Meta, Imweb, and COGS are being monitored`, `최근 스캔 ${timeSince(new Date(overviewData.lastScan))} · Meta, Imweb, COGS 모니터링 중`)
          : tr('Waiting for the next scan to refresh source health.', '다음 스캔 후 소스 상태가 갱신됩니다.')
      },
    ];

    return cards;
  }

  function renderOperatorSignals(container, campaignData, postmortem, overviewData, analyticsData) {
    if (!container) return;
    const signals = buildSignalCards(campaignData, postmortem, overviewData, analyticsData);
    container.innerHTML = signals.map(signal => `
      <article class="operator-signal-card ${signal.tone}">
        <div class="operator-signal-label">${esc(signal.label)}</div>
        <div class="operator-signal-title">${esc(signal.title)}</div>
        <div class="operator-signal-detail">${esc(signal.detail)}</div>
      </article>
    `).join('');
  }

  function renderCampaignTable(body, campaigns) {
    if (!body) return;
    const sorted = campaigns.slice().sort((left, right) => Number(right.metricsWindow?.spend || 0) - Number(left.metricsWindow?.spend || 0));

    body.innerHTML = sorted.map(campaign => {
      const metrics = campaign.metricsWindow || {};
      const status = campaign.status === 'ACTIVE' || campaign.status === 'PAUSED' ? campaign.status : 'UNKNOWN';
      const statusClass = status === 'ACTIVE' ? 'badge-success' : status === 'PAUSED' ? 'badge-warning' : 'badge-neutral';
      const statusLabel = status === 'ACTIVE' ? tr('ACTIVE', '집행중') : status === 'PAUSED' ? tr('PAUSED', '중지') : tr('UNKNOWN', '알 수 없음');
      const budget = campaign.dailyBudget ? formatUsd(parseInt(campaign.dailyBudget, 10) / 100, 2) : '-';
      const actionButton = status === 'ACTIVE'
        ? `<button class="btn btn-sm btn-ghost campaign-action" data-id="${esc(campaign.id)}" data-action="PAUSED">${esc(tr('Pause', '중지'))}</button>`
        : status === 'PAUSED'
        ? `<button class="btn btn-sm btn-primary campaign-action" data-id="${esc(campaign.id)}" data-action="ACTIVE">${esc(tr('Resume', '재개'))}</button>`
        : '—';

      return `
        <tr>
          <td style="font-weight:600">${esc(campaign.name)}</td>
          <td><span class="badge ${statusClass}">${esc(statusLabel)}</span></td>
          <td>${budget}${tr('/day', '/일')}</td>
          <td>${formatUsd(metrics.spend || 0, 2)}</td>
          <td>${getAttributedPurchases(metrics).toLocaleString(getLocale())}</td>
          <td>${metrics.cpa ? formatUsd(metrics.cpa, 2) : '-'}</td>
          <td>${metrics.ctr ? metrics.ctr.toFixed(2) + '%' : '-'}</td>
          <td>${actionButton}</td>
        </tr>
      `;
    }).join('');

    body.querySelectorAll('.campaign-action').forEach(button => {
      button.addEventListener('click', async event => {
        const id = event.target.dataset.id;
        const action = event.target.dataset.action;
        event.target.textContent = tr('Sending approval...', '승인 요청 중...');
        event.target.disabled = true;
        const result = await updateCampaignStatus(id, action);
        if (result && result.pending) {
          event.target.textContent = tr('⏳ Check Telegram', '⏳ 텔레그램 확인');
          event.target.title = tr('Approval request sent to Telegram. Please approve or reject there.', '승인 요청이 텔레그램으로 전송되었습니다. 텔레그램에서 승인 또는 거절하세요.');
          setTimeout(() => refreshCampaignsPage(), 15000);
          setTimeout(() => refreshCampaignsPage(), 60000);
        } else if (result && result.success) {
          event.target.textContent = action === 'PAUSED' ? tr('Paused', '중지됨') : tr('Resumed', '재개됨');
          setTimeout(() => refreshCampaignsPage(), 1000);
        } else {
          event.target.textContent = tr('Error', '오류');
        }
      });
    });
  }

  function renderActiveAds(container, countEl, postmortem, windowLabel) {
    if (!container) return;
    const active = (postmortem?.active || []).slice().sort((left, right) => Number(right.spend || 0) - Number(left.spend || 0));
    if (countEl) countEl.textContent = tr(
      `${Math.min(active.length, 4)} shown · ${active.length} active ads · ${windowLabel}`,
      `${Math.min(active.length, 4).toLocaleString(getLocale())}개 표시 · 활성 광고 ${active.length.toLocaleString(getLocale())}개 · ${windowLabel}`
    );

    if (active.length === 0) {
      container.innerHTML = `<div class="empty-state">${esc(tr('No active ads right now.', '현재 활성 광고가 없습니다.'))}</div>`;
      return;
    }

    container.innerHTML = `
      <div class="live-ads-grid">
        ${active.slice(0, 4).map(ad => {
          const cpaStr = ad.cpa ? formatUsd(ad.cpa, 2) : tr('N/A', '없음');
          const cpaColor = ad.cpa && ad.cpa < 15 ? '#4ade80' : ad.cpa && ad.cpa < 25 ? '#facc15' : '#f87171';
          const fatigueStatus = String(ad.fatigue?.status || 'healthy');
          const fatigueBadge = fatigueStatus === 'danger'
            ? `<span class="badge badge-error">${esc(tr('Rotate now', '지금 교체'))}</span>`
            : fatigueStatus === 'warning'
            ? `<span class="badge badge-warning">${esc(tr('Watch fatigue', '피로 주시'))}</span>`
            : `<span class="badge badge-success">${esc(tr('Healthy', '정상'))}</span>`;
          return `
            <div class="live-ad-card">
              <div class="live-ad-card-head">
                <div>
                  <div class="live-ad-card-title">${esc(ad.name)}</div>
                  <div class="live-ad-card-meta">${esc(ad.campaignName)} · ${tr(`${ad.daysOfData} days of data`, `${ad.daysOfData}일 데이터`)}</div>
                </div>
                <div class="live-ad-card-badges">
                  <span class="badge badge-success">${esc(tr('LIVE', '집행중'))}</span>
                  ${fatigueBadge}
                </div>
              </div>
              <div class="live-ad-metrics">
                <div><span>${esc(tr('Spend', '지출'))}</span><strong>${formatUsd(ad.spend || 0, 2)}</strong></div>
                <div><span>${esc(tr('Meta-attributed purchases', '메타 귀속 구매'))}</span><strong>${getAttributedPurchases(ad).toLocaleString(getLocale())}</strong></div>
                <div><span>CPA</span><strong style="color:${cpaColor}">${cpaStr}</strong></div>
                <div><span>CTR</span><strong>${Number(ad.avgCTR || 0).toFixed(2)}%</strong></div>
              </div>
              <div class="live-ad-note">${esc(localizeCreativeText(ad.fatigue?.summary || tr('Use Creative Health for fatigue diagnosis and rotation decisions.', '피로 진단과 교체 판단은 크리에이티브 상태 탭에서 확인하세요.')))}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  async function refreshCampaignsPage() {
    const windowMeta = getSeriesWindowMeta('campaigns');
    const [campaignData, livePerformance, postmortem, optData, analyticsData, overviewData, scansData, spendDaily] = await Promise.all([
      fetchCampaigns(windowMeta.key),
      fetchLivePerformance(),
      fetchPostmortem(windowMeta.key),
      fetchOptimizations(12),
      fetchAnalytics(),
      fetchOverview(),
      fetchScans(),
      fetchSpendDaily(),
    ]);

    if (!campaignData || !postmortem) return;

    const windowLabel = (campaignData?.windowDays || postmortem?.windowDays)
      ? tr(`Last ${campaignData?.windowDays || postmortem?.windowDays} days`, `최근 ${campaignData?.windowDays || postmortem?.windowDays}일`)
      : tr('All available data', '사용 가능한 전체 데이터');
    const windowNoteEl = document.getElementById('campaignWindowNote');
    if (windowNoteEl) {
      windowNoteEl.textContent = tr(
        `${windowLabel} · active delivery, pacing, fatigue, and approvals in one place.`,
        `${windowLabel} · 집행, 페이싱, 피로도, 승인 현황을 한 곳에서 확인`
      );
    }

    renderLiveKpis(campaignData, postmortem, optData, analyticsData, scansData);
    renderIntradaySection(livePerformance);
    renderDailyContextSection(spendDaily || [], windowMeta);
    renderActionQueue(document.getElementById('liveActionQueue'), optData, scansData);
    renderOperatorSignals(document.getElementById('operatorSignalGrid'), campaignData, postmortem, overviewData, analyticsData);
    renderActiveAds(document.getElementById('activeAdsContainer'), document.getElementById('activeCount'), postmortem, windowLabel);
    renderCampaignTable(document.getElementById('campaignBody'), campaignData.campaigns || []);

    bindNavShortcuts(document.querySelector('.page[data-page="campaigns"]'));

    if (window.lucide) {
      const page = document.querySelector('.page[data-page="campaigns"]');
      lucide.createIcons({ nodes: page ? [page] : undefined });
    }
  }

  live.registerPage('campaigns', {
    init() {
      bindNavShortcuts(document.querySelector('.page[data-page="campaigns"]'));
    },
    refresh: refreshCampaignsPage,
  });
})();
