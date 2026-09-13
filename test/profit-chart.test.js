const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { buildFinancialProjection } = require('../server/services/financialProjectionService');
const { buildCumulativeProfitSeries: sumProfitDays, buildMonthlyProfitSeries, buildDailyProfitChart, buildProfitChartSvg } = require('../server/services/profitChartService');
const { buildSummaryFinancialDays, buildSelectionSummary } = require('../server/services/calendarService');
const fxService = require('../server/services/fxService');
const paywayService = require('../server/services/paywayFinancialService');
const fees = { ready: true, totals: { feesComplete: true }, daily: [] };
test.beforeEach(() => {
  test.mock.method(fxService, 'getUsdToKrwRatesForRange', async () => ({ ratesByDate: {} }));
  test.mock.method(paywayService, 'getPaywayFinancialSummary', async () => fees);
});
test.afterEach(() => test.mock.restoreAll());

function summaryDays(data) {
  const projection = buildFinancialProjection(data);
  return buildSummaryFinancialDays(projection, projection.dailyMerged.map(row => row.date), fees);
}
function buildCumulativeProfitSeries(data, date) {
  return sumProfitDays(data, date, summaryDays(data));
}

function fixture() {
  return {
    fx: { usdToKrwRate: 1500 },
    revenueData: { dailyRevenue: {
      '2026-01-01': { revenue: 1000, refunded: 0, orders: 1 },
      '2026-01-03': { revenue: 1000, refunded: 200, orders: 1 },
      '2026-01-04': { revenue: 0, refunded: 100, orders: 0 },
      '2026-01-05': { revenue: 999999, refunded: 0, orders: 1 },
    } },
    cogsData: { dailyCOGS: {
      '2026-01-01': { cost: 500, shipping: 50, costCoverageRatio: 1 },
      '2026-01-03': { cost: 300, shipping: 20, costCoverageRatio: 0.5 },
    } },
    campaignInsights: [{ date_start: '2026-01-04', spend: '1' }],
  };
}

test('cumulative chart sums canonical daily profits, fills quiet days and excludes future days', () => {
  const data = fixture();
  const rows = summaryDays(data).filter(row => row.date <= '2026-01-04');
  const points = buildCumulativeProfitSeries(data, '2026-01-04');
  assert.equal(points.length, 4);
  assert.equal(points[0].value, rows[0].trueNetProfit);
  assert.equal(points[1].value, points[0].value);
  assert.equal(points.at(-1).value, rows.reduce((sum, row) => sum + row.trueNetProfit, 0));
  assert.ok(points.at(-1).value < 0);
  assert.deepEqual(points.map(point => point.estimated), [false, false, true, true]);
  const svg = buildProfitChartSvg(points, '2026-01-04');
  assert.doesNotMatch(svg, /<path[^>]*stroke-dasharray|#d97706|Includes estimated costs|Complete COGS|Week starting|Monday/);
  assert.match(svg, /estimated/);
  assert.match(svg, /<path[^>]+stroke="#15803d"/);
});

test('unknown COGS prevents all later cumulative values from looking final', () => {
  const data = fixture();
  delete data.cogsData.dailyCOGS['2026-01-03'];
  const points = buildCumulativeProfitSeries(data, '2026-01-04');
  assert.equal(points[2].value, null);
  assert.equal(points[3].value, null);
  assert.equal(points[3].pending, true);
});

test('recovered costs recompute the entire cumulative series without estimates', () => {
  const data = fixture();
  data.cogsData.dailyCOGS['2026-01-03'].costCoverageRatio = 1;
  assert.ok(buildCumulativeProfitSeries(data, '2026-01-04').every(point => !point.estimated && !point.pending));
});

test('missing revenue for COGS activity cannot create a fake cumulative loss', () => {
  const data = fixture();
  delete data.revenueData.dailyRevenue['2026-01-01'];
  data.cogsData.dailyCOGS['2026-01-01'].purchases = 1;
  assert.equal(buildCumulativeProfitSeries(data, '2026-01-04').at(-1).value, null);
});

test('renders a deterministic PNG within Telegram photo dimensions without external calls', async () => {
  const data = fixture();
  const result = await buildDailyProfitChart(data, '2026-01-04');
  const metadata = await sharp(result.png).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 1100);
  assert.equal(metadata.height, 1040);
  assert.ok(result.png.length < 10 * 1024 * 1024);
  assert.equal(result.pending, true);
  assert.equal(result.fingerprint, (await buildDailyProfitChart(data, '2026-01-04')).fingerprint);
});

