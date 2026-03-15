// ═══════════════════════════════════════════════════════
// AdPilot — Business Decision Engine
// Meta owns auction delivery. AdPilot owns business judgment.
// ═══════════════════════════════════════════════════════

const config = require('../config');
const meta = require('./metaClient');
const telegram = require('./telegram');
const {
  getPurchases,
  summarizeInsights,
} = require('../domain/metrics');
const { buildFatigueSnapshot, classifyFatigue } = require('../domain/fatigue');
const {
  filterRecentInsights,
  buildProfitContext,
} = require('../domain/performanceContext');
const { buildCampaignEconomics } = require('../services/campaignEconomicsService');
const { buildMeasurementTrust } = require('../services/measurementTrustService');
const {
  buildDefaultChampionPolicy,
  evaluateBudgetSnapshot,
} = require('../services/budgetPolicyService');
const observabilityService = require('../services/observabilityService');
const {
  OPTIMIZATION_TYPES,
  isBudgetDecreaseAction,
  isBudgetIncreaseAction,
  isExecutableOptimization,
  requiresApproval,
} = require('../domain/optimizationSemantics');
const runtimeSettings = require('../runtime/runtimeSettings');
const { getTodayInTimeZone } = require('../domain/time');

const PERFORMANCE_LOOKBACK_DAYS = 7;
const PROFIT_SCALE_MARGIN_THRESHOLD = 0.08;
const MIN_PROFIT_COVERAGE_RATIO = 0.8;
const OPTIMIZER_WINDOW_OPTIONS = Object.freeze({ includeCurrentDay: false });
const MIN_REALLOCATION_PURCHASES = 5;
const MIN_REALLOCATION_PURCHASE_DAYS = 3;
const DECISION_DOMAINS = Object.freeze({
  MACRO_BUDGET: 'macro_budget',
  PORTFOLIO: 'portfolio_guardrails',
  REALLOCATION: 'portfolio_allocation',
  MEASUREMENT: 'measurement_trust',
  CREATIVE: 'creative_inputs',
});

const DECISION_KINDS = Object.freeze({
  SCALE_BUDGET: 'scale_budget',
  REDUCE_BUDGET: 'reduce_budget',
  REALLOCATE_BUDGET: 'reallocate_budget',
  HOLD_BUDGET: 'hold_budget',
  HARD_STOPLOSS: 'hard_stoploss',
  FREEZE_LOW_TRUST: 'freeze_due_to_low_trust',
  FIX_MEASUREMENT_INPUTS: 'fix_measurement_inputs',
  FIX_CREATIVE_INPUTS: 'fix_creative_inputs',
  PORTFOLIO_SCALE: 'portfolio_scale',
  PORTFOLIO_REDUCE: 'portfolio_reduce',
});

function parseActionPercent(actionText, fallbackPercent) {
  const match = String(actionText || '').match(/(\d+(?:\.\d+)?)%/);
  const parsed = match ? Number.parseFloat(match[1]) : fallbackPercent;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackPercent;
}

class BusinessDecisionEngine {
  constructor(scanId = Date.now(), options = {}) {
    this.actions = []; // Generated actions for this scan
    this.scanId = scanId;
    this.budgetPolicy = options.budgetPolicy || null;
    this.measurementTrust = null;
  }

  getRules() {
    return runtimeSettings.getRules();
  }

  buildBusinessMetadata(overrides = {}) {
    return {
      optimizationScope: 'business_decisioning',
      automationScope: 'macro',
      ...overrides,
    };
  }

  hasAction(decisionKind) {
    return this.actions.some(action => action?.decisionKind === decisionKind);
  }

  buildDecisionEvidence(insights, totals = summarizeInsights(insights)) {
    const rows = Array.isArray(insights) ? insights : [];
    const purchaseDays = rows.filter(row => getPurchases(row?.actions) > 0).length;

    return {
      observationDays: rows.length,
      purchaseDays,
      spend: Number(totals.spend || 0),
      purchases: Number(totals.purchases || 0),
      cpa: totals.cpa,
    };
  }

  hasReallocationConfidence(evidence, rules) {
    return evidence.observationDays >= Math.max(rules.minDataDays, MIN_REALLOCATION_PURCHASE_DAYS)
      && evidence.spend >= rules.minSpendForDecision
      && evidence.purchases >= MIN_REALLOCATION_PURCHASES
      && evidence.purchaseDays >= MIN_REALLOCATION_PURCHASE_DAYS;
  }

