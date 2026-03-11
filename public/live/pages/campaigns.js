(function () {
  const live = window.AdPilotLive;
  const { esc, formatUsd, timeSince } = live.shared;
  const { fetchCampaigns, fetchPostmortem, fetchOptimizations, fetchAnalytics, fetchOverview, fetchScans, updateCampaignStatus } = live.api;
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
    return { label: normalized.charAt(0).toUpperCase() + normalized.slice(1), klass };
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
      `${campaigns.length} campaigns tracked in this window`,
      activeCampaigns.length > 0 ? 'positive' : 'neutral'
    );
    updateLiveKpi(
      'pendingApprovals',
      executablePending.length.toString(),
      olderPending > 0
        ? `${executablePending.length} current from the latest scan · ${olderPending} older pending in Action Queue`
        : `${executablePending.length} current from the latest scan`,
      executablePending.length > 0 ? 'warning' : 'positive'
    );
    updateLiveKpi(
      'fatigueAlerts',
      fatigueAds.length.toString(),
      `${dangerCount} high risk · ${warningCount} watch closely`,
      dangerCount > 0 ? 'negative' : fatigueAds.length > 0 ? 'warning' : 'positive'
    );
    updateLiveKpi(
      'spendPace',
      pace.totalDailyBudget > 0 ? `${formatUsd(pace.latestDailySpend, 0)} / ${formatUsd(pace.totalDailyBudget, 0)}` : '—',
      pace.totalDailyBudget > 0 ? `${pace.pacePct.toFixed(0)}% of today's active budget` : 'No active budget configured',
      paceTone
    );
    updateLiveKpi(
      'burnRisk',
      burnRiskCampaigns.length.toString(),
      burnRiskCampaigns.length > 0 ? `${formatUsd(burnRiskSpend, 2)} spent without Meta-attributed purchases` : 'No active zero-attribution burn risk flagged',
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
          ? `No approval-required actions were produced in the most recent scan. ${olderPending} older pending suggestion${olderPending === 1 ? '' : 's'} remain in Action Queue.`
          : 'No approval-required actions were produced in the most recent scan.'
      }</div>`;
      return;
    }

    container.innerHTML = optimizations.slice(0, 6).map(opt => {
      const priority = priorityBadge(opt.priority);
      const repeatNote = opt.repeats > 1
        ? `Repeated across ${opt.repeats} scans`
        : 'Single open recommendation';

      return `
        <div class="live-queue-item">
          <div class="live-queue-icon ${esc(opt.type || 'budget')}">
            <i data-lucide="${ACTION_ICON[opt.type] || 'zap'}"></i>
          </div>
          <div class="live-queue-content">
            <div class="live-queue-top">
              <div class="live-queue-title">${esc(opt.action || '—')}</div>
              <div class="live-queue-badges">
                <span class="badge badge-warning">Awaiting review</span>
                <span class="badge ${priority.klass}">${esc(priority.label)}</span>
              </div>
            </div>
            <div class="live-queue-target">${esc(opt.targetName || 'Account-wide')}</div>
            <div class="live-queue-detail">${esc(opt.reason || opt.impact || 'No reason provided.')}</div>
            <div class="live-queue-meta">${esc(opt.impact || 'No impact note provided.')} · ${esc(repeatNote)} · ${opt.timestamp ? 'Last seen ' + timeSince(new Date(opt.timestamp)) : 'Just now'}</div>
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
        label: 'Budget pace',
        title: pace.totalDailyBudget > 0 ? `${pace.pacePct.toFixed(0)}% of budget consumed` : 'No active budget pool',
        detail: pace.totalDailyBudget > 0
          ? `${formatUsd(pace.latestDailySpend, 2)} spent against ${formatUsd(pace.totalDailyBudget, 2)} today`
          : 'Set active campaign budgets before relying on pacing.'
      },
      {
        tone: bestScaleCandidate ? 'positive' : 'neutral',
        label: 'Best scale candidate',
        title: bestScaleCandidate ? bestScaleCandidate.name : 'No scale candidate right now',
        detail: bestScaleCandidate
          ? `${getAttributedPurchases(bestScaleCandidate.metricsWindow)} Meta-attributed purchases · ${formatUsd(bestScaleCandidate.metricsWindow.cpa || 0, 2)} CPA`
          : 'No active campaign has recent attributed purchase volume in this window.'
      },
      {
        tone: burnRiskCampaign ? 'negative' : 'positive',
        label: 'Cash burn risk',
        title: burnRiskCampaign ? burnRiskCampaign.name : 'No active burn risk flagged',
        detail: burnRiskCampaign
          ? `${formatUsd(burnRiskCampaign.metricsWindow.spend || 0, 2)} spent with 0 Meta-attributed purchases`
          : 'No active campaign is spending without attributed purchases.'
      },
      {
        tone: fatigueRisk && fatigueRisk.fatigue?.status === 'danger' ? 'negative' : fatigueRisk && fatigueRisk.fatigue?.status === 'warning' ? 'warning' : 'positive',
        label: 'Creative pressure',
        title: fatigueRisk ? fatigueRisk.name : 'Creatives look stable',
        detail: fatigueRisk
          ? (fatigueRisk.fatigue?.summary || `Frequency ${Number(fatigueRisk.lastFrequency || 0).toFixed(1)} · CTR ${Number(fatigueRisk.lastCTR || fatigueRisk.avgCTR || 0).toFixed(2)}%`)
          : 'No active ad currently shows fatigue pressure.'
      },
      {
        tone: errorSources > 0 ? 'negative' : staleSources > 0 ? 'warning' : 'positive',
        label: 'Source health',
        title: errorSources > 0 ? `${errorSources} source error${errorSources !== 1 ? 's' : ''}` : staleSources > 0 ? `${staleSources} cached source${staleSources !== 1 ? 's' : ''}` : `${healthySources} sources healthy`,
        detail: overviewData?.lastScan
          ? `Last scan ${timeSince(new Date(overviewData.lastScan))} · Meta, Imweb, and COGS are being monitored`
          : 'Waiting for the next scan to refresh source health.'
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
      const budget = campaign.dailyBudget ? formatUsd(parseInt(campaign.dailyBudget, 10) / 100, 2) : '-';
      const actionButton = status === 'ACTIVE'
        ? `<button class="btn btn-sm btn-ghost campaign-action" data-id="${esc(campaign.id)}" data-action="PAUSED">Pause</button>`
        : status === 'PAUSED'
        ? `<button class="btn btn-sm btn-primary campaign-action" data-id="${esc(campaign.id)}" data-action="ACTIVE">Resume</button>`
        : '—';

      return `
        <tr>
          <td style="font-weight:600">${esc(campaign.name)}</td>
          <td><span class="badge ${statusClass}">${esc(status)}</span></td>
          <td>${budget}/day</td>
          <td>${formatUsd(metrics.spend || 0, 2)}</td>
          <td>${getAttributedPurchases(metrics).toLocaleString()}</td>
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
        event.target.textContent = 'Sending approval...';
        event.target.disabled = true;
        const result = await updateCampaignStatus(id, action);
        if (result && result.pending) {
          event.target.textContent = '⏳ Check Telegram';
          event.target.title = 'Approval request sent to Telegram. Please approve or reject there.';
          setTimeout(() => refreshCampaignsPage(), 15000);
          setTimeout(() => refreshCampaignsPage(), 60000);
        } else if (result && result.success) {
          event.target.textContent = action === 'PAUSED' ? 'Paused' : 'Resumed';
          setTimeout(() => refreshCampaignsPage(), 1000);
        } else {
          event.target.textContent = 'Error';
        }
      });
    });
  }

  function renderActiveAds(container, countEl, postmortem, windowLabel) {
    if (!container) return;
    const active = (postmortem?.active || []).slice().sort((left, right) => Number(right.spend || 0) - Number(left.spend || 0));
    if (countEl) countEl.textContent = `${Math.min(active.length, 4)} shown · ${active.length} active ads · ${windowLabel}`;

    if (active.length === 0) {
      container.innerHTML = '<div class="empty-state">No active ads right now.</div>';
      return;
    }

    container.innerHTML = `
      <div class="live-ads-grid">
        ${active.slice(0, 4).map(ad => {
          const cpaStr = ad.cpa ? formatUsd(ad.cpa, 2) : 'N/A';
          const cpaColor = ad.cpa && ad.cpa < 15 ? '#4ade80' : ad.cpa && ad.cpa < 25 ? '#facc15' : '#f87171';
          const fatigueStatus = String(ad.fatigue?.status || 'healthy');
          const fatigueBadge = fatigueStatus === 'danger'
            ? '<span class="badge badge-error">Rotate now</span>'
            : fatigueStatus === 'warning'
            ? '<span class="badge badge-warning">Watch fatigue</span>'
            : '<span class="badge badge-success">Healthy</span>';
          return `
            <div class="live-ad-card">
              <div class="live-ad-card-head">
                <div>
                  <div class="live-ad-card-title">${esc(ad.name)}</div>
                  <div class="live-ad-card-meta">${esc(ad.campaignName)} · ${ad.daysOfData} days of data</div>
                </div>
                <div class="live-ad-card-badges">
                  <span class="badge badge-success">LIVE</span>
                  ${fatigueBadge}
                </div>
              </div>
              <div class="live-ad-metrics">
                <div><span>Spend</span><strong>${formatUsd(ad.spend || 0, 2)}</strong></div>
                <div><span>Meta-attributed purchases</span><strong>${getAttributedPurchases(ad).toLocaleString()}</strong></div>
                <div><span>CPA</span><strong style="color:${cpaColor}">${cpaStr}</strong></div>
                <div><span>CTR</span><strong>${Number(ad.avgCTR || 0).toFixed(2)}%</strong></div>
              </div>
              <div class="live-ad-note">${esc(ad.fatigue?.summary || 'Use Creative Health for fatigue diagnosis and rotation decisions.')}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  async function refreshCampaignsPage() {
    const windowMeta = getSeriesWindowMeta('campaigns');
    const [campaignData, postmortem, optData, analyticsData, overviewData, scansData] = await Promise.all([
      fetchCampaigns(windowMeta.key),
      fetchPostmortem(windowMeta.key),
      fetchOptimizations(12),
      fetchAnalytics(),
      fetchOverview(),
      fetchScans(),
    ]);

    if (!campaignData || !postmortem) return;

    const windowLabel = (campaignData?.windowDays || postmortem?.windowDays)
      ? `Last ${campaignData?.windowDays || postmortem?.windowDays} days`
      : 'All available data';
    const windowNoteEl = document.getElementById('campaignWindowNote');
    if (windowNoteEl) {
      windowNoteEl.textContent = `${windowLabel} · active delivery, pacing, fatigue, and approvals in one place.`;
    }

    renderLiveKpis(campaignData, postmortem, optData, analyticsData, scansData);
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
