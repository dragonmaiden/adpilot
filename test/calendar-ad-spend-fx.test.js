const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const contracts = require('../server/contracts/v1');
const { buildDailyUsdToKrwRates } = require('../server/services/fxService');
const { buildSelectionFxContext } = require('../server/services/calendarService');

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
    basis: 'daily',
    usdToKrwRate: 1461,
    rateDate: '2026-07-24',
    rangeStart: '2026-07-24',
    rangeEnd: '2026-07-24',
    fetchedAt: '2026-07-25T06:55:06.612Z',
    stale: false,
  };

  const payload = contracts.calendarAnalysis({ ready: true, fx });

  assert.deepEqual(payload.fx, fx);
});

test('calendar service uses date-specific FX for projections and selection context', () => {
  assert.match(calendarServiceJs, /fxService\.getUsdToKrwRatesForRange\(/);
  assert.match(calendarServiceJs, /usdToKrwRatesByDate:\s*historicalFx\?\.ratesByDate \|\| null/);
  assert.match(calendarServiceJs, /ready:\s*true,\s*\n\s*fx:\s*selectionFx,/);
  assert.match(calendarServiceJs, /ready:\s*false,\s*\n\s*fx:\s*data\.fx \|\| null,/);
});

test('historical FX fills weekends with the latest prior published market rate', () => {
  const history = buildDailyUsdToKrwRates(
    {
      base: 'USD',
      rates: {
        '2026-07-03': { KRW: 1531.23 },
        '2026-07-06': { KRW: 1531.07 },
      },
    },
    '2026-07-04',
    '2026-07-07',
    '2026-07-07T12:00:00.000Z'
  );

  assert.deepEqual(history.ratesByDate['2026-07-04'], {
    usdToKrwRate: 1531.23,
    rateDate: '2026-07-03',
  });
  assert.deepEqual(history.ratesByDate['2026-07-05'], {
    usdToKrwRate: 1531.23,
    rateDate: '2026-07-03',
  });
  assert.deepEqual(history.ratesByDate['2026-07-06'], {
    usdToKrwRate: 1531.07,
    rateDate: '2026-07-06',
  });
  assert.deepEqual(history.ratesByDate['2026-07-07'], {
    usdToKrwRate: 1531.07,
    rateDate: '2026-07-06',
  });
});

test('single-day calendar FX reflects that date and its published market date', () => {
  const selectionDays = [{
      date: '2026-07-04',
      adSpend: 10,
      adSpendKRW: 15_312,
      usdToKrwRate: 1531.23,
      fxRateDate: '2026-07-03',
    }];
  const context = buildSelectionFxContext({
    selectionDays,
    selectionSummary: {
      adSpend: 10,
      adSpendKRW: 15_312,
    },
    historicalFx: {
      source: 'frankfurter.app',
      fetchedAt: '2026-07-07T12:00:00.000Z',
      stale: false,
      ratesByDate: {
        '2026-07-04': {
          usdToKrwRate: 1531.23,
          rateDate: '2026-07-03',
        },
      },
    },
    fallbackFx: null,
    startDate: '2026-07-04',
    endDate: '2026-07-04',
  });

  assert.equal(context.basis, 'daily');
  assert.equal(context.usdToKrwRate, 1531.23);
  assert.equal(context.rateDate, '2026-07-03');
  assert.equal(context.rangeStart, '2026-07-04');
  assert.equal(context.rangeEnd, '2026-07-04');
  assert.equal(context.stale, false);
});

test('calendar range exposes the effective spend-weighted FX that reconciles USD and KRW spend', () => {
  const days = [
    {
      date: '2026-07-01',
      adSpend: 10,
      adSpendKRW: 14_000,
      usdToKrwRate: 1400,
      fxRateDate: '2026-07-01',
    },
    {
      date: '2026-07-02',
      adSpend: 30,
      adSpendKRW: 45_000,
      usdToKrwRate: 1500,
      fxRateDate: '2026-07-02',
    },
  ];
  const context = buildSelectionFxContext({
    selectionDays: days,
    selectionSummary: {
      adSpend: 40,
      adSpendKRW: 59_000,
    },
    historicalFx: {
      source: 'frankfurter.app',
      fetchedAt: '2026-07-03T12:00:00.000Z',
      stale: false,
      ratesByDate: Object.fromEntries(days.map(day => [day.date, {
        usdToKrwRate: day.usdToKrwRate,
        rateDate: day.fxRateDate,
      }])),
    },
    fallbackFx: null,
    startDate: '2026-07-01',
    endDate: '2026-07-02',
  });

  assert.equal(context.basis, 'spend_weighted_average');
  assert.equal(context.usdToKrwRate, 1475);
  assert.equal(context.rateDate, null);
  assert.equal(40 * context.usdToKrwRate, 59_000);
  assert.equal(context.stale, false);
});

test('calendar client validates the FX context before rendering financials', () => {
  assert.match(apiJs, /missing fx object/);
  assert.match(apiJs, /fx must describe USD\/KRW/);
  assert.match(apiJs, /fx\.usdToKrwRate must be a number or null/);
  assert.match(apiJs, /unexpected fx\.basis/);
  assert.match(apiJs, /fx selection range must be present/);
  assert.match(apiJs, /missing fx\.stale boolean/);
});

test('income statement pairs Meta USD spend with canonical KRW cost and the applied FX rate', () => {
  assert.match(calendarJs, /label:\s*tr\('Meta ad spend', 'Meta 광고비'\)/);
  assert.match(calendarJs, /meta:\s*tr\('Meta Ads · USD billing', 'Meta 광고 · USD 청구'\)/);
  assert.match(calendarJs, /sourceAmountLabel:\s*`\$\{formatUsd\(summary\.adSpend \|\| 0, 2\)\} USD`/);
  assert.match(calendarJs, /amount:\s*-summary\.adSpendKRW/);
  assert.match(calendarJs, /function formatUsdToKrwRate\(value\)/);
  assert.match(calendarJs, /minimumFractionDigits:\s*2/);
  assert.match(calendarJs, /fx\.basis === 'spend_weighted_average'/);
  assert.match(calendarJs, /spend-weighted average FX/);
  assert.match(calendarJs, /daily FX/);
  assert.match(calendarJs, /`1 USD = \$\{formatUsdToKrwRate\(usdToKrwRate\)\} · \$\{contextLabel\}`/);
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
