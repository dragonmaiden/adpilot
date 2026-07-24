(function () {
  const live = window.AdPilotLive;
  const { esc, formatSignedKrw, formatKrw, formatUsd, formatPercent, formatCount, tr, getLocale } = live.shared;
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

  function getCalendarWaterfallContextLabel() {
    return formatCalendarRange(calendarState.selectionStart, calendarState.selectionEnd);
  }

  function buildCalendarWaterfallSummary(rows) {
    const totals = (Array.isArray(rows) ? rows : []).reduce((summary, day) => {
      const grossRevenue = toFiniteNumber(day.revenue);
      const refundedAmount = toFiniteNumber(day.refunded);
      const recognizedOrders = toFiniteNumber(day.orders);
      const cogs = toFiniteNumber(day.cogs);
      const shipping = toFiniteNumber(day.shipping);
      const needsCOGSCoverage = grossRevenue > 0
        || refundedAmount > 0
        || recognizedOrders > 0
        || cogs > 0
        || shipping > 0
        || day.hasCOGS
        || day.hasPartialCOGS;

      summary.grossRevenue += grossRevenue;
      summary.refundedAmount += refundedAmount;
      summary.netRevenue += toFiniteNumber(day.netRevenue);
      summary.adSpend += toFiniteNumber(day.adSpend);
      summary.adSpendKRW += toFiniteNumber(day.adSpendKRW);
      summary.cogs += cogs;
      summary.shipping += shipping;
      summary.paymentFees += toFiniteNumber(day.paymentFees);
      summary.trueNetProfit += toFiniteNumber(day.trueNetProfit);
      summary.recognizedOrders += recognizedOrders;
      summary.refundOrders += toFiniteNumber(day.refundCount);
      if (needsCOGSCoverage) {
        summary.daysRequiringCOGS += 1;
        summary.daysWithCOGS += day.hasCOGS ? 1 : 0;
        summary.daysWithPartialCOGS += day.hasPartialCOGS ? 1 : 0;
      }
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
      daysRequiringCOGS: 0,
      daysWithCOGS: 0,
      daysWithPartialCOGS: 0,
    });

    const dayCount = Array.isArray(rows) ? rows.length : 0;
    return {
      ...totals,
      dayCount,
      refundRate: roundCalendarPercent(totals.refundedAmount, totals.grossRevenue),
      margin: roundCalendarPercent(totals.trueNetProfit, totals.netRevenue),
      cogsCoverageRatio: totals.daysRequiringCOGS > 0
        ? Number((totals.daysWithCOGS / totals.daysRequiringCOGS).toFixed(3))
        : 1,
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

  function buildIncomeStatementViewModel(selection) {
    const summary = buildCalendarWaterfallSummary(getCalendarWaterfallRows(selection));
    const paymentChannels = selection?.paymentChannels || {};
    const channelsByKey = new Map(
      (Array.isArray(paymentChannels.rows) ? paymentChannels.rows : [])
        .map(row => [String(row?.channel || 'unknown'), {
          revenue: Math.max(0, toFiniteNumber(row?.revenue)),
          orderCount: Math.max(0, toFiniteNumber(row?.orderCount)),
        }])
    );
    const getChannel = channel => channelsByKey.get(channel) || { revenue: 0, orderCount: 0 };
    const shareOf = (value, total) => total > 0
      ? formatPercent((Math.abs(value) / total) * 100)
      : '—';
    const paymentRows = [
      {
        channel: 'card',
        label: tr('Credit card revenue', '신용카드 매출'),
        ...getChannel('card'),
      },
      {
        channel: 'bank_transfer',
        label: tr('Bank transfer revenue', '계좌이체 매출'),
        ...getChannel('bank_transfer'),
      },
      {
        channel: 'virtual_account',
        label: tr('Virtual account revenue', '가상계좌 매출'),
        ...getChannel('virtual_account'),
      },
      {
        channel: 'other',
        label: tr('Other payment revenue', '기타 결제 매출'),
        ...getChannel('other'),
      },
      {
        channel: 'unknown',
        label: tr('Unclassified revenue', '미분류 매출'),
        ...getChannel('unknown'),
      },
    ].filter(row => (
      row.channel === 'card'
        || row.channel === 'bank_transfer'
        || row.revenue > 0
        || row.orderCount > 0
    )).map(row => ({
      ...row,
      meta: tr(
        `${formatCount(row.orderCount)} orders · ${shareOf(row.revenue, summary.grossRevenue)} of gross`,
        `주문 ${formatCount(row.orderCount)}건 · 총매출의 ${shareOf(row.revenue, summary.grossRevenue)}`
      ),
    }));
    const reportedChannelRevenue = toFiniteNumber(paymentChannels.totalGrossRevenue);
    const paymentChannelGap = Math.round(summary.grossRevenue - reportedChannelRevenue);
    const totalCosts = summary.cogs + summary.shipping + summary.paymentFees + summary.adSpendKRW;
    const orderCount = summary.recognizedOrders || toFiniteNumber(paymentChannels.totalOrderCount);
    const shippingPerOrder = orderCount > 0 ? Math.round(summary.shipping / orderCount) : 0;
    const daysRequiringCOGS = summary.daysRequiringCOGS || 0;
    const fullCoverage = summary.daysWithCOGS || 0;
    const partialCoverage = summary.daysWithPartialCOGS || 0;
    const missingCoverage = Math.max(0, daysRequiringCOGS - fullCoverage - partialCoverage);
    const cogsComplete = fullCoverage === daysRequiringCOGS;
    const coverageLabel = tr(
      `${formatCount(fullCoverage)} complete · ${formatCount(partialCoverage)} partial · ${formatCount(missingCoverage)} missing`,
      `완료 ${formatCount(fullCoverage)}일 · 부분 ${formatCount(partialCoverage)}일 · 누락 ${formatCount(missingCoverage)}일`
    );
    const feePercent = formatFeePercentLabel(getCalendarPaymentFeePercent());

    return {
      summary,
      contextLabel: getCalendarWaterfallContextLabel(),
      feePercent,
      paymentRows,
      paymentChannelGap,
      totalCosts,
      cogsComplete,
      coverageLabel,
      revenueLines: [
        ...paymentRows.map(row => ({
          key: `payment-${row.channel}`,
          label: row.label,
          meta: row.meta,
          amount: row.revenue,
          percent: shareOf(row.revenue, summary.grossRevenue),
          kind: 'detail',
        })),
        {
          key: 'gross-revenue',
          label: tr('Total revenue', '총매출'),
          meta: tr(`${formatCount(orderCount)} recognized orders`, `인식 주문 ${formatCount(orderCount)}건`),
          amount: summary.grossRevenue,
          percent: '100%',
          kind: 'subtotal',
        },
        {
          key: 'refunds',
          label: tr('Refunds and cancellations', '환불 및 취소'),
          meta: tr(
            `${formatCalendarPercentMetric(summary.refundRate)} refund rate`,
            `환불률 ${formatCalendarPercentMetric(summary.refundRate)}`
          ),
          amount: -summary.refundedAmount,
          percent: shareOf(summary.refundedAmount, summary.grossRevenue),
          kind: 'deduction',
        },
        {
          key: 'net-revenue',
          label: tr('Net revenue', '순매출'),
          meta: tr('Revenue after refunds', '환불 차감 후 매출'),
          amount: summary.netRevenue,
          percent: shareOf(summary.netRevenue, summary.grossRevenue),
          kind: 'total',
        },
      ],
      costLines: [
        {
          key: 'cogs',
          label: 'COGS',
          meta: coverageLabel,
          amount: -summary.cogs,
          percent: shareOf(summary.cogs, summary.netRevenue),
          kind: 'cost',
        },
        {
          key: 'shipping',
          label: tr('Shipping costs', '배송비'),
          meta: orderCount > 0
            ? tr(`${formatKrw(shippingPerOrder)} per order`, `주문당 ${formatKrw(shippingPerOrder)}`)
            : tr('No recognized orders', '인식된 주문 없음'),
          amount: -summary.shipping,
          percent: shareOf(summary.shipping, summary.netRevenue),
          kind: 'cost',
        },
        {
          key: 'payment-fees',
          label: tr('Payment processing fees', '결제 처리 수수료'),
          meta: tr(`${feePercent}% assumption on net revenue`, `순매출 기준 ${feePercent}% 가정`),
          amount: -summary.paymentFees,
          percent: shareOf(summary.paymentFees, summary.netRevenue),
          kind: 'cost',
        },
        {
          key: 'ad-spend',
          label: tr('Advertising costs', '광고비'),
          meta: tr(
            `${formatUsd(summary.adSpend || 0, 2)} media spend`,
            `미디어 지출 ${formatUsd(summary.adSpend || 0, 2)}`
          ),
          amount: -summary.adSpendKRW,
          percent: shareOf(summary.adSpendKRW, summary.netRevenue),
          kind: 'cost',
        },
        {
          key: 'total-costs',
          label: tr('Total costs', '총비용'),
          meta: tr('COGS + shipping + fees + advertising', '원가 + 배송비 + 수수료 + 광고비'),
          amount: -totalCosts,
          percent: shareOf(totalCosts, summary.netRevenue),
          kind: 'total-costs',
        },
      ],
    };
  }

  function renderIncomeStatementLine(line, index) {
    const amount = Math.abs(toFiniteNumber(line.amount)) < 0.5 ? 0 : toFiniteNumber(line.amount);

    return `
      <div class="income-statement-line ${esc(line.kind || '')}" style="--statement-row-index:${index}" role="row">
        <div class="income-statement-account" role="rowheader">
          <span>${esc(line.label)}</span>
          <small>${esc(line.meta || '')}</small>
        </div>
        <span class="income-statement-percent" role="cell">${esc(line.percent || '—')}</span>
        <strong class="income-statement-amount" role="cell">${amount < 0 ? formatSignedKrw(amount) : formatKrw(amount)}</strong>
      </div>
    `;
  }

  function renderIncomeStatementBody(viewModel) {
    const { summary } = viewModel;
    const resultPositive = summary.trueNetProfit >= 0;
    const resultLabel = resultPositive
      ? tr('Net profit', '순이익')
      : tr('Net loss', '순손실');
    const coverageIcon = viewModel.cogsComplete ? 'badge-check' : 'triangle-alert';
    const coverageClass = viewModel.cogsComplete ? 'complete' : 'incomplete';
    const coverageNote = viewModel.cogsComplete
      ? tr(
        viewModel.summary.daysRequiringCOGS > 0
          ? `COGS and shipping are complete for all ${formatCount(viewModel.summary.daysRequiringCOGS)} order days.`
          : 'No recognized order days require COGS coverage.',
        viewModel.summary.daysRequiringCOGS > 0
          ? `주문이 있는 ${formatCount(viewModel.summary.daysRequiringCOGS)}일의 원가와 배송비가 모두 완료되었습니다.`
          : '원가 커버리지가 필요한 인식 주문일이 없습니다.'
      )
      : tr(
        `COGS coverage is incomplete (${viewModel.coverageLabel}). Net profit reflects only costs currently logged.`,
        `원가 커버리지가 불완전합니다(${viewModel.coverageLabel}). 순이익은 현재 입력된 비용만 반영합니다.`
      );
    const reconciliationWarning = viewModel.paymentChannelGap === 0
      ? ''
      : `
        <div class="income-statement-alert" role="status">
          <i data-lucide="circle-alert"></i>
          <span>${esc(tr(
            `Payment-channel revenue differs from total revenue by ${formatSignedKrw(viewModel.paymentChannelGap)}.`,
            `결제수단별 매출과 총매출의 차이는 ${formatSignedKrw(viewModel.paymentChannelGap)}입니다.`
          ))}</span>
        </div>
      `;

    return `
      <div class="income-statement-columns" aria-hidden="true">
        <span>${esc(tr('Account', '계정'))}</span>
        <span>${esc(tr('% of base', '기준 비율'))}</span>
        <span>${esc(tr('Amount · KRW', '금액 · KRW'))}</span>
      </div>
      <section class="income-statement-section revenue" aria-labelledby="incomeRevenueHeading">
        <div class="income-statement-section-title" id="incomeRevenueHeading">
          <div>
            <span class="income-statement-section-index" aria-hidden="true">01</span>
            <span>${esc(tr('Revenue', '매출'))}</span>
          </div>
          <small>${esc(tr('Recognized payments in the selected range', '선택 범위 내 인식된 결제'))}</small>
        </div>
        <div class="income-statement-lines" role="table">
          ${viewModel.revenueLines.map((line, index) => renderIncomeStatementLine(line, index)).join('')}
        </div>
        ${reconciliationWarning}
      </section>
      <section class="income-statement-section costs" aria-labelledby="incomeCostsHeading">
        <div class="income-statement-section-title" id="incomeCostsHeading">
          <div>
            <span class="income-statement-section-index" aria-hidden="true">02</span>
            <span>${esc(tr('Costs', '비용'))}</span>
          </div>
          <small>${esc(tr('Costs deducted from net revenue', '순매출에서 차감되는 비용'))}</small>
        </div>
        <div class="income-statement-lines" role="table">
          ${viewModel.costLines.map((line, index) => renderIncomeStatementLine(line, index + viewModel.revenueLines.length)).join('')}
        </div>
      </section>
      <div class="income-statement-result ${resultPositive ? 'positive' : 'negative'}">
        <div class="income-statement-result-copy">
          <span class="income-statement-result-kicker">${esc(tr('Closing position', '최종 손익'))}</span>
          <strong class="income-statement-result-label">${esc(resultLabel)}</strong>
          <small>${esc(tr('Net revenue less all listed costs', '순매출에서 표시된 모든 비용 차감'))}</small>
        </div>
        <div class="income-statement-result-values">
          <strong class="income-statement-result-amount">${formatSignedKrw(summary.trueNetProfit)}</strong>
          <span class="income-statement-result-margin">
            <span>${esc(tr('Margin', '마진'))}</span>
            <b>${esc(formatCalendarPercentMetric(summary.margin))}</b>
          </span>
        </div>
      </div>
      <div class="income-statement-coverage ${coverageClass}">
        <i data-lucide="${coverageIcon}"></i>
        <div>
          <strong>${esc(viewModel.cogsComplete
            ? tr('Cost data complete', '비용 데이터 완료')
            : tr('Cost data needs attention', '비용 데이터 확인 필요'))}</strong>
          <span>${esc(coverageNote)}</span>
        </div>
      </div>
    `;
  }

  function renderCalendarIncomeStatement(selection) {
    const viewModel = buildIncomeStatementViewModel(selection);
    const customFeeValue = calendarState.paymentFeePercent == null
      ? ''
      : esc(String(calendarState.paymentFeePercent));
    const hasCustomFee = calendarState.paymentFeePercent != null;

    return `
      <div class="card income-statement-card" id="calendarIncomeStatement">
        <div class="income-statement-header">
          <div class="income-statement-heading">
            <span class="income-statement-document-mark" aria-hidden="true">P&amp;L</span>
            <div>
              <span class="income-statement-eyebrow">${esc(tr('Selected performance', '선택 범위 실적'))}</span>
              <h2>${esc(tr('Income Statement', '손익계산서'))}</h2>
              <span class="income-statement-period">
                <i data-lucide="calendar-days" aria-hidden="true"></i>
                <span data-income-statement-meta>${esc(viewModel.contextLabel)}</span>
              </span>
            </div>
          </div>
          <div class="income-statement-controls">
            <span class="income-statement-control-label">${esc(tr('Model assumption', '계산 가정'))}</span>
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
        <div class="income-statement-body" data-income-statement-body aria-label="${esc(tr('Income statement for the selected range', '선택 범위 손익계산서'))}">
          ${renderIncomeStatementBody(viewModel)}
        </div>
      </div>
    `;
  }

  function updateCalendarIncomeStatement() {
    const card = document.getElementById('calendarIncomeStatement');
    if (!card) return;

    const body = card.querySelector('[data-income-statement-body]');
    if (!body) return;

    const selection = calendarState.data?.selection || {};
    const viewModel = buildIncomeStatementViewModel(selection);
    const metaEl = card.querySelector('[data-income-statement-meta]');
    if (metaEl) metaEl.textContent = viewModel.contextLabel;

    body.innerHTML = renderIncomeStatementBody(viewModel);
    if (window.lucide) {
      lucide.createIcons({ nodes: [body] });
    }

    syncPaymentFeeControlState();
    renderCalendarProfitSummary();
  }

  function syncPaymentFeeControlState() {
    const ctrl = document.querySelector('.payment-fee-control');
    if (!ctrl) return;
    ctrl.classList.toggle('has-custom-fee', calendarState.paymentFeePercent != null);
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

  function renderCalendarProfitSummary(state = {}) {
    const renderer = live.profitSummary?.renderCalendarSelection;
    if (typeof renderer !== 'function') return;

    ensureCalendarStateInitialized();
    syncCalendarSelectionIntoViewport();

    const hasFreshSelection = hasFreshCalendarSelectionPayload(calendarState.data);
    if (state.loading || (!hasFreshSelection && calendarState.loading)) {
      renderer({ loading: true });
      return;
    }

    if (state.error || (!hasFreshSelection && calendarState.error)) {
      renderer({ error: state.error || calendarState.error });
      return;
    }

    if (!calendarState.data || calendarState.data.ready === false || !hasFreshSelection) {
      renderer({ error: tr('Summary is waiting for the first completed scan.', '첫 완료 스캔을 기다리는 중입니다.') });
      return;
    }

    const selection = calendarState.data.selection || {};
    renderer({
      selection,
      rows: getCalendarWaterfallRows(selection),
      contextLabel: getCalendarWaterfallContextLabel(),
      sourceAudit: calendarState.data?.sourceAudit || null,
    });
  }

  function renderCalendarIncomeStatementDeck() {
    const statementContainer = document.getElementById('calendarIncomeStatementDeck');
    if (!statementContainer) return;

    ensureCalendarStateInitialized();
    syncCalendarSelectionIntoViewport();

    const hasFreshSelection = hasFreshCalendarSelectionPayload(calendarState.data);
    if (!hasFreshSelection && calendarState.loading) {
      renderCalendarProfitSummary({ loading: true });
      statementContainer.innerHTML = renderEmptyStateCard(tr('Income Statement', '손익계산서'), tr('Refreshing the selected-range statement...', '선택 범위 손익계산서를 새로고침 중...'));
      return;
    }

    if (!hasFreshSelection && calendarState.error) {
      renderCalendarProfitSummary({ error: calendarState.error });
      statementContainer.innerHTML = renderEmptyStateCard(tr('Income Statement', '손익계산서'), calendarState.error);
      return;
    }

    if (!calendarState.data || calendarState.data.ready === false || !hasFreshSelection) {
      renderCalendarProfitSummary();
      statementContainer.innerHTML = renderEmptyStateCard(tr('Income Statement', '손익계산서'), tr('Calendar is waiting for the first completed scan.', '첫 완료 스캔을 기다리는 중입니다.'));
      return;
    }

    const selection = calendarState.data.selection || {};
    renderCalendarProfitSummary();
    statementContainer.innerHTML = renderCalendarIncomeStatement(selection);

    if (window.lucide) {
      lucide.createIcons({ nodes: [statementContainer] });
    }

    syncPaymentFeeControlState();
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
    renderCalendarIncomeStatementDeck();

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
        renderCalendarIncomeStatementDeck();
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
    const summaryPageEl = document.querySelector('.page[data-page="calendar"]');

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

    if (summaryPageEl) {
      summaryPageEl.addEventListener('click', event => {
        const resetButton = event.target.closest('[data-calendar-payment-fee-reset]');
        if (resetButton) {
          calendarState.paymentFeePercent = null;
          const input = document.getElementById('calendarPaymentFeeRateInput');
          if (input) input.value = '';
          updateCalendarIncomeStatement();
        }
      });

      summaryPageEl.addEventListener('input', event => {
        if (event.target?.id !== 'calendarPaymentFeeRateInput') return;

        calendarState.paymentFeePercent = parseCalendarPaymentFeePercent(event.target.value);
        clearTimeout(calendarFeeInputDebounceTimer);
        calendarFeeInputDebounceTimer = setTimeout(updateCalendarIncomeStatement, 80);
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
