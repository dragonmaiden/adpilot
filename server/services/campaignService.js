const scheduler = require('../modules/scheduler');
const contracts = require('../contracts/v1');
const { summarizeInsights } = require('../domain/metrics');
const { getTodayInTimeZone, shiftDate } = require('../domain/time');

/**
 * Build the /api/campaigns response with 7-day metrics per campaign.
 */
function getEnrichedCampaigns() {
  const data = scheduler.getLatestData();
  const campaigns = data.campaigns || [];
  const insights = data.campaignInsights || [];
  const windowStart = shiftDate(getTodayInTimeZone(), -6);

  const enriched = campaigns.map(c => {
    const cInsights = insights.filter(i => i.campaign_id === c.id && (!windowStart || i.date_start >= windowStart));
    const metrics = summarizeInsights(cInsights);

    return {
      ...c,
      metrics7d: {
        spend: metrics.spend,
        metaPurchases: metrics.purchases,
        cpa: metrics.cpa,
        clicks: metrics.clicks,
        impressions: metrics.impressions,
        ctr: metrics.ctr,
      },
    };
  });

  return contracts.campaigns({ campaigns: enriched });
}

module.exports = { getEnrichedCampaigns };
