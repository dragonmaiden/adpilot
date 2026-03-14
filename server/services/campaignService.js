const scheduler = require('../modules/scheduler');
const contracts = require('../contracts/v1');
const { summarizeInsights } = require('../domain/metrics');
const { getTodayInTimeZone } = require('../domain/time');
const { resolveWindowBounds } = require('../domain/performanceContext');

const WINDOW_DAYS = Object.freeze({
  '7d': 7,
  '14d': 14,
  '30d': 30,
  all: null,
});

function resolveWindow(query) {
  const key = typeof query?.days === 'string' ? query.days : '7d';
  const normalized = WINDOW_DAYS[key] === undefined ? '7d' : key;
  return {
    key: normalized,
    days: WINDOW_DAYS[normalized],
  };
}

/**
 * Build the /api/campaigns response with 7-day metrics per campaign.
 */
function getEnrichedCampaigns(query = {}) {
  const data = scheduler.getLatestData();
  const campaigns = data.campaigns || [];
  const insights = data.campaignInsights || [];
  const windowMeta = resolveWindow(query);
  const { windowStart, windowEnd } = windowMeta.days
    ? resolveWindowBounds(windowMeta.days, getTodayInTimeZone(), { includeCurrentDay: false })
    : { windowStart: null, windowEnd: null };

  const enriched = campaigns.map(c => {
    const cInsights = insights.filter(i =>
      i.campaign_id === c.id
      && (!windowStart || i.date_start >= windowStart)
      && (!windowEnd || i.date_start <= windowEnd)
    );
    const metrics = summarizeInsights(cInsights);

    return {
      ...c,
      metricsWindow: {
        spend: metrics.spend,
        attributedPurchases: metrics.purchases,
        metaPurchases: metrics.purchases,
        cpa: metrics.cpa,
        clicks: metrics.clicks,
        impressions: metrics.impressions,
        ctr: metrics.ctr,
      },
    };
  });

  return contracts.campaigns({
    campaigns: enriched,
    windowKey: windowMeta.key,
    windowDays: windowMeta.days,
  });
}

module.exports = { getEnrichedCampaigns };