test('no history and stale revenue fail explicitly', async () => {
  await assert.rejects(buildDailyProfitChart({}, '2026-01-04'), /No recorded/);
  await assert.rejects(buildDailyProfitChart({ ...fixture(), sources: { imweb: { stale: true } } }, '2026-01-04'), /stale/);
});

test('stale or unavailable financial sources and mismatched audits cannot produce a trusted chart', async () => {
  for (const key of ['imweb', 'cogs', 'metaInsights']) {
    for (const source of [{ stale: true }, { status: 'error' }, { hasData: false }]) {
      await assert.rejects(buildDailyProfitChart({ ...fixture(), sources: { [key]: source } }, '2026-01-04'), /unavailable/);
    }
  }
  await assert.rejects(buildDailyProfitChart({ ...fixture(), sourceAudit: { reconciliation: { status: 'mismatch' } } }, '2026-01-04'), /do not reconcile/);
});

test('monthly bars reconcile to cumulative profit and only the report month is dotted', () => {
  const data = fixture();
  data.cogsData.dailyCOGS['2026-01-05'] = { cost: 500000, costCoverageRatio: 1 };
  data.revenueData.dailyRevenue['2026-03-01'] = { revenue: 1000, refunded: 0, orders: 1 };
  data.cogsData.dailyCOGS['2026-03-01'] = { cost: 2000, costCoverageRatio: 1 };
  data.revenueData.dailyRevenue['2026-03-02'] = { revenue: 999999, orders: 1 };
  const points = buildCumulativeProfitSeries(data, '2026-03-01');
  const months = buildMonthlyProfitSeries(points, '2026-03-01');
  assert.deepEqual(months.map(month => month.month), ['2026-01', '2026-02', '2026-03']);
  assert.equal(months[1].value, 0);
  assert.ok(months[2].value < 0);
  assert.equal(months.reduce((sum, month) => sum + month.value, 0), points.at(-1).value);
  assert.deepEqual(months.map(month => month.current), [false, false, true]);
  assert.equal(months[0].estimated, true);
  assert.equal(months[2].estimated, false);
  const svg = buildProfitChartSvg(points, '2026-03-01');
  assert.match(svg, /data-month="2026-03"[^>]+stroke="#dc2626"[^>]+stroke-dasharray/);
  assert.doesNotMatch(svg, /data-month="2026-0[12]"[^>]+stroke-dasharray/);
});

test('missing costs invalidate only their month, not later monthly profits', () => {
  const data = fixture();
  data.revenueData.dailyRevenue['2026-02-01'] = { revenue: 1000, refunded: 0, orders: 1 };
  data.cogsData.dailyCOGS['2026-02-01'] = { cost: 300, costCoverageRatio: 1 };
  const points = buildCumulativeProfitSeries(data, '2026-02-01');
  const months = buildMonthlyProfitSeries(points, '2026-02-01');
  assert.equal(points.at(-1).value, null);
  assert.equal(months[0].value, null);
  assert.ok(months[1].value > 0);
  assert.equal(months[1].pending, false);
});

