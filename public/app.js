/* ============================================
   AdPilot — Meta Ads AI Agent Dashboard
   Application Logic — Real SHUE Data
   ============================================ */

// ── Theme Toggle ──
(function(){
  const t = document.querySelector('[data-theme-toggle]');
  const r = document.documentElement;
  let d = 'dark';
  r.setAttribute('data-theme', d);
  updateThemeIcon();

  if (t) {
    t.addEventListener('click', () => {
      d = d === 'dark' ? 'light' : 'dark';
      r.setAttribute('data-theme', d);
      updateThemeIcon();
      updateChartColors();
    });
  }

  function updateThemeIcon() {
    if (!t) return;
    t.innerHTML = d === 'dark'
      ? '<i data-lucide="sun"></i>'
      : '<i data-lucide="moon"></i>';
    lucide.createIcons({ nodes: [t] });
  }
})();

// ── Mobile Menu ──
const menuBtn = document.getElementById('menuBtn');
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('sidebarOverlay');

if (menuBtn) {
  menuBtn.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('active');
  });
}

if (overlay) {
  overlay.addEventListener('click', () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
  });
}

// ── Page Navigation ──
const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.page');
const pageTitle = document.getElementById('pageTitle');

const pageTitles = {
  overview: 'Overview',
  analytics: 'Analytics',
  campaigns: 'Active Campaigns',
  optimizations: 'Optimization Log',
  fatigue: 'Fatigue Detection',
  budget: 'Budget Manager',
  settings: 'Settings'
};

navItems.forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const target = item.dataset.page;

    navItems.forEach(n => n.classList.remove('active'));
    item.classList.add('active');

    pages.forEach(p => p.classList.remove('active'));
    const targetPage = document.querySelector(`.page[data-page="${target}"]`);
    if (targetPage) targetPage.classList.add('active');

    if (pageTitle) pageTitle.textContent = pageTitles[target] || target;

    sidebar.classList.remove('open');
    overlay.classList.remove('active');

    if (target === 'analytics' && !analyticsChartsInitialized) initAnalyticsCharts();
    if (target === 'fatigue' && !fatigueChartInitialized) initFatigueChart();
    if (target === 'budget' && !budgetChartsInitialized) initBudgetCharts();
    if (target === 'optimizations' && !optTimelineInitialized) initOptTimeline();
  });
});

// ── Scan Button ──
const runScanBtn = document.getElementById('runScanBtn');
if (runScanBtn) {
  runScanBtn.addEventListener('click', () => {
    document.body.classList.add('scanning');
    runScanBtn.querySelector('span').textContent = 'Scanning...';
    setTimeout(() => {
      document.body.classList.remove('scanning');
      runScanBtn.querySelector('span').textContent = 'Run Scan Now';
      document.getElementById('lastScan').textContent = 'just now';
      addActivity({
        type: 'bid',
        icon: 'radar',
        title: 'Manual scan completed',
        detail: 'Analyzed 4 campaigns & 34 ads. Found 2 micro-optimization opportunities.',
        time: 'Just now'
      });
    }, 3000);
  });
}

// ── Countdown Timer ──
let countdownMinutes = 47;
setInterval(() => {
  countdownMinutes = countdownMinutes <= 0 ? 60 : countdownMinutes - 1;
  const el = document.getElementById('countdown');
  if (el) el.textContent = countdownMinutes + 'm';
}, 60000);

// ── KPI Number Animation ──
function animateKPIs() {
  document.querySelectorAll('.kpi-value[data-target]').forEach(el => {
    const target = parseFloat(el.dataset.target);
    const prefix = el.dataset.prefix !== undefined ? el.dataset.prefix : '$';
    const suffix = el.dataset.suffix || '';
    const duration = 1200;
    const start = performance.now();
    const isDecimal = target % 1 !== 0;

    function step(now) {
      const progress = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - progress, 3);
      const current = target * ease;

      if (isDecimal) {
        el.textContent = prefix + current.toFixed(2) + suffix;
      } else {
        el.textContent = prefix + Math.round(current).toLocaleString() + suffix;
      }

      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
}

// ── Chart.js Defaults ──
function getChartColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    text: style.getPropertyValue('--color-text-muted').trim(),
    textFaint: style.getPropertyValue('--color-text-faint').trim(),
    grid: style.getPropertyValue('--color-divider').trim(),
    surface: style.getPropertyValue('--color-surface').trim(),
    primary: '#20808D',
    secondary: '#A84B2F',
    success: '#4ade80',
    teal: '#1B474D',
    gold: '#FFC553',
  };
}

Chart.defaults.font.family = "'DM Sans', sans-serif";
Chart.defaults.font.size = 12;
Chart.defaults.plugins.legend.display = false;
Chart.defaults.responsive = true;
Chart.defaults.maintainAspectRatio = false;

let spendRevenueChart, impactChart, roasChart, brandChart, fatigueChart, budgetPieChart, budgetPaceChart;
let optTimelineChart, optTypeChart, optPriorityChart;
let fatigueChartInitialized = false;
let budgetChartsInitialized = false;
let optTimelineInitialized = false;

function updateChartColors() {
  const c = getChartColors();
  const allCharts = [spendRevenueChart, impactChart, roasChart, brandChart, fatigueChart, budgetPieChart, budgetPaceChart, optTimelineChart, optTypeChart, optPriorityChart];
  allCharts.forEach(chart => {
    if (!chart) return;
    if (chart.options.scales) {
      Object.values(chart.options.scales).forEach(scale => {
        if (scale.grid) scale.grid.color = c.grid;
        if (scale.ticks) scale.ticks.color = c.textFaint;
      });
    }
    chart.update('none');
  });
}

// ═══════════════════════════════════════════════════════
// ── REAL DATA: SHUE Meta Ads + Imweb Revenue ──
// ═══════════════════════════════════════════════════════

const USD_TO_KRW = 1450;

// Daily performance data (Feb 3 - Mar 10, 2026) — Meta Ads + Imweb Revenue
const dailyData = [
  {date:'02/03',spend:37.55,clicks:96,purchases:0,ctr:4.17,cpc:0.391,impressions:2300,reach:2204,revenue:0},
  {date:'02/04',spend:42.94,clicks:156,purchases:0,ctr:5.04,cpc:0.275,impressions:3094,reach:2823,revenue:0},
  {date:'02/05',spend:68.79,clicks:275,purchases:0,ctr:5.86,cpc:0.250,impressions:4690,reach:4324,revenue:0},
  {date:'02/06',spend:52.49,clicks:239,purchases:0,ctr:7.00,cpc:0.220,impressions:3415,reach:3014,revenue:0},
  {date:'02/07',spend:41.04,clicks:189,purchases:1,ctr:7.70,cpc:0.217,impressions:2455,reach:2118,revenue:118000},
  {date:'02/08',spend:53.59,clicks:232,purchases:5,ctr:9.56,cpc:0.231,impressions:2428,reach:1907,revenue:605550},
  {date:'02/09',spend:47.68,clicks:158,purchases:2,ctr:10.49,cpc:0.302,impressions:1506,reach:1193,revenue:149850},
  {date:'02/10',spend:81.43,clicks:277,purchases:3,ctr:6.96,cpc:0.294,impressions:3981,reach:2933,revenue:180000},
  {date:'02/11',spend:25.88,clicks:108,purchases:0,ctr:7.85,cpc:0.240,impressions:1375,reach:1252,revenue:386650},
  {date:'02/12',spend:35.30,clicks:154,purchases:3,ctr:6.03,cpc:0.229,impressions:2556,reach:2170,revenue:320800},
  {date:'02/13',spend:29.47,clicks:145,purchases:0,ctr:5.76,cpc:0.203,impressions:2518,reach:2379,revenue:0},
  {date:'02/14',spend:44.32,clicks:332,purchases:8,ctr:7.08,cpc:0.133,impressions:4692,reach:4219,revenue:1157150},
  {date:'02/15',spend:59.98,clicks:395,purchases:10,ctr:8.04,cpc:0.152,impressions:4912,reach:4478,revenue:1004249},
  {date:'02/16',spend:92.18,clicks:577,purchases:4,ctr:10.11,cpc:0.160,impressions:5705,reach:5085,revenue:186000},
  {date:'02/17',spend:59.27,clicks:398,purchases:5,ctr:7.29,cpc:0.149,impressions:5456,reach:4891,revenue:739000},
  {date:'02/18',spend:52.24,clicks:223,purchases:5,ctr:9.20,cpc:0.234,impressions:2425,reach:2099,revenue:726650},
  {date:'02/19',spend:99.74,clicks:257,purchases:1,ctr:5.60,cpc:0.388,impressions:4593,reach:4120,revenue:62000},
  {date:'02/20',spend:53.13,clicks:175,purchases:4,ctr:15.14,cpc:0.304,impressions:1156,reach:917,revenue:561250},
  {date:'02/21',spend:58.96,clicks:188,purchases:5,ctr:9.22,cpc:0.314,impressions:2038,reach:1751,revenue:374850},
  {date:'02/22',spend:161.50,clicks:830,purchases:10,ctr:9.37,cpc:0.195,impressions:8857,reach:6883,revenue:709099},
  {date:'02/23',spend:240.18,clicks:810,purchases:6,ctr:7.65,cpc:0.297,impressions:10589,reach:9169,revenue:874374},
  {date:'02/24',spend:167.14,clicks:519,purchases:6,ctr:9.30,cpc:0.322,impressions:5580,reach:4980,revenue:621731},
  {date:'02/25',spend:150.46,clicks:629,purchases:5,ctr:12.44,cpc:0.239,impressions:5056,reach:4187,revenue:0},
  {date:'02/26',spend:126.61,clicks:633,purchases:8,ctr:12.44,cpc:0.200,impressions:5089,reach:4150,revenue:1051799},
  {date:'02/27',spend:110.34,clicks:445,purchases:10,ctr:11.55,cpc:0.248,impressions:3852,reach:3159,revenue:1364858},
  {date:'02/28',spend:120.16,clicks:487,purchases:6,ctr:11.59,cpc:0.247,impressions:4203,reach:3654,revenue:1043992},
  {date:'03/01',spend:124.18,clicks:313,purchases:9,ctr:14.79,cpc:0.397,impressions:2117,reach:1612,revenue:822069},
  {date:'03/02',spend:179.75,clicks:601,purchases:18,ctr:15.31,cpc:0.299,impressions:3925,reach:3284,revenue:1404781},
  {date:'03/03',spend:242.42,clicks:873,purchases:8,ctr:11.15,cpc:0.278,impressions:7831,reach:6621,revenue:884295},
  {date:'03/04',spend:171.65,clicks:668,purchases:4,ctr:11.28,cpc:0.257,impressions:5920,reach:5647,revenue:753221},
  {date:'03/05',spend:128.11,clicks:359,purchases:8,ctr:16.80,cpc:0.357,impressions:2137,reach:1647,revenue:512081},
  {date:'03/06',spend:137.12,clicks:347,purchases:8,ctr:15.37,cpc:0.395,impressions:2257,reach:1560,revenue:1371349},
  {date:'03/07',spend:132.41,clicks:451,purchases:15,ctr:13.94,cpc:0.294,impressions:3235,reach:2525,revenue:812472},
  {date:'03/08',spend:151.42,clicks:656,purchases:11,ctr:12.53,cpc:0.231,impressions:5236,reach:4106,revenue:630317},
  {date:'03/09',spend:103.81,clicks:419,purchases:17,ctr:13.02,cpc:0.248,impressions:3218,reach:2437,revenue:756681},
  {date:'03/10',spend:46.85,clicks:182,purchases:2,ctr:11.64,cpc:0.257,impressions:1564,reach:1376,revenue:285000},
];

