(function () {
  const live = window.AdPilotLive;
  const { esc, safeConfidenceLevel, formatSignedKrw, formatKrw, formatPercent, formatCount, tr, getLocale } = live.shared;
  const { fetchAnalytics } = live.api;
  const { getSeriesWindowMeta, sliceRowsByWindow } = live.seriesWindows;
  let cachedAnalyticsData = null;
  let profitWaterfallGranularity = 'day';

  function toFiniteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function formatNullablePercent(value, digits = 1) {
    if (!hasNumericValue(value)) return '—';
    return formatPercent(Number(value), digits);
  }

  function formatNullableRoas(value) {
    if (!hasNumericValue(value)) return '—';
    return `${Number(value).toFixed(2)}x`;
  }

  function hasNumericValue(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value));
  }

  function formatNullableKrw(value) {
    return hasNumericValue(value) ? formatKrw(Number(value)) : '—';
  }

  function formatNullableSignedKrw(value) {
    return hasNumericValue(value) ? formatSignedKrw(Number(value)) : '—';
  }

  function formatNullableCount(value) {
    return hasNumericValue(value) ? formatCount(Number(value)) : '—';
  }

  function emptyCoverage() {
    return {
      totalDays: 0,
      daysWithCOGS: 0,
      daysWithPartialCOGS: 0,
      daysWithPendingRecovery: 0,
      coverageRatio: 0,
      cogsCoveredRange: {},
      missingRanges: [],
      confidence: { level: 'low', label: tr('Waiting for data', '데이터 대기 중') },
    };
  }

  function getProfitWindowSummary(profitAnalysis, windowKey) {
    const summaries = profitAnalysis?.windowSummaries || {};
    return summaries[windowKey] || summaries.all || {
      daysShown: 0,
      totalProfit: null,
      totalGrossRevenue: null,
      totalRefunded: null,
      totalOrders: null,
      totalCosts: null,
      blendedMargin: null,
      trueRoas: null,
      refundRate: null,
      costsShare: null,
      coverage: profitAnalysis?.coverage || emptyCoverage(),
    };
  }

  function parseDateKey(dateKey) {
    const [year, month, day] = String(dateKey || '').split('-').map(Number);
    if (!year || !month || !day) return null;
    return new Date(Date.UTC(year, month - 1, day));
  }

  function formatDateKey(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function formatShortDateLabel(dateKey) {
    const date = parseDateKey(dateKey);
    if (!date) return dateKey || '';
    return new Intl.DateTimeFormat(getLocale(), { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
  }

  function formatMonthLabel(monthKey) {
    const date = parseDateKey(`${monthKey}-01`);
    if (!date) return monthKey || '';
    return new Intl.DateTimeFormat(getLocale(), { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
  }

  function getWeekStartKey(dateKey) {
    const date = parseDateKey(dateKey);
    if (!date) return dateKey || '';
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - mondayOffset);
    return formatDateKey(date);
  }

  function getProfitWaterfallBucket(row, granularity) {
    if (granularity === 'month') {
      const key = String(row?.date || '').slice(0, 7);
      return { key, label: formatMonthLabel(key) };
    }

    if (granularity === 'week') {
      const key = getWeekStartKey(row?.date);
      return {
        key,
        label: formatShortDateLabel(key),
      };
    }

    return { key: row?.date || '', label: row?.date || '' };
  }

  function aggregateProfitWaterfallRows(rows, granularity) {
    const selectedGranularity = ['day', 'week', 'month'].includes(granularity) ? granularity : 'day';
    if (selectedGranularity === 'day') {
      return (Array.isArray(rows) ? rows : []).map(row => ({
        ...row,
        label: row.date,
        revenue: toFiniteNumber(row.revenue),
        refunded: toFiniteNumber(row.refunded),
        cogs: toFiniteNumber(row.cogs),
        cogsShipping: toFiniteNumber(row.cogsShipping ?? row.shipping),
        adSpendKRW: toFiniteNumber(row.adSpendKRW),
        paymentFees: toFiniteNumber(row.paymentFees),
        trueNetProfit: toFiniteNumber(row.trueNetProfit),
      }));
    }

    const buckets = new Map();
    (Array.isArray(rows) ? rows : []).forEach(row => {
      const { key, label } = getProfitWaterfallBucket(row, selectedGranularity);
      if (!key) return;

      if (!buckets.has(key)) {
        buckets.set(key, {
          date: key,
          label,
          revenue: 0,
          refunded: 0,
          cogs: 0,
          cogsShipping: 0,
          adSpendKRW: 0,
          paymentFees: 0,
          trueNetProfit: 0,
          days: 0,
          fullCogsDays: 0,
          hasPartialCOGS: false,
          hasPendingRecovery: false,
        });
      }

      const bucket = buckets.get(key);
      bucket.revenue += toFiniteNumber(row.revenue);
      bucket.refunded += toFiniteNumber(row.refunded);
      bucket.cogs += toFiniteNumber(row.cogs);
      bucket.cogsShipping += toFiniteNumber(row.cogsShipping ?? row.shipping);
      bucket.adSpendKRW += toFiniteNumber(row.adSpendKRW);
      bucket.paymentFees += toFiniteNumber(row.paymentFees);
      bucket.trueNetProfit += toFiniteNumber(row.trueNetProfit);
      bucket.days += 1;
      bucket.hasPartialCOGS = bucket.hasPartialCOGS || Boolean(row.hasPartialCOGS);
      bucket.hasPendingRecovery = bucket.hasPendingRecovery || Boolean(row.hasPendingRecovery);
      if (row.hasCOGS && !row.hasPartialCOGS && !row.hasPendingRecovery) {
        bucket.fullCogsDays += 1;
      }
    });

    return Array.from(buckets.values()).map(bucket => ({
      ...bucket,
      hasCOGS: bucket.days > 0 && bucket.fullCogsDays === bucket.days,
    }));
  }

  function buildNetProfitBuckets(waterfallBuckets) {
    return (Array.isArray(waterfallBuckets) ? waterfallBuckets : []).map(row => {
      const revenue = toFiniteNumber(row.revenue);
      const refunded = toFiniteNumber(row.refunded);
      const netRevenue = revenue - refunded;
      const trueNetProfit = toFiniteNumber(row.trueNetProfit);
      const margin = netRevenue > 0 ? Number(((trueNetProfit / netRevenue) * 100).toFixed(1)) : null;

      return {
        label: row.label || row.date || '',
        netRevenue,
        trueNetProfit,
        margin,
      };
    });
  }

  function setCurrencyAxisBreathingRoom(chart, values, labelsVisible) {
    if (!chart?.options?.scales?.y) return;
    const finiteValues = (Array.isArray(values) ? values : [])
      .map(value => Number(value))
      .filter(value => Number.isFinite(value));
    const maxValue = finiteValues.reduce((max, value) => Math.max(max, value), 0);
    const minValue = finiteValues.reduce((min, value) => Math.min(min, value), 0);
    const maxAbs = Math.max(Math.abs(maxValue), Math.abs(minValue), 1);
    const step = maxAbs >= 1_000_000 ? 100_000 : maxAbs >= 100_000 ? 50_000 : 10_000;
    const padding = Math.max(maxAbs * (labelsVisible ? 0.28 : 0.14), labelsVisible ? step : 0);

    chart.options.scales.y.suggestedMax = maxValue > 0
      ? Math.ceil((maxValue + padding) / step) * step
      : undefined;
    chart.options.scales.y.suggestedMin = minValue < 0
      ? Math.floor((minValue - padding) / step) * step
      : undefined;
    chart.options.layout = chart.options.layout || {};
    chart.options.layout.padding = {
      ...(chart.options.layout.padding || {}),
      top: labelsVisible ? 38 : 24,
    };
  }

  function setPercentAxisBreathingRoom(chart, values, labelsVisible) {
    if (!chart?.options?.scales?.y) return;
    const finiteValues = (Array.isArray(values) ? values : [])
      .map(value => Number(value))
      .filter(value => Number.isFinite(value));
    const maxValue = finiteValues.reduce((max, value) => Math.max(max, value), 0);
    const minValue = finiteValues.reduce((min, value) => Math.min(min, value), 0);
    const maxAbs = Math.max(Math.abs(maxValue), Math.abs(minValue), 1);
    const padding = Math.max(maxAbs * (labelsVisible ? 0.3 : 0.16), labelsVisible ? 5 : 0);

    chart.options.scales.y.suggestedMax = maxValue > 0
      ? Math.ceil((maxValue + padding) / 5) * 5
      : undefined;
    chart.options.scales.y.suggestedMin = minValue < 0
      ? Math.floor((minValue - padding) / 5) * 5
      : undefined;
    chart.options.layout = chart.options.layout || {};
    chart.options.layout.padding = {
      ...(chart.options.layout.padding || {}),
      top: labelsVisible ? 38 : 24,
    };
  }

  function syncProfitWaterfallGranularityControls() {
    document.querySelectorAll('[data-profit-waterfall-granularity]').forEach(button => {
      const isActive = button.dataset.profitWaterfallGranularity === profitWaterfallGranularity;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
  }

  function updateProfitInputCard(key, value, detail, tone = 'neutral') {
    const card = document.querySelector(`[data-profit-source-kpi="${key}"]`);
    if (!card) return;

    const valueEl = card.querySelector('.kpi-value');
    const detailEl = card.querySelector('.kpi-delta span');
    const detailWrap = card.querySelector('.kpi-delta');

    if (valueEl) valueEl.textContent = value;
    if (detailEl) detailEl.textContent = detail;
    if (detailWrap) {
      detailWrap.classList.remove('positive', 'negative', 'neutral');
      detailWrap.classList.add(tone);
    }
  }

  function renderOrderPatternChip(label, value, detail = '') {
    return `
      <span class="order-pattern-chip">
        <span>${esc(label)}</span>
        <strong>${esc(value)}</strong>
        ${detail ? `<span>${esc(detail)}</span>` : ''}
      </span>
    `;
  }

  function buildWeekdayPerformance(rows) {
    const labels = tr(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], ['일', '월', '화', '수', '목', '금', '토']);
    const buckets = labels.map(day => ({
      day,
      spend: 0,
      purchases: 0,
      paid: 0,
      refunded: 0,
      net: 0,
      orders: 0,
    }));

    (Array.isArray(rows) ? rows : []).forEach(row => {
      if (!row?.date) return;
      const weekdayIndex = new Date(`${row.date}T00:00:00`).getDay();
      const bucket = buckets[weekdayIndex];
      if (!bucket) return;

      const paid = toFiniteNumber(row.revenue);
      const refunded = toFiniteNumber(row.refunded);
      bucket.spend += toFiniteNumber(row.spend);
      bucket.purchases += toFiniteNumber(row.purchases);
      bucket.paid += paid;
      bucket.refunded += refunded;
      bucket.net += paid - refunded;
      bucket.orders += toFiniteNumber(row.orders);
    });

    return buckets.map(bucket => ({
      ...bucket,
      cpa: bucket.purchases > 0 ? bucket.spend / bucket.purchases : 0,
    }));
  }

  function renderProfitAnalysisSection(data) {
    if (!data || !data.profitAnalysis) return;

    const pa = data.profitAnalysis;
    const waterfall = sliceRowsByWindow(pa.waterfall || [], 'profit-structure');
    const windowMeta = getSeriesWindowMeta('profit-structure');
    const windowSummary = getProfitWindowSummary(pa, windowMeta.key);
    const windowCoverage = windowSummary.coverage || emptyCoverage();
    const overallCoverage = pa.coverage || {
      totalDays: waterfall.length,
      daysWithCOGS: 0,
      daysWithPartialCOGS: 0,
      coverageRatio: 0,
      cogsCoveredRange: {},
      missingRanges: [],
      confidence: { level: 'low', label: tr('Waiting for data', '데이터 대기 중') },
    };
    const coverage = windowCoverage.totalDays > 0 ? windowCoverage : overallCoverage;
    const todaySummary = pa.todaySummary;
    const runRate = pa.runRate;
    const totalProfit = windowSummary.totalProfit;
    const totalGrossRevenue = windowSummary.totalGrossRevenue;
    const totalRefunded = windowSummary.totalRefunded;
    const totalOrders = windowSummary.totalOrders;
    const totalCosts = windowSummary.totalCosts;
    const blendedMargin = windowSummary.blendedMargin;
    const trueRoas = windowSummary.trueRoas;
    const windowLabel = windowMeta?.label || tr('Selected', '선택');
    const refundRate = windowSummary.refundRate;
    const costsShare = windowSummary.costsShare;
    const totalNetRevenue = hasNumericValue(totalGrossRevenue) && hasNumericValue(totalRefunded)
      ? totalGrossRevenue - totalRefunded
      : null;

    const heroEl = document.getElementById('profitHero');
    const heroKickerEl = document.getElementById('profitHeroKicker');
    const verdictEl = document.getElementById('profitVerdict');
    const amountEl = document.getElementById('profitAmount');
    const confEl = document.getElementById('profitConfidence');
    const heroSubEl = document.getElementById('profitHeroSub');
    const latestSignalEl = document.getElementById('profitLatestSignal');
    const heroMarginEl = document.getElementById('profitHeroMargin');
    const heroRoasEl = document.getElementById('profitHeroRoas');
    const heroRunRateEl = document.getElementById('profitHeroRunRate');
    const netProfitSummaryEl = document.getElementById('netProfitSummary');

    if (heroKickerEl) {
      heroKickerEl.textContent = tr(`${windowLabel} time frame net profit`, `${windowLabel} 기준 순이익`);
    }

    if (verdictEl && amountEl) {
      const isPositive = totalProfit > 0;
      const isNegative = totalProfit < 0;
      verdictEl.textContent = isPositive ? tr('Profitable period', '수익 구간') : isNegative ? tr('Unprofitable period', '적자 구간') : tr('Break-even period', '손익분기 구간');
      verdictEl.className = 'profit-verdict ' + (isPositive ? 'verdict-positive' : isNegative ? 'verdict-negative' : '');
      amountEl.textContent = formatNullableSignedKrw(totalProfit);
      amountEl.className = 'profit-amount ' + (isPositive ? 'verdict-positive' : isNegative ? 'verdict-negative' : '');
      if (heroEl) heroEl.className = 'profit-hero ' + (isPositive ? 'hero-positive' : isNegative ? 'hero-negative' : '');
    }

    if (confEl && coverage.confidence) {
      const coverageLabel = coverage.confidence.level === 'high'
        ? tr('Strong COGS coverage', 'COGS 커버리지 양호')
        : coverage.confidence.level === 'medium'
        ? tr('Partial COGS coverage', 'COGS 일부 커버')
        : tr('Low COGS coverage', 'COGS 커버리지 낮음');
      confEl.textContent = coverageLabel;
      confEl.className = 'confidence-badge confidence-' + safeConfidenceLevel(coverage.confidence.level);
    }

    if (heroSubEl) {
      const partialNote = Number(coverage.daysWithPartialCOGS || 0) > 0
        ? tr(` · ${coverage.daysWithPartialCOGS} partial`, ` · 부분 커버 ${coverage.daysWithPartialCOGS.toLocaleString(getLocale())}일`)
        : '';
      const pendingNote = Number(coverage.daysWithPendingRecovery || 0) > 0
        ? tr(` · ${coverage.daysWithPendingRecovery} recovery-pending`, ` · 환급 대기 ${coverage.daysWithPendingRecovery.toLocaleString(getLocale())}일`)
        : '';
      heroSubEl.textContent = tr(
        `${windowLabel} time frame · ${toFiniteNumber(windowSummary.daysShown || waterfall.length)} days shown · ${coverage.daysWithCOGS} fully covered of ${coverage.totalDays} (${(coverage.coverageRatio * 100).toFixed(0)}% weighted coverage)${partialNote}${pendingNote}`,
        `${windowLabel} 기준 · ${toFiniteNumber(windowSummary.daysShown || waterfall.length).toLocaleString(getLocale())}일 표시 · ${coverage.totalDays.toLocaleString(getLocale())}일 중 ${coverage.daysWithCOGS.toLocaleString(getLocale())}일 완전 커버 (${(coverage.coverageRatio * 100).toFixed(0)}% 가중 커버)${partialNote}${pendingNote}`
      );
    }

    if (heroMarginEl) heroMarginEl.textContent = formatNullablePercent(blendedMargin, 1);
    if (heroRoasEl) heroRoasEl.textContent = formatNullableRoas(trueRoas);
    if (heroRunRateEl) heroRunRateEl.textContent = runRate ? formatSignedKrw(runRate.projectedMonthlyNetProfit) : '—';

    if (latestSignalEl) {
      if (todaySummary) {
        let summaryLabel = tr('Latest profit signal', '최근 수익 신호');
        if (todaySummary.summaryType === 'today') summaryLabel = tr('Today', '오늘');
        if (todaySummary.summaryType === 'latest_completed') summaryLabel = tr('Latest completed day', '최신 완료일');
        if (todaySummary.summaryType === 'estimated') summaryLabel = tr('Current estimate', '현재 추정치');
        const cogsNote = todaySummary.hasCOGS ? tr('COGS included', 'COGS 포함') : tr('COGS not yet available', 'COGS 아직 없음');
        latestSignalEl.textContent = `${summaryLabel}: ${todaySummary.date} · ${formatSignedKrw(todaySummary.trueNetProfit)} · ${cogsNote}`;
      } else {
        latestSignalEl.textContent = tr('Latest completed day: waiting for covered profit data.', '최신 완료일: 원가 포함 수익 데이터 대기 중');
      }
    }

    updateProfitInputCard(
      'grossRevenue',
      formatNullableKrw(totalGrossRevenue),
      tr(`${formatNullableCount(totalOrders)} orders · ${formatNullableKrw(totalRefunded)} refunded`, `${formatNullableCount(totalOrders)}건 주문 · 환불 ${formatNullableKrw(totalRefunded)}`),
      totalGrossRevenue > 0 ? 'positive' : 'neutral'
    );
    updateProfitInputCard(
      'refunds',
      formatNullableKrw(totalRefunded),
      tr(`${formatNullablePercent(refundRate)} of gross revenue`, `총매출 대비 ${formatNullablePercent(refundRate)}`),
      totalRefunded > 0 ? 'negative' : 'neutral'
    );
    updateProfitInputCard(
      'totalCosts',
      formatNullableKrw(totalCosts),
      tr(`${formatNullablePercent(costsShare)} of net revenue`, `순매출 대비 ${formatNullablePercent(costsShare)}`),
      totalCosts > 0 ? 'negative' : 'neutral'
    );
    updateProfitInputCard(
      'trueNetProfit',
      formatNullableSignedKrw(totalProfit),
      tr(`${formatNullablePercent(blendedMargin, 1)} margin`, `마진 ${formatNullablePercent(blendedMargin, 1)}`),
      totalProfit > 0 ? 'positive' : totalProfit < 0 ? 'negative' : 'neutral'
    );

    if (netProfitSummaryEl) {
      const profitTone = totalProfit > 0 ? 'positive' : totalProfit < 0 ? 'negative' : '';
      netProfitSummaryEl.innerHTML = `
        <span class="${profitTone}"><strong>${esc(formatNullableSignedKrw(totalProfit))}</strong> ${esc(tr('net profit', '순이익'))}</span>
        <span><strong>${esc(formatNullablePercent(blendedMargin, 1))}</strong> ${esc(tr(`margin on ${formatNullableKrw(totalNetRevenue)} net revenue`, `순매출 ${formatNullableKrw(totalNetRevenue)} 기준 마진`))}</span>
      `;
    }

    const cogsKpi = document.querySelector('[data-profit-kpi="cogsCoverage"] .kpi-value');
    if (cogsKpi) cogsKpi.textContent = (coverage.coverageRatio * 100).toFixed(0) + '%';
    const cogsSub = document.querySelector('[data-profit-kpi="cogsCoverage"] .kpi-delta span');
    if (cogsSub) {
      const partialText = Number(coverage.daysWithPartialCOGS || 0) > 0
        ? tr(` · ${coverage.daysWithPartialCOGS} partial`, ` · 부분 ${coverage.daysWithPartialCOGS.toLocaleString(getLocale())}일`)
        : '';
      const pendingText = Number(coverage.daysWithPendingRecovery || 0) > 0
        ? tr(` · ${coverage.daysWithPendingRecovery} recovery-pending`, ` · 환급 대기 ${coverage.daysWithPendingRecovery.toLocaleString(getLocale())}일`)
        : '';
      cogsSub.textContent = tr(
        `${coverage.daysWithCOGS} fully covered of ${coverage.totalDays}${partialText}${pendingText}`,
        `${coverage.totalDays.toLocaleString(getLocale())}일 중 완전 커버 ${coverage.daysWithCOGS.toLocaleString(getLocale())}일${partialText}${pendingText}`
      );
    }

    const marginKpi = document.querySelector('[data-profit-kpi="blendedMargin"] .kpi-value');
    if (marginKpi) marginKpi.textContent = formatNullablePercent(blendedMargin, 1);
    const marginSub = document.querySelector('[data-profit-kpi="blendedMargin"] .kpi-delta span');
    if (marginSub) marginSub.textContent = totalProfit >= 0 ? tr('Profitable', '수익') : tr('Unprofitable', '적자');

    const roasKpi = document.querySelector('[data-profit-kpi="trueRoas"] .kpi-value');
    if (roasKpi) roasKpi.textContent = formatNullableRoas(trueRoas);
    const roasSub = document.querySelector('[data-profit-kpi="trueRoas"] .kpi-delta span');
    if (roasSub) roasSub.textContent = tr('Net Revenue / Ad Spend', '순매출 / 광고비');

    const runRateKpi = document.querySelector('[data-profit-kpi="runRate30d"] .kpi-value');
    if (runRateKpi) {
      const projected = runRate ? runRate.projectedMonthlyNetProfit : null;
      runRateKpi.textContent = projected == null
        ? '—'
        : projected >= 0
        ? '₩' + projected.toLocaleString()
        : '-₩' + Math.abs(projected).toLocaleString();
    }
    const runRateSub = document.querySelector('[data-profit-kpi="runRate30d"] .kpi-delta span');
    if (runRateSub) {
      if (runRate) {
        const avgDaily = runRate.avgDailyNetProfit >= 0
          ? '₩' + runRate.avgDailyNetProfit.toLocaleString()
          : '-₩' + Math.abs(runRate.avgDailyNetProfit).toLocaleString();
        runRateSub.textContent = tr(`${runRate.daysUsed}d used · ${avgDaily}/day`, `${runRate.daysUsed}일 사용 · 일평균 ${avgDaily}`);
      } else {
        runRateSub.textContent = tr('Waiting for covered days', '커버된 날짜 대기 중');
      }
    }

    syncProfitWaterfallGranularityControls();
    const waterfallBuckets = aggregateProfitWaterfallRows(waterfall, profitWaterfallGranularity);
    const showChartValueLabels = profitWaterfallGranularity !== 'day';

    if (waterfallBuckets.length > 0 && typeof profitWaterfallChart !== 'undefined' && profitWaterfallChart) {
      const netRevenueValues = waterfallBuckets.map(row => row.revenue - row.refunded);
      const costValues = waterfallBuckets.map(row =>
        -(row.cogs + row.cogsShipping + row.adSpendKRW + row.paymentFees)
      );
      profitWaterfallChart.data.labels = waterfallBuckets.map(row => row.label);
      profitWaterfallChart.data.datasets[0].data = netRevenueValues;
      profitWaterfallChart.data.datasets[0].showValueLabels = showChartValueLabels;
      profitWaterfallChart.data.datasets[1].data = costValues;
      profitWaterfallChart.data.datasets[1].showValueLabels = showChartValueLabels;
      setCurrencyAxisBreathingRoom(profitWaterfallChart, [...netRevenueValues, ...costValues], showChartValueLabels);
      profitWaterfallChart.options.scales.x.ticks.minRotation = 45;
      profitWaterfallChart.options.scales.x.ticks.maxRotation = 45;
      profitWaterfallChart.options.scales.x.ticks.autoSkip = profitWaterfallGranularity === 'day';
      profitWaterfallChart.update();
    }

    const netProfitBuckets = buildNetProfitBuckets(waterfallBuckets);
    if (typeof netProfitChartInstance !== 'undefined' && netProfitChartInstance) {
      const netProfitDataset = netProfitChartInstance.data.datasets[0];
      netProfitChartInstance.data.labels = netProfitBuckets.map(row => row.label);
      netProfitDataset.data = netProfitBuckets.map(row => row.margin);
      netProfitDataset.netProfitValues = netProfitBuckets.map(row => row.trueNetProfit);
      netProfitDataset.netRevenue = netProfitBuckets.map(row => row.netRevenue);
      netProfitDataset.showValueLabels = showChartValueLabels;
      const marginValues = netProfitBuckets
        .map(row => Number(row.margin))
        .filter(value => Number.isFinite(value));
      setPercentAxisBreathingRoom(netProfitChartInstance, marginValues, showChartValueLabels);
      netProfitChartInstance.options.scales.x.ticks.minRotation = 45;
      netProfitChartInstance.options.scales.x.ticks.maxRotation = 45;
      netProfitChartInstance.options.scales.x.ticks.autoSkip = profitWaterfallGranularity === 'day';
      netProfitChartInstance.update();
    }

    const profitMovementFootnote = document.getElementById('profitMovementFootnote');
    if (profitMovementFootnote && coverage.confidence) {
      const conf = coverage.confidence;
      const coveredRange = coverage.cogsCoveredRange || {};
      const missing = coverage.missingRanges || [];
      const granularityLabel = profitWaterfallGranularity === 'month'
        ? tr('Monthly view', '월별 보기')
        : profitWaterfallGranularity === 'week'
        ? tr('Weekly view', '주별 보기')
        : tr('Daily view', '일별 보기');
      const coverageLabel = tr(
        `${coverage.daysWithCOGS}/${coverage.totalDays} days covered · ${(coverage.coverageRatio * 100).toFixed(0)}% weighted coverage`,
        `${coverage.totalDays.toLocaleString(getLocale())}일 중 ${coverage.daysWithCOGS.toLocaleString(getLocale())}일 커버 · 가중 커버 ${(coverage.coverageRatio * 100).toFixed(0)}%`
      );
      const rangeLabel = coveredRange.from
        ? tr(`COGS ${coveredRange.from} to ${coveredRange.to}`, `COGS ${coveredRange.from} ~ ${coveredRange.to}`)
        : '';
      const missingLabel = missing.length > 0
        ? tr(`Missing ${missing.join(', ')}`, `누락 ${missing.join(', ')}`)
        : '';
      const periodCount = waterfallBuckets.length;
      const periodsShownLabel = tr(
        `${periodCount.toLocaleString(getLocale())} ${periodCount === 1 ? 'period' : 'periods'} shown`,
        `${periodCount.toLocaleString(getLocale())}개 구간 표시`
      );
      const windowContextLabel = tr(`${windowLabel} time frame`, `${windowLabel} 기준`);

      profitMovementFootnote.innerHTML = `
        <span><strong>${esc(granularityLabel)}:</strong> ${esc(windowContextLabel)} · ${esc(periodsShownLabel)}</span>
        <span><strong>${esc(conf.label)}:</strong> ${esc(coverageLabel)}</span>
        ${rangeLabel ? `<span>${esc(rangeLabel)}</span>` : ''}
        ${missingLabel ? `<span>${esc(missingLabel)}</span>` : ''}
      `;
    }
  }

  async function refreshAnalyticsPage(options = {}) {
    try {
      if (
        typeof initProfitCharts === 'function'
        && typeof profitChartsInitialized !== 'undefined'
        && !profitChartsInitialized
      ) {
        initProfitCharts();
      }

      let data = cachedAnalyticsData;
      const shouldReuseCache = Boolean(
        options?.preferCached
        && cachedAnalyticsData
      );
      if (!shouldReuseCache) {
        data = await fetchAnalytics();
        if (!data) return;
        cachedAnalyticsData = data;
      }
      if (!data) return;

      const charts = data.charts || {};
      const allDailyMerged = charts.dailyMerged || [];
      const orderPatternDaily = sliceRowsByWindow(allDailyMerged, 'order-patterns');
      const orderPatternCutoff = orderPatternDaily[0]?.date || '';
      const orderPatternWeeklyAgg = (charts.weeklyAgg || []).filter(week => week.week >= orderPatternCutoff);
      const weekdayPerf = buildWeekdayPerformance(orderPatternDaily);
      const hourlyOrders = charts.hourlyOrders || [];
      const imwebSource = data.dataSources?.imweb || null;
      const sourceAudit = data.sourceAudit || null;
      const analyticsNoticeEl = document.getElementById('analyticsFreshnessNotice');
      const orderPatternSummaryEl = document.getElementById('orderPatternSummary');

      if (orderPatternSummaryEl) {
        const revenueDays = weekdayPerf.filter(day => Number(day.net || 0) > 0);
        const bestRevenueDay = revenueDays.reduce((best, day) => !best || day.net > best.net ? day : best, null);
        const peakOrderDay = weekdayPerf.reduce((best, day) => !best || (day.orders || 0) > (best.orders || 0) ? day : best, null);
        const latestWeek = orderPatternWeeklyAgg[orderPatternWeeklyAgg.length - 1] || null;
        const previousWeek = orderPatternWeeklyAgg[orderPatternWeeklyAgg.length - 2] || null;
        const latestRevenue = Number(latestWeek?.revenue || 0) - Number(latestWeek?.refunded || 0);
        const previousRevenue = Number(previousWeek?.revenue || 0) - Number(previousWeek?.refunded || 0);
        const latestDelta = latestWeek && previousWeek
          ? latestRevenue - previousRevenue
          : 0;
        const latestDetail = latestWeek
          ? (previousWeek
            ? tr(`${latestDelta >= 0 ? '+' : '-'}${formatKrw(Math.abs(latestDelta))} vs prior week`, `${latestDelta >= 0 ? '+' : '-'}${formatKrw(Math.abs(latestDelta))} 전주 대비`)
            : '')
          : '';
        orderPatternSummaryEl.innerHTML = [
          bestRevenueDay ? renderOrderPatternChip(tr('Best revenue day', '최고 매출 요일'), bestRevenueDay.day, formatKrw(bestRevenueDay.net || 0)) : '',
          peakOrderDay ? renderOrderPatternChip(tr('Peak order day', '주문 피크 요일'), peakOrderDay.day, tr(`${formatCount(peakOrderDay.orders || 0)} orders`, `주문 ${formatCount(peakOrderDay.orders || 0)}건`)) : '',
          latestWeek && (latestRevenue > 0 || previousRevenue > 0) ? renderOrderPatternChip(tr('Latest weekly revenue', '최근 주간 매출'), formatKrw(latestRevenue), latestDetail) : '',
        ].filter(Boolean).join('');
      }
      if (analyticsNoticeEl) {
        const failedChecks = Array.isArray(sourceAudit?.summary?.failedChecks) ? sourceAudit.summary.failedChecks : [];
        const failedFetches = Array.isArray(sourceAudit?.summary?.failedFetches) ? sourceAudit.summary.failedFetches : [];
        analyticsNoticeEl.classList.remove('is-error');
        if (sourceAudit?.status === 'mismatch') {
          analyticsNoticeEl.hidden = false;
          analyticsNoticeEl.classList.add('is-error');
          analyticsNoticeEl.textContent = failedChecks.length > 0
            ? tr(`Source audit mismatch: ${failedChecks.join(', ')}. Financial totals need review before use.`, `소스 감사 불일치: ${failedChecks.join(', ')}. 사용 전 재무 합계 검토가 필요합니다.`)
            : tr('Source audit mismatch. Financial totals need review before use.', '소스 감사 불일치. 사용 전 재무 합계 검토가 필요합니다.');
        } else if (sourceAudit?.status === 'reconciled_with_stale_sources') {
          analyticsNoticeEl.hidden = false;
          analyticsNoticeEl.textContent = failedFetches.length > 0
            ? tr(`Using last-known-good source data for ${failedFetches.join(', ')}.`, `${failedFetches.join(', ')} 마지막 정상 소스 데이터를 사용 중입니다.`)
            : tr('Using last-known-good source data.', '마지막 정상 소스 데이터를 사용 중입니다.');
        } else if (imwebSource?.stale) {
          analyticsNoticeEl.hidden = false;
          analyticsNoticeEl.textContent = tr('Revenue-backed analytics are using cached Imweb data. Weekday revenue, refunds, and ROAS are directional until the next successful sync.', '매출 기반 분석은 캐시된 Imweb 데이터를 사용 중입니다. 다음 정상 동기화 전까지 요일별 매출, 환불, ROAS는 방향성 참고용입니다.');
        } else if (imwebSource?.status === 'error') {
          analyticsNoticeEl.hidden = false;
          analyticsNoticeEl.textContent = tr('Imweb sync is unavailable. Revenue-backed analytics may be incomplete.', 'Imweb 동기화를 사용할 수 없어 매출 기반 분석이 불완전할 수 있습니다.');
        } else {
          analyticsNoticeEl.hidden = true;
          analyticsNoticeEl.textContent = '';
        }
      }

      renderProfitAnalysisSection(data);

      if (weekdayPerf.length > 0 && typeof weekdayChartInstance !== 'undefined' && weekdayChartInstance) {
        weekdayChartInstance.data.labels = weekdayPerf.map(day => day.day);
        weekdayChartInstance.data.datasets[0].data = weekdayPerf.map(day => day.orders || 0);
        weekdayChartInstance.data.datasets[1].data = weekdayPerf.map(day => day.net || 0);
        weekdayChartInstance.update();
      }

      if (hourlyOrders.length > 0 && typeof hourChartInstance !== 'undefined' && hourChartInstance) {
        const peakHours = hourlyOrders
          .slice()
          .sort((left, right) => (right.orders || 0) - (left.orders || 0))
          .slice(0, 3)
          .map(row => row.hour);

        hourChartInstance.data.labels = hourlyOrders.map(row => `${row.hour}:00`);
        hourChartInstance.data.datasets[0].data = hourlyOrders.map(row => row.orders || 0);
        hourChartInstance.data.datasets[0].backgroundColor = hourlyOrders.map(row =>
          peakHours.includes(row.hour) ? 'rgba(22, 101, 52, 0.92)' : 'rgba(22, 101, 52, 0.56)'
        );
        hourChartInstance.update();
      }

    } catch (e) {
      console.warn('[LIVE] refreshAnalyticsPage error:', e.message);
    }
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-profit-waterfall-granularity]');
    if (!button) return;

    const nextGranularity = button.dataset.profitWaterfallGranularity;
    if (!['day', 'week', 'month'].includes(nextGranularity) || nextGranularity === profitWaterfallGranularity) {
      return;
    }

    profitWaterfallGranularity = nextGranularity;
    syncProfitWaterfallGranularityControls();
    if (cachedAnalyticsData) {
      renderProfitAnalysisSection(cachedAnalyticsData);
    }
  });

  live.registerPage('analytics', {
    refresh: refreshAnalyticsPage,
  });
})();
