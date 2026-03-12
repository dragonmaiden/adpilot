const { getOrderCashTotals } = require('./imwebPayments');

const META_SOURCE_TOKENS = ['meta', 'facebook', 'instagram', 'ig'];
const NON_META_SOURCE_RULES = [
  { token: 'google', source: 'google' },
  { token: 'gclid', source: 'google' },
  { token: 'naver', source: 'naver' },
  { token: 'kakao', source: 'kakao' },
  { token: 'youtube', source: 'youtube' },
  { token: 'tiktok', source: 'tiktok' },
  { token: 'microsoft', source: 'microsoft' },
  { token: 'bing', source: 'microsoft' },
];

const ATTRIBUTION_PATHS = Object.freeze({
  saleChannel: ['saleChannel', 'sale_channel'],
  device: ['device'],
  country: ['country'],
  utmSource: ['utmSource', 'utm_source', 'utm.source', 'tracking.utmSource', 'tracking.utm_source', 'marketing.utmSource', 'marketing.utm_source'],
  utmMedium: ['utmMedium', 'utm_medium', 'utm.medium', 'tracking.utmMedium', 'tracking.utm_medium', 'marketing.utmMedium', 'marketing.utm_medium'],
  utmCampaign: ['utmCampaign', 'utm_campaign', 'utm.campaign', 'tracking.utmCampaign', 'tracking.utm_campaign', 'marketing.utmCampaign', 'marketing.utm_campaign'],
  utmContent: ['utmContent', 'utm_content', 'utm.content', 'tracking.utmContent', 'tracking.utm_content', 'marketing.utmContent', 'marketing.utm_content'],
  utmTerm: ['utmTerm', 'utm_term', 'utm.term', 'tracking.utmTerm', 'tracking.utm_term', 'marketing.utmTerm', 'marketing.utm_term'],
  fbclid: ['fbclid', 'tracking.fbclid', 'marketing.fbclid', 'analytics.fbclid'],
  gclid: ['gclid', 'tracking.gclid', 'marketing.gclid', 'analytics.gclid'],
  msclkid: ['msclkid', 'tracking.msclkid', 'marketing.msclkid', 'analytics.msclkid'],
  referrer: ['referrer', 'referer', 'tracking.referrer', 'tracking.referer', 'marketing.referrer', 'marketing.referer', 'firstReferrer', 'first_referrer'],
  landingUrl: ['landingUrl', 'landingURL', 'landing_page', 'landingPage', 'entryUrl', 'entryURL', 'tracking.landingUrl', 'tracking.landingURL'],
});

function asString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function getPathValue(value, path) {
  const segments = String(path || '').split('.');
  let current = value;

  for (const segment of segments) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    current = current[segment];
  }

  return current;
}

function pickFirstValue(value, paths) {
  for (const path of Array.isArray(paths) ? paths : []) {
    const candidate = asString(getPathValue(value, path));
    if (candidate) return candidate;
  }
  return null;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, fieldValue]) => fieldValue !== null && fieldValue !== undefined && fieldValue !== '')
  );
}