// Brand revenue data from Imweb
const brandData = [
  {brand:'CHANEL',items:51,revenue:8171350},
  {brand:'HERMÈS',items:71,revenue:7751150},
  {brand:'LOUIS VUITTON',items:55,revenue:6061050},
  {brand:'DIOR',items:16,revenue:2945750},
  {brand:'Other',items:124,revenue:5540818},
];

// COGS data from Google Sheets (Feb 2026 only)
const cogsData = {
  '02/08':{cost:465000,shipping:32000,items:10},
  '02/09':{cost:128000,shipping:12000,items:3},
  '02/10':{cost:138000,shipping:12000,items:4},
  '02/11':{cost:110000,shipping:4000,items:1},
  '02/12':{cost:190000,shipping:8000,items:3},
  '02/14':{cost:489000,shipping:16000,items:7},
  '02/15':{cost:534000,shipping:28000,items:10},
  '02/16':{cost:230000,shipping:12000,items:3},
  '02/17':{cost:361000,shipping:16000,items:5},
  '02/18':{cost:361000,shipping:8000,items:3},
  '02/19':{cost:23000,shipping:4000,items:1},
  '02/20':{cost:163000,shipping:12000,items:3},
  '02/21':{cost:162000,shipping:12000,items:4},
  '02/22':{cost:252000,shipping:28000,items:8},
  '02/23':{cost:556000,shipping:12000,items:5},
  '02/24':{cost:222000,shipping:24000,items:7},
  '02/26':{cost:273000,shipping:32000,items:9},
  '02/27':{cost:835000,shipping:44000,items:12},
  '02/28':{cost:362000,shipping:32000,items:9},
};
const totalCOGS = 5854000;
const totalShipping = 348000;

// Campaign data
const campaigns = [
  { name: '260202_트래픽 테스트', status: 'paused', objective: 'Traffic', budget: 110, spend: 23.92, purchases: 0, cpa: 0, ctr: 8.74, impressions: 3776, clicks: 330, reach: 3516, frequency: 1.07, addToCart: 2, checkouts: 3, fatigue: 'high' },
  { name: '260203_판매 테스트', status: 'active', objective: 'Sales', budget: 110, spend: 3452.42, purchases: 207, cpa: 16.68, ctr: 9.85, impressions: 135641, clicks: 13362, reach: 115230, frequency: 1.18, addToCart: 1110, checkouts: 727, fatigue: 'low' },
  { name: '260211_판매 2번째 테스트', status: 'paused', objective: 'Sales', budget: 110, spend: 16.72, purchases: 0, cpa: 0, ctr: 3.41, impressions: 1115, clicks: 38, reach: 969, frequency: 1.15, addToCart: 0, checkouts: 0, fatigue: 'high' },
  { name: '260219_랜덤박스 캠페인', status: 'paused', objective: 'Sales', budget: 110, spend: 37.03, purchases: 0, cpa: 0, ctr: 4.62, impressions: 1429, clicks: 66, reach: 1396, frequency: 1.02, addToCart: 2, checkouts: 0, fatigue: 'high' },
];

// Top ads performance
const adMetrics = [
  { name: '260226_스카프 15% 블랙 루루', campaign: '260203_판매 테스트', spend: 666.35, impressions: 12991, clicks: 1941, purchases: 52, ctr: 14.94, frequency: 1.83, cpc: 0.343, status: 'active' },
  { name: '260221_스카프 15%', campaign: '260203_판매 테스트', spend: 784.86, impressions: 33731, clicks: 3081, purchases: 47, ctr: 9.13, frequency: 1.52, cpc: 0.255, status: 'paused' },
  { name: '260224_스카프 15% 루루', campaign: '260203_판매 테스트', spend: 692.28, impressions: 25988, clicks: 3065, purchases: 32, ctr: 11.79, frequency: 1.52, cpc: 0.226, status: 'paused' },
  { name: '260209_랜덤 럭키박스 3 영상', campaign: '260203_판매 테스트', spend: 128.95, impressions: 5567, clicks: 483, purchases: 23, ctr: 8.68, frequency: 1.31, cpc: 0.267, status: 'paused' },
  { name: '260215_메리제인', campaign: '260203_판매 테스트', spend: 285.22, impressions: 12142, clicks: 1354, purchases: 18, ctr: 11.15, frequency: 1.45, cpc: 0.211, status: 'active' },
  { name: '260211_리버시블 자켓', campaign: '260203_판매 테스트', spend: 139.47, impressions: 14352, clicks: 1047, purchases: 9, ctr: 7.3, frequency: 1.22, cpc: 0.133, status: 'paused' },
  { name: '260205_랜덤 럭키박스 2', campaign: '260203_판매 테스트', spend: 144.05, impressions: 6154, clicks: 459, purchases: 8, ctr: 7.46, frequency: 1.54, cpc: 0.314, status: 'paused' },
  { name: '260305_메인 소재', campaign: '260203_판매 테스트', spend: 91.36, impressions: 1557, clicks: 235, purchases: 6, ctr: 15.09, frequency: 1.46, cpc: 0.389, status: 'active' },
  { name: '260224_스카프 15% 스카이', campaign: '260203_판매 테스트', spend: 104.57, impressions: 2365, clicks: 361, purchases: 5, ctr: 15.26, frequency: 1.3, cpc: 0.29, status: 'paused' },
  { name: '260303_수입 테라스 숄더백', campaign: '260203_판매 테스트', spend: 41.71, impressions: 861, clicks: 148, purchases: 2, ctr: 17.19, frequency: 1.49, cpc: 0.282, status: 'active' },
];

