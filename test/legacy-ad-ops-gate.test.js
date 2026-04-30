const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('legacy ad-operation routes require an explicit feature flag gate', () => {
  const config = fs.readFileSync(path.join(__dirname, '..', 'server/config.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '..', 'server/index.js'), 'utf8');

  assert.match(config, /legacyAdOpsEnabled: process\.env\.LEGACY_AD_OPS_ENABLED === 'true'/);
  assert.match(index, /function requireLegacyAdOps/);
  assert.match(index, /app\.get\('\/api\/live-performance', requireLegacyAdOps/);
  assert.match(index, /app\.get\('\/api\/postmortem', requireLegacyAdOps/);
  assert.doesNotMatch(index, /app\.post\('\/api\/campaigns\/:id\/status'/);
  assert.doesNotMatch(index, /app\.post\('\/api\/campaigns\/:id\/budget'/);
});
