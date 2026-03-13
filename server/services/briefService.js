const contracts = require('../contracts/v1');
const operatorSummaryService = require('./operatorSummaryService');

function roundMoney(value) {
  return Math.round(Number(value || 0));
}

function compactOptimization(opt = {}) {
  return {
    id: opt.id ?? '',
    type: opt.type ?? '',
    priority: opt.priority ?? 'low',
    targetName: opt.targetName ?? '',
    action: opt.action ?? '',
    reason: opt.reason ?? '',
    impact: opt.impact ?? '',
  };
}

function buildHeadline(summary) {
  const grossProfit = Number(summary?.kpis?.grossProfit || 0);
  const grossMargin = Number(summary?.kpis?.grossMargin || 0);
  const roas = Number(summary?.kpis?.roas || 0);

  if (grossProfit > 0) {
    return `7d gross profit is ₩${roundMoney(grossProfit).toLocaleString()} at ${grossMargin.toFixed(1)}% margin with ${roas.toFixed(2)}x ROAS.`;
  }

  if (grossProfit < 0) {
    return `7d gross profit is negative at -₩${Math.abs(roundMoney(grossProfit)).toLocaleString()} with ${roas.toFixed(2)}x ROAS.`;
  }

  return '7d profit signal is neutral or incomplete.';
}

function getDegradedSources(summary) {
  return Object.entries(summary?.sources || {})
    .filter(([, source]) => source?.status !== 'connected' || source?.stale)
    .map(([key, source]) => ({
      key,
      status: source?.status || 'unknown',
      stale: Boolean(source?.stale),
      lastError: source?.lastError || null,
    }));
}

function buildSignals(summary) {
  const signals = [];
  const degradedSources = getDegradedSources(summary);
  const pendingApprovals = summary?.optimizations?.pendingApprovals || [];
  const activeAlerts = summary?.optimizations?.activeAlerts || [];
  const operations = summary?.operations || {};
  const campaigns = summary?.campaigns || {};
  const profit = summary?.profit || {};

  if (degradedSources.length > 0) {
    const names = degradedSources.map(source => source.key).join(', ');
    signals.push({
      type: 'source_health',
      priority: 'critical',
      title: 'Source health degraded',
      summary: `${names} ${degradedSources.length === 1 ? 'is' : 'are'} not fully healthy, so business interpretation confidence is lower.`,
      nextMove: 'Treat scaling and profit interpretation conservatively until source health is restored.',
      confidence: 'high',
      details: degradedSources,
    });
  }

  if (pendingApprovals.length > 0) {
    const topPending = pendingApprovals[0];
    signals.push({
      type: 'pending_approval',
      priority: topPending.priority || 'medium',
      title: 'Approval waiting',
      summary: topPending.action || 'A commercially relevant approval is waiting.',
      nextMove: topPending.reason || 'Review the approval path before the next scan cycle.',
      confidence: 'high',
      details: compactOptimization(topPending),
    });
  }

  if (activeAlerts.length > 0) {
    const topAlert = activeAlerts[0];
    signals.push({
      type: 'active_alert',
      priority: topAlert.priority || 'high',
      title: 'High-priority operator alert',
      summary: topAlert.action || 'A high-priority advisory issue is active.',
      nextMove: topAlert.reason || topAlert.impact || 'Review this issue in the dashboard before it compounds.',
      confidence: 'medium',
      details: compactOptimization(topAlert),
    });
  }

  const missingCost = Number(operations.missingCostItemCount || 0);
  const incompletePurchases = Number(operations.incompletePurchaseCount || 0);
  const warningRows = Number(operations.validation?.rowsWithWarnings || 0);
  if (missingCost > 0 || incompletePurchases > 0 || warningRows > 0) {
    signals.push({
      type: 'cogs_quality',
      priority: 'medium',
      title: 'COGS quality caveat',
      summary: `${missingCost} missing-cost item${missingCost === 1 ? '' : 's'}, ${incompletePurchases} incomplete purchase${incompletePurchases === 1 ? '' : 's'}, ${warningRows} warning row${warningRows === 1 ? '' : 's'}.`,
      nextMove: 'Clear the newest COGS warning rows before trusting profit and scale signals too aggressively.',
      confidence: 'high',
      details: {
        missingCostItemCount: missingCost,
        incompletePurchaseCount: incompletePurchases,
        rowsWithWarnings: warningRows,
        samples: operations.validation?.samples || [],
      },
    });
  }

  if (Number(campaigns.activeCount || 0) <= 1 && Number(summary?.kpis?.adSpend || 0) > 0) {
    signals.push({
      type: 'concentration',
      priority: 'medium',
      title: 'Account concentration risk',
      summary: `${campaigns.activeCount || 0} active campaign is carrying current spend.`,
      nextMove: 'Treat scale decisions as concentration-sensitive until creative depth or structure broadens.',
      confidence: 'medium',
      details: {
        activeCount: campaigns.activeCount || 0,
        topSpender: campaigns.topSpenders?.[0] || null,
      },
    });
  }

  if (profit?.coverage?.hasReliableCoverage === false) {
    signals.push({
      type: 'profit_confidence',
      priority: 'medium',
      title: 'Profit confidence is limited',
      summary: `Coverage confidence is ${profit?.coverage?.confidence || 'unknown'} with weight ${Number(profit?.coverage?.coverageWeight || 0).toFixed(2)}.`,
      nextMove: 'Use profit estimates as directional, not definitive, until coverage improves.',
      confidence: 'medium',
      details: profit?.coverage || {},
    });
  }

  return signals.slice(0, 5);
}

