// ═══════════════════════════════════════════════════════
// AdPilot — Optimization Engine
// Analyzes Meta Ads data and generates micro-optimizations
// ═══════════════════════════════════════════════════════

const config = require('../config');
const meta = require('./metaClient');
const telegram = require('./telegram');
const {
  averagePositiveField,
  calcROAS,
  convertUsdToKrw,
  getPurchases,
  summarizeInsights,
} = require('../domain/metrics');
const { buildFatigueSnapshot, classifyFatigue } = require('../domain/fatigue');
const {
  filterRecentInsights,
  filterAllRecentInsights,
  sumRecentNetRevenue,
  buildWeekdayScaleContext,
  buildProfitContext,
} = require('../domain/performanceContext');
const { buildCampaignEconomics } = require('../services/campaignEconomicsService');
const {
  OPTIMIZATION_TYPES,
  isBudgetDecreaseAction,
  isBudgetIncreaseAction,
  isExecutableOptimization,
  isReallocationAction,
  requiresApproval,
} = require('../domain/optimizationSemantics');
const runtimeSettings = require('../runtime/runtimeSettings');
const { getTodayInTimeZone } = require('../domain/time');

const PERFORMANCE_LOOKBACK_DAYS = 7;
const SCHEDULE_LOOKBACK_DAYS = 28;
const PROFIT_SCALE_MARGIN_THRESHOLD = 0.08;
const MIN_PROFIT_COVERAGE_RATIO = 0.8;
const WEEKDAY_SCALE_CAUTION_RATIO = 1.15;
const WEEKDAY_SCALE_SUPPRESS_RATIO = 1.4;
const OPTIMIZER_WINDOW_OPTIONS = Object.freeze({ includeCurrentDay: false });
const MIN_SCALE_PURCHASES = 8;
const MIN_SCALE_PURCHASE_DAYS = 3;
const MIN_REALLOCATION_PURCHASES = 5;
const MIN_REALLOCATION_PURCHASE_DAYS = 3;
const SCALE_TREND_CAUTION_RATIO = 1.2;
const SCALE_TREND_SUPPRESS_RATIO = 1.45;

class OptimizationEngine {
  constructor(scanId = Date.now()) {
    this.actions = []; // Generated actions for this scan
    this.scanId = scanId;
  }

