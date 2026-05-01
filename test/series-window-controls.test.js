const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');
const INIT_JS_PATH = path.join(__dirname, '..', 'public', 'live', 'init.js');
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
});

test('profit summary renderer is driven by the calendar selected range', () => {
  assert.match(analyticsJs, /renderCalendarSelectionProfitSummary\(payload = \{\}\)/);
  assert.match(calendarJs, /rows: getCalendarWaterfallRows\(selection\)/);
  assert.match(calendarJs, /contextLabel: getCalendarWaterfallContextLabel\(\)/);
  assert.match(calendarJs, /sourceAudit: calendarState\.data\?\.sourceAudit \|\| null/);
  assert.match(calendarJs, /orderPatterns: calendarState\.data\?\.orderPatterns \|\| null/);
});

test('order pattern charts use the all-time calendar-analysis payload', () => {
  assert.match(analyticsJs, /function updatePatternCharts\(orderPatterns\)/);
  assert.match(analyticsJs, /normalizeOrderPatternWeekday\(orderPatterns\?\.weekday\)/);
  assert.match(analyticsJs, /normalizeOrderPatternHourly\(orderPatterns\?\.hourly\)/);
  assert.match(analyticsJs, /setOrderPatternRangeLabel\(formatOrderPatternRange\(orderPatterns\?\.range\)\)/);
  assert.match(analyticsJs, /updatePatternCharts\(payload\.orderPatterns \|\| \{\}\)/);
  assert.doesNotMatch(analyticsJs, /updatePatternCharts\(rows,\s*orders,\s*selectionSummary\)/);
  assert.doesNotMatch(analyticsJs, /buildHourlyOrders\(orders\)/);
});
