const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { __private } = require('../server/modules/scanRunner');
const { logValidation } = require('../server/validation/vendorSchemas');

test('resolveAdInsightsSince caps ad insight scans to a recent rolling window', () => {
  assert.equal(__private.resolveAdInsightsSince('2026-02-01', '2026-03-15'), '2026-02-01');
});

test('resolveAdInsightsSince uses the rolling window when business history is older than the recent cap', () => {
  assert.equal(__private.resolveAdInsightsSince('2025-11-01', '2026-03-15'), '2026-01-30');
  assert.equal(__private.resolveAdInsightsSince('2025-11-01', '2026-03-15', 30), '2026-02-14');
});

test('vendor validation can fail loud before source data is patched', () => {
  assert.throws(
    () => logValidation({ valid: false, warnings: [], errors: ['missing orderNo'] }, 'Imweb orders', true),
    /Validation failed for Imweb orders: missing orderNo/
  );
});

test('source fetches use strict validation before writing latest data', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server/modules/scanRunner.js'), 'utf8');

  assert.match(source, /logValidation\(campaignsValidation, 'Meta campaigns', true\)/);
  assert.match(source, /logValidation\(campaignInsightsValid, 'Meta campaign insights', true\)/);
  assert.match(source, /logValidation\(adInsightsValid, 'Meta ad insights', true\)/);
  assert.match(source, /logValidation\(ordersValid, 'Imweb orders', true\)/);
});

test('scan runner records a source audit after projection writes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server/modules/scanRunner.js'), 'utf8');

  assert.match(source, /buildSourceExtractionAudit/);
  assert.match(source, /step: 'source_audit'/);
  assert.match(source, /sourceAudit: latestData\.sourceAudit/);
});

test('scan runner audits recent paid-order Telegram delivery coverage', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server/modules/scanRunner.js'), 'utf8');

  assert.match(source, /buildOrderNotificationAudit\(recentOrders\)/);
  assert.match(source, /step: 'order_notification_audit'/);
  assert.match(source, /pushError\(scanResult, 'order_notification_audit'/);
});

test('scan runner sends paid fallback notifications for duplicate paid orders without prior state', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server/modules/scanRunner.js'), 'utf8');

  assert.match(
    source,
    /for \(const duplicate of result\.duplicates\) {\s+await orderNotificationService\.deliverPaidOrderNotification\(duplicate\);\s+}/
  );
  assert.doesNotMatch(source, /duplicate\?\.alreadyNotified/);
});