  buildCampaignRiskContext(campaigns, ads, adInsights, referenceDate = getTodayInTimeZone()) {
    const rules = this.getRules();
    const activeCampaignCount = (Array.isArray(campaigns) ? campaigns : []).filter(campaign => campaign.status === 'ACTIVE').length;
    const riskByCampaignId = new Map();

    for (const campaign of Array.isArray(campaigns) ? campaigns : []) {
      const activeAds = (Array.isArray(ads) ? ads : []).filter(ad =>
        ad?.campaign_id === campaign.id
        && ad?.effective_status === 'ACTIVE'
      );
      const fatiguedAds = [];

      for (const ad of activeAds) {
        const recentAdInsights = filterRecentInsights(adInsights, 'ad_id', ad.id, PERFORMANCE_LOOKBACK_DAYS, referenceDate, OPTIMIZER_WINDOW_OPTIONS);
        if (recentAdInsights.length < rules.minDataDays) continue;

        const fatigueSnapshot = buildFatigueSnapshot(recentAdInsights);
        const fatigue = classifyFatigue(fatigueSnapshot, {
          frequencyThreshold: rules.fatigueFrequencyThreshold,
          ctrDecayPercent: rules.fatigueCtrDecayPercent,
          minDataDays: rules.minDataDays,
        });

        if (fatigue.status === 'danger') {
          fatiguedAds.push({
            id: ad.id,
            name: ad.name,
            frequency: fatigueSnapshot.lastFrequency,
            ctrDecayPercent: fatigueSnapshot.ctrDecayPercent,
          });
        }
      }

      const activeAdCount = activeAds.length;
      const severeFatigueBlock = activeAdCount > 0
        && fatiguedAds.length >= Math.max(2, Math.ceil(activeAdCount * 0.5));

      riskByCampaignId.set(String(campaign.id), {
        activeCampaignCount,
        activeAdCount,
        fatiguedAds,
        severeFatigueBlock,
        hasConcentrationRisk: activeCampaignCount <= 1,
        hasCreativeDepthRisk: activeAdCount > 0 && activeAdCount < 3,
      });
    }

    return riskByCampaignId;
  }

  buildScaleImpactRange(increaseUsd, avgCPA, cautionCount = 0, confidence = 'low') {
    const baseLift = avgCPA > 0 ? increaseUsd / avgCPA : 0;
    if (!Number.isFinite(baseLift) || baseLift <= 0) {
      return { min: 0, max: 0 };
    }

    let lowFactor = confidence === 'high' ? 0.6 : confidence === 'medium' ? 0.45 : 0.3;
    let highFactor = confidence === 'high' ? 1.15 : confidence === 'medium' ? 0.95 : 0.8;

    if (cautionCount >= 2) {
      lowFactor *= 0.8;
      highFactor *= 0.85;
    }

    const min = Math.max(0, Math.floor(baseLift * lowFactor));
    const max = Math.max(min + 1, Math.ceil(baseLift * highFactor));

    return { min, max };
  }
  // ── Log an optimization action ──
  addAction(type, level, targetId, targetName, action, reason, impact, priority = 'medium', metadata = null) {
    const optimization = {
      id: `opt_${this.scanId}_${this.actions.length}`,
      timestamp: new Date().toISOString(),
      scanId: this.scanId,
      type,       // budget | creative | status
      level,      // campaign | adset | ad
      targetId,
      targetName,
      action,     // Human-readable action description
      reason,     // Why this optimization
      impact,     // Expected impact description
      priority,   // critical | high | medium | low
      executed: false,
      approvalStatus: null,
      approvalRequestedAt: null,
      executionResult: null,
      ...(metadata && typeof metadata === 'object' ? metadata : {}),
    };
    this.actions.push(optimization);
    return optimization;
  }

