// ═══════════════════════════════════════════════════════
// AdPilot — API Response Contracts v1
// Every endpoint returns one clean, versioned shape.
// No raw Meta/Imweb shapes leak to the UI.
// ═══════════════════════════════════════════════════════

const API_VERSION = 'v1';

function buildRateMetric({ rate = 0, numerator = 0, denominator = 0, unit = '', numeratorLabel = '', denominatorLabel = '' }) {
  return {
    rate,
    numerator,
    denominator,
    unit,
    numeratorLabel,
    denominatorLabel,
  };
}

/**
 * Build /api/overview response.
 */
function overview({ kpis, days, campaigns, charts, scanStats, lastScan, isScanning, dataSources, fx }) {
  return {
    apiVersion: API_VERSION,
    ready: true,
    lastScan: lastScan ?? null,
    isScanning: isScanning ?? false,
    days: days ?? 0,
    kpis: {
      revenue: kpis.revenue ?? 0,
      refunded: kpis.refunded ?? 0,
      netRevenue: kpis.netRevenue ?? 0,
      totalOrders: kpis.totalOrders ?? 0,
      adSpend: kpis.adSpend ?? 0,
      adSpendKRW: kpis.adSpendKRW ?? 0,
      purchases: kpis.purchases ?? 0,
      cpa: kpis.cpa ?? 0,
      ctr: kpis.ctr ?? 0,
      roas: kpis.roas ?? 0,
      refundRate: kpis.refundRate ?? 0,
      cancelRate: kpis.cancelRate ?? 0,
      cogs: kpis.cogs ?? null,
      aov: kpis.aov ?? 0,
      cogsRate: kpis.cogsRate ?? 0,
      grossProfit: kpis.grossProfit ?? 0,
      grossMargin: kpis.grossMargin ?? 0,
    },
    campaigns: (campaigns || []).map(c => ({
      id: c.id ?? '',
      name: c.name ?? '',
      status: c.status ?? 'UNKNOWN',
      dailyBudget: c.daily_budget ?? c.dailyBudget ?? null,
      objective: c.objective ?? '',
      bidStrategy: c.bid_strategy ?? c.bidStrategy ?? '',
    })),
    charts: {
      dailyMerged: charts.dailyMerged ?? [],
      hourlyOrders: charts.hourlyOrders ?? [],
      weekdayPerf: charts.weekdayPerf ?? [],
      weeklyAgg: charts.weeklyAgg ?? [],
      monthlyRefunds: charts.monthlyRefunds ?? [],
      dailyProfit: charts.dailyProfit ?? [],
    },
    scanStats: scanStats ?? {},
    dataSources: dataSources ?? {},
    fx: fx ?? {},
  };
}

/**
 * Build /api/overview "not ready" response.
 */
function overviewNotReady() {
  return {
    apiVersion: API_VERSION,
    ready: false,
    message: 'First scan not yet complete. Starting up...',
  };
}

/**
 * Build /api/analytics response.
 */
function analytics({ charts, revenueData, dailyInsights, adInsights, cogsData, monthlyRates, profitAnalysis, dataSources }) {
  const refundMetric = buildRateMetric({
    rate: revenueData?.refundRate ?? 0,
    numerator: revenueData?.totalRefunded ?? 0,
    denominator: revenueData?.totalRevenue ?? 0,
    unit: 'currency',
    numeratorLabel: 'refunded',
    denominatorLabel: 'revenue',
  });
  const cancellationMetric = buildRateMetric({
    rate: revenueData?.cancelRate ?? 0,
    numerator: revenueData?.cancelledSections ?? 0,
    denominator: revenueData?.totalSections ?? 0,
    unit: 'sections',
    numeratorLabel: 'cancelled',
    denominatorLabel: 'sections',
  });

  return {
    apiVersion: API_VERSION,
    charts: {
      dailyMerged: charts.dailyMerged ?? [],
      hourlyOrders: charts.hourlyOrders ?? [],
      weekdayPerf: charts.weekdayPerf ?? [],
      weeklyAgg: charts.weeklyAgg ?? [],
      monthlyRefunds: charts.monthlyRefunds ?? [],
      dailyProfit: charts.dailyProfit ?? [],
      fatigueTrend: charts.fatigueTrend ?? [],
    },
    // Flat metrics for non-chart consumers
    refundRate: refundMetric.rate,
    cancelRate: cancellationMetric.rate,
    cancelledSections: cancellationMetric.numerator,
    totalSections: cancellationMetric.denominator,
    totalRefunded: refundMetric.numerator,
    totalRevenue: refundMetric.denominator,
    netRevenue: revenueData?.netRevenue ?? 0,
    totalOrders: revenueData?.totalOrders ?? 0,
    metrics: {
      refunds: refundMetric,
      cancellations: cancellationMetric,
    },
    monthlyRates: monthlyRates ?? {},
    // COGS data from Google Sheets
    totalCOGS: cogsData?.totalCOGS ?? 0,
    totalShipping: cogsData?.totalShipping ?? 0,
    cogsItems: cogsData?.itemCount ?? 0,
    cogsOrders: cogsData?.orderCount ?? 0,
    // Raw insight rows (campaigns may still need them for tables)
    dailyInsights: dailyInsights ?? [],
    adInsights: adInsights ?? [],
    dataSources: dataSources ?? {},
    // Profit Analysis
    profitAnalysis: {
      waterfall: profitAnalysis?.waterfall ?? [],
      campaignProfit: profitAnalysis?.campaignProfit ?? [],
      campaignProfitWindows: profitAnalysis?.campaignProfitWindows ?? {},
      coverage: profitAnalysis?.coverage ?? {},
      windowSummaries: profitAnalysis?.windowSummaries ?? {},
      todaySummary: profitAnalysis?.todaySummary ?? null,
      runRate: profitAnalysis?.runRate ?? null,
    },
  };
}

