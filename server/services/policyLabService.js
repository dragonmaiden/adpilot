const scanStore = require('../modules/scanStore');
const snapshotRepository = require('../modules/snapshotRepository');
const policyLabStore = require('../modules/policyLabStore');
const runtimeSettings = require('../runtime/runtimeSettings');
const {
  buildDefaultChampionPolicy,
  evaluateBudgetSnapshot,
  createDecisionTrace,
  computeReward,
} = require('./budgetPolicyService');
const { runStructuredSearch } = require('./policyLabReplayService');
const { buildCampaignEconomics } = require('./campaignEconomicsService');
const { filterRecentInsights } = require('../domain/performanceContext');
const { summarizeInsights } = require('../domain/metrics');
const { formatDateInTimeZone } = require('../domain/time');
const observabilityService = require('./observabilityService');

const OUTCOME_WINDOWS = Object.freeze([24, 48, 72]);

function nowIso() {
  return new Date().toISOString();
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseTimestamp(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getRecentWindowStart(days, referenceDate) {
  const input = parseTimestamp(referenceDate) > 0 ? new Date(referenceDate) : new Date();
  const endDate = formatDateInTimeZone(input);
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(endMs)) return endDate;
  const start = new Date(endMs);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start.toISOString().slice(0, 10);
}

function ensureInitialized(rules = {}) {
  const policies = policyLabStore.getPolicies();
  const meta = policyLabStore.getMetaState();
  let champion = policies.find(policy => policy.id === meta.championPolicyId);

  if (!champion) {
    champion = policies.find(policy => policy.status === 'champion');
  }

  if (!champion) {
    champion = buildDefaultChampionPolicy(rules);
    policyLabStore.upsertPolicy(champion);
    policyLabStore.updateMetaState({
      championPolicyId: champion.id,
    });
  }

  return {
    championPolicy: champion,
    metaState: policyLabStore.getMetaState(),
  };
}

function getChampionPolicy(rules = {}) {
  return ensureInitialized(rules).championPolicy;
}

function getPolicies() {
  return policyLabStore.getPolicies();
}

function getActiveShadowPolicy() {
  const policies = policyLabStore.getPolicies();
  const meta = policyLabStore.getMetaState();
  if (meta.activeShadowPolicyId) {
    return policies.find(policy => policy.id === meta.activeShadowPolicyId) || null;
  }

  const fallback = policies
    .filter(policy => ['active_candidate', 'challenger', 'promotion_ready'].includes(policy.status))
    .sort((left, right) => asNumber(right.scoreSummary?.improvementRatio, 0) - asNumber(left.scoreSummary?.improvementRatio, 0));
  return fallback[0] || null;
}

function recordDecisionTraces(traces) {
  if (!Array.isArray(traces) || traces.length === 0) {
    return [];
  }

  policyLabStore.addDecisionTraces(traces);
  return traces;
}

function buildShadowTraceContext(championTrace, candidatePolicy, rules = {}) {
  const evaluation = evaluateBudgetSnapshot(championTrace.inputSnapshot, candidatePolicy, rules);
  return createDecisionTrace({
    scanId: championTrace.scanId,
    mode: 'challenger_shadow',
    policy: candidatePolicy,
    snapshot: championTrace.inputSnapshot,
    evaluation,
    strategyContext: {
      shadowAgainstPolicyId: championTrace.policyVersionId,
      championTraceId: championTrace.traceId,
    },
  });
}

function runShadowEvaluation({ scanId, championTraces, rules = {} }) {
  const candidatePolicy = getActiveShadowPolicy();
  if (!candidatePolicy || !Array.isArray(championTraces) || championTraces.length === 0) {
    return {
      candidatePolicy: candidatePolicy || null,
      challengerTraces: [],
      shadowLogs: [],
    };
  }

  const challengerTraces = championTraces.map(trace => buildShadowTraceContext(trace, candidatePolicy, rules));
  const shadowLogs = challengerTraces.map((trace, index) => {
    const championTrace = championTraces[index];
    return {
      id: `shadow_${scanId}_${index}_${Math.random().toString(36).slice(2, 8)}`,
      scanId,
      timestamp: trace.timestamp,
      championPolicyId: championTrace.policyVersionId,
      challengerPolicyId: candidatePolicy.id,
      targetId: trace.entity.targetId,
      targetName: trace.entity.targetName,
      championVerdict: championTrace.verdict,
      challengerVerdict: trace.verdict,
      diverged: championTrace.verdict !== trace.verdict,
      championTraceId: championTrace.traceId,
      challengerTraceId: trace.traceId,
      controlSurface: trace.controlSurface,
    };
  });

  policyLabStore.addDecisionTraces(challengerTraces);
  policyLabStore.addShadowDecisionLogs(shadowLogs);

  observabilityService.captureMessage(
    `Live comparison completed for ${challengerTraces.length} budget traces`,
    'info',
    {
      category: 'policy_lab.live_compare',
      title: 'Live comparison completed',
      tags: {
        challenger_policy: candidatePolicy.id,
        scan_id: scanId,
      },
      data: {
        divergenceRate: shadowLogs.length > 0
          ? shadowLogs.filter(entry => entry.diverged).length / shadowLogs.length
          : 0,
      },
    }
  );

  return {
    candidatePolicy,
    challengerTraces,
    shadowLogs,
  };
}

function seedBudgetOutcomeFromAction(action) {
  if (!action || action.type !== 'budget' || !action.executed || !action.traceId || !action.policyVersionId) {
    return null;
  }

  const existing = policyLabStore.getBudgetOutcomes().find(entry => entry.optimizationId === action.id);
  if (existing) {
    return existing;
  }

  const trace = policyLabStore.getDecisionTraces().find(entry => entry.traceId === action.traceId);
  if (!trace) return null;

  const baseline = {
    spend: asNumber(trace.inputSnapshot?.spend, 0),
    purchases: asNumber(trace.inputSnapshot?.purchases, 0),
    cpa: trace.inputSnapshot?.avgCpa == null ? null : asNumber(trace.inputSnapshot.avgCpa, null),
    estimatedTrueNetProfit: asNumber(trace.inputSnapshot?.economics?.estimatedTrueNetProfit, 0),
    coverageRatio: asNumber(trace.inputSnapshot?.economics?.coverageRatio, 0),
    confidence: trace.inputSnapshot?.economics?.confidence ?? 'low',
  };

  const actionPercent = asNumber(action.decisionActionPercent || action.traceActionPercent || action.actionPercent, 0);
  const outcome = {
    id: `outcome_${action.id}`,
    optimizationId: action.id,
    traceId: action.traceId,
    policyVersionId: action.policyVersionId,
    controlSurface: action.controlSurface || trace.controlSurface,
    targetId: action.targetId,
    targetName: action.targetName,
    targetLevel: action.level,
    verdict: action.decisionVerdict || trace.verdict,
    actionPercent,
    executedAt: nowIso(),
    baseline,
    snapshots: {
      h24: null,
      h48: null,
      h72: null,
    },
    reversalDetected: false,
    churnCount: 0,
    finalReward: null,
    status: 'pending',
    lastEvaluatedAt: null,
  };

  policyLabStore.addBudgetOutcome(outcome);
  return outcome;
}

function pickOutcomeSnapshotDate(outcome, windowHours) {
  const targetMs = parseTimestamp(outcome.executedAt) + (windowHours * 60 * 60 * 1000);
  const snapshots = snapshotRepository.getSnapshotsList();
  return snapshots
    .filter(snapshot => parseTimestamp(snapshot.timestamp) >= targetMs)
    .sort((left, right) => parseTimestamp(left.timestamp) - parseTimestamp(right.timestamp))[0] || null;
}

function buildOutcomeSnapshotForCampaign(outcome, snapshotMeta) {
  if (!snapshotMeta?.scanId) return null;
  const snapshot = snapshotRepository.getSnapshot(snapshotMeta.scanId);
  const data = snapshot?.data || {};
  const structure = data.meta_structure || {};
  const insights = data.meta_insights || {};
  const normalized = data.normalized || {};
  const referenceDate = formatDateInTimeZone(snapshotMeta.timestamp);
  const campaigns = structure.campaigns || [];
  const campaignInsights = insights.campaignInsights || [];
  const economics = buildCampaignEconomics(
    campaigns,
    campaignInsights,
    normalized.revenueData || null,
    normalized.cogsData || null,
    null,
    {
      days: 7,
      referenceDate,
      includeCurrentDay: false,
      minCoverageRatio: 0.8,
    }
  );
  const campaignEconomics = (economics.campaigns || []).find(entry => String(entry.campaignId) === String(outcome.targetId));
  const rows = filterRecentInsights(campaignInsights, 'campaign_id', outcome.targetId, 7, referenceDate, {
    includeCurrentDay: false,
  });
  const totals = summarizeInsights(rows);
  const baselineSpend = asNumber(outcome.baseline?.spend, 0);
  const volatilityScore = baselineSpend > 0 ? Math.abs(asNumber(totals.spend, 0) - baselineSpend) / baselineSpend : 0;
  const confidencePenalty = (
    campaignEconomics?.confidence === 'low'
      ? 25000
      : campaignEconomics?.confidence === 'medium'
      ? 10000
      : 0
  );

  return {
    snapshotScanId: snapshotMeta.scanId,
    snapshotAt: snapshotMeta.timestamp,
    spend: asNumber(totals.spend, 0),
    purchases: asNumber(totals.purchases, 0),
    cpa: totals.cpa == null ? null : asNumber(totals.cpa, null),
    estimatedTrueNetProfit: asNumber(campaignEconomics?.estimatedTrueNetProfit, 0),
    estimatedRevenue: asNumber(campaignEconomics?.estimatedRevenue, 0),
    coverageRatio: asNumber(campaignEconomics?.coverageRatio, 0),
    confidence: campaignEconomics?.confidence ?? 'low',
    volatilityScore,
    confidencePenalty,
  };
}

function refreshBudgetOutcomes() {
  const outcomes = policyLabStore.getBudgetOutcomes();
  if (outcomes.length === 0) {
    return [];
  }

  const championPolicy = getChampionPolicy(runtimeSettings.getRules());

  for (const outcome of outcomes) {
    if (outcome.status === 'complete') continue;
    if (outcome.targetLevel !== 'campaign') continue;

    for (const windowHours of OUTCOME_WINDOWS) {
      const key = `h${windowHours}`;
      if (outcome.snapshots?.[key]) continue;
      const snapshotMeta = pickOutcomeSnapshotDate(outcome, windowHours);
      if (!snapshotMeta) continue;

      const snapshotPayload = buildOutcomeSnapshotForCampaign(outcome, snapshotMeta);
      if (!snapshotPayload) continue;

      policyLabStore.updateBudgetOutcome(outcome.id, current => ({
        snapshots: {
          ...(current.snapshots || {}),
          [key]: snapshotPayload,
        },
        lastEvaluatedAt: nowIso(),
      }));
    }

    const refreshed = policyLabStore.getBudgetOutcomes().find(entry => entry.id === outcome.id);
    if (refreshed?.snapshots?.h72 && !refreshed.finalReward) {
      const reward = computeReward({
        baseline: refreshed.baseline,
        horizon: refreshed.snapshots.h72,
        policy: championPolicy,
        reversalDetected: refreshed.reversalDetected,
        churnCount: refreshed.churnCount,
      });
      policyLabStore.updateBudgetOutcome(outcome.id, {
        finalReward: reward,
        status: 'complete',
        lastEvaluatedAt: nowIso(),
      });
    }
  }

  return policyLabStore.getBudgetOutcomes();
}

function createExperimentMarkers(experiments) {
  return (Array.isArray(experiments) ? experiments : [])
    .slice()
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')))
    .map(experiment => ({
      date: String(experiment.createdAt || '').slice(0, 10),
      kind: experiment.status === 'promotion_ready' ? 'promoted' : 'challenger',
      title: experiment.status === 'promotion_ready' ? 'Promotion-ready challenger' : 'Challenger evaluated',
      detail: experiment.replaySummary?.sampleSize
        ? `${experiment.replaySummary.sampleSize} ${experiment.scoreMode === 'bootstrap_proxy' ? 'bootstrap' : 'replay'} samples · ${(asNumber(experiment.replaySummary.improvementRatio, 0) * 100).toFixed(1)}% improvement`
        : 'Insufficient replay data',
      count: 1,
    }));
}

function buildMetricsProgression(experiments, outcomes, shadowLogs, optimizations) {
  const rewardTrend = (Array.isArray(outcomes) ? outcomes : [])
    .filter(outcome => outcome?.status === 'complete' && outcome?.finalReward)
    .map(outcome => ({
      date: String(outcome.lastEvaluatedAt || outcome.executedAt || '').slice(0, 10),
      reward: asNumber(outcome.finalReward?.total, 0),
      realizedProfitDelta: asNumber(outcome.finalReward?.realizedProfitDelta, 0),
    }))
    .slice(-20);

  const candidateTrend = (Array.isArray(experiments) ? experiments : [])
    .map(experiment => ({
      date: String(experiment.createdAt || '').slice(0, 10),
      improvementRatio: asNumber(experiment.replaySummary?.improvementRatio, 0),
      approvalLoadRatio: asNumber(experiment.replaySummary?.approvalLoadRatio, 0),
    }))
    .slice(-20);

  const divergenceRate = (Array.isArray(shadowLogs) ? shadowLogs : []).length > 0
    ? (shadowLogs.filter(entry => entry.diverged).length / shadowLogs.length)
    : 0;
  const approvalFriction = (Array.isArray(optimizations) ? optimizations : []).filter(opt =>
    ['expired', 'rejected'].includes(String(opt.approvalStatus || '').toLowerCase())
  ).length;

  return {
    rewardTrend,
    candidateTrend,
    summary: {
      completedOutcomeCount: rewardTrend.length,
      totalReward: rewardTrend.reduce((sum, row) => sum + asNumber(row.reward, 0), 0),
      totalProfitDelta: rewardTrend.reduce((sum, row) => sum + asNumber(row.realizedProfitDelta, 0), 0),
      shadowDivergenceRate: Number(divergenceRate.toFixed(3)),
      approvalFriction,
    },
  };
}

function buildTraceFilters(traces) {
  return {
    policyIds: Array.from(new Set(traces.map(trace => trace.policyVersionId).filter(Boolean))).sort(),
    verdicts: Array.from(new Set(traces.map(trace => trace.verdict).filter(Boolean))).sort(),
    controlSurfaces: Array.from(new Set(traces.map(trace => trace.controlSurface).filter(Boolean))).sort(),
    targets: Array.from(new Set(traces.map(trace => trace.entity?.targetName).filter(Boolean))).sort().slice(0, 50),
  };
}

function getPolicyLabResponse() {
  ensureInitialized(runtimeSettings.getRules());
  refreshBudgetOutcomes();
  const traces = policyLabStore.getDecisionTraces()
    .slice()
    .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')));
  const experiments = policyLabStore.getExperiments()
    .slice()
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
  const outcomes = policyLabStore.getBudgetOutcomes()
    .slice()
    .sort((left, right) => String(right.executedAt || '').localeCompare(String(left.executedAt || '')));
  const shadowLogs = policyLabStore.getShadowDecisionLog()
    .slice()
    .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')));
  const observability = policyLabStore.getObservabilityEvents()
    .slice()
    .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')));
  const policies = policyLabStore.getPolicies();
  const meta = policyLabStore.getMetaState();
  const recommendationQualityService = require('./recommendationQualityService');
  const qualitySummary = recommendationQualityService.getRecommendationQualityResponse().summary || {};
  const championPolicy = policies.find(policy => policy.id === meta.championPolicyId) || getChampionPolicy(runtimeSettings.getRules());
  const activeShadow = getActiveShadowPolicy();
  const metrics = buildMetricsProgression(experiments, outcomes, shadowLogs, scanStore.getAllOptimizations());

  return {
    generatedAt: nowIso(),
    summary: {
      championPolicyId: championPolicy?.id || null,
      championPolicyLabel: championPolicy?.label || null,
      challengerCount: policies.filter(policy => ['active_candidate', 'challenger', 'promotion_ready'].includes(policy.status)).length,
      promotionReadyCount: policies.filter(policy => policy.status === 'promotion_ready').length,
      activeCandidateCount: policies.filter(policy => policy.status === 'active_candidate').length,
      lastResearchRunAt: meta.lastResearchRunAt || null,
      shadowDivergenceRate: metrics.summary.shadowDivergenceRate,
      liveDivergenceRate: metrics.summary.shadowDivergenceRate,
      sentryStatus: observabilityService.getStatus(),
      completedOutcomeCount: outcomes.filter(outcome => outcome.status === 'complete').length,
      decisionTraceCount: traces.length,
      activeShadowPolicyId: activeShadow?.id || null,
      activeShadowPolicyLabel: activeShadow?.label || null,
      activeLearningPolicyId: activeShadow?.id || null,
      activeLearningPolicyLabel: activeShadow?.label || null,
      evaluationMode: meta.lastResearchSummary?.scoreMode || null,
      replaySampleSize: asNumber(meta.lastResearchSummary?.replaySampleSize, 0),
    },
    learningLoop: {
      championPolicy,
      activeShadowPolicy: activeShadow,
      activeLearningPolicy: activeShadow,
      lastResearchSummary: meta.lastResearchSummary || null,
    },
    strategyMarkers: createExperimentMarkers(experiments).slice(-20),
    tracesPreview: traces.slice(0, 20),
    experimentsPreview: experiments.slice(0, 12),
    outcomesPreview: outcomes.slice(0, 12),
    metrics,
    qualitySummary,
    observability: {
      status: observabilityService.getStatus(),
      recent: observability.slice(0, 12),
    },
    traceFilters: buildTraceFilters(traces),
  };
}

function getExperimentsResponse() {
  return {
    generatedAt: nowIso(),
    experiments: policyLabStore.getExperiments()
      .slice()
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || ''))),
  };
}