  // ── Run all optimization checks ──
  async analyze(campaignData, adData, campaignInsights, adInsights, revenueData, revenueSource = null, cogsData = null) {
    const rules = this.getRules();
    this.actions = [];
    this.measurementTrust = null;
    const referenceDate = getTodayInTimeZone();
    const budgetPolicy = this.budgetPolicy || buildDefaultChampionPolicy(rules);
    const profitContext = buildProfitContext(campaignInsights, revenueData, cogsData, PERFORMANCE_LOOKBACK_DAYS, getTodayInTimeZone(), {
      minCoverageRatio: MIN_PROFIT_COVERAGE_RATIO,
      includeCurrentDay: false,
    });
    const campaignEconomics = buildCampaignEconomics(
      campaignData,
      campaignInsights,
      revenueData,
      cogsData,
      revenueSource,
      {
        days: PERFORMANCE_LOOKBACK_DAYS,
        referenceDate,
        includeCurrentDay: false,
        minCoverageRatio: MIN_PROFIT_COVERAGE_RATIO,
      }
    );
    const measurementTrust = buildMeasurementTrust({
      sourceHealth: {
        metaInsights: {
          status: Array.isArray(campaignInsights) && campaignInsights.length > 0 ? 'connected' : 'error',
          stale: false,
          hasData: Array.isArray(campaignInsights) && campaignInsights.length > 0,
        },
        imweb: {
          status: revenueSource?.status ?? 'unknown',
          stale: Boolean(revenueSource?.stale),
          hasData: Array.isArray(revenueData?.dailyRevenue) && revenueData.dailyRevenue.length > 0,
          lastError: revenueSource?.lastError ?? null,
        },
        cogs: {
          status: cogsData?.error ? 'error' : cogsData ? 'connected' : 'unknown',
          stale: Boolean(cogsData?.stale),
          hasData: Array.isArray(cogsData?.dailyCOGS) && cogsData.dailyCOGS.length > 0,
          lastError: cogsData?.error || null,
        },
      },
      revenueSource,
      campaignEconomicsSummary: campaignEconomics?.summary || null,
      profitContext,
    });
    const campaignRiskContext = this.buildCampaignRiskContext(
      campaignData,
      adData,
      adInsights,
      referenceDate
    );
    this.measurementTrust = measurementTrust;

    console.log(`[BUSINESS ENGINE] Starting scan ${this.scanId}...`);

    this.analyzeCampaigns(
      campaignData,
      campaignInsights,
      campaignEconomics,
      referenceDate,
      campaignRiskContext,
      budgetPolicy,
      measurementTrust
    );

    if (rules.budgetReallocationEnabled) {
      this.analyzeBudgetReallocation(campaignData, campaignInsights, campaignEconomics, measurementTrust);
    }

    this.analyzeROAS(campaignInsights, revenueData, revenueSource, profitContext, measurementTrust);
    this.analyzeCreativeInputs(campaignData, campaignRiskContext, campaignEconomics, measurementTrust);

    if (measurementTrust.shouldFreezeBudgetChanges) {
      this.addAction(
        OPTIMIZATION_TYPES.BUDGET,
        'account',
        config.meta.adAccountId,
        'Measurement Trust',
        'Freeze budget changes — measurement trust is too weak',
        `${measurementTrust.reason}. ${measurementTrust.blockingIssues.join('; ')}`,
        'Fix source health, freshness, and coverage before changing budget guardrails.',
        'high',
        this.buildBusinessMetadata({
          decisionKind: DECISION_KINDS.FREEZE_LOW_TRUST,
          decisionDomain: DECISION_DOMAINS.MEASUREMENT,
          measurementTrust: measurementTrust.level,
          measurementTrustReason: measurementTrust.reason,
          blockingIssues: measurementTrust.blockingIssues,
          cautionIssues: measurementTrust.cautionIssues,
        })
      );
    }

    if (!this.actions.length) {
      const holdReason = measurementTrust.level === 'high'
        ? 'Measurement trust is decision-grade and no campaign crossed the current scale, reduce, or stop-loss guardrails.'
        : `No campaign crossed the current guardrails. ${measurementTrust.reason}`;
      this.addAction(
        OPTIMIZATION_TYPES.BUDGET,
        'account',
        config.meta.adAccountId,
        'Meta Delivery',
        'Hold budget — let Meta continue delivery',
        holdReason,
        'No operator change needed. Re-evaluate after the next scan or when source quality shifts.',
        'low',
        this.buildBusinessMetadata({
          decisionKind: DECISION_KINDS.HOLD_BUDGET,
          decisionDomain: DECISION_DOMAINS.MACRO_BUDGET,
          decisionVerdict: 'hold',
          measurementTrust: measurementTrust.level,
        })
      );
    }

    console.log(`[BUSINESS ENGINE] Scan complete. Generated ${this.actions.length} decisions.`);
    return this.actions;
  }

