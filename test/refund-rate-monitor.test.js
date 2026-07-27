const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildRefundDeductionMetrics,
  buildRefundWindowSummary,
  buildHistoricalMonthlyRefundAverage,
  buildRefundRateComparison,
} = require('../server/services/calendarService');
const contracts = require('../server/contracts/v1');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');
const CALENDAR_JS_PATH = path.join(__dirname, '..', 'public', 'live', 'pages', 'calendar.js');
const STYLE_CSS_PATH = path.join(__dirname, '..', 'public', 'style.css');

const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const calendarJs = fs.readFileSync(CALENDAR_JS_PATH, 'utf8');
const css = fs.readFileSync(STYLE_CSS_PATH, 'utf8');

function historicalAverage(overrides = {}) {
  return {
    orderRate: 14.7,
    revenueRate: 13.3,
    monthCount: 3,
    orderRateMonthCount: 3,
    revenueRateMonthCount: 3,
    range: {
      start: '2026-01-01',
      end: '2026-03-31',
    },
    ...overrides,
  };
}

function monthToDateSummary(overrides = {}) {
  return {
    orderRate: 15,
    revenueRate: 15,
    grossRevenue: 400_000,
    refundedAmount: 60_000,
    recognizedOrders: 120,
    refundOrders: 18,
    range: { start: '2026-04-01', end: '2026-04-25' },
    ...overrides,
  };
}

function ordersForMonth(month, refundCount, totalCount, refundedAmount) {
  const baseRefund = refundCount > 0 ? Math.floor(refundedAmount / refundCount) : 0;
  const refundRemainder = refundCount > 0 ? refundedAmount % refundCount : 0;

  return Array.from({ length: totalCount }, (_, index) => ({
    wtime: `${month}-${String((index % 20) + 1).padStart(2, '0')}T01:00:00.000Z`,
    totalPaymentPrice: index < refundCount
      ? 1_000 - baseRefund - (index < refundRemainder ? 1 : 0)
      : 1_000,
    totalRefundedPrice: index < refundCount
      ? baseRefund + (index < refundRemainder ? 1 : 0)
      : 0,
    sections: [{
      orderSectionStatus: index < refundCount ? 'RETURN_COMPLETE' : 'PURCHASE_CONFIRMATION',
    }],
  }));
}

test('refund deductions classify returns and cancellations without changing the refunded total', () => {
  const metrics = buildRefundDeductionMetrics([
    {
      totalPaymentPrice: 80_000,
      totalRefundedPrice: 20_000,
      sections: [{ orderSectionStatus: 'RETURN_COMPLETE' }],
    },
    {
      totalPaymentPrice: 0,
      totalRefundedPrice: 40_000,
      sections: [{
        orderSectionStatus: 'CANCEL_COMPLETE',
        cancelInfo: { refundAmount: 40_000 },
      }],
    },
    {
      totalPaymentPrice: 100_000,
      totalRefundedPrice: 50_000,
      sections: [
        {
          orderSectionStatus: 'CANCEL_COMPLETE',
          cancelInfo: { refundAmount: 30_000 },
        },
        { orderSectionStatus: 'RETURN_COMPLETE' },
      ],
    },
  ]);

  assert.equal(metrics.totalRefundedAmount, 110_000);
  assert.equal(metrics.returnRefundedAmount, 40_000);
  assert.equal(metrics.cancellationRefundedAmount, 70_000);
  assert.equal(metrics.unclassifiedRefundedAmount, 0);
  assert.equal(
    metrics.returnRefundedAmount
      + metrics.cancellationRefundedAmount
      + metrics.unclassifiedRefundedAmount,
    metrics.totalRefundedAmount
  );
  assert.equal(metrics.returnRefundOrders, 2);
  assert.equal(metrics.cancellationOrders, 2);
});

test('refund deductions keep unknown Imweb statuses visible instead of mislabelling them', () => {
  const metrics = buildRefundDeductionMetrics([
    {
      totalPaymentPrice: 75_000,
      totalRefundedPrice: 25_000,
      sections: [{ orderSectionStatus: 'EXCHANGE_COMPLETE' }],
    },
  ]);

  assert.equal(metrics.returnRefundedAmount, 0);
  assert.equal(metrics.cancellationRefundedAmount, 0);
  assert.equal(metrics.unclassifiedRefundedAmount, 25_000);
});

test('completed historical months use arithmetic averages for order and revenue refund rates', () => {
  const average = buildHistoricalMonthlyRefundAverage({
    orders: [
      ...ordersForMonth('2026-01', 14, 100, 12_000),
      ...ordersForMonth('2026-02', 18, 120, 18_000),
      ...ordersForMonth('2026-03', 12, 80, 10_400),
    ],
    start: '2026-01-01',
    end: '2026-03-31',
  });

  assert.deepEqual(average, {
    orderRate: 14.7,
    revenueRate: 13.3,
    monthCount: 3,
    orderRateMonthCount: 3,
    revenueRateMonthCount: 3,
    range: {
      start: '2026-01-01',
      end: '2026-03-31',
    },
  });
});

