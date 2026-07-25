const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildRefundRateComparison,
} = require('../server/services/calendarService');
const contracts = require('../server/contracts/v1');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');
const CALENDAR_JS_PATH = path.join(__dirname, '..', 'public', 'live', 'pages', 'calendar.js');
const STYLE_CSS_PATH = path.join(__dirname, '..', 'public', 'style.css');

const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const calendarJs = fs.readFileSync(CALENDAR_JS_PATH, 'utf8');
const css = fs.readFileSync(STYLE_CSS_PATH, 'utf8');

function historicalPatterns(overrides = {}) {
  return {
    range: {
      start: '2026-02-01',
      end: '2026-07-25',
    },
    summary: {
      totalGrossRevenue: 2_000_000,
      totalRefunded: 100_000,
    },
    ...overrides,
  };
}

test('historical refund benchmark is gross-revenue weighted and compares percentage points', () => {
  const comparison = buildRefundRateComparison(historicalPatterns(), 8.5);

  assert.equal(comparison.basis, 'gross_revenue_weighted');
  assert.deepEqual(comparison.historical, {
    rate: 5,
    grossRevenue: 2_000_000,
    refundedAmount: 100_000,
    range: {
      start: '2026-02-01',
      end: '2026-07-25',
    },
  });
  assert.deepEqual(comparison.selected, {
    rate: 8.5,
    deltaPoints: 3.5,
    status: 'above_benchmark',
  });
});

test('selected refund rates at or below the historical benchmark stay within benchmark', () => {
  assert.equal(
    buildRefundRateComparison(historicalPatterns(), 4.9).selected.status,
    'within_benchmark'
  );
  assert.equal(
    buildRefundRateComparison(historicalPatterns(), 5).selected.status,
    'within_benchmark'
  );
});

test('refund comparison stays explicitly unavailable when gross revenue is zero', () => {
  const comparison = buildRefundRateComparison(historicalPatterns({
    summary: {
      totalGrossRevenue: 0,
      totalRefunded: 0,
    },
  }));

  assert.equal(comparison.historical.rate, null);
  assert.equal(comparison.selected.rate, null);
  assert.equal(comparison.selected.deltaPoints, null);
  assert.equal(comparison.selected.status, 'unavailable');
});

test('calendar contract preserves nullable refund rates instead of coercing them to zero', () => {
  const payload = contracts.calendarAnalysis({
    ready: true,
    refundComparison: buildRefundRateComparison(historicalPatterns({
      summary: {
        totalGrossRevenue: 0,
        totalRefunded: 0,
      },
    })),
  });

  assert.equal(payload.refundComparison.historical.rate, null);
  assert.equal(payload.refundComparison.selected.rate, null);
  assert.equal(payload.refundComparison.selected.deltaPoints, null);
});

test('summary contains one responsive refund-rate monitor driven by the calendar selection', () => {
  const monitorIndex = indexHtml.indexOf('id="refundRateMonitor"');
  const statementIndex = indexHtml.indexOf('id="calendarIncomeStatementDeck"');

  assert.ok(monitorIndex >= 0);
  assert.ok(monitorIndex < statementIndex);
  assert.match(calendarJs, /buildRefundMonitorViewModel\(refundComparison, selection\)/);
  assert.match(calendarJs, /calendarState\.data\.refundComparison/);
  assert.match(calendarJs, /renderCalendarRefundRateMonitor\(\);/);
  assert.match(calendarJs, /role="meter"/);
  assert.match(calendarJs, /Historical basis/);
  assert.match(calendarJs, /gross revenue/);
  assert.match(css, /\.refund-monitor-risk-zone\s*\{[\s\S]*linear-gradient/);
  assert.match(css, /@media \(max-width:\s*768px\)[\s\S]*\.refund-monitor-audit\s*\{[\s\S]*grid-template-columns:\s*1fr/);
});
