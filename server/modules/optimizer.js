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
  extractPositiveFieldValues,
  getPurchases,
  summarizeInsights,
} = require('../domain/metrics');
const {
  OPTIMIZATION_TYPES,
  isBudgetDecreaseAction,
  isBudgetIncreaseAction,
  requiresApproval,
} = require('../domain/optimizationSemantics');
const runtimeSettings = require('../runtime/runtimeSettings');

// ═══════════════════════════════════════════════
// OPTIMIZATION RULES
// ═══════════════════════════════════════════════

class OptimizationEngine {
  constructor() {
    this.actions = []; // Generated actions for this scan
    this.scanId = Date.now();
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
  async analyze(campaignData, adSetData, adData, campaignInsights, adSetInsights, adInsights, revenueData) {
    const rules = this.getRules();
    this.actions = [];
    this.scanId = Date.now();

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
    this.analyzeROAS(campaignInsights, revenueData);

    console.log(`[OPTIMIZER] Scan complete. Generated ${this.actions.length} optimizations.`);
    return this.actions;
  }

  // ── 1. Campaign-Level Analysis ──
  analyzeCampaigns(campaigns, insights, revenueData) {
    const rules = this.getRules();
    for (const campaign of campaigns) {
      if (campaign.status !== 'ACTIVE') continue;

      // Get recent insights for this campaign (last 7 days)
      const cInsights = insights.filter(i => i.campaign_id === campaign.id);
      if (cInsights.length === 0) continue;

      const totals = summarizeInsights(cInsights);
      const totalSpend = totals.spend;
      const totalPurchases = totals.purchases;
      const avgCPA = totals.cpa;
      const avgCTR = averagePositiveField(cInsights, 'ctr');
      const avgFrequency = averagePositiveField(cInsights, 'frequency');

      // Rule: High CPA warning
      if (avgCPA && avgCPA > rules.cpaWarningThreshold) {
        this.addAction(OPTIMIZATION_TYPES.BUDGET, 'campaign', campaign.id, campaign.name,
          `Reduce daily budget by ${Math.min(rules.maxBudgetChangePercent, 15)}%`,
          `CPA is $${avgCPA.toFixed(2)} (above $${rules.cpaWarningThreshold} threshold) over ${cInsights.length} days`,
          `Expected to reduce wasted spend by ~$${(totalSpend * 0.15 / cInsights.length).toFixed(2)}/day`,
          avgCPA > rules.cpaPauseThreshold ? 'critical' : 'high'
        );
      }

      // Rule: CPA too high — pause campaign
      if (avgCPA && avgCPA > rules.cpaPauseThreshold && cInsights.length >= rules.minDataDays) {
        this.addAction(OPTIMIZATION_TYPES.STATUS, 'campaign', campaign.id, campaign.name,
          `Pause campaign — CPA critically high`,
          `CPA $${avgCPA.toFixed(2)} exceeds $${rules.cpaPauseThreshold} threshold for ${cInsights.length} consecutive days`,
          `Save ~$${(totalSpend / cInsights.length).toFixed(2)}/day in wasted spend`,
          'critical'
        );
      }

      // Rule: Campaign performing well — increase budget
      if (avgCPA && avgCPA < rules.cpaWarningThreshold * 0.5 && totalPurchases >= 5) {
        const currentBudget = parseInt(campaign.daily_budget || 0);
        const increase = Math.round(currentBudget * rules.maxBudgetChangePercent / 100);
        this.addAction(OPTIMIZATION_TYPES.BUDGET, 'campaign', campaign.id, campaign.name,
          `Increase daily budget by $${(increase / 100).toFixed(2)} (${rules.maxBudgetChangePercent}%)`,
          `Strong CPA of $${avgCPA.toFixed(2)} with ${totalPurchases} purchases — room to scale`,
          `Potential ${Math.round(increase / 100 / avgCPA)} additional purchases/day`,
          'medium'
        );
      }

      // Rule: High frequency warning (audience saturation)
      if (avgFrequency > rules.fatigueFrequencyThreshold) {
        this.addAction(OPTIMIZATION_TYPES.TARGETING, 'campaign', campaign.id, campaign.name,
          `Expand audience — frequency is ${avgFrequency.toFixed(1)}`,
          `Average frequency of ${avgFrequency.toFixed(1)} indicates audience saturation (threshold: ${rules.fatigueFrequencyThreshold})`,
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

      const asInsights = insights.filter(i => i.adset_id === adSet.id);
      if (asInsights.length === 0) continue;

      const totals = summarizeInsights(asInsights);
      const totalSpend = totals.spend;
      const totalPurchases = totals.purchases;
      const avgCPA = totals.cpa;
      const avgCTR = averagePositiveField(asInsights, 'ctr');

      // Rule: Ad set spending with zero conversions
      if (totalSpend > rules.minSpendForDecision && totalPurchases === 0) {
        this.addAction(OPTIMIZATION_TYPES.STATUS, 'adset', adSet.id, adSet.name,
          `Pause ad set — $${totalSpend.toFixed(2)} spent with 0 purchases`,
          `${asInsights.length} days of data, $${totalSpend.toFixed(2)} total spend, zero conversions`,
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
      if (parentCampaign && avgCPA) {
        const campaignInsights = insights.filter(i => i.campaign_id === adSet.campaign_id);
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

      const adInsights = insights.filter(i => i.ad_id === ad.id);
      if (adInsights.length < 3) continue;

      const totals = summarizeInsights(adInsights);
      const totalSpend = totals.spend;
      const totalPurchases = totals.purchases;

      // Frequency trend
      const frequencies = extractPositiveFieldValues(adInsights, 'frequency');
      const latestFreq = frequencies.length > 0 ? frequencies[frequencies.length - 1] : 0;
      const avgFreq = frequencies.length > 0 ? frequencies.reduce((a, b) => a + b, 0) / frequencies.length : 0;

      // CTR trend
      const ctrs = extractPositiveFieldValues(adInsights, 'ctr');
      const peakCTR = Math.max(...ctrs, 0);
      const recentCTR = ctrs.length >= 3 ? ctrs.slice(-3).reduce((a, b) => a + b, 0) / 3 : ctrs[ctrs.length - 1] || 0;

      // CPM trend
      const cpms = extractPositiveFieldValues(adInsights, 'cpm');
      const avgCPM = cpms.length > 0 ? cpms.reduce((a, b) => a + b, 0) / cpms.length : 0;
      const recentCPM = cpms.length >= 3 ? cpms.slice(-3).reduce((a, b) => a + b, 0) / 3 : cpms[cpms.length - 1] || 0;

      // Fatigue: High frequency + CTR decay
      if (latestFreq > rules.fatigueFrequencyThreshold && peakCTR > 0) {
        const ctrDecay = ((peakCTR - recentCTR) / peakCTR) * 100;
        if (ctrDecay > rules.fatigueCtrDecayPercent) {
          this.addAction(OPTIMIZATION_TYPES.CREATIVE, 'ad', ad.id, ad.name,
            `Ad fatigued — pause & replace creative`,
            `Frequency: ${latestFreq.toFixed(1)}, CTR dropped ${ctrDecay.toFixed(0)}% from peak (${peakCTR.toFixed(2)}% → ${recentCTR.toFixed(2)}%)`,
            `Replacing creative typically restores CTR within 3-5 days`,
            'high'
          );
        }
      }

      // Fatigue: CPM rising significantly
      if (avgCPM > 0 && recentCPM > avgCPM * 1.4) {
        this.addAction(OPTIMIZATION_TYPES.BID, 'ad', ad.id, ad.name,
          `CPM rising ${((recentCPM / avgCPM - 1) * 100).toFixed(0)}% — review bid strategy`,
          `Recent CPM: $${recentCPM.toFixed(2)} vs average: $${avgCPM.toFixed(2)}`,
          `Rising CPM with stable CTR suggests increased competition or audience fatigue`,
          'medium'
        );
      }

      // Ad spending with no purchases
      if (totalSpend > rules.minSpendForDecision * 1.5 && totalPurchases === 0) {
        this.addAction(OPTIMIZATION_TYPES.STATUS, 'ad', ad.id, ad.name,
          `Pause ad — $${totalSpend.toFixed(2)} spent, 0 purchases`,
          `No conversions after $${totalSpend.toFixed(2)} spend across ${adInsights.length} days`,
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
      const cInsights = insights.filter(i => i.campaign_id === c.id);
      const totals = summarizeInsights(cInsights);
      return { ...c, spend: totals.spend, purchases: totals.purchases, cpa: totals.cpa ?? Infinity };
    });

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
    // Aggregate by day of week
    const dayPerf = {};
    for (const insight of adSetInsights) {
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
        `Best days: ${bestStr}. Underperforming: ${worstStr}`,
        `Shifting more budget to high-performing days could improve overall CPA`,
        'low'
      );
    }
  }

  // ── 6. ROAS-Based Optimizations ──
  analyzeROAS(campaignInsights, revenueData) {
    const rules = this.getRules();
    if (!revenueData) return;

    const totalSpend = summarizeInsights(campaignInsights).spend;
    const totalSpendKRW = convertUsdToKrw(totalSpend);
    const netRevenue = revenueData.netRevenue || 0;
    const roas = calcROAS(netRevenue, totalSpend);

    if (roas < rules.roasMinimum) {
      this.addAction(OPTIMIZATION_TYPES.BUDGET, 'account', config.meta.adAccountId, 'Overall ROAS',
        `ROAS is ${roas.toFixed(2)}x — below ${rules.roasMinimum}x minimum`,
        `Net revenue ₩${netRevenue.toLocaleString()} / ad spend ₩${totalSpendKRW.toLocaleString()} = ${roas.toFixed(2)}x ROAS`,
        `Consider reducing overall spend or improving conversion rate`,
        'critical'
      );
    }

    if (roas > 4) {
      this.addAction(OPTIMIZATION_TYPES.BUDGET, 'account', config.meta.adAccountId, 'Overall ROAS',
        `ROAS is ${roas.toFixed(2)}x — strong performance, room to scale`,
        `Net revenue ₩${netRevenue.toLocaleString()} / ad spend ₩${totalSpendKRW.toLocaleString()} = ${roas.toFixed(2)}x ROAS`,
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
