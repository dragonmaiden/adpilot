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

const contractsJs = fs.readFileSync(CONTRACTS_PATH, 'utf8');
const calendarServiceJs = fs.readFileSync(CALENDAR_SERVICE_PATH, 'utf8');
const calendarJs = fs.readFileSync(CALENDAR_JS_PATH, 'utf8');
const css = fs.readFileSync(STYLE_PATH, 'utf8');

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

test('calendar payload exposes category inflows and sankey consumes selected-range inflows', () => {
  assert.match(contractsJs, /categoryRevenueByDate:\s*categoryRevenueByDate\s*\?\?\s*\{\}/);
  assert.match(contractsJs, /categoryRevenueByMonth:\s*categoryRevenueByMonth\s*\?\?\s*\{\}/);
  assert.match(calendarServiceJs, /const monthKey = month\?\.key \|\| month\?\.month \|\| String\(month\?\.start \|\| ''\)\.slice\(0,\s*7\);/);
  assert.doesNotMatch(calendarServiceJs, /return \[month\.key,/);
  assert.match(calendarJs, /function getCalendarCategoryRevenueRows\(selection\)/);
  assert.match(calendarJs, /normalizeSankeyCategoryRows\(getCalendarCategoryRevenueRows\(selection\),\s*grossV\)/);
  assert.match(calendarJs, /addLink\(`category:\$\{row\.key\}`,\s*'gross',\s*row\.revenue,\s*'neutral'/);
  assert.match(calendarJs, /data-calendar-sankey-meta/);
  assert.match(calendarJs, /formatCalendarSankeyMeta\(viewModel\)/);
  assert.doesNotMatch(calendarJs, /waterfallGranularity|data-calendar-waterfall-granularity|calendar-sankey-mode-switch/);
  assert.doesNotMatch(css, /\.calendar-sankey-mode-switch/);
});

test('calendar sankey expands to the available card width before scrolling', () => {
  assert.match(calendarJs, /viewBox="0 0 1280 560"/);
  assert.match(calendarJs, /Profit Sankey with product category inflows/);
  assert.match(css, /\.calendar-sankey-canvas\s*\{[\s\S]*width:\s*100%;[\s\S]*min-width:\s*min\(1120px,\s*100%\);[\s\S]*aspect-ratio:\s*1280\s*\/\s*560;/);
});

test('calendar sankey omits zero-value labels and guide paths', () => {
  assert.doesNotMatch(calendarJs, /zeroFixedValue|options\.guide|is-guide|guide:/);
  assert.doesNotMatch(css, /\.calendar-sankey-flow\.is-guide/);
  assert.match(calendarJs, /const visibleNodes = nodes\.filter\(node => node\.visible !== false && linkedNodeIds\.has\(node\.id\)\);/);
  assert.match(calendarJs, /noFinancialMovement/);
  assert.match(calendarJs, /No financial movement in this selection\./);
});

test('calendar selection keeps the sankey as the metric owner before the detailed tables', () => {
  assert.doesNotMatch(calendarJs, /calendar-summary-grid-secondary|summaryCards|renderCalendarSummaryCard/);
  assert.doesNotMatch(css, /\.calendar-summary-grid/);
  assert.match(calendarJs, /\$\{renderCalendarSankey\(selection,\s*summary\)\}[\s\S]*<h2>\$\{esc\(tr\('Daily Breakdown'/);
});

test('calendar drag selection refreshes the same selected-range summary path', () => {
  assert.match(calendarJs, /viewportEl\.addEventListener\('pointerdown'[\s\S]*calendarState\.dragStart = dayEl\.dataset\.date;/);
  assert.match(calendarJs, /viewportEl\.addEventListener\('pointerover'[\s\S]*calendarState\.selectionStart = calendarState\.dragStart;[\s\S]*calendarState\.selectionEnd = currentDate;/);
  assert.match(calendarJs, /document\.addEventListener\('pointerup'[\s\S]*const shouldRefresh = calendarState\.didDrag;[\s\S]*await refreshCalendarPage\(\);/);
  assert.match(calendarJs, /fetchCalendarAnalysis\(\{[\s\S]*selectionStart:\s*calendarState\.selectionStart,[\s\S]*selectionEnd:\s*calendarState\.selectionEnd,/);
});
