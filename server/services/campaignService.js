const scheduler = require('../modules/scheduler');
const contracts = require('../contracts/v1');
const { sumField, sumPurchases, calcCPA, calcCTR } = require('../helpers/metrics');

/**
 * Build the /api/campaigns response with 7-day metrics per campaign.
 */
function getEnrichedCampaigns() {
  const data = scheduler.getLatestData();
  const campaigns = data.campaigns || [];
  const insights = data.campaignInsights || [];

  const enriched = campaigns.map(c => {
    const cInsights = insights.filter(i => i.campaign_id === c.id);
    const spend = sumField(cInsights, 'spend');
    const purchases = sumPurchases(cInsights);
    const clicks = sumField(cInsights, 'clicks', parseInt);
    const impressions = sumField(cInsights, 'impressions', parseInt);

    return {
      ...c,
      metrics7d: {
        spend,
        purchases,
        cpa: calcCPA(spend, purchases),
        clicks,
        impressions,
        ctr: calcCTR(clicks, impressions),
      },
    };
  });

  return contracts.campaigns({ campaigns: enriched });
}

module.exports = { getEnrichedCampaigns };