  // ── 1. Campaign-Level Analysis ──
  analyzeCampaigns(
    campaigns,
    insights,
    campaignEconomicsContext = null,
    referenceDate = getTodayInTimeZone(),
    campaignRiskContext = null,
    budgetPolicy = null,
    measurementTrust = null
  ) {
    const rules = this.getRules();
    const activeBudgetPolicy = budgetPolicy || this.budgetPolicy || buildDefaultChampionPolicy(rules);
    const campaignEconomicsById = new Map(
      (campaignEconomicsContext?.campaigns || []).map(campaign => [String(campaign.campaignId), campaign])
    );

    for (const campaign of campaigns) {
      if (campaign.status !== 'ACTIVE') continue;

      // Get recent insights for this campaign (last 7 days)
      const cInsights = filterRecentInsights(insights, 'campaign_id', campaign.id, PERFORMANCE_LOOKBACK_DAYS, referenceDate, OPTIMIZER_WINDOW_OPTIONS);
      if (cInsights.length === 0) continue;

      const totals = summarizeInsights(cInsights);
      const totalSpend = totals.spend;
      const totalPurchases = totals.purchases;
      const avgCPA = totals.cpa;
      const evidence = this.buildDecisionEvidence(cInsights, totals);
      const hasDecisionData = evidence.observationDays >= rules.minDataDays && totalSpend >= rules.minSpendForDecision;
      const riskSnapshot = campaignRiskContext?.get(String(campaign.id)) || null;
      const campaignEconomics = campaignEconomicsById.get(String(campaign.id)) || null;
      const budgetSnapshot = {
        targetId: campaign.id,
        targetName: campaign.name,
        targetLevel: 'campaign',
        currentBudgetCents: Number.parseInt(campaign.daily_budget || campaign.dailyBudget || 0, 10),
        avgCpa: avgCPA,
        spend: totalSpend,
        purchases: totalPurchases,
        evidence,
        economics: {
          targetCpa: campaignEconomics?.targetCpa ?? null,
          breakEvenCpa: campaignEconomics?.breakEvenCpa ?? null,
          estimatedRevenue: campaignEconomics?.estimatedRevenue ?? 0,
          estimatedTrueNetProfit: campaignEconomics?.estimatedTrueNetProfit ?? 0,
          estimatedMargin: campaignEconomics?.estimatedMargin ?? 0,
          coverageRatio: campaignEconomics?.coverageRatio ?? (campaignEconomics?.hasReliableEstimate ? 1 : 0),
          confidence: campaignEconomics?.confidence ?? 'low',
          confidenceLabel: campaignEconomics?.confidenceLabel ?? 'Low confidence',
          hasReliableEstimate: campaignEconomics?.hasReliableEstimate ?? false,
        },
        risk: {
          activeCampaignCount: riskSnapshot?.activeCampaignCount ?? 0,
          activeAdCount: riskSnapshot?.activeAdCount ?? 0,
          severeFatigueBlock: Boolean(riskSnapshot?.severeFatigueBlock),
          hasConcentrationRisk: Boolean(riskSnapshot?.hasConcentrationRisk),
          hasCreativeDepthRisk: Boolean(riskSnapshot?.hasCreativeDepthRisk),
          fatiguedAds: riskSnapshot?.fatiguedAds ?? [],
        },
        measurementTrust,
        reviewWindowHours: 72,
        timestamp: new Date().toISOString(),
      };
      const budgetEvaluation = evaluateBudgetSnapshot(budgetSnapshot, activeBudgetPolicy, rules);

      if (budgetEvaluation.shouldCreateOptimization && budgetEvaluation.verdict === 'reduce') {
        const targetCpaSuffix = campaignEconomics?.targetCpa
          ? ` versus estimated target CPA $${campaignEconomics.targetCpa.toFixed(2)}`
          : '';
        const budgetAction = this.addAction(
          OPTIMIZATION_TYPES.BUDGET,
          'campaign',
          campaign.id,
          campaign.name,
          `Reduce daily budget by ${budgetEvaluation.actionPercent}%`,
          `Last ${PERFORMANCE_LOOKBACK_DAYS}d CPA is $${avgCPA.toFixed(2)}${targetCpaSuffix}. ${budgetEvaluation.reasoning}`,
          budgetEvaluation.impactSummary,
          budgetEvaluation.priority,
          this.buildBusinessMetadata({
            decisionDomain: DECISION_DOMAINS.MACRO_BUDGET,
            decisionKind: DECISION_KINDS.REDUCE_BUDGET,
            decisionVerdict: budgetEvaluation.verdict,
            decisionActionPercent: budgetEvaluation.actionPercent,
            traceActionPercent: budgetEvaluation.actionPercent,
            measurementTrust: measurementTrust?.level || 'low',
          })
        );
        void budgetAction;
      }

      // Rule: CPA too high — pause campaign
      if (hasDecisionData && avgCPA && avgCPA > rules.cpaPauseThreshold) {
        this.addAction(OPTIMIZATION_TYPES.STATUS, 'campaign', campaign.id, campaign.name,
          `Pause campaign — CPA critically high`,
          `Last ${PERFORMANCE_LOOKBACK_DAYS}d CPA $${avgCPA.toFixed(2)} exceeds $${rules.cpaPauseThreshold} threshold`,
          `Save ~$${(totalSpend / cInsights.length).toFixed(2)}/day in wasted spend`,
          'critical',
          this.buildBusinessMetadata({
            decisionDomain: DECISION_DOMAINS.MACRO_BUDGET,
            decisionKind: DECISION_KINDS.HARD_STOPLOSS,
            measurementTrust: measurementTrust?.level || 'low',
          })
        );
      }

      if (budgetEvaluation.shouldCreateOptimization && budgetEvaluation.verdict === 'scale') {
        const confidenceLabel = campaignEconomics?.confidenceLabel || `${campaignEconomics?.confidence || 'low'} confidence`;
        const confidencePrefix = campaignEconomics?.confidence === 'high'
          ? 'Campaign contribution estimate is'
          : 'Directional campaign contribution estimate is';
        const caveatSuffix = budgetEvaluation.cautions.length > 0
          ? ` Scale caveats: ${budgetEvaluation.cautions.join('; ')}.`
          : '';
        const targetCpaSuffix = campaignEconomics?.targetCpa > 0
          ? ` versus estimated target CPA $${campaignEconomics.targetCpa.toFixed(2)}`
          : '';
        const breakEvenSuffix = campaignEconomics?.breakEvenCpa
          ? ` and break-even CPA $${campaignEconomics.breakEvenCpa.toFixed(2)}`
          : '';
        const impactRange = this.buildScaleImpactRange(
          budgetEvaluation.actionDollars,
          avgCPA,
          budgetEvaluation.cautions.length + budgetEvaluation.penalties.length,
          budgetEvaluation.confidence
        );
        const scaleReason = `Last ${PERFORMANCE_LOOKBACK_DAYS}d CPA is $${avgCPA.toFixed(2)}${targetCpaSuffix}${breakEvenSuffix}, with ${totalPurchases} Meta-attributed purchases. ${confidencePrefix} ₩${campaignEconomics.estimatedTrueNetProfit.toLocaleString()} on ₩${campaignEconomics.estimatedRevenue.toLocaleString()} estimated attributable revenue at ${(campaignEconomics.estimatedMargin * 100).toFixed(1)}% margin (${confidenceLabel.toLowerCase()} daily AOV proxy).${caveatSuffix}`;
        const budgetAction = this.addAction(OPTIMIZATION_TYPES.BUDGET, 'campaign', campaign.id, campaign.name,
          `Increase daily budget by $${budgetEvaluation.actionDollars.toFixed(2)} (${budgetEvaluation.actionPercent}%)`,
          scaleReason,
          `Estimated +${impactRange.min} to +${impactRange.max} Meta-attributed purchases/day if CPA holds. Review after 48-72 hours.`,
          budgetEvaluation.priority,
          this.buildBusinessMetadata({
            decisionDomain: DECISION_DOMAINS.MACRO_BUDGET,
            decisionKind: DECISION_KINDS.SCALE_BUDGET,
            decisionVerdict: budgetEvaluation.verdict,
            decisionActionPercent: budgetEvaluation.actionPercent,
            traceActionPercent: budgetEvaluation.actionPercent,
            measurementTrust: measurementTrust?.level || 'low',
          })
        );
        void budgetAction;
      }
    }
  }

