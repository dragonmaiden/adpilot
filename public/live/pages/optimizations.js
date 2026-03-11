(function () {
  const live = window.AdPilotLive;
  const { esc, safeOptType, timeSince, formatKrw } = live.shared;
  const { api, fetchOptimizations, fetchSpendDaily, executeOptimization } = live.api;

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

  async function updateOptimizationLog() {
    const data = await fetchOptimizations(30);
    if (!data) return;

    const container = document.getElementById('optimizationLog');
    if (!container) return;

    if (data.optimizations.length === 0) {
      container.innerHTML = '<div class="empty-state">No optimizations yet. Waiting for first scan...</div>';
      return;
    }

    container.innerHTML = data.optimizations.map(opt => {
      const type = safeOptType(opt.type);
      const priority = opt.priority || 'low';
      const iconMap = {
        budget: 'wallet',
        bid: 'gavel',
        creative: 'image',
        status: 'power',
        schedule: 'clock',
        targeting: 'target',
      };
      const priorityClass = {
        critical: 'badge-danger',
        high: 'badge-warning',
        medium: 'badge-info',
        low: '',
      };

      return `
        <div class="optimization-item ${opt.executed ? 'executed' : 'pending'}">
          <div class="opt-icon">
            <i data-lucide="${iconMap[type] || 'zap'}"></i>
          </div>
          <div class="opt-content">
            <div class="opt-header">
              <span class="opt-action">${esc(opt.action)}</span>
              <span class="badge ${priorityClass[priority] || ''}">${esc(priority)}</span>
              ${opt.executed ? '<span class="badge badge-success">Executed</span>' : `<button class="btn btn-sm btn-primary execute-opt" data-opt-id="${esc(opt.id)}">Execute</button>`}
            </div>
            <div class="opt-target">${esc(opt.targetName)}</div>
            <div class="opt-reason">${esc(opt.reason)}</div>
            <div class="opt-impact">${esc(opt.impact)}</div>
            <div class="opt-time">${timeSince(new Date(opt.timestamp))}</div>
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide) {
      lucide.createIcons();
    }

    container.querySelectorAll('.execute-opt').forEach(btn => {
      btn.addEventListener('click', async event => {
        const optId = event.target.dataset.optId;
        event.target.textContent = 'Sending approval...';
        event.target.disabled = true;
        const result = await executeOptimization(optId);
        if (result && result.pending) {
          event.target.textContent = '⏳ Check Telegram';
          event.target.title = 'Approval request sent to Telegram.';
        } else if (result && result.success) {
          event.target.textContent = 'Done';
          event.target.classList.remove('btn-primary');
          event.target.classList.add('btn-ghost');
        } else {
          event.target.textContent = 'Failed';
        }
      });
    });

    const statsEl = document.getElementById('optStats');
    if (statsEl && data.stats) {
      const total = Number(data.total) || 0;
      const executed = Number(data.stats.executed) || 0;
      const pending = Number(data.stats.pending) || 0;
      statsEl.innerHTML = `
        <span>Total: ${total}</span> ·
        <span>Executed: ${executed}</span> ·
        <span>Pending: ${pending}</span>
      `;
    }
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
