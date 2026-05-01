(function () {
  const live = window.AdPilotLive;
  const { esc, formatSignedKrw, formatKrw, formatUsd, formatPercent, formatCount, humanizeEnum, tr, getLocale } = live.shared;
  const { fetchCalendarAnalysis } = live.api;

  const KST_TIME_ZONE = 'Asia/Seoul';
  const DEFAULT_PAYMENT_FEE_PERCENT = 6;
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
    paymentFeePercent: null,
  };

  let calendarFeeInputDebounceTimer = null;

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

  function toFiniteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function calcCalendarPercent(numerator, denominator) {
    return denominator > 0 ? (numerator / denominator) * 100 : null;
  }

  function roundCalendarPercent(numerator, denominator, digits = 1) {
    const percent = calcCalendarPercent(numerator, denominator);
    return percent == null ? null : Number(percent.toFixed(digits));
  }

  function hasCalendarMetric(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value));
  }

  function formatCalendarPercentMetric(value, digits = 1) {
    return hasCalendarMetric(value) ? formatPercent(Number(value), digits) : '—';
  }

  function formatCalendarRoasMetric(value) {
    return hasCalendarMetric(value) ? `${Number(value).toFixed(2)}x` : '—';
  }

  function formatFeePercentLabel(value) {
    return Number(value).toFixed(2).replace(/\.?0+$/, '');
  }

  function formatCalendarCellKrw(value, { signed = false } = {}) {
    const numeric = Math.round(toFiniteNumber(value));
    const abs = Math.abs(numeric);
    if (abs === 0) return formatKrw(0);

    const sign = signed && numeric < 0 ? '-' : signed && numeric > 0 ? '+' : '';
    return `${sign}₩${abs.toLocaleString()}`;
  }

  function getCalendarPaymentFeePercent() {
    return calendarState.paymentFeePercent == null
      ? DEFAULT_PAYMENT_FEE_PERCENT
      : calendarState.paymentFeePercent;
  }

  function parseCalendarPaymentFeePercent(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
  }

  function recalculateCalendarDayForFee(day, feeRate) {
    const revenue = toFiniteNumber(day?.revenue);
    const refunded = toFiniteNumber(day?.refunded);
    const netRevenue = toFiniteNumber(day?.netRevenue ?? (revenue - refunded));
    const cogs = toFiniteNumber(day?.cogs);
    const shipping = toFiniteNumber(day?.shipping);
    const adSpend = toFiniteNumber(day?.adSpend);
    const adSpendKRW = toFiniteNumber(day?.adSpendKRW);
    const paymentFees = Math.round(netRevenue * feeRate);
    const trueNetProfit = Math.round(netRevenue - cogs - shipping - paymentFees - adSpendKRW);

    return {
      ...day,
      revenue,
      refunded,
      netRevenue,
      cogs,
      shipping,
      adSpend,
      adSpendKRW,
      paymentFees,
      trueNetProfit,
      margin: roundCalendarPercent(trueNetProfit, netRevenue),
    };
  }

  function getCalendarWaterfallRows(selection) {
    const feeRate = getCalendarPaymentFeePercent() / 100;
    const rows = Array.isArray(selection?.days) ? selection.days : [];

    return rows.map(day => recalculateCalendarDayForFee(day, feeRate));
  }

  function getCalendarCategoryRevenueRows(selection) {
    return Array.isArray(selection?.categoryRevenue) ? selection.categoryRevenue : [];
  }

  function normalizeSankeyCategoryRows(rows, grossRevenue) {
    const gross = Math.max(0, Math.round(toFiniteNumber(grossRevenue)));
    if (gross <= 0) return [];

    let normalized = (Array.isArray(rows) ? rows : [])
      .map((row, index) => {
        const keyBase = String(row?.key || row?.label || `category_${index}`)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '_')
          .replace(/^_+|_+$/g, '');
        return {
          keyBase: keyBase || `category_${index}`,
          label: String(row?.label || tr('Uncategorized', '미분류')).trim() || tr('Uncategorized', '미분류'),
          revenue: Math.max(0, Math.round(toFiniteNumber(row?.revenue))),
          orderCount: toFiniteNumber(row?.orderCount),
          order: index,
        };
      })
      .filter(row => row.revenue > 0);

    const total = normalized.reduce((sum, row) => sum + row.revenue, 0);
    if (total <= 0) {
      normalized = [{
        keyBase: 'uncategorized',
        label: tr('Uncategorized', '미분류'),
        revenue: gross,
        orderCount: 0,
        order: 0,
      }];
    } else {
      const delta = gross - total;
      const tolerance = Math.max(2, Math.round(gross * 0.002));
      if (Math.abs(delta) <= tolerance && normalized.length > 0) {
        normalized[0].revenue += delta;
      } else if (delta > 0) {
        normalized.push({
          keyBase: 'uncategorized',
          label: tr('Uncategorized', '미분류'),
          revenue: delta,
          orderCount: 0,
          order: normalized.length,
        });
      } else if (total > gross) {
        const scale = gross / total;
        normalized = normalized
          .map(row => ({
            ...row,
            revenue: Math.max(0, Math.round(row.revenue * scale)),
          }))
          .filter(row => row.revenue > 0);
        const scaledTotal = normalized.reduce((sum, row) => sum + row.revenue, 0);
        const scaledDelta = gross - scaledTotal;
        if (scaledDelta !== 0 && normalized.length > 0) {
          normalized[0].revenue += scaledDelta;
        }
      }
    }

    const adjustedTotal = normalized.reduce((sum, row) => sum + row.revenue, 0);
    const usedCategoryKeys = new Map();
    return normalized.map((row, index) => {
      const { keyBase: rawBaseKey, ...categoryRow } = row;
      const baseKey = rawBaseKey || `category_${index}`;
      const duplicateIndex = usedCategoryKeys.get(baseKey) || 0;
      usedCategoryKeys.set(baseKey, duplicateIndex + 1);

      return {
        ...categoryRow,
        key: duplicateIndex === 0 ? baseKey : `${baseKey}_${duplicateIndex + 1}`,
        share: adjustedTotal > 0 ? row.revenue / adjustedTotal : 0,
      };
    });
  }

  function getCalendarWaterfallContextLabel() {
    return formatCalendarRange(calendarState.selectionStart, calendarState.selectionEnd);
  }

  function buildCalendarWaterfallSummary(rows) {
    const totals = (Array.isArray(rows) ? rows : []).reduce((summary, day) => {
      summary.grossRevenue += toFiniteNumber(day.revenue);
      summary.refundedAmount += toFiniteNumber(day.refunded);
      summary.netRevenue += toFiniteNumber(day.netRevenue);
      summary.adSpend += toFiniteNumber(day.adSpend);
      summary.adSpendKRW += toFiniteNumber(day.adSpendKRW);
      summary.cogs += toFiniteNumber(day.cogs);
      summary.shipping += toFiniteNumber(day.shipping);
      summary.paymentFees += toFiniteNumber(day.paymentFees);
      summary.trueNetProfit += toFiniteNumber(day.trueNetProfit);
      summary.recognizedOrders += toFiniteNumber(day.orders);
      summary.refundOrders += toFiniteNumber(day.refundCount);
      summary.daysWithCOGS += day.hasCOGS ? 1 : 0;
      summary.daysWithPartialCOGS += day.hasPartialCOGS ? 1 : 0;
      return summary;
    }, {
      grossRevenue: 0,
      refundedAmount: 0,
      netRevenue: 0,
      adSpend: 0,
      adSpendKRW: 0,
      cogs: 0,
      shipping: 0,
      paymentFees: 0,
      trueNetProfit: 0,
      recognizedOrders: 0,
      refundOrders: 0,
      daysWithCOGS: 0,
      daysWithPartialCOGS: 0,
    });

    const dayCount = Array.isArray(rows) ? rows.length : 0;
    return {
      ...totals,
      dayCount,
      refundRate: roundCalendarPercent(totals.refundedAmount, totals.grossRevenue),
      margin: roundCalendarPercent(totals.trueNetProfit, totals.netRevenue),
      cogsCoverageRatio: dayCount > 0 ? Number((totals.daysWithCOGS / dayCount).toFixed(3)) : 0,
    };
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
    return `${monthLabel}${calendarState.loading ? ` · ${tr('Updating...', '업데이트 중...')}` : ''}`;
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

    const revenueFullLabel = isFuture ? '—' : formatKrw(data.revenue || 0);
    const profitFullLabel = isFuture ? '—' : formatSignedKrw(data.trueNetProfit || 0);
    const revenueLabel = isFuture ? '—' : formatCalendarCellKrw(data.revenue || 0);
    const profitLabel = isFuture ? '—' : formatCalendarCellKrw(data.trueNetProfit || 0, { signed: true });
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
        <div class="calendar-day-revenue" title="${esc(revenueFullLabel)}">${esc(revenueLabel)}</div>
        <div class="calendar-day-profit ${profitClass}" title="${esc(profitFullLabel)}">${esc(profitLabel)}</div>
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

  function buildSankeyViewModel(selection, baseSummary) {
    const rows = getCalendarWaterfallRows(selection);
    const summary = buildCalendarWaterfallSummary(rows);
    const feePercent = formatFeePercentLabel(getCalendarPaymentFeePercent());
    const contextLabel = getCalendarWaterfallContextLabel();
    const isProfitPositive = summary.trueNetProfit >= 0;
    const orderCount = summary.recognizedOrders || baseSummary?.recognizedOrders || 0;

    const coverageLabel = Number(summary.daysWithPartialCOGS || 0) > 0
      ? tr(
        `${formatCount(summary.daysWithCOGS || 0)} covered · ${formatCount(summary.daysWithPartialCOGS || 0)} partial`,
        `완전 커버 ${formatCount(summary.daysWithCOGS || 0)}일 · 부분 커버 ${formatCount(summary.daysWithPartialCOGS || 0)}일`
      )
      : tr(
        `${formatCount(summary.daysWithCOGS || 0)} covered days`,
        `커버 일수 ${formatCount(summary.daysWithCOGS || 0)}일`
      );

    const shippingPerOrder = orderCount > 0
      ? Math.round(summary.shipping / orderCount)
      : 0;
    const shippingSub = orderCount > 0
      ? tr(`${formatKrw(shippingPerOrder)} per order`, `주문당 ${formatKrw(shippingPerOrder)}`)
      : tr('Operational shipping', '운영 배송');

    const adSpendUsdTitle = `${formatUsd(summary.adSpend || 0, 2)} media spend`;
    const adSpendNetShare = summary.netRevenue > 0
      ? formatPercent((summary.adSpendKRW / summary.netRevenue) * 100)
      : '—';
    const adSpendSub = summary.netRevenue > 0
      ? tr(`${adSpendNetShare} of net rev`, `순매출의 ${adSpendNetShare}`)
      : tr(`${formatUsd(summary.adSpend || 0, 2)} media spend`, `광고비 ${formatUsd(summary.adSpend || 0, 2)}`);

    const profitMarginLabel = formatCalendarPercentMetric(summary.margin);
    const resultSub = isProfitPositive
      ? tr(`${profitMarginLabel} margin`, `마진 ${profitMarginLabel}`)
      : tr('Loss after costs', '비용 차감 후 손실');
    const expenseValue = value => value > 0 ? formatSignedKrw(-value) : formatKrw(0);

    const grossV    = Math.max(0, summary.grossRevenue);
    const refundedV = Math.max(0, summary.refundedAmount);
    const netV      = Math.max(0, summary.netRevenue);
    const cogsV     = Math.max(0, summary.cogs);
    const shipV     = Math.max(0, summary.shipping);
    const feesV     = Math.max(0, summary.paymentFees);
    const adV       = Math.max(0, summary.adSpendKRW);
    const profitV   = Math.max(0, summary.trueNetProfit);
    const lossV     = Math.max(0, -summary.trueNetProfit);
    const resultV   = isProfitPositive ? profitV : lossV;
    const costsTotal = cogsV + shipV + feesV + adV;
    const categoryRows = normalizeSankeyCategoryRows(getCalendarCategoryRevenueRows(selection), grossV);
    const hasCategoryBreakdown = categoryRows.length > 0;
    const grossColumn = hasCategoryBreakdown ? 1 : 0;
    const revenueColumn = hasCategoryBreakdown ? 2 : 1;
    const costsColumn = hasCategoryBreakdown ? 3 : 2;
    const terminalColumn = hasCategoryBreakdown ? 4 : 3;
    const netShareLabel = value => netV > 0 ? formatPercent((value / netV) * 100) : '—';
    const costsSub = netV > 0
      ? tr(`${formatPercent((costsTotal / netV) * 100)} of net rev`, `순매출의 ${formatPercent((costsTotal / netV) * 100)}`)
      : tr('Cost split', '비용 분기');
    const categoryNodes = categoryRows.map(row => ({
      id: `category:${row.key}`,
      key: `category:${row.key}`,
      label: row.label,
      displayValue: formatKrw(row.revenue),
      sub: tr(`${formatPercent(row.share * 100, 0)} of gross`, `총매출의 ${formatPercent(row.share * 100, 0)}`),
      tone: 'neutral',
      column: 0,
      order: row.order,
      labelSide: 'left',
      titleAttr: row.orderCount > 0
        ? tr(`${formatCount(row.orderCount)} orders`, `주문 ${formatCount(row.orderCount)}건`)
        : '',
    }));

    const nodes = [
      ...categoryNodes,
      { id: 'gross', key: 'gross', label: tr('Gross Revenue', '총매출'),
        displayValue: formatKrw(summary.grossRevenue),
        sub: tr(`${formatCount(orderCount)} orders`, `주문 ${formatCount(orderCount)}건`),
        tone: grossV > 0 ? 'positive' : 'neutral', column: grossColumn, order: 1,
        visible: grossV > 0 },
      { id: 'refunded', key: 'refunded', label: tr('Refunded', '환불'),
        displayValue: expenseValue(summary.refundedAmount),
        sub: tr(`${formatCalendarPercentMetric(summary.refundRate)} refund rate`, `환불률 ${formatCalendarPercentMetric(summary.refundRate)}`),
        tone: refundedV > 0 ? 'negative' : 'neutral', column: revenueColumn, order: 0,
        visible: refundedV > 0 },
      { id: 'net', key: 'net', label: tr('Net Revenue', '순매출'),
        displayValue: formatKrw(summary.netRevenue),
        sub: tr(`${formatCount(summary.dayCount || 0)} days`, `${formatCount(summary.dayCount || 0)}일`),
        tone: netV > 0 ? 'positive' : 'neutral', column: revenueColumn, order: 1,
        visible: netV > 0 },
      { id: 'costs', key: 'costs', label: tr('Costs', '비용'),
        displayValue: expenseValue(costsTotal), sub: costsSub,
        tone: 'negative', column: costsColumn, order: 1, labelSide: 'left',
        visible: costsTotal > 0 },
      { id: 'profit', key: 'profit',
        label: isProfitPositive ? tr('True Net Profit', '실질 순이익') : tr('True Net Loss', '실질 순손실'),
        displayValue: formatSignedKrw(summary.trueNetProfit),
        sub: isProfitPositive ? resultSub : tr('Uncovered costs', '미충당 비용'),
        tone: isProfitPositive ? 'positive' : 'negative',
        column: isProfitPositive ? terminalColumn : revenueColumn,
        order: isProfitPositive ? 0 : 2,
        terminal: isProfitPositive,
        labelSide: isProfitPositive ? undefined : 'left',
        visible: resultV > 0 },
      { id: 'cogs', key: 'cogs', label: 'COGS',
        displayValue: expenseValue(summary.cogs),
        sub: netV > 0 ? tr(`${netShareLabel(cogsV)} of net rev`, `순매출의 ${netShareLabel(cogsV)}`) : coverageLabel,
        tone: cogsV > 0 ? 'negative' : 'neutral', column: terminalColumn, order: 1,
        visible: cogsV > 0 },
      { id: 'shipping', key: 'shipping', label: tr('Shipping', '배송비'),
        displayValue: expenseValue(summary.shipping),
        sub: netV > 0 ? tr(`${netShareLabel(shipV)} of net rev`, `순매출의 ${netShareLabel(shipV)}`) : shippingSub,
        tone: shipV > 0 ? 'negative' : 'neutral', column: terminalColumn, order: 2,
        visible: shipV > 0 },
      { id: 'fees', key: 'fees', label: tr('Payment Fees', '결제 수수료'),
        displayValue: expenseValue(summary.paymentFees),
        sub: netV > 0 ? tr(`${netShareLabel(feesV)} of net rev`, `순매출의 ${netShareLabel(feesV)}`) : tr(`${formatCount(orderCount)} transactions`, `거래 ${formatCount(orderCount)}건`),
        tone: feesV > 0 ? 'negative' : 'neutral', column: terminalColumn, order: 3,
        visible: feesV > 0 },
      { id: 'adSpend', key: 'adSpend', label: tr('Ad Spend', '광고비'),
        displayValue: expenseValue(summary.adSpendKRW), sub: adSpendSub,
        tone: adV > 0 ? 'negative' : 'neutral', column: terminalColumn, order: isProfitPositive ? 5 : 4,
        titleAttr: adSpendUsdTitle, visible: adV > 0 },
    ];

    const links = [];
    const addLink = (source, target, value, tone, order, variant = '') => {
      const numericValue = Number(value) || 0;
      if (numericValue <= 0) return;
      links.push({
        source,
        target,
        value: numericValue,
        tone,
        order,
        variant,
      });
    };

    for (const row of categoryRows) {
      addLink(`category:${row.key}`, 'gross', row.revenue, 'neutral', row.order);
    }
    addLink('gross', 'refunded', refundedV, 'negative', 0);
    addLink('gross', 'net', netV, grossV > 0 ? 'positive' : 'neutral', 1);

    if (isProfitPositive) {
      addLink('net', 'profit', profitV, 'positive', 0);
      addLink('net', 'costs', costsTotal, costsTotal > 0 ? 'negative' : 'neutral', 1);
    } else {
      if (netV > 0) {
        addLink('net', 'costs', Math.min(netV, costsTotal), 'negative', 1);
      }
      addLink('profit', 'costs', lossV, 'negative', 0, 'loss-gap');
    }
    addLink('costs', 'cogs', cogsV, 'negative', 0);
    addLink('costs', 'shipping', shipV, 'negative', 1);
    addLink('costs', 'fees', feesV, 'negative', 2);
    addLink('costs', 'adSpend', adV, 'negative', 3);

    const d3Sankey = window.d3 && typeof window.d3.sankey === 'function' ? window.d3 : null;
    const displayableNodeIds = new Set(nodes.filter(node => node.visible !== false).map(node => node.id));
    const visibleLinks = links.filter(link => displayableNodeIds.has(link.source) && displayableNodeIds.has(link.target));
    const linkedNodeIds = visibleLinks.reduce((ids, link) => {
      ids.add(link.source);
      ids.add(link.target);
      return ids;
    }, new Set());
    const visibleNodes = nodes.filter(node => node.visible !== false && linkedNodeIds.has(node.id));

    if (visibleNodes.length === 0 || visibleLinks.length === 0) {
      return { nodes: [], flows: [], summary, feePercent, contextLabel, isProfitPositive, noFinancialMovement: true };
    }

    if (!d3Sankey) {
      return { nodes: visibleNodes, flows: [], summary, feePercent, contextLabel, isProfitPositive, missingSankeyEngine: true };
    }

    const visibleColumns = Array.from(new Set(visibleNodes.map(node => Number(node.column || 0))))
      .sort((left, right) => left - right);
    const columnIndexByValue = new Map(visibleColumns.map((column, index) => [column, index]));
    const layoutNodes = visibleNodes.map(node => ({
      ...node,
      sankeyColumn: columnIndexByValue.get(Number(node.column || 0)) || 0,
    }));

    const layout = d3Sankey.sankey()
      .nodeId(node => node.id)
      .nodeWidth(14)
      .nodePadding(34)
      .nodeSort((a, b) => (a.order || 0) - (b.order || 0))
      .linkSort((a, b) => (a.order || 0) - (b.order || 0))
      .nodeAlign(node => node.sankeyColumn)
      .extent(hasCategoryBreakdown ? [[170, 74], [1080, 500]] : [[96, 74], [1080, 500]]);
    const graph = layout({
      nodes: layoutNodes,
      links: visibleLinks.map(link => ({ ...link })),
    });
    const linkPath = d3Sankey.sankeyLinkHorizontal();
    const hasNetCostLink = graph.links.some(link => link.source.id === 'net' && link.target.id === 'costs');
    const buildSankeyFlowPath = link => {
      const isFlatLossGap = link.variant === 'loss-gap'
        && !hasNetCostLink
        && Math.abs((link.y1 || 0) - (link.y0 || 0)) < 4;
      if (!isFlatLossGap) return linkPath(link);

      const sourceX = link.source.x1;
      const targetX = link.target.x0;
      const dx = targetX - sourceX;
      const bow = Math.min(90, Math.max(34, (link.width || 1) * 0.16));
      return [
        `M${sourceX},${link.y0}`,
        `C${sourceX + dx * 0.28},${link.y0 - bow}`,
        `${targetX - dx * 0.28},${link.y1 + bow}`,
        `${targetX},${link.y1}`,
      ].join(' ');
    };
    const laidOutNodes = graph.nodes.map(node => ({
      ...node,
      x: node.x0,
      y: node.y0,
      w: Math.max(1, node.x1 - node.x0),
      h: Math.max(1, node.y1 - node.y0),
    }));
    const labelGroups = laidOutNodes
      .filter(node => !node.quiet)
      .reduce((groups, node) => {
        const key = String(node.column ?? 0);
        const group = groups.get(key) || [];
        group.push(node);
        groups.set(key, group);
        return groups;
      }, new Map());
    labelGroups.forEach(group => {
      const sorted = group.sort((left, right) => (left.order || 0) - (right.order || 0));
      const minGap = group.length > 5 ? 54 : 60;
      const topBound = 84;
      const bottomBound = 492;
      let cursor = topBound;
      sorted.forEach(node => {
        const naturalCenter = node.y + node.h / 2;
        node.labelCenterY = Math.max(naturalCenter, cursor);
        cursor = node.labelCenterY + minGap;
      });
      const overflow = cursor - minGap - bottomBound;
      if (overflow > 0) {
        sorted.forEach(node => {
          node.labelCenterY = Math.max(topBound, node.labelCenterY - overflow);
        });
      }
    });
    const flows = graph.links.map(link => ({
      tone: link.tone || 'neutral',
      variant: link.variant || '',
      width: Math.max(2, link.width || 1),
      d: buildSankeyFlowPath(link),
    }));

    return { nodes: laidOutNodes, flows, summary, feePercent, contextLabel, isProfitPositive };
  }

  function formatCalendarSankeyMeta(viewModel) {
    return viewModel.contextLabel || tr('Selected range', '선택한 범위');
  }

  function renderSankeyNode(node) {
    const titleAttr = node.titleAttr ? ` title="${esc(node.titleAttr)}"` : '';
    const labelSide = node.labelSide || 'right';
    const labelX = labelSide === 'left' ? node.x - 12 : node.x + node.w + 12;
    const anchor = labelSide === 'left' ? 'end' : 'start';
    const labelCenterY = Number.isFinite(node.labelCenterY) ? node.labelCenterY : node.y + node.h / 2;
    const labelY = labelCenterY - 15;
    const quietClass = node.quiet ? ' is-quiet' : '';
    const terminalClass = node.terminal ? ' is-terminal' : '';
    return `
      <g class="calendar-sankey-node ${esc(node.tone || 'neutral')}${terminalClass}${quietClass}" role="listitem"${titleAttr}>
        <rect class="calendar-sankey-bar" x="${node.x}" y="${node.y.toFixed(1)}" width="${node.w}" height="${node.h.toFixed(1)}" rx="5"></rect>
        <text class="calendar-sankey-label-title" x="${labelX}" y="${labelY.toFixed(1)}" text-anchor="${anchor}">${esc(node.label)}</text>
        <text class="calendar-sankey-label-value" x="${labelX}" y="${(labelY + 22).toFixed(1)}" text-anchor="${anchor}">${node.displayValue}</text>
        <text class="calendar-sankey-label-sub" x="${labelX}" y="${(labelY + 43).toFixed(1)}" text-anchor="${anchor}">${esc(node.sub || '—')}</text>
      </g>
    `;
  }

  function renderSankeyFlow(flow) {
    const variantClass = flow.variant ? ` is-${esc(flow.variant)}` : '';
    return `<path class="calendar-sankey-flow ${esc(flow.tone || 'neutral')}${variantClass}" d="${flow.d}" stroke-width="${flow.width.toFixed(2)}"></path>`;
  }

  function renderSankeyBodyMarkup(viewModel) {
    if (viewModel.noFinancialMovement) {
      return `<div class="calendar-sankey-missing">${esc(tr('No financial movement in this selection.', '선택 범위에 재무 흐름이 없습니다.'))}</div>`;
    }
    if (viewModel.missingSankeyEngine) {
      return `<div class="calendar-sankey-missing">${esc(tr('Sankey engine did not load.', 'Sankey 엔진을 불러오지 못했습니다.'))}</div>`;
    }
    return `
      <svg class="calendar-sankey-svg" viewBox="0 0 1280 560" role="list" aria-label="${esc(tr('Profit Sankey with product category inflows', '상품 카테고리 유입 포함 수익 Sankey'))}">
        ${viewModel.flows.map(renderSankeyFlow).join('')}
        ${viewModel.nodes.map(renderSankeyNode).join('')}
      </svg>
    `;
  }

  function renderCalendarSankey(selection, baseSummary) {
    const viewModel = buildSankeyViewModel(selection, baseSummary);
    const customFeeValue = calendarState.paymentFeePercent == null
      ? ''
      : esc(String(calendarState.paymentFeePercent));
    const hasCustomFee = calendarState.paymentFeePercent != null;

    return `
      <div class="card calendar-sankey-card" id="calendarProfitSankey">
        <div class="card-header calendar-sankey-header">
          <div>
            <h2>${esc(tr('Profit Sankey', '수익 Sankey'))}</h2>
            <span class="card-header-meta" data-calendar-sankey-meta>${esc(formatCalendarSankeyMeta(viewModel))}</span>
          </div>
          <div class="calendar-sankey-controls">
            <label class="payment-fee-control ${hasCustomFee ? 'has-custom-fee' : ''}" for="calendarPaymentFeeRateInput">
              <span>${esc(tr('Payment fee', '결제 수수료'))}</span>
              <div class="input-with-unit">
                <input id="calendarPaymentFeeRateInput" class="text-input payment-fee-input" type="number" min="0" step="0.1" inputmode="decimal" placeholder="${DEFAULT_PAYMENT_FEE_PERCENT}" value="${customFeeValue}" aria-label="${esc(tr('Payment fee percentage', '결제 수수료율'))}">
                <span class="unit">%</span>
                <button type="button" class="payment-fee-reset" data-calendar-payment-fee-reset aria-label="${esc(tr('Reset to default', '기본값으로'))}" title="${esc(tr('Reset to default', '기본값으로'))}">×</button>
              </div>
            </label>
          </div>
        </div>
        <div class="calendar-sankey-stage">
          <div class="calendar-sankey-canvas" role="list" aria-label="${esc(tr('Profit Sankey with product category inflows', '상품 카테고리 유입 포함 수익 Sankey'))}">
            ${renderSankeyBodyMarkup(viewModel)}
          </div>
        </div>
      </div>
    `;
  }

  function updateCalendarSankeyBody() {
    const card = document.getElementById('calendarProfitSankey');
    if (!card) return;

    const canvas = card.querySelector('.calendar-sankey-canvas');
    if (!canvas) return;

    const selection = calendarState.data?.selection || {};
    const baseSummary = selection.summary || {};
    const viewModel = buildSankeyViewModel(selection, baseSummary);
    const metaEl = card.querySelector('[data-calendar-sankey-meta]');
    if (metaEl) metaEl.textContent = formatCalendarSankeyMeta(viewModel);

    canvas.innerHTML = renderSankeyBodyMarkup(viewModel);
    if (window.lucide) {
      lucide.createIcons({ nodes: [canvas] });
    }

    syncPaymentFeeControlState();
    syncSankeyOverflow();
  }

  function syncPaymentFeeControlState() {
    const ctrl = document.querySelector('.payment-fee-control');
    if (!ctrl) return;
    ctrl.classList.toggle('has-custom-fee', calendarState.paymentFeePercent != null);
  }

  function syncSankeyOverflow() {
    const stage = document.querySelector('.calendar-sankey-stage');
    if (!stage) return;
    stage.classList.toggle('has-overflow', stage.scrollWidth > stage.clientWidth + 4);
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

  function renderSourceAuditNotice(sourceAudit) {
    if (!sourceAudit) return '';
    const failedChecks = Array.isArray(sourceAudit.summary?.failedChecks) ? sourceAudit.summary.failedChecks : [];
    const failedFetches = Array.isArray(sourceAudit.summary?.failedFetches) ? sourceAudit.summary.failedFetches : [];

    if (sourceAudit.status === 'mismatch') {
      const message = failedChecks.length > 0
        ? tr(`Source audit mismatch: ${failedChecks.join(', ')}. Calendar financial totals need review before use.`, `소스 감사 불일치: ${failedChecks.join(', ')}. 사용 전 캘린더 재무 합계 검토가 필요합니다.`)
        : tr('Source audit mismatch. Calendar financial totals need review before use.', '소스 감사 불일치. 사용 전 캘린더 재무 합계 검토가 필요합니다.');
      return `<div class="analytics-inline-notice is-error">${esc(message)}</div>`;
    }

    if (sourceAudit.status === 'reconciled_with_stale_sources') {
      const message = failedFetches.length > 0
        ? tr(`Using last-known-good source data for ${failedFetches.join(', ')}.`, `${failedFetches.join(', ')} 마지막 정상 소스 데이터를 사용 중입니다.`)
        : tr('Using last-known-good source data.', '마지막 정상 소스 데이터를 사용 중입니다.');
      return `<div class="analytics-inline-notice">${esc(message)}</div>`;
    }

    return '';
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

  function renderCalendarSelectionDeck() {
    const container = document.getElementById('calendarSelectionDeck');
    if (!container) return;

    ensureCalendarStateInitialized();
    syncCalendarSelectionIntoViewport();

    const hasFreshSelection = hasFreshCalendarSelectionPayload(calendarState.data);
    if (!hasFreshSelection && calendarState.loading) {
      container.innerHTML = renderEmptyStateCard(tr('Profit Sankey', '수익 Sankey'), tr('Refreshing calendar metrics for the selected date range...', '선택한 날짜 범위의 캘린더 지표를 새로고침 중...'));
      return;
    }

    if (!hasFreshSelection && calendarState.error) {
      container.innerHTML = renderEmptyStateCard(tr('Profit Sankey', '수익 Sankey'), calendarState.error);
      return;
    }

    if (!calendarState.data || calendarState.data.ready === false || !hasFreshSelection) {
      container.innerHTML = renderEmptyStateCard(tr('Calendar', '캘린더'), tr('Calendar is waiting for the first completed scan.', '첫 완료 스캔을 기다리는 중입니다.'));
      return;
    }

    const selection = calendarState.data.selection || {};
    const summary = selection.summary || {};

    const dailyRows = Array.isArray(selection.days) ? selection.days : [];
    const orderRows = Array.isArray(selection.orders) ? selection.orders : [];
    const productRows = Array.isArray(selection.products) ? selection.products : [];
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
            <td>${formatCalendarRoasMetric(day.roas)}</td>
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

    container.innerHTML = `
      ${renderSourceAuditNotice(calendarState.data?.sourceAudit || null)}

      ${renderCalendarSankey(selection, summary)}

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
    `;

    if (window.lucide) {
      lucide.createIcons({ nodes: [container] });
    }

    syncPaymentFeeControlState();
    syncSankeyOverflow();
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
    const selectionDeckEl = document.getElementById('calendarSelectionDeck');

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

    if (selectionDeckEl) {
      selectionDeckEl.addEventListener('click', event => {
        const resetButton = event.target.closest('[data-calendar-payment-fee-reset]');
        if (resetButton) {
          calendarState.paymentFeePercent = null;
          const input = document.getElementById('calendarPaymentFeeRateInput');
          if (input) input.value = '';
          updateCalendarSankeyBody();
        }
      });

      selectionDeckEl.addEventListener('input', event => {
        if (event.target?.id !== 'calendarPaymentFeeRateInput') return;

        calendarState.paymentFeePercent = parseCalendarPaymentFeePercent(event.target.value);
        clearTimeout(calendarFeeInputDebounceTimer);
        calendarFeeInputDebounceTimer = setTimeout(updateCalendarSankeyBody, 80);
      });

      window.addEventListener('resize', () => {
        clearTimeout(calendarFeeInputDebounceTimer);
        calendarFeeInputDebounceTimer = setTimeout(syncSankeyOverflow, 120);
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
