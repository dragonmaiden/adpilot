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

test('operations summary consolidates refund chart and the two core quality cards', () => {
  assert.match(indexHtml, /<div class="refund-quality-grid">[\s\S]*<canvas id="refundChart"><\/canvas>[\s\S]*data-kpi-analytics="refundRate"[\s\S]*data-kpi-analytics="cancelRate"/);
  assert.doesNotMatch(indexHtml, /data-kpi-analytics="febRefundRate"/);
  assert.doesNotMatch(indexHtml, /data-kpi-analytics="marRefundRate"/);
  assert.match(css, /\.refund-quality-grid\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1\.15fr\)\s*minmax\(320px,\s*0\.85fr\);[\s\S]*align-items:\s*center;/);
  assert.match(css, /\.refund-quality-kpis\s*\{[\s\S]*grid-template-columns:\s*1fr;/);
  assert.match(indexHtml, /Return \/ Cancel Sections/);
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
