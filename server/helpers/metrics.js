// ═══════════════════════════════════════════════════════
// AdPilot — Shared Metrics Helpers
// Centralizes purchase extraction, metric aggregation,
// and calculations (CPA/ROAS/CTR) used across the app.
// ═══════════════════════════════════════════════════════

/**
 * All Meta action types that represent a purchase conversion.
 */
const PURCHASE_ACTION_TYPES = [
  'purchase',
  'offsite_conversion.fb_pixel_purchase',
  'omni_purchase',
];

/**
 * Sum purchase counts from a Meta actions array.
 * @param {Array} actions – row.actions from Meta insight
 * @returns {number}
 */
function getPurchases(actions) {
  if (!actions) return 0;
  let total = 0;
  for (const a of actions) {
    if (PURCHASE_ACTION_TYPES.includes(a.action_type)) {
      total += parseInt(a.value, 10) || 0;
    }
  }
  return total;
}

/**
 * Extract CPA from Meta cost_per_action_type array.
 * @param {Array} costPerAction – row.cost_per_action_type
 * @returns {number|null}
 */
function getCPA(costPerAction) {
  if (!costPerAction) return null;
  const cpa = costPerAction.find(a => PURCHASE_ACTION_TYPES.includes(a.action_type));
  return cpa ? parseFloat(cpa.value) : null;
}

/**
 * Generic reduce over insight rows for a numeric field.
 * @param {Array} insights – array of Meta insight rows
 * @param {string} field – field name (e.g. 'spend', 'clicks', 'impressions')
 * @param {Function} [parse=parseFloat] – parser function
 * @returns {number}
 */
function sumField(insights, field, parse = parseFloat) {
  return (insights || []).reduce((s, i) => s + (parse(i[field] || 0) || 0), 0);
}

/**
 * Sum purchases across multiple insight rows.
 * @param {Array} insights – array of Meta insight rows
 * @returns {number}
 */
function sumPurchases(insights) {
  return (insights || []).reduce((s, i) => s + getPurchases(i.actions), 0);
}

/**
 * Calculate CPA (cost per acquisition).
 * @param {number} spend
 * @param {number} purchases
 * @returns {number|null} – null when purchases=0; callers apply ?? 0 or ?? Infinity
 */
function calcCPA(spend, purchases) {
  return purchases > 0 ? spend / purchases : null;
}

/**
 * Calculate CTR (click-through rate) as a percentage.
 * @param {number} clicks
 * @param {number} impressions
 * @returns {number} – 0 when impressions=0
 */
function calcCTR(clicks, impressions) {
  return impressions > 0 ? (clicks / impressions * 100) : 0;
}

/**
 * Calculate ROAS (return on ad spend).
 * @param {number} netRevenue – in store currency (KRW)
 * @param {number} spendUSD – ad spend in USD
 * @param {number} usdToKrw – conversion rate
 * @returns {number} – 0 when spend=0
 */
function calcROAS(netRevenue, spendUSD, usdToKrw) {
  const spendKRW = spendUSD * usdToKrw;
  return spendKRW > 0 ? netRevenue / spendKRW : 0;
}

module.exports = {
  PURCHASE_ACTION_TYPES,
  getPurchases,
  getCPA,
  sumField,
  sumPurchases,
  calcCPA,
  calcCTR,
  calcROAS,
};
