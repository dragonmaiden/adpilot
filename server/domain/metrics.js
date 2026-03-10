const config = require('../config');

const PURCHASE_ACTION_TYPES = [
  'purchase',
  'offsite_conversion.fb_pixel_purchase',
  'omni_purchase',
];

const PURCHASE_ACTION_TYPE_SET = new Set(PURCHASE_ACTION_TYPES);

function toNumber(value, parse = parseFloat) {
  const parsed = parse(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getPurchases(actions) {
  if (!Array.isArray(actions)) return 0;

  let total = 0;
  for (const action of actions) {
    if (PURCHASE_ACTION_TYPE_SET.has(action.action_type)) {
      total += toNumber(action.value, value => parseInt(value, 10));
    }
  }
  return total;
}

function getCPA(costPerAction) {
  if (!Array.isArray(costPerAction)) return null;

  const cpa = costPerAction.find(action => PURCHASE_ACTION_TYPE_SET.has(action.action_type));
  if (!cpa) return null;

  const value = toNumber(cpa.value);
  return value > 0 ? value : null;
}

function sumInsightField(insights, field, parse = parseFloat) {
  return (insights || []).reduce((sum, row) => sum + toNumber(row[field], parse), 0);
}

function sumPurchases(insights) {
  return (insights || []).reduce((sum, row) => sum + getPurchases(row.actions), 0);
}

function calcCPA(spend, purchases, fallback = null) {
  return purchases > 0 ? spend / purchases : fallback;
}

function calcCTR(clicks, impressions, fallback = 0) {
  return impressions > 0 ? (clicks / impressions) * 100 : fallback;
}

function calcCPC(spend, clicks, fallback = 0) {
  return clicks > 0 ? spend / clicks : fallback;
}

function calcPercent(numerator, denominator, fallback = 0) {
  return denominator > 0 ? (numerator / denominator) * 100 : fallback;
}

function calcAOV(revenue, orders, fallback = 0) {
  return orders > 0 ? revenue / orders : fallback;
}

function convertUsdToKrw(amountUsd, usdToKrw = config.currency.usdToKrw) {
  return amountUsd * usdToKrw;
}

function calcROAS(netRevenue, spendUsd, usdToKrw = config.currency.usdToKrw) {
  const spendKrw = convertUsdToKrw(spendUsd, usdToKrw);
  return spendKrw > 0 ? netRevenue / spendKrw : 0;
}

function calcGrossProfit(netRevenue, cogs, spendUsd, usdToKrw = config.currency.usdToKrw) {
  return netRevenue - cogs - convertUsdToKrw(spendUsd, usdToKrw);
}

function calcMargin(amount, revenue, fallback = 0) {
  return calcPercent(amount, revenue, fallback);
}

function summarizeInsights(insights, options = {}) {
  const spend = sumInsightField(insights, 'spend');
  const clicks = sumInsightField(insights, 'clicks', value => parseInt(value, 10));
  const impressions = sumInsightField(insights, 'impressions', value => parseInt(value, 10));
  const purchases = sumPurchases(insights);

  return {
    spend,
    clicks,
    impressions,
    purchases,
    cpa: calcCPA(spend, purchases, options.cpaFallback ?? null),
    ctr: calcCTR(clicks, impressions, options.ctrFallback ?? 0),
  };
}

function aggregateInsightsBy(insights, keySelector, initValue) {
  const grouped = {};

  for (const row of insights || []) {
    const key = keySelector(row);
    if (!key) continue;

    if (!grouped[key]) {
      grouped[key] = {
        spend: 0,
        purchases: 0,
        clicks: 0,
        impressions: 0,
        ...(typeof initValue === 'function' ? initValue(key, row) : initValue),
      };
    }

    grouped[key].spend += toNumber(row.spend);
    grouped[key].purchases += getPurchases(row.actions);
    grouped[key].clicks += toNumber(row.clicks, value => parseInt(value, 10));
    grouped[key].impressions += toNumber(row.impressions, value => parseInt(value, 10));
  }

  return grouped;
}

function extractPositiveFieldValues(rows, field, parse = parseFloat) {
  return (rows || [])
    .map(row => toNumber(row[field], parse))
    .filter(value => value > 0);
}

function averagePositiveField(rows, field, parse = parseFloat) {
  const values = extractPositiveFieldValues(rows, field, parse);
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

module.exports = {
  PURCHASE_ACTION_TYPES,
  getPurchases,
  getCPA,
  sumInsightField,
  sumPurchases,
  calcCPA,
  calcCTR,
  calcCPC,
  calcPercent,
  calcAOV,
  calcROAS,
  calcGrossProfit,
  calcMargin,
  convertUsdToKrw,
  summarizeInsights,
  aggregateInsightsBy,
  extractPositiveFieldValues,
  averagePositiveField,
};
