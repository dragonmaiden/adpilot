const crypto = require('crypto');
const runtimeSettings = require('../runtime/runtimeSettings');
const { summarizeInsights } = require('../domain/metrics');
const { buildFatigueSnapshot, classifyFatigue } = require('../domain/fatigue');
const { getOptimizationStatus } = require('../domain/optimizationSemantics');
const {
  filterRecentInsights,
  filterAllRecentInsights,
  buildProfitContext,
  buildWeekdayScaleContext,
} = require('../domain/performanceContext');
const { getTodayInTimeZone } = require('../domain/time');

const PERFORMANCE_LOOKBACK_DAYS = 7;
const FATIGUE_LOOKBACK_DAYS = 14;
const SCHEDULE_LOOKBACK_DAYS = 28;
const MIN_PROFIT_COVERAGE_RATIO = 0.8;
const WEEKDAY_SCALE_CAUTION_RATIO = 1.15;
const WEEKDAY_SCALE_SUPPRESS_RATIO = 1.4;
const STARTUP_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DIGEST_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const ALERT_DUPLICATE_COOLDOWN_MS = 90 * 60 * 1000;

function formatUsd(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function formatKrw(value) {
  return `₩${Math.round(Number(value || 0)).toLocaleString()}`;
}

function toPercent(value, digits = 1) {
  return `${(Number(value || 0) * 100).toFixed(digits)}%`;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function hash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function parseIso(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function hoursSince(iso, now = new Date()) {
  const date = parseIso(iso);
  if (!date) return Infinity;
  return (now.getTime() - date.getTime()) / (60 * 60 * 1000);
}

function shouldSendStartupMessage(state, now = new Date()) {
  const lastSentAt = state?.startup?.sentAt;
  if (!lastSentAt) return true;
  return (now.getTime() - new Date(lastSentAt).getTime()) >= STARTUP_COOLDOWN_MS;
}

function buildActiveAdDiagnostics(ads, adInsights, referenceDate = getTodayInTimeZone()) {
  return (Array.isArray(ads) ? ads : [])
    .filter(ad => String(ad?.status || ad?.effective_status || '').toUpperCase() === 'ACTIVE')
    .map(ad => {
      const history = filterRecentInsights(adInsights, 'ad_id', ad.id, FATIGUE_LOOKBACK_DAYS, referenceDate);
      const spendMetrics = summarizeInsights(history);
      const fatigueSnapshot = buildFatigueSnapshot(history);
      const fatigue = classifyFatigue(fatigueSnapshot, runtimeSettings.getRules());
      return {
        id: ad.id,
        name: ad.name || 'Unnamed ad',
        spend: Number(spendMetrics.spend || 0),
        attributedPurchases: Number(spendMetrics.purchases || 0),
        ctr: Number(spendMetrics.ctr || 0),
        cpm: Number(spendMetrics.cpm || 0),
        frequency: Number(spendMetrics.frequency || 0),
        fatigue,
        fatigueSnapshot,
      };
    })
    .filter(ad => ad.spend > 0 || ad.fatigueSnapshot.daysOfData > 0)
    .sort((left, right) => right.spend - left.spend);
}

function buildRecommendationDeck(context) {
  const deck = [];
  const {
    actionable,
    advisory,
    profitContext,
    weekdayScaleContext,
    activeAds,
    refundRate,
    activeCampaignCount,
  } = context;

  const totalActiveAdSpend = activeAds.reduce((sum, ad) => sum + ad.spend, 0);
  const topAd = activeAds[0] || null;
  const topAdShare = topAd && totalActiveAdSpend > 0 ? topAd.spend / totalActiveAdSpend : 0;
  const fatigueWarnings = activeAds.filter(ad => ad.fatigue.status === 'warning' || ad.fatigue.status === 'danger');

  if (actionable.length > 0) {
    const first = actionable[0];
    deck.push({
      code: 'approval-required',
      score: 100,
      headline: `Approval required: ${first.action}`,
      why: `${first.targetName} needs an executable ${first.type} change and is already in the approval path.`,
      next: 'Review the approval request in Telegram and either approve or reject it there.',
    });
  }

  if (profitContext?.trueNetProfit > 0 && (weekdayScaleContext.status === 'suppress' || weekdayScaleContext.status === 'caution')) {
    deck.push({
      code: `hold-scale-${weekdayScaleContext.status}`,
      score: weekdayScaleContext.status === 'suppress' ? 95 : 80,
      headline: `Do not scale account budget on ${weekdayScaleContext.weekday} yet.`,
      why: `${weekdayScaleContext.weekday} CPA is ${formatUsd(weekdayScaleContext.currentCpa)} versus a ${formatUsd(weekdayScaleContext.medianCpa)} median weekday CPA over the last ${SCHEDULE_LOOKBACK_DAYS} days.`,
      next: 'Keep budget flat on the weak weekday and wait for the next strong day before widening spend.',
    });
  }

  if (topAd && topAdShare >= 0.65 && fatigueWarnings.length >= 2) {
    deck.push({
      code: 'creative-concentration',
      score: 88,
      headline: 'Scale the winning creative angle before you scale total spend.',
      why: `${topAd.name} is carrying ${(topAdShare * 100).toFixed(0)}% of active ad spend, while ${fatigueWarnings.length} supporting creatives are already in fatigue warning.`,
      next: 'Launch 2-3 close variants of the winner and be ready to cap warning creatives if CTR decay persists for another 1-2 days.',
    });
  } else if (fatigueWarnings.length >= 2) {
    deck.push({
      code: 'creative-refresh',
      score: 76,
      headline: 'Refresh the creative bench before increasing budget.',
      why: `${fatigueWarnings.length} active creatives are showing meaningful CTR decay from peak delivery.`,
      next: 'Introduce fresh variants for the best-performing offer instead of pushing more spend into decaying creatives.',
    });
  }

  if (refundRate >= 0.1 && profitContext?.hasReliableCoverage) {
    deck.push({
      code: 'refund-caution',
      score: 72,
      headline: 'Treat scaling as contribution-margin constrained, not ROAS-only.',
      why: `Refunds are running at ${(refundRate * 100).toFixed(1)}% of gross revenue, so top-line growth can overstate real contribution.`,
      next: 'Keep a post-refund profit check on scale decisions and prioritize product angles with lower return risk.',
    });
  }

  if (profitContext?.trueNetProfit > 0
    && weekdayScaleContext.status === 'favorable'
    && topAdShare < 0.65
    && fatigueWarnings.length <= 1
    && activeCampaignCount <= 2
    && advisory.some(opt => /room to scale/i.test(opt.action || ''))) {
    deck.push({
      code: 'measured-scale',
      score: 70,
      headline: 'Measured scale is justified if efficiency holds.',
      why: `True net profit is positive at ${toPercent(profitContext.margin)} margin, the weekday baseline is supportive, and creative pressure is contained.`,
      next: 'Increase spend gradually and monitor CPA and post-refund margin after each change.',
    });
  }

  if (activeCampaignCount <= 1 && topAdShare >= 0.75) {
    deck.push({
      code: 'single-campaign-risk',
      score: 68,
      headline: 'Account performance is overly concentrated in one campaign and one lead creative.',
      why: `Only ${activeCampaignCount} campaign is active, and the top creative is taking ${(topAdShare * 100).toFixed(0)}% of active ad spend.`,
      next: 'Protect the account by validating a second creative angle before leaning harder into account-wide scale.',
    });
  }

  return deck
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);
}

function buildFingerprintPayload(context, recommendations, category) {
  return {
    category,
    actionable: context.actionable.map(opt => [opt.type, opt.level, opt.targetName, opt.action]),
    advisoryTargets: context.advisory.map(opt => [opt.targetName, opt.priority, opt.type]),
    recommendationCodes: recommendations.map(rec => rec.code),
    weekdayStatus: context.weekdayScaleContext.status,
    refundBand: context.refundRate >= 0.1 ? 'elevated' : 'normal',
    activeCampaignCount: context.activeCampaignCount,
    fatigueWarnings: context.activeAds
      .filter(ad => ad.fatigue.status !== 'healthy')
      .map(ad => ad.name),
    topAd: context.activeAds[0]?.name || null,
    sourceHealth: {
      metaInsights: context.sources.metaInsights?.status || 'unknown',
      imweb: context.sources.imweb?.status || 'unknown',
      cogs: context.sources.cogs?.status || 'unknown',
    },
  };
}

function getCategory(context, recommendations) {
  if (context.actionable.length > 0 || context.critical.length > 0) {
    return 'alert';
  }
  if (recommendations.length > 0) {
    return 'digest';
  }
  return 'silent';
}

function buildNotificationDecision({ category, fingerprint, state, now = new Date() }) {
  if (category === 'silent') {
    return { shouldSend: false, reason: 'no-high-signal-content' };
  }

  const lastFingerprint = state?.summary?.fingerprint || null;
  const lastSentAt = state?.summary?.sentAt || null;
  const lastSent = parseIso(lastSentAt);
  const duplicate = lastFingerprint === fingerprint;

  if (!lastSent) {
    return { shouldSend: true, reason: 'first-summary' };
  }

  const elapsedMs = now.getTime() - lastSent.getTime();
  if (category === 'alert') {
    if (duplicate && elapsedMs < ALERT_DUPLICATE_COOLDOWN_MS) {
      return { shouldSend: false, reason: 'duplicate-alert' };
    }
    return { shouldSend: true, reason: duplicate ? 'alert-cooldown-expired' : 'new-alert' };
  }

  if (duplicate || elapsedMs < DIGEST_COOLDOWN_MS) {
    return { shouldSend: false, reason: duplicate ? 'duplicate-digest' : 'digest-cooldown' };
  }

  return { shouldSend: true, reason: 'digest-changed' };
}

function buildScanDigestMessage(scanResult, context, recommendations, category) {
  const stats = scanResult.stats || {};
  const profitContext = context.profitContext;
  const sourceHealth = context.sources || {};
  const imwebStatus = sourceHealth.imweb?.status === 'connected' ? 'fresh' : 'cached';
  const actionLine = context.actionable.length > 0
    ? `${context.actionable.length} approval item${context.actionable.length === 1 ? '' : 's'} ready now`
    : 'No approval-required actions in this scan';
  const advisoryLine = context.advisory.length > 0
    ? `${context.advisory.length} advisory suggestion${context.advisory.length === 1 ? '' : 's'} in this scan`
    : 'No advisory suggestions in this scan';

  const recommendationsText = recommendations.length > 0
    ? recommendations.map((rec, index) => (
      `${index + 1}. <b>${rec.headline}</b>\n   • Why: ${rec.why}\n   • Next: ${rec.next}`
    )).join('\n\n')
    : '<i>No high-signal recommendations crossed the notification threshold.</i>';

  const profitLine = profitContext?.hasReliableCoverage
    ? `💰 ${formatKrw(profitContext.netRevenue)} net revenue · ${formatKrw(profitContext.trueNetProfit)} true net profit · ${toPercent(profitContext.margin)} margin`
    : '💰 Profit context unavailable or not reliable enough for scale decisions';

  const weekdayLine = context.weekdayScaleContext?.currentCpa && context.weekdayScaleContext?.medianCpa
    ? `📅 ${context.weekdayScaleContext.weekday} CPA ${formatUsd(context.weekdayScaleContext.currentCpa)} vs ${formatUsd(context.weekdayScaleContext.medianCpa)} median weekday CPA`
    : `📅 Weekday context ${context.weekdayScaleContext?.status || 'neutral'}`;

  const topAd = context.activeAds[0];
  const concentrationLine = topAd
    ? `🎯 Top active creative: ${topAd.name} · ${formatUsd(topAd.spend)} spend over ${FATIGUE_LOOKBACK_DAYS}d`
    : '🎯 No active creative diagnostics available';

  const header = category === 'alert'
    ? '🚨 <b>AdPilot Operator Alert</b>'
    : '📡 <b>AdPilot Performance Brief</b>';

  return `${header}

📊 ${pluralize(Number(stats.activeCampaigns || 0), 'active campaign')} · ${pluralize(Number(stats.activeAds || 0), 'active ad')} · ${formatUsd(stats.totalSpend7d || 0)} spent (${PERFORMANCE_LOOKBACK_DAYS}d)
${profitLine}
↩️ Refund rate ${(context.refundRate * 100).toFixed(1)}% · Imweb ${imwebStatus}
${weekdayLine}
${concentrationLine}

<b>Queue state</b>
• ${actionLine}
• ${advisoryLine}

<b>Best next moves</b>
${recommendationsText}

<i>I will interrupt you immediately for new approval items, critical deterioration, or materially changed advice.</i>`;
}

function buildScanSummaryPlan(scanResult, latestData, state, now = new Date()) {
  const rules = runtimeSettings.getRules();
  const optimizations = (scanResult.optimizations || []).map(opt => ({
    ...opt,
    status: getOptimizationStatus(opt),
  }));

  const actionable = optimizations.filter(opt => opt.status === 'needs_approval' || opt.status === 'awaiting_telegram');
  const advisory = optimizations.filter(opt => opt.status === 'advisory');
  const critical = optimizations.filter(opt => opt.priority === 'critical');
  const activeCampaignCount = (latestData?.campaigns || []).filter(campaign => String(campaign?.status || '').toUpperCase() === 'ACTIVE').length;
  const activeAds = buildActiveAdDiagnostics(latestData?.ads, latestData?.adInsights, getTodayInTimeZone());
  const revenueData = latestData?.revenueData || null;
  const cogsData = latestData?.cogsData || null;
  const profitContext = buildProfitContext(
    latestData?.campaignInsights,
    revenueData,
    cogsData,
    PERFORMANCE_LOOKBACK_DAYS,
    getTodayInTimeZone(),
    { minCoverageRatio: MIN_PROFIT_COVERAGE_RATIO }
  );
  const weekdayScaleContext = buildWeekdayScaleContext(
    latestData?.campaignInsights,
    rules,
    getTodayInTimeZone(),
    {
      lookbackDays: SCHEDULE_LOOKBACK_DAYS,
      cautionRatio: WEEKDAY_SCALE_CAUTION_RATIO,
      suppressRatio: WEEKDAY_SCALE_SUPPRESS_RATIO,
    }
  );
  const refundRate = revenueData?.totalRevenue > 0
    ? Number(revenueData.totalRefunded || 0) / Number(revenueData.totalRevenue || 1)
    : 0;
  const recommendations = buildRecommendationDeck({
    actionable,
    advisory,
    critical,
    profitContext,
    weekdayScaleContext,
    activeAds,
    refundRate,
    activeCampaignCount,
  });
  const category = getCategory({ actionable, advisory, critical }, recommendations);
  const fingerprintPayload = buildFingerprintPayload({
    actionable,
    advisory,
    activeAds,
    refundRate,
    sources: latestData?.sources || {},
    weekdayScaleContext,
    activeCampaignCount,
  }, recommendations, category);
  const fingerprint = hash(JSON.stringify(fingerprintPayload));
  const decision = buildNotificationDecision({ category, fingerprint, state, now });

  return {
    shouldSend: decision.shouldSend,
    reason: decision.reason,
    category,
    fingerprint,
    text: decision.shouldSend
      ? buildScanDigestMessage(scanResult, {
        actionable,
        advisory,
        activeAds,
        refundRate,
        profitContext,
        weekdayScaleContext,
        sources: latestData?.sources || {},
      }, recommendations, category)
      : null,
  };
}

module.exports = {
  buildScanSummaryPlan,
  buildNotificationDecision,
  buildRecommendationDeck,
  shouldSendStartupMessage,
  hoursSince,
};
