(function () {
  const live = window.AdPilotLive;
  const { esc, formatSignedKrw, formatKrw, formatUsd, formatPercent, formatCount, tr, getLocale } = live.shared;
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

  function toFiniteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function hasCalendarMetric(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value));
  }

  function formatCalendarPercentMetric(value, digits = 1) {
    return hasCalendarMetric(value) ? formatPercent(Number(value), digits) : '—';
  }

  function formatUsdToKrwRate(value) {
    return `₩${Number(value).toLocaleString(getLocale(), {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  function buildCalendarFxRateLabel(fx = {}) {
    const usdToKrwRate = hasCalendarMetric(fx?.usdToKrwRate) && Number(fx.usdToKrwRate) > 0
      ? Number(fx.usdToKrwRate)
      : null;
    if (usdToKrwRate == null) {
      return tr('FX rate unavailable', '환율 정보 없음');
    }

    const fxDate = isIsoDateKey(fx?.rateDate)
      ? formatUtcDate(fx.rateDate, { month: 'short', day: 'numeric', year: 'numeric' })
      : null;
    const fxRange = isIsoDateKey(fx?.rangeStart) && isIsoDateKey(fx?.rangeEnd)
      ? formatCalendarRange(fx.rangeStart, fx.rangeEnd)
      : null;
    const cachedPrefix = fx.stale ? 'cached ' : '';
    const cachedPrefixKo = fx.stale ? '캐시된 ' : '';
    const contextLabel = fx.basis === 'spend_weighted_average'
      ? tr(
        `${cachedPrefix}spend-weighted average FX${fxRange ? ` · ${fxRange}` : ''}`,
        `${cachedPrefixKo}지출 가중 평균 환율${fxRange ? ` · ${fxRange}` : ''}`
      )
      : fx.basis === 'arithmetic_average'
        ? tr(
          `${cachedPrefix}daily average FX${fxRange ? ` · ${fxRange}` : ''}`,
          `${cachedPrefixKo}일별 평균 환율${fxRange ? ` · ${fxRange}` : ''}`
        )
        : fx.basis === 'latest_fallback'
          ? tr(
            `latest FX fallback${fxDate ? ` · ${fxDate}` : ''}`,
            `최신 환율 대체값${fxDate ? ` · ${fxDate}` : ''}`
          )
          : tr(
            `${cachedPrefix}daily FX${fxDate ? ` · ${fxDate}` : ''}`,
            `${cachedPrefixKo}일별 환율${fxDate ? ` · ${fxDate}` : ''}`
          );

    return `1 USD = ${formatUsdToKrwRate(usdToKrwRate)} · ${contextLabel}`;
  }

  function formatCalendarCellKrw(value, { signed = false } = {}) {
    const numeric = Math.round(toFiniteNumber(value));
    const abs = Math.abs(numeric);
    if (abs === 0) return formatKrw(0);

    const sign = signed && numeric < 0 ? '-' : signed && numeric > 0 ? '+' : '';
    return `${sign}₩${abs.toLocaleString()}`;
  }

  function getCalendarWaterfallContextLabel() {
    return formatCalendarRange(calendarState.selectionStart, calendarState.selectionEnd);
  }

  function buildCalendarWaterfallSummary(selection) {
    const rows = Array.isArray(selection?.days) ? selection.days : [];
    const canonical = selection?.summary || {};
    const costReconciliation = canonical.costReconciliation || {};
    const cogsReconciliation = canonical.costReconciliation?.cogs || {};
    const shippingReconciliation = canonical.costReconciliation?.shipping || {};
    const netCogs = toFiniteNumber(canonical.cogs);
    const netShipping = toFiniteNumber(canonical.shipping);
    const coverage = rows.reduce((summary, day) => {
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

      if (needsCOGSCoverage) {
        summary.daysRequiringCOGS += 1;
        summary.daysWithCOGS += day.hasCOGS ? 1 : 0;
        summary.daysWithPartialCOGS += day.hasPartialCOGS ? 1 : 0;
      }
      return summary;
    }, {
      daysRequiringCOGS: 0,
      daysWithCOGS: 0,
      daysWithPartialCOGS: 0,
    });

    return {
      grossRevenue: toFiniteNumber(canonical.grossRevenue),
      refundedAmount: toFiniteNumber(canonical.refundedAmount),
      returnRefundedAmount: toFiniteNumber(canonical.returnRefundedAmount),
      cancellationRefundedAmount: toFiniteNumber(canonical.cancellationRefundedAmount),
      unclassifiedRefundedAmount: toFiniteNumber(canonical.unclassifiedRefundedAmount),
      netRevenue: toFiniteNumber(canonical.netRevenue),
      adSpend: toFiniteNumber(canonical.adSpend),
      adSpendKRW: toFiniteNumber(canonical.adSpendKRW),
      cogs: netCogs,
      shipping: netShipping,
      purchaseCogs: hasCalendarMetric(cogsReconciliation.purchaseTotal)
        ? toFiniteNumber(cogsReconciliation.purchaseTotal)
        : netCogs,
      refundCogs: toFiniteNumber(cogsReconciliation.refundMarkedTotal),
      cogsSheetTotal: costReconciliation.complete && hasCalendarMetric(cogsReconciliation.sheetTotal)
        ? toFiniteNumber(cogsReconciliation.sheetTotal)
        : null,
      cogsSourcePartitionDelta: toFiniteNumber(cogsReconciliation.sourcePartitionDelta),
      cogsNetCheckDelta: toFiniteNumber(cogsReconciliation.netCheckDelta),
      purchaseShipping: hasCalendarMetric(shippingReconciliation.purchaseTotal)
        ? toFiniteNumber(shippingReconciliation.purchaseTotal)
        : netShipping,
      refundShipping: toFiniteNumber(shippingReconciliation.refundMarkedTotal),
      shippingSheetTotal: costReconciliation.complete && hasCalendarMetric(shippingReconciliation.sheetTotal)
        ? toFiniteNumber(shippingReconciliation.sheetTotal)
        : null,
      shippingSourcePartitionDelta: toFiniteNumber(shippingReconciliation.sourcePartitionDelta),
      shippingNetCheckDelta: toFiniteNumber(shippingReconciliation.netCheckDelta),
      costReconciliationComplete: costReconciliation.complete === true,
      costReconciled: costReconciliation.reconciled === true,
      paymentFees: hasCalendarMetric(canonical.paymentFees)
        ? toFiniteNumber(canonical.paymentFees)
        : null,
      totalCosts: hasCalendarMetric(canonical.totalCosts)
        ? toFiniteNumber(canonical.totalCosts)
        : null,
      trueNetProfit: hasCalendarMetric(canonical.trueNetProfit)
        ? toFiniteNumber(canonical.trueNetProfit)
        : null,
      recognizedOrders: toFiniteNumber(canonical.recognizedOrders),
      refundOrders: toFiniteNumber(canonical.refundOrders),
      returnRefundOrders: toFiniteNumber(canonical.returnRefundOrders),
      cancellationOrders: toFiniteNumber(canonical.cancellationOrders),
      refundRate: hasCalendarMetric(canonical.refundRate)
        ? Number(canonical.refundRate)
        : null,
      margin: hasCalendarMetric(canonical.margin)
        ? Number(canonical.margin)
        : null,
      dayCount: rows.length,
      ...coverage,
      cogsCoverageRatio: coverage.daysRequiringCOGS > 0
        ? Number((coverage.daysWithCOGS / coverage.daysRequiringCOGS).toFixed(3))
        : 1,
      paymentFeesComplete: canonical.paymentFeeCoverage?.complete === true,
      paymentFeeError: canonical.paymentFeeError || null,
      paymentFeeStale: Boolean(canonical.paymentFeeStale),
    };
  }

  function ensureCalendarStateInitialized() {
    if (calendarState.initialized) return;

    const today = getKstDateKey();
    calendarState.anchorMonth = getCalendarMonthStart(today);
    calendarState.selectionStart = getCalendarMonthStart(today);
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
    const profitAvailable = hasCalendarMetric(data.trueNetProfit);
    const netProfit = profitAvailable ? Number(data.trueNetProfit) : null;
    const profitClass = !profitAvailable ? '' : netProfit >= 0 ? 'positive' : 'negative';
    const maxPositiveProfit = Math.max(Number(spectrum?.maxPositiveProfit || 0), 1);
    const maxNegativeLoss = Math.max(Number(spectrum?.maxNegativeLoss || 0), 1);
    const profitSpectrum = profitAvailable && netProfit > 0
      ? Math.min(1, netProfit / maxPositiveProfit)
      : profitAvailable && netProfit < 0
        ? Math.min(1, Math.abs(netProfit) / maxNegativeLoss)
        : 0;
    const dayToneClass = isFuture
      ? 'profit-breakeven'
      : profitAvailable && netProfit > 0
        ? 'profit-positive'
        : profitAvailable && netProfit < 0
          ? 'profit-negative'
          : 'profit-breakeven';
    const tintStrength = isFuture
      ? 0
      : profitAvailable && netProfit > 0
        ? Math.min(1, 0.08 + profitSpectrum * 0.92)
        : profitAvailable && netProfit < 0
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
    const profitFullLabel = isFuture || !profitAvailable ? '—' : formatSignedKrw(data.trueNetProfit);
    const revenueLabel = isFuture ? '—' : formatCalendarCellKrw(data.revenue || 0);
    const profitLabel = isFuture || !profitAvailable
      ? '—'
      : formatCalendarCellKrw(data.trueNetProfit, { signed: true });
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

  function buildIncomeStatementViewModel(selection, fx = {}) {
    const summary = buildCalendarWaterfallSummary(selection);
    const fxRateLabel = buildCalendarFxRateLabel(fx);
    const paymentChannels = selection?.paymentChannels || {};
    const payway = paymentChannels.payway || {};
    const channelsByKey = new Map(
      (Array.isArray(paymentChannels.rows) ? paymentChannels.rows : [])
        .map(row => [String(row?.channel || 'unknown'), {
          ...row,
          revenue: hasCalendarMetric(row?.revenue) ? Number(row.revenue) : null,
          orderCount: hasCalendarMetric(row?.orderCount) ? Number(row.orderCount) : null,
        }])
    );
    const getChannel = channel => channelsByKey.get(channel) || { revenue: null, orderCount: null };
    const shareOf = (value, total) => hasCalendarMetric(value) && total > 0
      ? formatPercent((Math.abs(value) / total) * 100)
      : '—';
    const paymentRows = [
      {
        channel: 'card',
        label: tr('Credit card net receipts', '신용카드 순수입'),
        ...getChannel('card'),
        meta: paymentChannels.ready
          ? tr(
            `${formatKrw(payway.grossApprovals || 0)} approvals − ${formatKrw(payway.cancellations || 0)} cancellations`,
            `승인 ${formatKrw(payway.grossApprovals || 0)} − 취소 ${formatKrw(payway.cancellations || 0)}`
          )
          : tr('Payway data unavailable', 'Payway 데이터를 사용할 수 없음'),
      },
      {
        channel: 'bank_transfer',
        label: tr('Bank transfer net revenue', '계좌이체 순매출'),
        ...getChannel('bank_transfer'),
        meta: tr(
          'Imweb net revenue less Payway card receipts',
          'Imweb 순매출에서 Payway 카드 수입 차감'
        ),
      },
    ];
    const paymentChannelGap = hasCalendarMetric(paymentChannels?.reconciliation?.gap)
      ? Math.round(Number(paymentChannels.reconciliation.gap))
      : null;
    const invalidNegativeBankRemainder = Boolean(
      paymentChannels?.reconciliation?.invalidNegativeBankRemainder
    );
    const totalCosts = summary.totalCosts;
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
    const paymentDataWarning = !paymentChannels.ready
      ? tr(
        `Payway card totals are unavailable${paymentChannels.error ? `: ${paymentChannels.error}` : '.'}`,
        `Payway 카드 합계를 사용할 수 없습니다${paymentChannels.error ? `: ${paymentChannels.error}` : '.'}`
      )
      : paymentChannels.stale
        ? tr(
          'Payway totals are temporarily stale. The last successful result is shown.',
          'Payway 합계가 일시적으로 오래되었습니다. 마지막 성공 결과가 표시됩니다.'
        )
        : !summary.paymentFeesComplete
          ? tr(
            'Some Payway transactions are missing fee values, so net profit is unavailable.',
            '일부 Payway 거래에 수수료 값이 없어 순이익을 표시할 수 없습니다.'
          )
          : null;
    const feeMeta = summary.paymentFeesComplete
      ? tr(
        `Payway actual: ${formatKrw(payway.approvalFees || 0)} charged − ${formatKrw(payway.cancelledFees || 0)} reversed`,
        `Payway 실제: 부과 ${formatKrw(payway.approvalFees || 0)} − 환급 ${formatKrw(payway.cancelledFees || 0)}`
      )
      : tr('Waiting for complete Payway fee data', '완전한 Payway 수수료 데이터를 기다리는 중');
    const hasRefundCostAdjustments = summary.refundCogs > 0 || summary.refundShipping > 0;
    const costReconciliationTone = !summary.costReconciliationComplete || !summary.costReconciled
      ? 'mismatch'
      : 'aligned';
    const costReconciliationNote = !summary.costReconciliationComplete
      ? tr(
        'The parsed COGS Sheet row totals are unavailable for part of this range. Net COGS and shipping are shown, but source-to-income alignment cannot be verified.',
        '선택 기간 일부의 COGS Sheet 원본 행 합계를 사용할 수 없습니다. 순원가와 순배송비는 표시되지만 원본과 손익계산서 간 일치 여부는 확인할 수 없습니다.'
      )
      : !summary.costReconciled
        ? tr(
          `COGS Sheet classification does not reconcile. COGS source partition ${formatSignedKrw(summary.cogsSourcePartitionDelta)}, COGS net check ${formatSignedKrw(summary.cogsNetCheckDelta)}, shipping source partition ${formatSignedKrw(summary.shippingSourcePartitionDelta)}, shipping net check ${formatSignedKrw(summary.shippingNetCheckDelta)}. Review the refund-marked rows before relying on profit.`,
          `COGS Sheet 분류가 일치하지 않습니다. 원가 원본 분류 차이 ${formatSignedKrw(summary.cogsSourcePartitionDelta)}, 원가 순액 검증 차이 ${formatSignedKrw(summary.cogsNetCheckDelta)}, 배송비 원본 분류 차이 ${formatSignedKrw(summary.shippingSourcePartitionDelta)}, 배송비 순액 검증 차이 ${formatSignedKrw(summary.shippingNetCheckDelta)}입니다. 순이익을 사용하기 전에 환불 표시 행을 확인하세요.`
        )
        : hasRefundCostAdjustments
          ? tr(
            `COGS Sheet and income statement align. The raw positive-column totals are ${formatKrw(summary.cogsSheetTotal)} cost and ${formatKrw(summary.shippingSheetTotal)} shipping: ${formatKrw(summary.purchaseCogs)} purchases + ${formatKrw(summary.refundCogs)} refund-marked COGS, and ${formatKrw(summary.purchaseShipping)} shipping paid + ${formatKrw(summary.refundShipping)} refund-marked shipping. Profit shows those recoveries separately, producing net COGS of ${formatKrw(summary.cogs)} and net shipping of ${formatKrw(summary.shipping)}.`,
            `COGS Sheet와 손익계산서가 일치합니다. 양수 열 원본 합계는 원가 ${formatKrw(summary.cogsSheetTotal)}, 배송비 ${formatKrw(summary.shippingSheetTotal)}이며, 매입 원가 ${formatKrw(summary.purchaseCogs)} + 환불 표시 원가 ${formatKrw(summary.refundCogs)}, 지급 배송비 ${formatKrw(summary.purchaseShipping)} + 환불 표시 배송비 ${formatKrw(summary.refundShipping)}로 구성됩니다. 손익에는 환급을 별도 표시하여 순원가 ${formatKrw(summary.cogs)}, 순배송비 ${formatKrw(summary.shipping)}를 반영합니다.`
          )
          : tr(
            'COGS Sheet cost and shipping totals match the net amounts used in profit; no refund/recovery adjustment applies to this range.',
            'COGS Sheet의 원가 및 배송비 합계가 순이익 계산에 사용된 순액과 일치하며, 이 기간에는 환불/환급 조정이 없습니다.'
          );
    const renderNetCostBridge = ({
      grossKey,
      grossLabel,
      grossMeta,
      grossTotal,
      recoveryKey,
      recoveryLabel,
      recoveryMeta,
      recoveryTotal,
      netKey,
      netLabel,
      netMeta,
      netTotal,
    }) => [
      {
        key: grossKey,
        label: grossLabel,
        meta: grossMeta,
        amount: -grossTotal,
        percent: shareOf(grossTotal, summary.netRevenue),
        kind: 'cost',
      },
      {
        key: recoveryKey,
        label: recoveryLabel,
        meta: recoveryMeta,
        amount: recoveryTotal,
        percent: shareOf(recoveryTotal, summary.netRevenue),
        kind: 'detail recovery',
      },
      {
        key: netKey,
        label: netLabel,
        meta: netMeta,
        amount: -netTotal,
        percent: shareOf(netTotal, summary.netRevenue),
        kind: 'subtotal',
      },
    ];
    const cogsRecoveryMeta = summary.costReconciliationComplete
      ? tr('Refund-marked COGS Sheet rows shown separately from purchases', '매입과 분리 표시한 COGS Sheet 환불 표시 행')
      : tr('Current recovery classification; source-row alignment is unavailable', '현재 환급 분류이며 원본 행 일치 여부는 확인할 수 없음');
    const shippingRecoveryMeta = summary.costReconciliationComplete
      ? tr('Refund-marked shipping shown separately from shipping paid', '지급 배송비와 분리 표시한 환불 표시 배송비')
      : tr('Current reimbursement classification; source-row alignment is unavailable', '현재 환급 배송비 분류이며 원본 행 일치 여부는 확인할 수 없음');

    return {
      summary,
      contextLabel: getCalendarWaterfallContextLabel(),
      paymentRows,
      paymentChannelGap,
      invalidNegativeBankRemainder,
      paymentDataWarning,
      totalCosts,
      cogsComplete,
      coverageLabel,
      costReconciliationNote,
      costReconciliationTone,
      revenueLines: [
        {
          key: 'gross-revenue',
          label: tr('Total revenue', '총매출'),
          meta: tr(`${formatCount(orderCount)} recognized orders`, `인식 주문 ${formatCount(orderCount)}건`),
          amount: summary.grossRevenue,
          percent: '100%',
          kind: 'subtotal',
        },
        {
          key: 'returns',
          label: tr('Returns and refunds', '반품 환불'),
          meta: tr(
            `${formatCount(summary.returnRefundOrders)} post-delivery return ${summary.returnRefundOrders === 1 ? 'order' : 'orders'} · share of total gross revenue`,
            `배송 후 반품 주문 ${formatCount(summary.returnRefundOrders)}건 · 총매출 기준 비율`
          ),
          amount: -summary.returnRefundedAmount,
          percent: shareOf(summary.returnRefundedAmount, summary.grossRevenue),
          kind: 'deduction',
        },
        {
          key: 'cancellations',
          label: tr('Order cancellations', '주문 취소'),
          meta: tr(
            `${formatCount(summary.cancellationOrders)} cancelled ${summary.cancellationOrders === 1 ? 'order' : 'orders'}`,
            `취소 주문 ${formatCount(summary.cancellationOrders)}건`
          ),
          amount: -summary.cancellationRefundedAmount,
          percent: shareOf(summary.cancellationRefundedAmount, summary.grossRevenue),
          kind: 'deduction',
        },
        ...(summary.unclassifiedRefundedAmount > 0 ? [{
          key: 'unclassified-reversals',
          label: tr('Other revenue reversals', '기타 매출 차감'),
          meta: tr(
            'Needs Imweb status classification',
            'Imweb 상태 분류 필요'
          ),
          amount: -summary.unclassifiedRefundedAmount,
          percent: shareOf(summary.unclassifiedRefundedAmount, summary.grossRevenue),
          kind: 'deduction',
        }] : []),
        ...paymentRows.map(row => ({
          key: `payment-${row.channel}`,
          label: row.label,
          meta: row.meta,
          amount: row.revenue,
          percent: shareOf(row.revenue, summary.netRevenue),
          kind: 'detail',
        })),
        {
          key: 'net-revenue',
          label: tr('Net revenue', '순매출'),
          meta: tr('Card receipts + bank-transfer remainder', '카드 수입 + 계좌이체 잔액'),
          amount: summary.netRevenue,
          percent: shareOf(summary.netRevenue, summary.grossRevenue),
          kind: 'total',
        },
      ],
      costLines: [
        ...renderNetCostBridge({
          grossKey: 'gross-cogs',
          grossLabel: tr('Gross COGS purchased', '총 매입 원가'),
          grossMeta: tr('COGS Sheet purchase rows · refund-marked rows excluded', 'COGS Sheet 매입 행 · 환불 표시 행 제외'),
          grossTotal: summary.purchaseCogs,
          recoveryKey: 'recovered-cogs',
          recoveryLabel: tr('Less: recovered/returned COGS', '차감: 회수/반품 원가'),
          recoveryMeta: cogsRecoveryMeta,
          recoveryTotal: summary.refundCogs,
          netKey: 'net-cogs',
          netLabel: tr('Net COGS used in profit', '순이익 계산 반영 순원가'),
          netMeta: coverageLabel,
          netTotal: summary.cogs,
        }),
        ...renderNetCostBridge({
          grossKey: 'shipping-paid',
          grossLabel: tr('Shipping paid', '지급 배송비'),
          grossMeta: tr('COGS Sheet shipping on purchase rows · refund-marked rows excluded', 'COGS Sheet 매입 행 배송비 · 환불 표시 행 제외'),
          grossTotal: summary.purchaseShipping,
          recoveryKey: 'shipping-reimbursed',
          recoveryLabel: tr('Less: shipping reimbursed', '차감: 환급 배송비'),
          recoveryMeta: shippingRecoveryMeta,
          recoveryTotal: summary.refundShipping,
          netKey: 'net-shipping',
          netLabel: tr('Net shipping used in profit', '순이익 계산 반영 순배송비'),
          netMeta: orderCount > 0
            ? tr(`${formatKrw(shippingPerOrder)} net per recognized order`, `인식 주문당 순배송비 ${formatKrw(shippingPerOrder)}`)
            : tr('No recognized orders', '인식된 주문 없음'),
          netTotal: summary.shipping,
        }),
        {
          key: 'payment-fees',
          label: tr('Payment processing fees', '결제 처리 수수료'),
          meta: feeMeta,
          amount: summary.paymentFees == null ? null : -summary.paymentFees,
          percent: shareOf(summary.paymentFees, summary.netRevenue),
          kind: 'cost',
        },
        {
          key: 'ad-spend',
          label: tr('Meta ad spend', 'Meta 광고비'),
          meta: tr('Meta Ads · USD billing', 'Meta 광고 · USD 청구'),
          amount: -summary.adSpendKRW,
          sourceAmountLabel: `${formatUsd(summary.adSpend || 0, 2)} USD`,
          fxRateLabel,
          percent: shareOf(summary.adSpendKRW, summary.netRevenue),
          kind: 'cost',
        },
        {
          key: 'total-costs',
          label: tr('Total costs', '총비용'),
          meta: tr('COGS + shipping + fees + advertising', '원가 + 배송비 + 수수료 + 광고비'),
          amount: totalCosts == null ? null : -totalCosts,
          percent: shareOf(totalCosts, summary.netRevenue),
          kind: 'total-costs',
        },
      ],
    };
  }

  function renderIncomeStatementLine(line) {
    const hasAmount = hasCalendarMetric(line.amount);
    const amount = hasAmount && Math.abs(Number(line.amount)) >= 0.5 ? Number(line.amount) : 0;
    const amountLabel = hasAmount
      ? amount < 0 ? formatSignedKrw(amount) : formatKrw(amount)
      : '—';
    const amountMarkup = line.key === 'ad-spend'
      ? `
        <div
          class="income-statement-ad-spend-values"
          role="cell"
          aria-label="${esc(`${amountLabel}; ${line.sourceAmountLabel}; ${line.fxRateLabel}`)}"
        >
          <strong class="income-statement-amount">${amountLabel}</strong>
          <span class="income-statement-source-amount">${esc(line.sourceAmountLabel)}</span>
          <small>${esc(line.fxRateLabel)}</small>
        </div>
      `
      : `<strong class="income-statement-amount" role="cell">${amountLabel}</strong>`;

    return `
      <div class="income-statement-line ${esc(line.kind || '')}" role="row">
        <div class="income-statement-account" role="rowheader">
          <span>${esc(line.label)}</span>
          <small>${esc(line.meta || '')}</small>
        </div>
        <span class="income-statement-percent" role="cell">${esc(line.percent || '—')}</span>
        ${amountMarkup}
      </div>
    `;
  }

  function renderIncomeStatementBody(viewModel) {
    const { summary } = viewModel;
    const profitAvailable = hasCalendarMetric(summary.trueNetProfit);
    const resultPositive = profitAvailable && summary.trueNetProfit >= 0;
    const resultLabel = !profitAvailable
      ? tr('Net profit unavailable', '순이익 사용 불가')
      : resultPositive
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
    const reconciliationWarning = viewModel.paymentChannelGap == null
      || viewModel.paymentChannelGap === 0
      ? ''
      : `
        <div class="income-statement-alert" role="status">
          <i data-lucide="circle-alert"></i>
          <span>${esc(tr(
            `Payment-channel net revenue differs from Imweb net revenue by ${formatSignedKrw(viewModel.paymentChannelGap)}.`,
            `결제수단별 순매출과 Imweb 순매출의 차이는 ${formatSignedKrw(viewModel.paymentChannelGap)}입니다.`
          ))}</span>
        </div>
      `;
    const negativeRemainderWarning = viewModel.invalidNegativeBankRemainder
      ? `
        <div class="income-statement-alert" role="status">
          <i data-lucide="triangle-alert"></i>
          <span>${esc(tr(
            'Payway card receipts exceed Imweb net revenue for this range. Check the selected date basis before using the bank-transfer remainder.',
            '이 기간의 Payway 카드 수입이 Imweb 순매출을 초과합니다. 계좌이체 잔액을 사용하기 전에 선택한 날짜 기준을 확인하세요.'
          ))}</span>
        </div>
      `
      : '';
    const paymentDataWarning = viewModel.paymentDataWarning
      ? `
        <div class="income-statement-alert" role="status">
          <i data-lucide="database-zap"></i>
          <span>${esc(viewModel.paymentDataWarning)}</span>
        </div>
      `
      : '';

    return `
      <div class="income-statement-columns" aria-hidden="true">
        <span>${esc(tr('Account', '계정'))}</span>
        <span>${esc(tr('% of base', '기준 비율'))}</span>
        <span>${esc(tr('Amount · KRW', '금액 · KRW'))}</span>
      </div>
      <section class="income-statement-section revenue" aria-labelledby="incomeRevenueHeading">
        <div class="income-statement-section-title" id="incomeRevenueHeading">${esc(tr('Revenue', '매출'))}</div>
        <div class="income-statement-lines" role="table">
          ${viewModel.revenueLines.map(line => renderIncomeStatementLine(line)).join('')}
        </div>
        ${reconciliationWarning}
        ${negativeRemainderWarning}
        ${paymentDataWarning}
      </section>
      <section class="income-statement-section costs" aria-labelledby="incomeCostsHeading">
        <div class="income-statement-section-title" id="incomeCostsHeading">${esc(tr('Costs', '비용'))}</div>
        <div class="income-statement-lines" role="table">
          ${viewModel.costLines.map(line => renderIncomeStatementLine(line)).join('')}
        </div>
        ${viewModel.costReconciliationNote ? `
          <div class="income-statement-source-reconciliation ${esc(viewModel.costReconciliationTone)}" role="note">
            <i data-lucide="${viewModel.costReconciliationTone === 'mismatch' ? 'triangle-alert' : 'scale'}"></i>
            <div>
              <strong>${esc(tr('COGS Sheet reconciliation', 'COGS Sheet 조정 내역'))}</strong>
              <span>${esc(viewModel.costReconciliationNote)}</span>
            </div>
          </div>
        ` : ''}
      </section>
      <div class="income-statement-result ${!profitAvailable ? 'unavailable' : resultPositive ? 'positive' : 'negative'}">
        <div class="income-statement-result-copy">
          <strong class="income-statement-result-label">${esc(resultLabel)}</strong>
          <small>${esc(tr('Net revenue less all listed costs', '순매출에서 표시된 모든 비용 차감'))}</small>
        </div>
        <div class="income-statement-result-values">
          <strong class="income-statement-result-amount">${profitAvailable ? formatSignedKrw(summary.trueNetProfit) : '—'}</strong>
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

  function renderCalendarIncomeStatement(selection, fx) {
    const viewModel = buildIncomeStatementViewModel(selection, fx);

    return `
      <div class="card income-statement-card" id="calendarIncomeStatement">
        <div class="income-statement-header">
          <div class="income-statement-heading">
            <h2>${esc(tr('Income Statement', '손익계산서'))}</h2>
            <span class="income-statement-period">
              <i data-lucide="calendar-days" aria-hidden="true"></i>
              <span data-income-statement-meta>${esc(viewModel.contextLabel)}</span>
            </span>
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
    const viewModel = buildIncomeStatementViewModel(selection, calendarState.data?.fx);
    const metaEl = card.querySelector('[data-income-statement-meta]');
    if (metaEl) metaEl.textContent = viewModel.contextLabel;

    body.innerHTML = renderIncomeStatementBody(viewModel);
    if (window.lucide) {
      lucide.createIcons({ nodes: [body] });
    }

    renderCalendarProfitSummary();
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

  function buildRefundMonitorViewModel(refundComparison) {
    const historical = refundComparison?.historical || {};
    const monthToDate = refundComparison?.monthToDate || {};
    const historicalOrderRate = hasCalendarMetric(historical.orderRate)
      ? Math.max(0, Number(historical.orderRate))
      : null;
    const historicalRevenueRate = hasCalendarMetric(historical.revenueRate)
      ? Math.max(0, Number(historical.revenueRate))
      : null;
    const monthToDateOrderRate = hasCalendarMetric(monthToDate.orderRate)
      ? Math.max(0, Number(monthToDate.orderRate))
      : null;
    const monthToDateRevenueRate = hasCalendarMetric(monthToDate.revenueRate)
      ? Math.max(0, Number(monthToDate.revenueRate))
      : null;

    return {
      historicalOrderRate,
      historicalRevenueRate,
      monthToDateOrderRate,
      monthToDateRevenueRate,
      orderComparison: buildRefundMetricComparison(
        tr('Orders', '주문'),
        monthToDateOrderRate,
        historicalOrderRate,
        tr('No recognized orders', '확인된 주문 없음')
      ),
      revenueComparison: buildRefundMetricComparison(
        tr('Revenue', '매출'),
        monthToDateRevenueRate,
        historicalRevenueRate,
        tr('No revenue', '매출 없음')
      ),
      tone: monthToDate.status === 'above_benchmark'
        ? 'above'
        : monthToDateOrderRate == null && monthToDateRevenueRate == null
          ? 'unavailable'
          : 'within',
    };
  }

  function buildRefundMetricComparison(metricLabel, currentRate, historicalRate, unavailableLabel) {
    if (currentRate == null || historicalRate == null) {
      return {
        label: `${metricLabel} · ${unavailableLabel}`,
        symbol: '—',
        tone: 'unavailable',
      };
    }
    if (currentRate === historicalRate) {
      return {
        label: `${metricLabel} · ${tr('matches average', '평균과 동일')}`,
        symbol: '=',
        tone: 'within',
      };
    }

    const delta = currentRate - historicalRate;
    if (historicalRate === 0) {
      return {
        label: `${metricLabel} · ${tr(
          `${formatPercent(currentRate, 1)} vs 0.0% average`,
          `${formatPercent(currentRate, 1)} / 평균 0.0%`
        )}`,
        symbol: delta < 0 ? '↓' : '↑',
        tone: delta < 0 ? 'within' : 'above',
      };
    }

    const relativeDifference = Math.abs((delta / historicalRate) * 100);
    const direction = delta < 0
      ? tr(
        `${relativeDifference.toFixed(1)}% below average`,
        `평균보다 ${relativeDifference.toFixed(1)}% 낮음`
      )
      : tr(
        `${relativeDifference.toFixed(1)}% above average`,
        `평균보다 ${relativeDifference.toFixed(1)}% 높음`
      );
    return {
      label: `${metricLabel} · ${direction}`,
      symbol: delta < 0 ? '↓' : '↑',
      tone: delta < 0 ? 'within' : 'above',
    };
  }

  function renderRefundMonitorPlaceholder(message, tone = 'neutral') {
    const container = document.getElementById('refundRateMonitor');
    if (!container) return;

    container.setAttribute('aria-busy', 'true');
    container.innerHTML = `
      <div class="card refund-monitor-card refund-monitor-placeholder ${tone === 'error' ? 'is-error' : ''}">
        <div class="refund-monitor-kicker">${esc(tr('Refunds', '환불'))}</div>
        <h2>${esc(tr('Post-delivery return rates · cancellations excluded', '배송 후 반품률 · 주문 취소 제외'))}</h2>
        <p>${esc(message)}</p>
      </div>
    `;
  }

  function renderCalendarRefundRateMonitor(state = {}) {
    const container = document.getElementById('refundRateMonitor');
    if (!container) return;

    if (state.loading) {
      renderRefundMonitorPlaceholder(
        tr('Refreshing the refund comparison...', '환불 비교를 새로고침 중입니다...')
      );
      return;
    }

    if (state.error) {
      renderRefundMonitorPlaceholder(state.error, 'error');
      return;
    }

    if (!calendarState.data || calendarState.data.ready === false) {
      renderRefundMonitorPlaceholder(
        tr('Waiting for the first completed scan.', '첫 완료 스캔을 기다리는 중입니다.')
      );
      return;
    }

    const refundComparison = calendarState.data.refundComparison || {};
    const viewModel = buildRefundMonitorViewModel(refundComparison);
    if (viewModel.historicalOrderRate == null && viewModel.historicalRevenueRate == null) {
      renderRefundMonitorPlaceholder(
        tr(
          'The historical comparison will appear after recognized orders or gross revenue are available.',
          '확인된 주문 또는 총매출 데이터가 확보되면 과거 비교가 표시됩니다.'
        )
      );
      return;
    }
    const metricComparisons = [
      viewModel.orderComparison,
      viewModel.revenueComparison,
    ];
    const comparisonMarkup = metricComparisons.every(comparison => comparison.tone === 'unavailable')
      ? `
        <div class="refund-monitor-delta is-unavailable">
          <span aria-hidden="true">—</span>
          <strong>${esc(tr('No month-to-date comparison', '월 누계 비교 없음'))}</strong>
        </div>
      `
      : metricComparisons.map(comparison => `
        <div class="refund-monitor-delta is-${esc(comparison.tone)}" aria-label="${esc(comparison.label)}">
          <span aria-hidden="true">${esc(comparison.symbol)}</span>
          <strong>${esc(comparison.label)}</strong>
        </div>
      `).join('');

    container.setAttribute('aria-busy', 'false');
    container.innerHTML = `
      <section
        class="card refund-monitor-card tone-${esc(viewModel.tone)}"
        aria-labelledby="refundMonitorTitle"
      >
        <header class="refund-monitor-header">
          <div>
            <div class="refund-monitor-kicker">${esc(tr('Refunds', '환불'))}</div>
            <h2 id="refundMonitorTitle">${esc(tr('Post-delivery return rates · cancellations excluded', '배송 후 반품률 · 주문 취소 제외'))}</h2>
          </div>
        </header>

        <div class="refund-monitor-comparison">
          <div class="refund-monitor-period">
            <span class="refund-monitor-period-label">${esc(tr('Historical monthly average', '과거 월평균'))}</span>
            <div class="refund-monitor-metrics">
              <div class="refund-monitor-metric">
                <strong>${viewModel.historicalOrderRate == null ? '—' : esc(formatPercent(viewModel.historicalOrderRate, 1))}</strong>
                <span>${esc(tr('order return rate', '주문 기준 반품률'))}</span>
              </div>
              <div class="refund-monitor-metric">
                <strong>${viewModel.historicalRevenueRate == null ? '—' : esc(formatPercent(viewModel.historicalRevenueRate, 1))}</strong>
                <span>${esc(tr('revenue return rate', '매출 기준 반품률'))}</span>
              </div>
            </div>
          </div>

          <div class="refund-monitor-deltas">
            ${comparisonMarkup}
          </div>

          <div class="refund-monitor-period refund-monitor-period-current">
            <span class="refund-monitor-period-label">${esc(tr('Month to date', '월 누계'))}</span>
            <div class="refund-monitor-metrics">
              <div class="refund-monitor-metric is-${esc(viewModel.orderComparison.tone)}">
                <strong>${viewModel.monthToDateOrderRate == null ? '—' : esc(formatPercent(viewModel.monthToDateOrderRate, 1))}</strong>
                <span>${esc(tr('order return rate', '주문 기준 반품률'))}</span>
              </div>
              <div class="refund-monitor-metric is-${esc(viewModel.revenueComparison.tone)}">
                <strong>${viewModel.monthToDateRevenueRate == null ? '—' : esc(formatPercent(viewModel.monthToDateRevenueRate, 1))}</strong>
                <span>${esc(tr('revenue return rate', '매출 기준 반품률'))}</span>
              </div>
            </div>
          </div>
        </div>
      </section>
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
      contextLabel: getCalendarWaterfallContextLabel(),
      sourceAudit: calendarState.data?.sourceAudit || null,
    });
  }

  function formatPatternHour(hour) {
    return `${String(hour).padStart(2, '0')}:00`;
  }

  function buildOrderPatternsViewModel(patterns) {
    const weekdaySource = Array.isArray(patterns?.weekday) ? patterns.weekday : [];
    const hourlySource = Array.isArray(patterns?.hourly) ? patterns.hourly : [];
    const summary = patterns?.summary || {};
    const totalOrders = Math.max(0, toFiniteNumber(summary.totalOrders));

    const weekdayLabels = tr(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], ['월', '화', '수', '목', '금', '토', '일']);
    const weekdayByIndex = new Map(weekdaySource.map(row => [Number(row?.dayIndex), row]));
    const weekdayRows = [1, 2, 3, 4, 5, 6, 0].map((dayIndex, position) => {
      const row = weekdayByIndex.get(dayIndex) || {};
      return {
        label: weekdayLabels[position],
        orders: Math.max(0, toFiniteNumber(row.orders)),
        revenue: Math.max(0, toFiniteNumber(row.revenue)),
      };
    });
    const maxWeekdayOrders = weekdayRows.reduce((max, row) => Math.max(max, row.orders), 0);
    const peakWeekday = weekdayRows.reduce(
      (peak, row) => (row.orders > (peak?.orders || 0) ? row : peak),
      null
    );

    const hourRows = Array.from({ length: 24 }, (_, hour) => {
      const row = hourlySource.find(entry => Number(entry?.hour) === hour) || {};
      return {
        hour,
        orders: Math.max(0, toFiniteNumber(row.orders)),
        revenue: Math.max(0, toFiniteNumber(row.revenue)),
      };
    });
    const maxHourOrders = hourRows.reduce((max, row) => Math.max(max, row.orders), 0);

    let peakWindow = null;
    if (totalOrders > 0) {
      for (let start = 0; start < 24; start += 1) {
        const orders = hourRows[start].orders
          + hourRows[(start + 1) % 24].orders
          + hourRows[(start + 2) % 24].orders;
        if (orders > (peakWindow?.orders || 0)) {
          peakWindow = { start, end: (start + 3) % 24, orders };
        }
      }
    }
    const peakHours = new Set(peakWindow
      ? [peakWindow.start, (peakWindow.start + 1) % 24, (peakWindow.start + 2) % 24]
      : []);

    return {
      totalOrders,
      range: patterns?.range || {},
      weekdayRows,
      maxWeekdayOrders,
      peakWeekday,
      hourRows,
      maxHourOrders,
      peakWindow,
      peakHours,
    };
  }

  function renderOrderPatternsCard(viewModel) {
    const { totalOrders, range } = viewModel;
    const rangeLabel = range.start && range.end ? formatCalendarRange(range.start, range.end) : null;
    const sampleNote = [
      tr(
        `Based on ${formatCount(totalOrders)} recognized orders`,
        `인식 주문 ${formatCount(totalOrders)}건 기준`
      ),
      rangeLabel,
      'KST',
      totalOrders > 0
        ? tr('Gross revenue before refunds and fees', '환불·수수료 차감 전 총매출')
        : null,
      totalOrders > 0 && totalOrders < 100
        ? tr('Early data — patterns may shift', '데이터가 아직 적어 패턴이 바뀔 수 있습니다')
        : null,
    ].filter(Boolean).join(' · ');

    const weekdayRowsHtml = viewModel.weekdayRows.map(row => {
      const isPeak = totalOrders > 0 && viewModel.peakWeekday && row === viewModel.peakWeekday;
      const width = viewModel.maxWeekdayOrders > 0
        ? Math.max(row.orders > 0 ? 2 : 0, Math.round((row.orders / viewModel.maxWeekdayOrders) * 100))
        : 0;
      return `
        <div class="order-patterns-weekday-row ${isPeak ? 'peak' : ''}" role="row">
          <span class="order-patterns-weekday-label" role="rowheader">${esc(row.label)}</span>
          <span class="order-patterns-bar" aria-hidden="true"><span style="width:${width}%"></span></span>
          <span class="order-patterns-orders" role="cell">${formatCount(row.orders)}</span>
          <span class="order-patterns-revenue" role="cell">${formatKrw(row.revenue)}</span>
        </div>
      `;
    }).join('');

    const hourlyRevenueAvailable = viewModel.hourRows.some(row => row.revenue > 0);
    const hourBarsHtml = viewModel.hourRows.map(row => {
      const height = viewModel.maxHourOrders > 0
        ? Math.max(row.orders > 0 ? 4 : 0, Math.round((row.orders / viewModel.maxHourOrders) * 100))
        : 0;
      const revenueSuffix = hourlyRevenueAvailable ? ` · ${formatKrw(row.revenue)}` : '';
      const tooltip = tr(
        `${formatPatternHour(row.hour)} · ${formatCount(row.orders)} orders${revenueSuffix}`,
        `${formatPatternHour(row.hour)} · 주문 ${formatCount(row.orders)}건${revenueSuffix}`
      );
      const isPeak = viewModel.peakHours.has(row.hour);
      return `<span class="order-patterns-hour-slot" title="${esc(tooltip)}"><span class="order-patterns-hour-bar ${isPeak ? 'peak' : ''}" style="height:${height}%"></span></span>`;
    }).join('');

    const hourAxisHtml = viewModel.hourRows.map(row => {
      const labelled = row.hour % 6 === 0 || row.hour === 23;
      return `<span class="order-patterns-hour-tick">${labelled ? String(row.hour).padStart(2, '0') : ''}</span>`;
    }).join('');

    return `
      <div class="card order-patterns-card">
        <div class="order-patterns-header">
          <h2>${esc(tr('Order Patterns', '주문 패턴'))}</h2>
          <span class="order-patterns-subtitle">${esc(tr('When orders happen across all synced history', '전체 동기화 기간의 주문 발생 시점'))}</span>
        </div>
        ${totalOrders === 0 ? `
          <p class="order-patterns-empty">${esc(tr('Order timing trends will appear once orders are synced.', '주문이 동기화되면 시점 트렌드가 표시됩니다.'))}</p>
        ` : `
          <div class="order-patterns-body">
            <section class="order-patterns-panel" aria-label="${esc(tr('Orders by weekday', '요일별 주문'))}">
              <div class="order-patterns-panel-head">
                <span class="order-patterns-panel-title">${esc(tr('Orders by weekday', '요일별 주문'))}</span>
              </div>
              <div class="order-patterns-weekday-rows" role="table">
                ${weekdayRowsHtml}
              </div>
            </section>
            <section class="order-patterns-panel" aria-label="${esc(tr('Orders by hour of day', '시간대별 주문'))}">
              <div class="order-patterns-panel-head">
                <span class="order-patterns-panel-title">${esc(tr('Orders by hour · KST', '시간대별 주문 · KST'))}</span>
              </div>
              <div class="order-patterns-hours">
                ${hourBarsHtml}
              </div>
              <div class="order-patterns-hour-axis" aria-hidden="true">
                ${hourAxisHtml}
              </div>
            </section>
          </div>
        `}
        <div class="order-patterns-footnote">${esc(sampleNote)}</div>
      </div>
    `;
  }

  function renderCalendarOrderPatternsSection() {
    const container = document.getElementById('calendarOrderPatterns');
    if (!container) return;

    const data = calendarState.data;
    if (!data || data.ready === false) {
      if (calendarState.loading && container.childElementCount > 0) return;
      container.innerHTML = '';
      return;
    }

    const viewModel = buildOrderPatternsViewModel(data.orderPatterns);
    container.innerHTML = renderOrderPatternsCard(viewModel);
  }

  function renderCalendarIncomeStatementDeck() {
    const statementContainer = document.getElementById('calendarIncomeStatementDeck');
    if (!statementContainer) return;

    renderCalendarOrderPatternsSection();

    ensureCalendarStateInitialized();
    syncCalendarSelectionIntoViewport();

    const hasFreshSelection = hasFreshCalendarSelectionPayload(calendarState.data);
    if (!hasFreshSelection && calendarState.loading) {
      renderCalendarProfitSummary({ loading: true });
      renderCalendarRefundRateMonitor({ loading: true });
      statementContainer.innerHTML = renderEmptyStateCard(tr('Income Statement', '손익계산서'), tr('Refreshing the selected-range statement...', '선택 범위 손익계산서를 새로고침 중...'));
      return;
    }

    if (!hasFreshSelection && calendarState.error) {
      renderCalendarProfitSummary({ error: calendarState.error });
      renderCalendarRefundRateMonitor({ error: calendarState.error });
      statementContainer.innerHTML = renderEmptyStateCard(tr('Income Statement', '손익계산서'), calendarState.error);
      return;
    }

    if (!calendarState.data || calendarState.data.ready === false || !hasFreshSelection) {
      renderCalendarProfitSummary();
      renderCalendarRefundRateMonitor();
      statementContainer.innerHTML = renderEmptyStateCard(tr('Income Statement', '손익계산서'), tr('Calendar is waiting for the first completed scan.', '첫 완료 스캔을 기다리는 중입니다.'));
      return;
    }

    const selection = calendarState.data.selection || {};
    renderCalendarProfitSummary();
    renderCalendarRefundRateMonitor();
    statementContainer.innerHTML = renderCalendarIncomeStatement(selection, calendarState.data.fx);

    if (window.lucide) {
      lucide.createIcons({ nodes: [statementContainer] });
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
    const monthToDateBtn = document.getElementById('calendarMonthToDateBtn');
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

    if (monthToDateBtn) {
      monthToDateBtn.addEventListener('click', async () => {
        const today = getKstDateKey();
        calendarState.anchorMonth = getCalendarMonthStart(today);
        calendarState.selectionStart = getCalendarMonthStart(today);
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
