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

test('profit structure shows net profit chart under profit movement without duplicate section titles', () => {
  assert.match(indexHtml, /<canvas id="profitWaterfallChart"><\/canvas>[\s\S]*<div class="card chart-card net-profit-card">[\s\S]*id="netProfitSummary"[\s\S]*<canvas id="netProfitChart"><\/canvas>[\s\S]*<div class="charts-grid order-patterns-grid">/);
  assert.match(indexHtml, /data-i18n="chart.netProfitMargin"/);
  assert.doesNotMatch(indexHtml, /analytics.structureKicker|analytics.structureTitle|analytics.orderPatternsKicker|analytics.orderPatternsTitle/);
  assert.doesNotMatch(indexHtml, /analytics.operationsKicker|analytics.operationsTitle|refund-quality-grid|refund-quality-kpis/);
  assert.doesNotMatch(indexHtml, /data-kpi-analytics="refundRate"|data-kpi-analytics="cancelRate"/);
  assert.doesNotMatch(indexHtml, /data-kpi-analytics="febRefundRate"|data-kpi-analytics="marRefundRate"/);
  assert.doesNotMatch(css, /\.refund-quality-grid|\.refund-quality-kpis/);
  assert.match(css, /\.net-profit-card\s*\{[\s\S]*margin-top:\s*var\(--space-4\);/);
});

test('net profit chart follows the profit movement window instead of monthly refunds', () => {
  assert.match(analyticsJs, /buildNetProfitBuckets\(waterfallBuckets\)/);
  assert.match(analyticsJs, /sliceRowsByWindow\(pa\.waterfall \|\| \[\], 'profit-structure'\)/);
  assert.match(analyticsJs, /formatNullableSignedKrw\(totalProfit\)[\s\S]*formatNullablePercent\(blendedMargin, 1\)[\s\S]*formatNullableKrw\(totalNetRevenue\)/);
  assert.match(analyticsJs, /netProfitDataset\.data = netProfitBuckets\.map\(row => row\.trueNetProfit\)/);
  assert.match(analyticsJs, /netProfitDataset\.netProfitMargins = netProfitBuckets\.map\(row => row\.margin\)/);
  assert.doesNotMatch(analyticsJs, /monthlyRefunds/);
});

test('profit movement excludes the separate refund series and uses net revenue against total costs', () => {
  assert.match(analyticsJs, /profitWaterfallChart\.data\.datasets\[0\]\.data = waterfallBuckets\.map\(row => row\.revenue - row\.refunded\)/);
  assert.match(analyticsJs, /profitWaterfallChart\.data\.datasets\[1\]\.data = waterfallBuckets\.map\(row =>\s*-\(row\.cogs \+ row\.cogsShipping \+ row\.adSpendKRW \+ row\.paymentFees\)/);
  assert.match(analyticsJs, /const periodCount = waterfallBuckets\.length;/);
  assert.match(analyticsJs, /periodCount === 1 \? 'period' : 'periods'/);
  assert.match(analyticsJs, /windowContextLabel[\s\S]*\$\{esc\(granularityLabel\)\}:<\/strong> \$\{esc\(windowContextLabel\)\} · \$\{esc\(periodsShownLabel\)\}/);
  assert.doesNotMatch(analyticsJs, /Daily view refund rate|granularityLabel\)} refund rate/);
});

test('net profit chart data labels show net margin from the same visible buckets', () => {
  assert.match(analyticsJs, /function buildNetProfitBuckets\(waterfallBuckets\)/);
  assert.match(analyticsJs, /const revenue = toFiniteNumber\(row\.revenue\);[\s\S]*const refunded = toFiniteNumber\(row\.refunded\);[\s\S]*const netRevenue = revenue - refunded;/);
  assert.match(analyticsJs, /const trueNetProfit = toFiniteNumber\(row\.trueNetProfit\);/);
  assert.match(analyticsJs, /const margin = netRevenue > 0 \? Number\(\(\(trueNetProfit \/ netRevenue\) \* 100\)\.toFixed\(1\)\) : null;/);
  assert.match(analyticsJs, /netProfitDataset\.netProfitMargins = netProfitBuckets\.map\(row => row\.margin\)/);
});

test('profit summary no longer renders or fetches settlement reconciliation UI', () => {
  assert.doesNotMatch(indexHtml, /reconciliationSummaryCard|reconciliationCard|reconciliationTable/);
  assert.doesNotMatch(analyticsJs, /fetchReconciliation|updateReconciliationSection|buildVisibleReconciliationReport/);
});

test('order pattern section avoids duplicate campaign and weekday table surfaces', () => {
  assert.match(indexHtml, /<div class="card chart-card order-pattern-card">[\s\S]*(Average orders &amp; revenue in the week|Average orders & revenue in the week)/);
  assert.match(indexHtml, /<div class="card chart-card order-pattern-card">[\s\S]*data-series-window-group="order-patterns"[\s\S]*<canvas id="weekdayChart"><\/canvas>/);
  assert.match(indexHtml, /<canvas id="weekdayChart"><\/canvas>[\s\S]*<canvas id="hourChart"><\/canvas>/);
  assert.doesNotMatch(indexHtml, /Campaign Profit Leaderboard|campaignProfitTable|weekdayTable/);
  assert.doesNotMatch(indexHtml, /Media Profitability|Media Efficiency/);
});

test('analytics payload no longer computes campaign-profit surfaces for removed UI', () => {
  assert.doesNotMatch(analyticsServiceJs, /buildCampaignEconomics|campaignProfitWindows|toCampaignProfitWindow/);
  assert.doesNotMatch(contractsJs, /campaignProfitWindows|campaignProfit:/);
});
