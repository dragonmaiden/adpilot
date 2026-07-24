const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildProductCategoryRevenue,
  classifyProductCategory,
} = require('../server/domain/productCategories');

const CONTRACTS_PATH = path.join(__dirname, '..', 'server', 'contracts', 'v1.js');
const CALENDAR_SERVICE_PATH = path.join(__dirname, '..', 'server', 'services', 'calendarService.js');
const CALENDAR_JS_PATH = path.join(__dirname, '..', 'public', 'live', 'pages', 'calendar.js');
const STYLE_PATH = path.join(__dirname, '..', 'public', 'style.css');
const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');

const contractsJs = fs.readFileSync(CONTRACTS_PATH, 'utf8');
const calendarServiceJs = fs.readFileSync(CALENDAR_SERVICE_PATH, 'utf8');
const calendarJs = fs.readFileSync(CALENDAR_JS_PATH, 'utf8');
const css = fs.readFileSync(STYLE_PATH, 'utf8');
const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

function makeOrder(orderNo, totalPaymentPrice, totalRefundedPrice, items) {
  return {
    orderNo,
    totalPaymentPrice,
    totalRefundedPrice,
    sections: [
      {
        sectionItems: items.map(item => ({
          qty: item.qty || 1,
          productInfo: {
            prodName: item.name,
            itemPrice: item.price,
          },
        })),
      },
    ],
  };
}

test('product category revenue allocates actual gross order revenue, not list-price totals', () => {
  const orders = [
    makeOrder('A001', 90_000, 10_000, [
      { name: 'Imported leather hobo bag', price: 60_000 },
      { name: 'Mary Jane shoes', price: 40_000 },
    ]),
    makeOrder('A002', 50_000, 0, [
      { name: 'Silk scarf twilly', price: 50_000 },
    ]),
    makeOrder('A003', 20_000, 0, [
      { name: 'Gold necklace pendant', price: 20_000 },
    ]),
  ];

  const rows = buildProductCategoryRevenue(orders, { limit: 8 });
  const total = rows.reduce((sum, row) => sum + row.revenue, 0);
  const byLabel = Object.fromEntries(rows.map(row => [row.label, row]));

  assert.equal(total, 170_000);
  assert.equal(byLabel.Bags.revenue, 60_000);
  assert.equal(byLabel.Shoes.revenue, 40_000);
  assert.equal(byLabel.Scarves.revenue, 50_000);
  assert.equal(byLabel.Jewelry.revenue, 20_000);
  assert.equal(byLabel.Bags.share, 0.3529);
});

test('product classifier recognizes Shue category language', () => {
  assert.equal(classifyProductCategory('최대 60만원 SHUE LUCKY BOX').label, 'Lucky Box');
  assert.equal(classifyProductCategory('Imported shoulder bag').label, 'Bags');
  assert.equal(classifyProductCategory('네버풀 MM M46975').label, 'Bags');
  assert.equal(classifyProductCategory('메리제인 슈즈').label, 'Shoes');
  assert.equal(classifyProductCategory('알함브라 네크리스').label, 'Jewelry');
  assert.equal(classifyProductCategory('cashmere cardigan knit').label, 'Apparel');
  assert.equal(classifyProductCategory('슈에기획 GRP 포켓 루닉 롱슬리브 (남녀공용)').label, 'Apparel');
});

test('product category revenue keeps known categories split before using Other', () => {
  const orders = [
    makeOrder('CAT001', 10_000, 0, [{ name: '최대 60만원 SHUE LUCKY BOX', price: 10_000 }]),
    makeOrder('CAT002', 20_000, 0, [{ name: 'Silk scarf twilly', price: 20_000 }]),
    makeOrder('CAT003', 30_000, 0, [{ name: 'Imported shoulder bag', price: 30_000 }]),
    makeOrder('CAT004', 40_000, 0, [{ name: '메리제인 슈즈', price: 40_000 }]),
    makeOrder('CAT005', 50_000, 0, [{ name: '알함브라 네크리스', price: 50_000 }]),
    makeOrder('CAT006', 60_000, 0, [{ name: 'cashmere cardigan knit', price: 60_000 }]),
    makeOrder('CAT007', 70_000, 0, [{ name: 'card holder wallet', price: 70_000 }]),
    makeOrder('CAT008', 80_000, 0, [{ name: 'logo belt accessory', price: 80_000 }]),
  ];

  const labels = buildProductCategoryRevenue(orders).map(row => row.label);

  assert.deepEqual(new Set(labels), new Set([
    'Lucky Box',
    'Scarves',
    'Bags',
    'Shoes',
    'Jewelry',
    'Apparel',
    'Wallets',
    'Accessories',
  ]));
  assert.equal(labels.includes('Other'), false);
});