// ── Sparklines ──
function createSparkline(containerId, data, color) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const canvas = document.createElement('canvas');
  container.appendChild(canvas);

  new Chart(canvas, {
    type: 'line',
    data: {
      labels: data.map((_, i) => i),
      datasets: [{
        data: data,
        borderColor: color,
        borderWidth: 1.5,
        fill: {
          target: 'origin',
          above: color + '15',
        },
        pointRadius: 0,
        tension: 0.4,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
      elements: { line: { borderWidth: 1.5 } }
    }
  });
}

// ── Main Charts ──
function initCharts() {
  const c = getChartColors();

  // Use last 14 days of daily data for overview charts
  const last14 = dailyData.slice(-14);
  const chartLabels = last14.map(d => d.date);

  // Revenue vs Ad Spend chart (both in KRW)
  const ctx1 = document.getElementById('spendRevenueChart');
  if (ctx1) {
    spendRevenueChart = new Chart(ctx1, {
      type: 'bar',
      data: {
        labels: chartLabels,
        datasets: [
          {
            label: 'Revenue (₩)',
            data: last14.map(d => d.revenue),
            backgroundColor: '#4ade80',
            borderRadius: 4,
            barPercentage: 0.7,
            categoryPercentage: 0.6,
            yAxisID: 'y',
          },
          {
            label: 'Ad Spend (₩)',
            data: last14.map(d => Math.round(d.spend * USD_TO_KRW)),
            type: 'line',
            borderColor: c.secondary,
            backgroundColor: c.secondary + '20',
            fill: false,
            tension: 0.4,
            pointRadius: 3,
            pointBackgroundColor: c.secondary,
            borderWidth: 2,
            yAxisID: 'y',
          }
        ]
      },
      options: {
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: { color: c.textFaint, usePointStyle: true, padding: 12, font: { size: 11 } }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: c.textFaint, maxRotation: 45 } },
          y: {
            position: 'left',
            grid: { color: c.grid },
            ticks: {
              color: c.textFaint,
              callback: v => '₩' + (v / 1000).toFixed(0) + 'K'
            },
          },
        }
      }
    });
  }

  // Daily ROAS chart
  const ctxRoas = document.getElementById('roasChart');
  if (ctxRoas) {
    const roasData = last14.map(d => {
      const spendKrw = d.spend * USD_TO_KRW;
      return spendKrw > 0 ? parseFloat((d.revenue / spendKrw).toFixed(2)) : 0;
    });
    roasChart = new Chart(ctxRoas, {
      type: 'line',
      data: {
        labels: chartLabels,
        datasets: [{
          label: 'ROAS',
          data: roasData,
          borderColor: c.primary,
          backgroundColor: c.primary + '20',
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointBackgroundColor: roasData.map(v => v >= 3 ? '#4ade80' : v >= 1 ? c.gold : 'var(--color-error, #ef4444)'),
          borderWidth: 2,
        }]
      },
      options: {
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: { label: ctx => ctx.parsed.y.toFixed(1) + 'x ROAS' }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: c.textFaint, maxRotation: 45 } },
          y: {
            grid: { color: c.grid },
            ticks: {
              color: c.textFaint,
              callback: v => v + 'x'
            },
            min: 0,
          }
        },
      }
    });
  }

  // Brand revenue doughnut
  const ctxBrand = document.getElementById('brandChart');
  if (ctxBrand) {
    brandChart = new Chart(ctxBrand, {
      type: 'doughnut',
      data: {
        labels: brandData.map(b => b.brand),
        datasets: [{
          data: brandData.map(b => b.revenue),
          backgroundColor: ['#20808D', '#FFC553', '#A84B2F', '#944454', '#6B7280'],
          borderWidth: 0,
        }]
      },
      options: {
        plugins: {
          legend: {
            display: true,
            position: 'right',
            labels: {
              color: c.textFaint,
              usePointStyle: true,
              padding: 10,
              font: { size: 11 },
            }
          },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                return ctx.label + ': ₩' + ctx.raw.toLocaleString();
              }
            }
          }
        },
        cutout: '65%',
      }
    });
  }

  // CTR & CPC Trend
  const ctx2 = document.getElementById('impactChart');
  if (ctx2) {
    impactChart = new Chart(ctx2, {
      type: 'line',
      data: {
        labels: chartLabels,
        datasets: [
          {
            label: 'CTR (%)',
            data: last14.map(d => d.ctr),
            borderColor: c.primary,
            backgroundColor: c.primary + '15',
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            pointBackgroundColor: c.primary,
            yAxisID: 'y',
          },
          {
            label: 'CPC ($)',
            data: last14.map(d => d.cpc),
            borderColor: c.secondary,
            backgroundColor: c.secondary + '15',
            fill: false,
            tension: 0.4,
            pointRadius: 3,
            pointBackgroundColor: c.secondary,
            yAxisID: 'y1',
          }
        ]
      },
      options: {
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: { color: c.textFaint, usePointStyle: true, padding: 12, font: { size: 11 } }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: c.textFaint, maxRotation: 45 } },
          y: {
            position: 'left',
            grid: { color: c.grid },
            ticks: {
              color: c.textFaint,
              callback: v => v + '%'
            },
            title: { display: true, text: 'CTR (%)', color: c.textFaint }
          },
          y1: {
            position: 'right',
            grid: { display: false },
            ticks: {
              color: c.textFaint,
              callback: v => '$' + v.toFixed(2)
            },
            title: { display: true, text: 'CPC ($)', color: c.textFaint }
          }
        }
      }
    });
  }

  // Sparklines from real data (last 12 days)
  const last12 = dailyData.slice(-12);
  createSparkline('sparkRevenue', last12.map(d => d.revenue), '#4ade80');
  createSparkline('sparkCogs', last12.map(d => {
    const cg = cogsData[d.date];
    return cg ? cg.cost + cg.shipping : 0;
  }), c.secondary);
  createSparkline('sparkSpend', last12.map(d => d.spend), c.primary);
  createSparkline('sparkRoas', last12.map(d => {
    const sk = d.spend * USD_TO_KRW;
    return sk > 0 ? d.revenue / sk : 0;
  }), c.primary);
  createSparkline('sparkPurchases', last12.map(d => d.purchases), '#4ade80');
  createSparkline('sparkCtr', last12.map(d => d.ctr), c.primary);
  createSparkline('sparkCpa', last12.map(d => d.spend / Math.max(d.purchases, 1)), c.secondary);
}

// ── Activity Feed (AI actions based on real data patterns) ──
const activities = [
  { type: 'budget', icon: 'wallet', title: 'Budget scale-up on 판매 테스트', detail: 'Main campaign generating 206 purchases at $16.72 CPA. Daily budget maintained at $110/day — strong performance.', time: '12m ago' },
  { type: 'creative', icon: 'image', title: 'Top performer: 스카프 15% 블랙 루루', detail: '52 purchases at $12.72 CPA — best performing ad. CTR at 14.98%. Recommending increased delivery weight.', time: '45m ago' },
  { type: 'bid', icon: 'trending-up', title: 'CPC optimization detected', detail: 'Overall CPC dropped from $0.39 (Feb 3) to $0.25 (Mar 9). Algorithm learning phase complete, efficiency improving.', time: '1h ago' },
  { type: 'audience', icon: 'users', title: 'Paused underperformer: 브레이슬릿 화이트', detail: '$52 spent with 0 purchases and 4.47% CTR (below 9.84% campaign avg). Suggest pausing to save budget.', time: '2h ago' },
  { type: 'schedule', icon: 'clock', title: 'Peak day identified: Mar 2', detail: 'Best single day: 18 purchases at $9.99 CPA. 15.31% CTR. Sunday shows strong purchase intent patterns.', time: '3h ago' },
  { type: 'budget', icon: 'wallet', title: 'Paused 3 underperforming campaigns', detail: '트래픽 테스트, 판매 2번째 테스트, 랜덤박스 캠페인 generated 0 purchases combined. Budget consolidated to 판매 테스트.', time: '4h ago' },
  { type: 'creative', icon: 'image', title: 'Creative rotation: 럭키박스 3 영상', detail: 'Video ad achieving 23 purchases at $5.61 CPA — highest efficiency. Recommend scaling this creative format.', time: '5h ago' },
  { type: 'bid', icon: 'trending-up', title: 'Frequency alert on 스카프 15%', detail: 'Ad frequency at 1.52 with 33,731 impressions. Approaching saturation — monitor for CTR decay.', time: '6h ago' },
];

function addActivity(act) {
  activities.unshift(act);
  renderActivities();
}

function renderActivities() {
  const feed = document.getElementById('activityFeed');
  if (!feed) return;

  feed.innerHTML = activities.slice(0, 8).map(a => `
    <div class="activity-item">
      <div class="activity-icon ${a.type}">
        <i data-lucide="${a.icon}"></i>
      </div>
      <div class="activity-content">
        <div class="activity-title">${a.title}</div>
        <div class="activity-detail">${a.detail}</div>
      </div>
      <div class="activity-time">${a.time}</div>
    </div>
  `).join('');

  lucide.createIcons({ nodes: [feed] });
}

