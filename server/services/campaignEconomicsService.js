const config = require('../config');
const {
  calcGrossProfit,
  convertUsdToKrw,
  getPurchases,
} = require('../domain/metrics');
const {
  filterAllRecentInsights,
  resolveWindowBounds,
} = require('../domain/performanceContext');
const { getTodayInTimeZone } = require('../domain/time');
const transforms = require('../transforms/charts');

const HIGH_CONFIDENCE_COVERAGE_RATIO = 0.8;
const MEDIUM_CONFIDENCE_COVERAGE_RATIO = 0.4;
const HIGH_CONFIDENCE_PURCHASES = 8;
const MEDIUM_CONFIDENCE_PURCHASES = 3;
const ESTIMATE_BASIS = 'meta_purchases_x_daily_net_aov';

function createEmptyCampaignEconomics(campaign = {}) {
  return {
    campaignId: String(campaign.id || ''),
    campaignName: campaign.name || String(campaign.id || 'Unknown campaign'),
    status: campaign.effective_status || campaign.status || 'UNKNOWN',
    spend: 0,
    spendKrw: 0,
    metaPurchases: 0,
    observationDays: 0,
    purchaseDays: 0,
    activeDays: 0,
    coverageWeight: 0,
    coverageRatio: 0,
    estimatedRevenue: 0,
    allocatedCogs: 0,
    allocatedShipping: 0,
    allocatedFees: 0,
    estimatedTrueNetProfit: 0,
    estimatedMargin: 0,
    estimatedRoas: 0,
    contributionPerSpend: 0,
    confidence: 'low',
    hasReliableEstimate: false,
    basis: ESTIMATE_BASIS,
  };
}

