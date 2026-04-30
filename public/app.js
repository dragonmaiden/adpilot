/* ============================================
   AdPilot — Profit Dashboard
   Application Logic
   ============================================ */

// ── Page Navigation ──
const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.page');

navItems.forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const target = item.dataset.page;

    navItems.forEach(n => n.classList.remove('active'));
    item.classList.add('active');

    pages.forEach(p => p.classList.remove('active'));
    const targetPage = document.querySelector(`.page[data-page="${target}"]`);
    if (targetPage) targetPage.classList.add('active');

    if (target === 'analytics' && !analyticsChartsInitialized) initAnalyticsCharts();
    if (target === 'analytics' && !profitChartsInitialized) initProfitCharts();
    if (window.AdPilotLive) {
      window.AdPilotLive.handlePageActivated(target);
    }
  });
});

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

function formatChartKrwTick(value) {
  const amount = Number(value);
  return '₩' + (Number.isFinite(amount) ? Math.round(amount).toLocaleString('en-US') : '0');
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

let spendRevenueChart, impactChart, roasChart, brandChart, hourChartInstance;
let profitWaterfallChart;
let profitChartsInitialized = false;

function updateChartColors() {
  const c = getChartColors();
  const allCharts = [spendRevenueChart, impactChart, roasChart, brandChart, hourChartInstance, profitWaterfallChart];
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

// ── Main Charts — initialize with empty data; the live runtime populates them ──
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
              callback: v => formatChartKrwTick(v)
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

  // Overview daily profit chart (empty)
  const ctxBrand = document.getElementById('brandChart');
  if (ctxBrand) {
    brandChart = new Chart(ctxBrand, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Daily Profit (₩)',
          data: [],
          borderColor: '#4ade80',
          backgroundColor: 'rgba(74, 222, 128, 0.16)',
          fill: {
            target: 'origin',
            above: 'rgba(74, 222, 128, 0.16)',
            below: 'rgba(248, 113, 113, 0.14)',
          },
          tension: 0.35,
          pointRadius: 3,
          pointHoverRadius: 4,
          pointBackgroundColor: [],
          borderWidth: 2,
        }]
      },
      options: {
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                const value = Number(ctx.raw || 0);
                const prefix = value >= 0 ? '₩' : '-₩';
                return 'Profit: ' + prefix + Math.abs(Math.round(value)).toLocaleString();
              }
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: c.textFaint, maxRotation: 45 } },
          y: {
            grid: { color: c.grid },
            ticks: {
              color: c.textFaint,
              callback: v => formatChartKrwTick(v),
            },
          },
        },
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

  const hourCtx = document.getElementById('hourChart');
  if (hourCtx) {
    hourChartInstance = new Chart(hourCtx, {
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
}

// ═══════════════════════════════════════════════════════
// ── PROFIT ANALYSIS PAGE ──
// ═══════════════════════════════════════════════════════

function initProfitCharts() {
  profitChartsInitialized = true;
  const c = getChartColors();

  const ctx = document.getElementById('profitWaterfallChart');
  if (ctx) {
    profitWaterfallChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Gross Revenue',
            data: [],
            backgroundColor: 'rgba(22, 101, 52, 0.72)',
            borderRadius: 3,
            stack: 'costs',
            order: 2,
            legendRank: 1,
            pointStyle: 'rectRounded',
          },
          {
            label: 'Refunds',
            data: [],
            backgroundColor: 'rgba(248, 113, 113, 0.52)',
            borderRadius: 3,
            stack: 'deductions',
            order: 2,
            legendRank: 2,
            pointStyle: 'rectRounded',
          },
          {
            label: 'Total Costs',
            data: [],
            backgroundColor: 'rgba(185, 28, 28, 0.58)',
            borderRadius: 3,
            stack: 'deductions',
            order: 2,
            legendRank: 3,
            pointStyle: 'rectRounded',
          },
          {
            label: 'True Net Profit',
            data: [],
            type: 'line',
            borderColor: c.teal || '#1B474D',
            backgroundColor: 'transparent',
            borderWidth: 2.5,
            pointRadius: 3,
            pointBackgroundColor: [],
            pointBorderColor: '#fff',
            pointBorderWidth: 1,
            pointStyle: 'line',
            tension: 0.3,
            order: 1,
            legendRank: 4,
          }
        ]
      },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: {
              color: c.text,
              boxWidth: 12,
              padding: 12,
              usePointStyle: true,
              pointStyleWidth: 16,
              font: { size: 11 },
              sort: (a, b, data) => {
                const rankA = data.datasets[a.datasetIndex]?.legendRank || a.datasetIndex;
                const rankB = data.datasets[b.datasetIndex]?.legendRank || b.datasetIndex;
                return rankA - rankB;
              }
            }
          },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                const val = ctx.parsed.y;
                return ctx.dataset.label + ': \u20a9' + (val || 0).toLocaleString();
              },
              afterBody: function(items) {
                const item = items?.[0];
                if (!item?.chart) return '';
                const revenue = Number(item.chart.data.datasets?.[0]?.data?.[item.dataIndex] || 0);
                const refunded = Math.abs(Number(item.chart.data.datasets?.[1]?.data?.[item.dataIndex] || 0));
                if (revenue <= 0) return '';
                return `Refund rate: ${((refunded / revenue) * 100).toFixed(1)}%`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: c.textFaint, maxRotation: 45, font: { size: 10 } }
          },
          y: {
            grid: { color: c.grid },
            ticks: {
              color: c.textFaint,
              callback: v => formatChartKrwTick(v)
            }
          }
        }
      }
    });
  }

}