// ── Campaign Table ──
function renderCampaigns(filter) {
  const body = document.getElementById('campaignBody');
  if (!body) return;

  const filtered = filter === 'all' ? campaigns : campaigns.filter(c => {
    if (filter === 'warning') return c.fatigue === 'high' || (c.purchases === 0 && c.spend > 10);
    return c.status === filter;
  });

  body.innerHTML = filtered.map(c => {
    const statusClass = c.status === 'active' ? 'badge-success' : 'badge-neutral';
    const statusLabel = c.status.charAt(0).toUpperCase() + c.status.slice(1);
    const fatigueClass = c.fatigue === 'high' ? 'badge-error' : c.fatigue === 'medium' ? 'badge-warning' : 'badge-success';

    return `<tr>
      <td style="font-weight:500">${c.name}</td>
      <td><span class="badge ${statusClass}">${statusLabel}</span></td>
      <td>$${c.budget}/day</td>
      <td>$${c.spend.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
      <td style="font-weight:600">${c.purchases}</td>
      <td>${c.cpa > 0 ? '$' + c.cpa.toFixed(2) : '—'}</td>
      <td>${c.ctr}%</td>
      <td><span class="badge ${fatigueClass}">${c.fatigue.charAt(0).toUpperCase() + c.fatigue.slice(1)}</span></td>
      <td><button class="btn btn-sm btn-ghost">Details</button></td>
    </tr>`;
  }).join('');
}

const campaignFilter = document.getElementById('campaignFilter');
if (campaignFilter) {
  campaignFilter.addEventListener('change', (e) => {
    renderCampaigns(e.target.value);
  });
}

// ── Optimization Log ──
const optimizations = [
  { type: 'budget', title: 'Budget consolidated to 판매 테스트', desc: 'The main campaign drives all 206 purchases at $16.72 CPA. Three test campaigns produced 0 conversions. All budget now focused on the performer.', campaign: '260203_판매 테스트', time: '12m ago', impact: 'Saved ~$78/week' },
  { type: 'creative', title: 'Top ad identified: 블랙 루루 스카프', desc: '52 purchases from $661 spend = $12.72 CPA (best). CTR 14.98% is 52% above campaign average. Delivery weight increased.', campaign: '260203_판매 테스트', time: '45m ago', impact: 'CPA -24% vs avg' },
  { type: 'bid', title: 'CPC efficiency improving naturally', desc: 'CPC declined from $0.39 on Feb 3 to $0.25 by Mar 9 as Meta\'s algorithm learned. No manual bid intervention needed.', campaign: '260203_판매 테스트', time: '1h ago', impact: 'CPC -36%' },
  { type: 'audience', title: 'Paused 브레이슬릿 화이트 ad', desc: 'This ad spent $52.08 with 0 purchases and 4.47% CTR — well below the 9.84% campaign average. Immediate pause recommended.', campaign: '260203_판매 테스트', time: '2h ago', impact: 'Saved $52+' },
  { type: 'creative', title: 'Video outperforms static: 럭키박스 3 영상', desc: '23 purchases at only $5.61 CPA from video format. Static ads average $16+ CPA. Recommend shifting creative mix toward video.', campaign: '260203_판매 테스트', time: '3h ago', impact: 'CPA -66% vs avg' },
  { type: 'schedule', title: 'Weekend performance spike detected', desc: 'Mar 2 (Sunday): 18 purchases, highest single-day volume. Mar 7-9 weekend averaged 14 purchases/day vs 7 on weekdays. Consider weekend budget boost.', campaign: '260203_판매 테스트', time: '4h ago', impact: '+2x weekend conv.' },
  { type: 'budget', title: 'Paused 판매 2번째 테스트', desc: 'Second sales test spent $16.72 with only 38 clicks (3.41% CTR) and 0 purchases. Campaign paused after 1 day.', campaign: '260211_판매 2번째 테스트', time: '5h ago', impact: 'Saved $50/day' },
  { type: 'audience', title: 'Target: Women 25-52, South Korea', desc: 'Instagram + Threads placement in KR market. Core audience is women 25-52. This targeting is performing well — 65,101 reach with 2.08 frequency.', campaign: '260203_판매 테스트', time: '6h ago', impact: 'Reach 65K+' },
  { type: 'creative', title: '메리제인 ad performing steadily', desc: '17 purchases at $16.56 CPA with 11.04% CTR from 12,046 impressions. Solid mid-tier performer. Keep active.', campaign: '260203_판매 테스트', time: '7h ago', impact: '$16.56 CPA' },
  { type: 'budget', title: 'CTR trend: Strong upward trajectory', desc: 'CTR improved from 4.18% (Feb 3) to consistently 11-16% by March. Algorithm optimization and creative learning driving gains.', campaign: 'All', time: '8h ago', impact: 'CTR +280%' },
];

function renderOptimizations(filter) {
  const log = document.getElementById('optimizationLog');
  if (!log) return;

  const filtered = filter === 'all' ? optimizations : optimizations.filter(o => o.type === filter);

  log.innerHTML = filtered.map(o => `
    <div class="opt-item">
      <span class="opt-type-badge ${o.type}">${o.type.charAt(0).toUpperCase() + o.type.slice(1)}</span>
      <div class="opt-content">
        <div class="opt-title">${o.title}</div>
        <div class="opt-desc">${o.desc}</div>
        <div class="opt-meta">
          <span>${o.campaign}</span>
          <span>${o.time}</span>
          <span class="opt-impact">${o.impact}</span>
        </div>
      </div>
    </div>
  `).join('');
}

const optTypeFilter = document.getElementById('optTypeFilter');
if (optTypeFilter) {
  optTypeFilter.addEventListener('change', (e) => {
    renderOptimizations(e.target.value);
  });
}

// ── Fatigue Detection (real ad-level data — ACTIVE ADS ONLY, updated 2026-03-10) ──
const fatigueAds = [
  { name: '260305_메인 소재', status: 'healthy', frequency: 1.12, ctrDecay: +26, cpmRise: -12, days: 5, action: 'Excellent. CTR trending up (14.7% → 18.5%), CPM dropping. 6 purchases in 5 days. No fatigue signs.' },
  { name: '260303_수입 테라스 숄더백', status: 'healthy', frequency: 1.16, ctrDecay: +3, cpmRise: +18, days: 7, action: 'Strong performer. 17.2% CTR, 2 purchases. CPM rising slightly — monitor but no action needed.' },
  { name: '260226_스카프 15% 블랙 루루', status: 'healthy', frequency: 1.18, ctrDecay: +1, cpmRise: +24, days: 12, action: 'Top performer. 14.9% CTR, 52 purchases. CTR stable but CPM rising 24% — watch for early fatigue.' },
  { name: '260215_메리제인', status: 'warning', frequency: 1.11, ctrDecay: -29, cpmRise: -36, days: 23, action: 'CTR declining 29% (24.4% → 17.2%). Longest running ad at 23 days. Consider refreshing creative soon.' },
];

function renderFatigue() {
  const grid = document.getElementById('fatigueGrid');
  if (!grid) return;

  grid.innerHTML = fatigueAds.map(a => `
    <div class="fatigue-card ${a.status}">
      <div class="fatigue-header">
        <span class="fatigue-name">${a.name}</span>
        <span class="badge badge-${a.status === 'danger' ? 'error' : a.status === 'warning' ? 'warning' : 'success'}">${a.status.charAt(0).toUpperCase() + a.status.slice(1)}</span>
      </div>
      <div class="fatigue-metrics">
        <div class="fatigue-metric">
          <span class="fatigue-metric-label">Frequency</span>
          <span class="fatigue-metric-value">${a.frequency}</span>
        </div>
        <div class="fatigue-metric">
          <span class="fatigue-metric-label">CTR Change</span>
          <span class="fatigue-metric-value" style="color:${a.ctrDecay < -20 ? 'var(--color-error)' : a.ctrDecay < -10 ? 'var(--color-warning)' : 'var(--color-success)'}">${a.ctrDecay}%</span>
        </div>
        <div class="fatigue-metric">
          <span class="fatigue-metric-label">CPM Change</span>
          <span class="fatigue-metric-value" style="color:${a.cpmRise > 30 ? 'var(--color-error)' : a.cpmRise > 15 ? 'var(--color-warning)' : 'var(--color-success)'}">+${a.cpmRise}%</span>
        </div>
        <div class="fatigue-metric">
          <span class="fatigue-metric-label">Active Days</span>
          <span class="fatigue-metric-value">${a.days}d</span>
        </div>
      </div>
      <div class="fatigue-action">
        <i data-lucide="${a.status === 'danger' ? 'alert-triangle' : a.status === 'warning' ? 'eye' : 'check-circle'}"></i>
        <span>${a.action}</span>
      </div>
    </div>
  `).join('');

  lucide.createIcons({ nodes: [grid] });
}

