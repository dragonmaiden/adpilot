const scheduler = require('../modules/scheduler');
const runtimeSettings = require('../runtime/runtimeSettings');
const contracts = require('../contracts/v1');
const overviewService = require('./overviewService');
const analyticsService = require('./analyticsService');
const campaignService = require('./campaignService');
const optimizationService = require('./optimizationService');
const { isOpenApprovalStatus } = require('../domain/optimizationSemantics');

const ACTIVE_ALERT_MAX_AGE_MS = 36 * 60 * 60 * 1000;

function compactSource(source = {}) {
  return {
    status: source.status ?? 'unknown',
    stale: source.stale ?? false,
    hasData: source.hasData ?? false,
    lastSuccessAt: source.lastSuccessAt ?? null,
    lastError: source.lastError ?? null,
  };
}

function toCampaignSnapshot(campaign) {
  return {
    id: campaign.id ?? '',
    name: campaign.name ?? '',
    status: campaign.status ?? 'UNKNOWN',
    spend: Number(campaign.metricsWindow?.spend ?? 0),
    purchases: Number(campaign.metricsWindow?.attributedPurchases ?? campaign.metricsWindow?.metaPurchases ?? 0),
    cpa: Number(campaign.metricsWindow?.cpa ?? 0) || null,
    ctr: Number(campaign.metricsWindow?.ctr ?? 0),
  };
}

function sortBySpend(left, right) {
  return right.spend - left.spend;
}

function sortByStrength(left, right) {
  const leftCpa = left.cpa ?? Number.POSITIVE_INFINITY;
  const rightCpa = right.cpa ?? Number.POSITIVE_INFINITY;
  if (leftCpa !== rightCpa) return leftCpa - rightCpa;
  if (left.purchases !== right.purchases) return right.purchases - left.purchases;
  return right.spend - left.spend;
}

function sortByWeakness(left, right) {
  const leftNoPurchases = left.purchases <= 0 ? 1 : 0;
  const rightNoPurchases = right.purchases <= 0 ? 1 : 0;
  if (leftNoPurchases !== rightNoPurchases) return rightNoPurchases - leftNoPurchases;

  const leftCpa = left.cpa ?? Number.NEGATIVE_INFINITY;
  const rightCpa = right.cpa ?? Number.NEGATIVE_INFINITY;
  if (leftCpa !== rightCpa) return rightCpa - leftCpa;
  return right.spend - left.spend;
}

function summarizeOptimization(opt) {
  return {
    id: opt.id ?? '',
    type: opt.type ?? '',
    priority: opt.priority ?? 'low',
    status: opt.status ?? 'unknown',
    targetName: opt.targetName ?? '',
    action: opt.action ?? '',
    reason: opt.reason ?? '',
    impact: opt.impact ?? '',
    timestamp: opt.timestamp ?? null,
  };
}

function normalizeCoverageConfidence(rawConfidence) {
  if (rawConfidence && typeof rawConfidence === 'object') {
    return {
      level: rawConfidence.level ?? 'unknown',
      label: rawConfidence.label ?? 'Unknown confidence',
      color: rawConfidence.color ?? null,
    };
  }

  const level = typeof rawConfidence === 'string' ? rawConfidence : 'unknown';
  const label = level === 'high'
    ? 'High confidence'
    : level === 'medium'
    ? 'Medium confidence'
    : level === 'low'
    ? 'Low confidence'
    : 'Unknown confidence';

  return {
    level,
    label,
    color: null,
  };
}

function isFreshAlert(opt, now = Date.now()) {
  const timestampMs = new Date(opt?.timestamp || 0).getTime();
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return false;
  return (now - timestampMs) <= ACTIVE_ALERT_MAX_AGE_MS;
}

function getSchedulerDiagnostics(settings) {
  if (typeof runtimeSettings.getSchedulerDiagnostics === 'function') {
    return runtimeSettings.getSchedulerDiagnostics();
  }

  return {
    scanIntervalMinutes: settings.scheduler?.scanIntervalMinutes ?? null,
    configuredScanIntervalMinutes: settings.scheduler?.scanIntervalMinutes ?? null,
    driftDetected: false,
    intervalSource: 'unknown',
  };
}