test('historical monthly average compares with the current month to date', () => {
  const comparison = buildRefundRateComparison(
    historicalAverage(),
    monthToDateSummary()
  );

  assert.equal(comparison.basis, 'completed_months_arithmetic_mean');
  assert.equal(comparison.scope, 'post_delivery_returns_excluding_cancellations');
  assert.deepEqual(comparison.historical, {
    orderRate: 14.7,
    revenueRate: 13.3,
    monthCount: 3,
    orderRateMonthCount: 3,
    revenueRateMonthCount: 3,
    range: {
      start: '2026-01-01',
      end: '2026-03-31',
    },
  });
  assert.deepEqual(comparison.monthToDate, {
    orderRate: 15,
    revenueRate: 15,
    grossRevenue: 400_000,
    refundedAmount: 60_000,
    recognizedOrders: 120,
    refundOrders: 18,
    range: {
      start: '2026-04-01',
      end: '2026-04-25',
    },
    orderDeltaPoints: 0.3,
    revenueDeltaPoints: 1.7,
    status: 'above_benchmark',
  });
});

test('month-to-date refund rates at or below history stay within benchmark', () => {
  assert.equal(
    buildRefundRateComparison(
      historicalAverage(),
      monthToDateSummary({ orderRate: 14.6, revenueRate: 13.2 })
    ).monthToDate.status,
    'within_benchmark'
  );
  assert.equal(
    buildRefundRateComparison(
      historicalAverage(),
      monthToDateSummary({ orderRate: 14.7, revenueRate: 13.3 })
    ).monthToDate.status,
    'within_benchmark'
  );
});

test('refund window counts post-delivery returns and excludes free cancellations', () => {
  const summary = buildRefundWindowSummary({
    orders: [
      {
        wtime: '2026-07-01T01:00:00.000Z',
        totalPaymentPrice: 90_000,
        totalRefundedPrice: 10_000,
        sections: [{ orderSectionStatus: 'RETURN_COMPLETE' }],
      },
      {
        wtime: '2026-07-02T01:00:00.000Z',
        totalPaymentPrice: 280_000,
        totalRefundedPrice: 20_000,
        sections: [{ orderSectionStatus: 'RETURN_DONE' }],
      },
      {
        wtime: '2026-07-03T01:00:00.000Z',
        totalPaymentPrice: 50_000,
        totalRefundedPrice: 0,
        sections: [{ orderSectionStatus: 'PURCHASE_CONFIRMATION' }],
      },
      {
        wtime: '2026-07-04T01:00:00.000Z',
        totalPaymentPrice: 8_000,
        totalRefundedPrice: 40_000,
        sections: [{
          orderSectionStatus: 'CANCEL_COMPLETE',
          cancelInfo: { refundAmount: 40_000 },
        }],
      },
      {
        wtime: '2026-08-01T01:00:00.000Z',
        totalPaymentPrice: 0,
        totalRefundedPrice: 900_000,
        sections: [{ orderSectionStatus: 'RETURN_COMPLETE' }],
      },
    ],
    start: '2026-07-01',
    end: '2026-07-31',
  });

  assert.equal(summary.grossRevenue, 450_000);
  assert.equal(summary.refundedAmount, 30_000);
  assert.equal(summary.revenueRate, 6.7);
  assert.equal(summary.orderRate, 66.7);
  assert.equal(summary.recognizedOrders, 3);
  assert.equal(summary.refundOrders, 2);
});

test('mixed orders subtract cancellation refunds before measuring return refunds', () => {
  const summary = buildRefundWindowSummary({
    orders: [
      {
        wtime: '2026-07-01T01:00:00.000Z',
        totalPaymentPrice: 97_708,
        totalRefundedPrice: 192_184,
        sections: [
          {
            orderSectionStatus: 'CANCEL_COMPLETE',
            cancelInfo: { refundAmount: 192_184 },
          },
          { orderSectionStatus: 'RETURN_REQUEST' },
        ],
      },
      {
        wtime: '2026-07-02T01:00:00.000Z',
        totalPaymentPrice: 8_000,
        totalRefundedPrice: 96_167,
        sections: [{ orderSectionStatus: 'RETURN_COMPLETE' }],
      },
    ],
    start: '2026-07-01',
    end: '2026-07-31',
  });

  assert.equal(summary.grossRevenue, 201_875);
  assert.equal(summary.refundedAmount, 96_167);
  assert.equal(summary.recognizedOrders, 2);
  assert.equal(summary.refundOrders, 1);
  assert.equal(summary.orderRate, 50);
  assert.equal(summary.revenueRate, 47.6);
});

