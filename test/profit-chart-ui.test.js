const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_PATH = path.join(__dirname, '..', 'public', 'app.js');
const STYLE_PATH = path.join(__dirname, '..', 'public', 'style.css');
const UTILS_PATH = path.join(__dirname, '..', 'public', 'utils.js');
const SHARED_PATH = path.join(__dirname, '..', 'public', 'live', 'shared.js');
const CALENDAR_JS_PATH = path.join(__dirname, '..', 'public', 'live', 'pages', 'calendar.js');
const LIVE_PERFORMANCE_SERVICE_PATH = path.join(__dirname, '..', 'server', 'services', 'livePerformanceService.js');

const appJs = fs.readFileSync(APP_PATH, 'utf8');
const css = fs.readFileSync(STYLE_PATH, 'utf8');
const utilsJs = fs.readFileSync(UTILS_PATH, 'utf8');
const sharedJs = fs.readFileSync(SHARED_PATH, 'utf8');
const calendarJs = fs.readFileSync(CALENDAR_JS_PATH, 'utf8');
const livePerformanceServiceJs = fs.readFileSync(LIVE_PERFORMANCE_SERVICE_PATH, 'utf8');

test('profit movement keeps only net revenue and total costs', () => {
  assert.match(appJs, /label:\s*'Net Revenue'[\s\S]*label:\s*'Total Costs'/);
  assert.match(appJs, /id:\s*'profitMovementValueLabelPlugin'/);
  assert.match(appJs, /if \(!dataset\.showValueLabels\) return;/);
  assert.doesNotMatch(
    appJs,
    /label:\s*'Net Profit'[\s\S]*type:\s*'line'/
  );
  assert.match(
    appJs,
    /interaction:\s*\{\s*[\r\n]\s*mode:\s*'index',\s*[\r\n]\s*intersect:\s*false/
  );
  assert.match(
    appJs,
    /tooltip:\s*\{[\s\S]*mode:\s*'index'[\s\S]*label:\s*function\(ctx\)\s*\{[\s\S]*formatSignedChartKrw\(ctx\.parsed\.y\)/
  );
  assert.match(appJs, /tooltip:\s*\{[\s\S]*backgroundColor:\s*'#111827'[\s\S]*bodyColor:\s*'#ffffff'/);
});

test('positive bar charts share the deep green profit palette', () => {
  assert.match(appJs, /darkGreenFill:\s*'rgba\(22, 101, 52, 0\.72\)'/);
  assert.match(appJs, /label:\s*'Revenue \(₩\)'[\s\S]*backgroundColor:\s*c\.darkGreenFill/);
  assert.match(appJs, /label:\s*'Net Revenue'[\s\S]*backgroundColor:\s*c\.darkGreenFill/);
  assert.match(appJs, /label:\s*'Orders'[\s\S]*backgroundColor:\s*c\.darkGreenFill/);
});

test('net profit chart uses complementary blue bars with dark profit labels', () => {
  assert.match(appJs, /netProfitBlueFill:\s*'rgba\(37, 99, 235, 0\.72\)'/);
  assert.match(appJs, /id:\s*'netProfitValueLabelPlugin'/);
  assert.match(appJs, /label:\s*'Net Margin'[\s\S]*const profit = Number\(ctx\.dataset\.netProfitValues\?\.\[ctx\.dataIndex\] \?\? ctx\.raw \?\? 0\);[\s\S]*c\.netProfitBlueFill/);
  assert.match(appJs, /ctx\.fillStyle\s*=\s*c\.netProfitLine\s*\|\|\s*'#111827'/);
});

test('net profit chart uses margin axis and KRW profit labels', () => {
  assert.match(appJs, /id:\s*'netProfitValueLabelPlugin'/);
  assert.match(appJs, /if \(!dataset\.showValueLabels\) return;/);
  assert.match(appJs, /const margin = Number\(margins\[index\]\);[\s\S]*if \(!Number\.isFinite\(margin\)\) return;/);
  assert.match(appJs, /const label = formatSignedChartKrw\(value\);/);
  assert.match(appJs, /label:\s*ctx => `Margin: \$\{formatChartPercentTick\(ctx\.parsed\.y\)\}`/);
  assert.match(appJs, /title:\s*\{\s*display:\s*true,\s*text:\s*'Margin \(%\)'/);
  assert.match(appJs, /x:\s*\{\s*grid:\s*\{\s*display:\s*false\s*\},\s*ticks:\s*\{\s*color:\s*c\.chartLabel,\s*minRotation:\s*45,\s*maxRotation:\s*45\s*\}/);
  assert.match(appJs, /ticks:\s*\{\s*color:\s*c\.chartLabel,\s*callback:\s*v => formatChartPercentTick\(v\) \}/);
  assert.match(appJs, /ctx\.fillStyle = c\.netProfitLine \|\| '#111827';/);
});

test('profit summary chart labels use the stronger chart label color', () => {
  assert.match(css, /--color-chart-label:\s*#71717a;/);
  assert.match(appJs, /const chartLabel = style\.getPropertyValue\('--color-chart-label'\)/);
  assert.match(appJs, /const profitSummaryCharts = new Set\(\[hourChartInstance, profitWaterfallChart, netProfitChartInstance, weekdayChartInstance\]\)/);
  assert.match(appJs, /if \(legendLabels && profitSummaryCharts\.has\(chart\)\) legendLabels\.color = c\.chartLabel;/);
  assert.match(appJs, /legend:\s*\{[\s\S]*labels:\s*\{[\s\S]*color:\s*c\.chartLabel[\s\S]*pointStyleWidth:\s*16/);
  assert.match(appJs, /x:\s*\{\s*grid:\s*\{\s*display:\s*false\s*\},\s*ticks:\s*\{\s*color:\s*c\.chartLabel,\s*font:\s*\{\s*size:\s*9\s*\},\s*maxRotation:\s*0\s*\}/);
});

test('compact section headers stay visually tied to the card below', () => {
  assert.match(
    css,
    /\.section-head-compact\s*\{[\s\S]*margin-top:\s*var\(--space-5\);[\s\S]*margin-bottom:\s*var\(--space-3\);/
  );
});

test('KRW display helpers render full whole amounts instead of K or M abbreviations', () => {
  const displaySources = [utilsJs, sharedJs, calendarJs, livePerformanceServiceJs].join('\n');

  assert.doesNotMatch(displaySources, /toFixed\([^)]*\)\s*\+\s*['"`][KMk]/);
  assert.doesNotMatch(displaySources, /Math\.round\([^)]*\/\s*1_?000\)[\s\S]{0,80}['"`][KMk]/);
  assert.doesNotMatch(displaySources, /\$\{[^}]*\/\s*1_?000_?000[^}]*\}[KMk]/);
  assert.doesNotMatch(displaySources, /\$\{[^}]*\/\s*1_?000[^}]*\}[KMk]/);
});