function clampRatio(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function classifyConfidence({
  hasFreshRevenue,
  coverageRatio,
  metaPurchases,
  estimatedRevenue,
}) {
  if (!hasFreshRevenue || estimatedRevenue <= 0 || metaPurchases <= 0) {
    return 'low';
  }

  if (coverageRatio >= HIGH_CONFIDENCE_COVERAGE_RATIO && metaPurchases >= HIGH_CONFIDENCE_PURCHASES) {
    return 'high';
  }

  if (coverageRatio >= MEDIUM_CONFIDENCE_COVERAGE_RATIO && metaPurchases >= MEDIUM_CONFIDENCE_PURCHASES) {
    return 'medium';
  }

  return 'low';
}

function filterDateDict(dictionary, windowStart, windowEnd) {
  if (!dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(dictionary).filter(([date]) => date >= windowStart && date <= windowEnd)
  );
}

function buildCampaignLookup(campaigns) {
  const lookup = new Map();

  for (const campaign of Array.isArray(campaigns) ? campaigns : []) {
    lookup.set(String(campaign.id), campaign);
  }

  return lookup;
}

function buildCampaignDateStats(insights) {
  const campaignDateStats = new Map();
  const metaPurchasesByDate = new Map();

  for (const row of Array.isArray(insights) ? insights : []) {
    const campaignId = String(row?.campaign_id || '').trim();
    const date = String(row?.date_start || '').trim();
    if (!campaignId || !date) continue;

    const purchases = getPurchases(row?.actions);
    const spend = Number.parseFloat(row?.spend || 0) || 0;
    const key = `${campaignId}:${date}`;
    const existing = campaignDateStats.get(key) || {
      campaignId,
      date,
      spend: 0,
      purchases: 0,
      observations: 0,
    };

    existing.spend += spend;
    existing.purchases += purchases;
    existing.observations += 1;
    campaignDateStats.set(key, existing);
    metaPurchasesByDate.set(date, (metaPurchasesByDate.get(date) || 0) + purchases);
  }

  return { campaignDateStats, metaPurchasesByDate };
}

function buildWindowSummary(dailyMerged, profitWaterfall, hasFreshRevenue, minCoverageRatio) {
  const totals = (Array.isArray(profitWaterfall) ? profitWaterfall : []).reduce((summary, row) => {
    summary.netRevenue += Number(row?.netRevenue || 0);
    summary.cogs += Number(row?.cogs || 0);
    summary.shipping += Number(row?.cogsShipping || 0);
    summary.paymentFees += Number(row?.paymentFees || 0);
    summary.coverageWeight += Number.isFinite(row?.cogsCoverageRatio) ? row.cogsCoverageRatio : 0;
    return summary;
  }, {
    netRevenue: 0,
    cogs: 0,
    shipping: 0,
    paymentFees: 0,
    coverageWeight: 0,
  });

  const orders = (Array.isArray(dailyMerged) ? dailyMerged : []).reduce(
    (sum, row) => sum + Number(row?.orders || 0),
    0
  );
  const coverageRatio = profitWaterfall.length > 0 ? totals.coverageWeight / profitWaterfall.length : 0;

  return {
    netRevenue: Math.round(totals.netRevenue),
    orders,
    cogs: Math.round(totals.cogs),
    shipping: Math.round(totals.shipping),
    paymentFees: Math.round(totals.paymentFees),
    coverageWeight: Number(totals.coverageWeight.toFixed(3)),
    coverageRatio,
    hasReliableCoverage: hasFreshRevenue && coverageRatio >= minCoverageRatio,
    confidence: 'low',
  };
}

function buildCampaignEconomics(campaigns, campaignInsights, revenueData, cogsData, revenueSource = null, options = {}) {
  const {
    days = 7,
    referenceDate = getTodayInTimeZone(),
    includeCurrentDay = false,
    minCoverageRatio = HIGH_CONFIDENCE_COVERAGE_RATIO,
    paymentFeeRate = config.fees.paymentFeeRate,
  } = options;

  const { windowStart, windowEnd } = resolveWindowBounds(days, referenceDate, { includeCurrentDay });
  if (!windowStart || !windowEnd) {
    return {
      summary: {
        days,
        windowStart: null,
        windowEnd: null,
        netRevenue: 0,
        orders: 0,
        estimatedMetaRevenue: 0,
        attributableRevenueShare: 0,
        totalMetaPurchases: 0,
        coverageWeight: 0,
        coverageRatio: 0,
        hasFreshRevenue: false,
        hasReliableCoverage: false,
        confidence: 'low',
        basis: ESTIMATE_BASIS,
      },
      campaigns: [],
    };
  }

  const hasFreshRevenue = revenueSource?.status === 'connected' && !revenueSource?.stale;
  const recentInsights = filterAllRecentInsights(campaignInsights, days, referenceDate, { includeCurrentDay });
  const revenueByDay = filterDateDict(revenueData?.dailyRevenue, windowStart, windowEnd);
  const dailyCogs = filterDateDict(cogsData?.dailyCOGS, windowStart, windowEnd);
  const dailyMerged = transforms.buildDailyMerged(revenueByDay, recentInsights, dailyCogs);
  const profitWaterfall = transforms.buildProfitWaterfall(dailyMerged, dailyCogs, paymentFeeRate);
  const mergedByDate = new Map(dailyMerged.map(row => [String(row.date), row]));
  const profitByDate = new Map(profitWaterfall.map(row => [String(row.date), row]));
  const campaignLookup = buildCampaignLookup(campaigns);
  const { campaignDateStats, metaPurchasesByDate } = buildCampaignDateStats(recentInsights);
  const summary = buildWindowSummary(dailyMerged, profitWaterfall, hasFreshRevenue, minCoverageRatio);
  const campaignStates = new Map();

  for (const campaign of Array.isArray(campaigns) ? campaigns : []) {
    campaignStates.set(String(campaign.id), createEmptyCampaignEconomics(campaign));
  }

  for (const stats of campaignDateStats.values()) {
    const campaign = campaignLookup.get(stats.campaignId) || { id: stats.campaignId };
    const campaignState = campaignStates.get(stats.campaignId) || createEmptyCampaignEconomics(campaign);
    const mergedDay = mergedByDate.get(stats.date) || null;
    const profitDay = profitByDate.get(stats.date) || null;
    const dayOrders = Number(mergedDay?.orders || 0);
    const dayNetRevenue = Number(mergedDay?.netRevenue || 0);
    const dayMetaPurchases = metaPurchasesByDate.get(stats.date) || 0;
    const dayAov = dayOrders > 0 ? dayNetRevenue / dayOrders : 0;
    const campaignEstimatedRevenue = stats.purchases * dayAov;
    const totalEstimatedMetaRevenue = dayMetaPurchases * dayAov;
    const attributableRevenueShare = dayNetRevenue > 0
      ? clampRatio(totalEstimatedMetaRevenue / dayNetRevenue)
      : 0;
    const attributableCogs = Number(profitDay?.cogs || 0) * attributableRevenueShare;
    const attributableShipping = Number(profitDay?.cogsShipping || 0) * attributableRevenueShare;
    const attributableFees = Number(profitDay?.paymentFees || 0) * attributableRevenueShare;
    const campaignRevenueShare = totalEstimatedMetaRevenue > 0
      ? campaignEstimatedRevenue / totalEstimatedMetaRevenue
      : 0;

    campaignState.spend += stats.spend;
    campaignState.metaPurchases += stats.purchases;
    campaignState.observationDays += stats.observations;
    campaignState.activeDays += 1;
    campaignState.purchaseDays += stats.purchases > 0 ? 1 : 0;
    campaignState.coverageWeight += Number.isFinite(profitDay?.cogsCoverageRatio)
      ? profitDay.cogsCoverageRatio
      : 0;
    campaignState.estimatedRevenue += campaignEstimatedRevenue;
    campaignState.allocatedCogs += attributableCogs * campaignRevenueShare;
    campaignState.allocatedShipping += attributableShipping * campaignRevenueShare;
    campaignState.allocatedFees += attributableFees * campaignRevenueShare;

    campaignStates.set(stats.campaignId, campaignState);
  }

  const campaignEconomics = Array.from(campaignStates.values())
    .map(state => {
      const spendKrw = Math.round(convertUsdToKrw(state.spend));
      const estimatedTrueNetProfit = Math.round(calcGrossProfit(
        state.estimatedRevenue,
        state.allocatedCogs + state.allocatedShipping + state.allocatedFees,
        state.spend
      ));
      const estimatedMargin = state.estimatedRevenue > 0
        ? estimatedTrueNetProfit / state.estimatedRevenue
        : 0;
      const coverageRatio = state.activeDays > 0 ? state.coverageWeight / state.activeDays : 0;
      const confidence = classifyConfidence({
        hasFreshRevenue,
        coverageRatio,
        metaPurchases: state.metaPurchases,
        estimatedRevenue: state.estimatedRevenue,
      });

      return {
        ...state,
        spend: Number(state.spend.toFixed(2)),
        spendKrw,
        coverageWeight: Number(state.coverageWeight.toFixed(3)),
        coverageRatio,
        estimatedRevenue: Math.round(state.estimatedRevenue),
        allocatedCogs: Math.round(state.allocatedCogs),
        allocatedShipping: Math.round(state.allocatedShipping),
        allocatedFees: Math.round(state.allocatedFees),
        estimatedTrueNetProfit,
        estimatedMargin,
        estimatedRoas: spendKrw > 0 ? Number((state.estimatedRevenue / spendKrw).toFixed(2)) : 0,
        contributionPerSpend: spendKrw > 0 ? estimatedTrueNetProfit / spendKrw : 0,
        confidence,
        hasReliableEstimate: hasFreshRevenue
          && coverageRatio >= MEDIUM_CONFIDENCE_COVERAGE_RATIO
          && state.metaPurchases >= MEDIUM_CONFIDENCE_PURCHASES
          && state.estimatedRevenue > 0,
      };
    })
    .sort((left, right) => right.estimatedTrueNetProfit - left.estimatedTrueNetProfit);

  const estimatedMetaRevenue = campaignEconomics.reduce((sum, campaign) => sum + campaign.estimatedRevenue, 0);
  const totalMetaPurchases = campaignEconomics.reduce((sum, campaign) => sum + campaign.metaPurchases, 0);

  return {
    summary: {
      ...summary,
      days,
      windowStart,
      windowEnd,
      estimatedMetaRevenue: Math.round(estimatedMetaRevenue),
      attributableRevenueShare: summary.netRevenue > 0
        ? clampRatio(estimatedMetaRevenue / summary.netRevenue)
        : 0,
      totalMetaPurchases,
      hasFreshRevenue,
      confidence: classifyConfidence({
        hasFreshRevenue,
        coverageRatio: summary.coverageRatio,
        metaPurchases: totalMetaPurchases,
        estimatedRevenue: estimatedMetaRevenue,
      }),
      basis: ESTIMATE_BASIS,
    },
    campaigns: campaignEconomics,
  };
}

module.exports = {
  buildCampaignEconomics,
  ESTIMATE_BASIS,
};
