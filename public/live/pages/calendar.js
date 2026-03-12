(function () {
  const live = window.AdPilotLive;
  const { esc, formatSignedKrw, formatKrw, formatUsd, formatPercent, formatCount, humanizeEnum, tr, getLocale, localizeOptimizationText } = live.shared;
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
    return new Intl.DateTimeFormat(getLocale(), {
      timeZone: 'UTC',
      ...options,
    }).format(date);
  }

  function formatCalendarRange(start, end) {
    if (!start || !end) return tr('Selected range', '선택한 범위');
    if (start === end) {
      return formatUtcDate(start, { month: 'long', day: 'numeric', year: 'numeric' });
    }
    return `${formatUtcDate(start, { month: 'short', day: 'numeric' })} – ${formatUtcDate(end, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  function formatKstTimestamp(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString(getLocale(), {
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
    const monthLabel = (months || []).map(month => month.label).join(' + ') || tr('Calendar', '캘린더');
    const selectionLabel = formatCalendarRange(calendarState.selectionStart, calendarState.selectionEnd);
    return `${monthLabel} · ${selectionLabel} · KST${calendarState.loading ? ` · ${tr('Updating...', '업데이트 중...')}` : ''}`;
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
      badges.push(`<span class="calendar-mini-badge future">${esc(tr('Future', '예정'))}</span>`);
    }

    if ((data.refundCount || 0) > 0) {
      badges.push(`<span class="calendar-mini-badge refund">${tr(`${formatCount(data.refundCount)} refund${data.refundCount === 1 ? '' : 's'}`, `환불 ${formatCount(data.refundCount)}건`)}</span>`);
    }

    if (isEmptyDay) {
      badges.push(`<span class="calendar-mini-badge coverage">${esc(tr('No data', '데이터 없음'))}</span>`);
    }

    const revenueLabel = isFuture ? '—' : formatKrw(data.revenue || 0);
    const profitLabel = isFuture ? '—' : formatSignedKrw(data.trueNetProfit || 0);
    const orderCount = Number(data.orders || 0);
    const ordersLabel = isFuture
      ? tr('Future', '예정')
      : tr(`${formatCount(orderCount)} ${orderCount === 1 ? 'order' : 'orders'}`, `주문 ${formatCount(orderCount)}건`);

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
          ${dateKey === todayKey ? `<span class="calendar-day-label">${esc(tr('Today', '오늘'))}</span>` : ''}
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
      ? calendarState.data.viewport.months.map(month => ({
        ...month,
        label: formatUtcDate(month.start, { month: 'long', year: 'numeric' }),
      }))
      : buildClientCalendarMonths(visibleStart, visibleEnd);

    if (metaEl) {
      metaEl.textContent = getCalendarSelectionMeta(months);
    }

    if (!hasFreshViewport && calendarState.loading) {
      viewportEl.innerHTML = `<div class="empty-state">${esc(tr('Loading calendar analysis...', '캘린더 분석 불러오는 중...'))}</div>`;
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
    const weekdayLabels = tr(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], ['월', '화', '수', '목', '금', '토', '일']);

    viewportEl.innerHTML = months.map(month => {
      const days = enumerateDateKeys(month.start, month.end);
      const leadingSpaces = getCalendarWeekday(month.start);
      return `
        <div class="calendar-month">
          <div class="calendar-month-header">
            <div>
              <div class="calendar-month-title">${esc(month.label)}</div>
              <div class="calendar-month-note">${tr(`${formatCount(days.length)} days`, `${formatCount(days.length)}일`)}</div>
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
          <h2>${esc(tr('Profit Waterfall', '수익 워터폴'))}</h2>
          <span class="calendar-card-note">${esc(tr('Left to right: revenue becomes true net profit after refunds, operating costs, and media spend.', '왼쪽에서 오른쪽으로: 매출이 환불, 운영비, 광고비를 거쳐 실질 순이익이 됩니다.'))}</span>
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
                    <span>${esc(tr('Next row starts here', '다음 줄은 여기서 시작'))}</span>
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
    const label = normalized === 'ACTIVE'
      ? tr('Active', '집행중')
      : normalized === 'OPEN'
      ? tr('Open', '오픈')
      : normalized === 'PAUSED'
      ? tr('Paused', '중지')
      : humanizeEnum(status || '—');
    return `<span class="badge ${badgeClass}">${esc(label)}</span>`;
  }

  function renderStatusMixText(statusMix) {
    const statusLabels = {
      active: tr('Active', '집행중'),
      open: tr('Open', '오픈'),
      paused: tr('Paused', '중지'),
      cancelled: tr('Cancelled', '취소'),
      canceled: tr('Canceled', '취소'),
      refund: tr('Refunded', '환불'),
      refunded: tr('Refunded', '환불'),
      returned: tr('Returned', '반품'),
      pending: tr('Pending', '대기'),
      completed: tr('Completed', '완료'),
      paid: tr('Paid', '결제완료'),
    };

    return (Array.isArray(statusMix) ? statusMix : [])
      .slice(0, 3)
      .map(entry => {
        const normalized = String(entry?.status || '').trim().toLowerCase();
        const label = statusLabels[normalized] || humanizeEnum(entry.status);
        return `${label} ${formatCount(entry.count)}`;
      })
      .join(' · ') || '—';
  }

  function translateEventTitle(title) {
    switch (String(title || '')) {
      case 'Scan completed':
        return tr('Scan completed', '스캔 완료');
      case 'Optimization suggested':
        return tr('Optimization suggested', '최적화 제안');
      case 'Optimization executed':
        return tr('Optimization executed', '최적화 실행됨');
      case 'Optimization execution update':
        return tr('Optimization execution update', '최적화 실행 업데이트');
      case 'Settlement gap detected':
        return tr('Settlement gap detected', '정산 차이 감지');
      default:
        return localizeOptimizationText(title);
    }
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
    if (event?.meta?.priority) {
      const priorityLabel = {
        critical: tr('Critical', '치명적'),
        high: tr('High', '높음'),
        medium: tr('Medium', '보통'),
        low: tr('Low', '낮음'),
      }[String(event.meta.priority || '').toLowerCase()] || humanizeEnum(event.meta.priority);
      meta.push(esc(priorityLabel));
    }
    if (event?.scanId) meta.push(`#${esc(String(event.scanId))}`);
    const summary = event?.type === 'reconciliation_gap'
      ? tr(
        `Settlement ${formatSignedKrw(event?.meta?.settlementGap || 0)} · Imweb ${formatSignedKrw(event?.meta?.imwebGap || 0)}`,
        `정산 ${formatSignedKrw(event?.meta?.settlementGap || 0)} · Imweb ${formatSignedKrw(event?.meta?.imwebGap || 0)}`
      )
      : localizeOptimizationText(event?.summary || '—');

    return `
      <div class="calendar-event">
        <div class="calendar-event-icon ${statusClass}">
          <i data-lucide="${esc(iconMap[event?.type] || 'activity')}"></i>
        </div>
        <div class="calendar-event-main">
          <div class="calendar-event-title">${esc(translateEventTitle(event?.title || tr('Event', '이벤트')))}</div>
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
      container.innerHTML = renderEmptyStateCard(tr('Selected Range', '선택한 범위'), tr('Refreshing calendar metrics for the selected date range...', '선택한 날짜 범위의 캘린더 지표를 새로고침 중...'));
      return;
    }

    if (!hasFreshSelection && calendarState.error) {
      container.innerHTML = renderEmptyStateCard(tr('Selected Range', '선택한 범위'), calendarState.error);
      return;
    }

    if (!calendarState.data || calendarState.data.ready === false || !hasFreshSelection) {
      container.innerHTML = renderEmptyStateCard(tr('Calendar Analysis', '캘린더 분석'), tr('Calendar analysis is waiting for the first completed scan.', '첫 완료 스캔을 기다리는 중입니다.'));
      return;
    }

    const selection = calendarState.data.selection || {};
    const summary = selection.summary || {};
    const isProfitPositive = (summary.trueNetProfit || 0) >= 0;
    const reconciliation = selection.reconciliation || {};
    const overlap = reconciliation.summary?.overlap || {};

    const waterfallCards = [
      { label: tr('Gross Revenue', '총매출'), value: formatKrw(summary.grossRevenue || 0), sub: tr(`${formatCount(summary.recognizedOrders || 0)} recognized orders`, `인식 주문 ${formatCount(summary.recognizedOrders || 0)}건`), tone: 'positive', icon: 'shopping-bag' },
      { label: tr('Refunded', '환불'), value: formatSignedKrw(-(summary.refundedAmount || 0)), sub: tr(`${formatPercent(summary.refundRate || 0)} refund rate`, `환불률 ${formatPercent(summary.refundRate || 0)}`), tone: (summary.refundedAmount || 0) > 0 ? 'negative' : 'neutral', icon: 'rotate-ccw' },
      { label: tr('Net Revenue', '순매출'), value: formatKrw(summary.netRevenue || 0), sub: tr(`${formatCount(summary.dayCount || selection.dayCount || 0)} selected days`, `선택 일수 ${formatCount(summary.dayCount || selection.dayCount || 0)}일`), tone: 'positive', icon: 'wallet' },
      {
        label: 'COGS',
        value: formatSignedKrw(-(summary.cogs || 0)),
        sub: Number(summary.daysWithPartialCOGS || 0) > 0
          ? tr(
            `${formatCount(summary.daysWithCOGS || 0)} covered · ${formatCount(summary.daysWithPartialCOGS || 0)} partial days`,
            `완전 커버 ${formatCount(summary.daysWithCOGS || 0)}일 · 부분 커버 ${formatCount(summary.daysWithPartialCOGS || 0)}일`
          )
          : tr(`${formatCount(summary.daysWithCOGS || 0)} covered days`, `커버 일수 ${formatCount(summary.daysWithCOGS || 0)}일`),
        tone: 'negative',
        icon: 'package',
      },
      { label: tr('Shipping', '배송비'), value: formatSignedKrw(-(summary.shipping || 0)), sub: tr('Operational shipping cost', '운영 배송비'), tone: 'negative', icon: 'truck' },
      { label: tr('Payment Fees', '결제 수수료'), value: formatSignedKrw(-(summary.paymentFees || 0)), sub: tr('3.3% applied to net revenue', '순매출 기준 3.3% 적용'), tone: 'negative', icon: 'credit-card' },
      { label: tr('Ad Spend', '광고비'), value: formatSignedKrw(-(summary.adSpendKRW || 0)), sub: tr(`${formatUsd(summary.adSpend || 0, 2)} media spend`, `광고비 ${formatUsd(summary.adSpend || 0, 2)}`), tone: 'negative', icon: 'megaphone' },
      { label: tr('True Net Profit', '실질 순이익'), value: formatSignedKrw(summary.trueNetProfit || 0), sub: isProfitPositive ? tr('Profit after all deductions', '모든 차감 후 수익') : tr('Below break-even after all deductions', '모든 차감 후 손익분기 이하'), tone: isProfitPositive ? 'positive' : 'negative', icon: 'coins' },
    ];

    const summaryCards = [
      { label: tr('Margin', '마진'), value: formatPercent(summary.margin || 0), sub: tr('True net profit / net revenue', '실질 순이익 / 순매출'), tone: (summary.margin || 0) >= 0 ? 'positive' : 'negative', icon: 'percent' },
      { label: 'ROAS', value: `${Number(summary.roas || 0).toFixed(2)}x`, sub: tr('Net revenue / ad spend', '순매출 / 광고비'), tone: (summary.roas || 0) >= 1 ? 'positive' : 'negative', icon: 'trending-up' },
      { label: tr('Recognized Orders', '인식 주문'), value: formatCount(summary.recognizedOrders || 0), sub: tr(`${formatCount(summary.refundOrders || 0)} refund orders`, `환불 주문 ${formatCount(summary.refundOrders || 0)}건`), tone: 'neutral', icon: 'receipt' },
      { label: tr('Refund Rate', '환불률'), value: formatPercent(summary.refundRate || 0), sub: tr(`${formatKrw(summary.refundedAmount || 0)} refunded`, `${formatKrw(summary.refundedAmount || 0)} 환불`), tone: (summary.refundRate || 0) > 10 ? 'negative' : 'neutral', icon: 'percent' },
      { label: tr('Cancel Rate', '취소율'), value: formatPercent(summary.cancelRate || 0), sub: tr(`${formatCount(summary.cancelledSections || 0)} of ${formatCount(summary.totalSections || 0)} sections`, `섹션 ${formatCount(summary.totalSections || 0)}개 중 ${formatCount(summary.cancelledSections || 0)}개`), tone: (summary.cancelRate || 0) > 10 ? 'negative' : 'neutral', icon: 'x-circle' },
      { label: tr('Meta Purchases', '메타 구매'), value: formatCount(summary.metaPurchases || 0), sub: tr('Selected-range campaign insights', '선택 범위 캠페인 인사이트'), tone: 'neutral', icon: 'mouse-pointer-2' },
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
            <td>${
              day.hasCOGS
                ? `<span class="badge badge-success">${esc(tr('Covered', '커버됨'))}</span>`
                : day.hasPartialCOGS
                ? `<span class="badge badge-warning">${esc(tr('Partial', '부분 커버'))}</span>`
                : `<span class="badge badge-warning">${esc(tr('Pending', '대기'))}</span>`
            }</td>
          </tr>
        `).join('')
      : `<tr><td colspan="11" style="text-align:center;color:var(--color-text-faint);padding:20px">${esc(tr('No daily rows in this selection.', '선택 범위에 일별 행이 없습니다.'))}</td></tr>`;

    const orderBody = orderRows.length > 0
      ? orderRows.map(row => `
          <tr>
            <td style="font-weight:600">${esc(formatUtcDate(row.date, { month: 'short', day: 'numeric' }))}</td>
            <td><span style="font-family:var(--font-mono)">${esc(row.orderNo || '—')}</span></td>
            <td>${renderStatusBadge(row.orderStatus)}</td>
            <td>${esc(humanizeEnum(row.paymentMethod || row.pgName || tr('Unknown', '알 수 없음')))}</td>
            <td>${formatKrw(row.paidAmount || 0)}</td>
            <td style="color:var(--color-error)">${formatKrw(row.refundedAmount || 0)}</td>
            <td style="font-weight:600">${formatSignedKrw(row.netRevenue || 0)}</td>
            <td>${formatCount(row.itemCount || 0)}</td>
            <td title="${esc(row.productSummary || '')}">${esc(row.productSummary || '—')}</td>
          </tr>
        `).join('')
      : `<tr><td colspan="9" style="text-align:center;color:var(--color-text-faint);padding:20px">${esc(tr('No orders in this selection.', '선택 범위에 주문이 없습니다.'))}</td></tr>`;

    const productBody = productRows.length > 0
      ? productRows.map(row => {
          const exactCoverage = !!row.exactCostCoverage;
          const coverageMarkup = exactCoverage
            ? `<span class="calendar-product-coverage exact">${esc(tr('Exact', '정확 일치'))}</span>`
            : `<span class="calendar-product-coverage partial">${tr(`${formatPercent((row.coverageRatio || 0) * 100, 0)} covered`, `${formatPercent((row.coverageRatio || 0) * 100, 0)} 커버`)}</span>`;
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
      : `<tr><td colspan="10" style="text-align:center;color:var(--color-text-faint);padding:20px">${esc(tr('No product rows in this selection.', '선택 범위에 상품 행이 없습니다.'))}</td></tr>`;

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
      : `<tr><td colspan="9" style="text-align:center;color:var(--color-text-faint);padding:20px">${esc(tr('No campaign insight rows in this selection.', '선택 범위에 캠페인 인사이트 행이 없습니다.'))}</td></tr>`;

    const reconRows = Array.isArray(reconciliation.daily) ? reconciliation.daily : [];
    const reconciliationSummary = reconciliation.ready === false
      ? `<p class="calendar-coverage-note">${esc(tr('Settlement reconciliation is unavailable for this environment.', '이 환경에서는 정산 대사를 사용할 수 없습니다.'))}</p>`
      : `
        <div class="calendar-reconciliation-grid">
          <div class="calendar-reconciliation-item">
            <div class="calendar-reconciliation-label">${esc(tr('Matched Net', '일치 순액'))}</div>
            <div class="calendar-reconciliation-value">${formatSignedKrw(overlap.netAmount || 0)}</div>
          </div>
          <div class="calendar-reconciliation-item">
            <div class="calendar-reconciliation-label">${esc(tr('Settlement Gaps', '정산 차이'))}</div>
            <div class="calendar-reconciliation-value">${formatCount(overlap.unmatchedSettlementCount || 0)}</div>
          </div>
          <div class="calendar-reconciliation-item">
            <div class="calendar-reconciliation-label">${esc(tr('Imweb Gaps', 'Imweb 차이'))}</div>
            <div class="calendar-reconciliation-value">${formatCount(overlap.unmatchedImwebCount || 0)}</div>
          </div>
          <div class="calendar-reconciliation-item">
            <div class="calendar-reconciliation-label">${esc(tr('Method Drift', '결제 방식 차이'))}</div>
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
      : `<tr><td colspan="6" style="text-align:center;color:var(--color-text-faint);padding:20px">${esc(tr('No reconciliation gaps in this selection.', '선택 범위에 대사 차이가 없습니다.'))}</td></tr>`;

    container.innerHTML = `
      <div class="card">
        <div class="calendar-detail-head">
          <div>
            <div class="section-kicker">${esc(tr('Selected Range', '선택한 범위'))}</div>
            <div class="calendar-detail-title">${esc(formatCalendarRange(calendarState.selectionStart, calendarState.selectionEnd))}</div>
            <div class="calendar-detail-note">${tr(`${formatCount(selection.dayCount || 0)} day${selection.dayCount === 1 ? '' : 's'} selected · All dates shown in KST`, `${formatCount(selection.dayCount || 0)}일 선택 · 모든 날짜는 KST 기준`)}</div>
          </div>
          <div class="calendar-chip-row">
            <span class="calendar-chip ${isProfitPositive ? 'positive' : 'negative'}">${esc(isProfitPositive ? tr('Profitable time frame', '수익 구간') : tr('Below break-even', '손익분기 이하'))}</span>
          </div>
        </div>
      </div>

      ${renderCalendarWaterfall(waterfallCards)}

      <div class="calendar-summary-grid calendar-summary-grid-secondary">
        ${summaryCards.map(renderCalendarSummaryCard).join('')}
      </div>

      <div class="card">
        <div class="card-header">
          <h2>${esc(tr('Daily Breakdown', '일별 상세'))}</h2>
          <span class="calendar-card-note">${tr(`${formatCount(dailyRows.length)} rows`, `${formatCount(dailyRows.length)}행`)}</span>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>${esc(tr('Date', '날짜'))}</th>
                <th>${esc(tr('Gross', '총액'))}</th>
                <th>${esc(tr('Refunded', '환불'))}</th>
                <th>${esc(tr('Net', '순액'))}</th>
                <th>${esc(tr('Orders', '주문'))}</th>
                <th>${esc(tr('Ad Spend', '광고비'))}</th>
                <th>${esc(tr('COGS + Ship', '원가 + 배송'))}</th>
                <th>${esc(tr('Fees', '수수료'))}</th>
                <th>${esc(tr('True Net', '실질 순이익'))}</th>
                <th>ROAS</th>
                <th>${esc(tr('Coverage', '커버리지'))}</th>
              </tr>
            </thead>
            <tbody>${dailyBody}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2>${esc(tr('Orders Ledger', '주문 원장'))}</h2>
          <span class="calendar-card-note">${tr(`${formatCount(orderRows.length)} rows · recognized and non-recognized orders in the selection`, `${formatCount(orderRows.length)}행 · 선택 범위 내 인식/비인식 주문`)}</span>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>${esc(tr('Date', '날짜'))}</th>
                <th>${esc(tr('Order', '주문번호'))}</th>
                <th>${esc(tr('Status', '상태'))}</th>
                <th>${esc(tr('Payment', '결제'))}</th>
                <th>${esc(tr('Paid', '결제금액'))}</th>
                <th>${esc(tr('Refunded', '환불'))}</th>
                <th>${esc(tr('Net', '순액'))}</th>
                <th>${esc(tr('Items', '상품수'))}</th>
                <th>${esc(tr('Products', '상품'))}</th>
              </tr>
            </thead>
            <tbody>${orderBody}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2>${esc(tr('Product Explorer', '상품 탐색'))}</h2>
          <span class="calendar-card-note">${esc(tr('Exact COGS only appears when date + productName matches the Sheets item rows exactly.', '정확한 COGS는 date + productName이 시트 항목과 정확히 일치할 때만 표시됩니다.'))}</span>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>${esc(tr('Product', '상품'))}</th>
                <th>${esc(tr('Brand', '브랜드'))}</th>
                <th>${esc(tr('Qty', '수량'))}</th>
                <th>${esc(tr('Orders', '주문'))}</th>
                <th>${esc(tr('Revenue', '매출'))}</th>
                <th>${esc(tr('Refund / Cancel Qty', '환불 / 취소 수량'))}</th>
                <th>${esc(tr('Status Mix', '상태 구성'))}</th>
                <th>COGS</th>
                <th>${esc(tr('Shipping', '배송비'))}</th>
                <th>${esc(tr('Profit / Coverage', '이익 / 커버리지'))}</th>
              </tr>
            </thead>
            <tbody>${productBody}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2>${esc(tr('Campaign Performance', '캠페인 성과'))}</h2>
          <span class="calendar-card-note">${esc(tr('Revenue, COGS allocation, profit, and ROAS here are estimated from selected-range AOV and Meta purchases.', '여기서 매출, COGS 배분, 이익, ROAS는 선택 범위 AOV와 메타 구매를 기준으로 추정됩니다.'))}</span>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>${esc(tr('Campaign', '캠페인'))}</th>
                <th>${esc(tr('Status', '상태'))}</th>
                <th>${esc(tr('Spend', '지출'))}</th>
                <th>${esc(tr('Meta Purchases', '메타 구매'))}</th>
                <th>${esc(tr('Est. Revenue', '추정 매출'))}</th>
                <th>${esc(tr('Est. COGS', '추정 원가'))}</th>
                <th>${esc(tr('Est. Profit', '추정 이익'))}</th>
                <th>${esc(tr('Est. ROAS', '추정 ROAS'))}</th>
                <th>${esc(tr('Margin', '마진'))}</th>
              </tr>
            </thead>
            <tbody>${campaignBody}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <h2>${esc(tr('Operations & Reconciliation Timeline', '운영 및 정산 타임라인'))}</h2>
            <div class="calendar-card-note">${esc(tr('Scans, optimizer actions, execution updates, and reconciliation gaps for the active selection.', '선택 범위의 스캔, 최적화 조치, 실행 업데이트, 정산 차이를 보여줍니다.'))}</div>
          </div>
          <span class="calendar-card-note">${tr(`${formatCount(operations.length)} events`, `${formatCount(operations.length)}개 이벤트`)}</span>
        </div>
        ${reconciliationSummary}
        <div class="calendar-timeline">
          ${operations.length > 0
            ? operations.map(renderCalendarEvent).join('')
            : `<div class="empty-state">${esc(tr('No operations in this selection.', '선택 범위에 운영 이벤트가 없습니다.'))}</div>`}
        </div>
        <div class="card-header" style="margin-top:16px">
          <h2>${esc(tr('Daily Reconciliation Gaps', '일별 정산 차이'))}</h2>
          <span class="calendar-card-note">${tr(`${formatCount(reconRows.length)} rows`, `${formatCount(reconRows.length)}행`)}</span>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>${esc(tr('Date', '날짜'))}</th>
                <th>${esc(tr('Settlement Net', '정산 순액'))}</th>
                <th>${esc(tr('Imweb Net', 'Imweb 순액'))}</th>
                <th>${esc(tr('Matched', '일치'))}</th>
                <th>${esc(tr('Settlement Gap', '정산 차이'))}</th>
                <th>${esc(tr('Imweb Gap', 'Imweb 차이'))}</th>
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
        calendarState.error = tr('Could not refresh calendar metrics right now. Try again in a moment.', '지금은 캘린더 지표를 새로고침할 수 없습니다. 잠시 후 다시 시도하세요.');
      }
    } catch (err) {
      if (requestId !== calendarState.requestId) {
        return;
      }
      calendarState.error = tr('Could not refresh calendar metrics right now. Try again in a moment.', '지금은 캘린더 지표를 새로고침할 수 없습니다. 잠시 후 다시 시도하세요.');
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
