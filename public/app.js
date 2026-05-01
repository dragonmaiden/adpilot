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

function formatSignedChartKrw(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount === 0) return '₩0';
  const rounded = Math.round(amount);
  return `${rounded < 0 ? '-₩' : '₩'}${Math.abs(rounded).toLocaleString('en-US')}`;
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
    darkGreen: '#166534',
    darkGreenFill: 'rgba(22, 101, 52, 0.72)',
    netProfitBlue: '#2563EB',
    netProfitBlueFill: 'rgba(37, 99, 235, 0.72)',
    teal: '#1B474D',
    netProfitLine: '#111827',
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
  const allCharts = [spendRevenueChart, impactChart, roasChart, brandChart, hourChartInstance, profitWaterfallChart, netProfitChartInstance];
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
            backgroundColor: c.darkGreenFill,
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
            label: 'Net Revenue',
            data: [],
            backgroundColor: c.darkGreenFill,
            borderRadius: 3,
            stack: 'costs',
            order: 2,
            legendRank: 1,
            pointStyle: 'rectRounded',
          },
          {
            label: 'Total Costs',
            data: [],
            backgroundColor: 'rgba(185, 28, 28, 0.58)',
            borderRadius: 3,
            stack: 'deductions',
            order: 2,
            legendRank: 2,
            pointStyle: 'rectRounded',
          }
        ]
      },
      options: {
        maintainAspectRatio: false,
        layout: {
          padding: { top: 18 },
        },
        interaction: {
          mode: 'index',
          intersect: false,
        },
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
            mode: 'index',
            intersect: false,
            backgroundColor: '#111827',
            titleColor: '#ffffff',
            bodyColor: '#ffffff',
            borderColor: 'rgba(255, 255, 255, 0.18)',
            borderWidth: 1,
            padding: 10,
            displayColors: true,
            callbacks: {
              title: function(items) {
                return items?.[0]?.label || '';
              },
              label: function(ctx) {
                return `${ctx.dataset.label}: ${formatSignedChartKrw(ctx.parsed.y)}`;
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
let weekdayChartInstance, netProfitChartInstance;

function initAnalyticsCharts() {
  analyticsChartsInitialized = true;
  const c = getChartColors();
  const netProfitMarginLabelPlugin = {
    id: 'netProfitMarginLabelPlugin',
    afterDatasetsDraw(chart) {
      const dataset = chart.data?.datasets?.[0] || {};
      const margins = dataset.netProfitMargins || [];
      const values = dataset.data || [];
      const bars = chart.getDatasetMeta(0)?.data || [];
      if (bars.length === 0 || margins.length === 0) return;

      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.fillStyle = c.netProfitLine || '#111827';
      ctx.font = '600 11px IBM Plex Sans KR, Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';

      bars.forEach((bar, index) => {
        const margin = Number(margins[index]);
        if (!Number.isFinite(margin)) return;
        const value = Number(values[index] || 0);
        const label = `${Math.round(margin)}%`;
        const y = value < 0
          ? Math.min(bar.y + 8, chartArea.bottom - 12)
          : Math.max(bar.y - 6, chartArea.top + 14);
        ctx.textBaseline = value < 0 ? 'top' : 'bottom';
        ctx.strokeText(label, bar.x, y);
        ctx.fillText(label, bar.x, y);
      });

      ctx.restore();
    },
  };

  // ── Weekday Orders and Revenue (empty) ──
  const wdCtx = document.getElementById('weekdayChart');
  if (wdCtx) {
    weekdayChartInstance = new Chart(wdCtx, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Orders',
            data: [],
            backgroundColor: c.darkGreenFill,
            borderRadius: 4,
            yAxisID: 'y',
          },
          {
            label: 'Revenue (\u20a9)',
            data: [],
            type: 'line',
            borderColor: c.netProfitLine,
            backgroundColor: 'transparent',
            borderWidth: 2.5,
            pointRadius: 5,
            pointBackgroundColor: c.netProfitLine,
            tension: 0.3,
            yAxisID: 'y1',
          }
        ]
      },
      options: {
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: { display: true, position: 'top', labels: { color: c.text, boxWidth: 12, padding: 16 } },
          tooltip: {
            mode: 'index',
            intersect: false,
            callbacks: {
              label: ctx => ctx.dataset.type === 'line'
                ? `${ctx.dataset.label}: ${formatChartKrwTick(ctx.parsed.y)}`
                : `${ctx.dataset.label}: ${Number(ctx.parsed.y || 0).toLocaleString()}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: c.textFaint } },
          y: { title: { display: true, text: 'Orders', color: c.textFaint }, grid: { color: c.grid }, ticks: { color: c.textFaint } },
          y1: { position: 'right', title: { display: true, text: 'Revenue (\u20a9)', color: c.textFaint }, grid: { display: false }, ticks: { color: c.netProfitLine, callback: v => formatChartKrwTick(v) } },
        }
      }
    });
  }

  // ── Net Profit and Margin (empty) ──
  const netProfitCtx = document.getElementById('netProfitChart');
  if (netProfitCtx) {
    netProfitChartInstance = new Chart(netProfitCtx, {
      type: 'bar',
      plugins: [netProfitMarginLabelPlugin],
      data: {
        labels: [],
        datasets: [
          {
            label: 'Net Profit',
            data: [],
            backgroundColor: ctx => Number(ctx.raw || 0) < 0
              ? 'rgba(185, 28, 28, 0.58)'
              : c.netProfitBlueFill,
            borderRadius: 4,
            barPercentage: 0.62,
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
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => `Net Profit: ${formatSignedChartKrw(ctx.parsed.y)}`,
              afterBody: items => {
                if (!Array.isArray(items) || items.length === 0) return [];
                const index = items[0].dataIndex;
                const dataset = items[0].chart.data?.datasets?.[0] || {};
                const margin = Number(dataset.netProfitMargins?.[index]);
                const netRevenue = Number(dataset.netRevenue?.[index] || 0);
                return [
                  Number.isFinite(margin) ? `Margin: ${Math.round(margin)}%` : null,
                  `Net revenue: ${formatChartKrwTick(netRevenue)}`,
                ].filter(Boolean);
              },
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: c.textFaint } },
          y: {
            beginAtZero: true,
            grid: { color: c.grid },
            ticks: { color: c.textFaint, callback: v => formatSignedChartKrw(v) },
          },
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
