(function () {
  const live = window.AdPilotLive;
  const {
    esc,
    safeOptType,
    timeSince,
    formatCount,
    tr,
    localizeOptimizationText,
  } = live.shared;
  const {
    fetchAiOperations,
    fetchOptimizations,
    executeOptimization,
  } = live.api;

  const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
  const ICON_MAP = {
    budget: 'wallet',
    creative: 'image',
    status: 'power',
    legacy: 'archive',
  };
  const EVENT_ICON_MAP = {
    action_now: 'sparkles',
    awaiting_reply: 'send',
    fix_inputs: 'wrench',
    hold: 'pause-circle',
    portfolio_guidance: 'arrow-right-left',
    cleanup: 'archive',
    research: 'radar',
    resolved: 'check-check',
    executed: 'check-check',
    expired: 'clock-3',
    rejected: 'x-circle',
    advisory: 'radar',
    delivery_failed: 'triangle-alert',
    execution_failed: 'octagon-alert',
    challenger: 'beaker',
    promoted: 'rocket',
    warning: 'triangle-alert',
    error: 'octagon-alert',
    info: 'radar',
  };

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
      case 'action_now':
        return { label: tr('Decide now', '지금 결정'), className: 'badge-warning' };
      case 'awaiting_reply':
        return { label: tr('Awaiting reply', '응답 대기'), className: 'badge-info' };
      case 'fix_inputs':
        return { label: tr('Fix inputs', '입력 수정'), className: 'badge-warning' };
      case 'hold':
        return { label: tr('Hold', '유지'), className: 'badge-info' };
      case 'portfolio_guidance':
        return { label: tr('Portfolio guidance', '포트폴리오 가이드'), className: 'badge-info' };
      case 'cleanup':
        return { label: tr('Cleanup', '정리'), className: 'badge-neutral' };
      case 'research':
        return { label: tr('Research', '리서치'), className: 'badge-neutral' };
      case 'resolved':
        return { label: tr('Resolved', '해결됨'), className: 'badge-success' };
      case 'executed':
        return { label: tr('Executed', '실행됨'), className: 'badge-success' };
      case 'delivery_failed':
        return { label: tr('Delivery failed', '전달 실패'), className: 'badge-danger' };
      case 'execution_failed':
        return { label: tr('Execution failed', '실행 실패'), className: 'badge-danger' };
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
      case 'live':
        return ['action_now', 'awaiting_reply'].includes(cluster.currentStatus);
      case 'fix_inputs':
        return cluster.currentStatus === 'fix_inputs';
      case 'hold':
        return cluster.currentStatus === 'hold';
      case 'portfolio_guidance':
        return cluster.currentStatus === 'portfolio_guidance';
      case 'research':
        return cluster.currentStatus === 'research';
      case 'cleanup':
        return cluster.currentStatus === 'cleanup';
      case 'resolved':
        return cluster.currentStatus === 'resolved';
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
        const decisionKind = String(opt.decisionKind || '').toLowerCase();
        switch (statusFilter) {
          case 'live':
            return opt.status === 'needs_approval' || opt.status === 'awaiting_telegram';
          case 'fix_inputs':
            return opt.status === 'advisory' && ['freeze_due_to_low_trust', 'fix_measurement_inputs', 'fix_creative_inputs'].includes(decisionKind);
          case 'hold':
            return opt.status === 'advisory' && decisionKind === 'hold_budget';
          case 'portfolio_guidance':
            return opt.status === 'advisory' && ['reallocate_budget', 'portfolio_scale', 'portfolio_reduce'].includes(decisionKind);
          case 'research':
            return opt.status === 'advisory' && !['freeze_due_to_low_trust', 'fix_measurement_inputs', 'fix_creative_inputs', 'hold_budget', 'reallocate_budget', 'portfolio_scale', 'portfolio_reduce'].includes(decisionKind);
          case 'cleanup':
            return ['delivery_failed', 'execution_failed'].includes(opt.status);
          case 'resolved':
            return opt.status === 'executed' || opt.status === 'rejected' || opt.status === 'expired';
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

    if (cluster.stateReason) parts.push(tr(cluster.stateReason, cluster.stateReason));
    if (counts.delivery_failed) parts.push(tr(`${formatCount(counts.delivery_failed)} delivery failure`, `${formatCount(counts.delivery_failed)}건 전달 실패`));
    if (counts.execution_failed) parts.push(tr(`${formatCount(counts.execution_failed)} execution failure`, `${formatCount(counts.execution_failed)}건 실행 실패`));
    if (counts.expired) parts.push(tr(`${formatCount(counts.expired)} expired`, `${formatCount(counts.expired)}건 만료`));
    if (counts.rejected) parts.push(tr(`${formatCount(counts.rejected)} rejected`, `${formatCount(counts.rejected)}건 거절`));
    if (counts.executed) parts.push(tr(`${formatCount(counts.executed)} executed`, `${formatCount(counts.executed)}건 실행`));
    if (counts.advisory && ['fix_inputs', 'hold', 'portfolio_guidance', 'research'].includes(cluster.currentStatus)) {
      parts.push(tr(`${formatCount(counts.advisory)} advisory`, `${formatCount(counts.advisory)}건 참고용`));
    }

    return parts.join(' · ');
  }

  function buildClusterMeta(cluster) {
    const items = [];

    items.push(`<span class="opt-cluster-stat"><strong>${esc(formatCount(cluster.count || 0))}</strong>${esc(tr('rows', '행'))}</span>`);
    if (cluster.recentCount > 0) {
      items.push(`<span class="opt-cluster-stat"><strong>${esc(formatCount(cluster.recentCount || 0))}</strong>${esc(tr(`in ${cluster.windowHours || 72}h`, `${cluster.windowHours || 72}시간`))}</span>`);
    }
    if (cluster.actionableNow) {
      items.push(`<span class="opt-cluster-stat"><strong>${esc(formatCount(cluster.openCount || 0))}</strong>${esc(tr('live', '라이브'))}</span>`);
    }
    if (cluster.currentStatus === 'cleanup') {
      items.push(`<span class="opt-cluster-stat"><strong>${esc(tr('Cleanup', '정리'))}</strong>${esc(tr(`${cluster.backlogAgeHours || 0}h age`, `${cluster.backlogAgeHours || 0}시간`))}</span>`);
    }
    if (cluster.currentStatus === 'hold') {
      items.push(`<span class="opt-cluster-stat"><strong>${esc(tr('No change', '변경 없음'))}</strong>${esc(tr('Meta keeps running', 'Meta 계속 집행'))}</span>`);
    }
    if (cluster.currentStatus === 'portfolio_guidance') {
      items.push(`<span class="opt-cluster-stat"><strong>${esc(tr('Macro plan', '거시 계획'))}</strong>${esc(tr('Next planning pass', '다음 운영 사이클'))}</span>`);
    }

    return items.join('');
  }

  function renderClusterCard(cluster, options = {}) {
    const type = safeOptType(cluster.type);
    const priority = priorityMeta(cluster.priority);
    const status = statusMeta(cluster.currentStatus);
    const lastSeen = formatRelative(cluster.lastSeenAt);
    const firstSeen = formatRelative(cluster.firstSeenAt);
    const queueAction = options.showAction && cluster.currentStatus === 'action_now'
      ? `<button class="btn btn-sm btn-primary execute-opt" data-opt-id="${esc(cluster.latestOptimizationId)}">${esc(tr('Request approval', '승인 요청'))}</button>`
      : '';
    const awaitingBadge = options.showAction && cluster.currentStatus === 'awaiting_reply'
      ? `<span class="badge badge-info">${esc(tr('Awaiting reply', '응답 대기'))}</span>`
      : '';
    const callout = cluster.count > 1
      ? tr(
          `${formatCount(cluster.count)} raw rows collapsed into one decision family`,
          `원시 ${formatCount(cluster.count)}행을 하나의 의사결정 패밀리로 압축`
        )
      : '';
    const stateCallout = cluster.currentStatus === 'cleanup'
      ? tr(
          'This family is shown for cleanup only. It is not asking for approval right now.',
          '이 패밀리는 정리용으로만 표시됩니다. 지금 승인 요청 중인 항목이 아닙니다.'
        )
      : cluster.currentStatus === 'hold'
      ? tr(
          'This is an explicit no-change state. The system is telling you to leave delivery alone for now.',
          '이것은 명시적인 변경 없음 상태입니다. 지금은 집행을 그대로 두라는 뜻입니다.'
        )
      : cluster.currentStatus === 'portfolio_guidance'
      ? tr(
          'This is macro guidance for the next planning pass. It should shape budget direction, but it is not a live approval queue.',
          '이것은 다음 운영 사이클을 위한 거시 가이드입니다. 예산 방향에는 반영해야 하지만 라이브 승인 큐는 아닙니다.'
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
          ${stateCallout ? `<div class="opt-callout">${esc(stateCallout)}</div>` : ''}
          <div class="opt-time">${esc(tr(`First seen ${firstSeen} · Last seen ${lastSeen}`, `최초 ${firstSeen} · 최근 ${lastSeen}`))}</div>
        </div>
      </div>
    `;
  }

  function renderSummary(aiOps) {
    const summary = aiOps?.summary || {};
    const quality = aiOps?.quality || {};
    const qualitySummary = quality.summary || {};

    const valueMap = {
      optActionNow: summary.actionNowFamilies ?? 0,
      optBacklog: summary.fixInputFamilies ?? 0,
      optFriction: summary.holdFamilies ?? 0,
      optPortfolio: summary.portfolioGuidanceFamilies ?? 0,
    };

    Object.entries(valueMap).forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = typeof value === 'number' ? formatCount(value) : value;
    });

    const metaMap = {
      optActionNowMeta: tr(
        `${formatCount(summary.actionNowItems || 0)} live approvals still inside the review window`,
        `검토 창 안에 있는 라이브 승인 ${formatCount(summary.actionNowItems || 0)}건`
      ),
      optBacklogMeta: tr(
        `${formatCount(summary.fixInputFamilies || 0)} input fixes · ${formatCount(summary.cleanupFamilies || 0)} cleanup families behind them`,
        `입력 수정 ${formatCount(summary.fixInputFamilies || 0)}개 · 뒤에 정리 패밀리 ${formatCount(summary.cleanupFamilies || 0)}개`
      ),
      optFrictionMeta: tr(
        `${formatCount(summary.holdFamilies || 0)} explicit no-change states`,
        `명시적 유지 상태 ${formatCount(summary.holdFamilies || 0)}개`
      ),
      optPortfolioMeta: tr(
        `${formatCount(summary.portfolioGuidanceFamilies || 0)} macro advisories for the next planning pass`,
        `다음 운영 사이클용 거시 가이드 ${formatCount(summary.portfolioGuidanceFamilies || 0)}개`
      ),
    };

    Object.entries(metaMap).forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    });
  }

  function renderLaneEmpty(title, body) {
    return `
      <div class="ai-ops-lane-empty">
        <strong>${esc(title)}</strong>
        <p>${esc(body)}</p>
      </div>
    `;
  }

  function renderFocus(aiOps) {
    const card = document.getElementById('aiOpsFocusCard');
    const titleEl = document.getElementById('optHeroTitle');
    const bodyEl = document.getElementById('optHeroBody');
    const tagsEl = document.getElementById('optHeroTags');
    const nextEl = document.getElementById('optHeroNext');
    const nextMetaEl = document.getElementById('optHeroNextMeta');
    const ignoreEl = document.getElementById('optHeroIgnore');
    const ignoreMetaEl = document.getElementById('optHeroIgnoreMeta');
    if (!card || !titleEl || !bodyEl || !tagsEl || !nextEl || !nextMetaEl || !ignoreEl || !ignoreMetaEl) return;

    const summary = aiOps?.summary || {};
    const immediate = aiOps?.queue?.immediate || [];
    const fixInputs = aiOps?.queue?.fixInputs || [];
    const holdQueue = aiOps?.queue?.hold || [];
    const portfolioQueue = aiOps?.queue?.portfolioGuidance || [];
    const cleanupQueue = aiOps?.queue?.cleanup || [];
    const latestChange = aiOps?.activity?.[0];
    const topImmediate = immediate[0];
    const topFixInput = fixInputs[0];
    const topHold = holdQueue[0];
    const topPortfolio = portfolioQueue[0];
    const topCleanup = cleanupQueue[0];

    let tone;
    let title;
    let body;
    let nextMove;
    let nextMoveMeta;
    let ignoreNow;
    let ignoreNowMeta;

    if (summary.actionNowFamilies > 0 && topImmediate) {
      tone = 'warning';
      title = tr('Act on the live queue first', '라이브 큐부터 처리하세요');
      body = tr(
        `${formatCount(summary.actionNowFamilies)} budget or stop-loss decisions are still inside the review window. Start with ${topImmediate.targetName || 'the top item'} before looking at input fixes or portfolio guidance.`,
        `검토 창 안에 아직 ${formatCount(summary.actionNowFamilies)}개 예산/가드레일 결정 패밀리가 있습니다. 입력 수정이나 포트폴리오 가이드보다 먼저 ${topImmediate.targetName || '최상단 항목'}부터 보세요.`
      );
      nextMove = topImmediate.targetName || tr('Open the top live decision', '상단 라이브 결정을 열기');
      nextMoveMeta = localizeOptimizationText(topImmediate.action || topImmediate.reason || tr('Review the recommendation and decide.', '추천 내용을 검토하고 결정하세요.'));
      ignoreNow = tr('Hold states and portfolio guidance can wait', '유지 상태와 포트폴리오 가이드는 나중에');
      ignoreNowMeta = tr(
        'Do not spend attention on audit history until the live queue is clear.',
        '라이브 큐가 비기 전까지는 감사용 이력에 주의를 뺏기지 않아도 됩니다.'
      );
    } else if ((summary.fixInputFamilies || 0) > 0 && topFixInput) {
      tone = 'calm';
      title = tr('No live approvals, fix the inputs next', '라이브 승인은 없지만 입력 수정이 먼저입니다');
      body = tr(
        `${formatCount(summary.fixInputFamilies)} family is asking for better inputs or stronger measurement trust before the next budget move.`,
        `다음 예산 변경 전에 ${formatCount(summary.fixInputFamilies)}개 패밀리가 더 나은 입력이나 더 강한 측정 신뢰를 요구하고 있습니다.`
      );
      nextMove = topFixInput.targetName || tr('Fix the top input issue', '최상단 입력 이슈 수정');
      nextMoveMeta = localizeOptimizationText(topFixInput.reason || tr('Improve trust or creative inputs before scaling.', '스케일 전에 신뢰나 크리에이티브 입력을 개선하세요.'));
      ignoreNow = tr('Do not over-edit delivery', '집행을 과도하게 건드리지 마세요');
      ignoreNowMeta = tr(
        'The point here is to improve inputs, not to compensate for Meta by making more delivery edits.',
        '여기서 중요한 것은 입력을 개선하는 것이지, 집행 편집을 늘려 Meta를 대신하려는 것이 아닙니다.'
      );
    } else if ((summary.holdFamilies || 0) > 0 && topHold) {
      tone = 'calm';
      title = tr('Nothing to change right now', '지금 바꿀 것은 없습니다');
      body = tr(
        `${formatCount(summary.holdFamilies)} family is explicitly telling you to leave Meta delivery alone and wait for a material shift.`,
        `${formatCount(summary.holdFamilies)}개 패밀리가 Meta 집행을 그대로 두고 의미 있는 변화가 올 때까지 기다리라고 명시적으로 말하고 있습니다.`
      );
      nextMove = topHold.targetName || tr('Respect the hold state', '유지 상태 존중');
      nextMoveMeta = localizeOptimizationText(topHold.reason || tr('No budget change is warranted in the current window.', '현재 구간에서는 예산 변경이 타당하지 않습니다.'));
      ignoreNow = tr('You do not need a heroic tweak', '억지로 손볼 필요는 없습니다');
      ignoreNowMeta = tr(
        'A clear hold state is a decision too. Let Meta keep doing the auction-level work.',
        '명확한 유지 상태도 하나의 결정입니다. 경매 수준의 일은 Meta가 계속 하게 두세요.'
      );
    } else if ((summary.portfolioGuidanceFamilies || 0) > 0 && topPortfolio) {
      tone = 'neutral';
      title = tr('No urgent blocker, review portfolio guidance next', '긴급한 차단 요인은 없고 포트폴리오 가이드를 다음으로 보세요');
      body = tr(
        `${formatCount(summary.portfolioGuidanceFamilies)} macro guidance family is ready for the next planning pass. Use it to shape how much room Meta gets, not to micromanage delivery.`,
        `다음 운영 사이클을 위한 거시 가이드 패밀리 ${formatCount(summary.portfolioGuidanceFamilies)}개가 준비되어 있습니다. 집행을 미세 조정하는 대신 Meta에 어느 정도 여지를 줄지 결정할 때 사용하세요.`
      );
      nextMove = topPortfolio.targetName || tr('Review the top portfolio advisory', '상단 포트폴리오 가이드 검토');
      nextMoveMeta = localizeOptimizationText(topPortfolio.reason || topPortfolio.action || tr('Use this to shape the next budget planning pass.', '다음 예산 운영 사이클을 잡는 데 사용하세요.'));
      ignoreNow = tr('Archive and research can stay folded', '아카이브와 연구는 접어둬도 됩니다');
      ignoreNowMeta = tr(
        'This is planning guidance, not a live approval queue. Stay at the macro level.',
        '이것은 라이브 승인 큐가 아니라 계획 가이드입니다. 거시 수준에서 보세요.'
      );
    } else if ((summary.cleanupFamilies || 0) > 0 && topCleanup) {
      tone = 'neutral';
      title = tr('Decision flow is clear, but cleanup remains', '의사결정 흐름은 비었지만 정리는 남아 있습니다');
      body = tr(
        `${formatCount(summary.cleanupFamilies)} family is only cleanup now: stale approvals, delivery failures, or old audit clutter.`,
        `${formatCount(summary.cleanupFamilies)}개 패밀리는 이제 정리용입니다. 오래된 승인, 전달 실패, 혹은 감사용 잡음입니다.`
      );
      nextMove = topCleanup.targetName || tr('Clear the top cleanup family', '최상단 정리 패밀리 정리');
      nextMoveMeta = buildClusterStatusLine(topCleanup) || localizeOptimizationText(topCleanup.reason || tr('Clean up stale approval history or delivery failures.', '오래된 승인 이력이나 전달 실패를 정리하세요.'));
      ignoreNow = tr('No live budget decision is waiting', '대기 중인 라이브 예산 결정은 없습니다');
      ignoreNowMeta = tr(
        'This is hygiene work, not strategy. Clear it when convenient.',
        '이것은 전략이 아니라 위생 작업입니다. 편한 때 정리하면 됩니다.'
      );
    } else if ((summary.recentChangeCount || 0) > 0 || (summary.resolvedFamilies || 0) > 0) {
      tone = 'good';
      title = tr('Nothing urgent, just recent movement to review', '긴급한 건 없고 최근 변화만 확인하면 됩니다');
      body = tr(
        `${formatCount(summary.recentChangeCount || 0)} material change${(summary.recentChangeCount || 0) === 1 ? '' : 's'} landed in the recent window, but there is no open action queue competing for attention.`,
        `최근 창에 의미 있는 변화 ${formatCount(summary.recentChangeCount || 0)}개가 있었지만, 주의를 경쟁하는 열린 액션 큐는 없습니다.`
      );
      nextMove = latestChange?.title || tr('Scan the recent changes list', '최근 변화 목록 확인');
      nextMoveMeta = latestChange?.detail || tr('Confirm whether the change affects today’s decisions.', '이 변화가 오늘 결정에 영향을 주는지 확인하세요.');
      ignoreNow = tr('Blocked history can wait', '막힌 이력은 나중에');
      ignoreNowMeta = tr(
        'The page is calm enough that you can stay at the top of the workflow and skip deeper audit sections.',
        '페이지가 충분히 차분하니 워크플로 상단만 보고 깊은 감사 섹션은 건너뛰어도 됩니다.'
      );
    } else {
      tone = 'good';
      title = tr('Clear runway right now', '지금은 깔끔한 상태입니다');
      body = tr(
        'No live approvals, fix-input alerts, or hold exceptions are competing for attention. You can treat Decision Center as quiet until a fresh state change lands.',
        '라이브 승인, 입력 수정 알림, 유지 예외가 모두 비어 있습니다. 새로운 상태 변화가 생길 때까지 의사결정 센터는 조용한 상태로 봐도 됩니다.'
      );
      nextMove = tr('Stay on the top workflow', '상단 워크플로만 보면 됩니다');
      nextMoveMeta = tr(
        'If anything changes, it will show up in the action lane or recent changes before it matters elsewhere.',
        '무언가 바뀌면 다른 곳보다 먼저 액션 레인이나 최근 변화에 나타납니다.'
      );
      ignoreNow = tr('Archive can stay folded', '아카이브는 접어둬도 됩니다');
      ignoreNowMeta = tr(
        'Use the deeper sections only when you need audit detail or older raw history.',
        '감사용 세부 내용이나 오래된 원시 이력이 필요할 때만 아래 섹션을 열면 됩니다.'
      );
    }

    const chips = [
      { label: tr('Live', '라이브'), rawValue: summary.actionNowFamilies || 0 },
      { label: tr('Fix inputs', '입력 수정'), rawValue: summary.fixInputFamilies || 0 },
      { label: tr('Hold', '유지'), rawValue: summary.holdFamilies || 0 },
      { label: tr('Portfolio guidance', '포트폴리오 가이드'), rawValue: summary.portfolioGuidanceFamilies || 0 },
    ].filter(chip => chip.rawValue > 0 || chip.label === tr('Live', '라이브'));

    card.dataset.tone = tone;
    titleEl.textContent = title;
    bodyEl.textContent = body;
    nextEl.textContent = nextMove;
    nextMetaEl.textContent = nextMoveMeta;
    ignoreEl.textContent = ignoreNow;
    ignoreMetaEl.textContent = ignoreNowMeta;
    tagsEl.innerHTML = chips.map(chip => `
      <span class="ai-ops-focus-chip">
        <strong>${esc(formatCount(chip.rawValue))}</strong>
        <span>${esc(chip.label)}</span>
      </span>
    `).join('');
  }

  function renderSectionSummaries(aiOps) {
    const archiveEl = document.getElementById('optArchiveSummary');

    if (archiveEl) {
      archiveEl.textContent = tr(
        `${formatCount(aiOps?.clusters?.length || 0)} families hidden · open only for audit detail`,
        `숨겨진 패밀리 ${formatCount(aiOps?.clusters?.length || 0)}개 · 감사 세부 내용이 필요할 때만 열기`
      );
    }
  }

  function renderQueue(aiOps) {
    const container = document.getElementById('optimizationQueue');
    const statsEl = document.getElementById('optQueueStats');
    const entries = aiOps?.queue?.immediate || [];

    if (statsEl) {
      const openFamilies = entries.filter(cluster => cluster.currentStatus === 'action_now').length;
      const awaitingFamilies = entries.filter(cluster => cluster.currentStatus === 'awaiting_reply').length;
      statsEl.textContent = tr(
        `${formatCount(openFamilies)} decide now · ${formatCount(awaitingFamilies)} awaiting reply`,
        `${formatCount(openFamilies)}개 지금 결정 · ${formatCount(awaitingFamilies)}개 응답 대기`
      );
    }

    if (!container) return;
    if (entries.length === 0) {
      container.innerHTML = renderLaneEmpty(
        tr('No live decisions right now', '지금 처리할 라이브 결정이 없습니다'),
        tr(
          'Nothing is currently asking for approval. If trust or creative supply still needs work, use the fix-inputs lane beside this card instead of digging through archive history.',
          '현재 승인 요청 중인 항목이 없습니다. 신뢰나 크리에이티브 공급 정리가 필요하다면 아카이브를 뒤지기보다 옆 입력 수정 레인을 보세요.'
        )
      );
      return;
    }

    container.innerHTML = entries.map(cluster => renderClusterCard(cluster, { showAction: true })).join('');
    if (window.lucide) lucide.createIcons();
    bindExecuteButtons(container);
  }

  function renderBacklog(aiOps) {
    const container = document.getElementById('optimizationBacklog');
    const statsEl = document.getElementById('optBacklogStats');
    const entries = aiOps?.queue?.fixInputs || [];

    if (statsEl) {
      statsEl.textContent = tr(
        `${formatCount(entries.length)} fix-input families`,
        `${formatCount(entries.length)}개 입력 수정 패밀리`
      );
    }

    if (!container) return;
    if (entries.length === 0) {
      container.innerHTML = renderLaneEmpty(
        tr('Inputs are clear right now', '지금은 고칠 입력이 없습니다'),
        tr(
          'Measurement trust and creative supply are not blocking the next budget decision. This lane should stay quiet unless something upstream needs fixing.',
          '측정 신뢰도나 크리에이티브 공급이 다음 예산 결정을 막고 있지 않습니다. 상위 입력을 고쳐야 할 때만 이 레인이 시끄러워져야 합니다.'
        )
      );
      return;
    }

    container.innerHTML = entries.map(cluster => renderClusterCard(cluster)).join('');
    if (window.lucide) lucide.createIcons();
  }

  function renderHold(aiOps) {
    const container = document.getElementById('optimizationHold');
    const statsEl = document.getElementById('optHoldStats');
    const entries = aiOps?.queue?.hold || [];

    if (statsEl) {
      statsEl.textContent = tr(
        `${formatCount(entries.length)} no-change families`,
        `${formatCount(entries.length)}개 변경 없음 패밀리`
      );
    }

    if (!container) return;
    if (entries.length === 0) {
      container.innerHTML = renderLaneEmpty(
        tr('No explicit hold states right now', '지금은 명시적 유지 상태가 없습니다'),
        tr(
          'If this lane is empty, the system either has a live decision, an input fix, or nothing material to say.',
          '이 레인이 비어 있다면 시스템에는 라이브 결정, 입력 수정, 혹은 말할 만한 변화가 없는 것입니다.'
        )
      );
      return;
    }

    container.innerHTML = entries.map(cluster => renderClusterCard(cluster)).join('');
    if (window.lucide) lucide.createIcons();
  }

  function renderPortfolioGuidance(aiOps) {
    const container = document.getElementById('optimizationPortfolio');
    const statsEl = document.getElementById('optPortfolioStats');
    const entries = aiOps?.queue?.portfolioGuidance || [];

    if (statsEl) {
      statsEl.textContent = tr(
        `${formatCount(entries.length)} macro guidance families`,
        `${formatCount(entries.length)}개 거시 가이드 패밀리`
      );
    }

    if (!container) return;
    if (entries.length === 0) {
      container.innerHTML = renderLaneEmpty(
        tr('No portfolio guidance right now', '지금은 포트폴리오 가이드가 없습니다'),
        tr(
          'If this lane is empty, the system has no macro reallocation or portfolio guardrail advice worth surfacing right now.',
          '이 레인이 비어 있다면 지금 표면에 올릴 만한 거시 재배분 또는 포트폴리오 가드레일 조언이 없는 상태입니다.'
        )
      );
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
      const openish = entries.filter(entry => ['action_now', 'awaiting_reply'].includes(entry.kind)).length;
      const fixInputs = entries.filter(entry => entry.kind === 'fix_inputs').length;
      const hold = entries.filter(entry => entry.kind === 'hold').length;
      const portfolio = entries.filter(entry => entry.kind === 'portfolio_guidance').length;
      const cleanup = entries.filter(entry => entry.kind === 'cleanup').length;
      const resolved = entries.filter(entry => entry.kind === 'resolved').length;
      statsEl.textContent = tr(
        `${formatCount(entries.length)} events · ${formatCount(openish)} live · ${formatCount(fixInputs)} fix inputs · ${formatCount(hold)} hold · ${formatCount(portfolio)} portfolio · ${formatCount(cleanup)} cleanup · ${formatCount(resolved)} resolved`,
        `${formatCount(entries.length)}개 이벤트 · ${formatCount(openish)}개 라이브 · ${formatCount(fixInputs)}개 입력 수정 · ${formatCount(hold)}개 유지 · ${formatCount(portfolio)}개 포트폴리오 · ${formatCount(cleanup)}개 정리 · ${formatCount(resolved)}개 해결`
      );
    }

    if (!container) return;
    if (entries.length === 0) {
      container.innerHTML = renderLaneEmpty(
        tr('No fresh owner-facing changes', '새로운 소유자용 변화가 없습니다'),
        tr(
          'Routine scans may still be running, but nothing material has changed recently enough to deserve space in the main decision flow.',
          '루틴 스캔은 계속 돌아갈 수 있지만, 메인 결정 흐름에 자리를 줄 만큼 최근에 바뀐 중요한 변화는 없습니다.'
        )
      );
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
        <h3>${esc(tr('Diagnostics rail', '진단 레일'))}</h3>
        <div class="opt-header">
          <span class="badge ${qualityBadge.className}">${esc(qualityBadge.label)}</span>
        </div>
        <div class="ai-ops-system-copy">
          ${esc(tr(
            `This is background hygiene, not a decision queue. Use it to spot cleanup debt, background advisories, and scan health.`,
            `여기는 결정 큐가 아니라 배경 위생 정보입니다. 정리 부채, 배경 참고 맥락, 스캔 상태를 볼 때만 사용하세요.`
          ))}
        </div>
        <div class="ai-ops-system-metrics">
          <div class="ai-ops-system-metric">
            <span>${esc(tr('Cleanup families', '정리 패밀리'))}</span>
            <strong>${esc(formatCount(summary.cleanupFamilies || 0))}</strong>
          </div>
          <div class="ai-ops-system-metric">
            <span>${esc(tr('Background advisories', '배경 참고 패밀리'))}</span>
            <strong>${esc(formatCount(summary.researchFamilies || 0))}</strong>
          </div>
          <div class="ai-ops-system-metric">
            <span>${esc(tr('Delivery failures', '전달 실패'))}</span>
            <strong>${esc(formatCount(qualitySummary.failedApprovalRequests || 0))}</strong>
          </div>
          <div class="ai-ops-system-metric">
            <span>${esc(tr('Scans (24h)', '스캔 (24시간)'))}</span>
            <strong>${esc(formatCount(system.scanCount || 0))}</strong>
          </div>
          <div class="ai-ops-system-metric">
            <span>${esc(tr('Quiet scans', '조용한 스캔'))}</span>
            <strong>${esc(formatCount(system.quietScans || 0))}</strong>
          </div>
        </div>
        <div class="opt-time">${esc(tr(
          system.lastScanAt
            ? `Last scan ${formatRelative(system.lastScanAt)} · ${formatCount(system.scansWithSuggestions || 0)} scans with suggestions · ${formatCount(system.lastScanErrors || 0)} errors on the latest run`
            : 'No recent scan data yet.',
          system.lastScanAt
            ? `최근 스캔 ${formatRelative(system.lastScanAt)} · 제안 포함 스캔 ${formatCount(system.scansWithSuggestions || 0)}개 · 최근 실행 오류 ${formatCount(system.lastScanErrors || 0)}건`
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

    ['optTypeFilter', 'optStatusFilter'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const eventName = el.tagName === 'INPUT' ? 'input' : 'change';
      el.addEventListener(eventName, () => {
        refreshOptimizationsPage();
      });
    });
  }

  async function refreshOptimizationsPage() {
    bindOptimizationFilters();

    const [aiOps, optData] = await Promise.all([
      fetchAiOperations(),
      fetchOptimizations(500),
    ]);

    if (!aiOps) return;

    renderFocus(aiOps);
    renderSummary(aiOps);
    renderQueue(aiOps);
    renderBacklog(aiOps);
    renderHold(aiOps);
    renderPortfolioGuidance(aiOps);
    renderActivity(aiOps);
    renderSystemChatter(aiOps);
    renderClusters(aiOps);
    renderRawHistory(optData || { optimizations: [], total: 0 });
    renderSectionSummaries(aiOps);
  }

  live.registerPage('optimizations', {
    refresh: refreshOptimizationsPage,
  });
})();
