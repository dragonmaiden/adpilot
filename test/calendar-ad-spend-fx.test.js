const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const contracts = require('../server/contracts/v1');

const CALENDAR_SERVICE_PATH = path.join(__dirname, '..', 'server', 'services', 'calendarService.js');
const API_JS_PATH = path.join(__dirname, '..', 'public', 'live', 'api.js');
const CALENDAR_JS_PATH = path.join(__dirname, '..', 'public', 'live', 'pages', 'calendar.js');
const STYLE_PATH = path.join(__dirname, '..', 'public', 'style.css');

const calendarServiceJs = fs.readFileSync(CALENDAR_SERVICE_PATH, 'utf8');
const apiJs = fs.readFileSync(API_JS_PATH, 'utf8');
const calendarJs = fs.readFileSync(CALENDAR_JS_PATH, 'utf8');
const css = fs.readFileSync(STYLE_PATH, 'utf8');

test('calendar contract exposes the canonical USD/KRW conversion context', () => {
  const fx = {
    base: 'USD',
    quote: 'KRW',
    source: 'frankfurter.app',
    usdToKrwRate: 1461,
    rateDate: '2026-07-24',
    fetchedAt: '2026-07-25T06:55:06.612Z',
    stale: false,
  };

  const payload = contracts.calendarAnalysis({ ready: true, fx });

  assert.deepEqual(payload.fx, fx);
});

test('calendar service carries the projection FX owner through both response states', () => {
  assert.match(calendarServiceJs, /ready:\s*true,\s*\n\s*fx:\s*projection\.fx,/);
  assert.match(calendarServiceJs, /ready:\s*false,\s*\n\s*fx:\s*data\.fx \|\| null,/);
});

test('calendar client validates the FX context before rendering financials', () => {
  assert.match(apiJs, /missing fx object/);
  assert.match(apiJs, /fx must describe USD\/KRW/);
  assert.match(apiJs, /fx\.usdToKrwRate must be a number or null/);
  assert.match(apiJs, /missing fx\.stale boolean/);
});

test('income statement pairs Meta USD spend with canonical KRW cost and the applied FX rate', () => {
  assert.match(calendarJs, /label:\s*tr\('Meta ad spend', 'Meta 광고비'\)/);
  assert.match(calendarJs, /meta:\s*tr\('Meta Ads · USD billing', 'Meta 광고 · USD 청구'\)/);
  assert.match(calendarJs, /sourceAmountLabel:\s*`\$\{formatUsd\(summary\.adSpend \|\| 0, 2\)\} USD`/);
  assert.match(calendarJs, /amount:\s*-summary\.adSpendKRW/);
  assert.match(calendarJs, /function formatUsdToKrwRate\(value\)/);
  assert.match(calendarJs, /minimumFractionDigits:\s*2/);
  assert.match(calendarJs, /`1 USD = \$\{formatUsdToKrwRate\(usdToKrwRate\)\}/);
  assert.match(calendarJs, /renderCalendarIncomeStatement\(selection, calendarState\.data\.fx\)/);
  assert.doesNotMatch(calendarJs, /summary\.adSpend\s*\*\s*usdToKrwRate/);
});

test('Meta currency amounts remain grouped without competing on one line', () => {
  assert.match(css, /\.income-statement-ad-spend-values\s*\{[\s\S]*align-items:\s*flex-end;/);
  assert.match(css, /\.income-statement-ad-spend-values \.income-statement-amount\s*\{[\s\S]*font-weight:\s*600;/);
  assert.match(css, /\.income-statement-source-amount\s*\{[\s\S]*font-variant-numeric:\s*tabular-nums;/);
  assert.match(css, /\.income-statement-ad-spend-values > small\s*\{[\s\S]*max-width:\s*100%;[\s\S]*overflow-wrap:\s*anywhere;/);
  assert.doesNotMatch(calendarJs, /income-statement-currency-pair/);
  assert.doesNotMatch(calendarJs, /aria-hidden="true">→/);
});
