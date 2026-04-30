(function () {
  const live = window.AdPilotLive;
  const { esc, safeConfidenceLevel, formatSignedKrw, formatSignedCompactKrw, formatKrw, formatUsd, formatPercent, formatCount, humanizeEnum, tr, getLocale } = live.shared;
  const { fetchAnalytics, fetchReconciliation } = live.api;
  const { getSeriesWindowMeta, sliceRowsByWindow } = live.seriesWindows;
  let cachedAnalyticsData = null;
  let cachedReconciliation;
  let profitWaterfallGranularity = 'day';

  function formatRateMetricDetail(metric, fallback) {
    if (!metric || metric.numerator == null || metric.denominator == null) {
      return fallback;
    }

    if (metric.unit === 'currency') {
      return tr(
        `${formatKrw(metric.numerator)} of ${formatKrw(metric.denominator)}`,
        `${formatKrw(metric.denominator)} 중 ${formatKrw(metric.numerator)}`
      );
    }

    if (metric.unit === 'sections') {
      const denominatorLabel = metric.denominatorLabel || 'sections';
      const numeratorLabel = metric.numeratorLabel || 'cancelled';
      return tr(
        `${metric.numerator} ${numeratorLabel} of ${metric.denominator} ${denominatorLabel}`,
        `${metric.denominator.toLocaleString(getLocale())}${denominatorLabel === 'sections' ? '개 섹션' : denominatorLabel} 중 ${metric.numerator.toLocaleString(getLocale())}${numeratorLabel === 'cancelled' ? '개 취소' : numeratorLabel}`
      );
    }

    return fallback;
  }

  function summarizeBy(values, selector) {
    return (Array.isArray(values) ? values : []).reduce((summary, value) => {
      const key = selector(value);
      summary[key] = (summary[key] || 0) + 1;
      return summary;
    }, {});
  }

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
        label: tr(`Week of ${formatShortDateLabel(key)}`, `${formatShortDateLabel(key)} 주`),
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

  function renderCampaignSummaryCard(label, value, detail, tone = 'neutral', icon = 'bar-chart-3') {
    return `
      <div class="kpi-card">
        <div class="kpi-label">${esc(label)}</div>
        <div class="kpi-value">${esc(value)}</div>
        <div class="kpi-delta ${esc(tone)}"><i data-lucide="${esc(icon)}"></i><span>${esc(detail)}</span></div>
      </div>
    `;
  }

  function renderMediaEfficiencyChip(label, value, detail = '') {
    return `
      <span class="media-efficiency-chip">
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

  function buildReconciliationOverlap(dailyRows, matches, unmatchedSettlements, unmatchedImwebPayments) {
    const mismatchMatches = matches.filter(match => match.methodMismatch);
    return {
      matchedCount: matches.length,
      netAmount: dailyRows.reduce((sum, day) => sum + toFiniteNumber(day.matched?.netAmount), 0),
      methodMismatchCount: mismatchMatches.length,
      methodMismatchAmount: mismatchMatches.reduce((sum, match) => sum + toFiniteNumber(match.amount), 0),
      confidence: summarizeBy(matches, match => match.confidence || 'low'),
      unmatchedSettlementCount: unmatchedSettlements.length,
      unmatchedImwebCount: unmatchedImwebPayments.length,
    };
  }

  function buildVisibleReconciliationReport(report, group) {
    const daily = sliceRowsByWindow(report?.daily || [], group);
    const visibleDates = new Set(daily.map(day => day.date));
    const matches = (report?.matches || []).filter(match =>
      visibleDates.has(match?.settlement?.tradedDate || match?.imwebPayment?.completedDate)
    );
    const unmatchedSettlements = (report?.unmatchedSettlements || []).filter(item => visibleDates.has(item?.tradedDate));
    const unmatchedImwebPayments = (report?.unmatchedImwebPayments || []).filter(item => visibleDates.has(item?.completedDate));

    return {
      ...report,
      daily,
      summary: {
        ...(report?.summary || {}),
        overlap: buildReconciliationOverlap(daily, matches, unmatchedSettlements, unmatchedImwebPayments),
      },
      matches,
      unmatchedSettlements,
      unmatchedImwebPayments,
    };
  }

  function renderProfitAnalysisSection(data) {
    if (!data || !data.profitAnalysis) return;

    const pa = data.profitAnalysis;
    const waterfall = sliceRowsByWindow(pa.waterfall || [], 'profit-structure');
    const windowMeta = getSeriesWindowMeta('profit-structure');
    const windowSummary = getProfitWindowSummary(pa, windowMeta.key);
    const windowCoverage = windowSummary.coverage || emptyCoverage();
    const mediaWindowMeta = getSeriesWindowMeta('media-profitability');
    const campaignProfitWindow = pa.campaignProfitWindows?.[mediaWindowMeta.key]
      || pa.campaignProfitWindows?.all
      || { campaigns: pa.campaignProfit || [], summary: {} };
    const campaignProfit = Array.isArray(campaignProfitWindow.campaigns) ? campaignProfitWindow.campaigns : [];
    const campaignSummary = campaignProfitWindow.summary || {};
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

    if (heroKickerEl) {
      heroKickerEl.textContent = tr(`${windowLabel} time frame true net profit`, `${windowLabel} 기준 실질 순이익`);
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
    if (heroRunRateEl) heroRunRateEl.textContent = runRate ? formatSignedCompactKrw(runRate.projectedMonthlyNetProfit) : '—';

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

    if (waterfallBuckets.length > 0 && typeof profitWaterfallChart !== 'undefined' && profitWaterfallChart) {
      profitWaterfallChart.data.labels = waterfallBuckets.map(row => row.label);
      profitWaterfallChart.data.datasets[0].data = waterfallBuckets.map(row => row.revenue);
      profitWaterfallChart.data.datasets[1].data = waterfallBuckets.map(row => -row.refunded);
      profitWaterfallChart.data.datasets[2].data = waterfallBuckets.map(row =>
        -(row.cogs + row.cogsShipping + row.adSpendKRW + row.paymentFees)
      );
      profitWaterfallChart.data.datasets[3].data = waterfallBuckets.map(row => row.trueNetProfit);
      profitWaterfallChart.data.datasets[3].pointBackgroundColor = waterfallBuckets.map(row =>
        row.trueNetProfit >= 0 ? '#4ade80' : '#f87171'
      );
      profitWaterfallChart.options.scales.x.ticks.maxRotation = profitWaterfallGranularity === 'day' ? 45 : 0;
      profitWaterfallChart.options.scales.x.ticks.autoSkip = profitWaterfallGranularity === 'day';
      profitWaterfallChart.update();
    }

    const tbody = document.getElementById('campaignProfitBody');
    const summaryEl = document.getElementById('campaignProfitSummary');
    const contextEl = document.getElementById('campaignProfitContext');
    const noteEl = document.getElementById('campaignProfitWindowNote');
    const estimatedProfit = Number(campaignSummary.estimatedProfit || 0);
    const estimatedRevenue = Number(campaignSummary.estimatedMetaRevenue || 0);
    const campaignSpendKRW = Number(campaignSummary.spendKRW || 0);
    const totalMetaPurchases = Number(campaignSummary.totalMetaPurchases || 0);
    const attributedShare = Number(campaignSummary.attributableRevenueShare || 0) * 100;
    const campaignRowsForTable = campaignProfit
      .filter(campaign => {
        const status = String(campaign.status || '').toUpperCase();
        return status === 'ACTIVE'
          || Number(campaign.spend || 0) > 0
          || Number(campaign.metaPurchases || 0) > 0
          || Number(campaign.estimatedRevenue || 0) > 0
          || Number(campaign.grossProfit || 0) !== 0;
      })
      .sort((left, right) => {
        const leftActive = String(left.status || '').toUpperCase() === 'ACTIVE';
        const rightActive = String(right.status || '').toUpperCase() === 'ACTIVE';
        if (leftActive !== rightActive) return leftActive ? -1 : 1;
        return Number(right.grossProfit || 0) - Number(left.grossProfit || 0);
      });

    if (noteEl) {
      noteEl.textContent = tr(
        `Revenue estimated (pixel-attributed) · ${mediaWindowMeta.label} time frame`,
        `매출은 픽셀 귀속 기준 추정 · ${mediaWindowMeta.label} 기준`
      );
    }

    if (summaryEl) {
      const profitTone = estimatedProfit > 0 ? 'positive' : estimatedProfit < 0 ? 'negative' : 'neutral';
      summaryEl.innerHTML = [
        renderCampaignSummaryCard(
          tr('Campaign Spend', '캠페인 지출'),
          formatKrw(campaignSpendKRW),
          formatUsd(campaignSummary.spend || 0, 2),
          campaignSpendKRW > 0 ? 'negative' : 'neutral',
          'credit-card'
        ),
        renderCampaignSummaryCard(
          tr('Meta Purchases', '메타 구매'),
          formatCount(totalMetaPurchases),
          tr(`${formatCount(campaignSummary.activeCampaigns || 0)} active campaigns`, `집행중 캠페인 ${formatCount(campaignSummary.activeCampaigns || 0)}개`),
          totalMetaPurchases > 0 ? 'positive' : 'neutral',
          'mouse-pointer-2'
        ),
        renderCampaignSummaryCard(
          tr('Est. Revenue', '추정 매출'),
          formatKrw(estimatedRevenue),
          tr(`${formatPercent(attributedShare, 0)} of net revenue model`, `순매출 모델의 ${formatPercent(attributedShare, 0)}`),
          estimatedRevenue > 0 ? 'positive' : 'neutral',
          'receipt'
        ),
        renderCampaignSummaryCard(
          tr('Est. Profit', '추정 이익'),
          formatSignedKrw(estimatedProfit),
          tr(`${formatCount(campaignSummary.profitableCampaigns || 0)} profitable campaigns`, `수익 캠페인 ${formatCount(campaignSummary.profitableCampaigns || 0)}개`),
          profitTone,
          'trending-up'
        ),
      ].join('');
    }

    if (contextEl) {
      const confidence = campaignSummary.confidenceLabel || campaignSummary.confidence || tr('estimate', '추정');
      contextEl.textContent = tr(
        `${mediaWindowMeta.label} estimate · ${campaignSummary.windowStart || '—'} to ${campaignSummary.windowEnd || '—'} · ${confidence}`,
        `${mediaWindowMeta.label} 추정 · ${campaignSummary.windowStart || '—'} ~ ${campaignSummary.windowEnd || '—'} · ${confidence}`
      );
    }

    if (tbody) {
      tbody.innerHTML = campaignRowsForTable.length > 0 ? campaignRowsForTable.map(campaign => {
        const statusClass = campaign.status === 'ACTIVE' ? 'badge-success' : 'badge-neutral';
        const profitColor = campaign.grossProfit >= 0 ? 'var(--color-success)' : 'var(--color-error)';
        const estimatedRoas = Number(campaign.estimatedRoas || 0);
        return `<tr>
          <td class="cell-primary cell-wrap" title="${esc(campaign.campaignId)}">${esc(campaign.campaignName)}</td>
          <td class="cell-fit cell-nowrap"><span class="badge ${statusClass}">${esc(campaign.status === 'ACTIVE' ? tr('ACTIVE', '집행중') : campaign.status === 'PAUSED' ? tr('PAUSED', '중지') : (campaign.status || '—'))}</span></td>
          <td class="cell-fit cell-nowrap">$${campaign.spend.toFixed(2)}<br><span style="font-size:0.7rem;color:var(--color-text-faint)">₩${campaign.spendKRW.toLocaleString()}</span></td>
          <td class="cell-fit cell-nowrap">${Number(campaign.metaPurchases || 0).toLocaleString(getLocale())}</td>
          <td class="cell-fit cell-nowrap">₩${campaign.estimatedRevenue.toLocaleString()}</td>
          <td class="cell-fit cell-nowrap">₩${campaign.allocatedCOGS.toLocaleString()}</td>
          <td class="cell-fit cell-nowrap" style="color:${profitColor};font-weight:600">₩${campaign.grossProfit.toLocaleString()}</td>
          <td class="cell-fit cell-nowrap" style="color:${estimatedRoas >= 1 ? 'var(--color-success)' : 'var(--color-error)'}">${estimatedRoas.toFixed(2)}x</td>
          <td class="cell-fit cell-nowrap" style="color:${profitColor}">${campaign.margin.toFixed(1)}%</td>
        </tr>`;
      }).join('') : `<tr><td colspan="9" style="text-align:center;color:var(--color-text-faint);padding:20px">${esc(tr('No campaign estimates in this time frame.', '이 기간에는 캠페인 추정치가 없습니다.'))}</td></tr>`;
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

      profitMovementFootnote.innerHTML = `
        <span><strong>${esc(granularityLabel)} refund rate:</strong> ${esc(formatNullablePercent(windowSummary.refundRate, 1))}</span>
        <span><strong>${esc(conf.label)}:</strong> ${esc(coverageLabel)}</span>
        ${rangeLabel ? `<span>${esc(rangeLabel)}</span>` : ''}
        ${missingLabel ? `<span>${esc(missingLabel)}</span>` : ''}
      `;
    }
  }

  function updateReconciliationSection(report) {
    const statusEl = document.getElementById('reconciliationStatus');
    const noteEl = document.getElementById('reconciliationNote');
    const windowEl = document.getElementById('reconciliationWindow');
    const bodyEl = document.getElementById('reconciliationBody');
    const visibleReport = report && report.ready !== false
      ? buildVisibleReconciliationReport(report, 'revenue-quality')
      : report;
    const rangeMeta = getSeriesWindowMeta('revenue-quality');

    if (windowEl) {
      windowEl.textContent = report?.matchWindowMinutes
        ? tr(`Match time frame ${report.matchWindowMinutes}m · ${rangeMeta.label} view`, `매칭 범위 ${report.matchWindowMinutes}분 · ${rangeMeta.label} 보기`)
        : tr(`${rangeMeta.label} view`, `${rangeMeta.label} 보기`);
    }

    if (!report || report.ready === false) {
      if (statusEl) {
        statusEl.className = 'badge badge-neutral';
        statusEl.textContent = tr('Unavailable', '사용 불가');
      }
      if (noteEl) {
        noteEl.textContent = tr('Settlement reconciliation is unavailable because no settlement source is configured.', '정산 소스가 설정되지 않아 정산 대사가 불가능합니다.');
      }
      if (bodyEl) {
        bodyEl.innerHTML = `<tr><td colspan="6" style="color:var(--color-text-faint)">${esc(tr('Settlement reconciliation is unavailable.', '정산 대사를 사용할 수 없습니다.'))}</td></tr>`;
      }
      return;
    }

    const overlap = visibleReport.summary?.overlap || {};
    const matchedNet = overlap.netAmount || 0;
    const unmatchedSettlementCount = overlap.unmatchedSettlementCount || 0;
    const unmatchedImwebCount = overlap.unmatchedImwebCount || 0;
    const methodMismatchCount = overlap.methodMismatchCount || 0;
    const methodMismatchAmount = overlap.methodMismatchAmount || 0;

    if (statusEl) {
      if (methodMismatchCount > 0) {
        statusEl.className = 'badge badge-warning';
        statusEl.textContent = tr('Check Mapping', '매핑 확인');
      } else if (unmatchedSettlementCount > 0 || unmatchedImwebCount > 0) {
        statusEl.className = 'badge badge-neutral';
        statusEl.textContent = tr('Partial Match', '부분 일치');
      } else {
        statusEl.className = 'badge badge-success';
        statusEl.textContent = tr('Aligned', '일치');
      }
    }

    const reconKpis = {
      matchedNet: {
        value: formatSignedKrw(matchedNet),
        sub: tr(`${overlap.matchedCount || 0} matched events`, `일치 이벤트 ${Number(overlap.matchedCount || 0).toLocaleString(getLocale())}건`),
      },
      unmatchedSettlement: {
        value: String(unmatchedSettlementCount),
        sub: tr(`${formatSignedKrw((visibleReport.daily || []).reduce((sum, day) => sum + (day.unmatchedSettlement?.netAmount || 0), 0))} settlement gap`, `정산 차이 ${formatSignedKrw((visibleReport.daily || []).reduce((sum, day) => sum + (day.unmatchedSettlement?.netAmount || 0), 0))}`),
      },
      unmatchedImweb: {
        value: String(unmatchedImwebCount),
        sub: tr(`${formatSignedKrw((visibleReport.daily || []).reduce((sum, day) => sum + (day.unmatchedImweb?.netAmount || 0), 0))} imweb gap`, `Imweb 차이 ${formatSignedKrw((visibleReport.daily || []).reduce((sum, day) => sum + (day.unmatchedImweb?.netAmount || 0), 0))}`),
      },
      methodMismatch: {
        value: String(methodMismatchCount),
        sub: methodMismatchCount > 0 ? tr(`${formatSignedKrw(methodMismatchAmount)} flagged`, `${formatSignedKrw(methodMismatchAmount)} 표시됨`) : tr('No method drift', '결제 방식 차이 없음'),
      },
    };

    Object.entries(reconKpis).forEach(([key, meta]) => {
      const valueEl = document.querySelector(`[data-recon-kpi="${key}"] .kpi-value`);
      const subEl = document.querySelector(`[data-recon-kpi="${key}"] .kpi-delta span`);
      if (valueEl) valueEl.textContent = meta.value;
      if (subEl) subEl.textContent = meta.sub;
    });

    if (noteEl) {
      const confidence = overlap.confidence || {};
      const high = confidence.high || 0;
      const medium = confidence.medium || 0;
      const low = confidence.low || 0;
      noteEl.textContent = visibleReport.daily.length === 0
        ? tr('No reconciliation rows fall inside the selected time frame.', '선택한 기간에 해당하는 대사 행이 없습니다.')
        : methodMismatchCount > 0
        ? tr(`${high} high / ${medium} medium / ${low} low-confidence matches. Matched settlement rows are currently colliding with non-card IMWEB payment labels, so treat this as a validation signal rather than a direct payment-method map.`, `높음 ${high}건 / 중간 ${medium}건 / 낮음 ${low}건 일치입니다. 현재 카드 외 IMWEB 결제 라벨과 일부 충돌하므로 직접적인 결제수단 매핑이 아니라 검증 신호로 해석하세요.`)
        : tr(`${high} high / ${medium} medium / ${low} low-confidence matches across the selected settlement time frame.`, `선택한 정산 기간 기준 높음 ${high}건 / 중간 ${medium}건 / 낮음 ${low}건 일치입니다.`);
    }

    if (bodyEl) {
      const rows = (visibleReport.daily || []).slice().reverse();
      bodyEl.innerHTML = rows.length > 0
        ? rows.map(day => `
            <tr>
              <td style="font-weight:600">${esc(day.date)}</td>
              <td>${formatSignedKrw(day.settlement?.netAmount || 0)}</td>
              <td>${formatSignedKrw(day.imweb?.netAmount || 0)}</td>
              <td style="color:var(--color-success)">${formatSignedKrw(day.matched?.netAmount || 0)}</td>
              <td style="color:${(day.unmatchedSettlement?.netAmount || 0) === 0 ? 'var(--color-text)' : 'var(--color-warning)'}">${formatSignedKrw(day.unmatchedSettlement?.netAmount || 0)}</td>
              <td style="color:${(day.unmatchedImweb?.netAmount || 0) === 0 ? 'var(--color-text)' : 'var(--color-warning)'}">${formatSignedKrw(day.unmatchedImweb?.netAmount || 0)}</td>
            </tr>
          `).join('')
        : `<tr><td colspan="6" style="color:var(--color-text-faint)">${esc(tr('No reconciliation rows available.', '대사 행이 없습니다.'))}</td></tr>`;
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
      let reconciliation = cachedReconciliation;
      const shouldReuseCache = Boolean(
        options?.preferCached
        && cachedAnalyticsData
        && cachedReconciliation !== undefined
      );
      if (!shouldReuseCache) {
        [data, reconciliation] = await Promise.all([
          fetchAnalytics(),
          fetchReconciliation(),
        ]);
        if (!data) return;
        cachedAnalyticsData = data;
        cachedReconciliation = reconciliation || null;
      }
      if (!data) return;

      const refundRateEl = document.querySelector('[data-kpi-analytics="refundRate"] .kpi-value');
      if (refundRateEl && data.refundRate != null) {
        refundRateEl.textContent = data.refundRate.toFixed(1) + '%';
      }
      const refundSubEl = document.querySelector('[data-kpi-analytics="refundRate"] .kpi-delta span');
      if (refundSubEl) {
        refundSubEl.textContent = formatRateMetricDetail(
          data.metrics?.refunds,
          `${formatKrw(data.totalRefunded || 0)} of ${formatKrw(data.totalRevenue || 0)}`
        );
      }

      const cancelRateEl = document.querySelector('[data-kpi-analytics="cancelRate"] .kpi-value');
      if (cancelRateEl && data.cancelRate != null) {
        cancelRateEl.textContent = data.cancelRate.toFixed(1) + '%';
      }
      const cancelSubEl = document.querySelector('[data-kpi-analytics="cancelRate"] .kpi-delta span');
      if (cancelSubEl) {
        cancelSubEl.textContent = formatRateMetricDetail(
          data.metrics?.cancellations,
          tr(
            `${data.cancelledSections || 0} cancelled of ${data.totalSections || 0} sections`,
            `${(data.totalSections || 0).toLocaleString(getLocale())}개 섹션 중 ${(data.cancelledSections || 0).toLocaleString(getLocale())}개 취소`
          )
        );
      }

      const febRate = data.monthlyRates?.['2026-02'] ?? null;
      const febRefundEl = document.querySelector('[data-kpi-analytics="febRefundRate"] .kpi-value');
      if (febRefundEl && febRate != null) {
        febRefundEl.textContent = febRate.toFixed(1) + '%';
      }
      const febSubEl = document.querySelector('[data-kpi-analytics="febRefundRate"] .kpi-delta span');
      if (febSubEl) {
        const febData = (data.charts?.monthlyRefunds || []).find(month => month.month === '2026-02');
        if (febData) febSubEl.textContent = tr(`${formatKrw(febData.refunded || 0)} refunded of ${formatKrw(febData.revenue || 0)}`, `${formatKrw(febData.revenue || 0)} 중 ${formatKrw(febData.refunded || 0)} 환불`);
      }

      const marRate = data.monthlyRates?.['2026-03'] ?? null;
      const marRefundEl = document.querySelector('[data-kpi-analytics="marRefundRate"] .kpi-value');
      if (marRefundEl && marRate != null) {
        marRefundEl.textContent = marRate.toFixed(1) + '%';
      }
      const marSubEl = document.querySelector('[data-kpi-analytics="marRefundRate"] .kpi-delta span');
      if (marSubEl) {
        const marData = (data.charts?.monthlyRefunds || []).find(month => month.month === '2026-03');
        if (marData) marSubEl.textContent = tr(`${formatKrw(marData.refunded || 0)} refunded of ${formatKrw(marData.revenue || 0)}`, `${formatKrw(marData.revenue || 0)} 중 ${formatKrw(marData.refunded || 0)} 환불`);
      }

      const charts = data.charts || {};
      const allDailyMerged = charts.dailyMerged || [];
      const mediaDaily = sliceRowsByWindow(allDailyMerged, 'media-profitability');
      const mediaCutoff = mediaDaily[0]?.date || '';
      const mediaWeeklyAgg = (charts.weeklyAgg || []).filter(week => week.week >= mediaCutoff);
      const weekdayPerf = buildWeekdayPerformance(mediaDaily);
      const qualityCutoff = sliceRowsByWindow(allDailyMerged, 'revenue-quality')[0]?.date || '';
      const monthlyRefunds = (charts.monthlyRefunds || []).filter(month => month.month >= qualityCutoff.slice(0, 7));
      const imwebSource = data.dataSources?.imweb || null;
      const analyticsNoticeEl = document.getElementById('analyticsFreshnessNotice');
      const mediaEfficiencyWindowEl = document.getElementById('mediaEfficiencyWindowNote');
      const mediaEfficiencySummaryEl = document.getElementById('mediaEfficiencySummary');
      const weekdayTableWindowEl = document.getElementById('weekdayTableWindowNote');
      const mediaWindowMeta = getSeriesWindowMeta('media-profitability');

      if (mediaEfficiencyWindowEl) {
        mediaEfficiencyWindowEl.textContent = tr(`${mediaWindowMeta.label} time frame`, `${mediaWindowMeta.label} 기준`);
      }
      if (weekdayTableWindowEl) {
        weekdayTableWindowEl.textContent = tr(`Net revenue, ad spend, and CPA by weekday · ${mediaWindowMeta.label} time frame`, `요일별 순매출, 광고비, CPA · ${mediaWindowMeta.label} 기준`);
      }
      if (mediaEfficiencySummaryEl) {
        const cpaDays = weekdayPerf.filter(day => Number(day.cpa || 0) > 0);
        const bestCpaDay = cpaDays.reduce((best, day) => !best || day.cpa < best.cpa ? day : best, null);
        const peakPurchaseDay = weekdayPerf.reduce((best, day) => !best || (day.purchases || 0) > (best.purchases || 0) ? day : best, null);
        const latestWeek = mediaWeeklyAgg[mediaWeeklyAgg.length - 1] || null;
        const previousWeek = mediaWeeklyAgg[mediaWeeklyAgg.length - 2] || null;
        const latestCpa = Number(latestWeek?.cpa || 0);
        const previousCpa = Number(previousWeek?.cpa || 0);
        const latestDelta = latestCpa > 0 && previousCpa > 0
          ? latestCpa - previousCpa
          : 0;
        const latestDetail = latestWeek
          ? (previousCpa > 0
            ? tr(`${latestDelta >= 0 ? '+' : '-'}$${Math.abs(latestDelta).toFixed(2)} vs prior week`, `${latestDelta >= 0 ? '+' : '-'}$${Math.abs(latestDelta).toFixed(2)} 전주 대비`)
            : tr(`${formatCount(latestWeek.purchases || 0)} purchases`, `구매 ${formatCount(latestWeek.purchases || 0)}건`))
          : '';
        mediaEfficiencySummaryEl.innerHTML = [
          bestCpaDay ? renderMediaEfficiencyChip(tr('Best weekday CPA', '최저 요일 CPA'), bestCpaDay.day, formatUsd(bestCpaDay.cpa, 2)) : '',
          peakPurchaseDay ? renderMediaEfficiencyChip(tr('Peak purchase day', '구매 피크 요일'), peakPurchaseDay.day, tr(`${formatCount(peakPurchaseDay.purchases || 0)} purchases`, `구매 ${formatCount(peakPurchaseDay.purchases || 0)}건`)) : '',
          latestWeek ? renderMediaEfficiencyChip(tr('Latest weekly CPA', '최근 주간 CPA'), formatUsd(latestCpa, 2), latestDetail) : '',
        ].filter(Boolean).join('');
      }
      if (analyticsNoticeEl) {
        if (imwebSource?.stale) {
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
        weekdayChartInstance.data.datasets[0].data = weekdayPerf.map(day => day.purchases || 0);
        weekdayChartInstance.data.datasets[1].data = weekdayPerf.map(day => day.cpa || 0);
        weekdayChartInstance.update();
      }

      if (monthlyRefunds.length > 0 && typeof refundChartInstance !== 'undefined' && refundChartInstance) {
        refundChartInstance.data.labels = monthlyRefunds.map(month => month.month);
        refundChartInstance.data.datasets[0].data = monthlyRefunds.map(month => month.revenue || 0);
        refundChartInstance.data.datasets[1].data = monthlyRefunds.map(month => month.refunded || 0);
        refundChartInstance.update();
      }

      if (weekdayPerf.length > 0) {
        const body = document.getElementById('weekdayBody');
        if (body) {
          const bestCpa = Math.min(...weekdayPerf.filter(row => row.cpa > 0).map(row => row.cpa));
          const worstCpa = Math.max(...weekdayPerf.map(row => row.cpa || 0));

          body.innerHTML = weekdayPerf.map(day => {
            const cpa = day.cpa || 0;
            const cpaBadge = cpa > 0 && cpa <= bestCpa + 3 ? 'badge-success' : cpa >= worstCpa - 3 ? 'badge-danger' : '';
            return `<tr>
              <td style="font-weight:600">${esc(day.day)}</td>
              <td>${day.orders || 0}</td>
              <td>₩${Math.round(day.paid || 0).toLocaleString()}</td>
              <td style="color:var(--color-danger)">₩${Math.round(day.refunded || 0).toLocaleString()}</td>
              <td style="font-weight:600">₩${Math.round(day.net || 0).toLocaleString()}</td>
              <td>$${(day.spend || 0).toFixed(0)}</td>
              <td>${day.purchases || 0}</td>
              <td><span class="badge ${cpaBadge}">$${cpa.toFixed(2)}</span></td>
            </tr>`;
          }).join('');
        }
      }

      if (reconciliation) {
        updateReconciliationSection(reconciliation);
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