function buildScanSection(overview, settings) {
  const schedulerDiagnostics = getSchedulerDiagnostics(settings);
  return {
    lastScan: overview.lastScan ?? null,
    nextScan: scheduler.getNextScheduledRunAt()?.toISOString() ?? null,
    isScanning: overview.isScanning ?? false,
    intervalMinutes: schedulerDiagnostics.scanIntervalMinutes ?? settings.scheduler?.scanIntervalMinutes ?? null,
    configuredIntervalMinutes: schedulerDiagnostics.configuredScanIntervalMinutes ?? null,
    intervalDriftDetected: schedulerDiagnostics.driftDetected ?? false,
    intervalSource: schedulerDiagnostics.intervalSource ?? null,
    autonomousMode: settings.rules?.autonomousMode ?? false,
    activeCampaigns: Number(overview.scanStats?.activeCampaigns ?? 0),
    activeAds: Number(overview.scanStats?.activeAds ?? 0),
    activeAdSets: Number(overview.scanStats?.activeAdSets ?? 0),
  };
}

async function getOperatorSummaryResponse() {
  const settings = runtimeSettings.getSettings();
  const latestData = scheduler.getLatestData();
  const sourceHealth = scheduler.getSourceHealth();
  const overview = await overviewService.getOverviewResponse();

  if (!overview?.ready) {
    return contracts.operatorSummary({
      ready: false,
      generatedAt: new Date().toISOString(),
      objective: 'Maximize profitable growth while keeping execution approval-gated.',
      scan: buildScanSection(overview || {}, settings),
      sources: {
        metaStructure: compactSource(sourceHealth.metaStructure),
        metaInsights: compactSource(sourceHealth.metaInsights),
        imweb: compactSource(sourceHealth.imweb),
        cogs: compactSource(sourceHealth.cogs),
      },
      notes: [
        'No completed scan is available yet.',
        'Use /api/health for basic liveness and wait for the first scan to finish.',
      ],
      links: {
        health: '/api/health',
        overview: '/api/overview',
        analytics: '/api/analytics',
        campaigns: '/api/campaigns?days=7d',
        optimizations: '/api/optimizations?limit=20',
        settings: '/api/settings',
      },
    });
  }

  const analytics = analyticsService.getAnalyticsResponse();
  const campaignsResponse = campaignService.getEnrichedCampaigns({ days: '7d' });
  const optimizationsResponse = optimizationService.getOptimizationsResponse({ limit: '200' });

  const campaignSnapshots = (campaignsResponse.campaigns || []).map(toCampaignSnapshot);
  const nowMs = Date.now();
  const pendingApprovals = (optimizationsResponse.optimizations || [])
    .filter(opt => isOpenApprovalStatus(opt.status))
    .slice(0, 5)
    .map(summarizeOptimization);
  const activeAlerts = (optimizationsResponse.optimizations || [])
    .filter(opt =>
      opt.status === 'advisory'
      && ['high', 'critical'].includes(String(opt.priority || '').toLowerCase())
      && isFreshAlert(opt, nowMs)
    )
    .slice(0, 5)
    .map(summarizeOptimization);

  const cogs = latestData.cogsData || {};
  const validation = cogs.validation || {};
  const todaySummary = analytics.profitAnalysis?.todaySummary || null;
  const runRate = analytics.profitAnalysis?.runRate || null;
  const coverage = analytics.profitAnalysis?.coverage || {};
  const normalizedCoverageConfidence = normalizeCoverageConfidence(coverage.confidence);

  return contracts.operatorSummary({
    ready: true,
    generatedAt: new Date().toISOString(),
    objective: 'Maximize profitable growth while keeping execution approval-gated.',
    scan: buildScanSection(overview, settings),
    sources: {
      metaStructure: compactSource(sourceHealth.metaStructure),
      metaInsights: compactSource(sourceHealth.metaInsights),
      imweb: compactSource(sourceHealth.imweb),
      cogs: compactSource(sourceHealth.cogs),
    },
    kpis: {
      revenue: overview.kpis?.revenue ?? 0,
      netRevenue: overview.kpis?.netRevenue ?? 0,
      refunded: overview.kpis?.refunded ?? 0,
      refundRate: overview.kpis?.refundRate ?? 0,
      cancelRate: overview.kpis?.cancelRate ?? 0,
      adSpend: overview.kpis?.adSpend ?? 0,
      adSpendKRW: overview.kpis?.adSpendKRW ?? 0,
      purchases: overview.kpis?.purchases ?? 0,
      cpa: overview.kpis?.cpa ?? 0,
      ctr: overview.kpis?.ctr ?? 0,
      roas: overview.kpis?.roas ?? 0,
      grossProfit: overview.kpis?.grossProfit ?? 0,
      grossMargin: overview.kpis?.grossMargin ?? 0,
      aov: overview.kpis?.aov ?? 0,
      cogs: overview.kpis?.cogs ?? 0,
      cogsRate: overview.kpis?.cogsRate ?? 0,
    },
    profit: {
      todaySummary,
      runRate,
      coverage: {
        coverageRatio: Number(coverage.coverageRatio ?? 0),
        coverageScore: Number(coverage.coverageScore ?? coverage.coverageWeight ?? 0),
        totalDays: Number(coverage.totalDays ?? 0),
        hasReliableCoverage: coverage.hasReliableCoverage ?? false,
        confidence: normalizedCoverageConfidence.level,
        confidenceLabel: normalizedCoverageConfidence.label,
        confidenceColor: normalizedCoverageConfidence.color,
      },
    },
    campaigns: {
      windowKey: campaignsResponse.windowKey ?? '7d',
      activeCount: campaignSnapshots.filter(campaign => String(campaign.status || '').toUpperCase() === 'ACTIVE').length,
      topSpenders: campaignSnapshots.slice().sort(sortBySpend).slice(0, 5),
      strongest: campaignSnapshots
        .filter(campaign => campaign.purchases > 0)
        .sort(sortByStrength)
        .slice(0, 5),
      weakest: campaignSnapshots
        .filter(campaign => campaign.spend > 0)
        .sort(sortByWeakness)
        .slice(0, 5),
    },
    optimizations: {
      pendingApprovals,
      activeAlerts,
      stats: optimizationsResponse.stats ?? {},
    },
    operations: {
      orderSyncMode: 'scan_polling_primary_with_webhook_support',
      sheets: Array.isArray(cogs.sheets) ? cogs.sheets : [],
      purchaseCount: cogs.purchaseCount ?? 0,
      itemCount: cogs.itemCount ?? 0,
      incompletePurchaseCount: cogs.incompletePurchaseCount ?? 0,
      missingCostItemCount: cogs.missingCostItemCount ?? 0,
      validation: {
        rowsWithWarnings: validation.rowsWithWarnings ?? 0,
        missingValueRows: validation.missingValueRows ?? 0,
        malformedOrderNumberRows: validation.malformedOrderNumberRows ?? 0,
        samples: Array.isArray(validation.samples) ? validation.samples.slice(0, 5) : [],
      },
    },
    notes: [
      'Use this summary as the primary read-only operator brief.',
      'If deeper detail is needed, drill into the linked read-only endpoints.',
      'Execution remains approval-gated in AdPilot and handled by the separate ops bot.',
    ],
    links: {
      health: '/api/health',
      overview: '/api/overview',
      analytics: '/api/analytics',
      campaigns: '/api/campaigns?days=7d',
      optimizations: '/api/optimizations?limit=20',
      timeline: '/api/optimizations/timeline',
      calendar: '/api/calendar-analysis',
      reconciliation: '/api/reconciliation',
      settings: '/api/settings',
    },
  });
}

module.exports = {
  getOperatorSummaryResponse,
};