  getRules() {
    return runtimeSettings.getRules();
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

  hasScaleConfidence(evidence, rules) {
    return evidence.observationDays >= Math.max(rules.minDataDays, MIN_SCALE_PURCHASE_DAYS)
      && evidence.spend >= rules.minSpendForDecision
      && evidence.purchases >= MIN_SCALE_PURCHASES
      && evidence.purchaseDays >= MIN_SCALE_PURCHASE_DAYS;
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

  buildScaleTrendContext(insights, rules) {
    const rows = Array.isArray(insights) ? insights : [];
    if (rows.length < Math.max(rules.minDataDays, 5)) {
      return { status: 'neutral' };
    }

    const recent = rows.slice(-3);
    const baseline = rows.slice(0, -3);
    if (recent.length < 3 || baseline.length < 2) {
      return { status: 'neutral' };
    }

    const recentTotals = summarizeInsights(recent);
    const baselineTotals = summarizeInsights(baseline);

    if ((recentTotals.purchases || 0) === 0 && (recentTotals.spend || 0) >= rules.minSpendForDecision) {
      return {
        status: 'suppress',
        reason: `Recent 3d delivery spent $${recentTotals.spend.toFixed(2)} with 0 Meta-attributed purchases`,
      };
    }

    if (!recentTotals.cpa || !baselineTotals.cpa || baselineTotals.cpa <= 0) {
      return { status: 'neutral' };
    }

    const weaknessRatio = recentTotals.cpa / baselineTotals.cpa;
    if (weaknessRatio >= SCALE_TREND_SUPPRESS_RATIO) {
      return {
        status: 'suppress',
        weaknessRatio,
        recentCpa: recentTotals.cpa,
        baselineCpa: baselineTotals.cpa,
        reason: `Recent 3d CPA is $${recentTotals.cpa.toFixed(2)} versus a $${baselineTotals.cpa.toFixed(2)} prior-window CPA`,
      };
    }

    if (weaknessRatio >= SCALE_TREND_CAUTION_RATIO) {
      return {
        status: 'caution',
        weaknessRatio,
        recentCpa: recentTotals.cpa,
        baselineCpa: baselineTotals.cpa,
        reason: `Recent 3d CPA is softening at $${recentTotals.cpa.toFixed(2)} versus $${baselineTotals.cpa.toFixed(2)} previously`,
      };
    }

    return {
      status: 'stable',
      weaknessRatio,
      recentCpa: recentTotals.cpa,
      baselineCpa: baselineTotals.cpa,
    };
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

  buildScaleDecision({
    campaign,
    totals,
    evidence,
    rules,
    campaignEconomics,
    weekdayScaleContext,
    trendContext,
    riskSnapshot,
  }) {
    const blockers = [];
    const cautions = [];
    const avgCPA = totals.cpa;
    const dynamicTargetCpa = campaignEconomics?.targetCpa > 0
      ? campaignEconomics.targetCpa
      : Number((rules.cpaWarningThreshold * 0.5).toFixed(2));
    const breakEvenCpa = campaignEconomics?.breakEvenCpa > 0 ? campaignEconomics.breakEvenCpa : null;

    if (!this.hasScaleConfidence(evidence, rules)) {
      blockers.push('Recent delivery evidence is still too thin to scale confidently');
    }

    if (!avgCPA) {
      blockers.push('Recent CPA is unavailable');
    }

    if (!campaignEconomics) {
      blockers.push('Campaign economics are unavailable');
    } else {
      if (!campaignEconomics.hasReliableEstimate) {
        blockers.push('Campaign contribution estimate is not reliable enough yet');
      }

      if (campaignEconomics.estimatedTrueNetProfit <= 0 || campaignEconomics.estimatedMargin < PROFIT_SCALE_MARGIN_THRESHOLD) {
        blockers.push('Estimated contribution is not yet strong enough to justify scaling');
      }

      if (avgCPA && breakEvenCpa && avgCPA > breakEvenCpa) {
        blockers.push(`7d CPA is above the estimated break-even CPA of $${breakEvenCpa.toFixed(2)}`);
      } else if (avgCPA && dynamicTargetCpa && avgCPA > dynamicTargetCpa) {
        blockers.push(`7d CPA is above the estimated target CPA of $${dynamicTargetCpa.toFixed(2)}`);
      }

      if (campaignEconomics.confidence !== 'high') {
        cautions.push(`${campaignEconomics.confidenceLabel} contribution estimate`);
      }

      if (campaignEconomics.coverageRatio < MIN_PROFIT_COVERAGE_RATIO) {
        cautions.push(`COGS coverage on active spend is ${(campaignEconomics.coverageRatio * 100).toFixed(1)}%`);
      }
    }

    if (weekdayScaleContext?.status === 'suppress') {
      blockers.push(weekdayScaleContext.reason);
    } else if (weekdayScaleContext?.status === 'caution') {
      cautions.push(weekdayScaleContext.reason);
    }

    if (trendContext?.status === 'suppress') {
      blockers.push(trendContext.reason);
    } else if (trendContext?.status === 'caution') {
      cautions.push(trendContext.reason);
    }

    if (riskSnapshot?.severeFatigueBlock) {
      blockers.push(`${riskSnapshot.fatiguedAds.length}/${riskSnapshot.activeAdCount} active ads already show fatigue`);
    } else if ((riskSnapshot?.fatiguedAds || []).length > 0) {
      const names = riskSnapshot.fatiguedAds.slice(0, 2).map(ad => ad.name).join(', ');
      cautions.push(`${riskSnapshot.fatiguedAds.length}/${riskSnapshot.activeAdCount} active ads show fatigue${names ? ` (${names})` : ''}`);
    }

    if (riskSnapshot?.hasConcentrationRisk) {
      cautions.push(`${riskSnapshot.activeCampaignCount} active campaign is carrying spend`);
    }

    if (riskSnapshot?.hasCreativeDepthRisk) {
      cautions.push(`Only ${riskSnapshot.activeAdCount} active ads are available to absorb extra budget`);
    }

    if (blockers.length > 0) {
      return {
        shouldScale: false,
        blockers,
        cautions,
        dynamicTargetCpa,
        breakEvenCpa,
      };
    }

    const cautionCount = cautions.length;
    const increasePercent = cautionCount >= 3
      ? Math.min(rules.maxBudgetChangePercent, 10)
      : rules.maxBudgetChangePercent;
    const currentBudget = parseInt(campaign.daily_budget || campaign.dailyBudget || 0, 10);
    const increase = Math.round(currentBudget * increasePercent / 100);
    const priority = cautionCount > 0 ? 'low' : 'medium';
    const impactRange = this.buildScaleImpactRange(increase / 100, avgCPA, cautionCount, campaignEconomics?.confidence || 'low');

    return {
      shouldScale: increase > 0,
      blockers,
      cautions,
      dynamicTargetCpa,
      breakEvenCpa,
      increase,
      increasePercent,
      priority,
      impactRange,
    };
  }

  // ── Log an optimization action ──
  addAction(type, level, targetId, targetName, action, reason, impact, priority = 'medium') {
    this.actions.push({
      id: `opt_${this.scanId}_${this.actions.length}`,
      timestamp: new Date().toISOString(),
      scanId: this.scanId,
      type,       // budget | bid | creative | schedule | targeting | status
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
    });
  }

  // ── Run all optimization checks ──
  async analyze(campaignData, adSetData, adData, campaignInsights, adSetInsights, adInsights, revenueData, revenueSource = null, cogsData = null) {
    const rules = this.getRules();
    this.actions = [];
    const referenceDate = getTodayInTimeZone();
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
    const campaignRiskContext = this.buildCampaignRiskContext(
      campaignData,
      adData,
      adInsights,
      referenceDate
    );

    console.log(`[OPTIMIZER] Starting scan ${this.scanId}...`);

    // 1. Campaign-level optimizations
    this.analyzeCampaigns(campaignData, campaignInsights, campaignEconomics, referenceDate, campaignRiskContext);

    // 2. Ad set-level optimizations
    this.analyzeAdSets(adSetData, adSetInsights, campaignData);

    // 3. Ad-level optimizations (fatigue, creative performance)
    this.analyzeAds(adData, adInsights);

    // 4. Budget reallocation across campaigns
    if (rules.budgetReallocationEnabled) {
      this.analyzeBudgetReallocation(campaignData, campaignInsights, campaignEconomics);
    }

    // 5. Scheduling optimizations
    this.analyzeScheduling(adSetInsights);

    // 6. ROAS-based optimizations
    this.analyzeROAS(campaignInsights, revenueData, revenueSource, profitContext);

    console.log(`[OPTIMIZER] Scan complete. Generated ${this.actions.length} optimizations.`);
    return this.actions;
  }

  // ── 1. Campaign-Level Analysis ──
  analyzeCampaigns(campaigns, insights, campaignEconomicsContext = null, referenceDate = getTodayInTimeZone(), campaignRiskContext = null) {
    const rules = this.getRules();
    const campaignEconomicsById = new Map(
      (campaignEconomicsContext?.campaigns || []).map(campaign => [String(campaign.campaignId), campaign])
    );

    for (const campaign of campaigns) {
      if (campaign.status !== 'ACTIVE') continue;

      // Get recent insights for this campaign (last 7 days)
      const cInsights = filterRecentInsights(insights, 'campaign_id', campaign.id, PERFORMANCE_LOOKBACK_DAYS, referenceDate, OPTIMIZER_WINDOW_OPTIONS);
      if (cInsights.length === 0) continue;
      const campaignHistory = filterRecentInsights(insights, 'campaign_id', campaign.id, SCHEDULE_LOOKBACK_DAYS, referenceDate, OPTIMIZER_WINDOW_OPTIONS);

      const totals = summarizeInsights(cInsights);
      const totalSpend = totals.spend;
      const totalPurchases = totals.purchases;
      const avgCPA = totals.cpa;
      const avgFrequency = averagePositiveField(cInsights, 'frequency');
      const evidence = this.buildDecisionEvidence(cInsights, totals);
      const hasDecisionData = evidence.observationDays >= rules.minDataDays && totalSpend >= rules.minSpendForDecision;
      const riskSnapshot = campaignRiskContext?.get(String(campaign.id)) || null;
      const trendContext = this.buildScaleTrendContext(cInsights, rules);

      // Rule: High CPA warning
      if (hasDecisionData && avgCPA && avgCPA > rules.cpaWarningThreshold) {
        this.addAction(OPTIMIZATION_TYPES.BUDGET, 'campaign', campaign.id, campaign.name,
          `Reduce daily budget by ${Math.min(rules.maxBudgetChangePercent, 15)}%`,
          `Last ${PERFORMANCE_LOOKBACK_DAYS}d CPA is $${avgCPA.toFixed(2)} (above $${rules.cpaWarningThreshold} threshold)`,
          `Expected to reduce wasted spend by ~$${(totalSpend * 0.15 / cInsights.length).toFixed(2)}/day`,
          avgCPA > rules.cpaPauseThreshold ? 'critical' : 'high'
        );
      }

      // Rule: CPA too high — pause campaign
      if (hasDecisionData && avgCPA && avgCPA > rules.cpaPauseThreshold) {
        this.addAction(OPTIMIZATION_TYPES.STATUS, 'campaign', campaign.id, campaign.name,
          `Pause campaign — CPA critically high`,
          `Last ${PERFORMANCE_LOOKBACK_DAYS}d CPA $${avgCPA.toFixed(2)} exceeds $${rules.cpaPauseThreshold} threshold`,
          `Save ~$${(totalSpend / cInsights.length).toFixed(2)}/day in wasted spend`,
          'critical'
        );
      }

      // Rule: Campaign performing well — increase budget
      const campaignEconomics = campaignEconomicsById.get(String(campaign.id)) || null;
      const weekdayScaleContext = buildWeekdayScaleContext(campaignHistory, rules, referenceDate, {
        lookbackDays: SCHEDULE_LOOKBACK_DAYS,
        cautionRatio: WEEKDAY_SCALE_CAUTION_RATIO,
        suppressRatio: WEEKDAY_SCALE_SUPPRESS_RATIO,
        includeCurrentDay: false,
      });

      const scaleDecision = this.buildScaleDecision({
        campaign,
        totals,
        evidence,
        rules,
        campaignEconomics,
        weekdayScaleContext,
        trendContext,
        riskSnapshot,
      });

      if (hasDecisionData && scaleDecision.shouldScale) {
        const confidenceLabel = campaignEconomics?.confidenceLabel || `${campaignEconomics?.confidence || 'low'} confidence`;
        const confidencePrefix = campaignEconomics?.confidence === 'high'
          ? 'Campaign contribution estimate is'
          : 'Directional campaign contribution estimate is';
        const caveatSuffix = scaleDecision.cautions.length > 0
          ? ` Scale caveats: ${scaleDecision.cautions.join('; ')}.`
          : '';
        const targetCpaSuffix = scaleDecision.dynamicTargetCpa > 0
          ? ` versus estimated target CPA $${scaleDecision.dynamicTargetCpa.toFixed(2)}`
          : '';
        const breakEvenSuffix = scaleDecision.breakEvenCpa
          ? ` and break-even CPA $${scaleDecision.breakEvenCpa.toFixed(2)}`
          : '';
        const scaleReason = `Last ${PERFORMANCE_LOOKBACK_DAYS}d CPA is $${avgCPA.toFixed(2)}${targetCpaSuffix}${breakEvenSuffix}, with ${totalPurchases} Meta-attributed purchases. ${confidencePrefix} ₩${campaignEconomics.estimatedTrueNetProfit.toLocaleString()} on ₩${campaignEconomics.estimatedRevenue.toLocaleString()} estimated attributable revenue at ${(campaignEconomics.estimatedMargin * 100).toFixed(1)}% margin (${confidenceLabel.toLowerCase()} daily AOV proxy).${caveatSuffix}`;
        this.addAction(OPTIMIZATION_TYPES.BUDGET, 'campaign', campaign.id, campaign.name,
          `Increase daily budget by $${(scaleDecision.increase / 100).toFixed(2)} (${scaleDecision.increasePercent}%)`,
          scaleReason,
          `Estimated +${scaleDecision.impactRange.min} to +${scaleDecision.impactRange.max} Meta-attributed purchases/day if CPA holds. Review after 48-72 hours.`,
          scaleDecision.priority
        );
      }

      // Rule: High frequency warning (audience saturation)
      if (hasDecisionData && avgFrequency > rules.fatigueFrequencyThreshold) {
        this.addAction(OPTIMIZATION_TYPES.TARGETING, 'campaign', campaign.id, campaign.name,
          `Expand audience — frequency is ${avgFrequency.toFixed(1)}`,
          `Last ${PERFORMANCE_LOOKBACK_DAYS}d average frequency of ${avgFrequency.toFixed(1)} indicates audience saturation (threshold: ${rules.fatigueFrequencyThreshold})`,
          `Reduce frequency by expanding lookalike or interest targeting`,
          'high'
        );
      }
    }
  }

  // ── 2. Ad Set-Level Analysis ──
  analyzeAdSets(adSets, insights, campaigns) {
    const rules = this.getRules();
    for (const adSet of adSets) {
      if (adSet.effective_status !== 'ACTIVE') continue;

      const asInsights = filterRecentInsights(insights, 'adset_id', adSet.id, PERFORMANCE_LOOKBACK_DAYS, getTodayInTimeZone(), OPTIMIZER_WINDOW_OPTIONS);
      if (asInsights.length === 0) continue;

      const totals = summarizeInsights(asInsights);
      const totalSpend = totals.spend;
      const totalPurchases = totals.purchases;
      const avgCPA = totals.cpa;
      const hasDecisionData = asInsights.length >= rules.minDataDays && totalSpend >= rules.minSpendForDecision;

      // Rule: Ad set spending with zero conversions
      if (hasDecisionData && totalPurchases === 0) {
        this.addAction(OPTIMIZATION_TYPES.STATUS, 'adset', adSet.id, adSet.name,
          `Pause ad set — $${totalSpend.toFixed(2)} spent with 0 purchases`,
          `Last ${PERFORMANCE_LOOKBACK_DAYS}d: $${totalSpend.toFixed(2)} spend, zero purchases`,
          `Save $${(totalSpend / asInsights.length).toFixed(2)}/day`,
          'critical'
        );
      }

      // Rule: CTR declining (compare first half vs second half)
      if (asInsights.length >= 6) {
        const half = Math.floor(asInsights.length / 2);
        const firstHalf = asInsights.slice(0, half);
        const secondHalf = asInsights.slice(half);
        const ctrFirst = firstHalf.reduce((s, i) => s + parseFloat(i.ctr || 0), 0) / firstHalf.length;
        const ctrSecond = secondHalf.reduce((s, i) => s + parseFloat(i.ctr || 0), 0) / secondHalf.length;

        if (ctrFirst > 0 && ((ctrFirst - ctrSecond) / ctrFirst * 100) > rules.fatigueCtrDecayPercent) {
          this.addAction(OPTIMIZATION_TYPES.CREATIVE, 'adset', adSet.id, adSet.name,
            `Refresh creatives — CTR declining ${((ctrFirst - ctrSecond) / ctrFirst * 100).toFixed(0)}%`,
            `CTR dropped from ${ctrFirst.toFixed(2)}% to ${ctrSecond.toFixed(2)}% (${((ctrFirst - ctrSecond) / ctrFirst * 100).toFixed(0)}% decay)`,
            `Restoring CTR could reduce CPA by ~${((ctrFirst - ctrSecond) / ctrFirst * 50).toFixed(0)}%`,
            'high'
          );
        }
      }

      // Rule: Ad set CPA much higher than campaign average
      const parentCampaign = campaigns.find(c => c.id === adSet.campaign_id);
      if (parentCampaign && hasDecisionData && avgCPA) {
        const campaignInsights = filterRecentInsights(insights, 'campaign_id', adSet.campaign_id, PERFORMANCE_LOOKBACK_DAYS, getTodayInTimeZone(), OPTIMIZER_WINDOW_OPTIONS);
        const campaignTotals = summarizeInsights(campaignInsights);
        const campaignCPA = campaignTotals.cpa;

        if (campaignCPA && avgCPA > campaignCPA * 1.5) {
          this.addAction(OPTIMIZATION_TYPES.BUDGET, 'adset', adSet.id, adSet.name,
            `Reduce budget — CPA ${((avgCPA / campaignCPA - 1) * 100).toFixed(0)}% above campaign average`,
            `Ad set CPA: $${avgCPA.toFixed(2)} vs campaign avg: $${campaignCPA.toFixed(2)}`,
            `Reallocate budget to better performing ad sets`,
            'high'
          );
        }
      }
    }
  }

  // ── 3. Ad-Level Analysis (Fatigue Detection) ──
  analyzeAds(ads, insights) {
    const rules = this.getRules();
    for (const ad of ads) {
      if (ad.effective_status !== 'ACTIVE') continue;

      const adInsights = filterRecentInsights(insights, 'ad_id', ad.id, PERFORMANCE_LOOKBACK_DAYS, getTodayInTimeZone(), OPTIMIZER_WINDOW_OPTIONS);
      if (adInsights.length < 3) continue;

      const totals = summarizeInsights(adInsights);
      const totalSpend = totals.spend;
      const totalPurchases = totals.purchases;
      const fatigueSnapshot = buildFatigueSnapshot(adInsights);
      const fatigue = classifyFatigue(fatigueSnapshot, {
        frequencyThreshold: rules.fatigueFrequencyThreshold,
        ctrDecayPercent: rules.fatigueCtrDecayPercent,
        minDataDays: rules.minDataDays,
      });

      if (fatigue.status === 'danger') {
        this.addAction(OPTIMIZATION_TYPES.CREATIVE, 'ad', ad.id, ad.name,
          `Ad fatigued — pause & replace creative`,
          `Last ${PERFORMANCE_LOOKBACK_DAYS}d: frequency ${fatigueSnapshot.lastFrequency.toFixed(1)}, CTR down ${fatigueSnapshot.ctrDecayPercent.toFixed(0)}% from peak (${fatigueSnapshot.peakCTR.toFixed(2)}% → ${fatigueSnapshot.recentCTR.toFixed(2)}%)`,
          `Replacing creative typically restores CTR within 3-5 days`,
          'high'
        );
      }

      // Fatigue: CPM rising significantly
      if (fatigue.flags.cpmPressure && totalSpend >= rules.minSpendForDecision) {
        this.addAction(OPTIMIZATION_TYPES.BID, 'ad', ad.id, ad.name,
          `CPM rising ${fatigueSnapshot.cpmRisePercent.toFixed(0)}% — review bid strategy`,
          `Recent CPM: $${fatigueSnapshot.recentCPM.toFixed(2)} vs average: $${fatigueSnapshot.avgCPM.toFixed(2)}`,
          `Rising CPM with stable CTR suggests increased competition or audience fatigue`,
          'medium'
        );
      }

      // Ad spending with no purchases
      if (adInsights.length >= rules.minDataDays && totalSpend > rules.minSpendForDecision * 1.5 && totalPurchases === 0) {
        this.addAction(OPTIMIZATION_TYPES.STATUS, 'ad', ad.id, ad.name,
          `Pause ad — $${totalSpend.toFixed(2)} spent, 0 purchases`,
          `No purchases after $${totalSpend.toFixed(2)} spend over the last ${PERFORMANCE_LOOKBACK_DAYS}d`,
          `Save daily spend and reallocate to converting ads`,
          'critical'
        );
      }
    }
  }

  // ── 4. Budget Reallocation ──
  analyzeBudgetReallocation(campaigns, insights, campaignEconomicsContext = null) {
    const rules = this.getRules();
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
        'high'
      );
    }
  }

  // ── 5. Scheduling Optimizations ──
  analyzeScheduling(adSetInsights) {
    const rules = this.getRules();
    const recentInsights = filterAllRecentInsights(adSetInsights, SCHEDULE_LOOKBACK_DAYS, getTodayInTimeZone(), OPTIMIZER_WINDOW_OPTIONS);
    if (recentInsights.length < 14) return;

    // Aggregate by day of week
    const dayPerf = {};
    for (const insight of recentInsights) {
      const date = new Date(insight.date_start);
      const day = date.toLocaleDateString('en-US', { weekday: 'long' });
      if (!dayPerf[day]) dayPerf[day] = { spend: 0, purchases: 0 };
      dayPerf[day].spend += summarizeInsights([insight]).spend;
      dayPerf[day].purchases += getPurchases(insight.actions);
    }

    // Find best and worst days
    const days = Object.entries(dayPerf).map(([day, d]) => ({
      day, ...d, cpa: d.purchases > 0 ? d.spend / d.purchases : Infinity
    }));

    const bestDays = days.filter(d => d.purchases > 0).sort((a, b) => a.cpa - b.cpa);
    const worstDays = days.filter(d => d.cpa === Infinity || d.cpa > rules.cpaWarningThreshold);

    if (bestDays.length > 0 && worstDays.length > 0) {
      const bestStr = bestDays.slice(0, 2).map(d => `${d.day} ($${d.cpa.toFixed(2)} CPA)`).join(', ');
      const worstStr = worstDays.slice(0, 2).map(d => d.day).join(', ');

      this.addAction(OPTIMIZATION_TYPES.SCHEDULE, 'account', config.meta.adAccountId, 'SHUE Ad Account',
        `Consider dayparting: best performance on ${bestDays[0].day}`,
        `Last ${SCHEDULE_LOOKBACK_DAYS}d best days: ${bestStr}. Underperforming: ${worstStr}`,
        `Shifting more budget to high-performing days could improve overall CPA`,
        'low'
      );
    }
  }

  // ── 6. ROAS-Based Optimizations ──
  analyzeROAS(campaignInsights, revenueData, revenueSource, profitContext = null) {
    const rules = this.getRules();
    if (!revenueData) return;
    if (revenueSource?.stale || revenueSource?.status !== 'connected') return;

    const recentCampaignInsights = filterAllRecentInsights(campaignInsights, PERFORMANCE_LOOKBACK_DAYS, getTodayInTimeZone(), OPTIMIZER_WINDOW_OPTIONS);
    const totalSpend = summarizeInsights(recentCampaignInsights).spend;
    const netRevenue = sumRecentNetRevenue(revenueData, PERFORMANCE_LOOKBACK_DAYS, getTodayInTimeZone(), OPTIMIZER_WINDOW_OPTIONS);
    if (totalSpend < rules.minSpendForDecision) return;

    if (profitContext?.hasReliableCoverage) {
      if (profitContext.trueNetProfit < 0) {
        this.addAction(OPTIMIZATION_TYPES.BUDGET, 'account', config.meta.adAccountId, 'Overall Profitability',
          `True net profit is -₩${Math.abs(profitContext.trueNetProfit).toLocaleString()} — reduce spend`,
          `Last ${PERFORMANCE_LOOKBACK_DAYS}d true net profit is -₩${Math.abs(profitContext.trueNetProfit).toLocaleString()} after ₩${profitContext.cogs.toLocaleString()} COGS, ₩${profitContext.shipping.toLocaleString()} shipping, ₩${profitContext.paymentFees.toLocaleString()} fees, and ₩${profitContext.adSpendKRW.toLocaleString()} ad spend`,
          `Reduce wasted spend until contribution margin turns positive`,
          'critical'
        );
        return;
      }

      if (profitContext.trueNetProfit > 0 && profitContext.margin >= PROFIT_SCALE_MARGIN_THRESHOLD) {
        this.addAction(OPTIMIZATION_TYPES.BUDGET, 'account', config.meta.adAccountId, 'Overall Profitability',
          `True net profit is ₩${profitContext.trueNetProfit.toLocaleString()} — room to scale`,
          `Last ${PERFORMANCE_LOOKBACK_DAYS}d true net profit is ₩${profitContext.trueNetProfit.toLocaleString()} on ₩${profitContext.netRevenue.toLocaleString()} net revenue (${(profitContext.margin * 100).toFixed(1)}% true net margin)`,
          `Consider increasing total ad spend by 10-20% while margins stay above ${(PROFIT_SCALE_MARGIN_THRESHOLD * 100).toFixed(0)}%`,
          'medium'
        );
      }
      return;
    }

    const totalSpendKRW = convertUsdToKrw(totalSpend);
    const roas = calcROAS(netRevenue, totalSpend);

    if (roas < rules.roasMinimum) {
      this.addAction(OPTIMIZATION_TYPES.BUDGET, 'account', config.meta.adAccountId, 'Overall ROAS',
        `ROAS is ${roas.toFixed(2)}x — below ${rules.roasMinimum}x minimum`,
        `Last ${PERFORMANCE_LOOKBACK_DAYS}d net revenue ₩${netRevenue.toLocaleString()} / ad spend ₩${totalSpendKRW.toLocaleString()} = ${roas.toFixed(2)}x ROAS`,
        `Consider reducing overall spend or improving conversion rate`,
        'critical'
      );
    }

    if (roas > 4) {
      this.addAction(OPTIMIZATION_TYPES.BUDGET, 'account', config.meta.adAccountId, 'Overall ROAS',
        `ROAS is ${roas.toFixed(2)}x — strong performance, room to scale`,
        `Last ${PERFORMANCE_LOOKBACK_DAYS}d net revenue ₩${netRevenue.toLocaleString()} / ad spend ₩${totalSpendKRW.toLocaleString()} = ${roas.toFixed(2)}x ROAS`,
        `Consider increasing total ad spend by 10-20% to capture more volume`,
        'medium'
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

      // Budget changes
      if (action.type === OPTIMIZATION_TYPES.BUDGET && (action.level === 'campaign' || action.level === 'adset')) {
        const entities = action.level === 'campaign' ? await meta.getCampaigns() : await meta.getAdSets();
        const entity = entities.find(item => item.id === action.targetId);
        const currentBudget = Number.parseInt(entity?.daily_budget || 0, 10);

        if (!Number.isFinite(currentBudget) || currentBudget <= 0) {
          action.executed = false;
          action.executionResult = 'Failed: current daily budget unavailable';
          return action;
        }

        let newBudget = currentBudget;
        if (isBudgetDecreaseAction(action.action)) {
          const match = action.action.match(/(\d+)%/);
          const pct = match ? parseInt(match[1], 10) : rules.maxBudgetChangePercent;
          newBudget = Math.max(100, Math.round(currentBudget * (1 - pct / 100)));
        } else if (isBudgetIncreaseAction(action.action)) {
          newBudget = Math.round(currentBudget * (1 + rules.maxBudgetChangePercent / 100));
        } else {
          action.executed = false;
          action.executionResult = 'Suggestion only — unsupported budget action';
          return action;
        }

        result = action.level === 'campaign'
          ? await meta.updateCampaignBudget(action.targetId, newBudget)
          : await meta.updateAdSetBudget(action.targetId, newBudget);
      }

      // Status changes
      if (action.type === OPTIMIZATION_TYPES.STATUS) {
        if (action.level === 'campaign') {
          result = await meta.updateCampaignStatus(action.targetId, 'PAUSED');
        } else if (action.level === 'adset') {
          result = await meta.updateAdSetStatus(action.targetId, 'PAUSED');
        } else if (action.level === 'ad') {
          result = await meta.updateAdStatus(action.targetId, 'PAUSED');
        }
      }

      if (action.type === OPTIMIZATION_TYPES.BID && action.level === 'adset') {
        const adSets = await meta.getAdSets();
        const adSet = adSets.find(item => item.id === action.targetId);
        const currentBid = Number.parseInt(adSet?.bid_amount || 0, 10);

        if (!Number.isFinite(currentBid) || currentBid <= 0) {
          action.executed = false;
          action.executionResult = 'Failed: current bid unavailable';
          return action;
        }

        const nextBid = Math.max(1, Math.round(currentBid * 0.9));
        result = await meta.updateAdSetBid(action.targetId, nextBid);
      }

      action.executed = true;
      action.executionResult = result ? 'Success' : 'No action taken';
      console.log(`[OPTIMIZER] Executed: ${action.action} → ${action.executionResult}`);
    } catch (err) {
      action.executed = false;
      action.executionResult = `Failed: ${err.message}`;
      console.error(`[OPTIMIZER] Execution failed: ${err.message}`);
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

    console.log(`[OPTIMIZER] ${approvalQueue.length} approval-required actions to process...`);

    for (const action of approvalQueue) {
      console.log(`[OPTIMIZER] Requesting Telegram approval for: ${action.action}`);
      const approvalId = await telegram.requestApproval(action);

      if (!approvalId) {
        action.executed = false;
        action.executionResult = 'Failed to send Telegram approval request';
        console.error(`[OPTIMIZER] Telegram request failed for: ${action.action}`);
        continue;
      }

      action.approvalStatus = 'pending';
      action.approvalRequestedAt = new Date().toISOString();
      const response = await telegram.waitForApproval(approvalId, 300000);

      if (response.approved) {
        console.log(`[OPTIMIZER] ✅ APPROVED: ${action.action}`);
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
        console.log(`[OPTIMIZER] ❌ REJECTED: ${action.action} — ${response.reason}`);
      }

      await new Promise(r => setTimeout(r, 1000));
    }

    return approvalQueue;
  }

  async executeHighPriority() {
    return this.processApprovalQueue();
  }
}

module.exports = OptimizationEngine;
module.exports.buildProfitContext = buildProfitContext;
module.exports.buildWeekdayScaleContext = buildWeekdayScaleContext;