test('calendar payload owns selected-range revenue by payment channel', () => {
  assert.match(contractsJs, /categoryRevenueByDate:\s*categoryRevenueByDate\s*\?\?\s*\{\}/);
  assert.match(contractsJs, /categoryRevenueByMonth:\s*categoryRevenueByMonth\s*\?\?\s*\{\}/);
  assert.match(contractsJs, /categoryRevenue:\s*selection\?\.categoryRevenue\s*\?\?\s*\[\]/);
  assert.match(contractsJs, /paymentChannels:\s*\{/);
  assert.match(contractsJs, /totalGrossRevenue:\s*selection\?\.paymentChannels\?\.totalGrossRevenue\s*\?\?\s*0/);
  assert.match(contractsJs, /rows:\s*\(selection\?\.paymentChannels\?\.rows\s*\?\?\s*\[\]\)\.map/);
  assert.match(calendarServiceJs, /cogsAutofillService\.getPaywayCardOrderNos/);
  assert.match(calendarServiceJs, /buildPaymentChannelRevenue\(selectionOrders,\s*\{\s*cardOrderNos,\s*bankTransferAsRemainder:\s*true/);
  assert.match(calendarJs, /const paymentChannels = selection\?\.paymentChannels \|\| \{\};/);
  assert.match(calendarJs, /label:\s*tr\('Credit card revenue'/);
  assert.match(calendarJs, /label:\s*tr\('Bank transfer revenue'/);
});

test('calendar payload preserves all-time order patterns for API compatibility', () => {
  assert.match(contractsJs, /orderPatterns:\s*\{/);
  assert.match(contractsJs, /weekday:\s*orderPatterns\?\.weekday\s*\?\?\s*\[\]/);
  assert.match(contractsJs, /hourly:\s*orderPatterns\?\.hourly\s*\?\?\s*\[\]/);
  assert.match(calendarServiceJs, /function buildAllTimeOrderPatterns\(projection\)/);
  assert.match(calendarServiceJs, /const dailyRows = Array\.isArray\(projection\?\.dailyMerged\) \? projection\.dailyMerged : \[\];/);
  assert.match(calendarServiceJs, /orderPatterns: buildAllTimeOrderPatterns\(projection\)/);
});

test('calendar income statement renders the financial sequence and every canonical cost', () => {
  const revenueIndex = calendarJs.indexOf("label: tr('Credit card revenue'");
  const totalRevenueIndex = calendarJs.indexOf("label: tr('Total revenue'");
  const refundsIndex = calendarJs.indexOf("label: tr('Refunds and cancellations'");
  const netRevenueIndex = calendarJs.indexOf("label: tr('Net revenue'");
  const cogsIndex = calendarJs.indexOf("label: 'COGS'");
  const shippingIndex = calendarJs.indexOf("label: tr('Shipping costs'");
  const paymentFeesIndex = calendarJs.indexOf("label: tr('Payment processing fees'");
  const advertisingIndex = calendarJs.indexOf("label: tr('Advertising costs'");
  const totalCostsIndex = calendarJs.indexOf("label: tr('Total costs'");

  assert.ok(revenueIndex >= 0);
  assert.ok(revenueIndex < totalRevenueIndex);
  assert.ok(totalRevenueIndex < refundsIndex);
  assert.ok(refundsIndex < netRevenueIndex);
  assert.ok(netRevenueIndex < cogsIndex);
  assert.ok(cogsIndex < shippingIndex);
  assert.ok(shippingIndex < paymentFeesIndex);
  assert.ok(paymentFeesIndex < advertisingIndex);
  assert.ok(advertisingIndex < totalCostsIndex);
  assert.match(calendarJs, /tr\('Net profit', '순이익'\)/);
  assert.match(calendarJs, /summary\.trueNetProfit/);
});

test('calendar income statement exposes financial incompleteness instead of hiding it', () => {
  assert.match(calendarJs, /const paymentChannelGap = Math\.round\(summary\.grossRevenue - reportedChannelRevenue\);/);
  assert.match(calendarJs, /Payment-channel revenue differs from total revenue by/);
  assert.match(calendarJs, /COGS coverage is incomplete/);
  assert.match(calendarJs, /Net profit reflects only costs currently logged/);
  assert.match(calendarJs, /daysRequiringCOGS/);
});

test('calendar income statement is responsive without horizontal chart scrolling', () => {
  assert.match(css, /\.income-statement-columns,\s*\.income-statement-line\s*\{[\s\S]*grid-template-columns:/);
  assert.match(css, /@media \(max-width:\s*480px\)[\s\S]*\.income-statement-columns span:nth-child\(2\),[\s\S]*\.income-statement-line \.income-statement-percent\s*\{[\s\S]*display:\s*none;/);
  assert.match(css, /@media \(max-width:\s*480px\)[\s\S]*\.income-statement-result\s*\{[\s\S]*flex-direction:\s*column;/);
  assert.doesNotMatch(css, /calendar-sankey-canvas/);
});

test('calendar no longer loads or renders Sankey dependencies', () => {
  assert.doesNotMatch(indexHtml, /d3(?:-sankey)?(?:\.min)?\.js/i);
  assert.doesNotMatch(indexHtml, /Sankey/);
  assert.doesNotMatch(calendarJs, /Sankey|d3Sankey|sankeyLinkHorizontal/);
  assert.doesNotMatch(css, /sankey/i);
});

test('calendar income statement keeps Meta ad spend visible as an explicit cost row', () => {
  assert.match(calendarJs, /summary\.adSpendKRW \+= toFiniteNumber\(day\.adSpendKRW\)/);
  assert.match(calendarJs, /label:\s*tr\('Advertising costs', '광고비'\)/);
  assert.match(calendarJs, /amount:\s*-summary\.adSpendKRW/);
  assert.match(calendarJs, /COGS \+ shipping \+ fees \+ advertising/);
});

test('calendar selection ends after the income statement', () => {
  assert.doesNotMatch(calendarJs, /calendar-summary-grid-secondary|summaryCards|renderCalendarSummaryCard/);
  assert.doesNotMatch(css, /\.calendar-summary-grid/);
  assert.match(indexHtml, /class="summary-profit-topline"[\s\S]*id="calendarIncomeStatementDeck"/);
  assert.doesNotMatch(indexHtml, /summary-profit-charts|calendarSelectionDeck/);
  assert.match(css, /\.summary-profit-topline\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(0,\s*1fr\);/);
  assert.match(css, /\.summary-profit-kpis\s*\{[\s\S]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/);
  assert.match(calendarJs, /const statementContainer = document\.getElementById\('calendarIncomeStatementDeck'\);/);
  assert.match(calendarJs, /statementContainer\.innerHTML = renderCalendarIncomeStatement\(selection\);/);
  assert.doesNotMatch(calendarJs, /Daily Breakdown|Orders Ledger|Product Explorer/);
});

test('calendar drag selection refreshes the same selected-range summary path', () => {
  assert.match(calendarJs, /viewportEl\.addEventListener\('pointerdown'[\s\S]*calendarState\.dragStart = dayEl\.dataset\.date;/);
  assert.match(calendarJs, /viewportEl\.addEventListener\('pointerover'[\s\S]*calendarState\.selectionStart = calendarState\.dragStart;[\s\S]*calendarState\.selectionEnd = currentDate;/);
  assert.match(calendarJs, /document\.addEventListener\('pointerup'[\s\S]*const shouldRefresh = calendarState\.didDrag;[\s\S]*await refreshCalendarPage\(\);/);
  assert.match(calendarJs, /fetchCalendarAnalysis\(\{[\s\S]*selectionStart:\s*calendarState\.selectionStart,[\s\S]*selectionEnd:\s*calendarState\.selectionEnd,/);
});