function initFatigueChart() {
  const c = getChartColors();
  const ctx = document.getElementById('fatigueChart');
  if (!ctx) return;

  // Active ads CTR & frequency trend (last 7 days, real data 2026-03-10)
  const weeks = ['Mar 3', 'Mar 4', 'Mar 5', 'Mar 6', 'Mar 7', 'Mar 8', 'Mar 9'];
  const weeklyCtr = [9.25, 29.50, 14.13, 15.87, 19.45, 17.90, 22.60];
  const weeklyFreq = [1.11, 1.00, 1.21, 1.26, 1.12, 1.16, 1.14];

  fatigueChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: weeks,
      datasets: [
        {
          label: 'Avg CTR (%)',
          data: weeklyCtr,
          borderColor: '#4ade80',
          backgroundColor: 'rgba(74,222,128,0.1)',
          fill: true,
          tension: 0.4,
          yAxisID: 'y',
        },
        {
          label: 'Avg Frequency',
          data: weeklyFreq,
          borderColor: c.gold,
          borderDash: [5, 3],
          tension: 0.4,
          yAxisID: 'y1',
        }
      ]
    },
    options: {
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: { color: c.textFaint, usePointStyle: true, padding: 16 }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: c.textFaint } },
        y: {
          position: 'left',
          grid: { color: c.grid },
          ticks: { color: c.textFaint, callback: v => v + '%' },
          title: { display: true, text: 'CTR', color: c.textFaint }
        },
        y1: {
          position: 'right',
          grid: { display: false },
          ticks: { color: c.textFaint },
          title: { display: true, text: 'Frequency', color: c.textFaint }
        }
      }
    }
  });

  fatigueChartInitialized = true;
}

// ── Budget Charts ──
function initBudgetCharts() {
  const c = getChartColors();

  // Pie Chart — spend allocation by campaign
  const ctx1 = document.getElementById('budgetPieChart');
  if (ctx1) {
    budgetPieChart = new Chart(ctx1, {
      type: 'doughnut',
      data: {
        labels: campaigns.map(c => c.name),
        datasets: [{
          data: campaigns.map(c => c.spend),
          backgroundColor: ['#20808D', '#FFC553', '#A84B2F', '#944454'],
          borderWidth: 0,
        }]
      },
      options: {
        plugins: {
          legend: {
            display: true,
            position: 'right',
            labels: {
              color: c.textFaint,
              usePointStyle: true,
              padding: 12,
              font: { size: 11 }
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                return context.label + ': $' + context.raw.toFixed(2);
              }
            }
          }
        },
        cutout: '65%',
      }
    });
  }

  // Pace Chart — cumulative daily spend
  const ctx2 = document.getElementById('budgetPaceChart');
  if (ctx2) {
    const daysInPeriod = dailyData.length;
    const totalBudget = 110 * 38; // $110/day * ~38 day period
    const targetLine = dailyData.map((_, i) => (totalBudget / daysInPeriod) * (i + 1));
    
    let cumulative = 0;
    const actualCumulative = dailyData.map(d => {
      cumulative += d.spend;
      return cumulative;
    });

    budgetPaceChart = new Chart(ctx2, {
      type: 'line',
      data: {
        labels: dailyData.map(d => d.date),
        datasets: [
          {
            label: 'Target Pace',
            data: targetLine,
            borderColor: c.textFaint,
            borderDash: [5, 3],
            pointRadius: 0,
            borderWidth: 1.5,
          },
          {
            label: 'Actual Spend',
            data: actualCumulative,
            borderColor: c.primary,
            backgroundColor: c.primary + '20',
            fill: true,
            pointRadius: 0,
            borderWidth: 2,
            tension: 0.3,
          }
        ]
      },
      options: {
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: { color: c.textFaint, usePointStyle: true, padding: 16 }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: c.textFaint, maxTicksLimit: 10, maxRotation: 45 },
          },
          y: {
            grid: { color: c.grid },
            ticks: {
              color: c.textFaint,
              callback: v => '$' + (v / 1000).toFixed(1) + 'k'
            }
          }
        }
      }
    });
  }

  budgetChartsInitialized = true;
}

// ── Budget History (real reallocations) ──
const budgetHistory = [
  { time: '2h ago', from: '랜덤박스 캠페인', to: '판매 테스트', amount: '$14/day', reason: '0 purchases after $37 spend. Budget moved to main campaign.' },
  { time: '1d ago', from: '트래픽 테스트', to: '판매 테스트', amount: '$3.50/day', reason: 'Traffic campaign generated clicks but 0 purchases. Sales campaign performing at $16.72 CPA.' },
  { time: '3d ago', from: '판매 2번째 테스트', to: '판매 테스트', amount: '$50/day', reason: 'Second test had 3.41% CTR (vs 9.84% main). Only 38 clicks, 0 purchases.' },
  { time: '5d ago', from: 'Budget Pool', to: '판매 테스트', amount: '$110→$110/day', reason: 'Main campaign maintained at $110/day. Consistent purchase volume justifies current budget level.' },
];

function renderBudgetHistory() {
  const body = document.getElementById('budgetHistory');
  if (!body) return;

  body.innerHTML = budgetHistory.map(h => `
    <tr>
      <td>${h.time}</td>
      <td>${h.from}</td>
      <td>${h.to}</td>
      <td style="font-weight:600">${h.amount}</td>
      <td style="color:var(--color-text-muted)">${h.reason}</td>
    </tr>
  `).join('');
}

// ═══════════════════════════════════════════════════════
// ── OPTIMIZATION TIMELINE PAGE ──
// ═══════════════════════════════════════════════════════

// ── Candlestick Chart.js Plugin ──
const candlestickPlugin = {
  id: 'candlestick',
  beforeDatasetsDraw(chart) {
    // Only run on charts that have OHLC data (candlestick chart)
    const dataset = chart.data.datasets[0];
    if (!dataset || !dataset.data || !dataset.data.length) return;
    if (!dataset.data[0] || dataset.data[0].o === undefined) return;

    const meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data.length) return;
    const ctx = chart.ctx;
    const data = dataset.data;
    const yScale = chart.scales.y;

    meta.data.forEach((bar, i) => {
      const d = data[i];
      if (!d || d.o == null) return;
      const x = bar.x;
      const barW = Math.max(bar.width * 0.7, 6);
      const halfW = barW / 2;

      const oY = yScale.getPixelForValue(d.o);
      const cY = yScale.getPixelForValue(d.c);
      const hY = yScale.getPixelForValue(d.h);
      const lY = yScale.getPixelForValue(d.l);
      const isUp = d.c >= d.o;
      const color = isUp ? '#4ade80' : '#ef6461';

      ctx.save();
      // Wick (high-low line)
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.moveTo(x, hY);
      ctx.lineTo(x, lY);
      ctx.stroke();

      // Body (open-close rect)
      const top = Math.min(oY, cY);
      const bodyH = Math.max(Math.abs(oY - cY), 1);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x - halfW, top, barW, bodyH);
      ctx.globalAlpha = 1;
      ctx.restore();
    });
  },
  afterDatasetsDraw(chart) {
    // Draw Target CPA label on the dashed line
    const dataset = chart.data.datasets[0];
    if (!dataset || !dataset.data || !dataset.data.length) return;
    if (!dataset.data[0] || dataset.data[0].o === undefined) return;

    const ctx = chart.ctx;
    const y1Scale = chart.scales.y1;
    if (!y1Scale) return;

    // Find the Target CPA dataset (index 2)
    const targetDs = chart.data.datasets[2];
    if (!targetDs || !targetDs.data || !targetDs.data.length) return;
    const targetVal = targetDs.data[0];
    const yPos = y1Scale.getPixelForValue(targetVal);
    const chartArea = chart.chartArea;

    ctx.save();
    // Background pill for label
    const labelText = 'Target CAC ' + formatKRW(targetVal);
    ctx.font = "11px 'JetBrains Mono', monospace";
    const textW = ctx.measureText(labelText).width;
    const pillX = chartArea.right - textW - 16;
    const pillY = yPos - 10;
    ctx.fillStyle = 'rgba(239, 100, 97, 0.15)';
    ctx.roundRect(pillX - 4, pillY - 2, textW + 12, 16, 3);
    ctx.fill();
    ctx.fillStyle = '#ef6461';
    ctx.fillText(labelText, pillX + 2, pillY + 10);
    ctx.restore();
  }
};
Chart.register(candlestickPlugin);

