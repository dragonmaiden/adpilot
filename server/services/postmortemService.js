const scheduler = require('../modules/scheduler');
const contracts = require('../contracts/v1');
const { summarizeInsights, extractPositiveFieldValues } = require('../domain/metrics');

/**
 * Build the /api/postmortem response — ad performance data with lessons for paused ads.
 */
function getPostmortemResponse() {
  const data = scheduler.getLatestData();
  const ads = data.ads || [];
  const adInsights = data.adInsights || [];
  const campaigns = data.campaigns || [];

  // Build performance data for ALL ads (active + paused)
  const adPerformance = ads.map(ad => {
    const adIns = adInsights.filter(i => i.ad_id === ad.id);
    const metrics = summarizeInsights(adIns);
    const totalSpend = metrics.spend;
    const totalClicks = metrics.clicks;
    const totalImpressions = metrics.impressions;
    const totalMetaPurchases = metrics.purchases;

    const ctrs = extractPositiveFieldValues(adIns, 'ctr');
    const cpms = extractPositiveFieldValues(adIns, 'cpm');
    const freqs = extractPositiveFieldValues(adIns, 'frequency');

    const peakCTR = ctrs.length > 0 ? Math.max(...ctrs) : 0;
    const avgCTR = ctrs.length > 0 ? ctrs.reduce((a, b) => a + b, 0) / ctrs.length : 0;
    const lastCTR = ctrs.length > 0 ? ctrs[ctrs.length - 1] : 0;
    const avgCPM = cpms.length > 0 ? cpms.reduce((a, b) => a + b, 0) / cpms.length : 0;
    const lastFreq = freqs.length > 0 ? freqs[freqs.length - 1] : 0;
    const cpa = metrics.cpa;

    // Generate lessons for paused ads
    const lessons = [];
    if (ad.effective_status !== 'ACTIVE') {
      if (totalSpend > 0 && totalMetaPurchases === 0) {
        lessons.push({ type: 'no_conversions', text: `Spent $${totalSpend.toFixed(2)} with zero pixel purchases — creative or targeting did not resonate` });
      }
      if (cpa && cpa > 30) {
        lessons.push({ type: 'high_cpa', text: `CPA of $${cpa.toFixed(2)} was too high — audience may have been too broad or creative lacked urgency` });
      }
      if (peakCTR > 0 && lastCTR > 0 && ((peakCTR - lastCTR) / peakCTR) > 0.3) {
        lessons.push({ type: 'ctr_decay', text: `CTR dropped ${((peakCTR - lastCTR) / peakCTR * 100).toFixed(0)}% from peak (${peakCTR.toFixed(2)}% → ${lastCTR.toFixed(2)}%) — audience fatigue` });
      }
      if (lastFreq > 3) {
        lessons.push({ type: 'high_frequency', text: `Frequency reached ${lastFreq.toFixed(1)} — same people seeing the ad too many times` });
      }
      if (avgCTR > 1.5 && totalMetaPurchases === 0) {
        lessons.push({ type: 'clicks_no_purchase', text: `Good CTR (${avgCTR.toFixed(2)}%) but no pixel purchases — landing page or pricing may be the issue` });
      }
      if (totalSpend === 0) {
        lessons.push({ type: 'no_data', text: 'No spend data in the last 7 days — was paused before this period' });
      }
      if (lessons.length === 0 && totalSpend > 0) {
        lessons.push({ type: 'general', text: `Spent $${totalSpend.toFixed(2)} with ${totalMetaPurchases} pixel purchase${totalMetaPurchases !== 1 ? 's' : ''} — manually paused or replaced by better creative` });
      }
    }

    const campaign = campaigns.find(c => c.id === ad.campaign_id);

    return {
      id: ad.id,
      name: ad.name,
      status: ad.status,
      effectiveStatus: ad.effective_status,
      campaignId: ad.campaign_id,
      campaignName: campaign ? campaign.name : 'Unknown',
      adsetId: ad.adset_id,
      daysOfData: adIns.length,
      spend: totalSpend,
      clicks: totalClicks,
      impressions: totalImpressions,
      metaPurchases: totalMetaPurchases,
      cpa,
      avgCTR,
      peakCTR,
      lastCTR,
      avgCPM,
      lastFrequency: lastFreq,
      lessons,
    };
  });

  // Separate active vs inactive
  const active = adPerformance.filter(a => a.effectiveStatus === 'ACTIVE');
  const inactive = adPerformance.filter(a => a.effectiveStatus !== 'ACTIVE' && a.spend > 0)
    .sort((a, b) => b.spend - a.spend);
  const noData = adPerformance.filter(a => a.effectiveStatus !== 'ACTIVE' && a.spend === 0);

  // Aggregate lessons across all inactive
  const lessonsSummary = {};
  inactive.forEach(a => {
    a.lessons.forEach(l => {
      if (!lessonsSummary[l.type]) lessonsSummary[l.type] = { count: 0, examples: [] };
      lessonsSummary[l.type].count++;
      if (lessonsSummary[l.type].examples.length < 3) {
        lessonsSummary[l.type].examples.push(a.name);
      }
    });
  });

  return contracts.postmortem({
    active,
    inactive,
    noData,
    lessonsSummary,
    totals: {
      activeCount: active.length,
      inactiveWithData: inactive.length,
      inactiveNoData: noData.length,
      totalAds: ads.length,
    },
  });
}

module.exports = { getPostmortemResponse };
