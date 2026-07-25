const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const transforms = require('../server/transforms/charts');
const { buildAllTimeOrderPatterns } = require('../server/services/calendarService');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');
const CALENDAR_JS_PATH = path.join(__dirname, '..', 'public', 'live', 'pages', 'calendar.js');
const STYLE_CSS_PATH = path.join(__dirname, '..', 'public', 'style.css');
const IMWEB_CLIENT_PATH = path.join(__dirname, '..', 'server', 'modules', 'imwebClient.js');
const CALENDAR_SERVICE_PATH = path.join(__dirname, '..', 'server', 'services', 'calendarService.js');
const PROJECTION_SERVICE_PATH = path.join(__dirname, '..', 'server', 'services', 'financialProjectionService.js');

const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const calendarJs = fs.readFileSync(CALENDAR_JS_PATH, 'utf8');
const css = fs.readFileSync(STYLE_CSS_PATH, 'utf8');
const imwebClientJs = fs.readFileSync(IMWEB_CLIENT_PATH, 'utf8');
const calendarServiceJs = fs.readFileSync(CALENDAR_SERVICE_PATH, 'utf8');
const projectionServiceJs = fs.readFileSync(PROJECTION_SERVICE_PATH, 'utf8');

test('buildHourlyOrders carries per-hour revenue alongside order counts', () => {
  const rows = transforms.buildHourlyOrders([2, 0, 5], [30_000, 0, 125_000]);

  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { hour: 0, orders: 2, revenue: 30_000 });
  assert.deepEqual(rows[2], { hour: 2, orders: 5, revenue: 125_000 });
});

test('buildHourlyOrders zero-fills 24 buckets and tolerates missing revenue', () => {
  const empty = transforms.buildHourlyOrders([]);
  assert.equal(empty.length, 24);
  assert.deepEqual(empty[23], { hour: 23, orders: 0, revenue: 0 });

  const withoutRevenue = transforms.buildHourlyOrders([1, 2]);
  assert.deepEqual(withoutRevenue[1], { hour: 1, orders: 2, revenue: 0 });

  const malformedRevenue = transforms.buildHourlyOrders([1], ['not-a-number']);
  assert.deepEqual(malformedRevenue[0], { hour: 0, orders: 1, revenue: 0 });
});

test('order sync accumulates recognized revenue per KST hour', () => {
  assert.match(imwebClientJs, /const hourlyRevenue = new Array\(24\)\.fill\(0\);/);
  assert.match(imwebClientJs, /hourlyOrders\[hour\]\+\+;\s*\n\s*hourlyRevenue\[hour\] \+= approvedAmount;/);
  assert.match(imwebClientJs, /hourlyOrders,\s*\n\s*hourlyRevenue,/);
});

test('projection and calendar service carry hourly revenue through to order patterns', () => {
  assert.match(projectionServiceJs, /buildHourlyOrders\(revenue\.hourlyOrders, revenue\.hourlyRevenue\)/);
  assert.match(calendarServiceJs, /\{ hour, orders: 0, revenue: 0 \}/);
  assert.match(calendarServiceJs, /buckets\[hour\]\.revenue = toFiniteNumber\(row\?\.revenue\);/);
});

test('order patterns range ignores Meta-spend-only days without orders', () => {
  const patterns = buildAllTimeOrderPatterns({
    dailyMerged: [
      { date: '2026-02-03', revenue: 0, refunded: 0, orders: 0 },
      { date: '2026-03-10', revenue: 150_000, refunded: 0, orders: 2 },
      { date: '2026-03-15', revenue: 90_000, refunded: 10_000, orders: 1 },
      { date: '2026-07-24', revenue: 0, refunded: 0, orders: 0 },
    ],
    hourlyOrders: [],
  });

  assert.equal(patterns.range.start, '2026-03-10');
  assert.equal(patterns.range.end, '2026-03-15');
  assert.equal(patterns.summary.totalOrders, 3);
  assert.equal(patterns.summary.totalGrossRevenue, 240_000);
  assert.equal(patterns.summary.totalRefunded, 10_000);
});

test('order patterns aggregates weekday buckets by KST calendar day', () => {
  // 2026-03-10 is a Tuesday, 2026-03-15 is a Sunday.
  const patterns = buildAllTimeOrderPatterns({
    dailyMerged: [
      { date: '2026-03-10', revenue: 150_000, refunded: 0, orders: 2 },
      { date: '2026-03-15', revenue: 90_000, refunded: 10_000, orders: 1 },
    ],
    hourlyOrders: [{ hour: 21, orders: 3, revenue: 240_000 }],
  });

  const tuesday = patterns.weekday.find(row => row.dayIndex === 2);
  const sunday = patterns.weekday.find(row => row.dayIndex === 0);

  assert.equal(tuesday.orders, 2);
  assert.equal(tuesday.revenue, 150_000);
  assert.equal(sunday.orders, 1);
  assert.equal(sunday.net, 80_000);
  assert.equal(patterns.hourly[21].orders, 3);
  assert.equal(patterns.hourly[21].revenue, 240_000);
});

test('order patterns discloses gross-revenue basis in the footnote', () => {
  assert.match(calendarJs, /Gross revenue before refunds and fees/);
});

test('order patterns section renders below the income statement deck', () => {
  const deckIndex = indexHtml.indexOf('id="calendarIncomeStatementDeck"');
  const patternsIndex = indexHtml.indexOf('id="calendarOrderPatterns"');

  assert.ok(deckIndex >= 0);
  assert.ok(patternsIndex > deckIndex);
});

test('calendar page renders weekday and hourly order patterns from the API payload', () => {
  assert.match(calendarJs, /function buildOrderPatternsViewModel\(patterns\)/);
  assert.match(calendarJs, /function renderCalendarOrderPatternsSection\(\)/);
  assert.match(calendarJs, /renderCalendarOrderPatternsSection\(\);/);
  // Server dayIndex is getUTCDay() (0 = Sunday); UI must display Monday-first.
  assert.match(calendarJs, /\[1, 2, 3, 4, 5, 6, 0\]\.map/);
  assert.match(calendarJs, /buildOrderPatternsViewModel\(data\.orderPatterns\)/);
});

test('order patterns surfaces honest sample-size context', () => {
  assert.match(calendarJs, /Based on \$\{formatCount\(totalOrders\)\} recognized orders/);
  assert.match(calendarJs, /Early data — patterns may shift/);
  assert.match(calendarJs, /totalOrders === 0 \? `/);
});

test('order patterns layout is responsive without horizontal scrolling', () => {
  assert.match(css, /\.order-patterns-body\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\);/);
  assert.match(css, /@media \(max-width:\s*768px\)[\s\S]*\.order-patterns-body\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(css, /\.calendar-order-patterns:empty\s*\{\s*display:\s*none;/);
});