/**
 * Build /api/calendar-analysis response.
 */
function calendarAnalysis({ ready, viewport, calendarDays, selection }) {
  return {
    apiVersion: API_VERSION,
    ready: ready !== false,
    viewport: {
      today: viewport?.today ?? null,
      visibleStart: viewport?.visibleStart ?? null,
      visibleEnd: viewport?.visibleEnd ?? null,
      selectionStart: viewport?.selectionStart ?? null,
      selectionEnd: viewport?.selectionEnd ?? null,
      months: viewport?.months ?? [],
    },
    calendarDays: calendarDays ?? [],
    selection: {
      label: selection?.label ?? '',
      dayCount: selection?.dayCount ?? 0,
      summary: selection?.summary ?? {},
      days: selection?.days ?? [],
      orders: selection?.orders ?? [],
      products: selection?.products ?? [],
      campaigns: selection?.campaigns ?? [],
      operations: selection?.operations ?? [],
      reconciliation: selection?.reconciliation ?? {},
      coverage: selection?.coverage ?? {},
    },
  };
}

/**
 * Build /api/campaigns response.
 */
function campaigns({ campaigns: enriched, windowKey, windowDays }) {
  return {
    apiVersion: API_VERSION,
    windowKey: windowKey ?? '7d',
    windowDays: windowDays ?? 7,
    campaigns: (enriched || []).map(c => ({
      id: c.id ?? '',
      name: c.name ?? '',
      status: c.status ?? 'UNKNOWN',
      effectiveStatus: c.effective_status ?? c.status ?? 'UNKNOWN',
      dailyBudget: c.daily_budget ?? c.dailyBudget ?? null,
      objective: c.objective ?? '',
      bidStrategy: c.bid_strategy ?? c.bidStrategy ?? '',
      metricsWindow: {
        spend: c.metricsWindow?.spend ?? 0,
        attributedPurchases: c.metricsWindow?.attributedPurchases ?? c.metricsWindow?.metaPurchases ?? 0,
        metaPurchases: c.metricsWindow?.metaPurchases ?? 0,
        cpa: c.metricsWindow?.cpa ?? null,
        clicks: c.metricsWindow?.clicks ?? 0,
        impressions: c.metricsWindow?.impressions ?? 0,
        ctr: c.metricsWindow?.ctr ?? 0,
      },
    })),
  };
}

function livePerformance(data) {
  return {
    apiVersion: API_VERSION,
    ...data,
  };
}

/**
 * Build /api/scans response.
 */
function scans({ history, lastScan, isScanning, nextScan }) {
  return {
    apiVersion: API_VERSION,
    history: history ?? [],
    lastScan: lastScan ?? null,
    isScanning: isScanning ?? false,
    nextScan: nextScan ?? null,
  };
}

/**
 * Build /api/spend-daily response.
 */
function spendDaily(data) {
  return (data || []).map(d => ({
    date: d.date ?? '',
    o: d.o ?? 0,
    h: d.h ?? 0,
    l: d.l ?? 0,
    c: d.c ?? 0,
    spend: d.spend ?? 0,
    cac: d.cac ?? 0,
    orders: d.orders ?? 0,
  }));
}

/**
 * Build /api/reconciliation response.
 */
function reconciliation({ ready, matchWindowMinutes, summary, daily, matches, unmatchedSettlements, unmatchedImwebPayments }) {
  return {
    apiVersion: API_VERSION,
    ready: ready ?? false,
    matchWindowMinutes: matchWindowMinutes ?? 0,
    summary: summary ?? {},
    daily: daily ?? [],
    matches: matches ?? [],
    unmatchedSettlements: unmatchedSettlements ?? [],
    unmatchedImwebPayments: unmatchedImwebPayments ?? [],
  };
}

/**
 * Build /api/postmortem response.
 */
function postmortem({ active, inactive, noData, lessonsSummary, totals, windowKey, windowDays }) {
  return {
    apiVersion: API_VERSION,
    windowKey: windowKey ?? '14d',
    windowDays: windowDays ?? 14,
    active: active ?? [],
    inactive: inactive ?? [],
    noData: noData ?? [],
    lessonsSummary: lessonsSummary ?? {},
    totals: {
      activeCount: totals?.activeCount ?? 0,
      inactiveWithData: totals?.inactiveWithData ?? 0,
      inactiveNoData: totals?.inactiveNoData ?? 0,
      totalAds: totals?.totalAds ?? 0,
    },
  };
}

/**
 * Build /api/settings response.
 */
function settings({ rules, scheduler, meta, imweb, telegram, sources, currency, cogs }) {
  return {
    apiVersion: API_VERSION,
    rules: rules ?? {},
    scheduler: scheduler ?? {},
    meta: meta ?? {},
    imweb: imweb ?? {},
    cogs: cogs ?? {},
    telegram: telegram ?? {},
    sources: sources ?? {},
    currency: currency ?? {},
  };
}

/**
 * Build /api/snapshots list response.
 */
function snapshotsList(snapshots) {
  return {
    apiVersion: API_VERSION,
    snapshots: snapshots ?? [],
  };
}

/**
 * Build /api/snapshots/:scanId response.
 */
function snapshotDetail(data) {
  return {
    apiVersion: API_VERSION,
    ...data,
  };
}

module.exports = {
  API_VERSION,
  overview,
  overviewNotReady,
  analytics,
  calendarAnalysis,
  campaigns,
  livePerformance,
  scans,
  spendDaily,
  reconciliation,
  postmortem,
  settings,
  snapshotsList,
  snapshotDetail,
};
