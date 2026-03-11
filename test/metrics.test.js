const test = require('node:test');
const assert = require('node:assert/strict');

const { getPurchases, summarizeInsights } = require('../server/domain/metrics');

test('getPurchases counts a Meta insight row once even when purchase aliases are duplicated', () => {
  const actions = [
    { action_type: 'purchase', value: '1' },
    { action_type: 'offsite_conversion.fb_pixel_purchase', value: '1' },
    { action_type: 'omni_purchase', value: '1' },
  ];

  assert.equal(getPurchases(actions), 1);
});

test('summarizeInsights derives campaign CPA from canonical Meta-attributed purchases', () => {
  const rows = [
    { spend: '100', clicks: '100', impressions: '1000', actions: [{ action_type: 'purchase', value: '8' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '8' }, { action_type: 'omni_purchase', value: '8' }] },
    { spend: '100', clicks: '100', impressions: '1000', actions: [{ action_type: 'purchase', value: '8' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '8' }, { action_type: 'omni_purchase', value: '8' }] },
    { spend: '100', clicks: '100', impressions: '1000', actions: [{ action_type: 'purchase', value: '8' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '8' }, { action_type: 'omni_purchase', value: '8' }] },
    { spend: '100', clicks: '100', impressions: '1000', actions: [{ action_type: 'purchase', value: '8' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '8' }, { action_type: 'omni_purchase', value: '8' }] },
    { spend: '100', clicks: '100', impressions: '1000', actions: [{ action_type: 'purchase', value: '8' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '8' }, { action_type: 'omni_purchase', value: '8' }] },
    { spend: '100', clicks: '100', impressions: '1000', actions: [{ action_type: 'purchase', value: '8' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '8' }, { action_type: 'omni_purchase', value: '8' }] },
    { spend: '231.68', clicks: '100', impressions: '1000', actions: [{ action_type: 'purchase', value: '20' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '20' }, { action_type: 'omni_purchase', value: '20' }] },
  ];

  const summary = summarizeInsights(rows);

  assert.equal(summary.purchases, 68);
  assert.ok(Math.abs(summary.cpa - 12.230588235294118) < 0.0001);
});
