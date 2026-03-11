(function () {
  const live = window.AdPilotLive;
  const { esc, safeOptType, timeSince, formatKrw } = live.shared;
  const { api, fetchOptimizations, fetchSpendDaily, executeOptimization } = live.api;

  const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
  const EXECUTABLE_TYPES = new Set(['budget', 'bid', 'status']);
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
    const peakDate = new Date(peakDay.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

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
      label: normalized.charAt(0).toUpperCase() + normalized.slice(1),
      className: {
        critical: 'badge-danger',
        high: 'badge-warning',
        medium: 'badge-info',
        low: 'badge-neutral',
      }[normalized] || 'badge-neutral',
      rank: PRIORITY_RANK[normalized] ?? PRIORITY_RANK.low,
    };
  }

  function buildGroupKey(opt) {
    return [
      String(opt.type || ''),
      String(opt.level || ''),
      String(opt.targetName || ''),
      normalizeActionKey(opt.action),
    ].join('|');
  }

  function groupOpenOptimizations(opts, typeFilter = 'all') {
    const open = (Array.isArray(opts) ? opts : [])
      .filter(opt => !opt.executed)
      .filter(opt => typeFilter === 'all' || opt.type === typeFilter)
      .slice()
      .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')));

    const groups = new Map();
    for (const opt of open) {
      const key = buildGroupKey(opt);
      const current = groups.get(key);
      if (!current) {
        groups.set(key, {
          latest: opt,
          repeats: 1,
          firstSeen: opt.timestamp || null,
          rawOpenCount: 1,
        });
        continue;
      }

      current.repeats += 1;
      current.rawOpenCount += 1;
      if (opt.timestamp && (!current.firstSeen || String(opt.timestamp).localeCompare(String(current.firstSeen)) < 0)) {
        current.firstSeen = opt.timestamp;
      }
    }

    return {
      rawOpenCount: open.length,
      groups: Array.from(groups.values()).sort((left, right) => {
        const leftPriority = priorityMeta(left.latest.priority).rank;
        const rightPriority = priorityMeta(right.latest.priority).rank;
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
        return String(right.latest.timestamp || '').localeCompare(String(left.latest.timestamp || ''));
      }),
    };
  }

  function getFilteredHistory(opts) {
    const typeFilter = getTypeFilter();
    const statusFilter = getStatusFilter();

    return (Array.isArray(opts) ? opts : []).filter(opt => {
      if (typeFilter !== 'all' && opt.type !== typeFilter) return false;
      if (statusFilter === 'open' && opt.executed) return false;
      if (statusFilter === 'executed' && !opt.executed) return false;
      return true;
    });
  }

  function bindExecuteButtons(scope = document) {
    scope.querySelectorAll('.execute-opt').forEach(button => {
      if (button.dataset.bound === 'true') return;
      button.dataset.bound = 'true';

      button.addEventListener('click', async event => {
        const optId = event.currentTarget.dataset.optId;
        event.currentTarget.textContent = 'Sending approval...';
        event.currentTarget.disabled = true;
        const result = await executeOptimization(optId);
        if (result && result.pending) {
          event.currentTarget.textContent = 'Check Telegram';
          event.currentTarget.title = 'Approval request sent to Telegram.';
        } else if (result && result.success) {
          event.currentTarget.textContent = 'Done';
          event.currentTarget.classList.remove('btn-primary');
          event.currentTarget.classList.add('btn-ghost');
        } else {
          event.currentTarget.textContent = 'Failed';
        }
      });
    });
  }

  function renderOpenQueue(data) {
    const container = document.getElementById('optimizationQueue');
    const statsEl = document.getElementById('optQueueStats');
    if (!container) return;

    const typeFilter = getTypeFilter();
    const grouped = groupOpenOptimizations(data.optimizations || [], typeFilter);
    const groups = grouped.groups;

    if (statsEl) {
      const typeLabel = typeFilter === 'all' ? 'all types' : `${typeFilter} only`;
      statsEl.textContent = `${groups.length} grouped item${groups.length === 1 ? '' : 's'} · ${grouped.rawOpenCount} raw open log${grouped.rawOpenCount === 1 ? '' : 's'} · ${typeLabel}`;
    }

    if (groups.length === 0) {
      container.innerHTML = '<div class="empty-state">No open suggestions match the current filter.</div>';
      return;
    }

    container.innerHTML = groups.map(group => {
      const opt = group.latest;
      const type = safeOptType(opt.type);
      const priority = priorityMeta(opt.priority);
      const canExecute = EXECUTABLE_TYPES.has(opt.type);
      const repeatText = group.repeats > 1
        ? `Seen ${group.repeats} times across scans`
        : 'Single open suggestion';
      const firstSeen = group.firstSeen ? ` · First logged ${timeSince(new Date(group.firstSeen))}` : '';
      const lastSeen = opt.timestamp ? `Last seen ${timeSince(new Date(opt.timestamp))}` : 'Timestamp unavailable';
      const latestScan = opt.scanId ? ` · Latest scan ${String(opt.scanId).slice(-6)}` : '';
      const queueAction = canExecute
        ? `<button class="btn btn-sm btn-primary execute-opt" data-opt-id="${esc(opt.id)}">Send approval</button>`
        : '<span class="badge badge-neutral">Advisory only</span>';

      return `
        <div class="optimization-item grouped ${type}">
          <div class="opt-icon">
            <i data-lucide="${ICON_MAP[type] || 'zap'}"></i>
          </div>
          <div class="opt-content">
            <div class="opt-header">
              <span class="opt-action">${esc(opt.action)}</span>
              <span class="badge ${priority.className}">${esc(priority.label)}</span>
              <span class="badge badge-warning">Open</span>
              ${queueAction}
            </div>
            <div class="opt-target">${esc(opt.targetName || 'Account-wide')}</div>
            <div class="opt-reason">${esc(opt.reason || 'No reason provided.')}</div>
            <div class="opt-impact">${esc(opt.impact || 'No impact estimate provided.')}</div>
            <div class="opt-meta">
              <span>${esc(repeatText)}</span>
              <span>${esc(lastSeen)}${esc(latestScan)}</span>
            </div>
            <div class="opt-time">${esc(group.repeats > 1 ? `${repeatText}${firstSeen}` : lastSeen)}</div>
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide) {
      lucide.createIcons();
    }
    bindExecuteButtons(container);
  }

  function renderOptimizationHistory(data) {
    const container = document.getElementById('optimizationLog');
    const statsEl = document.getElementById('optStats');
    if (!container) return;

    const filtered = getFilteredHistory(data.optimizations || []);
    if (statsEl) {
      statsEl.textContent = `${filtered.length} shown · ${Number(data.total || 0)} total logged`;
    }

    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty-state">No decisions match the current history filters.</div>';
      return;
    }

    container.innerHTML = filtered.map(opt => {
      const type = safeOptType(opt.type);
      const priority = priorityMeta(opt.priority);
      const statusBadge = opt.executed
        ? '<span class="badge badge-success">Executed</span>'
        : '<span class="badge badge-warning">Open</span>';
      const scanText = opt.scanId ? ` · Scan ${String(opt.scanId).slice(-6)}` : '';

      return `
        <div class="optimization-item ${opt.executed ? 'executed' : 'pending'}">
          <div class="opt-icon">
            <i data-lucide="${ICON_MAP[type] || 'zap'}"></i>
          </div>
          <div class="opt-content">
            <div class="opt-header">
              <span class="opt-action">${esc(opt.action)}</span>
              <span class="badge ${priority.className}">${esc(priority.label)}</span>
              ${statusBadge}
            </div>
            <div class="opt-target">${esc(opt.targetName || 'Account-wide')}</div>
            <div class="opt-reason">${esc(opt.reason || 'No reason provided.')}</div>
            <div class="opt-impact">${esc(opt.impact || 'No impact estimate provided.')}</div>
            <div class="opt-time">${opt.timestamp ? `${timeSince(new Date(opt.timestamp))}${scanText}` : 'Timestamp unavailable'}</div>
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

  async function updateOptimizationLog() {
    bindOptimizationFilters();

    const data = await fetchOptimizations(500);
    if (!data) return;

    renderOpenQueue(data);
    renderOptimizationHistory(data);
  }

  async function updateOptTimeline() {
    const spendData = await fetchSpendDaily();

    if (typeof optTimelineChart !== 'undefined' && optTimelineChart && spendData && spendData.length > 0) {
      const labels = spendData.map(row => {
        const dt = new Date(row.date);
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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

    const optData = await fetchOptimizations(500);
    if (optData && optData.stats) {
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

      const totalEl = document.getElementById('optTotal');
      const execEl = document.getElementById('optExecuted');
      const pendEl = document.getElementById('optPending');
      const scansEl = document.getElementById('optScans');
      if (totalEl) totalEl.textContent = optData.total || 0;
      if (execEl) execEl.textContent = optData.stats.executed || 0;
      if (pendEl) pendEl.textContent = optData.stats.pending || 0;
      if (scansEl) {
        const scanData = await api('/scans');
        scansEl.textContent = scanData ? scanData.history.length : 0;
      }
    }
  }

  async function refreshOptimizationsPage() {
    await Promise.all([
      updateOptimizationLog(),
      updateOptTimeline(),
    ]);
  }

  live.registerPage('optimizations', {
    refresh: refreshOptimizationsPage,
  });
})();
