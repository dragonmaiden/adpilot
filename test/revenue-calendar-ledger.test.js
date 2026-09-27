const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const calendarJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'live', 'pages', 'calendar.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

test('calendar day cells use ledger conventions for profit and refunds', () => {
  assert.match(calendarJs, /function formatCalendarLedgerProfit\(value\)/);
  assert.match(calendarJs, /if \(rounded < 0\) return `\(\$\{digits\}\)`;/);
  assert.match(calendarJs, /return rounded > 0 \? `\+\$\{digits\}` : digits;/);
  assert.match(calendarJs, /const CALENDAR_MAX_REFUND_MARKS = 5;/);
  assert.match(calendarJs, /refundCount > CALENDAR_MAX_REFUND_MARKS \? `×\$\{formatCount\(refundCount\)\}` : '×'\.repeat\(refundCount\)/);
  assert.match(css, /\.calendar-day-refunds\s*\{[\s\S]*?white-space:\s*nowrap;/);
  assert.match(calendarJs, /class="calendar-day-refunds \$\{refundCount > CALENDAR_MAX_REFUND_MARKS \? 'is-count' : ''\}" title=/);
  assert.match(calendarJs, /Math\.min\(1, netProfit \/ maxPositiveProfit\)/);
});

test('calendar month sheet has ledger header totals, padded grid, and footnote', () => {
  assert.match(calendarJs, /const trailingSpaces = \(7 - \(\(leadingSpaces \+ days\.length\) % 7\)\) % 7;/);
  assert.match(calendarJs, /class="calendar-month-totals"/);
  assert.doesNotMatch(calendarJs, /calendar-month-note/);
  assert.match(calendarJs, /Each red × is one refunded order/);
  assert.match(calendarJs, /Parentheses denote a loss/);
  assert.match(css, /\.calendar-month-header\s*\{[\s\S]*?border-bottom:\s*2px solid var\(--calendar-ink\);/);
  assert.match(css, /\.calendar-grid\s*\{\s*border-left:\s*1px solid var\(--calendar-hairline\);/);
  assert.match(css, /\.calendar-spacer\s*\{[\s\S]*?visibility:\s*hidden;/);
  assert.match(css, /\[data-theme="light"\] \.calendar-day\.profit-positive\s*\{[\s\S]*?oklch\(/);
  assert.match(css, /\.calendar-day\.is-today,\s*\.calendar-day\.is-today:hover\s*\{\s*box-shadow:\s*inset 0 0 0 2px var\(--calendar-ink\);/);
});
