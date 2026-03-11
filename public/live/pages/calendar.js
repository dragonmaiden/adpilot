(function () {
  const live = window.AdPilotLive;
  const { esc, formatSignedKrw, formatKrw, formatUsd, formatPercent, formatCount, humanizeEnum } = live.shared;
  const { fetchCalendarAnalysis } = live.api;

  const KST_TIME_ZONE = 'Asia/Seoul';
  const calendarState = {
    initialized: false,
    anchorMonth: null,
    selectionStart: null,
    selectionEnd: null,
    data: null,
    error: null,
    loading: false,
    requestId: 0,
    dragging: false,
    dragStart: null,
    didDrag: false,
  };

  function isIsoDateKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
  }

  function getKstDateKey() {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: KST_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.formatToParts(new Date());
    const values = {};
    for (const part of parts) {
      if (part.type !== 'literal') {
        values[part.type] = part.value;
      }
    }
    return `${values.year}-${values.month}-${values.day}`;
  }

  function toUtcDate(dateKey) {
    if (!isIsoDateKey(dateKey)) return null;
    const [year, month, day] = String(dateKey).split('-').map(value => Number.parseInt(value, 10));
    return new Date(Date.UTC(year, month - 1, day));
  }

  function fromUtcDate(date) {
    return date instanceof Date && !Number.isNaN(date.getTime())
      ? date.toISOString().slice(0, 10)
      : null;
  }

  function compareDateKeys(left, right) {
    return String(left || '').localeCompare(String(right || ''));
  }

  function getCalendarMonthStart(dateKey) {
    const date = toUtcDate(dateKey);
    if (!date) return null;
    date.setUTCDate(1);
    return fromUtcDate(date);
  }

  function getCalendarMonthEnd(dateKey) {
    const date = toUtcDate(dateKey);
    if (!date) return null;
    date.setUTCMonth(date.getUTCMonth() + 1, 0);
    return fromUtcDate(date);
  }

  function shiftCalendarMonth(dateKey, deltaMonths) {
    const date = toUtcDate(dateKey);
    if (!date) return null;

    const day = date.getUTCDate();
    const shifted = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + deltaMonths, 1));
    const lastDay = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
    shifted.setUTCDate(Math.min(day, lastDay));
    return fromUtcDate(shifted);
  }

  function clampDateKey(dateKey, min, max) {
    if (!isIsoDateKey(dateKey)) return min;
    if (compareDateKeys(dateKey, min) < 0) return min;
    if (compareDateKeys(dateKey, max) > 0) return max;
    return dateKey;
  }

  function enumerateDateKeys(start, end) {
    const dates = [];
    let cursor = start;
    while (cursor && compareDateKeys(cursor, end) <= 0) {
      dates.push(cursor);
      const current = toUtcDate(cursor);
      current.setUTCDate(current.getUTCDate() + 1);
      cursor = fromUtcDate(current);
    }
    return dates;
  }

  function getCalendarWeekday(dateKey) {
    const date = toUtcDate(dateKey);
    return date ? (date.getUTCDay() + 6) % 7 : 0;
  }

  function formatUtcDate(dateKey, options) {
    const date = toUtcDate(dateKey);
    if (!date) return '—';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      ...options,
    }).format(date);
  }

  function formatCalendarRange(start, end) {
    if (!start || !end) return 'Selected range';
    if (start === end) {
      return formatUtcDate(start, { month: 'long', day: 'numeric', year: 'numeric' });
    }
    return `${formatUtcDate(start, { month: 'short', day: 'numeric' })} – ${formatUtcDate(end, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  function formatKstTimestamp(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('en-US', {
      timeZone: KST_TIME_ZONE,
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  function ensureCalendarStateInitialized() {
    if (calendarState.initialized) return;

    const today = getKstDateKey();
    calendarState.anchorMonth = getCalendarMonthStart(today);
    calendarState.selectionStart = today;
    calendarState.selectionEnd = today;
    calendarState.initialized = true;
  }

  function getCalendarVisibleRange() {
    ensureCalendarStateInitialized();
    const anchorMonth = getCalendarMonthStart(calendarState.anchorMonth || getKstDateKey());
    return {
      visibleStart: getCalendarMonthStart(shiftCalendarMonth(anchorMonth, -1)),
      visibleEnd: getCalendarMonthEnd(anchorMonth),
    };
  }

  function syncCalendarSelectionIntoViewport() {
    const { visibleStart, visibleEnd } = getCalendarVisibleRange();
    const fallback = clampDateKey(getKstDateKey(), visibleStart, visibleEnd);

    calendarState.selectionStart = clampDateKey(calendarState.selectionStart || fallback, visibleStart, visibleEnd);
    calendarState.selectionEnd = clampDateKey(calendarState.selectionEnd || calendarState.selectionStart, visibleStart, visibleEnd);

    if (compareDateKeys(calendarState.selectionStart, calendarState.selectionEnd) > 0) {
      const start = calendarState.selectionEnd;
      calendarState.selectionEnd = calendarState.selectionStart;
      calendarState.selectionStart = start;
    }
  }

  function buildClientCalendarMonths(visibleStart, visibleEnd) {
    const months = [];
    let cursor = getCalendarMonthStart(visibleStart);
    const lastMonth = getCalendarMonthStart(visibleEnd);

    while (cursor && compareDateKeys(cursor, lastMonth) <= 0) {
      months.push({
        month: cursor.slice(0, 7),
        label: formatUtcDate(cursor, { month: 'long', year: 'numeric' }),
        start: cursor,
        end: getCalendarMonthEnd(cursor),
      });
      cursor = shiftCalendarMonth(cursor, 1);
    }

    return months;
  }

  function hasFreshCalendarViewportPayload(data) {
    const { visibleStart, visibleEnd } = getCalendarVisibleRange();
    return !!(
      data &&
      data.viewport?.visibleStart === visibleStart &&
      data.viewport?.visibleEnd === visibleEnd
    );
  }

  function hasFreshCalendarSelectionPayload(data) {
    return !!(
      hasFreshCalendarViewportPayload(data) &&
      data.viewport?.selectionStart === calendarState.selectionStart &&
      data.viewport?.selectionEnd === calendarState.selectionEnd
    );
  }

  function getCalendarSelectionMeta(months) {
    const monthLabel = (months || []).map(month => month.label).join(' + ') || 'Calendar';
    const selectionLabel = formatCalendarRange(calendarState.selectionStart, calendarState.selectionEnd);
    return `${monthLabel} · ${selectionLabel} · KST${calendarState.loading ? ' · Updating...' : ''}`;
  }

  function getCalendarDayClasses(dateKey) {
    const classes = [];
    const inRange = compareDateKeys(dateKey, calendarState.selectionStart) >= 0 && compareDateKeys(dateKey, calendarState.selectionEnd) <= 0;
    const isSingle = calendarState.selectionStart === calendarState.selectionEnd && dateKey === calendarState.selectionStart;
    const isStart = dateKey === calendarState.selectionStart;
    const isEnd = dateKey === calendarState.selectionEnd;
    const isToday = dateKey === getKstDateKey();

    if (inRange) classes.push('is-selected', 'is-range');
    if (isStart) classes.push('is-selection-start');
    if (isEnd) classes.push('is-selection-end');
    if (isSingle) classes.push('is-selection-single');
    if (isToday) classes.push('is-today');

    return classes.join(' ');
  }

  function renderCalendarDayCell(dateKey, dayData, spectrum) {
    const data = dayData || {
      revenue: 0,
      trueNetProfit: 0,
      orders: 0,
      refundCount: 0,
      hasCOGS: false,
      revenueIntensity: 0,
    };
    const todayKey = getKstDateKey();
    const isFuture = compareDateKeys(dateKey, todayKey) > 0;
    const isEmptyDay = !isFuture && (data.revenue || 0) === 0 && (data.orders || 0) === 0 && (data.adSpend || 0) === 0 && (data.refundCount || 0) === 0;
    const netProfit = Number(data.trueNetProfit || 0);
    const profitClass = netProfit >= 0 ? 'positive' : 'negative';
    const maxPositiveProfit = Math.max(Number(spectrum?.maxPositiveProfit || 0), 1);
    const maxNegativeLoss = Math.max(Number(spectrum?.maxNegativeLoss || 0), 1);
    const profitSpectrum = netProfit > 0
      ? Math.min(1, netProfit / maxPositiveProfit)
      : netProfit < 0
        ? Math.min(1, Math.abs(netProfit) / maxNegativeLoss)
        : 0;
    const dayToneClass = isFuture
      ? 'profit-breakeven'
      : netProfit > 0
        ? 'profit-positive'
        : netProfit < 0
          ? 'profit-negative'
          : 'profit-breakeven';
    const tintStrength = isFuture
      ? 0
      : netProfit > 0
        ? Math.min(1, 0.08 + profitSpectrum * 0.92)
        : netProfit < 0
          ? Math.min(1, 0.08 + profitSpectrum * 0.92)
          : 0;
    const badges = [];

    if (isFuture) {
      badges.push('<span class="calendar-mini-badge future">Future</span>');
    }

    if ((data.refundCount || 0) > 0) {
      badges.push(`<span class="calendar-mini-badge refund">${formatCount(data.refundCount)} refund${data.refundCount === 1 ? '' : 's'}</span>`);
    }

    if (isEmptyDay) {
      badges.push('<span class="calendar-mini-badge coverage">No data</span>');
    }

    const revenueLabel = isFuture ? '—' : formatKrw(data.revenue || 0);
    const profitLabel = isFuture ? '—' : formatSignedKrw(data.trueNetProfit || 0);
    const orderCount = Number(data.orders || 0);
    const ordersLabel = isFuture
      ? 'Future'
      : `${formatCount(orderCount)} ${orderCount === 1 ? 'order' : 'orders'}`;

    return `
      <button
        type="button"
        class="calendar-day ${dayToneClass} ${getCalendarDayClasses(dateKey)} ${isFuture ? 'is-future' : ''} ${isEmptyDay ? 'is-empty' : ''}"
        data-date="${esc(dateKey)}"
        data-future="${isFuture ? '1' : '0'}"
        style="--calendar-tint-strength:${tintStrength.toFixed(3)}"
      >
        <div class="calendar-day-top">
          <span class="calendar-day-number">${esc(String(Number(dateKey.slice(-2))))}</span>
          ${dateKey === todayKey ? '<span class="calendar-day-label">Today</span>' : ''}
        </div>
        <div class="calendar-day-revenue">${revenueLabel}</div>
        <div class="calendar-day-profit ${profitClass}">${profitLabel}</div>
        <div class="calendar-day-orders">${ordersLabel}</div>
        ${badges.length ? `<div class="calendar-day-badges">${badges.join('')}</div>` : ''}
      </button>
    `;
  }

  function renderCalendarViewport() {
    const viewportEl = document.getElementById('calendarViewport');
    const metaEl = document.getElementById('calendarSelectionMeta');
    if (!viewportEl) return;

    ensureCalendarStateInitialized();
    syncCalendarSelectionIntoViewport();

    const { visibleStart, visibleEnd } = getCalendarVisibleRange();
    const hasFreshViewport = hasFreshCalendarViewportPayload(calendarState.data);
    const months = hasFreshViewport && calendarState.data?.viewport?.months?.length
      ? calendarState.data.viewport.months
      : buildClientCalendarMonths(visibleStart, visibleEnd);

    if (metaEl) {
      metaEl.textContent = getCalendarSelectionMeta(months);
    }

    if (!hasFreshViewport && calendarState.loading) {
      viewportEl.innerHTML = '<div class="empty-state">Loading calendar analysis...</div>';
      return;
    }

    const calendarDays = hasFreshViewport ? (calendarState.data?.calendarDays || []) : [];
    const dayMap = new Map(calendarDays.map(day => [day.date, day]));
    const tintSpectrum = calendarDays.reduce((acc, day) => {
      const netProfit = Number(day?.trueNetProfit || 0);
      if (netProfit > 0) {
        acc.maxPositiveProfit = Math.max(acc.maxPositiveProfit, netProfit);
      } else if (netProfit < 0) {
        acc.maxNegativeLoss = Math.max(acc.maxNegativeLoss, Math.abs(netProfit));
      }
      return acc;
    }, { maxPositiveProfit: 0, maxNegativeLoss: 0 });
    const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    viewportEl.innerHTML = months.map(month => {
      const days = enumerateDateKeys(month.start, month.end);
      const leadingSpaces = getCalendarWeekday(month.start);
      return `
        <div class="calendar-month">
          <div class="calendar-month-header">
            <div>
              <div class="calendar-month-title">${esc(month.label)}</div>
              <div class="calendar-month-note">${formatCount(days.length)} days</div>
            </div>
            <span class="badge badge-neutral">${esc(month.month)}</span>
          </div>
          <div class="calendar-weekdays">
            ${weekdayLabels.map(label => `<div class="calendar-weekday">${label}</div>`).join('')}
          </div>
          <div class="calendar-grid">
            ${Array.from({ length: leadingSpaces }, () => '<div class="calendar-spacer"></div>').join('')}
            ${days.map(dateKey => renderCalendarDayCell(dateKey, dayMap.get(dateKey), tintSpectrum)).join('')}
          </div>
        </div>
      `;
    }).join('');
  }

  function renderCalendarSummaryCard(card) {
    return `
      <div class="kpi-card">
        <div class="kpi-label">${esc(card.label)}</div>
        <div class="kpi-value">${card.value}</div>
        <div class="kpi-delta ${card.tone || 'neutral'}">
          <i data-lucide="${esc(card.icon || 'minus')}"></i>
          <span>${esc(card.sub || '—')}</span>
        </div>
      </div>
    `;
  }

  function renderCalendarWaterfallCard(step) {
    const toneClass = step.tone ? ` ${step.tone}` : '';
    return `
      <div class="calendar-waterfall-card${toneClass}">
        <div class="kpi-label">${esc(step.label)}</div>
        <div class="kpi-value">${step.value}</div>
        <div class="kpi-delta ${step.tone || 'neutral'}">
          <i data-lucide="${esc(step.icon || 'minus')}"></i>
          <span>${esc(step.sub || '—')}</span>
        </div>
      </div>
    `;
  }

  function renderCalendarWaterfall(steps) {
    if (!Array.isArray(steps) || steps.length === 0) return '';

    const rowSize = 4;
    const rows = [];
    for (let index = 0; index < steps.length; index += rowSize) {
      rows.push(steps.slice(index, index + rowSize));
    }

    return `
      <div class="card">
        <div class="card-header">
          <h2>Profit Waterfall</h2>
          <span class="calendar-card-note">Left to right: revenue becomes true net profit after refunds, operating costs, and media spend.</span>
        </div>
        <div class="calendar-waterfall">
          ${rows.map((row, rowIndex) => `
            <div class="calendar-waterfall-row-wrap">
              <div class="calendar-waterfall-row" role="list" style="grid-template-columns:${row.map(() => 'minmax(0, 1fr)').join(' auto ')}">
                ${row.map((step, stepIndex) => `
                  <div class="calendar-waterfall-step" role="listitem">
                    ${renderCalendarWaterfallCard(step)}
                  </div>
                  ${stepIndex < row.length - 1 ? '<div class="calendar-waterfall-arrow" aria-hidden="true"><i data-lucide="arrow-right"></i></div>' : ''}
                `).join('')}
              </div>
              ${rowIndex < rows.length - 1 ? `
                <div class="calendar-waterfall-row-connector" aria-hidden="true">
                  <div class="calendar-waterfall-row-connector-start">
                    <i data-lucide="arrow-right"></i>
                    <span>Next row starts here</span>
                  </div>
                  <div class="calendar-waterfall-row-connector-line"></div>
                  <div class="calendar-waterfall-row-connector-turn">
                    <i data-lucide="corner-down-left"></i>
                  </div>
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderEmptyStateCard(title, body) {
    return `
      <div class="card">
        <div class="card-header">
          <h2>${esc(title)}</h2>
        </div>
        <p class="card-desc">${esc(body)}</p>
      </div>
    `;
  }

  function renderStatusBadge(status) {
    const normalized = String(status || '').toUpperCase();
    const badgeClass = normalized === 'ACTIVE' || normalized === 'OPEN'
      ? 'badge-success'
      : normalized === 'PAUSED'
      ? 'badge-neutral'
      : /(CANCEL|RETURN|REFUND|ERROR|FAILED)/.test(normalized)
      ? 'badge-danger'
      : 'badge-neutral';
    return `<span class="badge ${badgeClass}">${esc(humanizeEnum(status || '—'))}</span>`;
  }

  function renderStatusMixText(statusMix) {
    return (Array.isArray(statusMix) ? statusMix : [])
      .slice(0, 3)
      .map(entry => `${humanizeEnum(entry.status)} ${formatCount(entry.count)}`)
      .join(' · ') || '—';
  }

  function renderCalendarEvent(event) {
    const iconMap = {
      scan: 'radar',
      optimization: 'zap',
      execution: 'send',
      reconciliation_gap: 'shield-alert',
      refund_spike: 'rotate-ccw',
    };
    const statusClass = event?.status === 'ok'
      ? 'ok'
      : event?.status === 'error'
      ? 'error'
      : event?.status === 'warning'
      ? 'warning'
      : '';
    const meta = [];
    if (event?.meta?.targetName) meta.push(esc(event.meta.targetName));
    if (event?.meta?.priority) meta.push(esc(humanizeEnum(event.meta.priority)));
    if (event?.scanId) meta.push(`#${esc(String(event.scanId))}`);
    const summary = event?.type === 'reconciliation_gap'
      ? `Settlement ${formatSignedKrw(event?.meta?.settlementGap || 0)} · Imweb ${formatSignedKrw(event?.meta?.imwebGap || 0)}`
      : (event?.summary || '—');

    return `
      <div class="calendar-event">
        <div class="calendar-event-icon ${statusClass}">
          <i data-lucide="${esc(iconMap[event?.type] || 'activity')}"></i>
        </div>
        <div class="calendar-event-main">
          <div class="calendar-event-title">${esc(event?.title || 'Event')}</div>
          <div class="calendar-event-summary">${esc(summary)}</div>
          ${meta.length > 0 ? `<div class="calendar-event-meta">${meta.join(' · ')}</div>` : ''}
        </div>
        <div class="calendar-event-time">${esc(event?.timestamp ? formatKstTimestamp(event.timestamp) : formatUtcDate(event?.date, { month: 'short', day: 'numeric' }))}</div>
      </div>
    `;
  }

  function renderCalendarSelectionDeck() {
    const container = document.getElementById('calendarSelectionDeck');
    if (!container) return;

    ensureCalendarStateInitialized();
    syncCalendarSelectionIntoViewport();

    const hasFreshSelection = hasFreshCalendarSelectionPayload(calendarState.data);
    if (!hasFreshSelection && calendarState.loading) {
      container.innerHTML = renderEmptyStateCard('Selected Range', 'Refreshing calendar metrics for the selected date range...');
      return;
    }

    if (!hasFreshSelection && calendarState.error) {
      container.innerHTML = renderEmptyStateCard('Selected Range', calendarState.error);
      return;
    }

    if (!calendarState.data || calendarState.data.ready === false || !hasFreshSelection) {
      container.innerHTML = renderEmptyStateCard('Calendar Analysis', 'Calendar analysis is waiting for the first completed scan.');
      return;
    }

    const selection = calendarState.data.selection || {};
    const summary = selection.summary || {};
    const isProfitPositive = (summary.trueNetProfit || 0) >= 0;
    const reconciliation = selection.reconciliation || {};
    const overlap = reconciliation.summary?.overlap || {};

    const waterfallCards = [
      { label: 'Gross Revenue', value: formatKrw(summary.grossRevenue || 0), sub: `${formatCount(summary.recognizedOrders || 0)} recognized orders`, tone: 'positive', icon: 'shopping-bag' },
      { label: 'Refunded', value: formatSignedKrw(-(summary.refundedAmount || 0)), sub: `${formatPercent(summary.refundRate || 0)} refund rate`, tone: (summary.refundedAmount || 0) > 0 ? 'negative' : 'neutral', icon: 'rotate-ccw' },
      { label: 'Net Revenue', value: formatKrw(summary.netRevenue || 0), sub: `${formatCount(summary.dayCount || selection.dayCount || 0)} selected days`, tone: 'positive', icon: 'wallet' },
      { label: 'COGS', value: formatSignedKrw(-(summary.cogs || 0)), sub: `${formatCount(summary.daysWithCOGS || 0)} covered days`, tone: 'negative', icon: 'package' },
      { label: 'Shipping', value: formatSignedKrw(-(summary.shipping || 0)), sub: 'Operational shipping cost', tone: 'negative', icon: 'truck' },
      { label: 'Payment Fees', value: formatSignedKrw(-(summary.paymentFees || 0)), sub: '3.3% applied to net revenue', tone: 'negative', icon: 'credit-card' },
      { label: 'Ad Spend', value: formatSignedKrw(-(summary.adSpendKRW || 0)), sub: `${formatUsd(summary.adSpend || 0, 2)} media spend`, tone: 'negative', icon: 'megaphone' },
      { label: 'True Net Profit', value: formatSignedKrw(summary.trueNetProfit || 0), sub: isProfitPositive ? 'Profit after all deductions' : 'Below break-even after all deductions', tone: isProfitPositive ? 'positive' : 'negative', icon: 'coins' },
    ];

    const summaryCards = [
      { label: 'Margin', value: formatPercent(summary.margin || 0), sub: 'True net profit / net revenue', tone: (summary.margin || 0) >= 0 ? 'positive' : 'negative', icon: 'percent' },
      { label: 'ROAS', value: `${Number(summary.roas || 0).toFixed(2)}x`, sub: 'Net revenue / ad spend', tone: (summary.roas || 0) >= 1 ? 'positive' : 'negative', icon: 'trending-up' },
      { label: 'Recognized Orders', value: formatCount(summary.recognizedOrders || 0), sub: `${formatCount(summary.refundOrders || 0)} refund orders`, tone: 'neutral', icon: 'receipt' },
      { label: 'Refund Rate', value: formatPercent(summary.refundRate || 0), sub: `${formatKrw(summary.refundedAmount || 0)} refunded`, tone: (summary.refundRate || 0) > 10 ? 'negative' : 'neutral', icon: 'percent' },
      { label: 'Cancel Rate', value: formatPercent(summary.cancelRate || 0), sub: `${formatCount(summary.cancelledSections || 0)} of ${formatCount(summary.totalSections || 0)} sections`, tone: (summary.cancelRate || 0) > 10 ? 'negative' : 'neutral', icon: 'x-circle' },
      { label: 'Meta Purchases', value: formatCount(summary.metaPurchases || 0), sub: 'Selected-range campaign insights', tone: 'neutral', icon: 'mouse-pointer-2' },
    ];

    const dailyRows = Array.isArray(selection.days) ? selection.days : [];
    const orderRows = Array.isArray(selection.orders) ? selection.orders : [];
    const productRows = Array.isArray(selection.products) ? selection.products : [];
    const campaignRows = Array.isArray(selection.campaigns) ? selection.campaigns : [];
    const operations = Array.isArray(selection.operations) ? selection.operations : [];

    const dailyBody = dailyRows.length > 0
      ? dailyRows.map(day => `
          <tr>
            <td style="font-weight:600">${esc(formatUtcDate(day.date, { month: 'short', day: 'numeric' }))}</td>
            <td>${formatKrw(day.revenue || 0)}</td>
            <td style="color:var(--color-error)">${formatKrw(day.refunded || 0)}</td>
            <td style="font-weight:600">${formatKrw(day.netRevenue || 0)}</td>
            <td>${formatCount(day.orders || 0)}</td>
            <td>${formatUsd(day.adSpend || 0, 2)}<br><span class="calendar-card-note">${formatKrw(day.adSpendKRW || 0)}</span></td>
            <td>${formatKrw((day.cogs || 0) + (day.shipping || 0))}</td>
            <td>${formatKrw(day.paymentFees || 0)}</td>
            <td style="font-weight:600;color:${(day.trueNetProfit || 0) >= 0 ? 'var(--color-success)' : 'var(--color-error)'}">${formatSignedKrw(day.trueNetProfit || 0)}</td>
            <td>${Number(day.roas || 0).toFixed(2)}x</td>
            <td>${day.hasCOGS ? '<span class="badge badge-success">Covered</span>' : '<span class="badge badge-warning">Pending</span>'}</td>
          </tr>
        `).join('')
      : '<tr><td colspan="11" style="text-align:center;color:var(--color-text-faint);padding:20px">No daily rows in this selection.</td></tr>';

    const orderBody = orderRows.length > 0
      ? orderRows.map(row => `
          <tr>
            <td style="font-weight:600">${esc(formatUtcDate(row.date, { month: 'short', day: 'numeric' }))}</td>
            <td><span style="font-family:var(--font-mono)">${esc(row.orderNo || '—')}</span></td>
            <td>${renderStatusBadge(row.orderStatus)}</td>
            <td>${esc(humanizeEnum(row.paymentMethod || row.pgName || 'Unknown'))}</td>
            <td>${formatKrw(row.paidAmount || 0)}</td>
            <td style="color:var(--color-error)">${formatKrw(row.refundedAmount || 0)}</td>
            <td style="font-weight:600">${formatSignedKrw(row.netRevenue || 0)}</td>
            <td>${formatCount(row.itemCount || 0)}</td>
            <td title="${esc(row.productSummary || '')}">${esc(row.productSummary || '—')}</td>
          </tr>
        `).join('')
      : '<tr><td colspan="9" style="text-align:center;color:var(--color-text-faint);padding:20px">No orders in this selection.</td></tr>';

    const productBody = productRows.length > 0
      ? productRows.map(row => {
          const exactCoverage = !!row.exactCostCoverage;
          const coverageMarkup = exactCoverage
            ? '<span class="calendar-product-coverage exact">Exact</span>'
            : `<span class="calendar-product-coverage partial">${formatPercent((row.coverageRatio || 0) * 100, 0)} covered</span>`;
          return `
            <tr>
              <td style="font-weight:600">${esc(row.productName || '—')}</td>
              <td>${esc(row.brand || '—')}</td>
              <td>${formatCount(row.qty || 0)}</td>
              <td>${formatCount(row.orderCount || 0)}</td>
              <td>${formatKrw(row.itemRevenue || 0)}</td>
              <td>${formatCount(row.refundedOrCanceledQty || 0)}</td>
              <td title="${esc(renderStatusMixText(row.statusMix))}">${esc(renderStatusMixText(row.statusMix))}</td>
              <td>${row.knownCogs != null ? formatKrw(row.knownCogs) : '—'}</td>
              <td>${row.knownShipping != null ? formatKrw(row.knownShipping) : '—'}</td>
              <td>${row.knownProfit != null ? formatSignedKrw(row.knownProfit) : coverageMarkup}</td>
            </tr>
          `;
        }).join('')
      : '<tr><td colspan="10" style="text-align:center;color:var(--color-text-faint);padding:20px">No product rows in this selection.</td></tr>';

    const campaignBody = campaignRows.length > 0
      ? campaignRows.map(row => `
          <tr>
            <td style="font-weight:600">${esc(row.campaignName || row.campaignId || '—')}</td>
            <td>${renderStatusBadge(row.status)}</td>
            <td>${formatUsd(row.spend || 0, 2)}<br><span class="calendar-card-note">${formatKrw(row.spendKRW || 0)}</span></td>
            <td>${formatCount(row.metaPurchases || 0)}</td>
            <td>${formatKrw(row.estimatedRevenue || 0)}</td>
            <td>${formatKrw(row.allocatedCOGS || 0)}</td>
            <td style="font-weight:600;color:${(row.grossProfit || 0) >= 0 ? 'var(--color-success)' : 'var(--color-error)'}">${formatSignedKrw(row.grossProfit || 0)}</td>
            <td>${Number(row.estimatedRoas || 0).toFixed(2)}x</td>
            <td>${formatPercent(row.margin || 0)}</td>
          </tr>
        `).join('')
      : '<tr><td colspan="9" style="text-align:center;color:var(--color-text-faint);padding:20px">No campaign insight rows in this selection.</td></tr>';

    const reconRows = Array.isArray(reconciliation.daily) ? reconciliation.daily : [];
    const reconciliationSummary = reconciliation.ready === false
      ? '<p class="calendar-coverage-note">Settlement reconciliation is unavailable for this environment.</p>'
      : `
        <div class="calendar-reconciliation-grid">
          <div class="calendar-reconciliation-item">
            <div class="calendar-reconciliation-label">Matched Net</div>
            <div class="calendar-reconciliation-value">${formatSignedKrw(overlap.netAmount || 0)}</div>
          </div>
          <div class="calendar-reconciliation-item">
            <div class="calendar-reconciliation-label">Settlement Gaps</div>
            <div class="calendar-reconciliation-value">${formatCount(overlap.unmatchedSettlementCount || 0)}</div>
          </div>
          <div class="calendar-reconciliation-item">
            <div class="calendar-reconciliation-label">Imweb Gaps</div>
            <div class="calendar-reconciliation-value">${formatCount(overlap.unmatchedImwebCount || 0)}</div>
          </div>
          <div class="calendar-reconciliation-item">
            <div class="calendar-reconciliation-label">Method Drift</div>
            <div class="calendar-reconciliation-value">${formatCount(overlap.methodMismatchCount || 0)}</div>
          </div>
        </div>
      `;

    const reconBody = reconRows.length > 0
      ? reconRows.map(day => `
          <tr>
            <td style="font-weight:600">${esc(formatUtcDate(day.date, { month: 'short', day: 'numeric' }))}</td>
            <td>${formatSignedKrw(day.settlement?.netAmount || 0)}</td>
            <td>${formatSignedKrw(day.imweb?.netAmount || 0)}</td>
            <td style="color:var(--color-success)">${formatSignedKrw(day.matched?.netAmount || 0)}</td>
            <td style="color:${(day.unmatchedSettlement?.netAmount || 0) === 0 ? 'var(--color-text)' : 'var(--color-warning)'}">${formatSignedKrw(day.unmatchedSettlement?.netAmount || 0)}</td>
            <td style="color:${(day.unmatchedImweb?.netAmount || 0) === 0 ? 'var(--color-text)' : 'var(--color-warning)'}">${formatSignedKrw(day.unmatchedImweb?.netAmount || 0)}</td>
          </tr>
        `).join('')
      : '<tr><td colspan="6" style="text-align:center;color:var(--color-text-faint);padding:20px">No reconciliation gaps in this selection.</td></tr>';

    container.innerHTML = `
      <div class="card">
        <div class="calendar-detail-head">
          <div>
            <div class="section-kicker">Selected Range</div>
            <div class="calendar-detail-title">${esc(formatCalendarRange(calendarState.selectionStart, calendarState.selectionEnd))}</div>
            <div class="calendar-detail-note">${formatCount(selection.dayCount || 0)} day${selection.dayCount === 1 ? '' : 's'} selected · All dates shown in KST</div>
          </div>
          <div class="calendar-chip-row">
            <span class="calendar-chip ${isProfitPositive ? 'positive' : 'negative'}">${isProfitPositive ? 'Profitable window' : 'Below break-even'}</span>
          </div>
        </div>
      </div>

      ${renderCalendarWaterfall(waterfallCards)}

      <div class="calendar-summary-grid calendar-summary-grid-secondary">
        ${summaryCards.map(renderCalendarSummaryCard).join('')}
      </div>

      <div class="card">
        <div class="card-header">
          <h2>Daily Breakdown</h2>
          <span class="calendar-card-note">${formatCount(dailyRows.length)} rows</span>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Gross</th>
                <th>Refunded</th>
                <th>Net</th>
                <th>Orders</th>
                <th>Ad Spend</th>
                <th>COGS + Ship</th>
                <th>Fees</th>
                <th>True Net</th>
                <th>ROAS</th>
                <th>Coverage</th>
              </tr>
            </thead>
            <tbody>${dailyBody}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2>Orders Ledger</h2>
          <span class="calendar-card-note">${formatCount(orderRows.length)} rows · recognized and non-recognized orders in the selection</span>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Order</th>
                <th>Status</th>
                <th>Payment</th>
                <th>Paid</th>
                <th>Refunded</th>
                <th>Net</th>
                <th>Items</th>
                <th>Products</th>
              </tr>
            </thead>
            <tbody>${orderBody}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2>Product Explorer</h2>
          <span class="calendar-card-note">Exact COGS only appears when <code>date + productName</code> matches the Sheets item rows exactly.</span>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Brand</th>
                <th>Qty</th>
                <th>Orders</th>
                <th>Revenue</th>
                <th>Refund / Cancel Qty</th>
                <th>Status Mix</th>
                <th>COGS</th>
                <th>Shipping</th>
                <th>Profit / Coverage</th>
              </tr>
            </thead>
            <tbody>${productBody}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2>Campaign Performance</h2>
          <span class="calendar-card-note">Revenue, COGS allocation, profit, and ROAS here are estimated from selected-range AOV and Meta purchases.</span>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
                <th>Spend</th>
                <th>Meta Purchases</th>
                <th>Est. Revenue</th>
                <th>Est. COGS</th>
                <th>Est. Profit</th>
                <th>Est. ROAS</th>
                <th>Margin</th>
              </tr>
            </thead>
            <tbody>${campaignBody}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <h2>Operations & Reconciliation Timeline</h2>
            <div class="calendar-card-note">Scans, optimizer actions, execution updates, and reconciliation gaps for the active selection.</div>
          </div>
          <span class="calendar-card-note">${formatCount(operations.length)} events</span>
        </div>
        ${reconciliationSummary}
        <div class="calendar-timeline">
          ${operations.length > 0
            ? operations.map(renderCalendarEvent).join('')
            : '<div class="empty-state">No operations in this selection.</div>'}
        </div>
        <div class="card-header" style="margin-top:16px">
          <h2>Daily Reconciliation Gaps</h2>
          <span class="calendar-card-note">${formatCount(reconRows.length)} rows</span>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Settlement Net</th>
                <th>Imweb Net</th>
                <th>Matched</th>
                <th>Settlement Gap</th>
                <th>Imweb Gap</th>
              </tr>
            </thead>
            <tbody>${reconBody}</tbody>
          </table>
        </div>
      </div>
    `;

    if (window.lucide) {
      lucide.createIcons({ nodes: [container] });
    }
  }

  async function refreshCalendarPage() {
    const viewportEl = document.getElementById('calendarViewport');
    if (!viewportEl) return;

    ensureCalendarStateInitialized();
    syncCalendarSelectionIntoViewport();

    const { visibleStart, visibleEnd } = getCalendarVisibleRange();
    calendarState.loading = true;
    calendarState.error = null;
    renderCalendarViewport();
    renderCalendarSelectionDeck();

    const requestId = ++calendarState.requestId;
    try {
      const data = await fetchCalendarAnalysis({
        visibleStart,
        visibleEnd,
        selectionStart: calendarState.selectionStart,
        selectionEnd: calendarState.selectionEnd,
      });

      if (requestId !== calendarState.requestId) {
        return;
      }

      if (data) {
        calendarState.data = data;
        calendarState.selectionStart = data.viewport?.selectionStart || calendarState.selectionStart;
        calendarState.selectionEnd = data.viewport?.selectionEnd || calendarState.selectionEnd;
        calendarState.error = null;
      } else if (!hasFreshCalendarSelectionPayload(calendarState.data)) {
        calendarState.error = 'Could not refresh calendar metrics right now. Try again in a moment.';
      }
    } catch (err) {
      if (requestId !== calendarState.requestId) {
        return;
      }
      calendarState.error = 'Could not refresh calendar metrics right now. Try again in a moment.';
      console.warn('[LIVE] refreshCalendarPage error:', err.message);
    } finally {
      if (requestId === calendarState.requestId) {
        calendarState.loading = false;
        renderCalendarViewport();
        renderCalendarSelectionDeck();
      }
    }
  }

  function initCalendarPage() {
    if (document.body.dataset.calendarAnalysisReady === 'true') {
      return;
    }

    document.body.dataset.calendarAnalysisReady = 'true';
    ensureCalendarStateInitialized();

    const prevBtn = document.getElementById('calendarPrevBtn');
    const nextBtn = document.getElementById('calendarNextBtn');
    const todayBtn = document.getElementById('calendarTodayBtn');
    const viewportEl = document.getElementById('calendarViewport');

    if (prevBtn) {
      prevBtn.addEventListener('click', async () => {
        calendarState.anchorMonth = shiftCalendarMonth(calendarState.anchorMonth, -1);
        syncCalendarSelectionIntoViewport();
        await refreshCalendarPage();
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', async () => {
        calendarState.anchorMonth = shiftCalendarMonth(calendarState.anchorMonth, 1);
        syncCalendarSelectionIntoViewport();
        await refreshCalendarPage();
      });
    }

    if (todayBtn) {
      todayBtn.addEventListener('click', async () => {
        const today = getKstDateKey();
        calendarState.anchorMonth = getCalendarMonthStart(today);
        calendarState.selectionStart = today;
        calendarState.selectionEnd = today;
        await refreshCalendarPage();
      });
    }

    if (viewportEl) {
      viewportEl.addEventListener('pointerdown', event => {
        const dayEl = event.target.closest('.calendar-day[data-date]');
        if (!dayEl || dayEl.dataset.future === '1') return;

        calendarState.dragging = true;
        calendarState.didDrag = false;
        calendarState.dragStart = dayEl.dataset.date;
      });

      viewportEl.addEventListener('pointerover', event => {
        if (!calendarState.dragging) return;
        const dayEl = event.target.closest('.calendar-day[data-date]');
        if (!dayEl || dayEl.dataset.future === '1') return;

        const currentDate = dayEl.dataset.date;
        if (!currentDate || currentDate === calendarState.selectionEnd) return;

        calendarState.didDrag = currentDate !== calendarState.dragStart;
        if (compareDateKeys(currentDate, calendarState.dragStart) >= 0) {
          calendarState.selectionStart = calendarState.dragStart;
          calendarState.selectionEnd = currentDate;
        } else {
          calendarState.selectionStart = currentDate;
          calendarState.selectionEnd = calendarState.dragStart;
        }
        renderCalendarViewport();
      });

      viewportEl.addEventListener('click', async event => {
        const dayEl = event.target.closest('.calendar-day[data-date]');
        if (!dayEl || dayEl.dataset.future === '1') return;
        if (calendarState.didDrag) {
          calendarState.didDrag = false;
          return;
        }

        calendarState.selectionStart = dayEl.dataset.date;
        calendarState.selectionEnd = dayEl.dataset.date;
        await refreshCalendarPage();
      });
    }

    document.addEventListener('pointerup', async () => {
      if (!calendarState.dragging) return;
      const shouldRefresh = calendarState.didDrag;
      calendarState.dragging = false;
      calendarState.dragStart = null;
      if (shouldRefresh) {
        await refreshCalendarPage();
      }
    });
  }

  live.registerPage('calendar', {
    init: initCalendarPage,
    refresh: refreshCalendarPage,
  });
})();
