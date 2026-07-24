const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');
const INIT_JS_PATH = path.join(__dirname, '..', 'public', 'live', 'init.js');
const SERIES_WINDOWS_PATH = path.join(__dirname, '..', 'public', 'live', 'series-windows.js');
const ANALYTICS_JS_PATH = path.join(__dirname, '..', 'public', 'live', 'pages', 'analytics.js');
const CALENDAR_JS_PATH = path.join(__dirname, '..', 'public', 'live', 'pages', 'calendar.js');

const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const initJs = fs.readFileSync(INIT_JS_PATH, 'utf8');
const analyticsJs = fs.readFileSync(ANALYTICS_JS_PATH, 'utf8');
const calendarJs = fs.readFileSync(CALENDAR_JS_PATH, 'utf8');

test('profit summary no longer exposes independent timeframe window controls', () => {
  assert.doesNotMatch(indexHtml, /data-series-window-group="profit-structure"/);
  assert.doesNotMatch(indexHtml, /data-series-window-group="order-patterns"/);
  assert.doesNotMatch(indexHtml, /data-series-window-value="(?:7d|14d|30d|all)"/);
  assert.doesNotMatch(initJs, /registerSeriesWindowRefresher\('profit-structure'/);
  assert.doesNotMatch(initJs, /registerSeriesWindowRefresher\('order-patterns'/);
  assert.equal(fs.existsSync(SERIES_WINDOWS_PATH), false);
  assert.doesNotMatch(indexHtml, /series-windows\.js/);
});

test('profit summary renderer is driven by the calendar selected range', () => {
  assert.match(analyticsJs, /renderCalendarSelectionProfitSummary\(payload = \{\}\)/);
  assert.match(calendarJs, /rows: Array\.isArray\(selection\.days\) \? selection\.days : \[\]/);
  assert.match(calendarJs, /contextLabel: getCalendarWaterfallContextLabel\(\)/);
  assert.match(calendarJs, /sourceAudit: calendarState\.data\?\.sourceAudit \|\| null/);
  assert.doesNotMatch(calendarJs, /orderPatterns:/);
});

test('profit summary cost card warns when selected COGS coverage is partial', () => {
  assert.match(analyticsJs, /function hasPartialCogsCoverage\(coverage\)/);
  assert.match(analyticsJs, /partialCogs\s*\?\s*'warning'/);
  assert.match(analyticsJs, /partialCogs\s*\?\s*'triangle-alert'/);
  assert.match(analyticsJs, /\$\{coverageLabel\} COGS · \$\{costsShareLabel\} costs/);
  assert.doesNotMatch(analyticsJs, /updateProfitInputCard\(\s*'trueNetProfit'/);
});

test('order pattern chart rendering has been removed', () => {
  assert.doesNotMatch(
    analyticsJs,
    /updatePatternCharts|normalizeOrderPatternWeekday|normalizeOrderPatternHourly/
  );
  assert.doesNotMatch(calendarJs, /orderPatterns:/);
});
