const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');
const ANALYTICS_JS_PATH = path.join(__dirname, '..', 'public', 'live', 'pages', 'analytics.js');
const STYLE_PATH = path.join(__dirname, '..', 'public', 'style.css');
const ANALYTICS_SERVICE_PATH = path.join(__dirname, '..', 'server', 'services', 'analyticsService.js');
const CONTRACTS_PATH = path.join(__dirname, '..', 'server', 'contracts', 'v1.js');

const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const analyticsJs = fs.readFileSync(ANALYTICS_JS_PATH, 'utf8');
const css = fs.readFileSync(STYLE_PATH, 'utf8');
const analyticsServiceJs = fs.readFileSync(ANALYTICS_SERVICE_PATH, 'utf8');
const contractsJs = fs.readFileSync(CONTRACTS_PATH, 'utf8');

test('profit structure shows a full-width refund rate chart under profit movement', () => {
  assert.match(indexHtml, /<canvas id="profitWaterfallChart"><\/canvas>[\s\S]*<div class="card chart-card refund-rate-card">[\s\S]*id="refundRateSummary"[\s\S]*<canvas id="refundChart"><\/canvas>[\s\S]*data-i18n="analytics.orderPatternsKicker"/);
  assert.match(indexHtml, /data-i18n="chart.refundRate"/);
  assert.doesNotMatch(indexHtml, /analytics.operationsKicker|analytics.operationsTitle|refund-quality-grid|refund-quality-kpis/);
  assert.doesNotMatch(indexHtml, /data-kpi-analytics="refundRate"|data-kpi-analytics="cancelRate"/);
  assert.doesNotMatch(indexHtml, /data-kpi-analytics="febRefundRate"|data-kpi-analytics="marRefundRate"/);
  assert.doesNotMatch(css, /\.refund-quality-grid|\.refund-quality-kpis/);
  assert.match(css, /\.refund-rate-card\s*\{[\s\S]*margin-top:\s*var\(--space-4\);/);
});

test('refund rate chart follows the profit movement window instead of monthly refunds', () => {
  assert.match(analyticsJs, /buildRefundRateBuckets\(waterfallBuckets\)/);
  assert.match(analyticsJs, /sliceRowsByWindow\(pa\.waterfall \|\| \[\], 'profit-structure'\)/);
  assert.match(analyticsJs, /formatNullableKrw\(totalRefunded\)[\s\S]*formatNullablePercent\(refundRate, 1\)[\s\S]*formatNullableKrw\(totalGrossRevenue\)/);
  assert.match(analyticsJs, /refundRateDataset\.data = refundRateBuckets\.map\(row => row\.rate\)/);
  assert.doesNotMatch(analyticsJs, /monthlyRefunds/);
});

test('profit movement excludes the separate refund series and uses net revenue against total costs', () => {
  assert.match(analyticsJs, /profitWaterfallChart\.data\.datasets\[0\]\.data = waterfallBuckets\.map\(row => row\.revenue - row\.refunded\)/);
  assert.match(analyticsJs, /profitWaterfallChart\.data\.datasets\[1\]\.data = waterfallBuckets\.map\(row =>\s*-\(row\.cogs \+ row\.cogsShipping \+ row\.adSpendKRW \+ row\.paymentFees\)/);
  assert.doesNotMatch(analyticsJs, /Daily view refund rate|granularityLabel\)} refund rate/);
});

test('profit summary no longer renders or fetches settlement reconciliation UI', () => {
  assert.doesNotMatch(indexHtml, /reconciliationSummaryCard|reconciliationCard|reconciliationTable/);
  assert.doesNotMatch(analyticsJs, /fetchReconciliation|updateReconciliationSection|buildVisibleReconciliationReport/);
});

test('order pattern section avoids duplicate campaign and weekday table surfaces', () => {
  assert.match(indexHtml, /Average orders &amp; revenue in the week|Average orders & revenue in the week/);
  assert.match(indexHtml, /<canvas id="weekdayChart"><\/canvas>[\s\S]*<canvas id="hourChart"><\/canvas>/);
  assert.doesNotMatch(indexHtml, /Campaign Profit Leaderboard|campaignProfitTable|weekdayTable/);
  assert.doesNotMatch(indexHtml, /Media Profitability|Media Efficiency/);
});

test('analytics payload no longer computes campaign-profit surfaces for removed UI', () => {
  assert.doesNotMatch(analyticsServiceJs, /buildCampaignEconomics|campaignProfitWindows|toCampaignProfitWindow/);
  assert.doesNotMatch(contractsJs, /campaignProfitWindows|campaignProfit:/);
});