function getTracesResponse() {
  const traces = policyLabStore.getDecisionTraces()
    .slice()
    .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')));
  const optimizationsById = new Map(scanStore.getAllOptimizations().map(opt => [opt.id, opt]));

  return {
    generatedAt: nowIso(),
    filters: buildTraceFilters(traces),
    traces: traces.map(trace => ({
      ...trace,
      optimizationStatus: trace.optimizationId ? optimizationsById.get(trace.optimizationId)?.approvalStatus || null : null,
    })),
  };
}

function getOutcomesResponse() {
  refreshBudgetOutcomes();
  return {
    generatedAt: nowIso(),
    outcomes: policyLabStore.getBudgetOutcomes()
      .slice()
      .sort((left, right) => String(right.executedAt || '').localeCompare(String(left.executedAt || ''))),
  };
}

function getObservabilityResponse() {
  return {
    generatedAt: nowIso(),
    status: observabilityService.getStatus(),
    events: policyLabStore.getObservabilityEvents()
      .slice()
      .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || ''))),
  };
}

function runResearchIteration(rules = {}) {
  const { championPolicy } = ensureInitialized(rules);
  refreshBudgetOutcomes();
  const traces = policyLabStore.getDecisionTraces().filter(trace => trace.mode === 'champion');
  const outcomes = policyLabStore.getBudgetOutcomes();
  const research = runStructuredSearch({
    championPolicy,
    outcomes,
    traces,
    rules,
  });

  const policiesToUpsert = [];
  const experimentsToAdd = [];

  for (const experiment of research.experiments) {
    const existingPolicy = policyLabStore.getPolicies().find(policy => policy.id === experiment.policyId);
    const nextPolicy = existingPolicy || {
      ...championPolicy,
      id: experiment.policyId,
      label: experiment.policyId,
      parentPolicyId: championPolicy.id,
      createdAt: experiment.createdAt,
    };

    nextPolicy.status = experiment.status;
    nextPolicy.diffSummary = experiment.diffSummary;
    nextPolicy.scoreSummary = experiment.replaySummary;
    nextPolicy.summaryLine = experiment.diffSummary?.length
      ? experiment.diffSummary.slice(0, 3).map(change => `${change.path.split('.').slice(-1)[0]} ${change.from} -> ${change.to}`).join(' · ')
      : 'No parameter changes';
    policiesToUpsert.push(nextPolicy);
    experimentsToAdd.push(experiment);
  }

  const bestPolicy = policiesToUpsert
    .slice()
    .sort((left, right) => asNumber(right.scoreSummary?.improvementRatio, 0) - asNumber(left.scoreSummary?.improvementRatio, 0))[0] || null;

  if (bestPolicy && bestPolicy.status !== 'promotion_ready') {
    bestPolicy.status = 'active_candidate';
    const bestExperiment = experimentsToAdd.find(entry => entry.policyId === bestPolicy.id);
    if (bestExperiment) {
      bestExperiment.status = 'active_candidate';
    }
  }

  policiesToUpsert.forEach(policy => policyLabStore.upsertPolicy(policy));
  policyLabStore.addExperiments(experimentsToAdd);

  policyLabStore.updateMetaState({
    lastResearchRunAt: nowIso(),
    lastResearchSummary: {
      replaySampleSize: research.replaySampleSize,
      experimentCount: experimentsToAdd.length,
      bestPolicyId: bestPolicy?.id || null,
      bestImprovementRatio: asNumber(bestPolicy?.scoreSummary?.improvementRatio, 0),
      scoreMode: research.scoreMode,
    },
    activeShadowPolicyId: bestPolicy?.id || null,
  });

  observabilityService.captureMessage(
    `Policy lab evaluated ${experimentsToAdd.length} challengers`,
    'info',
    {
      category: 'policy_lab.research',
      title: 'Policy lab iteration completed',
      tags: {
        champion_policy: championPolicy.id,
        best_policy: bestPolicy?.id || 'none',
      },
      data: {
        replaySampleSize: research.replaySampleSize,
        bestImprovementRatio: asNumber(bestPolicy?.scoreSummary?.improvementRatio, 0),
        scoreMode: research.scoreMode,
      },
      source: 'policy-lab-worker',
    }
  );

  return {
    championPolicy,
    bestPolicy,
    experiments: experimentsToAdd,
    replaySampleSize: research.replaySampleSize,
    scoreMode: research.scoreMode,
  };
}

module.exports = {
  ensureInitialized,
  getChampionPolicy,
  getPolicies,
  getActiveShadowPolicy,
  recordDecisionTraces,
  runShadowEvaluation,
  seedBudgetOutcomeFromAction,
  refreshBudgetOutcomes,
  getPolicyLabResponse,
  getExperimentsResponse,
  getTracesResponse,
  getOutcomesResponse,
  getObservabilityResponse,
  runResearchIteration,
};