function normalizeHost(input) {
  const value = asString(input);
  if (!value) return '';

  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`);
    return parsed.hostname.toLowerCase();
  } catch (_) {
    return value.toLowerCase();
  }
}

function classifySource(value) {
  const token = normalizeHost(value);
  if (!token) return null;

  if (META_SOURCE_TOKENS.some(candidate => token.includes(candidate))) {
    return { bucket: 'meta', marketingSource: 'meta_ads' };
  }

  for (const rule of NON_META_SOURCE_RULES) {
    if (token.includes(rule.token)) {
      return { bucket: 'non_meta', marketingSource: rule.source };
    }
  }

  if (token === 'imweb') {
    return { bucket: 'unattributed', marketingSource: 'imweb_storefront' };
  }

  return null;
}

function normalizeSaleChannel(value) {
  const channel = asString(value);
  if (!channel) return null;

  const upper = channel.toUpperCase();
  if (upper === 'IMWEB') {
    return {
      bucket: 'unattributed',
      marketingSource: 'imweb_storefront',
    };
  }

  return {
    bucket: 'non_meta',
    marketingSource: channel.toLowerCase(),
  };
}

function getOrderSections(order) {
  if (Array.isArray(order?.sections)) return order.sections;
  if (Array.isArray(order?.orderSections)) return order.orderSections;
  return [];
}

function getSectionItems(section) {
  if (Array.isArray(section?.sectionItems)) return section.sectionItems;
  if (Array.isArray(section?.items)) return section.items;
  return [];
}

function getOrderItems(order) {
  const items = [];

  for (const section of getOrderSections(order)) {
    items.push(...getSectionItems(section));
  }

  return items;
}

function extractOrderAttribution(order) {
  const signals = compactObject({
    saleChannel: pickFirstValue(order, ATTRIBUTION_PATHS.saleChannel),
    device: pickFirstValue(order, ATTRIBUTION_PATHS.device),
    country: pickFirstValue(order, ATTRIBUTION_PATHS.country),
    utmSource: pickFirstValue(order, ATTRIBUTION_PATHS.utmSource),
    utmMedium: pickFirstValue(order, ATTRIBUTION_PATHS.utmMedium),
    utmCampaign: pickFirstValue(order, ATTRIBUTION_PATHS.utmCampaign),
    utmContent: pickFirstValue(order, ATTRIBUTION_PATHS.utmContent),
    utmTerm: pickFirstValue(order, ATTRIBUTION_PATHS.utmTerm),
    fbclid: pickFirstValue(order, ATTRIBUTION_PATHS.fbclid),
    gclid: pickFirstValue(order, ATTRIBUTION_PATHS.gclid),
    msclkid: pickFirstValue(order, ATTRIBUTION_PATHS.msclkid),
    referrer: pickFirstValue(order, ATTRIBUTION_PATHS.referrer),
    landingUrl: pickFirstValue(order, ATTRIBUTION_PATHS.landingUrl),
  });

  let bucket = 'unattributed';
  let marketingSource = 'unknown';
  let basis = 'none';
  let confidence = 'none';

  if (signals.fbclid) {
    bucket = 'meta';
    marketingSource = 'meta_ads';
    basis = 'click_id';
    confidence = 'high';
  } else if (signals.gclid) {
    bucket = 'non_meta';
    marketingSource = 'google';
    basis = 'click_id';
    confidence = 'high';
  } else if (signals.msclkid) {
    bucket = 'non_meta';
    marketingSource = 'microsoft';
    basis = 'click_id';
    confidence = 'high';
  } else if (signals.utmSource) {
    const classified = classifySource(signals.utmSource);
    bucket = classified?.bucket || 'unattributed';
    marketingSource = classified?.marketingSource || signals.utmSource.toLowerCase();
    basis = 'utm';
    confidence = signals.utmCampaign ? 'medium' : 'low';
  } else if (signals.referrer) {
    const classified = classifySource(signals.referrer);
    bucket = classified?.bucket || 'unattributed';
    marketingSource = classified?.marketingSource || 'referral';
    basis = 'referrer';
    confidence = classified ? 'low' : 'none';
  } else if (signals.saleChannel) {
    const classified = normalizeSaleChannel(signals.saleChannel);
    bucket = classified?.bucket || 'unattributed';
    marketingSource = classified?.marketingSource || signals.saleChannel.toLowerCase();
    basis = 'sale_channel';
    confidence = 'low';
  }

  return {
    bucket,
    marketingSource,
    saleChannel: signals.saleChannel || null,
    device: signals.device || null,
    country: signals.country || null,
    basis,
    confidence,
    isMetaAttributed: bucket === 'meta',
    hasCampaignSignal: Boolean(signals.fbclid || signals.gclid || signals.msclkid || signals.utmCampaign),
    utmSource: signals.utmSource || null,
    utmMedium: signals.utmMedium || null,
    utmCampaign: signals.utmCampaign || null,
    utmContent: signals.utmContent || null,
    utmTerm: signals.utmTerm || null,
    referrer: signals.referrer || null,
    landingUrl: signals.landingUrl || null,
    clickIds: compactObject({
      fbclid: signals.fbclid || null,
      gclid: signals.gclid || null,
      msclkid: signals.msclkid || null,
    }),
    signals,
  };
}

function createBucketSummary() {
  return {
    meta: 0,
    non_meta: 0,
    unattributed: 0,
  };
}

function summarizeOrderAttribution(orders) {
  const summary = {
    recognizedOrders: 0,
    attributedOrders: 0,
    ordersWithCampaignSignal: 0,
    byBucket: createBucketSummary(),
    approvedAmountByBucket: createBucketSummary(),
    refundedAmountByBucket: createBucketSummary(),
    netRevenueByBucket: createBucketSummary(),
    basisCounts: {},
  };

  for (const order of Array.isArray(orders) ? orders : []) {
    const attribution = extractOrderAttribution(order);
    const { approvedAmount, refundedAmount, netPaidAmount, hasRecognizedCash } = getOrderCashTotals(order);
    if (!hasRecognizedCash) continue;

    summary.recognizedOrders += 1;
    summary.byBucket[attribution.bucket] += 1;
    summary.approvedAmountByBucket[attribution.bucket] += approvedAmount;
    summary.refundedAmountByBucket[attribution.bucket] += refundedAmount;
    summary.netRevenueByBucket[attribution.bucket] += netPaidAmount;
    summary.basisCounts[attribution.basis] = (summary.basisCounts[attribution.basis] || 0) + 1;
    if (attribution.bucket !== 'unattributed') {
      summary.attributedOrders += 1;
    }
    if (attribution.hasCampaignSignal) {
      summary.ordersWithCampaignSignal += 1;
    }
  }

  const netRevenueTotal = Object.values(summary.netRevenueByBucket).reduce((sum, value) => sum + value, 0);

  return {
    ...summary,
    approvedAmountByBucket: Object.fromEntries(
      Object.entries(summary.approvedAmountByBucket).map(([key, value]) => [key, Math.round(value)])
    ),
    refundedAmountByBucket: Object.fromEntries(
      Object.entries(summary.refundedAmountByBucket).map(([key, value]) => [key, Math.round(value)])
    ),
    netRevenueByBucket: Object.fromEntries(
      Object.entries(summary.netRevenueByBucket).map(([key, value]) => [key, Math.round(value)])
    ),
    attributionCoverageRate: summary.recognizedOrders > 0 ? summary.attributedOrders / summary.recognizedOrders : 0,
    campaignSignalRate: summary.recognizedOrders > 0 ? summary.ordersWithCampaignSignal / summary.recognizedOrders : 0,
    metaAttributedRevenueShare: netRevenueTotal > 0 ? summary.netRevenueByBucket.meta / netRevenueTotal : 0,
  };
}

module.exports = {
  getOrderSections,
  getSectionItems,
  getOrderItems,
  extractOrderAttribution,
  summarizeOrderAttribution,
};
