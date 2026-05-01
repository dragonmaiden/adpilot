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
  assert.doesNotMatch(indexHtml, /chart-container" style="height:/);
  assert.doesNotMatch(css, /\.refund-quality-grid|\.refund-quality-kpis/);
  assert.match(css, /--chart-visual-height:\s*clamp\(380px,\s*34vw,\s*420px\);/);
  assert.match(css, /\.chart-container\s*\{\s*position:\s*relative;\s*height:\s*var\(--chart-visual-height\);/);
  assert.match(css, /\.net-profit-card\s*\{[\s\S]*margin-top:\s*var\(--space-4\);/);
});

test('profit movement uses the calendar selection instead of manual timeframe controls', () => {
  assert.doesNotMatch(indexHtml, /data-profit-waterfall-granularity|data-series-window-group="profit-structure"/);
  assert.match(analyticsJs, /function chooseSelectionGranularity\(rows\)/);
  assert.match(analyticsJs, /chooseSelectionGranularity\(rows\)/);
  assert.doesNotMatch(analyticsJs, /profitWaterfallGranularity|data-profit-waterfall-granularity/);
});

test('net profit chart follows the selected calendar range instead of monthly refunds', () => {
  assert.match(analyticsJs, /buildNetProfitBuckets\(waterfallBuckets\)/);
  assert.match(analyticsJs, /normalizeCalendarWaterfallRows\(payload\.rows \|\| selection\.days \|\| \[\]\)/);
  assert.match(analyticsJs, /buildSelectionSummary\(rows,\s*selection\)/);
  assert.match(analyticsJs, /live\.profitSummary = \{[\s\S]*renderCalendarSelection: renderCalendarSelectionProfitSummary/);
  assert.match(analyticsJs, /formatNullableSignedKrw\(totalProfit\)[\s\S]*formatNullablePercent\(blendedMargin, 1\)[\s\S]*formatNullableKrw\(totalNetRevenue\)/);
  assert.match(analyticsJs, /label:\s*formatShortDateLabel\(key\)/);
  assert.doesNotMatch(analyticsJs, /Week of/);
  assert.doesNotMatch(analyticsJs, /sliceRowsByWindow|getSeriesWindowMeta|fetchAnalytics/);
  assert.match(analyticsJs, /const netProfitValues = netProfitBuckets\.map\(row => row\.trueNetProfit\)/);
  assert.match(analyticsJs, /const marginValues = netProfitBuckets\.map\(row => row\.margin\)/);
  assert.match(analyticsJs, /netProfitDataset\.data = netProfitValues/);
  assert.match(analyticsJs, /marginDataset\.data = marginValues/);
  assert.doesNotMatch(analyticsJs, /monthlyRefunds/);
});

test('profit movement excludes the separate refund series and uses net revenue against total costs', () => {
  assert.match(analyticsJs, /const netRevenueValues = waterfallBuckets\.map\(row => row\.revenue - row\.refunded\)/);
  assert.match(analyticsJs, /const costValues = waterfallBuckets\.map\(row =>\s*-\(row\.cogs \+ row\.cogsShipping \+ row\.adSpendKRW \+ row\.paymentFees\)/);
  assert.match(analyticsJs, /profitWaterfallChart\.data\.datasets\[0\]\.data = netRevenueValues/);
  assert.match(analyticsJs, /profitWaterfallChart\.data\.datasets\[1\]\.data = costValues/);
  assert.match(analyticsJs, /const periodCount = waterfallBuckets\.length;/);
  assert.match(analyticsJs, /periodCount === 1 \? 'period' : 'periods'/);
  assert.match(analyticsJs, /windowContextLabel[\s\S]*\$\{esc\(granularityLabel\)\}:<\/strong> \$\{esc\(windowContextLabel\)\} · \$\{esc\(periodsShownLabel\)\}/);
  assert.doesNotMatch(analyticsJs, /Daily view refund rate|granularityLabel\)} refund rate/);
});

