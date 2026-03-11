// ═══════════════════════════════════════════════════════
// AdPilot — Vendor Payload Validation
// Checks that vendor API responses match expected shapes.
// Fails loudly if critical fields are missing.
// ═══════════════════════════════════════════════════════

/**
 * Validate Meta campaigns array.
 * Required fields: id, name, status
 * @param {Array} campaigns
 * @returns {{ valid: boolean, warnings: string[], errors: string[] }}
 */
function validateMetaCampaigns(campaigns) {
  const result = { valid: true, warnings: [], errors: [] };

  if (!Array.isArray(campaigns)) {
    result.valid = false;
    result.errors.push('[VALIDATION] Meta campaigns: expected array, got ' + typeof campaigns);
    return result;
  }

  const requiredFields = ['id', 'name', 'status'];
  const expectedFields = ['id', 'name', 'status', 'daily_budget', 'lifetime_budget', 'bid_strategy', 'objective', 'effective_status', 'start_time', 'updated_time'];

  let missingFieldCounts = {};
  let unexpectedFieldExamples = new Set();

  for (const campaign of campaigns) {
    // Check required fields
    for (const field of requiredFields) {
      if (campaign[field] === undefined || campaign[field] === null) {
        missingFieldCounts[field] = (missingFieldCounts[field] || 0) + 1;
      }
    }

    // Check for unexpected fields (shape drift)
    for (const key of Object.keys(campaign)) {
      if (!expectedFields.includes(key) && unexpectedFieldExamples.size < 5) {
        unexpectedFieldExamples.add(key);
      }
    }
  }

  // Report missing required fields as errors
  for (const [field, count] of Object.entries(missingFieldCounts)) {
    if (requiredFields.includes(field)) {
      result.valid = false;
      result.errors.push(`[VALIDATION] Meta campaigns: required field '${field}' missing on ${count}/${campaigns.length} items`);
    }
  }

  // Report unexpected fields as warnings (possible shape drift)
  if (unexpectedFieldExamples.size > 0) {
    result.warnings.push(`[VALIDATION] Meta campaigns: unexpected fields detected: ${[...unexpectedFieldExamples].join(', ')}`);
  }

  return result;
}

/**
 * Validate Meta insight rows.
 * Required fields: date_start, spend
 * @param {Array} insights
 * @param {string} level - 'campaign' | 'adset' | 'ad'
 * @returns {{ valid: boolean, warnings: string[], errors: string[] }}
 */
function validateMetaInsights(insights, level = 'campaign') {
  const result = { valid: true, warnings: [], errors: [] };

  if (!Array.isArray(insights)) {
    result.valid = false;
    result.errors.push(`[VALIDATION] Meta ${level} insights: expected array, got ${typeof insights}`);
    return result;
  }

  if (insights.length === 0) {
    result.warnings.push(`[VALIDATION] Meta ${level} insights: empty array — no data in date range`);
    return result;
  }

  const requiredFields = ['date_start', 'spend'];
  const idField = level === 'campaign' ? 'campaign_id' : level === 'adset' ? 'adset_id' : 'ad_id';
  requiredFields.push(idField);

  let missingFieldCounts = {};
  let noActionRows = 0;

  for (const row of insights) {
    for (const field of requiredFields) {
      if (row[field] === undefined || row[field] === null) {
        missingFieldCounts[field] = (missingFieldCounts[field] || 0) + 1;
      }
    }

    if (!row.actions || !Array.isArray(row.actions)) {
      noActionRows++;
    }
  }

  for (const [field, count] of Object.entries(missingFieldCounts)) {
    result.valid = false;
    result.errors.push(`[VALIDATION] Meta ${level} insights: required field '${field}' missing on ${count}/${insights.length} rows`);
  }

  if (noActionRows > insights.length * 0.5) {
    result.warnings.push(`[VALIDATION] Meta ${level} insights: ${noActionRows}/${insights.length} rows have no 'actions' array — conversion tracking may be broken`);
  }

  return result;
}

/**
 * Validate Imweb orders array.
 * @param {Array} orders
 * @returns {{ valid: boolean, warnings: string[], errors: string[] }}
 */
function validateImwebOrders(orders) {
  const result = { valid: true, warnings: [], errors: [] };

  if (!Array.isArray(orders)) {
    result.valid = false;
    result.errors.push('[VALIDATION] Imweb orders: expected array, got ' + typeof orders);
    return result;
  }

  if (orders.length === 0) {
    result.warnings.push('[VALIDATION] Imweb orders: empty array — no orders found');
    return result;
  }

  let missingPrice = 0;
  let missingTime = 0;
  let missingSections = 0;
  let unexpectedFields = new Set();

  const expectedFields = [
    'totalPaymentPrice', 'totalPrice', 'totalRefundedPrice',
    'wtime', 'sections', 'orderSections',
    'orderNo', 'orderStatus', 'paymentMethod', 'payments',
  ];

  for (const order of orders) {
    if (order.totalPaymentPrice === undefined && order.totalPrice === undefined) {
      missingPrice++;
    }
    if (!order.wtime) {
      missingTime++;
    }
    if (!order.sections && !order.orderSections) {
      missingSections++;
    }

    // Check for unexpected top-level fields (shape drift)
    for (const key of Object.keys(order)) {
      if (!expectedFields.includes(key) && unexpectedFields.size < 10) {
        unexpectedFields.add(key);
      }
    }
  }

  if (missingPrice > 0) {
    result.warnings.push(`[VALIDATION] Imweb orders: ${missingPrice}/${orders.length} orders missing price field (totalPaymentPrice or totalPrice)`);
  }

  if (missingTime > orders.length * 0.1) {
    result.valid = false;
    result.errors.push(`[VALIDATION] Imweb orders: ${missingTime}/${orders.length} orders missing 'wtime' — cannot build time-series`);
  }

  if (missingSections > orders.length * 0.5) {
    result.warnings.push(`[VALIDATION] Imweb orders: ${missingSections}/${orders.length} orders missing 'sections' — cancel tracking will be inaccurate`);
  }

  if (unexpectedFields.size > 3) {
    result.warnings.push(`[VALIDATION] Imweb orders: new fields detected: ${[...unexpectedFields].slice(0, 5).join(', ')}... — API shape may have changed`);
  }

  return result;
}

/**
 * Log validation results and throw on critical failures.
 * @param {Object} result - { valid, warnings, errors }
 * @param {string} context - e.g. 'Meta campaigns'
 * @param {boolean} strict - if true, throw on any error
 */
function logValidation(result, context, strict = false) {
  for (const w of result.warnings) {
    console.warn(w);
  }
  for (const e of result.errors) {
    console.error(e);
  }

  if (!result.valid && strict) {
    throw new Error(`Validation failed for ${context}: ${result.errors.join('; ')}`);
  }

  return result.valid;
}

module.exports = {
  validateMetaCampaigns,
  validateMetaInsights,
  validateImwebOrders,
  logValidation,
};