  analyzeCreativeInputs(campaigns, campaignRiskContext = null, campaignEconomicsContext = null, measurementTrust = null) {
    if (measurementTrust?.shouldFreezeBudgetChanges) return;

    const economicsByCampaignId = new Map(
      (campaignEconomicsContext?.campaigns || []).map(campaign => [String(campaign.campaignId), campaign])
    );
    const candidates = (Array.isArray(campaigns) ? campaigns : [])
      .filter(campaign => campaign.status === 'ACTIVE')
      .map(campaign => ({
        campaign,
        economics: economicsByCampaignId.get(String(campaign.id)) || null,
        risk: campaignRiskContext?.get(String(campaign.id)) || null,
      }))
      .filter(entry =>
        entry.economics?.hasReliableEstimate
        && entry.economics?.estimatedTrueNetProfit > 0
        && entry.economics?.estimatedMargin >= PROFIT_SCALE_MARGIN_THRESHOLD
        && entry.risk
        && (
          entry.risk.severeFatigueBlock
          || entry.risk.hasCreativeDepthRisk
          || (entry.risk.fatiguedAds || []).length > 0
        )
      )
      .sort((left, right) => (right.economics?.estimatedTrueNetProfit || 0) - (left.economics?.estimatedTrueNetProfit || 0))
      .slice(0, 3);

    for (const entry of candidates) {
      const issues = [];
      let priority = 'medium';

      if (entry.risk.severeFatigueBlock) {
        issues.push(`${entry.risk.fatiguedAds.length}/${entry.risk.activeAdCount} active ads are already fatigued`);
        priority = 'high';
      } else if ((entry.risk.fatiguedAds || []).length > 0) {
        issues.push(`${entry.risk.fatiguedAds.length}/${entry.risk.activeAdCount} active ads are showing fatigue`);
      }

      if (entry.risk.hasCreativeDepthRisk) {
        issues.push(`only ${entry.risk.activeAdCount} active ads are available to absorb more spend`);
      }

      if (issues.length === 0) continue;

      this.addAction(
        OPTIMIZATION_TYPES.CREATIVE,
        'campaign',
        entry.campaign.id,
        entry.campaign.name,
        'Feed Meta stronger creative inputs before scaling',
        `${entry.campaign.name} is still contribution-positive, but ${issues.join('; ')}. Improve creative supply instead of micromanaging delivery edits.`,
        'Better creative inventory gives Meta healthier inputs without forcing auction-level overrides.',
        priority,
        this.buildBusinessMetadata({
          decisionKind: DECISION_KINDS.FIX_CREATIVE_INPUTS,
          decisionDomain: DECISION_DOMAINS.CREATIVE,
          measurementTrust: measurementTrust?.level || 'low',
          estimatedTrueNetProfit: entry.economics?.estimatedTrueNetProfit || 0,
        })
      );
    }
  }