function buildNotes(summary) {
  return [
    'This brief is a thin digest of the canonical operator summary.',
    'Use /api/operator-summary for richer read-only context and drill-down links.',
    summary?.scan?.lastScan
      ? `Latest scan completed at ${summary.scan.lastScan}.`
      : 'No completed scan is available yet.',
  ];
}

function buildBriefFromSummary(summary) {
  const pendingApprovals = summary?.optimizations?.pendingApprovals || [];
  const activeAlerts = summary?.optimizations?.activeAlerts || [];

  return contracts.operatorBrief({
    ready: Boolean(summary?.ready),
    generatedAt: new Date().toISOString(),
    sourceGeneratedAt: summary?.generatedAt || null,
    objective: summary?.objective || '',
    headline: buildHeadline(summary),
    scorecard: {
      revenue: roundMoney(summary?.kpis?.revenue),
      netRevenue: roundMoney(summary?.kpis?.netRevenue),
      adSpend: Number(summary?.kpis?.adSpend || 0),
      grossProfit: roundMoney(summary?.kpis?.grossProfit),
      grossMargin: Number(summary?.kpis?.grossMargin || 0),
      roas: Number(summary?.kpis?.roas || 0),
      purchases: Number(summary?.kpis?.purchases || 0),
      cpa: Number(summary?.kpis?.cpa || 0),
    },
    scan: summary?.scan || {},
    signals: buildSignals(summary),
    approvals: {
      pendingCount: pendingApprovals.length,
      topPending: pendingApprovals.length > 0 ? compactOptimization(pendingApprovals[0]) : null,
    },
    alerts: {
      activeCount: activeAlerts.length,
      topAlert: activeAlerts.length > 0 ? compactOptimization(activeAlerts[0]) : null,
    },
    links: {
      summary: '/api/operator-summary',
      ...(summary?.links || {}),
    },
    notes: buildNotes(summary),
  });
}

async function getOperatorBriefResponse() {
  const summary = await operatorSummaryService.getOperatorSummaryResponse();
  return buildBriefFromSummary(summary);
}

module.exports = {
  buildBriefFromSummary,
  getOperatorBriefResponse,
};
