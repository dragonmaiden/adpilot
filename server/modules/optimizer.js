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
  OPTIMIZATION_TYPES,
  isBudgetDecreaseAction,
  isBudgetIncreaseAction,
  requiresApproval,
} = require('../domain/optimizationSemantics');
const runtimeSettings = require('../runtime/runtimeSettings');
const { getTodayInTimeZone, shiftDate } = require('../domain/time');

const PERFORMANCE_LOOKBACK_DAYS = 7;
const SCHEDULE_LOOKBACK_DAYS = 28;

// ═══════════════════════════════════════════════
// OPTIMIZATION RULES
// ═══════════════════════════════════════════════

function getWindowStart(days) {
  return shiftDate(getTodayInTimeZone(), -(days - 1));
}

function filterRecentInsights(insights, idKey, idValue, days = PERFORMANCE_LOOKBACK_DAYS) {
  const windowStart = getWindowStart(days);
  return (Array.isArray(insights) ? insights : [])
    .filter(row => row?.[idKey] === idValue && row?.date_start >= windowStart)
    .sort((left, right) => String(left?.date_start || '').localeCompare(String(right?.date_start || '')));
}

function filterAllRecentInsights(insights, days = PERFORMANCE_LOOKBACK_DAYS) {
  const windowStart = getWindowStart(days);
  return (Array.isArray(insights) ? insights : [])
    .filter(row => row?.date_start >= windowStart)
    .sort((left, right) => String(left?.date_start || '').localeCompare(String(right?.date_start || '')));
}

function sumRecentNetRevenue(revenueData, days = PERFORMANCE_LOOKBACK_DAYS) {
  const dailyRevenue = revenueData?.dailyRevenue;
  const windowStart = getWindowStart(days);
  if (!dailyRevenue || typeof dailyRevenue !== 'object') return 0;

  return Object.entries(dailyRevenue).reduce((sum, [date, value]) => {
    if (date < windowStart) return sum;
    const paid = Number(value?.revenue || 0);
    const refunded = Number(value?.refunded || 0);
    return sum + paid - refunded;
  }, 0);
}

class OptimizationEngine {
  constructor(scanId = Date.now()) {
    this.actions = []; // Generated actions for this scan
    this.scanId = scanId;
  }