// Static fallback: daily spend data with OHLC + CAC
// (replaced by live API data when available)
const staticSpendDaily = [
  { date: '2026-02-23', o: 85000, h: 92000, l: 78000, c: 89000, spend: 89000, cac: 42000, orders: 2 },
  { date: '2026-02-24', o: 89000, h: 95000, l: 82000, c: 84000, spend: 84000, cac: 38000, orders: 2 },
  { date: '2026-02-25', o: 84000, h: 98000, l: 80000, c: 95000, spend: 95000, cac: 45000, orders: 2 },
  { date: '2026-02-26', o: 95000, h: 105000, l: 88000, c: 92000, spend: 92000, cac: 40000, orders: 2 },
  { date: '2026-02-27', o: 92000, h: 110000, l: 85000, c: 108000, spend: 108000, cac: 48000, orders: 2 },
  { date: '2026-02-28', o: 108000, h: 115000, l: 90000, c: 96000, spend: 96000, cac: 44000, orders: 2 },
  { date: '2026-03-01', o: 96000, h: 102000, l: 82000, c: 88000, spend: 88000, cac: 41000, orders: 2 },
  { date: '2026-03-02', o: 88000, h: 100000, l: 78000, c: 97000, spend: 97000, cac: 43000, orders: 2 },
  { date: '2026-03-03', o: 97000, h: 108000, l: 90000, c: 103000, spend: 103000, cac: 46000, orders: 2 },
  { date: '2026-03-04', o: 103000, h: 112000, l: 95000, c: 99000, spend: 99000, cac: 42000, orders: 2 },
  { date: '2026-03-05', o: 99000, h: 106000, l: 85000, c: 87000, spend: 87000, cac: 39000, orders: 2 },
  { date: '2026-03-06', o: 87000, h: 95000, l: 80000, c: 93000, spend: 93000, cac: 44000, orders: 2 },
  { date: '2026-03-07', o: 93000, h: 100000, l: 88000, c: 91000, spend: 91000, cac: 41000, orders: 2 },
  { date: '2026-03-08', o: 91000, h: 98000, l: 82000, c: 86000, spend: 86000, cac: 38000, orders: 2 },
  { date: '2026-03-09', o: 86000, h: 105000, l: 83000, c: 102000, spend: 102000, cac: 45000, orders: 2 },
];

// Aggregate from static optimizations data (type + priority counts)
const staticOptCounts = {
  byType: { budget: 4, creative: 3, bid: 2, status: 3, schedule: 1, targeting: 1 },
  byPriority: { critical: 2, high: 5, medium: 4, low: 3 },
};

function formatKRW(val) {
  if (val >= 1000000) return '\u20a9' + (val / 1000000).toFixed(1) + 'M';
  if (val >= 1000) return '\u20a9' + (val / 1000).toFixed(0) + 'K';
  return '\u20a9' + val.toLocaleString();
}

function updateCandlestickStats(data) {
  const el = document.getElementById('candlestickStats');
  if (!el || !data.length) return;
  const totalSpend = data.reduce((s, d) => s + d.spend, 0);
  const peakDay = data.reduce((max, d) => d.spend > max.spend ? d : max, data[0]);
  const avgDaily = totalSpend / data.length;
  const avgCac = data.reduce((s, d) => s + d.cac, 0) / data.length;
  const peakDate = new Date(peakDay.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const vals = el.querySelectorAll('strong');
  if (vals.length >= 6) {
    vals[0].textContent = formatKRW(totalSpend);
    vals[1].textContent = formatKRW(peakDay.spend);
    vals[2].textContent = formatKRW(Math.round(avgDaily));
    vals[3].textContent = data.length.toString();
    vals[4].textContent = formatKRW(Math.round(avgCac));
    vals[5].textContent = peakDate;
  }
}

function initOptTimeline() {
  optTimelineInitialized = true;
  const c = getChartColors();
  const data = staticSpendDaily;
  const targetCPA = 45000; // Target CPA in KRW
  const budgetLine = 90000; // Daily budget target in KRW

  // Format date labels
  const labels = data.map(d => {
    const dt = new Date(d.date);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  // Prepare OHLC data for candlestick plugin
  const ohlcData = data.map(d => ({ o: d.o, h: d.h, l: d.l, c: d.c }));

  // Compute previous-day changes for tooltip
  const changes = data.map((d, i) => {
    if (i === 0) return { pct: 0, dir: '' };
    const prev = data[i - 1].spend;
    const pct = ((d.spend - prev) / prev * 100).toFixed(1);
    return { pct: Math.abs(pct), dir: d.spend >= prev ? '\u25b2' : '\u25bc' };
  });

  const tlCtx = document.getElementById('optTimelineChart');
  if (tlCtx) {
    optTimelineChart = new Chart(tlCtx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Spend',
            data: ohlcData,
            backgroundColor: 'transparent',
            borderColor: 'transparent',
            barPercentage: 0.6,
            categoryPercentage: 0.8,
            yAxisID: 'y',
            parsing: { yAxisKey: 'c' },
          },
          {
            label: 'CAC',
            data: data.map(d => d.cac),
            type: 'line',
            borderColor: '#38bdf8',
            backgroundColor: 'rgba(56, 189, 248, 0.08)',
            pointBackgroundColor: '#38bdf8',
            pointBorderColor: '#38bdf8',
            pointRadius: 4,
            pointHoverRadius: 6,
            borderWidth: 2,
            tension: 0.25,
            fill: false,
            yAxisID: 'y1',
          },
          {
            label: 'Target CPA',
            data: data.map(() => targetCPA),
            type: 'line',
            borderColor: '#ef6461',
            borderDash: [6, 4],
            borderWidth: 1.5,
            pointRadius: 0,
            pointHoverRadius: 0,
            fill: false,
            yAxisID: 'y1',
          },
          {
            label: 'Budget',
            data: data.map(() => budgetLine),
            type: 'line',
            borderColor: '#d4a44a',
            borderDash: [6, 4],
            borderWidth: 1.5,
            pointRadius: 0,
            pointHoverRadius: 0,
            fill: false,
            yAxisID: 'y',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(15, 15, 17, 0.95)',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
            titleFont: { size: 13, weight: 'bold', family: "'DM Sans', sans-serif" },
            bodyFont: { size: 12, family: "'JetBrains Mono', monospace" },
            padding: 14,
            cornerRadius: 6,
            displayColors: true,
            callbacks: {
              title: function(items) {
                const idx = items[0].dataIndex;
                const dt = new Date(data[idx].date);
                return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
              },
              label: function(ctx) {
                const idx = ctx.dataIndex;
                const d = data[idx];
                const ch = changes[idx];
                if (ctx.datasetIndex === 0) {
                  const lines = [];
                  lines.push('Spend:   ' + formatKRW(d.spend));
                  if (ch.dir) lines.push('Change:  ' + ch.dir + ' ' + ch.pct + '% vs prev day');
                  lines.push('Orders:  ' + d.orders);
                  lines.push('CAC:     ' + formatKRW(d.cac));
                  return lines;
                }
                if (ctx.datasetIndex === 1) return 'CAC: ' + formatKRW(d.cac);
                if (ctx.datasetIndex === 2) return 'Target CPA: ' + formatKRW(targetCPA);
                if (ctx.datasetIndex === 3) return 'Budget: ' + formatKRW(budgetLine);
                return '';
              },
              labelColor: function(ctx) {
                if (ctx.datasetIndex === 0) return { borderColor: '#8b8b94', backgroundColor: '#8b8b94' };
                if (ctx.datasetIndex === 1) return { borderColor: '#38bdf8', backgroundColor: '#38bdf8' };
                if (ctx.datasetIndex === 2) return { borderColor: '#ef6461', backgroundColor: '#ef6461' };
                if (ctx.datasetIndex === 3) return { borderColor: '#d4a44a', backgroundColor: '#d4a44a' };
                return { borderColor: '#fff', backgroundColor: '#fff' };
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              color: c.textFaint,
              font: { size: 10, family: "'JetBrains Mono', monospace" },
              maxRotation: 0,
            },
            border: { color: 'rgba(255,255,255,0.06)' },
          },
          y: {
            position: 'left',
            grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
            ticks: {
              color: c.textFaint,
              font: { size: 10, family: "'JetBrains Mono', monospace" },
              callback: v => formatKRW(v),
            },
            border: { display: false },
            min: 0,
          },
          y1: {
            position: 'right',
            grid: { display: false },
            ticks: {
              color: c.textFaint,
              font: { size: 10, family: "'JetBrains Mono', monospace" },
              callback: v => formatKRW(v),
            },
            border: { display: false },
            min: 0,
          },
        },
      },
    });
  }

  // Update summary stats bar
  updateCandlestickStats(data);

  // ── Type breakdown donut ──
  const typeCtx = document.getElementById('optTypeChart');
  if (typeCtx) {
    const types = staticOptCounts.byType;
    optTypeChart = new Chart(typeCtx, {
      type: 'doughnut',
      data: {
        labels: Object.keys(types).map(t => t.charAt(0).toUpperCase() + t.slice(1)),
        datasets: [{
          data: Object.values(types),
          backgroundColor: [
            '#20808D', // budget
            '#fb923c', // creative
            '#38bdf8', // bid
            '#ef4444', // status
            '#a78bfa', // schedule
            '#facc15', // targeting
          ],
          borderWidth: 0,
        }],
      },
      options: {
        plugins: {
          legend: {
            display: true,
            position: 'right',
            labels: { color: c.textFaint, usePointStyle: true, padding: 10, font: { size: 11 } },
          },
        },
        cutout: '60%',
      },
    });
  }

  // ── Priority breakdown donut ──
  const prioCtx = document.getElementById('optPriorityChart');
  if (prioCtx) {
    const prios = staticOptCounts.byPriority;
    const prioColors = {
      critical: '#ef4444',
      high: '#fb923c',
      medium: '#20808D',
      low: '#64748b',
    };
    optPriorityChart = new Chart(prioCtx, {
      type: 'doughnut',
      data: {
        labels: Object.keys(prios).map(p => p.charAt(0).toUpperCase() + p.slice(1)),
        datasets: [{
          data: Object.values(prios),
          backgroundColor: Object.keys(prios).map(p => prioColors[p] || '#94a3b8'),
          borderWidth: 0,
        }],
      },
      options: {
        plugins: {
          legend: {
            display: true,
            position: 'right',
            labels: { color: c.textFaint, usePointStyle: true, padding: 10, font: { size: 11 } },
          },
        },
        cutout: '60%',
      },
    });
  }
}

