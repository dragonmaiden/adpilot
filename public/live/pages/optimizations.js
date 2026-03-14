(function () {
  const live = window.AdPilotLive;
  const {
    esc,
    safeOptType,
    timeSince,
    formatKrw,
    formatCount,
    tr,
    getLocale,
    localizeOptimizationText,
  } = live.shared;
  const {
    fetchAiOperations,
    fetchOptimizations,
    fetchPolicyLab,
    fetchPolicyLabExperiments,
    fetchPolicyLabTraces,
    fetchPolicyLabOutcomes,
    fetchPolicyLabObservability,
    fetchSpendDaily,
    executeOptimization,
  } = live.api;

  const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
  const ICON_MAP = {
    budget: 'wallet',
    bid: 'gavel',
    creative: 'image',
    status: 'power',
    schedule: 'clock',
    targeting: 'target',
  };
  const EVENT_ICON_MAP = {
    needs_approval: 'sparkles',
    awaiting_telegram: 'send',
    executed: 'check-check',
    expired: 'clock-3',
    rejected: 'x-circle',
    advisory: 'radar',
    challenger: 'beaker',
    promoted: 'rocket',
    warning: 'triangle-alert',
    error: 'octagon-alert',
    info: 'radar',
  };

  function renderCandlestickStats(data) {
    const el = document.getElementById('candlestickStats');
    if (!el || !data.length) return;

    const totalSpend = data.reduce((sum, row) => sum + row.spend, 0);
    const peakDay = data.reduce((max, row) => row.spend > max.spend ? row : max, data[0]);
    const avgDaily = totalSpend / data.length;
    const avgCac = data.reduce((sum, row) => sum + row.cac, 0) / data.length;
    const peakDate = new Date(peakDay.date).toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' });

    const values = el.querySelectorAll('strong');
    if (values.length >= 6) {
      values[0].textContent = formatKrw(totalSpend);
      values[1].textContent = formatKrw(peakDay.spend);
      values[2].textContent = formatKrw(Math.round(avgDaily));
      values[3].textContent = data.length.toString();
      values[4].textContent = formatKrw(Math.round(avgCac));
      values[5].textContent = peakDate;
    }
  }

  function getTypeFilter() {
    return document.getElementById('optTypeFilter')?.value || 'all';
  }

  function getStatusFilter() {
    return document.getElementById('optStatusFilter')?.value || 'all';
  }

  function priorityMeta(priority) {
    const normalized = String(priority || 'low').toLowerCase();
    return {
      label: {
        critical: tr('Critical', '치명적'),
        high: tr('High', '높음'),
        medium: tr('Medium', '보통'),
        low: tr('Low', '낮음'),
      }[normalized] || tr('Low', '낮음'),
      className: {
        critical: 'badge-danger',
        high: 'badge-warning',
        medium: 'badge-info',
        low: 'badge-neutral',
      }[normalized] || 'badge-neutral',
      rank: PRIORITY_RANK[normalized] ?? PRIORITY_RANK.low,
    };
  }

  function statusMeta(status) {
    switch (status) {
      case 'needs_approval':
        return { label: tr('Open', '열림'), className: 'badge-warning' };
      case 'awaiting_telegram':
        return { label: tr('Awaiting Telegram', '텔레그램 대기'), className: 'badge-info' };
      case 'executed':
        return { label: tr('Executed', '실행됨'), className: 'badge-success' };
      case 'rejected':
        return { label: tr('Rejected', '거절됨'), className: 'badge-danger' };
      case 'expired':
        return { label: tr('Expired', '만료됨'), className: 'badge-neutral' };
      case 'advisory':
      default:
        return { label: tr('Advisory', '참고용'), className: 'badge-neutral' };
    }
  }

  function qualityMeta(level) {
    switch (String(level || '').toLowerCase()) {
      case 'high':
        return { label: tr('Healthy', '양호'), className: 'badge-success' };
      case 'medium':
        return { label: tr('Mixed quality', '혼합'), className: 'badge-warning' };
      case 'low':
      default:
        return { label: tr('Needs tuning', '조정 필요'), className: 'badge-danger' };
    }
  }

  function eventVisual(kind) {
    const normalized = String(kind || 'advisory').toLowerCase();
    return {
      icon: EVENT_ICON_MAP[normalized] || 'radar',
      dotClass: normalized,
    };
  }

  function syncSelectOptions(select, values, allLabel) {
    if (!select) return;
    const currentValue = select.value || 'all';
    const options = ['all', ...(Array.isArray(values) ? values : []).filter(Boolean)];
    select.innerHTML = options.map(value => `
      <option value="${esc(value)}">${esc(value === 'all' ? allLabel : value)}</option>
    `).join('');
    select.value = options.includes(currentValue) ? currentValue : 'all';
  }

  function controlSurfaceLabel(value) {
    switch (value) {
      case 'campaign_budget_controlled':
        return tr('Campaign budget', '캠페인 예산');
      case 'adset_budget_controlled':
        return tr('Ad set budget', '광고세트 예산');
      case 'mixed_or_unsupported':
      default:
        return tr('Mixed / unsupported', '혼합 / 미지원');
    }
  }

  function verdictMeta(verdict) {
    switch (String(verdict || '').toLowerCase()) {
      case 'scale':
        return { label: tr('Scale', '증액'), className: 'badge-success' };
      case 'reduce':
        return { label: tr('Reduce', '감액'), className: 'badge-warning' };
      case 'hold':
        return { label: tr('Hold', '유지'), className: 'badge-info' };
      case 'suppress':
      default:
        return { label: tr('Suppress', '보류'), className: 'badge-neutral' };
    }
  }

  function levelMeta(level) {
    switch (String(level || '').toLowerCase()) {
      case 'error':
        return { label: tr('Error', '오류'), className: 'badge-danger' };
      case 'warning':
        return { label: tr('Warning', '경고'), className: 'badge-warning' };
      case 'info':
      default:
        return { label: tr('Info', '정보'), className: 'badge-info' };
    }
  }

  function buildMergedMarkers(aiOps, policyLab) {
    const markers = [...(aiOps?.decisionMarkers || []), ...(policyLab?.strategyMarkers || [])];
    const byDate = new Map();

    markers.forEach(marker => {
      if (!marker?.date) return;
      const existing = byDate.get(marker.date);
      if (!existing) {
        byDate.set(marker.date, { ...marker });
        return;
      }

      existing.count = (existing.count || 1) + (marker.count || 1);
      existing.title = existing.title === marker.title ? existing.title : `${existing.title} + ${marker.title}`;
      existing.detail = [existing.detail, marker.detail].filter(Boolean).join(' · ');
      if (['promoted', 'executed', 'error', 'expired', 'rejected'].includes(marker.kind)) {
        existing.kind = marker.kind;
      }
    });

    return Array.from(byDate.values()).sort((left, right) => String(left.date).localeCompare(String(right.date)));
  }

  function compareClusters(left, right) {
    const leftPriority = priorityMeta(left.priority).rank;
    const rightPriority = priorityMeta(right.priority).rank;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    if (!!left.stale !== !!right.stale) return left.stale ? -1 : 1;
    if ((right.count || 0) !== (left.count || 0)) return (right.count || 0) - (left.count || 0);
    return String(right.lastSeenAt || '').localeCompare(String(left.lastSeenAt || ''));
  }

  function matchClusterStatus(cluster, statusFilter) {
    switch (statusFilter) {
      case 'open':
        return !!cluster.hasOpenApprovals;
      case 'awaiting_telegram':
        return cluster.currentStatus === 'awaiting_telegram' || (cluster.statusCounts?.awaiting_telegram || 0) > 0;
      case 'advisory':
        return cluster.currentStatus === 'advisory' && !cluster.hasOpenApprovals;
      case 'executed':
        return cluster.currentStatus === 'executed';
      case 'resolved':
        return ['expired', 'rejected'].includes(cluster.currentStatus) || (cluster.statusCounts?.expired || 0) > 0 || (cluster.statusCounts?.rejected || 0) > 0;
      case 'all':
      default:
        return true;
    }
  }

  function filterClusters(clusters) {
    const typeFilter = getTypeFilter();
    const statusFilter = getStatusFilter();

    return (Array.isArray(clusters) ? clusters : [])
      .filter(cluster => typeFilter === 'all' || cluster.type === typeFilter)
      .filter(cluster => matchClusterStatus(cluster, statusFilter))
      .slice()
      .sort(compareClusters);
  }

  function filterRawHistory(optimizations) {
    const typeFilter = getTypeFilter();
    const statusFilter = getStatusFilter();

    return (Array.isArray(optimizations) ? optimizations : [])
      .filter(opt => typeFilter === 'all' || opt.type === typeFilter)
      .filter(opt => {
        switch (statusFilter) {
          case 'open':
            return opt.status === 'needs_approval';
          case 'awaiting_telegram':
            return opt.status === 'awaiting_telegram';
          case 'advisory':
            return opt.status === 'advisory';
          case 'executed':
            return opt.status === 'executed';
          case 'resolved':
            return opt.status === 'rejected' || opt.status === 'expired';
          case 'all':
          default:
            return true;
        }
      });
  }

  function formatRelative(value) {
    const timestamp = value ? new Date(value) : null;
    if (!timestamp || Number.isNaN(timestamp.getTime())) {
      return tr('Timestamp unavailable', '시간 정보 없음');
    }
    return timeSince(timestamp);
  }

  function buildClusterStatusLine(cluster) {
    const parts = [];
    const counts = cluster.statusCounts || {};

    if (counts.needs_approval) parts.push(tr(`${formatCount(counts.needs_approval)} open`, `${formatCount(counts.needs_approval)}건 열림`));
    if (counts.awaiting_telegram) parts.push(tr(`${formatCount(counts.awaiting_telegram)} awaiting`, `${formatCount(counts.awaiting_telegram)}건 대기`));
    if (counts.expired) parts.push(tr(`${formatCount(counts.expired)} expired`, `${formatCount(counts.expired)}건 만료`));
    if (counts.rejected) parts.push(tr(`${formatCount(counts.rejected)} rejected`, `${formatCount(counts.rejected)}건 거절`));
    if (counts.executed) parts.push(tr(`${formatCount(counts.executed)} executed`, `${formatCount(counts.executed)}건 실행`));
    if (counts.advisory && !cluster.hasOpenApprovals) parts.push(tr(`${formatCount(counts.advisory)} advisory`, `${formatCount(counts.advisory)}건 참고용`));

    return parts.join(' · ');
  }

  function buildClusterMeta(cluster) {
    const items = [];

    items.push(`<span class="opt-cluster-stat"><strong>${esc(formatCount(cluster.count || 0))}</strong>${esc(tr('rows', '행'))}</span>`);
    if (cluster.recentCount > 0) {
      items.push(`<span class="opt-cluster-stat"><strong>${esc(formatCount(cluster.recentCount || 0))}</strong>${esc(tr(`in ${cluster.windowHours || 72}h`, `${cluster.windowHours || 72}시간`))}</span>`);
    }
    if (cluster.hasOpenApprovals) {
      items.push(`<span class="opt-cluster-stat"><strong>${esc(formatCount(cluster.openCount || 0))}</strong>${esc(tr('open', '열림'))}</span>`);
    }
    if (cluster.stale) {
      items.push(`<span class="opt-cluster-stat"><strong>${esc(tr('Stale', '정체'))}</strong>${esc(tr(`${cluster.backlogAgeHours || 0}h age`, `${cluster.backlogAgeHours || 0}시간`))}</span>`);
    }

    return items.join('');
  }

  function renderClusterCard(cluster, options = {}) {
    const type = safeOptType(cluster.type);
    const priority = priorityMeta(cluster.priority);
    const status = statusMeta(cluster.currentStatus);
    const lastSeen = formatRelative(cluster.lastSeenAt);
    const firstSeen = formatRelative(cluster.firstSeenAt);
    const queueAction = options.showAction && cluster.currentStatus === 'needs_approval'
      ? `<button class="btn btn-sm btn-primary execute-opt" data-opt-id="${esc(cluster.latestOptimizationId)}">${esc(tr('Send to Telegram', '텔레그램 전송'))}</button>`
      : '';
    const awaitingBadge = options.showAction && cluster.currentStatus === 'awaiting_telegram'
      ? `<span class="badge badge-info">${esc(tr('Awaiting Telegram', '텔레그램 응답 대기'))}</span>`
      : '';
    const callout = cluster.count > 1
      ? tr(
          `${formatCount(cluster.count)} raw rows collapsed into one decision family`,
          `원시 ${formatCount(cluster.count)}행을 하나의 의사결정 패밀리로 압축`
        )
      : '';

    return `
      <div class="optimization-item grouped ${type}">
        <div class="opt-icon">
          <i data-lucide="${ICON_MAP[type] || 'zap'}"></i>
        </div>
        <div class="opt-content">
          <div class="opt-header">
            <span class="opt-action">${esc(localizeOptimizationText(cluster.action || cluster.reason || tr('Untitled family', '제목 없음')))}</span>
            <span class="badge ${priority.className}">${esc(priority.label)}</span>
            <span class="badge ${status.className}">${esc(status.label)}</span>
            ${queueAction}
            ${awaitingBadge}
          </div>
          <div class="opt-target">${esc(cluster.targetName || tr('Account-wide', '계정 전체'))}</div>
          <div class="opt-reason">${esc(localizeOptimizationText(cluster.reason || tr('No reasoning captured for this family.', '사유가 기록되지 않았습니다.')))}</div>
          ${cluster.impact ? `<div class="opt-impact">${esc(localizeOptimizationText(cluster.impact))}</div>` : ''}
          <div class="opt-cluster-meta">${buildClusterMeta(cluster)}</div>
          <div class="opt-summary-line">${esc(buildClusterStatusLine(cluster) || tr('No lifecycle updates recorded yet.', '아직 상태 변화가 없습니다.'))}</div>
          ${callout ? `<div class="opt-callout">${esc(callout)}</div>` : ''}
          <div class="opt-time">${esc(tr(`First seen ${firstSeen} · Last seen ${lastSeen}`, `최초 ${firstSeen} · 최근 ${lastSeen}`))}</div>
        </div>
      </div>
    `;
  }

  function renderSummary(aiOps) {
    const summary = aiOps?.summary || {};
    const quality = aiOps?.quality || {};
    const qualitySummary = quality.summary || {};
    const qualityBadge = qualityMeta(quality.level);

    const valueMap = {
      optActionNow: summary.actionNowFamilies ?? 0,
      optBacklog: summary.openBacklogFamilies ?? 0,
      optFriction: (qualitySummary.expiredApprovals || 0) + (qualitySummary.failedApprovalRequests || 0),
      optRepeats: qualitySummary.duplicateApprovalClusters || 0,
      optQuality: qualityBadge.label,
    };

    Object.entries(valueMap).forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = typeof value === 'number' ? formatCount(value) : value;
    });

    const metaMap = {
      optActionNowMeta: tr(
        `${formatCount(summary.actionNowItems || 0)} open items across the latest queue`,
        `최신 큐 기준 ${formatCount(summary.actionNowItems || 0)}개 항목`
      ),
      optBacklogMeta: tr(
        `${formatCount(summary.openBacklogItems || 0)} unresolved items in older families`,
        `이전 패밀리에 ${formatCount(summary.openBacklogItems || 0)}개 미해결`
      ),
      optFrictionMeta: tr(
        `${formatCount(qualitySummary.expiredApprovals || 0)} expired · ${formatCount(qualitySummary.failedApprovalRequests || 0)} delivery failures`,
        `${formatCount(qualitySummary.expiredApprovals || 0)} 만료 · ${formatCount(qualitySummary.failedApprovalRequests || 0)} 전달 실패`
      ),
      optRepeatsMeta: tr(
        `${formatCount(summary.rawRecommendationCount || 0)} rows compressed into ${formatCount(summary.clusterCount || 0)} families`,
        `${formatCount(summary.rawRecommendationCount || 0)}행을 ${formatCount(summary.clusterCount || 0)}패밀리로 압축`
      ),
      optQualityMeta: tr(
        `${formatCount(qualitySummary.staleHighPriorityAlerts || 0)} stale alerts · ${formatCount(summary.staleBacklogFamilies || 0)} stale backlog families`,
        `${formatCount(qualitySummary.staleHighPriorityAlerts || 0)}개 오래된 경보 · ${formatCount(summary.staleBacklogFamilies || 0)}개 정체 백로그`
      ),
    };

    Object.entries(metaMap).forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    });
  }

  function renderEventStrip(markers) {
    const container = document.getElementById('candlestickEvents');
    if (!container) return;

    if (!Array.isArray(markers) || markers.length === 0) {
      container.innerHTML = `<div class="empty-state">${esc(tr('No meaningful decision markers in the current window.', '현재 창에서 의미 있는 결정 마커가 없습니다.'))}</div>`;
      return;
    }

    container.innerHTML = markers.map(marker => {
      const visual = eventVisual(marker.kind);
      const label = new Date(`${marker.date}T00:00:00Z`).toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' });
      return `
        <span class="candlestick-event-chip" title="${esc(marker.detail || marker.title || '')}">
          <span class="candlestick-event-dot ${esc(visual.dotClass)}"></span>
          <strong>${esc(label)}</strong>
          <span>${esc(marker.title || tr('Decision marker', '결정 마커'))}</span>
          ${marker.count > 1 ? `<span>· ${esc(formatCount(marker.count))}</span>` : ''}
        </span>
      `;
    }).join('');
  }

  function renderQueue(aiOps) {
    const container = document.getElementById('optimizationQueue');
    const statsEl = document.getElementById('optQueueStats');
    const entries = aiOps?.queue?.immediate || [];

    if (statsEl) {
      const openFamilies = entries.filter(cluster => cluster.currentStatus === 'needs_approval').length;
      const awaitingFamilies = entries.filter(cluster => cluster.currentStatus === 'awaiting_telegram').length;
      statsEl.textContent = tr(
        `${formatCount(openFamilies)} open families · ${formatCount(awaitingFamilies)} awaiting reply`,
        `${formatCount(openFamilies)}개 열림 · ${formatCount(awaitingFamilies)}개 응답 대기`
      );
    }

    if (!container) return;
    if (entries.length === 0) {
      container.innerHTML = `<div class="empty-state">${esc(tr('No immediate queue right now. Check the backlog beside this card for older unresolved decision families.', '즉시 처리할 큐가 없습니다. 이전 미해결 패밀리는 옆 백로그에서 확인하세요.'))}</div>`;
      return;
    }

    container.innerHTML = entries.map(cluster => renderClusterCard(cluster, { showAction: true })).join('');
    if (window.lucide) lucide.createIcons();
    bindExecuteButtons(container);
  }

  function renderBacklog(aiOps) {
    const container = document.getElementById('optimizationBacklog');
    const statsEl = document.getElementById('optBacklogStats');
    const entries = aiOps?.queue?.backlog || [];

    if (statsEl) {
      const staleFamilies = entries.filter(cluster => cluster.stale).length;
      statsEl.textContent = tr(
        `${formatCount(entries.length)} families · ${formatCount(staleFamilies)} stale`,
        `${formatCount(entries.length)}개 패밀리 · ${formatCount(staleFamilies)}개 정체`
      );
    }

    if (!container) return;
    if (entries.length === 0) {
      container.innerHTML = `<div class="empty-state">${esc(tr('No unresolved backlog families right now.', '현재 미해결 백로그 패밀리가 없습니다.'))}</div>`;
      return;
    }

    container.innerHTML = entries.map(cluster => renderClusterCard(cluster)).join('');
    if (window.lucide) lucide.createIcons();
  }

  function renderActivity(aiOps) {
    const container = document.getElementById('optActivityLog');
    const statsEl = document.getElementById('optActivityStats');
    const entries = aiOps?.activity || [];

    if (statsEl) {
      const openish = entries.filter(entry => ['needs_approval', 'awaiting_telegram'].includes(entry.kind)).length;
      const resolved = entries.filter(entry => ['expired', 'rejected', 'executed'].includes(entry.kind)).length;
      statsEl.textContent = tr(
        `${formatCount(entries.length)} events · ${formatCount(openish)} open flow · ${formatCount(resolved)} resolved/executed`,
        `${formatCount(entries.length)}개 이벤트 · ${formatCount(openish)}개 진행 중 · ${formatCount(resolved)}개 종료/실행`
      );
    }

    if (!container) return;
    if (entries.length === 0) {
      container.innerHTML = `<div class="empty-state">${esc(tr('No meaningful decision flow events yet in the current window.', '현재 창에서 의미 있는 결정 흐름 이벤트가 없습니다.'))}</div>`;
      return;
    }

    container.innerHTML = entries.map(entry => {
      const priority = priorityMeta(entry.priority);
      const visual = eventVisual(entry.kind);
      return `
        <div class="optimization-item grouped">
          <div class="opt-icon">
            <i data-lucide="${visual.icon}"></i>
          </div>
          <div class="opt-content">
            <div class="opt-header">
              <span class="opt-action">${esc(entry.title)}</span>
              <span class="badge ${statusMeta(entry.kind).className}">${esc(statusMeta(entry.kind).label)}</span>
              <span class="badge ${priority.className}">${esc(priority.label)}</span>
            </div>
            <div class="opt-target">${esc(entry.targetName || tr('Account-wide', '계정 전체'))}</div>
            <div class="opt-reason">${esc(localizeOptimizationText(entry.action || tr('No action captured.', '조치가 없습니다.')))}</div>
            <div class="opt-summary-line">${esc(entry.detail || tr('No extra detail recorded.', '추가 세부 정보가 없습니다.'))}</div>
            <div class="opt-time">${esc(formatRelative(entry.timestamp))}</div>
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide) lucide.createIcons();
  }

  function renderSystemChatter(aiOps) {
    const container = document.getElementById('optSystemChatter');
    if (!container) return;

    const summary = aiOps?.summary || {};
    const quality = aiOps?.quality || {};
    const qualitySummary = quality.summary || {};
    const system = aiOps?.systemChatter || {};
    const qualityBadge = qualityMeta(quality.level);

    container.innerHTML = `
      <div class="ai-ops-system-card">
        <h3>${esc(tr('AI quality pulse', 'AI 품질 상태'))}</h3>
        <div class="opt-header">
          <span class="badge ${qualityBadge.className}">${esc(qualityBadge.label)}</span>
        </div>
        <div class="ai-ops-system-copy">
          ${esc(tr(
            `${formatCount(summary.rawRecommendationCount || 0)} raw rows compressed into ${formatCount(summary.clusterCount || 0)} families. Duplicate pressure and expired approvals are now tracked separately from live action.`,
            `원시 ${formatCount(summary.rawRecommendationCount || 0)}행을 ${formatCount(summary.clusterCount || 0)}개 패밀리로 압축했습니다. 중복 압력과 만료 승인 수는 라이브 액션과 분리해 추적합니다.`
          ))}
        </div>
        <div class="ai-ops-system-metrics">
          <div class="ai-ops-system-metric">
            <span>${esc(tr('Compression', '압축률'))}</span>
            <strong>${esc(`${summary.compressionRatio || 0}x`)}</strong>
          </div>
          <div class="ai-ops-system-metric">
            <span>${esc(tr('Duplicate clusters', '중복 클러스터'))}</span>
            <strong>${esc(formatCount(qualitySummary.duplicateApprovalClusters || 0))}</strong>
          </div>
          <div class="ai-ops-system-metric">
            <span>${esc(tr('Expired approvals', '만료 승인'))}</span>
            <strong>${esc(formatCount(qualitySummary.expiredApprovals || 0))}</strong>
          </div>
          <div class="ai-ops-system-metric">
            <span>${esc(tr('Failed delivery', '전달 실패'))}</span>
            <strong>${esc(formatCount(qualitySummary.failedApprovalRequests || 0))}</strong>
          </div>
        </div>
      </div>
      <div class="ai-ops-system-card">
        <h3>${esc(tr('System chatter', '시스템 채터'))}</h3>
        <div class="ai-ops-system-copy">
          ${esc(tr(
            `Routine scan noise is summarized here so the main flow only shows meaningful decision state changes.`,
            `루틴 스캔 잡음은 이 레일에서 요약해 메인 플로우에는 의미 있는 결정 상태 변화만 남깁니다.`
          ))}
        </div>
        <div class="ai-ops-system-metrics">
          <div class="ai-ops-system-metric">
            <span>${esc(tr('Scans (24h)', '스캔 (24시간)'))}</span>
            <strong>${esc(formatCount(system.scanCount || 0))}</strong>
          </div>
          <div class="ai-ops-system-metric">
            <span>${esc(tr('With suggestions', '제안 포함'))}</span>
            <strong>${esc(formatCount(system.scansWithSuggestions || 0))}</strong>
          </div>
          <div class="ai-ops-system-metric">
            <span>${esc(tr('Quiet scans', '조용한 스캔'))}</span>
            <strong>${esc(formatCount(system.quietScans || 0))}</strong>
          </div>
          <div class="ai-ops-system-metric">
            <span>${esc(tr('Avg ideas/scan', '평균 아이디어/스캔'))}</span>
            <strong>${esc(String(system.avgOptimizationsPerScan || 0))}</strong>
          </div>
        </div>
        <div class="opt-time">${esc(tr(
          system.lastScanAt
            ? `Last scan ${formatRelative(system.lastScanAt)} · ${formatCount(system.lastScanOptimizations || 0)} suggestions · ${formatCount(system.lastScanErrors || 0)} errors`
            : 'No recent scan data yet.',
          system.lastScanAt
            ? `최근 스캔 ${formatRelative(system.lastScanAt)} · 제안 ${formatCount(system.lastScanOptimizations || 0)}건 · 오류 ${formatCount(system.lastScanErrors || 0)}건`
            : '최근 스캔 데이터가 없습니다.'
        ))}</div>
      </div>
    `;
  }

  function renderClusters(aiOps) {
    const container = document.getElementById('optimizationClusters');
    const statsEl = document.getElementById('optStats');
    const filtered = filterClusters(aiOps?.clusters || []);

    if (statsEl) {
      statsEl.textContent = tr(
        `${formatCount(filtered.length)} families shown · ${formatCount(aiOps?.clusters?.length || 0)} in the current window`,
        `${formatCount(filtered.length)}개 패밀리 표시 · 현재 창 전체 ${formatCount(aiOps?.clusters?.length || 0)}개`
      );
    }

    if (!container) return;
    if (filtered.length === 0) {
      container.innerHTML = `<div class="empty-state">${esc(tr('No clustered families match the current filters.', '현재 필터와 일치하는 패밀리가 없습니다.'))}</div>`;
      return;
    }

    container.innerHTML = filtered.map(cluster => renderClusterCard(cluster)).join('');
    if (window.lucide) lucide.createIcons();
  }

  function renderRawHistory(optData) {
    const container = document.getElementById('optimizationLog');
    const statsEl = document.getElementById('optRawStats');
    if (!container) return;

    const filtered = filterRawHistory(optData?.optimizations || []);
    if (statsEl) {
      statsEl.textContent = tr(
        `${formatCount(filtered.length)} raw rows shown · ${formatCount(optData?.total || 0)} total logged`,
        `${formatCount(filtered.length)}개 원시 행 표시 · 총 ${formatCount(optData?.total || 0)}개 기록`
      );
    }

    if (filtered.length === 0) {
      container.innerHTML = `<div class="empty-state">${esc(tr('No raw history rows match the current filters.', '현재 필터와 일치하는 원시 이력이 없습니다.'))}</div>`;
      return;
    }

    container.innerHTML = filtered.map(opt => {
      const type = safeOptType(opt.type);
      const priority = priorityMeta(opt.priority);
      const status = statusMeta(opt.status);
      const scanText = opt.scanId ? tr(` · Scan ${String(opt.scanId).slice(-6)}`, ` · 스캔 ${String(opt.scanId).slice(-6)}`) : '';
      const resultText = opt.executionResult ? ` · ${localizeOptimizationText(opt.executionResult)}` : '';

      return `
        <div class="optimization-item ${opt.executed ? 'executed' : 'pending'}">
          <div class="opt-icon">
            <i data-lucide="${ICON_MAP[type] || 'zap'}"></i>
          </div>
          <div class="opt-content">
            <div class="opt-header">
              <span class="opt-action">${esc(localizeOptimizationText(opt.action))}</span>
              <span class="badge ${priority.className}">${esc(priority.label)}</span>
              <span class="badge ${status.className}">${esc(status.label)}</span>
            </div>
            <div class="opt-target">${esc(opt.targetName || tr('Account-wide', '계정 전체'))}</div>
            <div class="opt-reason">${esc(localizeOptimizationText(opt.reason || tr('No reason provided.', '사유가 제공되지 않았습니다.')))}</div>
            <div class="opt-impact">${esc(localizeOptimizationText(opt.impact || tr('No impact estimate provided.', '영향 추정치가 없습니다.')))}</div>
            <div class="opt-time">${opt.timestamp ? `${formatRelative(opt.timestamp)}${scanText}${resultText}` : `${tr('Timestamp unavailable', '시간 정보 없음')}${resultText}`}</div>
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide) lucide.createIcons();
  }

  function renderKarpathySummary(policyLab) {
    const container = document.getElementById('karpathySummary');
    const metaEl = document.getElementById('karpathySummaryMeta');
    if (!container) return;

    if (!policyLab) {
      container.innerHTML = `<div class="empty-state">${esc(tr('Policy-lab data is not available yet.', '정책 실험 데이터가 아직 없습니다.'))}</div>`;
      if (metaEl) metaEl.textContent = tr('No data', '데이터 없음');
      return;
    }

    const summary = policyLab.summary || {};
    const sentryStatus = summary.sentryStatus || {};
    const sentryLabel = sentryStatus.enabled
      ? tr('Sentry live', '센트리 연결')
      : tr('Local only', '로컬만');

    if (metaEl) {
      metaEl.textContent = summary.lastResearchRunAt
        ? tr(`Last run ${formatRelative(summary.lastResearchRunAt)}`, `최근 실행 ${formatRelative(summary.lastResearchRunAt)}`)
        : tr('No research runs yet', '아직 연구 실행 없음');
    }

    const cards = [
      { label: tr('Champion', '챔피언'), value: summary.championPolicyLabel || '—', meta: summary.championPolicyId || '—' },
      { label: tr('Active challengers', '활성 도전자'), value: formatCount(summary.challengerCount || 0), meta: tr(`${formatCount(summary.promotionReadyCount || 0)} promotion-ready`, `${formatCount(summary.promotionReadyCount || 0)}개 승격 준비`) },
      { label: tr('Shadow divergence', '섀도우 분기'), value: `${Math.round((summary.shadowDivergenceRate || 0) * 100)}%`, meta: summary.activeShadowPolicyLabel || tr('No active shadow policy', '활성 섀도우 정책 없음') },
      { label: tr('Completed outcomes', '완료된 결과'), value: formatCount(summary.completedOutcomeCount || 0), meta: tr(`${formatCount(summary.decisionTraceCount || 0)} total traces`, `총 ${formatCount(summary.decisionTraceCount || 0)}개 트레이스`) },
      { label: tr('Observability', '관측 상태'), value: sentryLabel, meta: sentryStatus.lastEventAt ? tr(`Last event ${formatRelative(sentryStatus.lastEventAt)}`, `최근 이벤트 ${formatRelative(sentryStatus.lastEventAt)}`) : tr('No events yet', '아직 이벤트 없음') },
    ];

    container.innerHTML = cards.map(card => `
      <div class="karpathy-summary-card">
        <span>${esc(card.label)}</span>
        <strong>${esc(card.value)}</strong>
        <small>${esc(card.meta)}</small>
      </div>
    `).join('');
  }

  function renderKarpathyTimeline(policyLab, experimentsData) {
    const container = document.getElementById('karpathyTimeline');
    const metaEl = document.getElementById('karpathyTimelineMeta');
    if (!container) return;

    const markers = policyLab?.strategyMarkers || [];
    const experiments = experimentsData?.experiments || policyLab?.experimentsPreview || [];

    if (metaEl) {
      metaEl.textContent = tr(
        `${formatCount(markers.length)} chart markers · ${formatCount(experiments.length)} logged challengers`,
        `${formatCount(markers.length)}개 차트 마커 · ${formatCount(experiments.length)}개 도전자`
      );
    }

    if (markers.length === 0 && experiments.length === 0) {
      container.innerHTML = `<div class="empty-state">${esc(tr('No strategy progression logged yet.', '아직 전략 진행 이력이 없습니다.'))}</div>`;
      return;
    }

    const timelineItems = experiments.length > 0
      ? experiments.slice(0, 10).map(experiment => {
          const visual = eventVisual(experiment.status === 'promotion_ready' ? 'promoted' : 'challenger');
          const replay = experiment.replaySummary || {};
          return `
            <div class="karpathy-timeline-item">
              <div class="opt-icon">
                <i data-lucide="${visual.icon}"></i>
              </div>
              <div class="opt-content">
                <div class="opt-header">
                  <span class="opt-action">${esc(experiment.label || experiment.policyId || tr('Challenger policy', '도전자 정책'))}</span>
                  <span class="badge ${experiment.status === 'promotion_ready' ? 'badge-success' : 'badge-info'}">${esc(experiment.status || 'challenger')}</span>
                </div>
                <div class="opt-reason">${esc(experiment.summaryLine || tr('No diff summary recorded.', '차이 요약이 없습니다.'))}</div>
                <div class="opt-cluster-meta">
                  <span class="opt-cluster-stat"><strong>${esc(formatCount(replay.sampleSize || 0))}</strong>${esc(tr('replay samples', '리플레이 샘플'))}</span>
                  <span class="opt-cluster-stat"><strong>${esc(`${Math.round((replay.improvementRatio || 0) * 100)}%`)}</strong>${esc(tr('score lift', '점수 상승'))}</span>
                  <span class="opt-cluster-stat"><strong>${esc(`${Math.round((replay.divergenceRate || 0) * 100)}%`)}</strong>${esc(tr('divergence', '분기율'))}</span>
                </div>
                <div class="opt-time">${esc(formatRelative(experiment.createdAt))}</div>
              </div>
            </div>
          `;
        })
      : markers.slice(0, 10).map(marker => {
          const visual = eventVisual(marker.kind);
          return `
            <div class="karpathy-timeline-item">
              <div class="opt-icon">
                <i data-lucide="${visual.icon}"></i>
              </div>
              <div class="opt-content">
                <div class="opt-header">
                  <span class="opt-action">${esc(marker.title || tr('Strategy event', '전략 이벤트'))}</span>
                  <span class="badge ${marker.kind === 'promoted' ? 'badge-success' : 'badge-info'}">${esc(marker.kind || 'event')}</span>
                </div>
                <div class="opt-reason">${esc(marker.detail || tr('No detail captured.', '세부 내용이 없습니다.'))}</div>
                <div class="opt-time">${esc(marker.date || '—')}</div>
              </div>
            </div>
          `;
        });

    container.innerHTML = timelineItems.join('');

    if (window.lucide) lucide.createIcons();
  }

  function renderKarpathyMetrics(policyLab, outcomesData) {
    const container = document.getElementById('karpathyMetrics');
    const metaEl = document.getElementById('karpathyMetricsMeta');
    if (!container) return;

    const metrics = policyLab?.metrics || {};
    const summary = metrics.summary || {};
    const outcomes = outcomesData?.outcomes || policyLab?.outcomesPreview || [];

    if (metaEl) {
      metaEl.textContent = tr(
        `${formatCount(outcomes.length)} recent outcomes · ${formatCount(policyLab?.experimentsPreview?.length || 0)} previewed challengers`,
        `${formatCount(outcomes.length)}개 최근 결과 · ${formatCount(policyLab?.experimentsPreview?.length || 0)}개 도전자`
      );
    }

    if (!policyLab) {
      container.innerHTML = `<div class="empty-state">${esc(tr('Policy-lab metrics are not available yet.', '정책 실험 지표가 아직 없습니다.'))}</div>`;
      return;
    }

    const rewardTrend = metrics.rewardTrend || [];
    const candidateTrend = metrics.candidateTrend || [];

    container.innerHTML = `
      <div class="karpathy-metric-grid">
        <div class="karpathy-metric-card">
          <span>${esc(tr('Total reward', '총 보상'))}</span>
          <strong>${esc(formatKrw(summary.totalReward || 0))}</strong>
        </div>
        <div class="karpathy-metric-card">
          <span>${esc(tr('Realized profit delta', '실현 이익 증감'))}</span>
          <strong>${esc(formatKrw(summary.totalProfitDelta || 0))}</strong>
        </div>
        <div class="karpathy-metric-card">
          <span>${esc(tr('Approval friction', '승인 마찰'))}</span>
          <strong>${esc(formatCount(summary.approvalFriction || 0))}</strong>
        </div>
        <div class="karpathy-metric-card">
          <span>${esc(tr('Shadow divergence', '섀도우 분기'))}</span>
          <strong>${esc(`${Math.round((summary.shadowDivergenceRate || 0) * 100)}%`)}</strong>
        </div>
      </div>
      <div class="karpathy-mini-columns">
        <div class="karpathy-mini-card">
          <h3>${esc(tr('Reward trend', '보상 추세'))}</h3>
          ${(rewardTrend.length === 0 ? [`<div class="empty-state compact">${esc(tr('No completed 72h outcomes yet.', '아직 완료된 72시간 결과가 없습니다.'))}</div>`] : rewardTrend.slice(-6).reverse().map(row => `
            <div class="karpathy-row">
              <strong>${esc(row.date)}</strong>
              <span>${esc(formatKrw(row.reward || 0))}</span>
              <span>${esc(formatKrw(row.realizedProfitDelta || 0))}</span>
            </div>
          `)).join('')}
        </div>
        <div class="karpathy-mini-card">
          <h3>${esc(tr('Candidate trend', '도전자 추세'))}</h3>
          ${(candidateTrend.length === 0 ? [`<div class="empty-state compact">${esc(tr('No challenger scoring yet.', '아직 도전자 점수가 없습니다.'))}</div>`] : candidateTrend.slice(-6).reverse().map(row => `
            <div class="karpathy-row">
              <strong>${esc(row.date)}</strong>
              <span>${esc(`${Math.round((row.improvementRatio || 0) * 100)}%`)}</span>
              <span>${esc(`${Math.round((row.approvalLoadRatio || 0) * 100)}%`)}</span>
            </div>
          `)).join('')}
        </div>
      </div>
      <div class="karpathy-mini-card">
        <h3>${esc(tr('Latest scored outcomes', '최근 점수화 결과'))}</h3>
        ${(outcomes.filter(outcome => outcome.status === 'complete').slice(0, 6).map(outcome => `
          <div class="karpathy-outcome-row">
            <div>
              <strong>${esc(outcome.targetName || tr('Unknown target', '알 수 없는 대상'))}</strong>
              <div class="opt-time">${esc(formatRelative(outcome.executedAt))}</div>
            </div>
            <div class="karpathy-outcome-values">
              <span>${esc(outcome.finalReward?.rewardBucket || tr('pending', '대기'))}</span>
              <strong>${esc(formatKrw(outcome.finalReward?.total || 0))}</strong>
            </div>
          </div>
        `).join('')) || `<div class="empty-state compact">${esc(tr('No completed reward windows yet.', '아직 완료된 보상 윈도우가 없습니다.'))}</div>`}
      </div>
    `;
  }

  function renderKarpathyObservability(policyLab, observabilityData) {
    const container = document.getElementById('karpathyObservability');
    const metaEl = document.getElementById('karpathyObservabilityMeta');
    if (!container) return;

    const events = observabilityData?.events || policyLab?.observability?.recent || [];
    const status = observabilityData?.status || policyLab?.observability?.status || {};

    if (metaEl) {
      metaEl.textContent = status.enabled
        ? tr('Sentry enabled', '센트리 활성')
        : tr('Local observability only', '로컬 관측만');
    }

    if (events.length === 0) {
      container.innerHTML = `<div class="empty-state">${esc(tr('No observability warnings have been recorded yet.', '아직 기록된 관측 경고가 없습니다.'))}</div>`;
      return;
    }

    container.innerHTML = events.slice(0, 12).map(event => {
      const severity = levelMeta(event.level);
      const visual = eventVisual(event.level);
      return `
        <div class="optimization-item grouped">
          <div class="opt-icon">
            <i data-lucide="${visual.icon}"></i>
          </div>
          <div class="opt-content">
            <div class="opt-header">
              <span class="opt-action">${esc(event.title || event.message || tr('Observability event', '관측 이벤트'))}</span>
              <span class="badge ${severity.className}">${esc(severity.label)}</span>
            </div>
            <div class="opt-target">${esc(event.category || tr('General', '일반'))}</div>
            <div class="opt-reason">${esc(event.message || tr('No message captured.', '메시지가 없습니다.'))}</div>
            <div class="opt-summary-line">${esc(Object.entries(event.tags || {}).slice(0, 3).map(([key, value]) => `${key}: ${value}`).join(' · ') || tr('No tags captured.', '태그가 없습니다.'))}</div>
            <div class="opt-time">${esc(formatRelative(event.timestamp))}</div>
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide) lucide.createIcons();
  }

  function filterKarpathyTraces(tracesData) {
    const traces = tracesData?.traces || [];
    const policyFilter = document.getElementById('karpathyTracePolicyFilter')?.value || 'all';
    const verdictFilter = document.getElementById('karpathyTraceVerdictFilter')?.value || 'all';
    const surfaceFilter = document.getElementById('karpathyTraceSurfaceFilter')?.value || 'all';
    const targetFilter = (document.getElementById('karpathyTraceTargetFilter')?.value || '').trim().toLowerCase();

    return traces.filter(trace => {
      if (policyFilter !== 'all' && trace.policyVersionId !== policyFilter) return false;
      if (verdictFilter !== 'all' && trace.verdict !== verdictFilter) return false;
      if (surfaceFilter !== 'all' && trace.controlSurface !== surfaceFilter) return false;
      if (targetFilter && !String(trace.entity?.targetName || '').toLowerCase().includes(targetFilter)) return false;
      return true;
    });
  }

  function renderKarpathyTraces(tracesData) {
    const container = document.getElementById('karpathyTraceExplorer');
    const statsEl = document.getElementById('karpathyTraceStats');
    if (!container) return;

    const filters = tracesData?.filters || {};
    syncSelectOptions(document.getElementById('karpathyTracePolicyFilter'), filters.policyIds, tr('All policies', '모든 정책'));
    syncSelectOptions(document.getElementById('karpathyTraceVerdictFilter'), filters.verdicts, tr('All verdicts', '모든 판정'));

    const surfaceSelect = document.getElementById('karpathyTraceSurfaceFilter');
    if (surfaceSelect) {
      const selected = surfaceSelect.value;
      const values = ['all', ...(filters.controlSurfaces || [])];
      surfaceSelect.innerHTML = values.map(value => `<option value="${esc(value)}">${esc(value === 'all' ? tr('All control surfaces', '모든 예산 표면') : controlSurfaceLabel(value))}</option>`).join('');
      surfaceSelect.value = values.includes(selected) ? selected : 'all';
    }

    const filtered = filterKarpathyTraces(tracesData);

    if (statsEl) {
      statsEl.textContent = tr(
        `${formatCount(filtered.length)} traces shown · ${formatCount(tracesData?.traces?.length || 0)} total`,
        `${formatCount(filtered.length)}개 트레이스 표시 · 총 ${formatCount(tracesData?.traces?.length || 0)}개`
      );
    }

    if (filtered.length === 0) {
      container.innerHTML = `<div class="empty-state">${esc(tr('No traces match the current filters.', '현재 필터와 일치하는 트레이스가 없습니다.'))}</div>`;
      return;
    }

    container.innerHTML = filtered.slice(0, 40).map(trace => {
      const verdict = verdictMeta(trace.verdict);
      const gates = trace.gates || [];
      const penalties = trace.penalties || [];
      const blockers = trace.blockers || [];
      const cautions = trace.cautions || [];
      return `
        <details class="karpathy-trace-item">
          <summary>
            <div class="karpathy-trace-head">
              <div>
                <div class="opt-header">
                  <span class="opt-action">${esc(trace.entity?.targetName || tr('Unknown target', '알 수 없는 대상'))}</span>
                  <span class="badge ${verdict.className}">${esc(verdict.label)}</span>
                  <span class="badge badge-neutral">${esc(trace.mode || 'champion')}</span>
                </div>
                <div class="opt-target">${esc(trace.policyVersionId || '—')} · ${esc(controlSurfaceLabel(trace.controlSurface))}</div>
              </div>
              <span class="opt-time">${esc(formatRelative(trace.timestamp))}</span>
            </div>
          </summary>
          <div class="karpathy-trace-body">
            <div class="opt-reason">${esc(trace.rationaleSummary || trace.reasoning || tr('No rationale captured.', '판단 근거가 없습니다.'))}</div>
            <div class="opt-cluster-meta">
              <span class="opt-cluster-stat"><strong>${esc(String(trace.inputSnapshot?.avgCpa ?? '—'))}</strong>${esc(tr('CPA', 'CPA'))}</span>
              <span class="opt-cluster-stat"><strong>${esc(formatCount(trace.inputSnapshot?.purchases || 0))}</strong>${esc(tr('purchases', '구매'))}</span>
              <span class="opt-cluster-stat"><strong>${esc(`${trace.actionPercent || 0}%`)}</strong>${esc(tr('step', '변경폭'))}</span>
              <span class="opt-cluster-stat"><strong>${esc(trace.confidence || 'low')}</strong>${esc(tr('confidence', '신뢰도'))}</span>
            </div>
            <div class="karpathy-trace-columns">
              <div class="karpathy-trace-panel">
                <h4>${esc(tr('Gates', '게이트'))}</h4>
                ${gates.map(gate => `<div class="karpathy-trace-line ${gate.passed ? 'passed' : 'failed'}"><strong>${esc(gate.key)}</strong><span>${esc(gate.detail || '')}</span></div>`).join('') || `<div class="empty-state compact">${esc(tr('No gates recorded.', '기록된 게이트 없음'))}</div>`}
              </div>
              <div class="karpathy-trace-panel">
                <h4>${esc(tr('Penalties and blockers', '패널티와 차단'))}</h4>
                ${penalties.map(penalty => `<div class="karpathy-trace-line"><strong>${esc(penalty.type)}</strong><span>${esc(`${penalty.detail || ''} (w=${penalty.weight ?? 0})`)}</span></div>`).join('')}
                ${blockers.map(blocker => `<div class="karpathy-trace-line failed"><strong>${esc(tr('blocker', '차단'))}</strong><span>${esc(blocker)}</span></div>`).join('')}
                ${cautions.map(caution => `<div class="karpathy-trace-line"><strong>${esc(tr('caution', '주의'))}</strong><span>${esc(caution)}</span></div>`).join('')}
                ${(penalties.length || blockers.length || cautions.length) ? '' : `<div class="empty-state compact">${esc(tr('No penalties or blockers recorded.', '패널티/차단 없음'))}</div>`}
              </div>
            </div>
          </div>
        </details>
      `;
    }).join('');
  }

  function bindExecuteButtons(scope = document) {
    scope.querySelectorAll('.execute-opt').forEach(button => {
      if (button.dataset.bound === 'true') return;
      button.dataset.bound = 'true';

      button.addEventListener('click', async event => {
        const optId = event.currentTarget.dataset.optId;
        event.currentTarget.textContent = tr('Sending to Telegram...', '텔레그램 전송 중...');
        event.currentTarget.disabled = true;

        const result = await executeOptimization(optId);
        if (result && result.pending) {
          event.currentTarget.textContent = result.alreadyRequested ? tr('Awaiting Telegram', '텔레그램 응답 대기') : tr('Sent to Telegram', '텔레그램 전송됨');
          event.currentTarget.classList.remove('btn-primary');
          event.currentTarget.classList.add('btn-ghost');
          setTimeout(() => refreshOptimizationsPage(), 1000);
          setTimeout(() => refreshOptimizationsPage(), 10000);
          return;
        }

        event.currentTarget.textContent = tr('Failed', '실패');
      });
    });
  }

  function bindOptimizationFilters() {
    if (document.body.dataset.optFiltersBound === 'true') return;
    document.body.dataset.optFiltersBound = 'true';

    ['optTypeFilter', 'optStatusFilter', 'karpathyTracePolicyFilter', 'karpathyTraceVerdictFilter', 'karpathyTraceSurfaceFilter', 'karpathyTraceTargetFilter'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const eventName = el.tagName === 'INPUT' ? 'input' : 'change';
      el.addEventListener(eventName, () => {
        refreshOptimizationsPage();
      });
    });
  }

  function buildEventDataset(markersByDate, spendData, minV, pad) {
    const markerBase = Math.max(0, minV - pad * 1.1);
    const eventDataset = spendData.map(row => (markersByDate.get(row.date) ? markerBase : null));
    const pointBackgroundColor = spendData.map(row => {
      const marker = markersByDate.get(row.date);
      if (!marker) return 'transparent';
      switch (marker.kind) {
        case 'executed':
          return '#4ade80';
        case 'promoted':
          return '#f59e0b';
        case 'challenger':
          return '#7c3aed';
        case 'expired':
        case 'rejected':
          return '#ef6461';
        case 'needs_approval':
        case 'awaiting_telegram':
          return '#20808D';
        default:
          return '#94a3b8';
      }
    });
    const pointStyle = spendData.map(row => {
      const marker = markersByDate.get(row.date);
      if (!marker) return 'circle';
      switch (marker.kind) {
        case 'executed':
          return 'rectRounded';
        case 'promoted':
          return 'star';
        case 'challenger':
          return 'triangle';
        case 'expired':
        case 'rejected':
          return 'rectRot';
        case 'needs_approval':
        case 'awaiting_telegram':
          return 'triangle';
        default:
          return 'circle';
      }
    });
    const pointRadius = spendData.map(row => {
      const marker = markersByDate.get(row.date);
      return marker ? Math.min(7, 3 + Number(marker.count || 1)) : 0;
    });

    return {
      markerBase,
      eventDataset,
      pointBackgroundColor,
      pointStyle,
      pointRadius,
    };
  }

  function updateCharts(aiOps, policyLab, spendData) {
    if (!(typeof optTimelineChart !== 'undefined' && optTimelineChart && spendData && spendData.length > 0)) {
      return;
    }

    const labels = spendData.map(row => {
      const dt = new Date(row.date);
      return dt.toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' });
    });
    const mergedMarkers = buildMergedMarkers(aiOps, policyLab);
    const markersByDate = new Map(mergedMarkers.map(marker => [marker.date, marker]));

    if (typeof _candlestickOHLC !== 'undefined') {
      _candlestickOHLC = spendData.map(row => ({ o: row.o, h: row.h, l: row.l, c: row.c }));
    }
    if (typeof _candlestickData !== 'undefined') {
      _candlestickData = spendData;
      _candlestickChanges = spendData.map((row, index) => {
        if (index === 0) return { pct: 0, dir: '' };
        const prev = spendData[index - 1].spend;
        const pct = ((row.spend - prev) / Math.max(prev, 1) * 100).toFixed(1);
        return { pct: Math.abs(pct), dir: row.spend >= prev ? '▲' : '▼' };
      });
      _candlestickEventMarkers = spendData.map(row => markersByDate.get(row.date) || null);
    }

    optTimelineChart.data.labels = labels;
    optTimelineChart.data.datasets[0].data = spendData.map(row => row.c);
    optTimelineChart.data.datasets[1].data = spendData.map(row => row.cac);
    const targetValue = optTimelineChart.data.datasets[2].data[0] || 45000;
    const budgetValue = optTimelineChart.data.datasets[3].data[0] || 90000;
    optTimelineChart.data.datasets[2].data = spendData.map(() => targetValue);
    optTimelineChart.data.datasets[3].data = spendData.map(() => budgetValue);

    const allVals = spendData.flatMap(row => [row.o, row.h, row.l, row.c]);
    const minV = Math.min(...allVals);
    const maxV = Math.max(...allVals);
    const pad = Math.max((maxV - minV) * 0.15, 5000);
    const markerDataset = buildEventDataset(markersByDate, spendData, minV, pad);
    optTimelineChart.data.datasets[4].data = markerDataset.eventDataset;
    optTimelineChart.data.datasets[4].pointBackgroundColor = markerDataset.pointBackgroundColor;
    optTimelineChart.data.datasets[4].pointBorderColor = markerDataset.pointBackgroundColor;
    optTimelineChart.data.datasets[4].pointStyle = markerDataset.pointStyle;
    optTimelineChart.data.datasets[4].pointRadius = markerDataset.pointRadius;
    optTimelineChart.data.datasets[4].pointHoverRadius = markerDataset.pointRadius.map(radius => radius > 0 ? radius + 2 : 0);

    optTimelineChart.options.scales.y.min = Math.max(0, minV - pad * 2);
    optTimelineChart.options.scales.y.max = maxV + pad;
    optTimelineChart.update();

    renderCandlestickStats(spendData);
    renderEventStrip(mergedMarkers);
  }

  async function refreshOptimizationsPage() {
    bindOptimizationFilters();

    const [aiOps, optData, spendData, policyLab, experimentsData, tracesData, outcomesData, observabilityData] = await Promise.all([
      fetchAiOperations(),
      fetchOptimizations(500),
      fetchSpendDaily(),
      fetchPolicyLab(),
      fetchPolicyLabExperiments(),
      fetchPolicyLabTraces(),
      fetchPolicyLabOutcomes(),
      fetchPolicyLabObservability(),
    ]);

    if (!aiOps) return;

    renderSummary(aiOps);
    renderQueue(aiOps);
    renderBacklog(aiOps);
    renderActivity(aiOps);
    renderSystemChatter(aiOps);
    renderClusters(aiOps);
    renderRawHistory(optData || { optimizations: [], total: 0 });
    renderKarpathySummary(policyLab);
    renderKarpathyTimeline(policyLab, experimentsData);
    renderKarpathyTraces(tracesData || { traces: [], filters: { policyIds: [], verdicts: [], controlSurfaces: [] } });
    renderKarpathyMetrics(policyLab, outcomesData);
    renderKarpathyObservability(policyLab, observabilityData);
    updateCharts(aiOps, policyLab, spendData || []);
  }

  live.registerPage('optimizations', {
    refresh: refreshOptimizationsPage,
  });
})();
