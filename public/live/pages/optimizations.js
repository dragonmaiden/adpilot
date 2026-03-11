(function () {
  const live = window.AdPilotLive;
  const { esc, safeOptType, timeSince, formatKrw, tr, getLocale, localizeOptimizationText } = live.shared;
  const { fetchOptimizations, fetchScans, fetchSpendDaily, executeOptimization } = live.api;

  const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
  const ICON_MAP = {
    budget: 'wallet',
    bid: 'gavel',
    creative: 'image',
    status: 'power',
    schedule: 'clock',
    targeting: 'target',
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

  function normalizeActionKey(action) {
    return String(action || '').trim().replace(/\s+/g, ' ').toLowerCase();
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
        return { label: tr('Needs approval', '승인 필요'), className: 'badge-warning' };
      case 'awaiting_telegram':
        return { label: tr('Awaiting Telegram', '텔레그램 응답 대기'), className: 'badge-info' };
      case 'executed':
        return { label: tr('Executed', '실행됨'), className: 'badge-success' };
      case 'rejected':
        return { label: tr('Rejected', '거절됨'), className: 'badge-error' };
      case 'expired':
        return { label: tr('Expired', '만료됨'), className: 'badge-neutral' };
      case 'advisory':
      default:
        return { label: tr('Advisory', '참고용'), className: 'badge-neutral' };
    }
  }

  function getLatestScanId(scansData, optimizations) {
    if (scansData?.lastScan?.scanId) return scansData.lastScan.scanId;
    return (Array.isArray(optimizations) ? optimizations : []).reduce((max, opt) => {
      const scanId = Number(opt.scanId || 0);
      return scanId > max ? scanId : max;
    }, 0);
  }

  function buildGroupKey(opt) {
    return [
      String(opt.type || ''),
      String(opt.level || ''),
      String(opt.targetName || ''),
      normalizeActionKey(opt.action),
      String(opt.status || ''),
    ].join('|');
  }

  function sortOptimizations(left, right) {
    const leftPriority = priorityMeta(left.priority).rank;
    const rightPriority = priorityMeta(right.priority).rank;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return String(right.timestamp || '').localeCompare(String(left.timestamp || ''));
  }

  function getCurrentQueueEntries(optimizations, latestScanId) {
    return (Array.isArray(optimizations) ? optimizations : [])
      .filter(opt => {
        if (!opt || opt.executed || !opt.actionable) return false;
        if (opt.status === 'awaiting_telegram') return true;
        return opt.status === 'needs_approval' && opt.scanId === latestScanId;
      })
      .slice()
      .sort(sortOptimizations);
  }

  function groupOptimizations(entries, typeFilter) {
    const filtered = (Array.isArray(entries) ? entries : [])
      .filter(opt => typeFilter === 'all' || opt.type === typeFilter);
    const groups = new Map();

    for (const opt of filtered) {
      const key = buildGroupKey(opt);
      const current = groups.get(key);
      if (!current) {
        groups.set(key, {
          latest: opt,
          repeats: 1,
          firstSeen: opt.timestamp || null,
        });
        continue;
      }

      current.repeats += 1;
      if (opt.timestamp && (!current.firstSeen || String(opt.timestamp).localeCompare(String(current.firstSeen)) < 0)) {
        current.firstSeen = opt.timestamp;
      }
    }

    return Array.from(groups.values()).sort((left, right) => sortOptimizations(left.latest, right.latest));
  }

  function matchHistoryStatus(opt, statusFilter) {
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
  }

  function getHistoryEntries(optimizations, currentIds) {
    const typeFilter = getTypeFilter();
    const statusFilter = getStatusFilter();
    const excluded = currentIds || new Set();

    return (Array.isArray(optimizations) ? optimizations : [])
      .filter(opt => !excluded.has(opt.id))
      .filter(opt => typeFilter === 'all' || opt.type === typeFilter)
      .filter(opt => matchHistoryStatus(opt, statusFilter))
      .slice()
      .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')));
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

  function renderCurrentQueue(data, scansData) {
    const container = document.getElementById('optimizationQueue');
    const statsEl = document.getElementById('optQueueStats');
    if (!container) return { currentIds: new Set(), needsApprovalCount: 0, awaitingTelegramCount: 0, latestAdvisoryCount: 0 };

    const latestScanId = getLatestScanId(scansData, data.optimizations || []);
    const currentEntries = getCurrentQueueEntries(data.optimizations || [], latestScanId);
    const grouped = groupOptimizations(currentEntries, getTypeFilter());
    const latestNeedsApproval = currentEntries.filter(opt => opt.status === 'needs_approval').length;
    const awaitingTelegram = currentEntries.filter(opt => opt.status === 'awaiting_telegram').length;
    const latestAdvisory = (data.optimizations || []).filter(opt => opt.scanId === latestScanId && opt.status === 'advisory').length;

    if (statsEl) {
      statsEl.textContent = tr(
        `${latestNeedsApproval} ready now · ${awaitingTelegram} awaiting reply · ${latestAdvisory} advisory from latest scan`,
        `즉시 승인 ${latestNeedsApproval.toLocaleString(getLocale())}건 · 응답 대기 ${awaitingTelegram.toLocaleString(getLocale())}건 · 최신 스캔 참고용 ${latestAdvisory.toLocaleString(getLocale())}건`
      );
    }

    if (grouped.length === 0) {
      const advisoryNote = latestAdvisory > 0
        ? tr(` The latest scan produced ${latestAdvisory} advisory suggestion${latestAdvisory === 1 ? '' : 's'} instead.`, ` 최신 스캔에서는 참고용 제안 ${latestAdvisory.toLocaleString(getLocale())}건만 생성되었습니다.`)
        : '';
      container.innerHTML = `<div class="empty-state">${esc(tr('No approval-required items are active right now.', '현재 활성 승인 항목이 없습니다.'))}${esc(advisoryNote)} ${esc(tr('Review the history below for older or advisory suggestions.', '이전 제안이나 참고용 제안은 아래 이력에서 확인하세요.'))}</div>`;
      return {
        currentIds: new Set(),
        needsApprovalCount: latestNeedsApproval,
        awaitingTelegramCount: awaitingTelegram,
        latestAdvisoryCount: latestAdvisory,
      };
    }

    container.innerHTML = grouped.map(group => {
      const opt = group.latest;
      const type = safeOptType(opt.type);
      const priority = priorityMeta(opt.priority);
      const status = statusMeta(opt.status);
      const lastSeen = opt.timestamp ? tr(`Last seen ${timeSince(new Date(opt.timestamp))}`, `최근 확인 ${timeSince(new Date(opt.timestamp))}`) : tr('Timestamp unavailable', '시간 정보 없음');
      const firstSeen = group.firstSeen ? tr(`First logged ${timeSince(new Date(group.firstSeen))}`, `최초 기록 ${timeSince(new Date(group.firstSeen))}`) : tr('Timestamp unavailable', '시간 정보 없음');
      const repeatText = group.repeats > 1 ? tr(`Seen ${group.repeats} times`, `${group.repeats.toLocaleString(getLocale())}회 기록`) : tr('Single current item', '현재 단일 항목');
      const queueAction = opt.status === 'needs_approval'
        ? `<button class="btn btn-sm btn-primary execute-opt" data-opt-id="${esc(opt.id)}">${esc(tr('Send to Telegram', '텔레그램 전송'))}</button>`
        : `<span class="badge badge-info">${esc(tr('Awaiting Telegram', '텔레그램 응답 대기'))}</span>`;

      return `
        <div class="optimization-item grouped ${type}">
          <div class="opt-icon">
            <i data-lucide="${ICON_MAP[type] || 'zap'}"></i>
          </div>
          <div class="opt-content">
            <div class="opt-header">
              <span class="opt-action">${esc(localizeOptimizationText(opt.action))}</span>
              <span class="badge ${priority.className}">${esc(priority.label)}</span>
              <span class="badge ${status.className}">${esc(status.label)}</span>
              ${queueAction}
            </div>
            <div class="opt-target">${esc(opt.targetName || tr('Account-wide', '계정 전체'))}</div>
            <div class="opt-reason">${esc(localizeOptimizationText(opt.reason || tr('No reason provided.', '사유가 제공되지 않았습니다.')))}</div>
            <div class="opt-impact">${esc(localizeOptimizationText(opt.impact || tr('No impact estimate provided.', '영향 추정치가 없습니다.')))}</div>
            <div class="opt-meta">
              <span>${esc(repeatText)}</span>
              <span>${esc(lastSeen)}${opt.scanId ? tr(` · Latest scan ${String(opt.scanId).slice(-6)}`, ` · 최신 스캔 ${String(opt.scanId).slice(-6)}`) : ''}</span>
            </div>
            <div class="opt-time">${esc(`${firstSeen}${opt.executionResult ? ` · ${localizeOptimizationText(opt.executionResult)}` : ''}`)}</div>
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide) {
      lucide.createIcons();
    }
    bindExecuteButtons(container);

    return {
      currentIds: new Set(currentEntries.map(opt => opt.id)),
      needsApprovalCount: latestNeedsApproval,
      awaitingTelegramCount: awaitingTelegram,
      latestAdvisoryCount: latestAdvisory,
    };
  }

  function renderOptimizationHistory(data, currentIds) {
    const container = document.getElementById('optimizationLog');
    const statsEl = document.getElementById('optStats');
    if (!container) return;

    const filtered = getHistoryEntries(data.optimizations || [], currentIds);
    if (statsEl) {
      statsEl.textContent = tr(
        `${filtered.length} shown · ${Number(data.total || 0)} total logged`,
        `${filtered.length.toLocaleString(getLocale())}건 표시 · 총 ${Number(data.total || 0).toLocaleString(getLocale())}건 기록`
      );
    }

    if (filtered.length === 0) {
      container.innerHTML = `<div class="empty-state">${esc(tr('No historical suggestions match the current filters.', '현재 필터와 일치하는 과거 제안이 없습니다.'))}</div>`;
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
            <div class="opt-time">${opt.timestamp ? `${timeSince(new Date(opt.timestamp))}${scanText}${resultText}` : `${tr('Timestamp unavailable', '시간 정보 없음')}${resultText}`}</div>
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide) {
      lucide.createIcons();
    }
  }

  function bindOptimizationFilters() {
    if (document.body.dataset.optFiltersBound === 'true') return;
    document.body.dataset.optFiltersBound = 'true';

    ['optTypeFilter', 'optStatusFilter'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        refreshOptimizationsPage();
      });
    });
  }

  function updateCharts(optData, spendData, queueMeta) {
    if (typeof optTimelineChart !== 'undefined' && optTimelineChart && spendData && spendData.length > 0) {
      const labels = spendData.map(row => {
        const dt = new Date(row.date);
        return dt.toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' });
      });

      if (typeof _candlestickOHLC !== 'undefined') {
        _candlestickOHLC = spendData.map(row => ({ o: row.o, h: row.h, l: row.l, c: row.c }));
      }
      if (typeof _candlestickData !== 'undefined') {
        _candlestickData = spendData;
        _candlestickChanges = spendData.map((row, index) => {
          if (index === 0) return { pct: 0, dir: '' };
          const prev = spendData[index - 1].spend;
          const pct = ((row.spend - prev) / prev * 100).toFixed(1);
          return { pct: Math.abs(pct), dir: row.spend >= prev ? '▲' : '▼' };
        });
      }

      optTimelineChart.data.labels = labels;
      optTimelineChart.data.datasets[0].data = spendData.map(row => row.c);
      optTimelineChart.data.datasets[1].data = spendData.map(row => row.cac);
      const allVals = spendData.flatMap(row => [row.o, row.h, row.l, row.c]);
      const minV = Math.min(...allVals);
      const maxV = Math.max(...allVals);
      const pad = (maxV - minV) * 0.15;
      optTimelineChart.options.scales.y.min = Math.max(0, minV - pad * 2);
      optTimelineChart.options.scales.y.max = maxV + pad;
      optTimelineChart.update();

      renderCandlestickStats(spendData);
    }

    if (optData?.stats) {
      if (typeof optTypeChart !== 'undefined' && optTypeChart) {
        const types = optData.stats.byType || {};
        optTypeChart.data.labels = Object.keys(types).map(type => type.charAt(0).toUpperCase() + type.slice(1));
        optTypeChart.data.datasets[0].data = Object.values(types);
        optTypeChart.update();
      }

      if (typeof optPriorityChart !== 'undefined' && optPriorityChart) {
        const prios = optData.stats.byPriority || {};
        const prioColors = optPriorityChart._prioColors || { critical: '#ef4444', high: '#fb923c', medium: '#20808D', low: '#64748b' };
        optPriorityChart.data.labels = Object.keys(prios).map(priority => priority.charAt(0).toUpperCase() + priority.slice(1));
        optPriorityChart.data.datasets[0].data = Object.values(prios);
        optPriorityChart.data.datasets[0].backgroundColor = Object.keys(prios).map(priority => prioColors[priority] || '#94a3b8');
        optPriorityChart.update();
      }
    }

    const totalEl = document.getElementById('optTotal');
    const execEl = document.getElementById('optExecuted');
    const pendEl = document.getElementById('optPending');
    const awaitingEl = document.getElementById('optAwaiting');
    const advisoryEl = document.getElementById('optAdvisory');

    if (totalEl) totalEl.textContent = optData?.total || 0;
    if (execEl) execEl.textContent = optData?.stats?.executed || 0;
    if (pendEl) pendEl.textContent = queueMeta?.needsApprovalCount || 0;
    if (awaitingEl) awaitingEl.textContent = optData?.stats?.awaitingTelegram || queueMeta?.awaitingTelegramCount || 0;
    if (advisoryEl) advisoryEl.textContent = optData?.stats?.advisory || queueMeta?.latestAdvisoryCount || 0;
  }

  async function refreshOptimizationsPage() {
    bindOptimizationFilters();

    const [optData, spendData, scansData] = await Promise.all([
      fetchOptimizations(500),
      fetchSpendDaily(),
      fetchScans(),
    ]);

    if (!optData) return;

    const queueMeta = renderCurrentQueue(optData, scansData);
    renderOptimizationHistory(optData, queueMeta.currentIds);
    updateCharts(optData, spendData, queueMeta);
  }

  live.registerPage('optimizations', {
    refresh: refreshOptimizationsPage,
  });
})();
