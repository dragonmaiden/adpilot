/* ============================================
   AdPilot — Meta Ads AI Agent Dashboard
   Application Logic
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

const pageTitleKeys = {
  overview: 'page.overview',
  analytics: 'page.analytics',
  campaigns: 'page.campaigns',
  optimizations: 'page.optimizations',
  fatigue: 'page.fatigue',
  budget: 'page.budget',
  settings: 'page.settings'
};

// Fallback for when i18n hasn't loaded yet
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

    if (pageTitle) {
      pageTitle.textContent = (typeof t === 'function' && pageTitleKeys[target])
        ? t(pageTitleKeys[target])
        : (pageTitles[target] || target);
    }

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
    if (!target || target === 0) return; // skip zero/empty targets
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

const USD_TO_KRW = 1450;

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

// ── Main Charts — initialize with empty data; live.js populates them ──
function initCharts() {
  const c = getChartColors();

  // Revenue vs Ad Spend chart (empty until API data arrives)
  const ctx1 = document.getElementById('spendRevenueChart');
  if (ctx1) {
    spendRevenueChart = new Chart(ctx1, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Revenue (₩)',
            data: [],
            backgroundColor: '#4ade80',
            borderRadius: 4,
            barPercentage: 0.7,
            categoryPercentage: 0.6,
            yAxisID: 'y',
          },
          {
            label: 'Ad Spend (₩)',
            data: [],
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

  // Daily ROAS chart (empty)
  const ctxRoas = document.getElementById('roasChart');
  if (ctxRoas) {
    roasChart = new Chart(ctxRoas, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'ROAS',
          data: [],
          borderColor: c.primary,
          backgroundColor: c.primary + '20',
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointBackgroundColor: [],
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

  // Brand revenue doughnut (empty)
  const ctxBrand = document.getElementById('brandChart');
  if (ctxBrand) {
    brandChart = new Chart(ctxBrand, {
      type: 'doughnut',
      data: {
        labels: [],
        datasets: [{
          data: [],
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

  // CTR & CPC Trend (empty)
  const ctx2 = document.getElementById('impactChart');
  if (ctx2) {
    impactChart = new Chart(ctx2, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'CTR (%)',
            data: [],
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
            data: [],
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

  // Sparklines — start empty; live.js will call createSparkline with real data
  // (no-op here — live.js handles populating them via updateOverviewKPIs)
}

// ── Activity Feed ──
function addActivity(act) {
  // No-op in live mode; live.js renders activities from API
  // Keep stub to avoid errors from any remaining callers
}

function renderActivities() {
  // No-op — live.js populates #activityFeed from API
}

// ── Campaign Table ──
function renderCampaigns() {
  // No-op in live mode — live.js handles via updateLiveCampaigns
}

const campaignFilter = document.getElementById('campaignFilter');
if (campaignFilter) {
  campaignFilter.addEventListener('change', () => {
    // In live mode, re-fetch from API
    if (typeof liveMode !== 'undefined' && liveMode && typeof updateLiveCampaigns === 'function') {
      updateLiveCampaigns();
    }
  });
}

// ── Optimization Log ──
function renderOptimizations() {
  // No-op in live mode — live.js handles via updateOptimizationLog
}

const optTypeFilter = document.getElementById('optTypeFilter');
if (optTypeFilter) {
  optTypeFilter.addEventListener('change', () => {
    if (typeof liveMode !== 'undefined' && liveMode && typeof updateOptimizationLog === 'function') {
      updateOptimizationLog();
    }
  });
}

// ── Fatigue Detection ──
function renderFatigue() {
  // No-op in live mode — live.js handles via updateFatiguePage
}

function initFatigueChart() {
  const c = getChartColors();
  const ctx = document.getElementById('fatigueChart');
  if (!ctx) return;

  // Initialize with empty data; live.js populates via updateFatiguePage
  fatigueChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Avg CTR (%)',
          data: [],
          borderColor: '#4ade80',
          backgroundColor: 'rgba(74,222,128,0.1)',
          fill: true,
          tension: 0.4,
          yAxisID: 'y',
        },
        {
          label: 'Avg Frequency',
          data: [],
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

  // Trigger live data population if live mode is already active
  if (typeof liveMode !== 'undefined' && liveMode && typeof updateFatiguePage === 'function') {
    updateFatiguePage();
  }
}

// ── Budget Charts — initialize with empty data ──
function initBudgetCharts() {
  const c = getChartColors();

  // Pie Chart — spend allocation by campaign (empty)
  const ctx1 = document.getElementById('budgetPieChart');
  if (ctx1) {
    budgetPieChart = new Chart(ctx1, {
      type: 'doughnut',
      data: {
        labels: [],
        datasets: [{
          data: [],
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

  // Pace Chart — cumulative daily spend (empty)
  const ctx2 = document.getElementById('budgetPaceChart');
  if (ctx2) {
    budgetPaceChart = new Chart(ctx2, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Target Pace',
            data: [],
            borderColor: c.textFaint,
            borderDash: [5, 3],
            pointRadius: 0,
            borderWidth: 1.5,
          },
          {
            label: 'Actual Spend',
            data: [],
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

  // Trigger live data population if live mode is already active
  if (typeof liveMode !== 'undefined' && liveMode && typeof updateBudgetPage === 'function') {
    updateBudgetPage();
  }
}

// ── Budget History ──
function renderBudgetHistory() {
  // No-op in live mode — live.js handles via updateBudgetPage
}

// ═══════════════════════════════════════════════════════
// ── OPTIMIZATION TIMELINE PAGE ──
// ═══════════════════════════════════════════════════════

// ── Candlestick drawing via Chart.js plugin ──
// Stores OHLC data externally so plugin can draw candles independently of datasets
let _candlestickOHLC = [];

const candlestickPlugin = {
  id: 'candlestick',
  afterDatasetsDraw(chart) {
    if (!_candlestickOHLC.length) return;
    // Only draw on the candlestick chart (optTimelineChart)
    if (chart.canvas.id !== 'optTimelineChart') return;
    const xScale = chart.scales.x;
    const yScale = chart.scales.y;
    if (!xScale || !yScale) return;

    const ctx = chart.ctx;
    const chartArea = chart.chartArea;
    const totalBars = _candlestickOHLC.length;
    // Calculate bar width from chart area
    const availableWidth = chartArea.right - chartArea.left;
    const barW = Math.max(Math.floor((availableWidth / totalBars) * 0.45), 4);
    const halfW = barW / 2;

    _candlestickOHLC.forEach((d, i) => {
      if (!d || d.o == null) return;
      // Get the x pixel from the category scale
      const x = xScale.getPixelForValue(i);
      const oY = yScale.getPixelForValue(d.o);
      const cY = yScale.getPixelForValue(d.c);
      const hY = yScale.getPixelForValue(d.h);
      const lY = yScale.getPixelForValue(d.l);
      const isUp = d.c >= d.o;
      const color = isUp ? '#4ade80' : '#ef6461';

      ctx.save();
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.moveTo(x, hY);
      ctx.lineTo(x, lY);
      ctx.stroke();

      const top = Math.min(oY, cY);
      const bodyH = Math.max(Math.abs(oY - cY), 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x - halfW, top, barW, bodyH);
      ctx.globalAlpha = 1;
      ctx.restore();
    });

    // Draw Target CPA label pill
    const y1Scale = chart.scales.y1;
    if (y1Scale) {
      const targetDs = chart.data.datasets[2];
      if (targetDs && targetDs.data && targetDs.data.length) {
        const targetVal = targetDs.data[0];
        const yPos = y1Scale.getPixelForValue(targetVal);
        ctx.save();
        const labelText = 'Target CAC ' + formatKRW(targetVal);
        ctx.font = "11px 'JetBrains Mono', monospace";
        const textW = ctx.measureText(labelText).width;
        const pillX = chartArea.right - textW - 16;
        const pillY = yPos - 10;
        ctx.fillStyle = 'rgba(239, 100, 97, 0.2)';
        if (ctx.roundRect) {
          ctx.beginPath();
          ctx.roundRect(pillX - 4, pillY - 2, textW + 12, 16, 3);
          ctx.fill();
        } else {
          ctx.fillRect(pillX - 4, pillY - 2, textW + 12, 16);
        }
        ctx.fillStyle = '#ef6461';
        ctx.fillText(labelText, pillX + 2, pillY + 10);
        ctx.restore();
      }
    }
  }
};
Chart.register(candlestickPlugin);

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

// Shared ref for tooltip data so closures can access updated data
let _candlestickData = [];
let _candlestickChanges = [];

async function initOptTimeline() {
  optTimelineInitialized = true;
  const c = getChartColors();
  const targetCPA = 45000; // KRW
  const budgetLine = 90000; // KRW

  // Fetch real data from API (full history)
  let data = [];
  try {
    const resp = await fetch('/api/spend-daily');
    data = await resp.json();
  } catch (e) {
    console.warn('Failed to fetch spend-daily, chart will be empty until next scan');
  }
  if (!data || data.length === 0) {
    // Show empty state message
    const el = document.getElementById('optTimelineChart');
    if (el && el.parentNode) {
      el.parentNode.innerHTML = '<p style="text-align:center;color:var(--color-text-faint);padding:60px 0;font-size:0.85rem">Waiting for first scan to collect spend data...</p>';
    }
    return;
  }

  _candlestickData = data;

  // Store OHLC for the plugin to draw
  _candlestickOHLC = data.map(d => ({ o: d.o, h: d.h, l: d.l, c: d.c }));

  const labels = data.map(d => {
    const dt = new Date(d.date);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  // Compute previous-day changes for tooltip (stored in shared ref)
  _candlestickChanges = data.map((d, i) => {
    if (i === 0) return { pct: 0, dir: '' };
    const prev = data[i - 1].spend;
    const pct = ((d.spend - prev) / prev * 100).toFixed(1);
    return { pct: Math.abs(pct), dir: d.spend >= prev ? '\u25b2' : '\u25bc' };
  });

  // Y-axis range for spend: we want candles to fill most of the chart
  const allVals = data.flatMap(d => [d.o, d.h, d.l, d.c]);
  const minSpend = Math.min(...allVals);
  const maxSpend = Math.max(...allVals);
  const spendPad = (maxSpend - minSpend) * 0.15;
  const yMin = Math.max(0, minSpend - spendPad * 2);
  const yMax = maxSpend + spendPad;

  const tlCtx = document.getElementById('optTimelineChart');
  if (tlCtx) {
    optTimelineChart = new Chart(tlCtx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            // Hidden dataset just for Spend tooltip — candles drawn by plugin
            label: 'Spend',
            data: data.map(d => d.c),
            borderColor: 'transparent',
            backgroundColor: 'transparent',
            pointRadius: 0,
            pointHitRadius: 15,
            yAxisID: 'y',
            fill: false,
          },
          {
            label: 'CAC',
            data: data.map(d => d.cac),
            borderColor: '#38bdf8',
            backgroundColor: 'rgba(56, 189, 248, 0.08)',
            pointBackgroundColor: '#38bdf8',
            pointBorderColor: '#38bdf8',
            pointRadius: 4,
            pointHoverRadius: 6,
            borderWidth: 2,
            tension: 0.3,
            fill: false,
            yAxisID: 'y1',
          },
          {
            label: 'Target CPA',
            data: data.map(() => targetCPA),
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
            borderColor: 'rgba(255,255,255,0.12)',
            borderWidth: 1,
            titleFont: { size: 13, weight: 'bold', family: "'DM Sans', sans-serif" },
            bodyFont: { size: 12, family: "'JetBrains Mono', monospace" },
            bodySpacing: 6,
            padding: 14,
            cornerRadius: 6,
            displayColors: true,
            callbacks: {
              title: function(items) {
                const idx = items[0].dataIndex;
                if (!_candlestickData[idx]) return '';
                const dt = new Date(_candlestickData[idx].date);
                return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
              },
              label: function(ctx) {
                const idx = ctx.dataIndex;
                const d = _candlestickData[idx];
                if (!d) return '';
                const ch = _candlestickChanges[idx] || { pct: 0, dir: '' };
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
            min: yMin,
            max: yMax,
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
          },
        },
      },
    });
  }

  // Update summary stats bar
  updateCandlestickStats(data);

  // ── Type breakdown donut (empty — live.js populates via updateOptTimeline) ──
  const typeCtx = document.getElementById('optTypeChart');
  if (typeCtx) {
    optTypeChart = new Chart(typeCtx, {
      type: 'doughnut',
      data: {
        labels: [],
        datasets: [{
          data: [],
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

  // ── Priority breakdown donut (empty — live.js populates) ──
  const prioCtx = document.getElementById('optPriorityChart');
  if (prioCtx) {
    const prioColors = {
      critical: '#ef4444',
      high: '#fb923c',
      medium: '#20808D',
      low: '#64748b',
    };
    optPriorityChart = new Chart(prioCtx, {
      type: 'doughnut',
      data: {
        labels: [],
        datasets: [{
          data: [],
          backgroundColor: [],
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
    // Store prioColors on chart for live.js to access
    optPriorityChart._prioColors = prioColors;
  }

  // Trigger live timeline data now that chart exists
  if (typeof liveMode !== 'undefined' && liveMode && typeof updateOptTimeline === 'function') {
    updateOptTimeline();
  }
}

// ═══════════════════════════════════════════════════════
// ── ANALYTICS PAGE ──
// ═══════════════════════════════════════════════════════

let analyticsChartsInitialized = false;
let profitTrendChart, weeklyProfitChart, weekdayChartInstance, hourChartInstance, weeklyCpaChartInstance, refundChartInstance;

function initAnalyticsCharts() {
  analyticsChartsInitialized = true;
  const c = getChartColors();

  // ── Daily Profit Trend (empty) ──
  const profitCtx = document.getElementById('profitTrendChart');
  if (profitCtx) {
    profitTrendChart = new Chart(profitCtx, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Daily Profit (\u20a9)',
            data: [],
            backgroundColor: [],
            borderRadius: 3,
            order: 2,
          },
          {
            label: 'Cumulative Profit (\u20a9)',
            data: [],
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

  // ── Weekly Profit (empty) ──
  const wpCtx = document.getElementById('weeklyProfitChart');
  if (wpCtx) {
    weeklyProfitChart = new Chart(wpCtx, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [{
          label: 'Weekly Profit (\u20a9)',
          data: [],
          backgroundColor: [],
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

  // ── Weekday Ad Performance (empty) ──
  const wdCtx = document.getElementById('weekdayChart');
  if (wdCtx) {
    weekdayChartInstance = new Chart(wdCtx, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Purchases',
            data: [],
            backgroundColor: 'rgba(74, 222, 128, 0.75)',
            borderRadius: 4,
            yAxisID: 'y',
          },
          {
            label: 'CPA ($)',
            data: [],
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

  // ── Order Hour Distribution (empty) ──
  const hCtx = document.getElementById('hourChart');
  if (hCtx) {
    hourChartInstance = new Chart(hCtx, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [{
          label: 'Orders',
          data: [],
          backgroundColor: [],
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

  // ── Weekly CPA Trend (empty) ──
  const cpaCtx = document.getElementById('weeklyCpaChart');
  if (cpaCtx) {
    weeklyCpaChartInstance = new Chart(cpaCtx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'CPA ($)',
            data: [],
            borderColor: c.primary,
            backgroundColor: 'rgba(32, 128, 141, 0.1)',
            fill: true,
            borderWidth: 2.5,
            pointRadius: 6,
            pointBackgroundColor: [],
            tension: 0.3,
            yAxisID: 'y',
          },
          {
            label: 'Purchases',
            data: [],
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

  // ── Monthly Refund Comparison (empty) ──
  const refCtx = document.getElementById('refundChart');
  if (refCtx) {
    refundChartInstance = new Chart(refCtx, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Revenue Collected (\u20a9)',
            data: [],
            backgroundColor: 'rgba(32, 128, 141, 0.8)',
            borderRadius: 4,
          },
          {
            label: 'Refunded (\u20a9)',
            data: [],
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

  // Trigger live data population if already in live mode
  if (typeof liveMode !== 'undefined' && liveMode && typeof updateAnalyticsPage === 'function') {
    updateAnalyticsPage();
  }
}

function renderWeekdayTable() {
  // No-op stub — live.js populates the weekday table via updateAnalyticsPage
}

// ── Initialize Everything ──
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  animateKPIs();
  initCharts();
});