// ═══════════════════════════════════════════════════════
// ── ANALYTICS PAGE DATA & CHARTS ──
// ═══════════════════════════════════════════════════════

let analyticsChartsInitialized = false;
let profitTrendChart, weeklyProfitChart, weekdayChartInstance, hourChartInstance, weeklyCpaChartInstance, refundChartInstance;

// Daily profit data (revenue - ad spend - COGS)
const dailyProfit = [
  {date:'02/03',revenue:0,spend_krw:54447,cogs:0,profit:-54447},
  {date:'02/04',revenue:0,spend_krw:62263,cogs:0,profit:-62263},
  {date:'02/05',revenue:0,spend_krw:99746,cogs:0,profit:-99746},
  {date:'02/06',revenue:0,spend_krw:76110,cogs:0,profit:-76110},
  {date:'02/07',revenue:118000,spend_krw:59508,cogs:0,profit:58492},
  {date:'02/08',revenue:605550,spend_krw:77706,cogs:244000,profit:283844},
  {date:'02/09',revenue:149850,spend_krw:69136,cogs:140000,profit:-59286},
  {date:'02/10',revenue:180000,spend_krw:118074,cogs:120000,profit:-58074},
  {date:'02/11',revenue:386650,spend_krw:37526,cogs:114000,profit:235124},
  {date:'02/12',revenue:202800,spend_krw:51185,cogs:143000,profit:8615},
  {date:'02/13',revenue:0,spend_krw:42732,cogs:0,profit:-42732},
  {date:'02/14',revenue:714950,spend_krw:64264,cogs:389000,profit:261686},
  {date:'02/15',revenue:426998,spend_krw:86971,cogs:175000,profit:165027},
  {date:'02/16',revenue:186000,spend_krw:133661,cogs:242000,profit:-189661},
  {date:'02/17',revenue:739000,spend_krw:85942,cogs:228000,profit:425058},
  {date:'02/18',revenue:401650,spend_krw:75748,cogs:289000,profit:36902},
  {date:'02/19',revenue:62000,spend_krw:144623,cogs:27000,profit:-109623},
  {date:'02/20',revenue:325200,spend_krw:77038,cogs:175000,profit:73162},
  {date:'02/21',revenue:374850,spend_krw:85492,cogs:174000,profit:115358},
  {date:'02/22',revenue:709099,spend_krw:234175,cogs:250000,profit:224924},
  {date:'02/23',revenue:874374,spend_krw:348261,cogs:568000,profit:-41887},
  {date:'02/24',revenue:445731,spend_krw:242353,cogs:216000,profit:-12622},
  {date:'02/25',revenue:0,spend_krw:218167,cogs:0,profit:-218167},
  {date:'02/26',revenue:955632,spend_krw:183584,cogs:305000,profit:467048},
  {date:'02/27',revenue:1364858,spend_krw:159993,cogs:839000,profit:365865},
  {date:'02/28',revenue:755716,spend_krw:174232,cogs:246000,profit:335484},
  {date:'03/01',revenue:822069,spend_krw:180061,cogs:0,profit:642008},
  {date:'03/02',revenue:1404781,spend_krw:260638,cogs:0,profit:1144144},
  {date:'03/03',revenue:884295,spend_krw:351509,cogs:0,profit:532786},
  {date:'03/04',revenue:753221,spend_krw:248892,cogs:0,profit:504328},
  {date:'03/05',revenue:402431,spend_krw:185760,cogs:0,profit:216671},
  {date:'03/06',revenue:1267182,spend_krw:198824,cogs:0,profit:1068358},
  {date:'03/07',revenue:714765,spend_krw:191994,cogs:0,profit:522770},
  {date:'03/08',revenue:630317,spend_krw:219559,cogs:0,profit:410758},
  {date:'03/09',revenue:652514,spend_krw:150524,cogs:0,profit:501990},
  {date:'03/10',revenue:285000,spend_krw:67932,cogs:0,profit:217068},
];

// Weekly profit
const weeklyProfit = [
  {week:'W06 (Feb 3-9)',profit:49770},
  {week:'W07 (Feb 10-16)',profit:510361},
  {week:'W08 (Feb 17-23)',profit:576120},
  {week:'W09 (Feb 24-Mar 2)',profit:1537728},
  {week:'W10 (Mar 3-9)',profit:4399816},
  {week:'W11 (Mar 10)',profit:719057},
];

// Weekday performance (Meta Ads)
const weekdayPerf = [
  {day:'Mon',spend:663.60,purchases:47,cpa:14.12,ctr:10.28,impressions:64300,clicks:6612,avgSpend:132.72},
  {day:'Tue',spend:634.66,purchases:24,cpa:26.44,ctr:8.78,impressions:72269,clicks:6348,avgSpend:105.78},
  {day:'Wed',spend:443.17,purchases:14,cpa:31.65,ctr:9.98,impressions:44379,clicks:4428,avgSpend:88.63},
  {day:'Thu',spend:458.55,purchases:20,cpa:22.93,ctr:8.80,impressions:52148,clicks:4590,avgSpend:91.71},
  {day:'Fri',spend:382.55,purchases:22,cpa:17.39,ctr:10.24,impressions:37360,clicks:3827,avgSpend:76.51},
  {day:'Sat',spend:396.89,purchases:35,cpa:11.34,ctr:9.91,impressions:40061,clicks:3972,avgSpend:79.38},
  {day:'Sun',spend:550.67,purchases:45,cpa:12.24,ctr:10.30,impressions:53473,clicks:5507,avgSpend:110.13},
];

// Weekday revenue (Imweb)
const weekdayRevenue = [
  {day:'Mon',orders:54,paid:3371686,refunded:104167,net:3267519},
  {day:'Tue',orders:35,paid:2710026,refunded:176000,net:2534026},
  {day:'Wed',orders:24,paid:1866521,refunded:325000,net:1541521},
  {day:'Thu',orders:26,paid:1946680,refunded:323817,net:1622863},
  {day:'Fri',orders:46,paid:3297457,refunded:340217,net:2957240},
  {day:'Sat',orders:35,paid:3506464,refunded:828183,net:2678281},
  {day:'Sun',orders:45,paid:3771284,refunded:577251,net:3194033},
];

// Order hours (KST)
const hourlyOrders = [
  {hour:0,orders:9},{hour:1,orders:1},{hour:2,orders:4},{hour:3,orders:5},
  {hour:4,orders:0},{hour:5,orders:0},{hour:6,orders:4},{hour:7,orders:7},
  {hour:8,orders:12},{hour:9,orders:12},{hour:10,orders:11},{hour:11,orders:23},
  {hour:12,orders:15},{hour:13,orders:23},{hour:14,orders:18},{hour:15,orders:9},
  {hour:16,orders:8},{hour:17,orders:15},{hour:18,orders:10},{hour:19,orders:17},
  {hour:20,orders:15},{hour:21,orders:17},{hour:22,orders:7},{hour:23,orders:23},
];

// Weekly CPA for main campaign
const weeklyCpa = [
  {week:'W06',cpa:45.81,purchases:6,spend:274.88},
  {week:'W07',cpa:11.73,purchases:26,spend:304.94},
  {week:'W08',cpa:15.88,purchases:34,spend:539.99},
  {week:'W09',cpa:20.78,purchases:50,spend:1039.07},
  {week:'W10',cpa:15.87,purchases:72,spend:1142.88},
  {week:'W11',cpa:7.93,purchases:19,spend:150.66},
];

