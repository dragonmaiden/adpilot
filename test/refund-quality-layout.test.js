const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');
const ANALYTICS_JS_PATH = path.join(
  __dirname,
  '..',
  'public',
  'live',
  'pages',
  'analytics.js'
);
const CALENDAR_JS_PATH = path.join(
  __dirname,
  '..',
  'public',
  'live',
  'pages',
  'calendar.js'
);
const ANALYTICS_SERVICE_PATH = path.join(
  __dirname,
  '..',
  'server',
  'services',
  'analyticsService.js'
);
const CONTRACTS_PATH = path.join(__dirname, '..', 'server', 'contracts', 'v1.js');

const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const analyticsJs = fs.readFileSync(ANALYTICS_JS_PATH, 'utf8');
const calendarJs = fs.readFileSync(CALENDAR_JS_PATH, 'utf8');
const analyticsServiceJs = fs.readFileSync(ANALYTICS_SERVICE_PATH, 'utf8');
const contractsJs = fs.readFileSync(CONTRACTS_PATH, 'utf8');

test('retired analysis sections stay removed below the income statement', () => {
  const summaryPage = indexHtml.slice(
    indexHtml.indexOf('<section class="page active" data-page="calendar">'),
    indexHtml.indexOf('<!-- Settings Page -->')
  );
  const statementIndex = summaryPage.indexOf('id="calendarIncomeStatementDeck"');

  assert.ok(statementIndex >= 0);
  assert.doesNotMatch(
    summaryPage.slice(statementIndex),
    /Profit Movement|Net Profit &amp; Margin|Orders &amp; revenue by weekday|Order Timing Distribution|Daily Breakdown|Orders Ledger|Product Explorer/
  );
});

test('selected-range headline remains without retired chart renderers', () => {
  assert.match(analyticsJs, /function renderCalendarSelectionProfitSummary\(payload = \{\}\)/);
  assert.match(analyticsJs, /buildSelectionSummary\(rows,\s*selection\)/);
  assert.match(
    analyticsJs,
    /live\.profitSummary = \{[\s\S]*renderCalendarSelection: renderCalendarSelectionProfitSummary/
  );
  assert.doesNotMatch(
    analyticsJs,
    /profitWaterfallChart|netProfitChart|weekdayChart|hourChart|updatePatternCharts/
  );
  assert.match(
    calendarJs,
    /statementContainer\.innerHTML = renderCalendarIncomeStatement\(selection, calendarState\.data\.fx\);/
  );
});

test('selected-range headline keeps one net-profit owner and one row of supporting metrics', () => {
  assert.doesNotMatch(indexHtml, /data-profit-source-kpi="trueNetProfit"/);
  assert.doesNotMatch(analyticsJs, /updateProfitInputCard\(\s*'trueNetProfit'/);
  assert.doesNotMatch(analyticsJs, /\['grossRevenue', 'refunds', 'totalCosts', 'trueNetProfit'\]/);
  assert.match(indexHtml, /class="kpi-grid summary-profit-kpis"/);
});

test('profit summary no longer renders settlement reconciliation UI', () => {
  assert.doesNotMatch(indexHtml, /reconciliationSummaryCard|reconciliationCard|reconciliationTable/);
  assert.doesNotMatch(
    analyticsJs,
    /fetchReconciliation|updateReconciliationSection|buildVisibleReconciliationReport/
  );
});

test('analytics payload no longer computes campaign-profit surfaces for removed UI', () => {
  assert.doesNotMatch(
    analyticsServiceJs,
    /buildCampaignEconomics|campaignProfitWindows|toCampaignProfitWindow/
  );
  assert.doesNotMatch(contractsJs, /campaignProfitWindows|campaignProfit:/);
});
