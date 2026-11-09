const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { __private } = require('../server/modules/scanRunner');
const { logValidation } = require('../server/validation/vendorSchemas');

test('a failed checkpoint does not prevent a fresh COGS read and reports persistence failure', async t => {
  const store = require('../server/modules/scanStore');
  const cogs = require('../server/modules/cogsClient');
  const previous = store.getLatestData();
  const savedCogs = previous.cogsData;
  const savedHealth = { ...previous.sources.cogs };
  t.after(() => {
    store.patchLatestData({ cogsData: savedCogs });
    store.updateSourceHealth('cogs', savedHealth);
  });
  t.mock.method(store, 'saveLatestData', () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  t.mock.method(cogs, 'fetchAllCOGS', async () => ({ totalCOGS: 123, totalShipping: 4, itemCount: 1, orderCount: 1, orders: [] }));
  const scan = { steps: [], errors: [] };
  __private.persistCheckpoint(scan);
  const result = await __private.fetchCogs(scan);
  assert.equal(result.ok, true);
  assert.equal(store.getLatestData().cogsData.totalCOGS, 123);
  assert.equal(store.getSourceHealth().cogs.stale, false);
  assert.ok(scan.errors.some(error => error.step === 'checkpoint' && error.error === 'disk full'));
});

test('failed Sheet fetch remains stale even when saving the failure also fails', async t => {
  const store = require('../server/modules/scanStore');
  const cogs = require('../server/modules/cogsClient');
  const savedCogs = store.getLatestData().cogsData;
  const savedHealth = { ...store.getSourceHealth().cogs };
  t.after(() => {
    store.patchLatestData({ cogsData: savedCogs });
    store.updateSourceHealth('cogs', savedHealth);
  });
  store.patchLatestData({ cogsData: { totalCOGS: 100 } });
  t.mock.method(store, 'saveLatestData', () => { throw new Error('disk full'); });
  t.mock.method(cogs, 'fetchAllCOGS', async () => { throw new Error('Sheet unavailable'); });
  const scan = { steps: [], errors: [] };
  assert.equal((await __private.fetchCogs(scan)).ok, false);
  assert.equal(store.getSourceHealth().cogs.stale, true);
  assert.equal(store.getSourceHealth().cogs.lastError, 'Sheet unavailable');
  assert.equal(store.getLatestData().cogsData.totalCOGS, 100);
});

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
    /for \(const duplicate of result\.duplicates\) {\s+await orderNotificationService\.deliverPaidOrderNotification\(duplicate\);\s+await new Promise\(resolve => setImmediate\(resolve\)\);\s+}/
  );
  assert.doesNotMatch(source, /duplicate\?\.alreadyNotified/);
});

test('scan runner refreshes COGS-pending daily Telegram reports after source updates', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server/modules/scanRunner.js'), 'utf8');

  assert.match(source, /telegram\.refreshPendingDailyReports\(scanStore\.getLatestData\(\)\)/);
  assert.match(source, /step: 'daily_report_corrections'/);
});

test('scan runner records Payway watcher skip reasons on new-order backfill', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server/modules/scanRunner.js'), 'utf8');

  assert.match(source, /const paywayWatchSkipReasons = \{\}/);
  assert.match(source, /collectRecentPaywayPaymentWatchCandidates/);
  assert.match(source, /paywayWatchesRefreshed/);
  assert.match(source, /paywayWatchSkipReasons\[reason\]/);
  assert.match(source, /paywayWatchSkipReasons,/);
});