test('refund comparison stays explicitly unavailable when both denominators are zero', () => {
  const comparison = buildRefundRateComparison(
    historicalAverage({
      orderRate: null,
      revenueRate: null,
      orderRateMonthCount: 0,
      revenueRateMonthCount: 0,
    }),
    monthToDateSummary({
      orderRate: null,
      revenueRate: null,
      grossRevenue: 0,
      refundedAmount: 0,
      recognizedOrders: 0,
      refundOrders: 0,
    })
  );

  assert.equal(comparison.historical.orderRate, null);
  assert.equal(comparison.historical.revenueRate, null);
  assert.equal(comparison.monthToDate.orderRate, null);
  assert.equal(comparison.monthToDate.revenueRate, null);
  assert.equal(comparison.monthToDate.orderDeltaPoints, null);
  assert.equal(comparison.monthToDate.revenueDeltaPoints, null);
  assert.equal(comparison.monthToDate.status, 'unavailable');
});

test('calendar contract preserves nullable refund rates instead of coercing them to zero', () => {
  const payload = contracts.calendarAnalysis({
    ready: true,
    refundComparison: buildRefundRateComparison(
      historicalAverage({
        orderRate: null,
        revenueRate: null,
        monthCount: 0,
        orderRateMonthCount: 0,
        revenueRateMonthCount: 0,
      }),
      monthToDateSummary({
        orderRate: null,
        revenueRate: null,
        grossRevenue: 0,
        refundedAmount: 0,
        recognizedOrders: 0,
        refundOrders: 0,
      })
    ),
  });

  assert.equal(payload.refundComparison.historical.orderRate, null);
  assert.equal(payload.refundComparison.historical.revenueRate, null);
  assert.equal(
    payload.refundComparison.scope,
    'post_delivery_returns_excluding_cancellations'
  );
  assert.equal(payload.refundComparison.monthToDate.orderRate, null);
  assert.equal(payload.refundComparison.monthToDate.revenueRate, null);
  assert.equal(payload.refundComparison.monthToDate.orderDeltaPoints, null);
  assert.equal(payload.refundComparison.monthToDate.revenueDeltaPoints, null);
});

test('summary shows historical and month-to-date return refund rates', () => {
  const monitorIndex = indexHtml.indexOf('id="refundRateMonitor"');
  const statementIndex = indexHtml.indexOf('id="calendarIncomeStatementDeck"');
  const patternsIndex = indexHtml.indexOf('id="calendarOrderPatterns"');

  assert.ok(monitorIndex >= 0);
  assert.ok(statementIndex < monitorIndex);
  assert.ok(monitorIndex < patternsIndex);
  assert.match(calendarJs, /buildRefundMonitorViewModel\(refundComparison\)/);
  assert.match(calendarJs, /calendarState\.data\.refundComparison/);
  assert.match(calendarJs, /renderCalendarRefundRateMonitor\(\);/);
  assert.match(calendarJs, /Historical monthly average/);
  assert.match(calendarJs, /Month to date/);
  assert.match(calendarJs, /Post-delivery return rates · cancellations excluded/);
  assert.match(calendarJs, /order return rate/);
  assert.match(calendarJs, /revenue return rate/);
  assert.doesNotMatch(calendarJs, /refund orders \/ month/);
  assert.doesNotMatch(calendarJs, /role="meter"/);
  assert.doesNotMatch(calendarJs, /refund-monitor-(meter|track|axis|audit|benchmark)/);
  assert.doesNotMatch(calendarJs, /\bpp\b|%p/);
  assert.match(calendarJs, /relativeDifference/);
  assert.match(calendarJs, /% below average/);
  assert.match(calendarJs, /% above average/);
  assert.match(calendarJs, /refund-monitor-metrics/);
  assert.equal((calendarJs.match(/class="refund-monitor-metric(?:\s|")/g) || []).length, 4);
  assert.doesNotMatch(calendarJs, /refund-monitor-(order-total|rate)/);
  assert.match(
    css,
    /\.refund-monitor-metric strong\s*\{[\s\S]*font-size:\s*clamp\(1\.85rem,\s*3\.25vw,\s*2\.65rem\)/
  );
  assert.match(
    css,
    /\.refund-monitor-header\s*\{[\s\S]*max-width:\s*920px[\s\S]*margin-inline:\s*auto/
  );
  assert.match(
    css,
    /\.refund-monitor-comparison\s*\{[\s\S]*max-width:\s*920px[\s\S]*margin-inline:\s*auto/
  );
  assert.match(css, /\.refund-monitor-comparison\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width:\s*768px\)[\s\S]*\.refund-monitor-comparison\s*\{[\s\S]*grid-template-columns:\s*1fr/);
});

test('calendar defaults to month to date while keeping the shared selection path', () => {
  const calendarServiceJs = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'services', 'calendarService.js'),
    'utf8'
  );

  assert.match(calendarJs, /calendarState\.selectionStart = getCalendarMonthStart\(today\);/);
  assert.match(calendarJs, /calendarState\.selectionEnd = today;/);
  assert.match(calendarServiceJs, /selectionStart:\s*currentMonthStart,\s*\n\s*selectionEnd:\s*today,/);
  assert.match(indexHtml, /id="calendarMonthToDateBtn"[\s\S]*data-i18n="calendar\.monthToDate"/);
});
