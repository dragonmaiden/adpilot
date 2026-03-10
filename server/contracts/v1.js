// ═══════════════════════════════════════════════════════
// AdPilot — API Response Contracts v1
// Every endpoint returns one clean, versioned shape.
// No raw Meta/Imweb shapes leak to the UI.
// ═══════════════════════════════════════════════════════

const API_VERSION = 'v1';

/**
 * Build /api/overview response.
 */
function overview({ kpis, days, campaigns, charts, scanStats, lastScan, isScanning }) {
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
function analytics({ charts, revenueData, dailyInsights, adSetInsights, adInsights, cogsData, monthlyRates }) {
  return {
    apiVersion: API_VERSION,
    charts: {
      dailyMerged: charts.dailyMerged ?? [],
      hourlyOrders: charts.hourlyOrders ?? [],
      weekdayPerf: charts.weekdayPerf ?? [],
      weeklyAgg: charts.weeklyAgg ?? [],
      monthlyRefunds: charts.monthlyRefunds ?? [],
      dailyProfit: charts.dailyProfit ?? [],
    },
    // Flat metrics for non-chart consumers
    refundRate: revenueData?.refundRate ?? 0,
    cancelRate: revenueData?.cancelRate ?? 0,
    totalRefunded: revenueData?.totalRefunded ?? 0,
    totalRevenue: revenueData?.totalRevenue ?? 0,
    netRevenue: revenueData?.netRevenue ?? 0,
    totalOrders: revenueData?.totalOrders ?? 0,
    // Per-month refund rates
    febRefundRate: monthlyRates?.['2026-02'] ?? null,
    marRefundRate: monthlyRates?.['2026-03'] ?? null,
    monthlyRates: monthlyRates ?? {},
    // COGS data from Google Sheets
    totalCOGS: cogsData?.totalCOGS ?? 0,
    totalShipping: cogsData?.totalShipping ?? 0,
    cogsItems: cogsData?.itemCount ?? 0,
    cogsOrders: cogsData?.orderCount ?? 0,
    // Raw insight rows (campaigns may still need them for tables)
    dailyInsights: dailyInsights ?? [],
    adSetInsights: adSetInsights ?? [],
    adInsights: adInsights ?? [],
  };
}

/**
 * Build /api/campaigns response.
 */
function campaigns({ campaigns: enriched }) {
  return {
    apiVersion: API_VERSION,
    campaigns: (enriched || []).map(c => ({
      id: c.id ?? '',
      name: c.name ?? '',
      status: c.status ?? 'UNKNOWN',
      effective_status: c.effective_status ?? c.status ?? 'UNKNOWN',
      daily_budget: c.daily_budget ?? null,
      objective: c.objective ?? '',
      bid_strategy: c.bid_strategy ?? '',
      metrics7d: {
        spend: c.metrics7d?.spend ?? 0,
        purchases: c.metrics7d?.purchases ?? 0,
        cpa: c.metrics7d?.cpa ?? null,
        clicks: c.metrics7d?.clicks ?? 0,
        impressions: c.metrics7d?.impressions ?? 0,
        ctr: c.metrics7d?.ctr ?? 0,
      },
    })),
  };
}

/**
 * Build /api/optimizations response.
 */
function optimizations({ total, showing, optimizations: opts, stats }) {
  return {
    apiVersion: API_VERSION,
    total: total ?? 0,
    showing: showing ?? 0,
    optimizations: (opts || []).map(o => ({
      id: o.id ?? '',
      type: o.type ?? '',
      priority: o.priority ?? 'low',
      action: o.action ?? '',
      reason: o.reason ?? '',
      impact: o.impact ?? '',
      targetName: o.targetName ?? '',
      executed: o.executed ?? false,
      timestamp: o.timestamp ?? null,
      scanId: o.scanId ?? null,
    })),
    stats: {
      byType: stats?.byType ?? {},
      byPriority: stats?.byPriority ?? {},
      executed: stats?.executed ?? 0,
      pending: stats?.pending ?? 0,
    },
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
 * Build /api/postmortem response.
 */
function postmortem({ active, inactive, noData, lessonsSummary, totals }) {
  return {
    apiVersion: API_VERSION,
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
 * Build /api/optimizations/timeline response.
 */
function optimizationTimeline({ timeline, scanTimeline, totalOptimizations, totalScans }) {
  return {
    apiVersion: API_VERSION,
    timeline: timeline ?? [],
    scanTimeline: scanTimeline ?? [],
    totalOptimizations: totalOptimizations ?? 0,
    totalScans: totalScans ?? 0,
  };
}

/**
 * Build /api/settings response.
 */
function settings({ rules, scheduler, meta, imweb }) {
  return {
    apiVersion: API_VERSION,
    rules: rules ?? {},
    scheduler: scheduler ?? {},
    meta: meta ?? {},
    imweb: imweb ?? {},
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
  campaigns,
  optimizations,
  scans,
  spendDaily,
  postmortem,
  optimizationTimeline,
  settings,
  snapshotsList,
  snapshotDetail,
};
