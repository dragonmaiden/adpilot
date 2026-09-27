const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CALENDAR_JS_PATH = path.join(__dirname, '..', 'public', 'live', 'pages', 'calendar.js');
const STYLE_CSS_PATH = path.join(__dirname, '..', 'public', 'style.css');

const calendarJs = fs.readFileSync(CALENDAR_JS_PATH, 'utf8');
const css = fs.readFileSync(STYLE_CSS_PATH, 'utf8');

test('coverage spread cannot clobber numeric cogs/shipping in the waterfall summary', () => {
  const summaryFn = calendarJs.slice(
    calendarJs.indexOf('function buildCalendarWaterfallSummary'),
    calendarJs.indexOf('function ensureCalendarStateInitialized')
  );
  const spreadIndex = summaryFn.indexOf('...coverage,');
  const cogsIndex = summaryFn.indexOf('cogs: netCogs,');
  const shippingIndex = summaryFn.indexOf('shipping: netShipping,');

  assert.ok(spreadIndex >= 0 && cogsIndex >= 0 && shippingIndex >= 0);
  // costReconciliation carries `cogs` / `shipping` objects; the numeric fields must win.
  assert.ok(spreadIndex < cogsIndex);
  assert.ok(spreadIndex < shippingIndex);
});

test('income statement uses ledger number conventions', () => {
  assert.match(calendarJs, /function formatLedgerAmount\(value, \{ currency = false \} = \{\}\)/);
  assert.match(calendarJs, /return rounded < 0 \? `\(\$\{digits\}\)` : digits;/);
  assert.match(calendarJs, /if \(rounded === 0\) return '—';/);
  assert.match(calendarJs, /function formatLedgerPercent\(label\)/);
  assert.match(calendarJs, /formatLedgerAmount\(summary\.trueNetProfit, \{ currency: true \}\)/);
  assert.match(calendarJs, /Parentheses denote deductions/);
});

test('income statement header reads as a printed statement', () => {
  assert.match(calendarJs, /class="income-statement-brand">AdPilot</);
  assert.match(calendarJs, /tr\('Statement of Income', '손익계산서'\)/);
  assert.match(calendarJs, /Expressed in Korean won/);
  assert.match(css, /\.income-statement-header\s*\{[\s\S]*?border-bottom:\s*2px solid var\(--statement-ink\);[\s\S]*?text-align:\s*center;/);
  assert.match(css, /\.income-statement-line\s*\{[\s\S]*?border-bottom:\s*1px dotted var\(--statement-leader\);/);
  assert.match(css, /\.income-statement-result-amount\s*\{[\s\S]*?border-bottom:\s*3px double var\(--statement-ink\);/);
  assert.match(css, /\[data-theme="light"\] \.income-statement-card\s*\{\s*--statement-paper:\s*#fdfcfa;/);
});
