// ═══════════════════════════════════════════════════════
// AdPilot — Meta Ads API Client (Read + Write)
// ═══════════════════════════════════════════════════════

const config = require('../config');

const BASE = `${config.meta.baseUrl}/${config.meta.apiVersion}`;
const TOKEN = config.meta.accessToken;
const AD_ACCOUNT = config.meta.adAccountId;

// ── Helper: Make API request ──
async function metaApi(endpoint, method = 'GET', params = {}) {
  const url = new URL(`${BASE}${endpoint}`);

  if (method === 'GET') {
    url.searchParams.set('access_token', TOKEN);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    const data = await res.json();
    if (data.error) throw new Error(`Meta API Error: ${data.error.message} (code ${data.error.code})`);
    return data;
  }

  // POST (for updates)
  const body = new URLSearchParams({ access_token: TOKEN, ...params });
  const res = await fetch(url.toString(), { method: 'POST', body });
  const data = await res.json();
  if (data.error) throw new Error(`Meta API Error: ${data.error.message} (code ${data.error.code})`);
  return data;
}

// ── Helper: Paginate through all results ──
async function metaApiPaginated(endpoint, params = {}) {
  const results = [];
  let url = `${BASE}${endpoint}?access_token=${TOKEN}`;
  Object.entries(params).forEach(([k, v]) => { url += `&${k}=${encodeURIComponent(v)}`; });

  while (url) {
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(`Meta API Error: ${data.error.message}`);
    if (data.data) results.push(...data.data);
    url = data.paging?.next || null;
  }
  return results;
}

// ═══════════════════════════════════════════════
// READ OPERATIONS
// ═══════════════════════════════════════════════

// Get ad account status and budget constraints
async function getAdAccount(fields = 'id,account_status,disable_reason,currency,timezone_name,timezone_offset_hours_utc,amount_spent,balance,spend_cap,min_campaign_group_spend_cap') {
  return metaApi(`/${AD_ACCOUNT}`, 'GET', { fields });
}

// Get all campaigns with status and budgets
async function getCampaigns() {
  return metaApiPaginated(`/${AD_ACCOUNT}/campaigns`, {
    fields: 'id,name,status,daily_budget,lifetime_budget,bid_strategy,objective,effective_status,start_time,updated_time',
  });
}

// Get all ad sets with targeting & budget details
async function getAdSets() {
  return metaApiPaginated(`/${AD_ACCOUNT}/adsets`, {
    fields: 'id,name,status,campaign_id,daily_budget,bid_amount,bid_strategy,optimization_goal,effective_status,targeting,start_time,updated_time,budget_remaining',
  });
}

// Get all ads with creative info
async function getAds() {
  return metaApiPaginated(`/${AD_ACCOUNT}/ads`, {
    fields: 'id,name,status,adset_id,campaign_id,effective_status,creative{id,name,title,body,image_url,thumbnail_url},updated_time',
  });
}

// Get account-level insights for a date range
async function getAccountInsights(since, until) {
  return metaApi(`/${AD_ACCOUNT}/insights`, 'GET', {
    fields: 'spend,impressions,reach,clicks,ctr,cpc,cpm,actions,cost_per_action_type,frequency',
    time_range: JSON.stringify({ since, until }),
    time_increment: 1, // daily breakdown
  });
}

// Get campaign-level daily insights
async function getCampaignInsights(campaignId, since, until) {
  return metaApi(`/${campaignId}/insights`, 'GET', {
    fields: 'campaign_name,spend,impressions,reach,clicks,ctr,cpc,cpm,actions,cost_per_action_type,frequency',
    time_range: JSON.stringify({ since, until }),
    time_increment: 1,
  });
}

// Get ad set-level daily insights
async function getAdSetInsights(adSetId, since, until) {
  return metaApi(`/${adSetId}/insights`, 'GET', {
    fields: 'adset_name,spend,impressions,reach,clicks,ctr,cpc,cpm,actions,cost_per_action_type,frequency',
    time_range: JSON.stringify({ since, until }),
    time_increment: 1,
  });
}

// Get ad-level insights (for fatigue detection)
async function getAdInsights(adId, since, until) {
  return metaApi(`/${adId}/insights`, 'GET', {
    fields: 'ad_name,spend,impressions,reach,clicks,ctr,cpc,cpm,actions,cost_per_action_type,frequency',
    time_range: JSON.stringify({ since, until }),
    time_increment: 1,
  });
}

// Get all campaign daily insights in bulk
async function getAllCampaignInsights(since, until) {
  return metaApiPaginated(`/${AD_ACCOUNT}/insights`, {
    fields: 'campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,cpc,cpm,actions,cost_per_action_type,frequency',
    time_range: JSON.stringify({ since, until }),
    time_increment: 1,
    level: 'campaign',
  });
}

// Get all ad set daily insights in bulk
async function getAllAdSetInsights(since, until) {
  return metaApiPaginated(`/${AD_ACCOUNT}/insights`, {
    fields: 'adset_id,adset_name,campaign_id,spend,impressions,reach,clicks,ctr,cpc,cpm,actions,cost_per_action_type,frequency',
    time_range: JSON.stringify({ since, until }),
    time_increment: 1,
    level: 'adset',
  });
}

// Get all ad daily insights in bulk
async function getAllAdInsights(since, until) {
  return metaApiPaginated(`/${AD_ACCOUNT}/insights`, {
    fields: 'ad_id,ad_name,adset_id,campaign_id,spend,impressions,reach,clicks,ctr,cpc,cpm,actions,cost_per_action_type,frequency',
    time_range: JSON.stringify({ since, until }),
    time_increment: 1,
    level: 'ad',
  });
}

// ═══════════════════════════════════════════════
// WRITE OPERATIONS
// ═══════════════════════════════════════════════

// Update campaign status (ACTIVE / PAUSED)
async function updateCampaignStatus(campaignId, status) {
  console.log(`[META WRITE] Campaign ${campaignId} → status: ${status}`);
  return metaApi(`/${campaignId}`, 'POST', { status });
}

// Update campaign daily budget (in cents — $110 = 11000)
async function updateCampaignBudget(campaignId, dailyBudgetCents) {
  console.log(`[META WRITE] Campaign ${campaignId} → daily_budget: ${dailyBudgetCents} cents ($${(dailyBudgetCents / 100).toFixed(2)})`);
  return metaApi(`/${campaignId}`, 'POST', { daily_budget: dailyBudgetCents.toString() });
}

module.exports = {
  // Read
  getAdAccount,
  getCampaigns,
  getAdSets,
  getAds,
  getAccountInsights,
  getCampaignInsights,
  getAdSetInsights,
  getAdInsights,
  getAllCampaignInsights,
  getAllAdSetInsights,
  getAllAdInsights,
  // Write
  updateCampaignStatus,
  updateCampaignBudget,
};