  // ── 4. Budget Reallocation ──
  analyzeBudgetReallocation(campaigns, insights, campaignEconomicsContext = null, measurementTrust = null) {
    const rules = this.getRules();
    if (measurementTrust?.shouldFreezeBudgetChanges) return;
    const activeCampaigns = campaigns.filter(c => c.status === 'ACTIVE');
    if (activeCampaigns.length < 2) return;
    const economicsByCampaignId = new Map(
      (campaignEconomicsContext?.campaigns || []).map(campaign => [String(campaign.campaignId), campaign])
    );

    // Rank campaigns by estimated contribution efficiency, not raw CPA alone.
    const campaignPerf = activeCampaigns.map(c => {
      const cInsights = filterRecentInsights(insights, 'campaign_id', c.id, PERFORMANCE_LOOKBACK_DAYS, getTodayInTimeZone(), OPTIMIZER_WINDOW_OPTIONS);
      const totals = summarizeInsights(cInsights);
      const campaignEconomics = economicsByCampaignId.get(String(c.id)) || null;
      return {
        ...c,
        spend: totals.spend,
        purchases: totals.purchases,
        cpa: totals.cpa ?? Infinity,
        evidence: this.buildDecisionEvidence(cInsights, totals),
        campaignEconomics,
      };
    }).filter(campaign =>
      campaign.spend >= rules.minSpendForDecision
      && this.hasReallocationConfidence(campaign.evidence, rules)
      && campaign.campaignEconomics?.hasReliableEstimate
    );

    if (campaignPerf.length < 2) return;

    campaignPerf.sort((left, right) => {
      const contributionDelta = (right.campaignEconomics.contributionPerSpend || 0) - (left.campaignEconomics.contributionPerSpend || 0);
      if (contributionDelta !== 0) return contributionDelta;
      return (right.campaignEconomics.estimatedTrueNetProfit || 0) - (left.campaignEconomics.estimatedTrueNetProfit || 0);
    });

    const best = campaignPerf[0];
    const worst = campaignPerf[campaignPerf.length - 1];

    if (best.campaignEconomics.estimatedTrueNetProfit > 0
      && best.campaignEconomics.estimatedMargin >= PROFIT_SCALE_MARGIN_THRESHOLD
      && worst.campaignEconomics.estimatedTrueNetProfit < 0
      && worst.spend > rules.minSpendForDecision) {
      const worstBudget = parseInt(worst.daily_budget || 0);
      const moveAmount = Math.round(worstBudget * 0.5); // Move 50% of worst's budget

      this.addAction(OPTIMIZATION_TYPES.BUDGET, 'campaign', worst.id, `${worst.name} → ${best.name}`,
        `Reallocate $${(moveAmount / 100).toFixed(2)}/day from worst → best campaign`,
        `${worst.name} estimated contribution is -₩${Math.abs(worst.campaignEconomics.estimatedTrueNetProfit).toLocaleString()} at ${(worst.campaignEconomics.estimatedMargin * 100).toFixed(1)}% margin, while ${best.name} is +₩${best.campaignEconomics.estimatedTrueNetProfit.toLocaleString()} at ${(best.campaignEconomics.estimatedMargin * 100).toFixed(1)}% margin`,
        `Shift budget toward the higher-contribution campaign while keeping approvals reviewable`,
        'high',
        this.buildBusinessMetadata({
          decisionKind: DECISION_KINDS.REALLOCATE_BUDGET,
          decisionDomain: DECISION_DOMAINS.REALLOCATION,
          measurementTrust: measurementTrust?.level || 'low',
        })
      );
    }
  }