test('Telegram PNG uses website Summary daily, monthly and cumulative profits with historical FX and actual fees', async () => {
  const data = fixture();
  delete data.revenueData.dailyRevenue['2026-01-05'];
  data.cogsData.dailyCOGS['2026-01-03'].costCoverageRatio = 1;
  data.revenueData.dailyRevenue['2026-02-01'] = { revenue: 1000, refunded: 0, orders: 1 };
  data.cogsData.dailyCOGS['2026-02-01'] = { cost: 100, shipping: 20, costCoverageRatio: 1 };
  const historicalFx = { ratesByDate: { '2026-01-04': { usdToKrwRate: 1234.56, rateDate: '2026-01-02' } } };
  const payway = { ready: true, totals: { feesComplete: true }, daily: [
    { date: '2026-01-01', processingFees: 17 },
    { date: '2026-01-02', processingFees: -3 }, // fee reversal on an otherwise quiet day
    { date: '2026-02-01', processingFees: 21 },
  ] };
  test.mock.method(fxService, 'getUsdToKrwRatesForRange', async (start, end) => {
    assert.equal(start, '2026-01-01');
    assert.equal(end, '2026-02-01');
    return historicalFx;
  });
  test.mock.method(paywayService, 'getPaywayFinancialSummary', async () => payway);
  const scheduler = require('../server/modules/scheduler');
  test.mock.method(scheduler, 'getLatestData', () => data);
  test.mock.method(scheduler, 'getScanHistory', () => []);
  test.mock.method(scheduler, 'getLastScanResult', () => null);
  test.mock.method(require('../server/services/reconciliationService'), 'getReconciliationResponse', async () => ({ ready: false }));
  const website = await require('../server/services/calendarService').getCalendarAnalysisResponse({
    visibleStart: '2026-01-01', visibleEnd: '2026-02-01',
    selectionStart: '2026-01-01', selectionEnd: '2026-02-01',
  });
  const days = website.selection.days;
  assert.equal(days[0].trueNetProfit, 433);
  assert.equal(days[1].trueNetProfit, 3);
  assert.equal(days[3].adSpendKRW, 1235);
  assert.equal(days.at(-1).trueNetProfit, 859);
  const points = sumProfitDays(data, '2026-02-01', days);
  assert.deepEqual(points.map(point => point.dailyValue), days.map(day => day.trueNetProfit));
  assert.equal(points.at(-1).value, website.selection.summary.trueNetProfit);
  for (const month of buildMonthlyProfitSeries(points, '2026-02-01')) {
    const summary = buildSelectionSummary(days.filter(day => day.date.startsWith(month.month)), [], {}, payway);
    assert.equal(month.value, summary.trueNetProfit);
  }
  const chart = await buildDailyProfitChart(data, '2026-02-01');
  const expectedPng = await sharp(Buffer.from(buildProfitChartSvg(points, '2026-02-01'))).png().toBuffer();
  assert.deepEqual(chart.png, expectedPng);
  assert.equal(chart.pending, false);
});

test('incomplete Payway fees remain unknown and stale fees or failed FX do not fall back to estimated profit', async () => {
  const data = fixture();
  const incomplete = { ready: true, totals: { feesComplete: false }, daily: [] };
  const projection = buildFinancialProjection(data);
  const days = buildSummaryFinancialDays(projection, ['2026-01-01'], incomplete);
  assert.equal(days[0].trueNetProfit, null);
  assert.equal(sumProfitDays(data, '2026-01-01', days)[0].value, null);
  test.mock.method(paywayService, 'getPaywayFinancialSummary', async () => incomplete);
  assert.equal((await buildDailyProfitChart(data, '2026-01-04')).pending, true);
  test.mock.method(paywayService, 'getPaywayFinancialSummary', async () => ({ ...fees, stale: true }));
  await assert.rejects(buildDailyProfitChart(data, '2026-01-04'), /Payway fees are stale/);
  test.mock.method(fxService, 'getUsdToKrwRatesForRange', async () => { throw new Error('FX unavailable'); });
  await assert.rejects(buildDailyProfitChart(data, '2026-01-04'), /FX unavailable/);
});
