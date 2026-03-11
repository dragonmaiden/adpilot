(function () {
  const live = window.AdPilotLive;
  const { esc, formatUsd, timeSince, tr, getLocale, localizeOptimizationText, localizeCreativeText } = live.shared;
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
      tr(`${campaigns.length} campaigns tracked in this window`, `이 기간 추적 캠페인 ${campaigns.length.toLocaleString(getLocale())}개`),
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
          : tr('No active campaign has recent attributed purchase volume in this window.', '이 기간에 최근 귀속 구매가 있는 활성 캠페인이 없습니다.')
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