  // ── 5. Portfolio-Level Profitability Guardrails ──
  analyzeROAS(campaignInsights, revenueData, revenueSource, profitContext = null, measurementTrust = null) {
    const rules = this.getRules();
    if (!revenueData) return;
    if (revenueSource?.stale || revenueSource?.status !== 'connected') return;
    if (measurementTrust?.shouldFreezeBudgetChanges) return;
    if (!profitContext?.hasReliableCoverage || profitContext.adSpendKRW < rules.minSpendForDecision * 1300) return;

    if (profitContext.trueNetProfit < 0) {
      this.addAction(OPTIMIZATION_TYPES.BUDGET, 'account', config.meta.adAccountId, 'Overall Profitability',
        `True net profit is -₩${Math.abs(profitContext.trueNetProfit).toLocaleString()} — constrain spend`,
        `Last ${PERFORMANCE_LOOKBACK_DAYS}d true net profit is -₩${Math.abs(profitContext.trueNetProfit).toLocaleString()} after ₩${profitContext.cogs.toLocaleString()} COGS, ₩${profitContext.shipping.toLocaleString()} shipping, ₩${profitContext.paymentFees.toLocaleString()} fees, and ₩${profitContext.adSpendKRW.toLocaleString()} ad spend.`,
        `Treat this as a portfolio guardrail: reduce exposure until contribution turns positive again.`,
        'critical',
        this.buildBusinessMetadata({
          decisionKind: DECISION_KINDS.PORTFOLIO_REDUCE,
          decisionDomain: DECISION_DOMAINS.PORTFOLIO,
          decisionVerdict: 'reduce',
          measurementTrust: measurementTrust?.level || 'low',
        })
      );
      return;
    }

    if (
      profitContext.trueNetProfit > 0
      && profitContext.margin >= PROFIT_SCALE_MARGIN_THRESHOLD
      && !this.hasAction(DECISION_KINDS.SCALE_BUDGET)
    ) {
      this.addAction(OPTIMIZATION_TYPES.BUDGET, 'account', config.meta.adAccountId, 'Overall Profitability',
        `True net profit is ₩${profitContext.trueNetProfit.toLocaleString()} — room to feed Meta more budget`,
        `Last ${PERFORMANCE_LOOKBACK_DAYS}d true net profit is ₩${profitContext.trueNetProfit.toLocaleString()} on ₩${profitContext.netRevenue.toLocaleString()} net revenue (${(profitContext.margin * 100).toFixed(1)}% true net margin).`,
        `Use this as a portfolio-level scale guardrail while the margin stays above ${(PROFIT_SCALE_MARGIN_THRESHOLD * 100).toFixed(0)}%.`,
        'medium',
        this.buildBusinessMetadata({
          decisionKind: DECISION_KINDS.PORTFOLIO_SCALE,
          decisionDomain: DECISION_DOMAINS.PORTFOLIO,
          decisionVerdict: 'scale',
          measurementTrust: measurementTrust?.level || 'low',
        })
      );
    }
  }

  // ═══════════════════════════════════════════════
  // EXECUTION — Actually apply optimizations
  // ═══════════════════════════════════════════════