// ═══════════════════════════════════════════════════════
// ── ANALYTICS PAGE ──
// ═══════════════════════════════════════════════════════

let analyticsChartsInitialized = false;
let weekdayChartInstance, refundChartInstance;

function initAnalyticsCharts() {
  analyticsChartsInitialized = true;
  const c = getChartColors();
  const refundRateLabelPlugin = {
    id: 'refundRateLabelPlugin',
    afterDatasetsDraw(chart) {
      const revenue = chart.data?.datasets?.[0]?.data || [];
      const refunded = chart.data?.datasets?.[1]?.data || [];
      const bars = chart.getDatasetMeta(1)?.data || [];
      if (bars.length === 0) return;

      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.fillStyle = c.gold || '#FFC553';
      ctx.font = '600 11px IBM Plex Sans KR, Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';

      bars.forEach((bar, index) => {
        const revenueValue = Number(revenue[index] || 0);
        if (revenueValue <= 0) return;

        const refundedValue = Number(refunded[index] || 0);
        const rate = ((refundedValue / revenueValue) * 100).toFixed(1);
        const y = Math.max(bar.y - 6, chartArea.top + 14);
        ctx.fillText(`${rate}%`, bar.x, y);
      });

      ctx.restore();
    },
  };

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

  // ── Monthly Refund Comparison (empty) ──
  const refCtx = document.getElementById('refundChart');
  if (refCtx) {
    refundChartInstance = new Chart(refCtx, {
      type: 'bar',
      plugins: [refundRateLabelPlugin],
      data: {
        labels: [],
        datasets: [
          {
            label: 'Revenue Collected (\u20a9)',
            data: [],
            backgroundColor: 'rgba(32, 128, 141, 0.8)',
            borderRadius: 4,
            barPercentage: 0.58,
            categoryPercentage: 0.72,
          },
          {
            label: 'Refunded (\u20a9)',
            data: [],
            backgroundColor: 'rgba(239, 68, 68, 0.7)',
            borderRadius: 4,
            barPercentage: 0.58,
            categoryPercentage: 0.72,
          },
        ]
      },
      options: {
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: { display: true, position: 'top', labels: { color: c.text, boxWidth: 12, padding: 16 } },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.dataset.label}: \u20a9${Number(ctx.parsed.y || 0).toLocaleString()}`,
              afterBody: items => {
                if (!Array.isArray(items) || items.length === 0) return [];
                const index = items[0].dataIndex;
                const revenueValue = Number(items[0].chart.data?.datasets?.[0]?.data?.[index] || 0);
                const refundedValue = Number(items[0].chart.data?.datasets?.[1]?.data?.[index] || 0);
                if (revenueValue <= 0) return [];
                return [`Refund Rate: ${((refundedValue / revenueValue) * 100).toFixed(1)}%`];
              },
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: c.textFaint } },
          y: { grid: { color: c.grid }, ticks: { color: c.textFaint, callback: v => formatChartKrwTick(v) } },
        }
      }
    });
  }

}

// ── Initialize Everything ──
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  animateKPIs();
  initCharts();
  const activePage = document.querySelector('.page.active')?.dataset.page;
  if (activePage === 'analytics') {
    if (!analyticsChartsInitialized) initAnalyticsCharts();
    if (!profitChartsInitialized) initProfitCharts();
  }
});