test('net profit chart scales bars by net profit and overlays margin from the same buckets', () => {
  assert.match(analyticsJs, /function buildNetProfitBuckets\(waterfallBuckets\)/);
  assert.match(analyticsJs, /const revenue = toFiniteNumber\(row\.revenue\);[\s\S]*const refunded = toFiniteNumber\(row\.refunded\);[\s\S]*const netRevenue = revenue - refunded;/);
  assert.match(analyticsJs, /const trueNetProfit = toFiniteNumber\(row\.trueNetProfit\);/);
  assert.match(analyticsJs, /const margin = netRevenue > 0 \? Number\(\(\(trueNetProfit \/ netRevenue\) \* 100\)\.toFixed\(1\)\) : null;/);
  assert.match(analyticsJs, /const netProfitValues = netProfitBuckets\.map\(row => row\.trueNetProfit\);/);
  assert.match(analyticsJs, /const marginValues = netProfitBuckets\.map\(row => row\.margin\);/);
  assert.match(analyticsJs, /netProfitDataset\.data = netProfitValues;/);
  assert.match(analyticsJs, /netProfitDataset\.marginValues = marginValues;/);
  assert.match(analyticsJs, /marginDataset\.data = marginValues;/);
  assert.match(analyticsJs, /const finiteMarginValues = marginValues[\s\S]*\.filter\(value => Number\.isFinite\(value\)\);/);
  assert.match(analyticsJs, /const showChartValueLabels = selectedGranularity !== 'day';/);
  assert.match(analyticsJs, /profitWaterfallChart\.data\.datasets\[0\]\.showValueLabels = showChartValueLabels;/);
  assert.match(analyticsJs, /netProfitDataset\.showValueLabels = showChartValueLabels;/);
  assert.match(analyticsJs, /setCurrencyAxisBreathingRoom\(profitWaterfallChart, \[\.\.\.netRevenueValues, \.\.\.costValues\], showChartValueLabels\)/);
  assert.match(analyticsJs, /setCurrencyAxisBreathingRoom\(netProfitChartInstance, netProfitValues, showChartValueLabels\)/);
  assert.match(analyticsJs, /setPercentAxisBreathingRoom\(netProfitChartInstance, finiteMarginValues, false, 'y1'\)/);
  assert.match(analyticsJs, /function setChartTopPadding\(chart, top\)/);
  assert.match(analyticsJs, /options\.scales\.x\.ticks\.minRotation = 45;[\s\S]*options\.scales\.x\.ticks\.maxRotation = 45;/);
  assert.doesNotMatch(analyticsJs, /\.\.\.\(chart\.options\.layout\.padding \|\| \{\}\)/);
  assert.doesNotMatch(analyticsJs, /chart\.options\.layout = chart\.options\.layout \|\| \{\}/);
});

test('profit summary no longer renders or fetches settlement reconciliation UI', () => {
  assert.doesNotMatch(indexHtml, /reconciliationSummaryCard|reconciliationCard|reconciliationTable/);
  assert.doesNotMatch(analyticsJs, /fetchReconciliation|updateReconciliationSection|buildVisibleReconciliationReport/);
});

test('order pattern section avoids duplicate campaign and weekday table surfaces', () => {
  assert.match(indexHtml, /<div class="card chart-card order-pattern-card">[\s\S]*Orders &amp; revenue by weekday/);
  assert.match(indexHtml, /<div class="card chart-card order-pattern-card">[\s\S]*<canvas id="weekdayChart"><\/canvas>/);
  assert.doesNotMatch(indexHtml, /data-series-window-group="order-patterns"/);
  assert.match(indexHtml, /<canvas id="weekdayChart"><\/canvas>[\s\S]*<canvas id="hourChart"><\/canvas>/);
  assert.doesNotMatch(indexHtml, /Campaign Profit Leaderboard|campaignProfitTable|weekdayTable/);
  assert.doesNotMatch(indexHtml, /Media Profitability|Media Efficiency/);
});

test('analytics payload no longer computes campaign-profit surfaces for removed UI', () => {
  assert.doesNotMatch(analyticsServiceJs, /buildCampaignEconomics|campaignProfitWindows|toCampaignProfitWindow/);
  assert.doesNotMatch(contractsJs, /campaignProfitWindows|campaignProfit:/);
});