  async executeAction(action) {
    const rules = this.getRules();
    if (!rules.autonomousMode) {
      action.executed = false;
      action.executionResult = 'Skipped — autonomous mode disabled (suggestion only)';
      return action;
    }

    if (!this.isExecutableAction(action)) {
      action.executed = false;
      action.executionResult = 'Suggestion only — manual review required';
      return action;
    }

    try {
      let result;

      // Campaign budget changes
      if (action.type === OPTIMIZATION_TYPES.BUDGET && action.level === 'campaign') {
        const entities = await meta.getCampaigns();
        const entity = entities.find(item => item.id === action.targetId);
        const currentBudget = Number.parseInt(entity?.daily_budget || 0, 10);
        const explicitPercent = Number(action.decisionActionPercent || action.traceActionPercent || 0);
        const actionPercent = explicitPercent > 0
          ? explicitPercent
          : parseActionPercent(action.action, rules.maxBudgetChangePercent);

        if (!entity) {
          action.executed = false;
          action.executionResult = 'Failed: campaign not found in Meta';
          return action;
        }

        if (entity?.lifetime_budget && !entity?.daily_budget) {
          action.executed = false;
          action.executionResult = 'Failed: campaign uses lifetime budget, not daily budget';
          return action;
        }

        if (!Number.isFinite(currentBudget) || currentBudget <= 0) {
          action.executed = false;
          action.executionResult = 'Failed: current daily budget unavailable';
          return action;
        }

        let newBudget = currentBudget;
        if (isBudgetDecreaseAction(action.action)) {
          newBudget = Math.max(100, Math.round(currentBudget * (1 - actionPercent / 100)));
        } else if (isBudgetIncreaseAction(action.action)) {
          newBudget = Math.round(currentBudget * (1 + actionPercent / 100));
        } else {
          action.executed = false;
          action.executionResult = 'Suggestion only — unsupported budget action';
          return action;
        }

        if (action.level === 'campaign') {
          const account = await meta.getAdAccount();
          const accountStatus = Number.parseInt(account?.account_status, 10);
          const disableReason = Number.parseInt(account?.disable_reason, 10);
          const minCampaignBudget = Number.parseInt(account?.min_campaign_group_spend_cap || 0, 10);

          if (Number.isFinite(accountStatus) && accountStatus !== 1) {
            action.executed = false;
            action.executionResult = `Failed: ad account status ${accountStatus} blocks campaign budget updates`;
            return action;
          }

          if (Number.isFinite(disableReason) && disableReason !== 0) {
            action.executed = false;
            action.executionResult = `Failed: ad account disable reason ${disableReason} blocks campaign budget updates`;
            return action;
          }

          if (
            isBudgetDecreaseAction(action.action)
            && Number.isFinite(minCampaignBudget)
            && minCampaignBudget > 0
            && newBudget < minCampaignBudget
          ) {
            action.executed = false;
            action.executionResult = `Failed: requested campaign budget falls below Meta minimum of $${(minCampaignBudget / 100).toFixed(2)}/day`;
            return action;
          }
        }

        result = await meta.updateCampaignBudget(action.targetId, newBudget);
      }

      // Status changes
      if (action.type === OPTIMIZATION_TYPES.STATUS) {
        if (action.level === 'campaign') {
          result = await meta.updateCampaignStatus(action.targetId, 'PAUSED');
        }
      }

      action.executed = true;
      action.executionResult = result ? 'Success' : 'No action taken';
      if (action.executed) {
        observabilityService.captureMessage(
          `Optimization executed: ${action.action}`,
          'info',
          {
            category: 'optimizer.execution',
            title: 'Optimization executed',
            tags: {
              optimization_type: action.type,
              optimization_level: action.level,
              decision_verdict: action.decisionVerdict || 'unknown',
            },
            data: {
              targetId: action.targetId,
              targetName: action.targetName,
            },
          }
        );
      }
      console.log(`[BUSINESS ENGINE] Executed: ${action.action} → ${action.executionResult}`);
    } catch (err) {
      action.executed = false;
      action.executionResult = `Failed: ${err.message}`;
      observabilityService.captureException(err, {
        category: 'optimizer.execution',
        title: 'Optimization execution failed',
        tags: {
          optimization_type: action.type,
          optimization_level: action.level,
        },
        data: {
          targetId: action.targetId,
          targetName: action.targetName,
          action: action.action,
        },
      });
      console.error(`[BUSINESS ENGINE] Execution failed: ${err.message}`);
    }

    return action;
  }

  // ── Check if action requires Telegram approval ──
  requiresApproval(action) {
    return requiresApproval(action);
  }

  isExecutableAction(action) {
    return isExecutableOptimization(action);
  }

  // Execute money actions after explicit approval, regardless of priority.
  async processApprovalQueue() {
    const approvalQueue = this.actions.filter(action =>
      this.requiresApproval(action) && this.isExecutableAction(action) && !action.executed
    );

    console.log(`[BUSINESS ENGINE] ${approvalQueue.length} approval-required actions to process...`);

    for (const action of approvalQueue) {
      console.log(`[BUSINESS ENGINE] Requesting Telegram approval for: ${action.action}`);
      const approvalId = await telegram.requestApproval(action);

      if (!approvalId) {
        action.executed = false;
        action.executionResult = 'Failed to send Telegram approval request';
        console.error(`[BUSINESS ENGINE] Telegram request failed for: ${action.action}`);
        continue;
      }

      action.approvalStatus = 'pending';
      action.approvalRequestedAt = new Date().toISOString();
      const response = await telegram.waitForApproval(approvalId, 300000);

      if (response.approved) {
        console.log(`[BUSINESS ENGINE] ✅ APPROVED: ${action.action}`);
        await this.executeAction(action);
        action.approvalStatus = 'approved';
        const resultEmoji = action.executed ? '✅' : '❌';
        await telegram.sendMessage(
          `${resultEmoji} <b>Execution Result</b>\n\n<b>Action:</b> ${action.action}\n<b>Result:</b> ${action.executionResult}`
        );
      } else {
        action.executed = false;
        action.approvalStatus = String(response.reason || '').toLowerCase().includes('timeout') ? 'expired' : 'rejected';
        action.executionResult = `${action.approvalStatus === 'expired' ? 'Expired' : 'Rejected'}: ${response.reason}`;
        console.log(`[BUSINESS ENGINE] ❌ REJECTED: ${action.action} — ${response.reason}`);
      }

      await new Promise(r => setTimeout(r, 1000));
    }

    return approvalQueue;
  }

  async executeHighPriority() {
    return this.processApprovalQueue();
  }
}

module.exports = BusinessDecisionEngine;
module.exports.BusinessDecisionEngine = BusinessDecisionEngine;
module.exports.OptimizationEngine = BusinessDecisionEngine;
module.exports.buildProfitContext = buildProfitContext;