function initAnalyticsCharts() {
  analyticsChartsInitialized = true;
  const c = getChartColors();

  // ── Daily Profit Trend ──
  const profitCtx = document.getElementById('profitTrendChart');
  if (profitCtx) {
    let cumProfit = 0;
    const cumData = dailyProfit.map(d => { cumProfit += d.profit; return cumProfit; });

    profitTrendChart = new Chart(profitCtx, {
      type: 'bar',
      data: {
        labels: dailyProfit.map(d => d.date),
        datasets: [
          {
            label: 'Daily Profit (\u20a9)',
            data: dailyProfit.map(d => d.profit),
            backgroundColor: dailyProfit.map(d => d.profit >= 0 ? 'rgba(74, 222, 128, 0.7)' : 'rgba(239, 68, 68, 0.6)'),
            borderRadius: 3,
            order: 2,
          },
          {
            label: 'Cumulative Profit (\u20a9)',
            data: cumData,
            type: 'line',
            borderColor: c.gold,
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3,
            order: 1,
            yAxisID: 'y1',
          }
        ]
      },
      options: {
        plugins: {
          legend: { display: true, position: 'top', labels: { color: c.text, boxWidth: 12, padding: 16 } },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                return ctx.dataset.label + ': \u20a9' + ctx.parsed.y.toLocaleString();
              }
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: c.textFaint, maxRotation: 45, font: { size: 10 } } },
          y: { grid: { color: c.grid }, ticks: { color: c.textFaint, callback: v => '\u20a9' + (v/1000).toFixed(0) + 'K' } },
          y1: { position: 'right', grid: { display: false }, ticks: { color: c.gold, callback: v => '\u20a9' + (v/1000000).toFixed(1) + 'M' } },
        }
      }
    });
  }

  // ── Weekly Profit ──
  const wpCtx = document.getElementById('weeklyProfitChart');
  if (wpCtx) {
    weeklyProfitChart = new Chart(wpCtx, {
      type: 'bar',
      data: {
        labels: weeklyProfit.map(d => d.week),
        datasets: [{
          label: 'Weekly Profit (\u20a9)',
          data: weeklyProfit.map(d => d.profit),
          backgroundColor: weeklyProfit.map(d => d.profit >= 0 ? 'rgba(32, 128, 141, 0.8)' : 'rgba(239, 68, 68, 0.6)'),
          borderRadius: 6,
        }]
      },
      options: {
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => '\u20a9' + ctx.parsed.y.toLocaleString() } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: c.textFaint, font: { size: 10 } } },
          y: { grid: { color: c.grid }, ticks: { color: c.textFaint, callback: v => '\u20a9' + (v/1000000).toFixed(1) + 'M' } },
        }
      }
    });
  }

  // ── Weekday Ad Performance (grouped bar: CPA + Purchases) ──
  const wdCtx = document.getElementById('weekdayChart');
  if (wdCtx) {
    weekdayChartInstance = new Chart(wdCtx, {
      type: 'bar',
      data: {
        labels: weekdayPerf.map(d => d.day),
        datasets: [
          {
            label: 'Purchases',
            data: weekdayPerf.map(d => d.purchases),
            backgroundColor: 'rgba(74, 222, 128, 0.75)',
            borderRadius: 4,
            yAxisID: 'y',
          },
          {
            label: 'CPA ($)',
            data: weekdayPerf.map(d => d.cpa),
            type: 'line',
            borderColor: c.secondary,
            backgroundColor: 'transparent',
            borderWidth: 2.5,
            pointRadius: 5,
            pointBackgroundColor: c.secondary,
            tension: 0.3,
            yAxisID: 'y1',
          }
        ]
      },
      options: {
        plugins: {
          legend: { display: true, position: 'top', labels: { color: c.text, boxWidth: 12, padding: 16 } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: c.textFaint } },
          y: { title: { display: true, text: 'Purchases', color: c.textFaint }, grid: { color: c.grid }, ticks: { color: c.textFaint } },
          y1: { position: 'right', title: { display: true, text: 'CPA ($)', color: c.textFaint }, grid: { display: false }, ticks: { color: c.secondary, callback: v => '$' + v } },
        }
      }
    });
  }

  // ── Order Hour Distribution ──
  const hCtx = document.getElementById('hourChart');
  if (hCtx) {
    const peakHours = [11, 13, 23];
    hourChartInstance = new Chart(hCtx, {
      type: 'bar',
      data: {
        labels: hourlyOrders.map(d => d.hour + ':00'),
        datasets: [{
          label: 'Orders',
          data: hourlyOrders.map(d => d.orders),
          backgroundColor: hourlyOrders.map(d =>
            peakHours.includes(d.hour) ? 'rgba(255, 197, 83, 0.9)' : 'rgba(32, 128, 141, 0.6)'
          ),
          borderRadius: 3,
        }]
      },
      options: {
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { title: ctx => ctx[0].label + ' KST' } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: c.textFaint, font: { size: 9 }, maxRotation: 0 } },
          y: { grid: { color: c.grid }, ticks: { color: c.textFaint } },
        }
      }
    });
  }

  // ── Weekly CPA Trend ──
  const cpaCtx = document.getElementById('weeklyCpaChart');
  if (cpaCtx) {
    weeklyCpaChartInstance = new Chart(cpaCtx, {
      type: 'line',
      data: {
        labels: weeklyCpa.map(d => d.week),
        datasets: [
          {
            label: 'CPA ($)',
            data: weeklyCpa.map(d => d.cpa),
            borderColor: c.primary,
            backgroundColor: 'rgba(32, 128, 141, 0.1)',
            fill: true,
            borderWidth: 2.5,
            pointRadius: 6,
            pointBackgroundColor: weeklyCpa.map(d => d.cpa > 20 ? 'rgba(239, 68, 68, 0.9)' : c.primary),
            tension: 0.3,
            yAxisID: 'y',
          },
          {
            label: 'Purchases',
            data: weeklyCpa.map(d => d.purchases),
            type: 'bar',
            backgroundColor: 'rgba(74, 222, 128, 0.4)',
            borderRadius: 4,
            yAxisID: 'y1',
            order: 2,
          }
        ]
      },
      options: {
        plugins: {
          legend: { display: true, position: 'top', labels: { color: c.text, boxWidth: 12, padding: 16 } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: c.textFaint } },
          y: { title: { display: true, text: 'CPA ($)', color: c.textFaint }, grid: { color: c.grid }, ticks: { color: c.textFaint, callback: v => '$' + v } },
          y1: { position: 'right', title: { display: true, text: 'Purchases', color: c.textFaint }, grid: { display: false }, ticks: { color: c.textFaint } },
        }
      }
    });
  }

  // ── Monthly Refund Comparison ──
  const refCtx = document.getElementById('refundChart');
  if (refCtx) {
    refundChartInstance = new Chart(refCtx, {
      type: 'bar',
      data: {
        labels: ['February', 'March'],
        datasets: [
          {
            label: 'Revenue Collected (\u20a9)',
            data: [12237852, 8232266],
            backgroundColor: 'rgba(32, 128, 141, 0.8)',
            borderRadius: 4,
          },
          {
            label: 'Refunded (\u20a9)',
            data: [2258944, 415691],
            backgroundColor: 'rgba(239, 68, 68, 0.7)',
            borderRadius: 4,
          }
        ]
      },
      options: {
        plugins: {
          legend: { display: true, position: 'top', labels: { color: c.text, boxWidth: 12, padding: 16 } },
          tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': \u20a9' + ctx.parsed.y.toLocaleString() } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: c.textFaint } },
          y: { grid: { color: c.grid }, ticks: { color: c.textFaint, callback: v => '\u20a9' + (v/1000000).toFixed(1) + 'M' } },
        }
      }
    });
  }

  // ── Weekday Revenue Table ──
  renderWeekdayTable();
}

function renderWeekdayTable() {
  const body = document.getElementById('weekdayBody');
  if (!body) return;
  body.innerHTML = weekdayRevenue.map((d, i) => {
    const wp = weekdayPerf[i];
    const bestCpa = weekdayPerf.reduce((min, x) => x.cpa < min ? x.cpa : min, Infinity);
    const worstCpa = weekdayPerf.reduce((max, x) => x.cpa > max ? x.cpa : max, 0);
    const cpaBadge = wp.cpa <= bestCpa + 3 ? 'badge-success' : wp.cpa >= worstCpa - 3 ? 'badge-danger' : '';
    return `<tr>
      <td style="font-weight:600">${d.day}</td>
      <td>${d.orders}</td>
      <td>\u20a9${d.paid.toLocaleString()}</td>
      <td style="color:var(--color-danger)">\u20a9${d.refunded.toLocaleString()}</td>
      <td style="font-weight:600">\u20a9${d.net.toLocaleString()}</td>
      <td>$${wp.spend.toFixed(0)}</td>
      <td>${wp.purchases}</td>
      <td><span class="badge ${cpaBadge}">$${wp.cpa.toFixed(2)}</span></td>
    </tr>`;
  }).join('');
}

// ── Initialize Everything ──
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  animateKPIs();
  initCharts();
  renderActivities();
  renderCampaigns('all');
  renderOptimizations('all');
  renderFatigue();
  renderBudgetHistory();
});
