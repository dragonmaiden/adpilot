(function () {
  const live = window.AdPilotLive;
  const { esc, safeConfidenceLevel, formatSignedKrw, formatCompactKrw, formatSignedCompactKrw, formatKrw, formatUsd, formatPercent, formatCount, humanizeEnum } = live.shared;
  const { fetchAnalytics, fetchReconciliation } = live.api;
  const { getSeriesWindowMeta, sliceRowsByWindow, updateSeriesWindowBadges } = live.seriesWindows;

  function formatRateMetricDetail(metric, fallback) {
    if (!metric || metric.numerator == null || metric.denominator == null) {
      return fallback;
    }

    if (metric.unit === 'currency') {
      return `${formatCompactKrw(metric.numerator)} of ${formatCompactKrw(metric.denominator)}`;
    }

    if (metric.unit === 'sections') {
      return `${metric.numerator} ${metric.numeratorLabel || 'cancelled'} of ${metric.denominator} ${metric.denominatorLabel || 'sections'}`;
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

  function buildWeekdayPerformance(rows) {
    const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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
    const campaignProfit = pa.campaignProfit || [];
    const coveredDays = waterfall.filter(row => row.hasCOGS);
    const coverageRatio = waterfall.length > 0 ? coveredDays.length / waterfall.length : 0;
    const coverage = waterfall.length === 0
      ? { totalDays: 0, daysWithCOGS: 0, coverageRatio: 0, cogsCoveredRange: {}, missingRanges: [], confidence: { level: 'low', label: 'Waiting for data' } }
      : {
          totalDays: waterfall.length,
          daysWithCOGS: coveredDays.length,
          coverageRatio,
          cogsCoveredRange: coveredDays.length > 0 ? { from: coveredDays[0].date, to: coveredDays[coveredDays.length - 1].date } : {},
          missingRanges: waterfall.filter(row => !row.hasCOGS).map(row => row.date),
          confidence: coverageRatio >= 0.9 ? { level: 'high', label: 'High confidence' }
            : coverageRatio >= 0.6 ? { level: 'medium', label: 'Medium confidence' }
            : { level: 'low', label: 'Low confidence' },
        };
    const todaySummary = pa.todaySummary;
    const runRate = pa.runRate;

    updateSeriesWindowBadges('profit-structure', waterfall);

    const heroEl = document.getElementById('profitHero');
    const verdictEl = document.getElementById('profitVerdict');
    const amountEl = document.getElementById('profitAmount');
    const confEl = document.getElementById('profitConfidence');
    const heroSubEl = document.getElementById('profitHeroSub');

    if (todaySummary && verdictEl) {
      const isPositive = todaySummary.trueNetProfit >= 0;
      verdictEl.textContent = todaySummary.verdict;
      verdictEl.className = 'profit-verdict ' + (isPositive ? 'verdict-positive' : 'verdict-negative');
      amountEl.textContent = '₩' + todaySummary.trueNetProfit.toLocaleString();
      amountEl.className = 'profit-amount ' + (isPositive ? 'verdict-positive' : 'verdict-negative');
      if (heroEl) heroEl.className = 'profit-hero ' + (isPositive ? 'hero-positive' : 'hero-negative');
    }

    if (confEl && coverage.confidence) {
      confEl.textContent = coverage.confidence.label;
      confEl.className = 'confidence-badge confidence-' + safeConfidenceLevel(coverage.confidence.level);
    }

    if (heroSubEl && todaySummary) {
      let summaryLabel = 'Latest profit signal';
      if (todaySummary.summaryType === 'today') summaryLabel = 'Today';
      if (todaySummary.summaryType === 'latest_completed') summaryLabel = 'Latest completed day';
      if (todaySummary.summaryType === 'estimated') summaryLabel = 'Current estimate';
      const cogsNote = todaySummary.hasCOGS ? 'COGS included' : 'COGS not yet available';
      const runRateText = runRate
        ? ` · 14d avg ₩${runRate.avgDailyNetProfit.toLocaleString()}/day · est. ₩${runRate.projectedMonthlyNetProfit.toLocaleString()}/30d`
        : '';
      heroSubEl.textContent = `${todaySummary.date} — ${summaryLabel} · ${cogsNote}${runRateText}`;
    }

    const totalProfit = waterfall.reduce((sum, row) => sum + toFiniteNumber(row.trueNetProfit), 0);
    const totalNetRev = waterfall.reduce((sum, row) => sum + toFiniteNumber(row.netRevenue), 0);
    const totalAdSpend = waterfall.reduce((sum, row) => sum + toFiniteNumber(row.adSpendKRW), 0);
    const blendedMargin = totalNetRev > 0 ? (totalProfit / totalNetRev * 100) : 0;
    const trueRoas = totalAdSpend > 0 ? totalNetRev / totalAdSpend : 0;

    const profitKpi = document.querySelector('[data-profit-kpi="trueNetProfit"] .kpi-value');
    if (profitKpi) profitKpi.textContent = '₩' + totalProfit.toLocaleString();
    const profitSub = document.querySelector('[data-profit-kpi="trueNetProfit"] .kpi-delta span');
    if (profitSub) profitSub.textContent = waterfall.length + ' days';

    const cogsKpi = document.querySelector('[data-profit-kpi="cogsCoverage"] .kpi-value');
    if (cogsKpi) cogsKpi.textContent = (coverage.coverageRatio * 100).toFixed(0) + '%';
    const cogsSub = document.querySelector('[data-profit-kpi="cogsCoverage"] .kpi-delta span');
    if (cogsSub) cogsSub.textContent = coverage.daysWithCOGS + ' of ' + coverage.totalDays + ' days';

    const marginKpi = document.querySelector('[data-profit-kpi="blendedMargin"] .kpi-value');
    if (marginKpi) marginKpi.textContent = blendedMargin.toFixed(1) + '%';
    const marginSub = document.querySelector('[data-profit-kpi="blendedMargin"] .kpi-delta span');
    if (marginSub) marginSub.textContent = totalProfit >= 0 ? 'Profitable' : 'Unprofitable';

    const roasKpi = document.querySelector('[data-profit-kpi="trueRoas"] .kpi-value');
    if (roasKpi) roasKpi.textContent = trueRoas.toFixed(2) + 'x';
    const roasSub = document.querySelector('[data-profit-kpi="trueRoas"] .kpi-delta span');
    if (roasSub) roasSub.textContent = 'Net Revenue / Ad Spend';

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
        runRateSub.textContent = `${runRate.daysUsed}d used · ${avgDaily}/day`;
      } else {
        runRateSub.textContent = 'Waiting for covered days';
      }
    }

    if (waterfall.length > 0 && typeof profitWaterfallChart !== 'undefined' && profitWaterfallChart) {
      profitWaterfallChart.data.labels = waterfall.map(row => row.date);
      profitWaterfallChart.data.datasets[0].data = waterfall.map(row => row.revenue);
      profitWaterfallChart.data.datasets[1].data = waterfall.map(row => -row.refunded);
      profitWaterfallChart.data.datasets[2].data = waterfall.map(row => -(row.cogs + row.cogsShipping));
      profitWaterfallChart.data.datasets[3].data = waterfall.map(row => -row.adSpendKRW);
      profitWaterfallChart.data.datasets[4].data = waterfall.map(row => -row.paymentFees);
      profitWaterfallChart.data.datasets[5].data = waterfall.map(row => row.trueNetProfit);
      profitWaterfallChart.data.datasets[5].pointBackgroundColor = waterfall.map(row =>
        row.trueNetProfit >= 0 ? '#4ade80' : '#f87171'
      );
      profitWaterfallChart.data.datasets[0].backgroundColor = waterfall.map(row =>
        row.hasCOGS ? 'rgba(74, 222, 128, 0.75)' : 'rgba(74, 222, 128, 0.35)'
      );
      profitWaterfallChart.update();
    }

    const tbody = document.getElementById('campaignProfitBody');
    if (tbody) {
      tbody.innerHTML = campaignProfit.map(campaign => {
        const statusClass = campaign.status === 'ACTIVE' ? 'badge-success' : 'badge-neutral';
        const profitColor = campaign.grossProfit >= 0 ? 'var(--color-success)' : 'var(--color-error)';
        return `<tr>
          <td title="${esc(campaign.campaignId)}">${esc(campaign.campaignName)}</td>
          <td><span class="badge ${statusClass}">${esc(campaign.status || '—')}</span></td>
          <td>$${campaign.spend.toFixed(2)}<br><span style="font-size:0.7rem;color:var(--color-text-faint)">₩${campaign.spendKRW.toLocaleString()}</span></td>
          <td>${campaign.metaPurchases}</td>
          <td>₩${campaign.estimatedRevenue.toLocaleString()}</td>
          <td>₩${campaign.allocatedCOGS.toLocaleString()}</td>
          <td style="color:${profitColor};font-weight:600">₩${campaign.grossProfit.toLocaleString()}</td>
          <td style="color:${profitColor}">${campaign.margin.toFixed(1)}%</td>
        </tr>`;
      }).join('');
    }

    const coverageContent = document.getElementById('dataCoverageContent');
    if (coverageContent && coverage.confidence) {
      const conf = coverage.confidence;
      const confLevel = safeConfidenceLevel(conf.level);
      const coveredRange = coverage.cogsCoveredRange || {};
      const missing = coverage.missingRanges || [];
      coverageContent.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
          <span class="confidence-badge confidence-${confLevel}">${esc(conf.label)}</span>
          <span style="font-size:0.85rem;color:var(--color-text-muted)">${coverage.daysWithCOGS} of ${coverage.totalDays} days have COGS data (${(coverage.coverageRatio * 100).toFixed(0)}%)</span>
        </div>
        ${coveredRange.from ? `<p style="font-size:0.85rem;color:var(--color-text-muted);margin:4px 0">Covered: <strong>${esc(coveredRange.from)}</strong> to <strong>${esc(coveredRange.to)}</strong></p>` : ''}
        ${missing.length > 0 ? `<p style="font-size:0.85rem;color:var(--color-text-faint);margin:4px 0">Missing: ${missing.map(item => esc(item)).join(', ')}</p>` : ''}
        <p style="font-size:0.78rem;color:var(--color-text-faint);margin-top:8px">Days without COGS data are shown dimmed in the waterfall chart. Profit for those days only accounts for revenue, ad spend, and payment fees.</p>
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
        ? `Match window ${report.matchWindowMinutes}m · ${rangeMeta.label} view`
        : `${rangeMeta.label} view`;
    }

    if (!report || report.ready === false) {
      if (statusEl) {
        statusEl.className = 'badge badge-neutral';
        statusEl.textContent = 'Unavailable';
      }
      if (noteEl) {
        noteEl.textContent = 'Settlement reconciliation is unavailable because no settlement source is configured.';
      }
      if (bodyEl) {
        bodyEl.innerHTML = '<tr><td colspan="6" style="color:var(--color-text-faint)">Settlement reconciliation is unavailable.</td></tr>';
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
        statusEl.textContent = 'Check Mapping';
      } else if (unmatchedSettlementCount > 0 || unmatchedImwebCount > 0) {
        statusEl.className = 'badge badge-neutral';
        statusEl.textContent = 'Partial Match';
      } else {
        statusEl.className = 'badge badge-success';
        statusEl.textContent = 'Aligned';
      }
    }

    const reconKpis = {
      matchedNet: {
        value: formatSignedCompactKrw(matchedNet),
        sub: `${overlap.matchedCount || 0} matched events`,
      },
      unmatchedSettlement: {
        value: String(unmatchedSettlementCount),
        sub: `${formatSignedCompactKrw((visibleReport.daily || []).reduce((sum, day) => sum + (day.unmatchedSettlement?.netAmount || 0), 0))} settlement gap`,
      },
      unmatchedImweb: {
        value: String(unmatchedImwebCount),
        sub: `${formatSignedCompactKrw((visibleReport.daily || []).reduce((sum, day) => sum + (day.unmatchedImweb?.netAmount || 0), 0))} imweb gap`,
      },
      methodMismatch: {
        value: String(methodMismatchCount),
        sub: methodMismatchCount > 0 ? `${formatSignedCompactKrw(methodMismatchAmount)} flagged` : 'No method drift',
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
        ? 'No reconciliation rows fall inside the selected window.'
        : methodMismatchCount > 0
        ? `${high} high / ${medium} medium / ${low} low-confidence matches. Matched settlement rows are currently colliding with non-card IMWEB payment labels, so treat this as a validation signal rather than a direct payment-method map.`
        : `${high} high / ${medium} medium / ${low} low-confidence matches across the selected settlement window.`;
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
        : '<tr><td colspan="6" style="color:var(--color-text-faint)">No reconciliation rows available.</td></tr>';
    }
  }

  async function refreshAnalyticsPage() {
    try {
      const [data, reconciliation] = await Promise.all([
        fetchAnalytics(),
        fetchReconciliation(),
      ]);
      if (!data) return;

      const colors = typeof getChartColors === 'function' ? getChartColors() : {};
      const primary = colors.primary || '#20808D';

      const refundRateEl = document.querySelector('[data-kpi-analytics="refundRate"] .kpi-value');
      if (refundRateEl && data.refundRate != null) {
        refundRateEl.textContent = data.refundRate.toFixed(1) + '%';
      }
      const refundSubEl = document.querySelector('[data-kpi-analytics="refundRate"] .kpi-delta span');
      if (refundSubEl) {
        refundSubEl.textContent = formatRateMetricDetail(
          data.metrics?.refunds,
          '₩' + (data.totalRefunded / 1000).toFixed(0) + 'K of ₩' + ((data.totalRevenue || 0) / 1000000).toFixed(1) + 'M'
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
          (data.cancelledSections || 0) + ' cancelled of ' + (data.totalSections || 0) + ' sections'
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
        if (febData) febSubEl.textContent = '₩' + (febData.refunded / 1000).toFixed(0) + 'K refunded of ₩' + (febData.revenue / 1000000).toFixed(1) + 'M';
      }

      const marRate = data.monthlyRates?.['2026-03'] ?? null;
      const marRefundEl = document.querySelector('[data-kpi-analytics="marRefundRate"] .kpi-value');
      if (marRefundEl && marRate != null) {
        marRefundEl.textContent = marRate.toFixed(1) + '%';
      }
      const marSubEl = document.querySelector('[data-kpi-analytics="marRefundRate"] .kpi-delta span');
      if (marSubEl) {
        const marData = (data.charts?.monthlyRefunds || []).find(month => month.month === '2026-03');
        if (marData) marSubEl.textContent = '₩' + (marData.refunded / 1000).toFixed(0) + 'K refunded of ₩' + (marData.revenue / 1000000).toFixed(1) + 'M';
      }

      const charts = data.charts || {};
      const allDailyMerged = charts.dailyMerged || [];
      const allProfitWaterfall = data.profitAnalysis?.waterfall || [];
      const profitDaily = sliceRowsByWindow(allDailyMerged, 'profit-structure');
      const profitWaterfall = sliceRowsByWindow(allProfitWaterfall, 'profit-structure');
      const dailyProfit = profitWaterfall.length > 0
        ? profitWaterfall.map(row => ({ date: row.date, profit: row.trueNetProfit || 0 }))
        : sliceRowsByWindow(charts.dailyProfit || [], 'profit-structure');
      const profitCutoff = profitDaily[0]?.date || '';
      const profitWeeklyAgg = (charts.weeklyAgg || []).filter(week => week.week >= profitCutoff);
      const mediaDaily = sliceRowsByWindow(allDailyMerged, 'media-profitability');
      const mediaCutoff = mediaDaily[0]?.date || '';
      const mediaWeeklyAgg = (charts.weeklyAgg || []).filter(week => week.week >= mediaCutoff);
      const weekdayPerf = buildWeekdayPerformance(mediaDaily);
      const qualityCutoff = sliceRowsByWindow(allDailyMerged, 'revenue-quality')[0]?.date || '';
      const monthlyRefunds = (charts.monthlyRefunds || []).filter(month => month.month >= qualityCutoff.slice(0, 7));
      const imwebSource = data.dataSources?.imweb || null;
      const analyticsNoticeEl = document.getElementById('analyticsFreshnessNotice');
      const weekdayChartWindowEl = document.getElementById('weekdayChartWindowNote');
      const weekdayTableWindowEl = document.getElementById('weekdayTableWindowNote');
      const mediaWindowMeta = getSeriesWindowMeta('media-profitability');

      if (weekdayChartWindowEl) {
        weekdayChartWindowEl.textContent = `${mediaWindowMeta.label} window`;
      }
      if (weekdayTableWindowEl) {
        weekdayTableWindowEl.textContent = `Net revenue, ad spend, and CPA by weekday · ${mediaWindowMeta.label} window`;
      }
      if (analyticsNoticeEl) {
        if (imwebSource?.stale) {
          analyticsNoticeEl.hidden = false;
          analyticsNoticeEl.textContent = 'Revenue-backed analytics are using cached Imweb data. Weekday revenue, refunds, and ROAS are directional until the next successful sync.';
        } else if (imwebSource?.status === 'error') {
          analyticsNoticeEl.hidden = false;
          analyticsNoticeEl.textContent = 'Imweb sync is unavailable. Revenue-backed analytics may be incomplete.';
        } else {
          analyticsNoticeEl.hidden = true;
          analyticsNoticeEl.textContent = '';
        }
      }

      renderProfitAnalysisSection(data);

      if (dailyProfit.length > 0 && typeof profitTrendChart !== 'undefined' && profitTrendChart) {
        let cumProfit = 0;
        const cumData = dailyProfit.map(day => {
          cumProfit += (day.profit || 0);
          return cumProfit;
        });

        profitTrendChart.data.labels = dailyProfit.map(day => day.date);
        profitTrendChart.data.datasets[0].data = dailyProfit.map(day => day.profit || 0);
        profitTrendChart.data.datasets[0].backgroundColor = dailyProfit.map(day =>
          (day.profit || 0) >= 0 ? 'rgba(74, 222, 128, 0.7)' : 'rgba(239, 68, 68, 0.6)'
        );
        profitTrendChart.data.datasets[1].data = cumData;
        profitTrendChart.update();
      }

      if (profitWeeklyAgg.length > 0 && typeof weeklyProfitChart !== 'undefined' && weeklyProfitChart) {
        weeklyProfitChart.data.labels = profitWeeklyAgg.map(week => week.week);
        weeklyProfitChart.data.datasets[0].data = profitWeeklyAgg.map(week => week.profit || 0);
        weeklyProfitChart.data.datasets[0].backgroundColor = profitWeeklyAgg.map(week =>
          (week.profit || 0) >= 0 ? 'rgba(32, 128, 141, 0.8)' : 'rgba(239, 68, 68, 0.6)'
        );
        weeklyProfitChart.update();
      }

      if (mediaWeeklyAgg.length > 0 && typeof weeklyCpaChartInstance !== 'undefined' && weeklyCpaChartInstance) {
        weeklyCpaChartInstance.data.labels = mediaWeeklyAgg.map(week => week.week);
        weeklyCpaChartInstance.data.datasets[0].data = mediaWeeklyAgg.map(week => week.cpa || 0);
        weeklyCpaChartInstance.data.datasets[0].pointBackgroundColor = mediaWeeklyAgg.map(week =>
          (week.cpa || 0) > 20 ? 'rgba(239, 68, 68, 0.9)' : primary
        );
        weeklyCpaChartInstance.data.datasets[1].data = mediaWeeklyAgg.map(week => week.purchases || 0);
        weeklyCpaChartInstance.update();
      }

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

  live.registerPage('analytics', {
    refresh: refreshAnalyticsPage,
  });
})();
