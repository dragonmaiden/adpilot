(function () {
  const live = window.AdPilotLive;
  const {
    esc,
    safeConfidenceLevel,
    formatSignedKrw,
    formatKrw,
    formatPercent,
    formatCount,
    tr,
    getLocale,
  } = live.shared;

  function toFiniteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function hasNumericValue(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value));
  }

  function formatNullablePercent(value, digits = 1) {
    return hasNumericValue(value) ? formatPercent(Number(value), digits) : '—';
  }

  function formatNullableRoas(value) {
    return hasNumericValue(value) ? `${Number(value).toFixed(2)}x` : '—';
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

  function getCoverageRatio(coverage) {
    const ratio = Number(coverage?.coverageRatio);
    return Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : null;
  }

  function formatCoveragePercentLabel(coverage) {
    const ratio = getCoverageRatio(coverage);
    return ratio == null ? '—' : `${Math.round(ratio * 100)}%`;
  }

  function hasPartialCogsCoverage(coverage) {
    const partialDays = Number(coverage?.daysWithPartialCOGS || 0);
    const ratio = getCoverageRatio(coverage);
    return partialDays > 0 || (ratio != null && ratio > 0 && ratio < 1);
  }

  function emptyCoverage() {
    return {
      totalDays: 0,
      daysWithCOGS: 0,
      daysWithPartialCOGS: 0,
      daysWithPendingRecovery: 0,
      coverageRatio: 0,
      confidence: { level: 'low', label: tr('Waiting for data', '데이터 대기 중') },
    };
  }

  const PROFIT_INPUT_CARD_ICONS = {
    grossRevenue: 'receipt',
    refunds: 'rotate-ccw',
    totalCosts: 'package',
    trueNetProfit: 'trending-up',
  };

  function updateProfitInputCard(key, value, detail, tone = 'neutral', iconName = null) {
    const card = document.querySelector(`[data-profit-source-kpi="${key}"]`);
    if (!card) return;

    const valueElement = card.querySelector('.kpi-value');
    const detailElement = card.querySelector('.kpi-delta span');
    const detailWrapper = card.querySelector('.kpi-delta');
    const resolvedIconName = iconName || PROFIT_INPUT_CARD_ICONS[key] || null;

    if (valueElement) valueElement.textContent = value;
    if (detailElement) detailElement.textContent = detail;
    if (!detailWrapper) return;

    detailWrapper.classList.remove('positive', 'negative', 'warning', 'neutral');
    detailWrapper.classList.add(tone);
    if (resolvedIconName) {
      detailWrapper.innerHTML = `<i data-lucide="${esc(resolvedIconName)}"></i><span>${esc(detail)}</span>`;
      if (window.lucide) lucide.createIcons({ nodes: [detailWrapper] });
    }
  }

  function updateAnalyticsNotice(sourceAudit) {
    const noticeElement = document.getElementById('analyticsFreshnessNotice');
    if (!noticeElement) return;

    const failedChecks = Array.isArray(sourceAudit?.summary?.failedChecks)
      ? sourceAudit.summary.failedChecks
      : [];
    const failedFetches = Array.isArray(sourceAudit?.summary?.failedFetches)
      ? sourceAudit.summary.failedFetches
      : [];

    noticeElement.classList.remove('is-error');
    if (sourceAudit?.status === 'mismatch') {
      noticeElement.hidden = false;
      noticeElement.classList.add('is-error');
      noticeElement.textContent = failedChecks.length > 0
        ? tr(
            `Source audit mismatch: ${failedChecks.join(', ')}. Financial totals need review before use.`,
            `소스 감사 불일치: ${failedChecks.join(', ')}. 사용 전 재무 합계 검토가 필요합니다.`
          )
        : tr(
            'Source audit mismatch. Financial totals need review before use.',
            '소스 감사 불일치. 사용 전 재무 합계 검토가 필요합니다.'
          );
      return;
    }

    if (sourceAudit?.status === 'reconciled_with_stale_sources') {
      noticeElement.hidden = false;
      noticeElement.textContent = failedFetches.length > 0
        ? tr(
            `Using last-known-good source data for ${failedFetches.join(', ')}.`,
            `${failedFetches.join(', ')} 마지막 정상 소스 데이터를 사용 중입니다.`
          )
        : tr('Using last-known-good source data.', '마지막 정상 소스 데이터를 사용 중입니다.');
      return;
    }

    noticeElement.hidden = true;
    noticeElement.textContent = '';
  }

  function getSelectionCoverage(rows, selection, summary) {
    const coverage = selection?.coverage || {};
    const totalDays = toFiniteNumber(coverage.totalDays ?? summary?.totalDays ?? rows.length);
    const daysWithCOGS = toFiniteNumber(coverage.daysWithCOGS ?? summary?.daysWithCOGS);
    const daysWithPartialCOGS = toFiniteNumber(
      coverage.daysWithPartialCOGS ?? summary?.daysWithPartialCOGS
    );
    const coverageRatio = hasNumericValue(coverage.coverageRatio)
      ? Number(coverage.coverageRatio)
      : totalDays > 0
      ? Number(
          (
            rows.reduce((sum, row) => sum + toFiniteNumber(row.cogsCoverageRatio), 0) /
            totalDays
          ).toFixed(3)
        )
      : 0;

    return {
      totalDays,
      daysWithCOGS,
      daysWithPartialCOGS,
      daysWithPendingRecovery: toFiniteNumber(coverage.daysWithPendingRecovery),
      coverageRatio,
      confidence: coverage.confidence || summary?.confidence || emptyCoverage().confidence,
    };
  }

  function buildSelectionSummary(selection) {
    const rows = normalizeCoverageRows(selection?.days || []);
    const sourceSummary = selection?.summary || {};
    const totalNetRevenue = hasNumericValue(sourceSummary.netRevenue)
      ? Number(sourceSummary.netRevenue)
      : null;
    const totalCosts = hasNumericValue(sourceSummary.totalCosts)
      ? Number(sourceSummary.totalCosts)
      : null;

    return {
      daysShown: hasNumericValue(selection?.dayCount)
        ? Number(selection.dayCount)
        : rows.length,
      totalProfit: hasNumericValue(sourceSummary.trueNetProfit)
        ? Number(sourceSummary.trueNetProfit)
        : null,
      totalGrossRevenue: hasNumericValue(sourceSummary.grossRevenue)
        ? Number(sourceSummary.grossRevenue)
        : null,
      totalRefunded: hasNumericValue(sourceSummary.refundedAmount)
        ? Number(sourceSummary.refundedAmount)
        : null,
      totalOrders: hasNumericValue(sourceSummary.recognizedOrders)
        ? Number(sourceSummary.recognizedOrders)
        : null,
      totalCosts,
      blendedMargin: hasNumericValue(sourceSummary.margin)
        ? Number(sourceSummary.margin)
        : null,
      trueRoas: hasNumericValue(sourceSummary.roas)
        ? Number(sourceSummary.roas)
        : null,
      refundRate: hasNumericValue(sourceSummary.refundRate)
        ? Number(sourceSummary.refundRate)
        : null,
      costsShare: totalNetRevenue > 0 && hasNumericValue(totalCosts)
        ? (totalCosts / totalNetRevenue) * 100
        : null,
      coverage: getSelectionCoverage(rows, selection, sourceSummary),
    };
  }

  function normalizeCoverageRows(rows) {
    return (Array.isArray(rows) ? rows : [])
      .map(row => ({
        date: row?.date || '',
        cogsCoverageRatio: toFiniteNumber(row?.cogsCoverageRatio),
      }))
      .filter(row => row.date);
  }

  function renderProfitSummary(summary, windowLabel) {
    const coverage = summary.coverage || emptyCoverage();
    const {
      totalProfit,
      totalGrossRevenue,
      totalRefunded,
      totalOrders,
      totalCosts,
      blendedMargin,
      trueRoas,
      refundRate,
      costsShare,
      daysShown,
    } = summary;
    const averageDailyProfit =
      daysShown > 0 && hasNumericValue(totalProfit)
        ? Math.round(Number(totalProfit) / daysShown)
        : null;
    const partialCogs = hasPartialCogsCoverage(coverage);
    const coverageLabel = formatCoveragePercentLabel(coverage);
    const costsShareLabel = formatNullablePercent(costsShare);
    const marginLabel = formatNullablePercent(blendedMargin, 1);
    const isPositive = totalProfit > 0;
    const isNegative = totalProfit < 0;

    const heroElement = document.getElementById('profitHero');
    const kickerElement = document.getElementById('profitHeroKicker');
    const verdictElement = document.getElementById('profitVerdict');
    const amountElement = document.getElementById('profitAmount');
    const confidenceElement = document.getElementById('profitConfidence');
    const heroSubElement = document.getElementById('profitHeroSub');
    const latestSignalElement = document.getElementById('profitLatestSignal');

    if (kickerElement) {
      kickerElement.textContent = tr(`${windowLabel} net profit`, `${windowLabel} 순이익`);
    }
    if (verdictElement) {
      verdictElement.textContent = isPositive
        ? tr('Profitable period', '수익 구간')
        : isNegative
        ? tr('Unprofitable period', '적자 구간')
        : tr('Break-even period', '손익분기 구간');
      verdictElement.className = `profit-verdict ${
        isPositive ? 'verdict-positive' : isNegative ? 'verdict-negative' : ''
      }`;
    }
    if (amountElement) {
      amountElement.textContent = formatNullableSignedKrw(totalProfit);
      amountElement.className = `profit-amount ${
        isPositive ? 'verdict-positive' : isNegative ? 'verdict-negative' : ''
      }`;
    }
    if (heroElement) {
      heroElement.className = `profit-hero ${
        isPositive ? 'hero-positive' : isNegative ? 'hero-negative' : ''
      }`;
    }
    if (confidenceElement) {
      const confidence = coverage.confidence || emptyCoverage().confidence;
      confidenceElement.textContent =
        confidence.level === 'high'
          ? tr('Strong COGS coverage', 'COGS 커버리지 양호')
          : confidence.level === 'medium'
          ? tr('Partial COGS coverage', 'COGS 일부 커버')
          : tr('Low COGS coverage', 'COGS 커버리지 낮음');
      confidenceElement.className =
        'confidence-badge confidence-' + safeConfidenceLevel(confidence.level);
    }
    if (heroSubElement) {
      heroSubElement.textContent = tr(
        `${windowLabel} · ${daysShown} days shown · ${coverage.daysWithCOGS} fully covered of ${coverage.totalDays} (${(coverage.coverageRatio * 100).toFixed(0)}% weighted coverage)`,
        `${windowLabel} 기준 · ${daysShown.toLocaleString(getLocale())}일 표시 · ${coverage.totalDays.toLocaleString(getLocale())}일 중 ${coverage.daysWithCOGS.toLocaleString(getLocale())}일 완전 커버 (${(coverage.coverageRatio * 100).toFixed(0)}% 가중 커버)`
      );
    }
    if (latestSignalElement) {
      latestSignalElement.textContent = tr(
        `${windowLabel}: ${formatNullableCount(totalOrders)} orders · ${formatNullableKrw(totalGrossRevenue)} gross · ${formatNullableKrw(totalRefunded)} refunded`,
        `${windowLabel}: 주문 ${formatNullableCount(totalOrders)}건 · 총매출 ${formatNullableKrw(totalGrossRevenue)} · 환불 ${formatNullableKrw(totalRefunded)}`
      );
    }

    const heroMarginElement = document.getElementById('profitHeroMargin');
    const heroRoasElement = document.getElementById('profitHeroRoas');
    const heroRunRateElement = document.getElementById('profitHeroRunRate');
    if (heroMarginElement) heroMarginElement.textContent = marginLabel;
    if (heroRoasElement) heroRoasElement.textContent = formatNullableRoas(trueRoas);
    if (heroRunRateElement) {
      heroRunRateElement.textContent = formatNullableSignedKrw(averageDailyProfit);
    }

    updateProfitInputCard(
      'grossRevenue',
      formatNullableKrw(totalGrossRevenue),
      tr(
        `${formatNullableCount(totalOrders)} orders · ${formatNullableKrw(totalRefunded)} refunded`,
        `${formatNullableCount(totalOrders)}건 주문 · 환불 ${formatNullableKrw(totalRefunded)}`
      ),
      totalGrossRevenue > 0 ? 'positive' : 'neutral'
    );
    updateProfitInputCard(
      'refunds',
      formatNullableKrw(totalRefunded),
      tr(
        `${formatNullablePercent(refundRate)} of gross revenue`,
        `총매출 대비 ${formatNullablePercent(refundRate)}`
      ),
      totalRefunded > 0 ? 'negative' : 'neutral'
    );
    updateProfitInputCard(
      'totalCosts',
      formatNullableKrw(totalCosts),
      partialCogs
        ? tr(
            `${coverageLabel} COGS · ${costsShareLabel} costs`,
            `COGS ${coverageLabel} · 비용 ${costsShareLabel}`
          )
        : tr(`${costsShareLabel} of net revenue`, `순매출 대비 ${costsShareLabel}`),
      partialCogs ? 'warning' : totalCosts > 0 ? 'negative' : 'neutral',
      partialCogs ? 'triangle-alert' : 'package'
    );
  }

  function renderProfitSummaryPlaceholder(message) {
    updateAnalyticsNotice(null);
    const waitingText =
      message || tr('Waiting for the selected range...', '선택 범위 대기 중...');
    const heroElement = document.getElementById('profitHero');
    const kickerElement = document.getElementById('profitHeroKicker');
    const amountElement = document.getElementById('profitAmount');
    const verdictElement = document.getElementById('profitVerdict');
    const confidenceElement = document.getElementById('profitConfidence');
    const heroSubElement = document.getElementById('profitHeroSub');
    const latestSignalElement = document.getElementById('profitLatestSignal');

    if (kickerElement) {
      kickerElement.textContent = tr('Selected range net profit', '선택 범위 순이익');
    }
    if (heroElement) heroElement.className = 'profit-hero';
    if (amountElement) {
      amountElement.textContent = '—';
      amountElement.className = 'profit-amount';
    }
    if (verdictElement) {
      verdictElement.textContent = '—';
      verdictElement.className = 'profit-verdict';
    }
    if (confidenceElement) confidenceElement.textContent = tr('Waiting for data', '데이터 대기 중');
    if (heroSubElement) heroSubElement.textContent = waitingText;
    if (latestSignalElement) latestSignalElement.textContent = waitingText;

    ['grossRevenue', 'refunds', 'totalCosts'].forEach(key => {
      updateProfitInputCard(key, '—', waitingText, 'neutral');
    });
  }

  function renderCalendarSelectionProfitSummary(payload = {}) {
    if (payload.loading || payload.error || !payload.selection) {
      renderProfitSummaryPlaceholder(
        payload.error || tr('Refreshing selected range...', '선택 범위 새로고침 중...')
      );
      return;
    }

    const selection = payload.selection || {};
    if (selection.summary?.paymentFeeCoverage?.complete !== true) {
      renderProfitSummaryPlaceholder(
        tr(
          'Net profit is waiting for complete Payway fee data.',
          '완전한 Payway 수수료 데이터를 기다리는 중입니다.'
        )
      );
      return;
    }
    const summary = buildSelectionSummary(selection);
    const windowLabel =
      payload.contextLabel || selection.label || tr('Selected range', '선택 범위');

    updateAnalyticsNotice(payload.sourceAudit || null);
    renderProfitSummary(summary, windowLabel);
  }

  live.profitSummary = {
    renderCalendarSelection: renderCalendarSelectionProfitSummary,
  };
})();