  getRules() {
    return runtimeSettings.getRules();
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
      executionResult: null,
    });
  }

  // ── Run all optimization checks ──
  async analyze(campaignData, adSetData, adData, campaignInsights, adSetInsights, adInsights, revenueData, revenueSource = null) {
    const rules = this.getRules();
    this.actions = [];

    console.log(`[OPTIMIZER] Starting scan ${this.scanId}...`);

    // 1. Campaign-level optimizations
    this.analyzeCampaigns(campaignData, campaignInsights, revenueData);

    // 2. Ad set-level optimizations
    this.analyzeAdSets(adSetData, adSetInsights, campaignData);

    // 3. Ad-level optimizations (fatigue, creative performance)
    this.analyzeAds(adData, adInsights);

    // 4. Budget reallocation across campaigns
    if (rules.budgetReallocationEnabled) {
      this.analyzeBudgetReallocation(campaignData, campaignInsights);
    }

    // 5. Scheduling optimizations
    this.analyzeScheduling(adSetInsights);

    // 6. ROAS-based optimizations
    this.analyzeROAS(campaignInsights, revenueData, revenueSource);

    console.log(`[OPTIMIZER] Scan complete. Generated ${this.actions.length} optimizations.`);
    return this.actions;
  }

  // ── 1. Campaign-Level Analysis ──
  analyzeCampaigns(campaigns, insights, revenueData) {
    const rules = this.getRules();
    for (const campaign of campaigns) {
      if (campaign.status !== 'ACTIVE') continue;

      // Get recent insights for this campaign (last 7 days)
      const cInsights = filterRecentInsights(insights, 'campaign_id', campaign.id);
      if (cInsights.length === 0) continue;

      const totals = summarizeInsights(cInsights);
      const totalSpend = totals.spend;
      const totalPurchases = totals.purchases;
      const avgCPA = totals.cpa;
      const avgFrequency = averagePositiveField(cInsights, 'frequency');
      const hasDecisionData = cInsights.length >= rules.minDataDays && totalSpend >= rules.minSpendForDecision;

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
      if (hasDecisionData && avgCPA && avgCPA < rules.cpaWarningThreshold * 0.5 && totalPurchases >= 5) {
        const currentBudget = parseInt(campaign.daily_budget || 0);
        const increase = Math.round(currentBudget * rules.maxBudgetChangePercent / 100);
        this.addAction(OPTIMIZATION_TYPES.BUDGET, 'campaign', campaign.id, campaign.name,
          `Increase daily budget by $${(increase / 100).toFixed(2)} (${rules.maxBudgetChangePercent}%)`,
          `Last ${PERFORMANCE_LOOKBACK_DAYS}d CPA is $${avgCPA.toFixed(2)} with ${totalPurchases} purchases — room to scale`,
          `Potential ${Math.round(increase / 100 / avgCPA)} additional purchases/day`,
          'medium'
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

      const asInsights = filterRecentInsights(insights, 'adset_id', adSet.id);
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
        const campaignInsights = filterRecentInsights(insights, 'campaign_id', adSet.campaign_id);
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

      const adInsights = filterRecentInsights(insights, 'ad_id', ad.id);
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
  analyzeBudgetReallocation(campaigns, insights) {
    const rules = this.getRules();
    const activeCampaigns = campaigns.filter(c => c.status === 'ACTIVE');
    if (activeCampaigns.length < 2) return;

    // Calculate CPA for each active campaign
    const campaignPerf = activeCampaigns.map(c => {
      const cInsights = filterRecentInsights(insights, 'campaign_id', c.id);
      const totals = summarizeInsights(cInsights);
      return { ...c, spend: totals.spend, purchases: totals.purchases, cpa: totals.cpa ?? Infinity };
    }).filter(campaign => campaign.spend >= rules.minSpendForDecision);

    if (campaignPerf.length < 2) return;

    // Sort by CPA (best first)
    campaignPerf.sort((a, b) => a.cpa - b.cpa);

    const best = campaignPerf[0];
    const worst = campaignPerf[campaignPerf.length - 1];

    // If worst campaign CPA is 2x+ the best, suggest reallocation
    if (best.cpa < Infinity && worst.cpa > best.cpa * 2 && worst.spend > rules.minSpendForDecision) {
      const worstBudget = parseInt(worst.daily_budget || 0);
      const moveAmount = Math.round(worstBudget * 0.5); // Move 50% of worst's budget

      this.addAction(OPTIMIZATION_TYPES.BUDGET, 'campaign', worst.id, `${worst.name} → ${best.name}`,
        `Reallocate $${(moveAmount / 100).toFixed(2)}/day from worst → best campaign`,
        `${worst.name} CPA: $${worst.cpa.toFixed(2)} vs ${best.name} CPA: $${best.cpa.toFixed(2)} (${(worst.cpa / best.cpa).toFixed(1)}x worse)`,
        `Expected ~${Math.round(moveAmount / 100 / best.cpa)} additional purchases/day at better CPA`,
        'high'
      );
    }
  }

  // ── 5. Scheduling Optimizations ──
  analyzeScheduling(adSetInsights) {
    const rules = this.getRules();
    const recentInsights = filterAllRecentInsights(adSetInsights, SCHEDULE_LOOKBACK_DAYS);
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
  analyzeROAS(campaignInsights, revenueData, revenueSource) {
    const rules = this.getRules();
    if (!revenueData) return;
    if (revenueSource?.stale || revenueSource?.status !== 'connected') return;

    const recentCampaignInsights = filterAllRecentInsights(campaignInsights, PERFORMANCE_LOOKBACK_DAYS);
    const totalSpend = summarizeInsights(recentCampaignInsights).spend;
    const netRevenue = sumRecentNetRevenue(revenueData, PERFORMANCE_LOOKBACK_DAYS);
    if (totalSpend < rules.minSpendForDecision) return;

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

    try {
      let result;

      // Budget changes
      if (action.type === OPTIMIZATION_TYPES.BUDGET && action.level === 'campaign') {
        // Parse the budget change from the action description
        if (isBudgetDecreaseAction(action.action)) {
          const match = action.action.match(/(\d+)%/);
          const pct = match ? parseInt(match[1]) : rules.maxBudgetChangePercent;
          // We need the current budget - fetch it
          const campaigns = await meta.getCampaigns();
          const campaign = campaigns.find(c => c.id === action.targetId);
          if (campaign) {
            const currentBudget = parseInt(campaign.daily_budget);
            const newBudget = Math.round(currentBudget * (1 - pct / 100));
            result = await meta.updateCampaignBudget(action.targetId, newBudget);
          }
        } else if (isBudgetIncreaseAction(action.action)) {
          const campaigns = await meta.getCampaigns();
          const campaign = campaigns.find(c => c.id === action.targetId);
          if (campaign) {
            const currentBudget = parseInt(campaign.daily_budget);
            const newBudget = Math.round(currentBudget * (1 + rules.maxBudgetChangePercent / 100));
            result = await meta.updateCampaignBudget(action.targetId, newBudget);
          }
        }
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

  // Execute all critical and high priority actions (with Telegram approval)
  async executeHighPriority() {
    const toExecute = this.actions.filter(a =>
      (a.priority === 'critical' || a.priority === 'high') && !a.executed
    );

    console.log(`[OPTIMIZER] ${toExecute.length} high-priority actions to process...`);

    for (const action of toExecute) {
      if (this.requiresApproval(action)) {
        // Request Telegram approval
        console.log(`[OPTIMIZER] Requesting Telegram approval for: ${action.action}`);
        const approvalId = await telegram.requestApproval(action);

        if (!approvalId) {
          action.executed = false;
          action.executionResult = 'Failed to send Telegram approval request';
          console.error(`[OPTIMIZER] Telegram request failed for: ${action.action}`);
          continue;
        }

        // Wait for user response (5 min timeout)
        const response = await telegram.waitForApproval(approvalId, 300000);

        if (response.approved) {
          console.log(`[OPTIMIZER] ✅ APPROVED: ${action.action}`);
          await this.executeAction(action);
          // Notify execution result
          const resultEmoji = action.executed ? '✅' : '❌';
          await telegram.sendMessage(
            `${resultEmoji} <b>Execution Result</b>\n\n<b>Action:</b> ${action.action}\n<b>Result:</b> ${action.executionResult}`
          );
        } else {
          action.executed = false;
          action.executionResult = `Rejected: ${response.reason}`;
          console.log(`[OPTIMIZER] ❌ REJECTED: ${action.action} — ${response.reason}`);
        }
      } else {
        // Non-money actions (schedule suggestions, creative insights) execute directly
        await this.executeAction(action);
      }

      // Rate limiting: wait 1 second between actions
      await new Promise(r => setTimeout(r, 1000));
    }

    return toExecute;
  }
}

module.exports = OptimizationEngine;
