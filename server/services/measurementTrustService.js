function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSource(source = {}) {
  return {
    status: source?.status ?? 'unknown',
    stale: Boolean(source?.stale),
    hasData: Boolean(source?.hasData),
    lastError: source?.lastError ?? null,
  };
}

function compactSourceIssue(name, source) {
  return {
    name,
    status: source.status,
    stale: source.stale,
    hasData: source.hasData,
    lastError: source.lastError,
  };
}

function buildMeasurementTrust({
  sourceHealth = {},
  revenueSource = null,
  campaignEconomicsSummary = null,
  profitContext = null,
} = {}) {
  const imweb = normalizeSource(sourceHealth?.imweb);
  const cogs = normalizeSource(sourceHealth?.cogs);
  const metaInsights = normalizeSource(sourceHealth?.metaInsights);
  const summaryCoverageRatio = asNumber(campaignEconomicsSummary?.coverageRatio, 0);
  const summaryConfidence = campaignEconomicsSummary?.confidence ?? 'low';
  const profitCoverageRatio = asNumber(profitContext?.coverageRatio, 0);
  const hasReliableCoverage = Boolean(
    profitContext?.hasReliableCoverage
    || campaignEconomicsSummary?.hasReliableCoverage
  );
  const hasFreshRevenue = revenueSource?.status === 'connected' && !revenueSource?.stale;

  const blockingIssues = [];
  const cautionIssues = [];
  const degradedSources = [];

  if (metaInsights.status === 'error') {
    degradedSources.push(compactSourceIssue('Meta insights', metaInsights));
    blockingIssues.push('Meta insights are unavailable');
  } else if (metaInsights.stale) {
    degradedSources.push(compactSourceIssue('Meta insights', metaInsights));
    cautionIssues.push('Meta insights are stale');
  }

  if (!hasFreshRevenue || imweb.status === 'error') {
    degradedSources.push(compactSourceIssue('Imweb', imweb));
    blockingIssues.push('Fresh revenue data is unavailable');
  } else if (imweb.stale) {
    degradedSources.push(compactSourceIssue('Imweb', imweb));
    cautionIssues.push('Revenue data is cached');
  }

  if (cogs.status === 'error' || !cogs.hasData) {
    degradedSources.push(compactSourceIssue('Google Sheets COGS', cogs));
    blockingIssues.push('COGS source health is degraded');
  } else if (cogs.stale) {
    degradedSources.push(compactSourceIssue('Google Sheets COGS', cogs));
    cautionIssues.push('COGS data is cached');
  }

  if (!hasReliableCoverage && summaryConfidence === 'low') {
    blockingIssues.push('Attributable profit coverage is too weak to trust budget changes');
  } else if (!hasReliableCoverage || profitCoverageRatio < 0.8 || summaryCoverageRatio < 0.8) {
    cautionIssues.push('Profit coverage is directional rather than decision-grade');
  }

  const level = blockingIssues.length > 0
    ? 'low'
    : cautionIssues.length > 0
    ? 'medium'
    : 'high';

  const label = level === 'high'
    ? 'Decision-grade'
    : level === 'medium'
    ? 'Directional only'
    : 'Freeze budget changes';

  const reason = blockingIssues[0]
    || cautionIssues[0]
    || 'Measurement inputs are healthy enough for budget decisions';

  return {
    level,
    label,
    shouldFreezeBudgetChanges: blockingIssues.length > 0,
    canScale: blockingIssues.length === 0,
    shouldProceedWithBudgetChanges: blockingIssues.length === 0,
    hasReliableCoverage,
    hasFreshRevenue,
    coverageRatio: Number(Math.max(summaryCoverageRatio, profitCoverageRatio).toFixed(3)),
    confidence: summaryConfidence,
    reason,
    blockingIssues,
    cautionIssues,
    degradedSources,
  };
}

module.exports = {
  buildMeasurementTrust,
};
