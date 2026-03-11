/* ============================================
   AdPilot — Live Data Layer
   Connects dashboard to backend API
   ============================================ */

const API_BASE = window.location.origin + '/api';
const KST_TIME_ZONE = 'Asia/Seoul';
let pollInterval = null;
let liveMode = false;
let apiKeyPrompted = false;

const SAFE_OPT_TYPES = new Set(['budget', 'bid', 'creative', 'status', 'schedule', 'targeting']);
const SAFE_CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low']);

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function getApiKey() {
  return (sessionStorage.getItem('adpilot_key') || '').trim();
}

function promptForApiKey() {
  if (apiKeyPrompted) return;
  apiKeyPrompted = true;

  const key = window.prompt('Enter your AdPilot API key:');
  const trimmed = key ? key.trim() : '';
  if (trimmed) {
    sessionStorage.setItem('adpilot_key', trimmed);
    window.location.reload();
  }
}

function safeOptType(type) {
  return SAFE_OPT_TYPES.has(type) ? type : 'bid';
}

function safeConfidenceLevel(level) {
  return SAFE_CONFIDENCE_LEVELS.has(level) ? level : 'low';
}

function formatOptimizationScope(level) {
  const labels = {
    account: 'Account',
    campaign: 'Campaign',
    adset: 'Ad Set',
    ad: 'Ad',
  };
  return labels[level] || '—';
}

function formatSignedKrw(value) {
  const amount = Number.isFinite(value) ? value : 0;
  return amount >= 0
    ? '₩' + Math.round(amount).toLocaleString()
    : '-₩' + Math.abs(Math.round(amount)).toLocaleString();
}

function formatSignedCompactKrw(value) {
  const amount = Number.isFinite(value) ? value : 0;
  return amount >= 0
    ? formatKRW(amount)
    : '-' + formatKRW(Math.abs(amount));
}

function formatKrw(value) {
  const amount = Number.isFinite(value) ? value : 0;
  return '₩' + Math.round(amount).toLocaleString();
}

function formatUsd(value, digits = 0) {
  const amount = Number.isFinite(value) ? value : 0;
  return '$' + amount.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatPercent(value, digits = 1) {
  const amount = Number.isFinite(value) ? value : 0;
  return amount.toFixed(digits) + '%';
}

function formatCount(value) {
  const amount = Number.isFinite(value) ? value : 0;
  return amount.toLocaleString();
}

function formatRateMetricDetail(metric, fallback) {
  if (!metric || metric.numerator == null || metric.denominator == null) {
    return fallback;
  }

  if (metric.unit === 'currency') {
    return `${formatKRW(metric.numerator)} of ${formatKRW(metric.denominator)}`;
  }

  if (metric.unit === 'sections') {
    return `${metric.numerator} ${metric.numeratorLabel || 'cancelled'} of ${metric.denominator} ${metric.denominatorLabel || 'sections'}`;
  }

  return fallback;
}

function formatImwebAuthSource(source) {
  const labels = {
    none: 'No token loaded',
    disk: 'Persisted token file',
    env: 'Environment refresh token',
    seed: 'Manual seed token',
  };
  return labels[source] || source || '—';
}

function formatImwebAuthStatus(status) {
  const map = {
    connected: { text: 'Connected', badge: 'badge-success' },
    degraded: { text: 'Degraded', badge: 'badge-warning' },
    error: { text: 'Auth Error', badge: 'badge-error' },
    refresh_only: { text: 'Needs Refresh', badge: 'badge-warning' },
    access_only: { text: 'Token Loaded', badge: 'badge-warning' },
    misconfigured: { text: 'Misconfigured', badge: 'badge-danger' },
    missing: { text: 'Missing Token', badge: 'badge-neutral' },
  };
  return map[status] || { text: status || 'Unknown', badge: 'badge-neutral' };
}

function formatImwebExpiry(expiresAt) {
  if (!expiresAt) return '—';
  const dt = new Date(expiresAt);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function isIsoDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function getKstDateKey() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: KST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(new Date());
  const values = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }
  return `${values.year}-${values.month}-${values.day}`;
}

function toUtcDate(dateKey) {
  if (!isIsoDateKey(dateKey)) return null;
  const [year, month, day] = String(dateKey).split('-').map(value => Number.parseInt(value, 10));
  return new Date(Date.UTC(year, month - 1, day));
}

function fromUtcDate(date) {
  return date instanceof Date && !Number.isNaN(date.getTime())
    ? date.toISOString().slice(0, 10)
    : null;
}

function compareDateKeys(left, right) {
  return String(left || '').localeCompare(String(right || ''));
}

function getCalendarMonthStart(dateKey) {
  const date = toUtcDate(dateKey);
  if (!date) return null;
  date.setUTCDate(1);
  return fromUtcDate(date);
}

function getCalendarMonthEnd(dateKey) {
  const date = toUtcDate(dateKey);
  if (!date) return null;
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return fromUtcDate(date);
}

function shiftCalendarMonth(dateKey, deltaMonths) {
  const date = toUtcDate(dateKey);
  if (!date) return null;

  const day = date.getUTCDate();
  const shifted = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + deltaMonths, 1));
  const lastDay = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
  shifted.setUTCDate(Math.min(day, lastDay));
  return fromUtcDate(shifted);
}

function clampDateKey(dateKey, min, max) {
  if (!isIsoDateKey(dateKey)) return min;
  if (compareDateKeys(dateKey, min) < 0) return min;
  if (compareDateKeys(dateKey, max) > 0) return max;
  return dateKey;
}

function enumerateDateKeys(start, end) {
  const dates = [];
  let cursor = start;
  while (cursor && compareDateKeys(cursor, end) <= 0) {
    dates.push(cursor);
    const current = toUtcDate(cursor);
    current.setUTCDate(current.getUTCDate() + 1);
    cursor = fromUtcDate(current);
  }
  return dates;
}

function getCalendarWeekday(dateKey) {
  const date = toUtcDate(dateKey);
  return date ? (date.getUTCDay() + 6) % 7 : 0;
}

function formatUtcDate(dateKey, options) {
  const date = toUtcDate(dateKey);
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    ...options,
  }).format(date);
}

function formatCalendarRange(start, end) {
  if (!start || !end) return 'Selected range';
  if (start === end) {
    return formatUtcDate(start, { month: 'long', day: 'numeric', year: 'numeric' });
  }
  return `${formatUtcDate(start, { month: 'short', day: 'numeric' })} – ${formatUtcDate(end, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function formatKstTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    timeZone: KST_TIME_ZONE,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function humanizeEnum(value) {
  return String(value || '—')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function getActiveDashboardPage() {
  return document.querySelector('.page.active')?.dataset.page || 'overview';
}

const calendarState = {
  initialized: false,
  anchorMonth: null,
  selectionStart: null,
  selectionEnd: null,
  data: null,
  loading: false,
  requestId: 0,
  dragging: false,
  dragStart: null,
  didDrag: false,
};

const SERIES_WINDOW_OPTIONS = Object.freeze({
  '14d': { label: '14D', days: 14 },
  '30d': { label: '30D', days: 30 },
  all: { label: 'All', days: null },
});

const DEFAULT_SERIES_WINDOWS = Object.freeze({
  overview: '30d',
  'profit-structure': '30d',
  'media-profitability': '30d',
  'revenue-quality': 'all',
});

const seriesWindowState = { ...DEFAULT_SERIES_WINDOWS };
const seriesWindowRefreshers = new Map();

function summarizeBy(values, selector) {
  return (Array.isArray(values) ? values : []).reduce((summary, value) => {
    const key = selector(value);
    summary[key] = (summary[key] || 0) + 1;
    return summary;
  }, {});
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getSeriesWindowMeta(group) {
  const selectedKey = seriesWindowState[group] || DEFAULT_SERIES_WINDOWS[group] || 'all';
  return {
    key: selectedKey,
    ...(SERIES_WINDOW_OPTIONS[selectedKey] || SERIES_WINDOW_OPTIONS.all),
  };
}

function sortRowsByDate(rows, dateKey = 'date') {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row && row[dateKey])
    .slice()
    .sort((left, right) => String(left[dateKey]).localeCompare(String(right[dateKey])));
}

function sliceRowsByWindow(rows, group, dateKey = 'date') {
  const sorted = sortRowsByDate(rows, dateKey);
  const { days } = getSeriesWindowMeta(group);
  if (!days || sorted.length <= days) {
    return sorted;
  }
  return sorted.slice(-days);
}

function updateSeriesWindowBadges(group, rows) {
  const label = rows.length > 0 ? `(${rows.length}d)` : '(—)';
  document.querySelectorAll(`[data-series-window-badge="${group}"]`).forEach(el => {
    el.textContent = label;
  });
}

function syncSeriesWindowControls() {
  document.querySelectorAll('[data-series-window-group]').forEach(groupEl => {
    const group = groupEl.dataset.seriesWindowGroup;
    const activeValue = getSeriesWindowMeta(group).key;
    groupEl.querySelectorAll('[data-series-window-value]').forEach(button => {
      const isActive = button.dataset.seriesWindowValue === activeValue;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  });
}

function registerSeriesWindowRefresher(group, refresher) {
  if (typeof refresher === 'function') {
    seriesWindowRefreshers.set(group, refresher);
  }
}

async function refreshSeriesWindowGroup(group) {
  const refresher = seriesWindowRefreshers.get(group);
  if (typeof refresher === 'function') {
    await refresher();
  }
}

function initSeriesWindowControls() {
  if (document.body.dataset.seriesWindowControlsReady === 'true') {
    return;
  }

  document.body.dataset.seriesWindowControlsReady = 'true';
  syncSeriesWindowControls();

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-series-window-value]');
    if (!button) return;

    const groupEl = button.closest('[data-series-window-group]');
    const group = groupEl?.dataset.seriesWindowGroup;
    const nextValue = button.dataset.seriesWindowValue;
    if (!group || !SERIES_WINDOW_OPTIONS[nextValue]) return;
    if (seriesWindowState[group] === nextValue) return;

    seriesWindowState[group] = nextValue;
    syncSeriesWindowControls();
    await refreshSeriesWindowGroup(group);
  });
}

function buildReconciliationOverlap(dailyRows, matches, unmatchedSettlements, unmatchedImwebPayments) {
  const mismatchMatches = matches.filter(match => match.methodMismatch);
  return {
    matchedCount: matches.length,
    netAmount: dailyRows.reduce((sum, day) => sum + toFiniteNumber(day.matched?.netAmount), 0),
    methodMismatchCount: mismatchMatches.length,
    methodMismatchAmount: mismatchMatches.reduce((sum, match) => sum + toFiniteNumber(match.amount), 0),
    confidence: summarizeBy(matches, match => match.confidence || 'low'),
    unmatchedSettlementCount: unmatchedSettlements.length,
    unmatchedImwebCount: unmatchedImwebPayments.length,
  };
}

function buildVisibleReconciliationReport(report, group) {
  const daily = sliceRowsByWindow(report?.daily || [], group);
  const visibleDates = new Set(daily.map(day => day.date));
  const matches = (report?.matches || []).filter(match =>
    visibleDates.has(match?.settlement?.tradedDate || match?.imwebPayment?.completedDate)
  );
  const unmatchedSettlements = (report?.unmatchedSettlements || []).filter(item => visibleDates.has(item?.tradedDate));
  const unmatchedImwebPayments = (report?.unmatchedImwebPayments || []).filter(item => visibleDates.has(item?.completedDate));

  return {
    ...report,
    daily,
    summary: {
      ...(report?.summary || {}),
      overlap: buildReconciliationOverlap(daily, matches, unmatchedSettlements, unmatchedImwebPayments),
    },
    matches,
    unmatchedSettlements,
    unmatchedImwebPayments,
  };
}

// ── API Helper ──
async function api(path, method = 'GET', body = null) {
  try {
    const key = getApiKey();
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API_BASE}${path}`, opts);
    if (res.status === 401) {
      sessionStorage.removeItem('adpilot_key');
      promptForApiKey();
      return null;
    }
    if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
    return res.json();
  } catch (err) {
    console.warn(`[LIVE] API error on ${path}:`, err.message);
    return null;
  }
}

// ═══════════════════════════════════════════
// LIVE DATA POLLING
// ═══════════════════════════════════════════

async function checkBackendAvailable() {
  const health = await api('/health');
  return health && health.status === 'ok';
}

async function fetchOverview() {
  const data = await api('/overview');
  if (!data || !data.ready) return null;
  return data;
}

async function fetchOptimizations(limit = 50) {
  return api(`/optimizations?limit=${limit}`);
}

async function fetchScans() {
  return api('/scans');
}

async function fetchAnalytics() {
  return api('/analytics');
}

async function fetchCalendarAnalysis(params) {
  const search = new URLSearchParams(params || {});
  return api(`/calendar-analysis?${search.toString()}`);
}

async function fetchCampaigns() {
  return api('/campaigns');
}

async function fetchPostmortem() {
  return api('/postmortem');
}

async function fetchSettings() {
  return api('/settings');
}

async function fetchReconciliation() {
  return api('/reconciliation');
}

// ── Write operations ──
async function triggerScan() {
  return api('/scan', 'POST');
}

async function updateCampaignStatus(campaignId, status) {
  return api(`/campaigns/${campaignId}/status`, 'POST', { status });
}

async function updateCampaignBudget(campaignId, dailyBudget) {
  return api(`/campaigns/${campaignId}/budget`, 'POST', { dailyBudget });
}

async function executeOptimization(optId) {
  return api(`/optimizations/${optId}/execute`, 'POST');
}

async function updateSettings(settings) {
  return api('/settings', 'PUT', settings);
}

// ═══════════════════════════════════════════
// DATA TRANSFORMATION HELPERS
// ═══════════════════════════════════════════
// The API provides canonical chart arrays. The client only applies
// reusable date-window filtering and lightweight rollups for the UI.

// ═══════════════════════════════════════════
// UPDATE DASHBOARD WITH LIVE DATA
// ═══════════════════════════════════════════

// ── Overview KPIs + Charts ──
// ── Overview KPIs + Charts + Scan state ──
async function updateOverviewKPIs() {
  try {
    const [data, analyticsData] = await Promise.all([
      fetchOverview(),
      fetchAnalytics(),
    ]);
    if (!data) return;

    const k = data.kpis;

    // ── KPI Card 1: Revenue (Imweb) ──
    const revenueEl = document.querySelector('[data-kpi="revenue"] .kpi-value');
    if (revenueEl) {
      revenueEl.dataset.target = Math.round(k.revenue || 0);
      revenueEl.dataset.prefix = '₩';
      revenueEl.textContent = '₩' + Math.round(k.revenue || 0).toLocaleString();
    }
    const revenueSubEl = document.querySelector('[data-kpi="revenue"] .kpi-delta span');
    if (revenueSubEl) {
      const orders = k.totalOrders || 0;
      const aov = Math.round(k.aov || 0);
      revenueSubEl.textContent = orders + ' orders · ₩' + aov.toLocaleString() + ' AOV';
    }

    // ── KPI Card 2: COGS ──
    const cogsEl = document.querySelector('[data-kpi="cogs"] .kpi-value');
    if (cogsEl) {
      cogsEl.textContent = k.cogs != null ? '₩' + Math.round(k.cogs).toLocaleString() : '—';
    }
    const cogsSubEl = document.querySelector('[data-kpi="cogs"] .kpi-delta span');
    if (cogsSubEl && k.cogs != null) {
      cogsSubEl.textContent = (k.cogsRate || 0).toFixed(1) + '% of revenue · Google Sheets';
    }

    // ── KPI Card 3: Ad Spend ──
    const spendEl = document.querySelector('[data-kpi="adspend"] .kpi-value');
    if (spendEl) {
      spendEl.dataset.target = Math.round(k.adSpend || 0);
      spendEl.dataset.prefix = '$';
      spendEl.textContent = '$' + Math.round(k.adSpend || 0).toLocaleString();
    }
    const spendSubEl = document.querySelector('[data-kpi="adspend"] .kpi-delta span');
    if (spendSubEl) {
      spendSubEl.textContent = '₩' + ((k.adSpendKRW || 0) / 1000000).toFixed(2) + 'M · ' + (data.days || '—') + ' days';
    }

    // ── KPI Card 4: Gross Profit ──
    const profitEl = document.querySelector('[data-kpi="profit"] .kpi-value');
    if (profitEl) {
      const profit = k.grossProfit || 0;
      profitEl.textContent = profit >= 0
        ? '₩' + (profit / 1000).toFixed(0) + 'K'
        : '-₩' + (Math.abs(profit) / 1000).toFixed(0) + 'K';
    }
    const profitSubEl = document.querySelector('[data-kpi="profit"] .kpi-delta span');
    if (profitSubEl && k.grossMargin != null) {
      profitSubEl.textContent = '₩' + ((k.netRevenue || 0) / 1000000).toFixed(2) + 'M net · ' + k.grossMargin + '% margin';
    }

    // ── KPI Row 2: ROAS, Purchases, CTR, CPA ──
    const roasEl = document.querySelector('[data-kpi="roas"] .kpi-value');
    if (roasEl) {
      roasEl.dataset.target = k.roas != null ? k.roas.toFixed(2) : '0';
      roasEl.dataset.prefix = '';
      roasEl.dataset.suffix = 'x';
      roasEl.textContent = k.roas != null ? k.roas.toFixed(2) + 'x' : '—';
    }

    const purchasesEl = document.querySelector('[data-kpi="purchases"] .kpi-value');
    if (purchasesEl) {
      purchasesEl.dataset.target = k.purchases || 0;
      purchasesEl.dataset.prefix = '';
      purchasesEl.textContent = (k.purchases || 0).toString();
    }
    const purchasesSubEl = document.querySelector('[data-kpi="purchases"] .kpi-delta span');
    if (purchasesSubEl && data.days) {
      const avgPerDay = ((k.purchases || 0) / data.days).toFixed(1);
      purchasesSubEl.textContent = avgPerDay + ' avg/day';
    }

    const ctrEl = document.querySelector('[data-kpi="ctr"] .kpi-value');
    if (ctrEl) {
      ctrEl.dataset.target = (k.ctr || 0).toFixed(2);
      ctrEl.dataset.prefix = '';
      ctrEl.dataset.suffix = '%';
      ctrEl.textContent = (k.ctr || 0).toFixed(2) + '%';
    }

    const cpaEl = document.querySelector('[data-kpi="cpa"] .kpi-value');
    if (cpaEl) {
      cpaEl.dataset.target = k.cpa != null ? k.cpa.toFixed(2) : '0';
      cpaEl.dataset.prefix = '$';
      cpaEl.textContent = k.cpa != null ? '$' + k.cpa.toFixed(2) : '—';
    }

    // ── Scan state + live indicator ──
    if (data.lastScan) {
      const ago = timeSince(new Date(data.lastScan));
      const lastScanEl = document.getElementById('lastScan');
      if (lastScanEl) lastScanEl.textContent = ago;
    }
    const scanBtn = document.getElementById('runScanBtn');
    if (scanBtn) {
      if (data.isScanning) {
        scanBtn.querySelector('span').textContent = 'Scanning...';
        scanBtn.disabled = true;
      } else {
        scanBtn.querySelector('span').textContent = 'Run Scan Now';
        scanBtn.disabled = false;
      }
    }
    const liveDot = document.getElementById('liveDot');
    if (liveDot) liveDot.classList.add('pulse');
    setTimeout(() => { if (liveDot) liveDot.classList.remove('pulse'); }, 1000);

    // ── Chart data comes pre-computed from the server ──
    const dailyMerged = sliceRowsByWindow((data.charts && data.charts.dailyMerged) || [], 'overview');
    const hourlyOrders = analyticsData?.charts?.hourlyOrders || [];
    updateSeriesWindowBadges('overview', dailyMerged);

    // ── Overview Charts: Revenue vs Ad Spend, ROAS, CTR/CPC ──
    if (dailyMerged.length > 0) {
      const labels = dailyMerged.map(d => d.date);

      // spendRevenueChart
      if (typeof spendRevenueChart !== 'undefined' && spendRevenueChart) {
        spendRevenueChart.data.labels = labels;
        spendRevenueChart.data.datasets[0].data = dailyMerged.map(d => d.revenue || 0);
        spendRevenueChart.data.datasets[1].data = dailyMerged.map(d => d.spendKrw || 0);
        spendRevenueChart.update();
      }

      // roasChart
      if (typeof roasChart !== 'undefined' && roasChart) {
        const roasData = dailyMerged.map(d => d.roas || 0);
        const c = typeof getChartColors === 'function' ? getChartColors() : {};
        const gold = c.gold || '#FFC553';
        roasChart.data.labels = labels;
        roasChart.data.datasets[0].data = roasData;
        roasChart.data.datasets[0].pointBackgroundColor = roasData.map(v => v >= 3 ? '#4ade80' : v >= 1 ? gold : '#ef4444');
        roasChart.update();
      }

      // impactChart (CTR + CPC)
      if (typeof impactChart !== 'undefined' && impactChart) {
        impactChart.data.labels = labels;
        impactChart.data.datasets[0].data = dailyMerged.map(d => d.ctr || 0);
        impactChart.data.datasets[1].data = dailyMerged.map(d => d.cpc || 0);
        impactChart.update();
      }
    }

    // ── Sparklines ── (clear existing and re-render)
    const sparkIds = ['sparkRevenue', 'sparkSpend', 'sparkRoas', 'sparkPurchases', 'sparkCtr', 'sparkCpa', 'sparkCogs'];
    sparkIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });

    if (dailyMerged.length >= 2) {
      const last12 = dailyMerged.slice(-12);
      const c = typeof getChartColors === 'function' ? getChartColors() : { primary: '#20808D', secondary: '#A84B2F' };
      if (typeof createSparkline === 'function') {
        createSparkline('sparkRevenue', last12.map(d => d.revenue || 0), '#4ade80');
        createSparkline('sparkSpend', last12.map(d => d.spend || 0), c.primary);
        createSparkline('sparkRoas', last12.map(d => d.roas || 0), c.primary);
        createSparkline('sparkPurchases', last12.map(d => d.purchases || 0), '#4ade80');
        createSparkline('sparkCtr', last12.map(d => d.ctr || 0), c.primary);
        createSparkline('sparkCpa', last12.map(d => d.cpa || 0), c.secondary);
      }
    }

    if (hourlyOrders.length > 0 && typeof hourChartInstance !== 'undefined' && hourChartInstance) {
      const peakHours = hourlyOrders
        .slice()
        .sort((a, b) => (b.orders || 0) - (a.orders || 0))
        .slice(0, 3)
        .map(d => d.hour);

      hourChartInstance.data.labels = hourlyOrders.map(d => d.hour + ':00');
      hourChartInstance.data.datasets[0].data = hourlyOrders.map(d => d.orders || 0);
      hourChartInstance.data.datasets[0].backgroundColor = hourlyOrders.map(d =>
        peakHours.includes(d.hour) ? 'rgba(255, 197, 83, 0.9)' : 'rgba(32, 128, 141, 0.6)'
      );
      hourChartInstance.update();
    }

    // ── Activity feed from optimizations ──
    await updateActivityFeed();

  } catch (e) {
    console.warn('[LIVE] updateOverviewKPIs error:', e.message);
  }
}

async function updateActivityFeed() {
  try {
    const data = await fetchOptimizations(8);
    if (!data || !data.optimizations) return;

    const feed = document.getElementById('activityFeed');
    if (!feed) return;

    if (data.optimizations.length === 0) {
      feed.innerHTML = '<div class="activity-item"><div class="activity-content"><div class="activity-title">No activity yet</div><div class="activity-detail">Waiting for first scan to generate optimization data.</div></div></div>';
      return;
    }

    const iconMap = {
      budget: 'wallet',
      bid: 'trending-up',
      creative: 'image',
      status: 'power',
      schedule: 'clock',
      targeting: 'users',
    };

    feed.innerHTML = data.optimizations.slice(0, 8).map(opt => `
      <div class="activity-item">
        <div class="activity-icon ${safeOptType(opt.type)}">
          <i data-lucide="${iconMap[safeOptType(opt.type)] || 'zap'}"></i>
        </div>
        <div class="activity-content">
          <div class="activity-title">${esc(opt.action || opt.title || '—')}</div>
          <div class="activity-detail">${esc(opt.reason || opt.impact || '')}</div>
        </div>
        <div class="activity-time">${timeSince(new Date(opt.timestamp))}</div>
      </div>
    `).join('');

    if (window.lucide) lucide.createIcons({ nodes: [feed] });
  } catch (e) {
    console.warn('[LIVE] updateActivityFeed error:', e.message);
  }
}

async function updateOptimizationLog() {
  const data = await fetchOptimizations(30);
  if (!data) return;

  const container = document.getElementById('optimizationLog');
  if (!container) return;

  if (data.optimizations.length === 0) {
    container.innerHTML = '<div class="empty-state">No optimizations yet. Waiting for first scan...</div>';
    return;
  }

  container.innerHTML = data.optimizations.map(opt => {
    const type = safeOptType(opt.type);
    const priority = opt.priority || 'low';
    const iconMap = {
      budget: 'wallet',
      bid: 'gavel',
      creative: 'image',
      status: 'power',
      schedule: 'clock',
      targeting: 'target',
    };
    const priorityClass = {
      critical: 'badge-danger',
      high: 'badge-warning',
      medium: 'badge-info',
      low: '',
    };

    return `
      <div class="optimization-item ${opt.executed ? 'executed' : 'pending'}">
        <div class="opt-icon">
          <i data-lucide="${iconMap[type] || 'zap'}"></i>
        </div>
        <div class="opt-content">
          <div class="opt-header">
            <span class="opt-action">${esc(opt.action)}</span>
            <span class="badge ${priorityClass[priority] || ''}">${esc(priority)}</span>
            ${opt.executed ? '<span class="badge badge-success">Executed</span>' : `<button class="btn btn-sm btn-primary execute-opt" data-opt-id="${esc(opt.id)}">Execute</button>`}
          </div>
          <div class="opt-target">${esc(opt.targetName)}</div>
          <div class="opt-reason">${esc(opt.reason)}</div>
          <div class="opt-impact">${esc(opt.impact)}</div>
          <div class="opt-time">${timeSince(new Date(opt.timestamp))}</div>
        </div>
      </div>
    `;
  }).join('');

  // Re-initialize lucide icons
  if (window.lucide) lucide.createIcons();

  // Attach execute handlers
  container.querySelectorAll('.execute-opt').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const optId = e.target.dataset.optId;
      e.target.textContent = 'Sending approval...';
      e.target.disabled = true;
      const result = await executeOptimization(optId);
      if (result && result.pending) {
        e.target.textContent = '⏳ Check Telegram';
        e.target.title = 'Approval request sent to Telegram.';
      } else if (result && result.success) {
        e.target.textContent = 'Done';
        e.target.classList.remove('btn-primary');
        e.target.classList.add('btn-ghost');
      } else {
        e.target.textContent = 'Failed';
      }
    });
  });

  // Update stats
  const statsEl = document.getElementById('optStats');
  if (statsEl && data.stats) {
    const total = Number(data.total) || 0;
    const executed = Number(data.stats.executed) || 0;
    const pending = Number(data.stats.pending) || 0;
    statsEl.innerHTML = `
      <span>Total: ${total}</span> ·
      <span>Executed: ${executed}</span> ·
      <span>Pending: ${pending}</span>
    `;
  }
}

async function updateLiveCampaigns() {
  const [campaignData, postmortem] = await Promise.all([
    fetchCampaigns(),
    fetchPostmortem(),
  ]);

  // ── 1. Campaign overview table (all campaigns) ──
  const body = document.getElementById('campaignBody');
  if (body && campaignData) {
    body.innerHTML = campaignData.campaigns.map(c => {
      const m = c.metrics7d || {};
      const status = c.status === 'ACTIVE' || c.status === 'PAUSED' ? c.status : 'UNKNOWN';
      const statusClass = status === 'ACTIVE' ? 'badge-success' : status === 'PAUSED' ? 'badge-warning' : '';
      const budget = c.dailyBudget ? `$${(parseInt(c.dailyBudget) / 100).toFixed(2)}` : '-';
      const actionButton = status === 'ACTIVE'
        ? `<button class="btn btn-sm btn-ghost campaign-action" data-id="${esc(c.id)}" data-action="PAUSED">Pause</button>`
        : status === 'PAUSED'
        ? `<button class="btn btn-sm btn-primary campaign-action" data-id="${esc(c.id)}" data-action="ACTIVE">Resume</button>`
        : '—';

      return `
        <tr>
          <td style="font-weight:600">${esc(c.name)}</td>
          <td><span class="badge ${statusClass}">${esc(status)}</span></td>
          <td>${budget}/day</td>
          <td>$${(m.spend || 0).toFixed(2)}</td>
          <td>${m.metaPurchases || 0}</td>
          <td>${m.cpa ? '$' + m.cpa.toFixed(2) : '-'}</td>
          <td>${m.ctr ? m.ctr.toFixed(2) + '%' : '-'}</td>
          <td>${actionButton}</td>
        </tr>
      `;
    }).join('');

    // Attach campaign action handlers
    body.querySelectorAll('.campaign-action').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.dataset.id;
        const action = e.target.dataset.action;
        e.target.textContent = 'Sending approval...';
        e.target.disabled = true;
        const result = await updateCampaignStatus(id, action);
        if (result && result.pending) {
          e.target.textContent = '\u23f3 Check Telegram';
          e.target.title = 'Approval request sent to Telegram. Please approve or reject there.';
          setTimeout(updateLiveCampaigns, 15000);
          setTimeout(updateLiveCampaigns, 60000);
        } else if (result && result.success) {
          e.target.textContent = action === 'PAUSED' ? 'Paused' : 'Resumed';
          setTimeout(updateLiveCampaigns, 1000);
        } else {
          e.target.textContent = 'Error';
        }
      });
    });
  }

  if (!postmortem) return;

  // ── 2. Active ads section ──
  const activeContainer = document.getElementById('activeAdsContainer');
  const activeCount = document.getElementById('activeCount');
  if (activeContainer) {
    const active = postmortem.active || [];
    if (activeCount) activeCount.textContent = `${active.length} ad${active.length !== 1 ? 's' : ''} running`;

    if (active.length === 0) {
      activeContainer.innerHTML = '<div class="empty-state">No active ads right now</div>';
    } else {
      activeContainer.innerHTML = `
        <div class="live-ads-grid">
          ${active.map(ad => {
            const cpaStr = ad.cpa ? `$${ad.cpa.toFixed(2)}` : 'N/A';
            const cpaColor = ad.cpa && ad.cpa < 15 ? '#4ade80' : ad.cpa && ad.cpa < 25 ? '#facc15' : '#f87171';
            return `
              <div style="background:var(--color-surface-alt);border-radius:12px;padding:16px;border:1px solid var(--color-divider)">
                <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:10px">
                  <div style="font-weight:600;font-size:0.9rem;line-height:1.3">${esc(ad.name)}</div>
                  <span class="badge badge-success" style="flex-shrink:0;margin-left:8px">LIVE</span>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.82rem">
                  <div><span style="color:var(--color-text-muted)">Spend</span><br><strong>$${ad.spend.toFixed(2)}</strong></div>
                  <div><span style="color:var(--color-text-muted)">Pixel Purchases</span><br><strong>${ad.metaPurchases || 0}</strong></div>
                  <div><span style="color:var(--color-text-muted)">CPA</span><br><strong style="color:${cpaColor}">${cpaStr}</strong></div>
                  <div><span style="color:var(--color-text-muted)">CTR</span><br><strong>${ad.avgCTR.toFixed(2)}%</strong></div>
                  <div><span style="color:var(--color-text-muted)">CPM</span><br><strong>$${ad.avgCPM.toFixed(2)}</strong></div>
                  <div><span style="color:var(--color-text-muted)">Freq</span><br><strong>${ad.lastFrequency.toFixed(1)}</strong></div>
                </div>
                <div style="margin-top:10px;font-size:0.75rem;color:var(--color-text-faint)">${ad.daysOfData} days of data · ${esc(ad.campaignName)}</div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }
  }

  // ── 3. Lessons summary ──
  const lessonsSummaryEl = document.getElementById('lessonsSummary');
  if (lessonsSummaryEl) {
    const summary = postmortem.lessonsSummary || {};
    const lessonLabels = {
      no_conversions: { icon: '⚠️', title: 'Zero Conversions', color: '#f87171', tip: 'Test different creatives, audiences, or offers before scaling spend' },
      high_cpa: { icon: '💸', title: 'High CPA', color: '#facc15', tip: 'Narrow targeting or improve ad relevance to lower acquisition cost' },
      ctr_decay: { icon: '📉', title: 'CTR Decay (Fatigue)', color: '#fb923c', tip: 'Rotate creatives every 1–2 weeks to keep engagement fresh' },
      high_frequency: { icon: '🔁', title: 'Audience Saturation', color: '#c084fc', tip: 'Expand lookalike audiences or add new interest groups' },
      clicks_no_purchase: { icon: '🛒', title: 'Clicks but No Sales', color: '#38bdf8', tip: 'Review landing page experience, pricing, and checkout flow' },
      general: { icon: '📝', title: 'Manually Paused', color: '#94a3b8', tip: 'Replaced by better-performing creative variants' },
      no_data: { icon: '💭', title: 'No Recent Data', color: '#64748b', tip: 'Paused before the current analysis window' },
    };

    const keys = Object.keys(summary).filter(k => k !== 'no_data');
    if (keys.length > 0) {
      lessonsSummaryEl.innerHTML = `
        <div class="lessons-summary-grid">
          ${keys.map(k => {
            const info = lessonLabels[k] || { icon: 'ℹ️', title: k, color: '#94a3b8', tip: '' };
            const count = Number(summary[k].count) || 0;
            return `
              <div style="background:${info.color}15;border:1px solid ${info.color}30;border-radius:10px;padding:12px 16px;flex:1;min-width:200px">
                <div style="font-size:1.1rem;margin-bottom:4px">${info.icon} <strong style="color:${info.color}">${count}</strong></div>
                <div style="font-weight:600;font-size:0.85rem;margin-bottom:4px">${esc(info.title)}</div>
                <div style="font-size:0.78rem;color:var(--color-text-muted);line-height:1.4">${esc(info.tip)}</div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    } else {
      lessonsSummaryEl.innerHTML = '';
    }
  }

  // ── 4. Inactive ads with individual lessons ──
  const inactiveContainer = document.getElementById('inactiveAdsContainer');
  const inactiveCount = document.getElementById('inactiveCount');
  if (inactiveContainer) {
    const inactive = postmortem.inactive || [];
    const noData = postmortem.noData || [];
    if (inactiveCount) inactiveCount.textContent = `${inactive.length} with data · ${noData.length} archived`;

    if (inactive.length === 0 && noData.length === 0) {
      inactiveContainer.innerHTML = '<div class="empty-state">No paused ads</div>';
    } else {
      inactiveContainer.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:8px">
          ${inactive.map(ad => {
            const lessonHTML = ad.lessons.map(l => {
              const typeIcons = {
                no_conversions: '⚠️', high_cpa: '💸', ctr_decay: '📉',
                high_frequency: '🔁', clicks_no_purchase: '🛒', general: '📝', no_data: '💭'
              };
              return `<div style="font-size:0.8rem;color:var(--color-text-muted);margin-top:4px">${typeIcons[l.type] || '•'} ${esc(l.text)}</div>`;
            }).join('');

            return `
              <div style="background:var(--color-surface-alt);border-radius:10px;padding:14px 16px;border:1px solid var(--color-divider);opacity:0.85">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                  <div style="font-weight:600;font-size:0.88rem">${esc(ad.name)}</div>
                  <div class="inactive-ad-meta">
                    <span>$${ad.spend.toFixed(2)} spent</span>
                    <span>·</span>
                    <span>${ad.metaPurchases || 0} pixel purchase${(ad.metaPurchases || 0) !== 1 ? 's' : ''}</span>
                    <span>·</span>
                    <span>${ad.avgCTR.toFixed(2)}% CTR</span>
                    ${ad.cpa ? `<span>·</span><span>$${ad.cpa.toFixed(2)} CPA</span>` : ''}
                  </div>
                </div>
                ${lessonHTML}
                <div style="font-size:0.72rem;color:var(--color-text-faint);margin-top:6px">${ad.daysOfData} days of data · ${esc(ad.campaignName)}</div>
              </div>
            `;
          }).join('')}
          ${noData.length > 0 ? `
            <div style="margin-top:8px;padding:12px 16px;background:var(--color-surface-alt);border-radius:10px;border:1px solid var(--color-divider);opacity:0.6">
              <div style="font-weight:600;font-size:0.85rem;margin-bottom:6px">💭 ${noData.length} Archived Ads (no recent data)</div>
              <div style="font-size:0.78rem;color:var(--color-text-faint);line-height:1.6">
                ${noData.map(a => esc(a.name)).join(' · ')}
              </div>
            </div>
          ` : ''}
        </div>
      `;
    }
  }
}

// ═══════════════════════════════════════════
// ANALYTICS PAGE
// ═══════════════════════════════════════════

async function updateAnalyticsPage() {
  try {
    const [data, reconciliation] = await Promise.all([
      fetchAnalytics(),
      fetchReconciliation(),
    ]);
    if (!data) return;

    const c = typeof getChartColors === 'function' ? getChartColors() : {};
    const primary = c.primary || '#20808D';

    // ── KPI Cards: Refund/Cancel Rates ──
    const refundRateEl = document.querySelector('[data-kpi-analytics="refundRate"] .kpi-value');
    if (refundRateEl && data.refundRate != null) {
      refundRateEl.textContent = data.refundRate.toFixed(1) + '%';
    }
    const refundSubEl = document.querySelector('[data-kpi-analytics="refundRate"] .kpi-delta span');
    if (refundSubEl) {
      refundSubEl.textContent = formatRateMetricDetail(
        data.metrics?.refunds,
        '₩' + (data.totalRefunded / 1000).toFixed(0) + 'K of ₩' + ((data.totalRevenue || 0) / 1000000).toFixed(1) + 'M'
      );
    }

    const cancelRateEl = document.querySelector('[data-kpi-analytics="cancelRate"] .kpi-value');
    if (cancelRateEl && data.cancelRate != null) {
      cancelRateEl.textContent = data.cancelRate.toFixed(1) + '%';
    }
    const cancelSubEl = document.querySelector('[data-kpi-analytics="cancelRate"] .kpi-delta span');
    if (cancelSubEl) {
      cancelSubEl.textContent = formatRateMetricDetail(
        data.metrics?.cancellations,
        (data.cancelledSections || 0) + ' cancelled of ' + (data.totalSections || 0) + ' sections'
      );
    }

    const febRate = data.monthlyRates?.['2026-02'] ?? null;
    const febRefundEl = document.querySelector('[data-kpi-analytics="febRefundRate"] .kpi-value');
    if (febRefundEl && febRate != null) {
      febRefundEl.textContent = febRate.toFixed(1) + '%';
    }
    const febSubEl = document.querySelector('[data-kpi-analytics="febRefundRate"] .kpi-delta span');
    if (febSubEl) {
      const febData = (data.charts?.monthlyRefunds || []).find(m => m.month === '2026-02');
      if (febData) febSubEl.textContent = '₩' + (febData.refunded / 1000).toFixed(0) + 'K refunded of ₩' + (febData.revenue / 1000000).toFixed(1) + 'M';
    }

    const marRate = data.monthlyRates?.['2026-03'] ?? null;
    const marRefundEl = document.querySelector('[data-kpi-analytics="marRefundRate"] .kpi-value');
    if (marRefundEl && marRate != null) {
      marRefundEl.textContent = marRate.toFixed(1) + '%';
    }
    const marSubEl = document.querySelector('[data-kpi-analytics="marRefundRate"] .kpi-delta span');
    if (marSubEl) {
      const marData = (data.charts?.monthlyRefunds || []).find(m => m.month === '2026-03');
      if (marData) marSubEl.textContent = '₩' + (marData.refunded / 1000).toFixed(0) + 'K refunded of ₩' + (marData.revenue / 1000000).toFixed(1) + 'M';
    }

    // ── Chart data comes pre-computed from the server ──
    const charts = data.charts || {};
    const allDailyMerged = charts.dailyMerged || [];
    const allProfitWaterfall = data.profitAnalysis?.waterfall || [];
    const profitDaily = sliceRowsByWindow(allDailyMerged, 'profit-structure');
    const profitWaterfall = sliceRowsByWindow(allProfitWaterfall, 'profit-structure');
    const dailyProfit = profitWaterfall.length > 0
      ? profitWaterfall.map(row => ({ date: row.date, profit: row.trueNetProfit || 0 }))
      : sliceRowsByWindow(charts.dailyProfit || [], 'profit-structure');
    // Use server-computed aggregates, filtered to each section's date window
    const profitCutoff = profitDaily[0]?.date || '';
    const profitWeeklyAgg = (charts.weeklyAgg || []).filter(w => w.week >= profitCutoff);
    const mediaCutoff = sliceRowsByWindow(allDailyMerged, 'media-profitability')[0]?.date || '';
    const mediaWeeklyAgg = (charts.weeklyAgg || []).filter(w => w.week >= mediaCutoff);
    const weekdayPerf = charts.weekdayPerf || [];
    const qualityCutoff = sliceRowsByWindow(allDailyMerged, 'revenue-quality')[0]?.date || '';
    const monthlyRefunds = (charts.monthlyRefunds || []).filter(m => m.month >= qualityCutoff.slice(0, 7));

    renderProfitAnalysisSection(data);

    // ── Daily Profit Trend ──
    if (dailyProfit.length > 0 && typeof profitTrendChart !== 'undefined' && profitTrendChart) {
      let cumProfit = 0;
      const cumData = dailyProfit.map(d => { cumProfit += (d.profit || 0); return cumProfit; });

      profitTrendChart.data.labels = dailyProfit.map(d => d.date);
      profitTrendChart.data.datasets[0].data = dailyProfit.map(d => d.profit || 0);
      profitTrendChart.data.datasets[0].backgroundColor = dailyProfit.map(d =>
        (d.profit || 0) >= 0 ? 'rgba(74, 222, 128, 0.7)' : 'rgba(239, 68, 68, 0.6)'
      );
      profitTrendChart.data.datasets[1].data = cumData;
      profitTrendChart.update();
    }

    // ── Weekly Profit + CPA ──
    if (profitWeeklyAgg.length > 0 && typeof weeklyProfitChart !== 'undefined' && weeklyProfitChart) {
      weeklyProfitChart.data.labels = profitWeeklyAgg.map(d => d.week);
      weeklyProfitChart.data.datasets[0].data = profitWeeklyAgg.map(d => d.profit || 0);
      weeklyProfitChart.data.datasets[0].backgroundColor = profitWeeklyAgg.map(d =>
        (d.profit || 0) >= 0 ? 'rgba(32, 128, 141, 0.8)' : 'rgba(239, 68, 68, 0.6)'
      );
      weeklyProfitChart.update();
    }

    if (mediaWeeklyAgg.length > 0 && typeof weeklyCpaChartInstance !== 'undefined' && weeklyCpaChartInstance) {
      weeklyCpaChartInstance.data.labels = mediaWeeklyAgg.map(d => d.week);
      weeklyCpaChartInstance.data.datasets[0].data = mediaWeeklyAgg.map(d => d.cpa || 0);
      weeklyCpaChartInstance.data.datasets[0].pointBackgroundColor = mediaWeeklyAgg.map(d =>
        (d.cpa || 0) > 20 ? 'rgba(239, 68, 68, 0.9)' : primary
      );
      weeklyCpaChartInstance.data.datasets[1].data = mediaWeeklyAgg.map(d => d.purchases || 0);
      weeklyCpaChartInstance.update();
    }

    // ── Weekday Ad Performance ──
    if (weekdayPerf.length > 0 && typeof weekdayChartInstance !== 'undefined' && weekdayChartInstance) {
      weekdayChartInstance.data.labels = weekdayPerf.map(d => d.day);
      weekdayChartInstance.data.datasets[0].data = weekdayPerf.map(d => d.purchases || 0);
      weekdayChartInstance.data.datasets[1].data = weekdayPerf.map(d => d.cpa || 0);
      weekdayChartInstance.update();
    }

    // ── Monthly Refund Comparison ──
    if (monthlyRefunds.length > 0 && typeof refundChartInstance !== 'undefined' && refundChartInstance) {
      refundChartInstance.data.labels = monthlyRefunds.map(m => m.month);
      refundChartInstance.data.datasets[0].data = monthlyRefunds.map(m => m.revenue || 0);
      refundChartInstance.data.datasets[1].data = monthlyRefunds.map(m => m.refunded || 0);
      refundChartInstance.update();
    }

    // ── Weekday Revenue Table ──
    if (weekdayPerf.length > 0) {
      const body = document.getElementById('weekdayBody');
      if (body) {
        const bestCpa = Math.min(...weekdayPerf.filter(x => x.cpa > 0).map(x => x.cpa));
        const worstCpa = Math.max(...weekdayPerf.map(x => x.cpa || 0));

        body.innerHTML = weekdayPerf.map(d => {
          const cpa = d.cpa || 0;
          const cpaBadge = cpa > 0 && cpa <= bestCpa + 3 ? 'badge-success' : cpa >= worstCpa - 3 ? 'badge-danger' : '';
          return `<tr>
            <td style="font-weight:600">${esc(d.day)}</td>
            <td>${d.orders || 0}</td>
            <td>\u20a9${Math.round(d.paid || 0).toLocaleString()}</td>
            <td style="color:var(--color-danger)">\u20a9${Math.round(d.refunded || 0).toLocaleString()}</td>
            <td style="font-weight:600">\u20a9${Math.round(d.net || 0).toLocaleString()}</td>
            <td>$${(d.spend || 0).toFixed(0)}</td>
            <td>${d.purchases || 0}</td>
            <td><span class="badge ${cpaBadge}">$${cpa.toFixed(2)}</span></td>
          </tr>`;
        }).join('');
      }
    }

    if (reconciliation) {
      updateReconciliationSection(reconciliation);
    }

  } catch (e) {
    console.warn('[LIVE] updateAnalyticsPage error:', e.message);
  }
}

function renderProfitAnalysisSection(data) {
  if (!data || !data.profitAnalysis) return;

  const pa = data.profitAnalysis;
  const waterfall = sliceRowsByWindow(pa.waterfall || [], 'profit-structure');
  const campaignProfit = pa.campaignProfit || [];
  const coveredDays = waterfall.filter(r => r.hasCOGS);
  const coverageRatio = waterfall.length > 0 ? coveredDays.length / waterfall.length : 0;
  const coverage = waterfall.length === 0
    ? { totalDays: 0, daysWithCOGS: 0, coverageRatio: 0, cogsCoveredRange: {}, missingRanges: [], confidence: { level: 'low', label: 'Waiting for data' } }
    : {
        totalDays: waterfall.length,
        daysWithCOGS: coveredDays.length,
        coverageRatio,
        cogsCoveredRange: coveredDays.length > 0 ? { from: coveredDays[0].date, to: coveredDays[coveredDays.length - 1].date } : {},
        missingRanges: waterfall.filter(r => !r.hasCOGS).map(r => r.date),
        confidence: coverageRatio >= 0.9 ? { level: 'high', label: 'High confidence' }
          : coverageRatio >= 0.6 ? { level: 'medium', label: 'Medium confidence' }
          : { level: 'low', label: 'Low confidence' },
      };
  const todaySummary = pa.todaySummary;
  const runRate = pa.runRate;

  updateSeriesWindowBadges('profit-structure', waterfall);

  // ── Hero Card ──
  const heroEl = document.getElementById('profitHero');
  const verdictEl = document.getElementById('profitVerdict');
  const amountEl = document.getElementById('profitAmount');
  const confEl = document.getElementById('profitConfidence');
  const heroSubEl = document.getElementById('profitHeroSub');

  if (todaySummary && verdictEl) {
    const isPositive = todaySummary.trueNetProfit >= 0;
    verdictEl.textContent = todaySummary.verdict;
    verdictEl.className = 'profit-verdict ' + (isPositive ? 'verdict-positive' : 'verdict-negative');
    amountEl.textContent = '\u20a9' + todaySummary.trueNetProfit.toLocaleString();
    amountEl.className = 'profit-amount ' + (isPositive ? 'verdict-positive' : 'verdict-negative');
    if (heroEl) heroEl.className = 'profit-hero ' + (isPositive ? 'hero-positive' : 'hero-negative');
  }

  if (confEl && coverage.confidence) {
    confEl.textContent = coverage.confidence.label;
    confEl.className = 'confidence-badge confidence-' + safeConfidenceLevel(coverage.confidence.level);
  }

  if (heroSubEl && todaySummary) {
    let summaryLabel = 'Latest profit signal';
    if (todaySummary.summaryType === 'today') summaryLabel = 'Today';
    if (todaySummary.summaryType === 'latest_completed') summaryLabel = 'Latest completed day';
    if (todaySummary.summaryType === 'estimated') summaryLabel = 'Current estimate';
    const cogsNote = todaySummary.hasCOGS ? 'COGS included' : 'COGS not yet available';
    const runRateText = runRate
      ? ` · 14d avg ₩${runRate.avgDailyNetProfit.toLocaleString()}/day · est. ₩${runRate.projectedMonthlyNetProfit.toLocaleString()}/30d`
      : '';
    heroSubEl.textContent = `${todaySummary.date} — ${summaryLabel} · ${cogsNote}${runRateText}`;
  }

  // ── KPI Cards ──
  const totalProfit = waterfall.reduce((sum, row) => sum + toFiniteNumber(row.trueNetProfit), 0);
  const totalNetRev = waterfall.reduce((sum, row) => sum + toFiniteNumber(row.netRevenue), 0);
  const totalAdSpend = waterfall.reduce((sum, row) => sum + toFiniteNumber(row.adSpendKRW), 0);
  const blendedMargin = totalNetRev > 0 ? (totalProfit / totalNetRev * 100) : 0;
  const trueRoas = totalAdSpend > 0 ? totalNetRev / totalAdSpend : 0;

  const profitKpi = document.querySelector('[data-profit-kpi="trueNetProfit"] .kpi-value');
  if (profitKpi) profitKpi.textContent = '\u20a9' + totalProfit.toLocaleString();
  const profitSub = document.querySelector('[data-profit-kpi="trueNetProfit"] .kpi-delta span');
  if (profitSub) profitSub.textContent = waterfall.length + ' days';

  const cogsKpi = document.querySelector('[data-profit-kpi="cogsCoverage"] .kpi-value');
  if (cogsKpi) cogsKpi.textContent = (coverage.coverageRatio * 100).toFixed(0) + '%';
  const cogsSub = document.querySelector('[data-profit-kpi="cogsCoverage"] .kpi-delta span');
  if (cogsSub) cogsSub.textContent = coverage.daysWithCOGS + ' of ' + coverage.totalDays + ' days';

  const marginKpi = document.querySelector('[data-profit-kpi="blendedMargin"] .kpi-value');
  if (marginKpi) marginKpi.textContent = blendedMargin.toFixed(1) + '%';
  const marginSub = document.querySelector('[data-profit-kpi="blendedMargin"] .kpi-delta span');
  if (marginSub) marginSub.textContent = totalProfit >= 0 ? 'Profitable' : 'Unprofitable';

  const roasKpi = document.querySelector('[data-profit-kpi="trueRoas"] .kpi-value');
  if (roasKpi) roasKpi.textContent = trueRoas.toFixed(2) + 'x';
  const roasSub = document.querySelector('[data-profit-kpi="trueRoas"] .kpi-delta span');
  if (roasSub) roasSub.textContent = 'Net Revenue / Ad Spend';

  const runRateKpi = document.querySelector('[data-profit-kpi="runRate30d"] .kpi-value');
  if (runRateKpi) {
    const projected = runRate ? runRate.projectedMonthlyNetProfit : null;
    if (projected == null) {
      runRateKpi.textContent = '—';
    } else {
      runRateKpi.textContent = projected >= 0
        ? '\u20a9' + projected.toLocaleString()
        : '-\u20a9' + Math.abs(projected).toLocaleString();
    }
  }
  const runRateSub = document.querySelector('[data-profit-kpi="runRate30d"] .kpi-delta span');
  if (runRateSub) {
    if (runRate) {
      const avgDaily = runRate.avgDailyNetProfit >= 0
        ? '\u20a9' + runRate.avgDailyNetProfit.toLocaleString()
        : '-\u20a9' + Math.abs(runRate.avgDailyNetProfit).toLocaleString();
      runRateSub.textContent = `${runRate.daysUsed}d used · ${avgDaily}/day`;
    } else {
      runRateSub.textContent = 'Waiting for covered days';
    }
  }

  // ── Waterfall Chart ──
  if (waterfall.length > 0 && typeof profitWaterfallChart !== 'undefined' && profitWaterfallChart) {
    profitWaterfallChart.data.labels = waterfall.map(d => d.date);
    profitWaterfallChart.data.datasets[0].data = waterfall.map(d => d.revenue);
    profitWaterfallChart.data.datasets[1].data = waterfall.map(d => -d.refunded);
    profitWaterfallChart.data.datasets[2].data = waterfall.map(d => -(d.cogs + d.cogsShipping));
    profitWaterfallChart.data.datasets[3].data = waterfall.map(d => -d.adSpendKRW);
    profitWaterfallChart.data.datasets[4].data = waterfall.map(d => -d.paymentFees);
    profitWaterfallChart.data.datasets[5].data = waterfall.map(d => d.trueNetProfit);
    profitWaterfallChart.data.datasets[5].pointBackgroundColor = waterfall.map(d =>
      d.trueNetProfit >= 0 ? '#4ade80' : '#f87171'
    );
    profitWaterfallChart.data.datasets[0].backgroundColor = waterfall.map(d =>
      d.hasCOGS ? 'rgba(74, 222, 128, 0.75)' : 'rgba(74, 222, 128, 0.35)'
    );
    profitWaterfallChart.update();
  }

  // ── Campaign Profit Leaderboard ──
  const tbody = document.getElementById('campaignProfitBody');
  if (tbody) {
    tbody.innerHTML = campaignProfit.map(campaign => {
      const statusClass = campaign.status === 'ACTIVE' ? 'badge-success' : 'badge-neutral';
      const profitColor = campaign.grossProfit >= 0 ? 'var(--color-success)' : 'var(--color-error)';
      return `<tr>
        <td title="${esc(campaign.campaignId)}">${esc(campaign.campaignName)}</td>
        <td><span class="badge ${statusClass}">${esc(campaign.status || '—')}</span></td>
        <td>$${campaign.spend.toFixed(2)}<br><span style="font-size:0.7rem;color:var(--color-text-faint)">\u20a9${campaign.spendKRW.toLocaleString()}</span></td>
        <td>${campaign.metaPurchases}</td>
        <td>\u20a9${campaign.estimatedRevenue.toLocaleString()}</td>
        <td>\u20a9${campaign.allocatedCOGS.toLocaleString()}</td>
        <td style="color:${profitColor};font-weight:600">\u20a9${campaign.grossProfit.toLocaleString()}</td>
        <td style="color:${profitColor}">${campaign.margin.toFixed(1)}%</td>
      </tr>`;
    }).join('');
  }

  // ── Data Coverage Card ──
  const coverageContent = document.getElementById('dataCoverageContent');
  if (coverageContent && coverage.confidence) {
    const conf = coverage.confidence;
    const confLevel = safeConfidenceLevel(conf.level);
    const coveredRange = coverage.cogsCoveredRange || {};
    const missing = coverage.missingRanges || [];
    coverageContent.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <span class="confidence-badge confidence-${confLevel}">${esc(conf.label)}</span>
        <span style="font-size:0.85rem;color:var(--color-text-muted)">${coverage.daysWithCOGS} of ${coverage.totalDays} days have COGS data (${(coverage.coverageRatio * 100).toFixed(0)}%)</span>
      </div>
      ${coveredRange.from ? `<p style="font-size:0.85rem;color:var(--color-text-muted);margin:4px 0">Covered: <strong>${esc(coveredRange.from)}</strong> to <strong>${esc(coveredRange.to)}</strong></p>` : ''}
      ${missing.length > 0 ? `<p style="font-size:0.85rem;color:var(--color-text-faint);margin:4px 0">Missing: ${missing.map(item => esc(item)).join(', ')}</p>` : ''}
      <p style="font-size:0.78rem;color:var(--color-text-faint);margin-top:8px">Days without COGS data are shown dimmed in the waterfall chart. Profit for those days only accounts for revenue, ad spend, and payment fees.</p>
    `;
  }
}

function updateReconciliationSection(report) {
  const statusEl = document.getElementById('reconciliationStatus');
  const noteEl = document.getElementById('reconciliationNote');
  const windowEl = document.getElementById('reconciliationWindow');
  const bodyEl = document.getElementById('reconciliationBody');
  const visibleReport = report && report.ready !== false
    ? buildVisibleReconciliationReport(report, 'revenue-quality')
    : report;
  const rangeMeta = getSeriesWindowMeta('revenue-quality');

  if (windowEl) {
    windowEl.textContent = report?.matchWindowMinutes
      ? `Match window ${report.matchWindowMinutes}m · ${rangeMeta.label} view`
      : `${rangeMeta.label} view`;
  }

  if (!report || report.ready === false) {
    if (statusEl) {
      statusEl.className = 'badge badge-neutral';
      statusEl.textContent = 'Unavailable';
    }
    if (noteEl) {
      noteEl.textContent = 'Settlement reconciliation is unavailable because no settlement source is configured.';
    }
    if (bodyEl) {
      bodyEl.innerHTML = '<tr><td colspan="6" style="color:var(--color-text-faint)">Settlement reconciliation is unavailable.</td></tr>';
    }
    return;
  }

  const overlap = visibleReport.summary?.overlap || {};
  const matchedNet = overlap.netAmount || 0;
  const unmatchedSettlementCount = overlap.unmatchedSettlementCount || 0;
  const unmatchedImwebCount = overlap.unmatchedImwebCount || 0;
  const methodMismatchCount = overlap.methodMismatchCount || 0;
  const methodMismatchAmount = overlap.methodMismatchAmount || 0;

  if (statusEl) {
    if (methodMismatchCount > 0) {
      statusEl.className = 'badge badge-warning';
      statusEl.textContent = 'Check Mapping';
    } else if (unmatchedSettlementCount > 0 || unmatchedImwebCount > 0) {
      statusEl.className = 'badge badge-neutral';
      statusEl.textContent = 'Partial Match';
    } else {
      statusEl.className = 'badge badge-success';
      statusEl.textContent = 'Aligned';
    }
  }

  const reconKpis = {
    matchedNet: {
      value: formatSignedCompactKrw(matchedNet),
      sub: `${overlap.matchedCount || 0} matched events`,
    },
    unmatchedSettlement: {
      value: String(unmatchedSettlementCount),
      sub: `${formatSignedCompactKrw((visibleReport.daily || []).reduce((sum, day) => sum + (day.unmatchedSettlement?.netAmount || 0), 0))} settlement gap`,
    },
    unmatchedImweb: {
      value: String(unmatchedImwebCount),
      sub: `${formatSignedCompactKrw((visibleReport.daily || []).reduce((sum, day) => sum + (day.unmatchedImweb?.netAmount || 0), 0))} imweb gap`,
    },
    methodMismatch: {
      value: String(methodMismatchCount),
      sub: methodMismatchCount > 0 ? `${formatSignedCompactKrw(methodMismatchAmount)} flagged` : 'No method drift',
    },
  };

  Object.entries(reconKpis).forEach(([key, meta]) => {
    const valueEl = document.querySelector(`[data-recon-kpi="${key}"] .kpi-value`);
    const subEl = document.querySelector(`[data-recon-kpi="${key}"] .kpi-delta span`);
    if (valueEl) valueEl.textContent = meta.value;
    if (subEl) subEl.textContent = meta.sub;
  });

  if (noteEl) {
    const confidence = overlap.confidence || {};
    const high = confidence.high || 0;
    const medium = confidence.medium || 0;
    const low = confidence.low || 0;
    noteEl.textContent = visibleReport.daily.length === 0
      ? 'No reconciliation rows fall inside the selected window.'
      : methodMismatchCount > 0
      ? `${high} high / ${medium} medium / ${low} low-confidence matches. Matched settlement rows are currently colliding with non-card IMWEB payment labels, so treat this as a validation signal rather than a direct payment-method map.`
      : `${high} high / ${medium} medium / ${low} low-confidence matches across the selected settlement window.`;
  }

  if (bodyEl) {
    const rows = (visibleReport.daily || []).slice().reverse();
    bodyEl.innerHTML = rows.length > 0
      ? rows.map(day => `
          <tr>
            <td style="font-weight:600">${esc(day.date)}</td>
            <td>${formatSignedKrw(day.settlement?.netAmount || 0)}</td>
            <td>${formatSignedKrw(day.imweb?.netAmount || 0)}</td>
            <td style="color:var(--color-success)">${formatSignedKrw(day.matched?.netAmount || 0)}</td>
            <td style="color:${(day.unmatchedSettlement?.netAmount || 0) === 0 ? 'var(--color-text)' : 'var(--color-warning)'}">${formatSignedKrw(day.unmatchedSettlement?.netAmount || 0)}</td>
            <td style="color:${(day.unmatchedImweb?.netAmount || 0) === 0 ? 'var(--color-text)' : 'var(--color-warning)'}">${formatSignedKrw(day.unmatchedImweb?.netAmount || 0)}</td>
          </tr>
        `).join('')
      : '<tr><td colspan="6" style="color:var(--color-text-faint)">No reconciliation rows available.</td></tr>';
  }
}

// ═══════════════════════════════════════════
// CALENDAR ANALYSIS PAGE
// ═══════════════════════════════════════════

function ensureCalendarStateInitialized() {
  if (calendarState.initialized) return;

  const today = getKstDateKey();
  calendarState.anchorMonth = getCalendarMonthStart(today);
  calendarState.selectionStart = today;
  calendarState.selectionEnd = today;
  calendarState.initialized = true;
}

function getCalendarVisibleRange() {
  ensureCalendarStateInitialized();
  const anchorMonth = getCalendarMonthStart(calendarState.anchorMonth || getKstDateKey());
  return {
    visibleStart: getCalendarMonthStart(shiftCalendarMonth(anchorMonth, -1)),
    visibleEnd: getCalendarMonthEnd(anchorMonth),
  };
}

function syncCalendarSelectionIntoViewport() {
  const { visibleStart, visibleEnd } = getCalendarVisibleRange();
  const fallback = clampDateKey(getKstDateKey(), visibleStart, visibleEnd);

  calendarState.selectionStart = clampDateKey(calendarState.selectionStart || fallback, visibleStart, visibleEnd);
  calendarState.selectionEnd = clampDateKey(calendarState.selectionEnd || calendarState.selectionStart, visibleStart, visibleEnd);

  if (compareDateKeys(calendarState.selectionStart, calendarState.selectionEnd) > 0) {
    const start = calendarState.selectionEnd;
    calendarState.selectionEnd = calendarState.selectionStart;
    calendarState.selectionStart = start;
  }
}

function buildClientCalendarMonths(visibleStart, visibleEnd) {
  const months = [];
  let cursor = getCalendarMonthStart(visibleStart);
  const lastMonth = getCalendarMonthStart(visibleEnd);

  while (cursor && compareDateKeys(cursor, lastMonth) <= 0) {
    months.push({
      month: cursor.slice(0, 7),
      label: formatUtcDate(cursor, { month: 'long', year: 'numeric' }),
      start: cursor,
      end: getCalendarMonthEnd(cursor),
    });
    cursor = shiftCalendarMonth(cursor, 1);
  }

  return months;
}

function hasFreshCalendarViewportPayload(data) {
  const { visibleStart, visibleEnd } = getCalendarVisibleRange();
  return !!(
    data &&
    data.viewport?.visibleStart === visibleStart &&
    data.viewport?.visibleEnd === visibleEnd
  );
}

function hasFreshCalendarSelectionPayload(data) {
  return !!(
    hasFreshCalendarViewportPayload(data) &&
    data.viewport?.selectionStart === calendarState.selectionStart &&
    data.viewport?.selectionEnd === calendarState.selectionEnd
  );
}

function getCalendarSelectionMeta(months) {
  const monthLabel = (months || []).map(month => month.label).join(' + ') || 'Calendar';
  const selectionLabel = formatCalendarRange(calendarState.selectionStart, calendarState.selectionEnd);
  return `${monthLabel} · ${selectionLabel} · KST${calendarState.loading ? ' · Updating...' : ''}`;
}

function getCalendarDayClasses(dateKey) {
  const classes = [];
  const inRange = compareDateKeys(dateKey, calendarState.selectionStart) >= 0 && compareDateKeys(dateKey, calendarState.selectionEnd) <= 0;
  const isSingle = calendarState.selectionStart === calendarState.selectionEnd && dateKey === calendarState.selectionStart;
  const isStart = dateKey === calendarState.selectionStart;
  const isEnd = dateKey === calendarState.selectionEnd;
  const isToday = dateKey === getKstDateKey();

  if (inRange) classes.push('is-selected', 'is-range');
  if (isStart) classes.push('is-selection-start');
  if (isEnd) classes.push('is-selection-end');
  if (isSingle) classes.push('is-selection-single');
  if (isToday) classes.push('is-today');

  return classes.join(' ');
}

function renderCalendarDayCell(dateKey, dayData) {
  const data = dayData || {
    revenue: 0,
    trueNetProfit: 0,
    orders: 0,
    refundCount: 0,
    opCount: 0,
    reconciliationGapCount: 0,
    hasCOGS: false,
    revenueIntensity: 0,
  };
  const todayKey = getKstDateKey();
  const isFuture = compareDateKeys(dateKey, todayKey) > 0;
  const isEmptyDay = !isFuture && (data.revenue || 0) === 0 && (data.orders || 0) === 0 && (data.adSpend || 0) === 0 && (data.refundCount || 0) === 0 && (data.opCount || 0) === 0;
  const profitClass = (data.trueNetProfit || 0) >= 0 ? 'positive' : 'negative';
  const badges = [];

  if (isFuture) {
    badges.push('<span class="calendar-mini-badge future">Future</span>');
  }

  if ((data.refundCount || 0) > 0) {
    badges.push(`<span class="calendar-mini-badge refund">${formatCount(data.refundCount)} refund${data.refundCount === 1 ? '' : 's'}</span>`);
  }

  const anomalyCount = Math.max(data.reconciliationGapCount || 0, data.opCount || 0);
  if (anomalyCount > 0) {
    badges.push(`<span class="calendar-mini-badge ops">${formatCount(anomalyCount)} op${anomalyCount === 1 ? '' : 's'}</span>`);
  }

  if (!data.hasCOGS && ((data.revenue || 0) > 0 || (data.orders || 0) > 0 || (data.adSpend || 0) > 0)) {
    badges.push('<span class="calendar-mini-badge coverage">COGS open</span>');
  }

  if (isEmptyDay) {
    badges.push('<span class="calendar-mini-badge coverage">No data</span>');
  }

  const revenueLabel = isFuture ? '—' : formatCompactKrw(data.revenue || 0);
  const profitLabel = isFuture ? '—' : formatSignedCompactKrw(data.trueNetProfit || 0);
  const ordersLabel = isFuture ? 'Future date' : `${formatCount(data.orders || 0)} orders`;

  return `
    <button
      type="button"
      class="calendar-day ${getCalendarDayClasses(dateKey)} ${isFuture ? 'is-future' : ''} ${isEmptyDay ? 'is-empty' : ''}"
      data-date="${esc(dateKey)}"
      data-future="${isFuture ? '1' : '0'}"
      style="--calendar-alpha:${Number(data.revenueIntensity || 0)}"
    >
      <div class="calendar-day-top">
        <span class="calendar-day-number">${esc(String(Number(dateKey.slice(-2))))}</span>
        ${dateKey === todayKey ? '<span class="calendar-day-label">Today</span>' : ''}
      </div>
      <div class="calendar-day-revenue">${revenueLabel}</div>
      <div class="calendar-day-profit ${profitClass}">${profitLabel}</div>
      <div class="calendar-day-orders">${ordersLabel}</div>
      <div class="calendar-day-badges">${badges.join('')}</div>
    </button>
  `;
}

function renderCalendarViewport() {
  const viewportEl = document.getElementById('calendarViewport');
  const metaEl = document.getElementById('calendarSelectionMeta');
  if (!viewportEl) return;

  ensureCalendarStateInitialized();
  syncCalendarSelectionIntoViewport();

  const { visibleStart, visibleEnd } = getCalendarVisibleRange();
  const hasFreshViewport = hasFreshCalendarViewportPayload(calendarState.data);
  const months = hasFreshViewport && calendarState.data?.viewport?.months?.length
    ? calendarState.data.viewport.months
    : buildClientCalendarMonths(visibleStart, visibleEnd);

  if (metaEl) {
    metaEl.textContent = getCalendarSelectionMeta(months);
  }

  if (!hasFreshViewport && calendarState.loading) {
    viewportEl.innerHTML = '<div class="empty-state">Loading calendar analysis...</div>';
    return;
  }

  const calendarDays = hasFreshViewport ? (calendarState.data?.calendarDays || []) : [];
  const dayMap = new Map(calendarDays.map(day => [day.date, day]));
  const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  viewportEl.innerHTML = months.map(month => {
    const days = enumerateDateKeys(month.start, month.end);
    const leadingSpaces = getCalendarWeekday(month.start);
    return `
      <div class="calendar-month">
        <div class="calendar-month-header">
          <div>
            <div class="calendar-month-title">${esc(month.label)}</div>
            <div class="calendar-month-note">${formatCount(days.length)} days</div>
          </div>
          <span class="badge badge-neutral">${esc(month.month)}</span>
        </div>
        <div class="calendar-weekdays">
          ${weekdayLabels.map(label => `<div class="calendar-weekday">${label}</div>`).join('')}
        </div>
        <div class="calendar-grid">
          ${Array.from({ length: leadingSpaces }, () => '<div class="calendar-spacer"></div>').join('')}
          ${days.map(dateKey => renderCalendarDayCell(dateKey, dayMap.get(dateKey))).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function renderCalendarSummaryCard(card) {
  return `
    <div class="kpi-card">
      <div class="kpi-label">${esc(card.label)}</div>
      <div class="kpi-value">${card.value}</div>
      <div class="kpi-delta ${card.tone || 'neutral'}">
        <i data-lucide="${esc(card.icon || 'minus')}"></i>
        <span>${esc(card.sub || '—')}</span>
      </div>
    </div>
  `;
}

function renderEmptyStateCard(title, body) {
  return `
    <div class="card">
      <div class="card-header">
        <h2>${esc(title)}</h2>
      </div>
      <p class="card-desc">${esc(body)}</p>
    </div>
  `;
}

function renderStatusBadge(status) {
  const normalized = String(status || '').toUpperCase();
  const badgeClass = normalized === 'ACTIVE' || normalized === 'OPEN'
    ? 'badge-success'
    : normalized === 'PAUSED'
    ? 'badge-neutral'
    : /(CANCEL|RETURN|REFUND|ERROR|FAILED)/.test(normalized)
    ? 'badge-danger'
    : 'badge-neutral';
  return `<span class="badge ${badgeClass}">${esc(humanizeEnum(status || '—'))}</span>`;
}

function renderStatusMixText(statusMix) {
  return (Array.isArray(statusMix) ? statusMix : [])
    .slice(0, 3)
    .map(entry => `${humanizeEnum(entry.status)} ${formatCount(entry.count)}`)
    .join(' · ') || '—';
}

function renderCalendarEvent(event) {
  const iconMap = {
    scan: 'radar',
    optimization: 'zap',
    execution: 'send',
    reconciliation_gap: 'shield-alert',
    refund_spike: 'rotate-ccw',
  };
  const statusClass = event?.status === 'ok'
    ? 'ok'
    : event?.status === 'error'
    ? 'error'
    : event?.status === 'warning'
    ? 'warning'
    : '';
  const meta = [];
  if (event?.meta?.targetName) meta.push(esc(event.meta.targetName));
  if (event?.meta?.priority) meta.push(esc(humanizeEnum(event.meta.priority)));
  if (event?.scanId) meta.push(`#${esc(String(event.scanId))}`);
  const summary = event?.type === 'reconciliation_gap'
    ? `Settlement ${formatSignedKrw(event?.meta?.settlementGap || 0)} · Imweb ${formatSignedKrw(event?.meta?.imwebGap || 0)}`
    : (event?.summary || '—');

  return `
    <div class="calendar-event">
      <div class="calendar-event-icon ${statusClass}">
        <i data-lucide="${esc(iconMap[event?.type] || 'activity')}"></i>
      </div>
      <div class="calendar-event-main">
        <div class="calendar-event-title">${esc(event?.title || 'Event')}</div>
        <div class="calendar-event-summary">${esc(summary)}</div>
        ${meta.length > 0 ? `<div class="calendar-event-meta">${meta.join(' · ')}</div>` : ''}
      </div>
      <div class="calendar-event-time">${esc(event?.timestamp ? formatKstTimestamp(event.timestamp) : formatUtcDate(event?.date, { month: 'short', day: 'numeric' }))}</div>
    </div>
  `;
}

function renderCalendarSelectionDeck() {
  const container = document.getElementById('calendarSelectionDeck');
  if (!container) return;

  ensureCalendarStateInitialized();
  syncCalendarSelectionIntoViewport();

  const hasFreshSelection = hasFreshCalendarSelectionPayload(calendarState.data);
  if (!hasFreshSelection && calendarState.loading) {
    container.innerHTML = renderEmptyStateCard('Selected Range', 'Refreshing calendar metrics for the selected date range...');
    return;
  }

  if (!calendarState.data || calendarState.data.ready === false || !hasFreshSelection) {
    container.innerHTML = renderEmptyStateCard('Calendar Analysis', 'Calendar analysis is waiting for the first completed scan.');
    return;
  }

  const selection = calendarState.data.selection || {};
  const summary = selection.summary || {};
  const coverage = selection.coverage || {};
  const confidence = summary.confidence || coverage.confidence || { level: 'low', label: 'Waiting for data' };
  const confidenceClass = safeConfidenceLevel(confidence.level);
  const isProfitPositive = (summary.trueNetProfit || 0) >= 0;
  const reconciliation = selection.reconciliation || {};
  const overlap = reconciliation.summary?.overlap || {};

  const summaryCards = [
    { label: 'Gross Revenue', value: formatKrw(summary.grossRevenue || 0), sub: `${formatCount(summary.recognizedOrders || 0)} recognized orders`, tone: 'positive', icon: 'shopping-bag' },
    { label: 'Refunded', value: formatKrw(summary.refundedAmount || 0), sub: formatPercent(summary.refundRate || 0), tone: (summary.refundedAmount || 0) > 0 ? 'negative' : 'neutral', icon: 'rotate-ccw' },
    { label: 'Net Revenue', value: formatKrw(summary.netRevenue || 0), sub: `${formatCount(summary.dayCount || selection.dayCount || 0)} selected days`, tone: 'positive', icon: 'wallet' },
    { label: 'Ad Spend', value: formatUsd(summary.adSpend || 0, 2), sub: formatKrw(summary.adSpendKRW || 0), tone: 'neutral', icon: 'megaphone' },
    { label: 'COGS', value: formatKrw(summary.cogs || 0), sub: `${formatCount(summary.daysWithCOGS || 0)} covered days`, tone: 'neutral', icon: 'package' },
    { label: 'Shipping', value: formatKrw(summary.shipping || 0), sub: 'Included in true net profit', tone: 'neutral', icon: 'truck' },
    { label: 'Payment Fees', value: formatKrw(summary.paymentFees || 0), sub: 'Applied to net revenue', tone: 'neutral', icon: 'credit-card' },
    { label: 'True Net Profit', value: formatSignedKrw(summary.trueNetProfit || 0), sub: isProfitPositive ? 'Profitable selection' : 'Below break-even', tone: isProfitPositive ? 'positive' : 'negative', icon: 'coins' },
    { label: 'Margin', value: formatPercent(summary.margin || 0), sub: 'True net profit / net revenue', tone: (summary.margin || 0) >= 0 ? 'positive' : 'negative', icon: 'percent' },
    { label: 'ROAS', value: `${Number(summary.roas || 0).toFixed(2)}x`, sub: 'Net revenue / ad spend', tone: (summary.roas || 0) >= 1 ? 'positive' : 'negative', icon: 'trending-up' },
    { label: 'Recognized Orders', value: formatCount(summary.recognizedOrders || 0), sub: `${formatCount(summary.refundOrders || 0)} refund orders`, tone: 'neutral', icon: 'receipt' },
    { label: 'Refund Rate', value: formatPercent(summary.refundRate || 0), sub: `${formatKrw(summary.refundedAmount || 0)} refunded`, tone: (summary.refundRate || 0) > 10 ? 'negative' : 'neutral', icon: 'percent' },
    { label: 'Cancel Rate', value: formatPercent(summary.cancelRate || 0), sub: `${formatCount(summary.cancelledSections || 0)} of ${formatCount(summary.totalSections || 0)} sections`, tone: (summary.cancelRate || 0) > 10 ? 'negative' : 'neutral', icon: 'x-circle' },
    { label: 'Meta Purchases', value: formatCount(summary.metaPurchases || 0), sub: 'Selected-range campaign insights', tone: 'neutral', icon: 'mouse-pointer-2' },
    { label: 'Confidence', value: esc(confidence.label), sub: `${formatPercent((summary.cogsCoverageRatio || 0) * 100, 0)} COGS coverage`, tone: confidenceClass === 'high' ? 'positive' : confidenceClass === 'medium' ? 'neutral' : 'negative', icon: 'shield' },
  ];

  const dailyRows = Array.isArray(selection.days) ? selection.days : [];
  const orderRows = Array.isArray(selection.orders) ? selection.orders : [];
  const productRows = Array.isArray(selection.products) ? selection.products : [];
  const campaignRows = Array.isArray(selection.campaigns) ? selection.campaigns : [];
  const operations = Array.isArray(selection.operations) ? selection.operations : [];

  const dailyBody = dailyRows.length > 0
    ? dailyRows.map(day => `
        <tr>
          <td style="font-weight:600">${esc(formatUtcDate(day.date, { month: 'short', day: 'numeric' }))}</td>
          <td>${formatKrw(day.revenue || 0)}</td>
          <td style="color:var(--color-error)">${formatKrw(day.refunded || 0)}</td>
          <td style="font-weight:600">${formatKrw(day.netRevenue || 0)}</td>
          <td>${formatCount(day.orders || 0)}</td>
          <td>${formatUsd(day.adSpend || 0, 2)}<br><span class="calendar-card-note">${formatKrw(day.adSpendKRW || 0)}</span></td>
          <td>${formatKrw((day.cogs || 0) + (day.shipping || 0))}</td>
          <td>${formatKrw(day.paymentFees || 0)}</td>
          <td style="font-weight:600;color:${(day.trueNetProfit || 0) >= 0 ? 'var(--color-success)' : 'var(--color-error)'}">${formatSignedKrw(day.trueNetProfit || 0)}</td>
          <td>${Number(day.roas || 0).toFixed(2)}x</td>
          <td>${day.hasCOGS ? '<span class="badge badge-success">Covered</span>' : '<span class="badge badge-warning">Pending</span>'}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="11" style="text-align:center;color:var(--color-text-faint);padding:20px">No daily rows in this selection.</td></tr>';

  const orderBody = orderRows.length > 0
    ? orderRows.map(row => `
        <tr>
          <td style="font-weight:600">${esc(formatUtcDate(row.date, { month: 'short', day: 'numeric' }))}</td>
          <td><span style="font-family:var(--font-mono)">${esc(row.orderNo || '—')}</span></td>
          <td>${renderStatusBadge(row.orderStatus)}</td>
          <td>${esc(humanizeEnum(row.paymentMethod || row.pgName || 'Unknown'))}</td>
          <td>${formatKrw(row.paidAmount || 0)}</td>
          <td style="color:var(--color-error)">${formatKrw(row.refundedAmount || 0)}</td>
          <td style="font-weight:600">${formatSignedKrw(row.netRevenue || 0)}</td>
          <td>${formatCount(row.itemCount || 0)}</td>
          <td title="${esc(row.productSummary || '')}">${esc(row.productSummary || '—')}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="9" style="text-align:center;color:var(--color-text-faint);padding:20px">No orders in this selection.</td></tr>';

  const productBody = productRows.length > 0
    ? productRows.map(row => {
        const exactCoverage = !!row.exactCostCoverage;
        const coverageMarkup = exactCoverage
          ? '<span class="calendar-product-coverage exact">Exact</span>'
          : `<span class="calendar-product-coverage partial">${formatPercent((row.coverageRatio || 0) * 100, 0)} covered</span>`;
        return `
          <tr>
            <td style="font-weight:600">${esc(row.productName || '—')}</td>
            <td>${esc(row.brand || '—')}</td>
            <td>${formatCount(row.qty || 0)}</td>
            <td>${formatCount(row.orderCount || 0)}</td>
            <td>${formatKrw(row.itemRevenue || 0)}</td>
            <td>${formatCount(row.refundedOrCanceledQty || 0)}</td>
            <td title="${esc(renderStatusMixText(row.statusMix))}">${esc(renderStatusMixText(row.statusMix))}</td>
            <td>${row.knownCogs != null ? formatKrw(row.knownCogs) : '—'}</td>
            <td>${row.knownShipping != null ? formatKrw(row.knownShipping) : '—'}</td>
            <td>${row.knownProfit != null ? formatSignedKrw(row.knownProfit) : coverageMarkup}</td>
          </tr>
        `;
      }).join('')
    : '<tr><td colspan="10" style="text-align:center;color:var(--color-text-faint);padding:20px">No product rows in this selection.</td></tr>';

  const campaignBody = campaignRows.length > 0
    ? campaignRows.map(row => `
        <tr>
          <td style="font-weight:600">${esc(row.campaignName || row.campaignId || '—')}</td>
          <td>${renderStatusBadge(row.status)}</td>
          <td>${formatUsd(row.spend || 0, 2)}<br><span class="calendar-card-note">${formatKrw(row.spendKRW || 0)}</span></td>
          <td>${formatCount(row.metaPurchases || 0)}</td>
          <td>${formatKrw(row.estimatedRevenue || 0)}</td>
          <td>${formatKrw(row.allocatedCOGS || 0)}</td>
          <td style="font-weight:600;color:${(row.grossProfit || 0) >= 0 ? 'var(--color-success)' : 'var(--color-error)'}">${formatSignedKrw(row.grossProfit || 0)}</td>
          <td>${Number(row.estimatedRoas || 0).toFixed(2)}x</td>
          <td>${formatPercent(row.margin || 0)}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="9" style="text-align:center;color:var(--color-text-faint);padding:20px">No campaign insight rows in this selection.</td></tr>';

  const reconRows = Array.isArray(reconciliation.daily) ? reconciliation.daily : [];
  const reconciliationSummary = reconciliation.ready === false
    ? '<p class="calendar-coverage-note">Settlement reconciliation is unavailable for this environment.</p>'
    : `
      <div class="calendar-reconciliation-grid">
        <div class="calendar-reconciliation-item">
          <div class="calendar-reconciliation-label">Matched Net</div>
          <div class="calendar-reconciliation-value">${formatSignedCompactKrw(overlap.netAmount || 0)}</div>
        </div>
        <div class="calendar-reconciliation-item">
          <div class="calendar-reconciliation-label">Settlement Gaps</div>
          <div class="calendar-reconciliation-value">${formatCount(overlap.unmatchedSettlementCount || 0)}</div>
        </div>
        <div class="calendar-reconciliation-item">
          <div class="calendar-reconciliation-label">Imweb Gaps</div>
          <div class="calendar-reconciliation-value">${formatCount(overlap.unmatchedImwebCount || 0)}</div>
        </div>
        <div class="calendar-reconciliation-item">
          <div class="calendar-reconciliation-label">Method Drift</div>
          <div class="calendar-reconciliation-value">${formatCount(overlap.methodMismatchCount || 0)}</div>
        </div>
      </div>
    `;

  const reconBody = reconRows.length > 0
    ? reconRows.map(day => `
        <tr>
          <td style="font-weight:600">${esc(formatUtcDate(day.date, { month: 'short', day: 'numeric' }))}</td>
          <td>${formatSignedKrw(day.settlement?.netAmount || 0)}</td>
          <td>${formatSignedKrw(day.imweb?.netAmount || 0)}</td>
          <td style="color:var(--color-success)">${formatSignedKrw(day.matched?.netAmount || 0)}</td>
          <td style="color:${(day.unmatchedSettlement?.netAmount || 0) === 0 ? 'var(--color-text)' : 'var(--color-warning)'}">${formatSignedKrw(day.unmatchedSettlement?.netAmount || 0)}</td>
          <td style="color:${(day.unmatchedImweb?.netAmount || 0) === 0 ? 'var(--color-text)' : 'var(--color-warning)'}">${formatSignedKrw(day.unmatchedImweb?.netAmount || 0)}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="6" style="text-align:center;color:var(--color-text-faint);padding:20px">No reconciliation gaps in this selection.</td></tr>';

  container.innerHTML = `
    <div class="card">
      <div class="calendar-detail-head">
        <div>
          <div class="section-kicker">Selected Range</div>
          <div class="calendar-detail-title">${esc(formatCalendarRange(calendarState.selectionStart, calendarState.selectionEnd))}</div>
          <div class="calendar-detail-note">${formatCount(selection.dayCount || 0)} day${selection.dayCount === 1 ? '' : 's'} selected · All dates shown in KST</div>
        </div>
        <div class="calendar-chip-row">
          <span class="calendar-chip ${isProfitPositive ? 'positive' : 'negative'}">${isProfitPositive ? 'Profitable window' : 'Below break-even'}</span>
          <span class="calendar-chip ${confidenceClass === 'high' ? 'positive' : confidenceClass === 'medium' ? 'warning' : 'negative'}">${esc(confidence.label || 'Confidence')}</span>
        </div>
      </div>
      <div class="calendar-callout">
        <span class="confidence-badge confidence-${confidenceClass}">${esc(confidence.label || 'Confidence')}</span>
        <div class="calendar-callout-note">
          ${formatCount(coverage.daysWithCOGS || 0)} of ${formatCount(coverage.totalDays || 0)} selected days have COGS coverage.
          ${coverage.missingRanges && coverage.missingRanges.length > 0 ? ` Missing: ${coverage.missingRanges.join(', ')}.` : ''}
        </div>
      </div>
    </div>

    <div class="calendar-summary-grid">
      ${summaryCards.map(renderCalendarSummaryCard).join('')}
    </div>

    <div class="card">
      <div class="card-header">
        <h2>Daily Breakdown</h2>
        <span class="calendar-card-note">${formatCount(dailyRows.length)} rows</span>
      </div>
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Gross</th>
              <th>Refunded</th>
              <th>Net</th>
              <th>Orders</th>
              <th>Ad Spend</th>
              <th>COGS + Ship</th>
              <th>Fees</th>
              <th>True Net</th>
              <th>ROAS</th>
              <th>Coverage</th>
            </tr>
          </thead>
          <tbody>${dailyBody}</tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2>Orders Ledger</h2>
        <span class="calendar-card-note">${formatCount(orderRows.length)} rows · recognized and non-recognized orders in the selection</span>
      </div>
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Order</th>
              <th>Status</th>
              <th>Payment</th>
              <th>Paid</th>
              <th>Refunded</th>
              <th>Net</th>
              <th>Items</th>
              <th>Products</th>
            </tr>
          </thead>
          <tbody>${orderBody}</tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2>Product Explorer</h2>
        <span class="calendar-card-note">Exact COGS only appears when <code>date + productName</code> matches the Sheets item rows exactly.</span>
      </div>
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Brand</th>
              <th>Qty</th>
              <th>Orders</th>
              <th>Revenue</th>
              <th>Refund / Cancel Qty</th>
              <th>Status Mix</th>
              <th>COGS</th>
              <th>Shipping</th>
              <th>Profit / Coverage</th>
            </tr>
          </thead>
          <tbody>${productBody}</tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2>Campaign Performance</h2>
        <span class="calendar-card-note">Revenue, COGS allocation, profit, and ROAS here are estimated from selected-range AOV and Meta purchases.</span>
      </div>
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Status</th>
              <th>Spend</th>
              <th>Meta Purchases</th>
              <th>Est. Revenue</th>
              <th>Est. COGS</th>
              <th>Est. Profit</th>
              <th>Est. ROAS</th>
              <th>Margin</th>
            </tr>
          </thead>
          <tbody>${campaignBody}</tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <h2>Operations & Reconciliation Timeline</h2>
          <div class="calendar-card-note">Scans, optimizer actions, execution updates, and reconciliation gaps for the active selection.</div>
        </div>
        <span class="calendar-card-note">${formatCount(operations.length)} events</span>
      </div>
      ${reconciliationSummary}
      <div class="calendar-timeline">
        ${operations.length > 0
          ? operations.map(renderCalendarEvent).join('')
          : '<div class="empty-state">No operations in this selection.</div>'}
      </div>
      <div class="card-header" style="margin-top:16px">
        <h2>Daily Reconciliation Gaps</h2>
        <span class="calendar-card-note">${formatCount(reconRows.length)} rows</span>
      </div>
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Settlement Net</th>
              <th>Imweb Net</th>
              <th>Matched</th>
              <th>Settlement Gap</th>
              <th>Imweb Gap</th>
            </tr>
          </thead>
          <tbody>${reconBody}</tbody>
        </table>
      </div>
    </div>
  `;

  if (window.lucide) {
    lucide.createIcons({ nodes: [container] });
  }
}

async function updateCalendarAnalysisPage() {
  const viewportEl = document.getElementById('calendarViewport');
  if (!viewportEl) return;

  ensureCalendarStateInitialized();
  syncCalendarSelectionIntoViewport();

  const { visibleStart, visibleEnd } = getCalendarVisibleRange();
  calendarState.loading = true;
  renderCalendarViewport();
  renderCalendarSelectionDeck();

  const requestId = ++calendarState.requestId;
  const data = await fetchCalendarAnalysis({
    visibleStart,
    visibleEnd,
    selectionStart: calendarState.selectionStart,
    selectionEnd: calendarState.selectionEnd,
  });

  if (requestId !== calendarState.requestId) {
    return;
  }

  calendarState.loading = false;

  if (data) {
    calendarState.data = data;
    calendarState.selectionStart = data.viewport?.selectionStart || calendarState.selectionStart;
    calendarState.selectionEnd = data.viewport?.selectionEnd || calendarState.selectionEnd;
  } else if (!hasFreshCalendarSelectionPayload(calendarState.data)) {
    calendarState.data = null;
  }

  renderCalendarViewport();
  renderCalendarSelectionDeck();
}

function initCalendarAnalysisControls() {
  if (document.body.dataset.calendarAnalysisReady === 'true') {
    return;
  }

  document.body.dataset.calendarAnalysisReady = 'true';
  ensureCalendarStateInitialized();

  const prevBtn = document.getElementById('calendarPrevBtn');
  const nextBtn = document.getElementById('calendarNextBtn');
  const todayBtn = document.getElementById('calendarTodayBtn');
  const viewportEl = document.getElementById('calendarViewport');

  if (prevBtn) {
    prevBtn.addEventListener('click', async () => {
      calendarState.anchorMonth = shiftCalendarMonth(calendarState.anchorMonth, -1);
      syncCalendarSelectionIntoViewport();
      await updateCalendarAnalysisPage();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', async () => {
      calendarState.anchorMonth = shiftCalendarMonth(calendarState.anchorMonth, 1);
      syncCalendarSelectionIntoViewport();
      await updateCalendarAnalysisPage();
    });
  }

  if (todayBtn) {
    todayBtn.addEventListener('click', async () => {
      const today = getKstDateKey();
      calendarState.anchorMonth = getCalendarMonthStart(today);
      calendarState.selectionStart = today;
      calendarState.selectionEnd = today;
      await updateCalendarAnalysisPage();
    });
  }

  if (viewportEl) {
    viewportEl.addEventListener('pointerdown', event => {
      const dayEl = event.target.closest('.calendar-day[data-date]');
      if (!dayEl) return;
      if (dayEl.dataset.future === '1') return;

      calendarState.dragging = true;
      calendarState.didDrag = false;
      calendarState.dragStart = dayEl.dataset.date;
    });

    viewportEl.addEventListener('pointerover', event => {
      if (!calendarState.dragging) return;
      const dayEl = event.target.closest('.calendar-day[data-date]');
      if (!dayEl) return;
      if (dayEl.dataset.future === '1') return;

      const currentDate = dayEl.dataset.date;
      if (!currentDate || currentDate === calendarState.selectionEnd) return;

      calendarState.didDrag = currentDate !== calendarState.dragStart;
      if (compareDateKeys(currentDate, calendarState.dragStart) >= 0) {
        calendarState.selectionStart = calendarState.dragStart;
        calendarState.selectionEnd = currentDate;
      } else {
        calendarState.selectionStart = currentDate;
        calendarState.selectionEnd = calendarState.dragStart;
      }
      renderCalendarViewport();
    });

    viewportEl.addEventListener('click', async event => {
      const dayEl = event.target.closest('.calendar-day[data-date]');
      if (!dayEl) return;
      if (dayEl.dataset.future === '1') return;
      if (calendarState.didDrag) {
        calendarState.didDrag = false;
        return;
      }

      calendarState.selectionStart = dayEl.dataset.date;
      calendarState.selectionEnd = dayEl.dataset.date;
      await updateCalendarAnalysisPage();
    });
  }

  document.addEventListener('pointerup', async () => {
    if (!calendarState.dragging) return;
    const shouldRefresh = calendarState.didDrag;
    calendarState.dragging = false;
    calendarState.dragStart = null;
    if (shouldRefresh) {
      await updateCalendarAnalysisPage();
    }
  });
}

// ═══════════════════════════════════════════
// FATIGUE DETECTION PAGE
// ═══════════════════════════════════════════

async function updateFatiguePage() {
  try {
    const postmortem = await fetchPostmortem();
    if (!postmortem) return;

    // ── Fatigue grid from active ads ──
    const grid = document.getElementById('fatigueGrid');
    if (grid) {
      const active = postmortem.active || [];

      if (active.length === 0) {
        grid.innerHTML = '<div class="empty-state" style="padding:32px;text-align:center;color:var(--color-text-faint)">No active ads to analyze for fatigue.</div>';
      } else {
        // Compute fatigue status per ad based on frequency + CTR
        const fatigueAds = active.map(ad => {
          let status = 'healthy';
          let ctrDecay = 0;
          let cpmRise = 0;

          // Use lastFrequency as a proxy for saturation
          const freq = ad.lastFrequency || 1;
          const ctr = ad.avgCTR || 0;
          const cpm = ad.avgCPM || 0;

          if (freq > 2.5 || ctr < 5) status = 'danger';
          else if (freq > 1.8 || ctr < 8) status = 'warning';

          return {
            name: ad.name,
            status,
            frequency: freq.toFixed(2),
            ctrDecay: ctr.toFixed(2),
            cpmRise: cpm.toFixed(2),
            days: ad.daysOfData || 0,
            action: status === 'danger'
              ? `Frequency ${freq.toFixed(1)} is high. CTR at ${ctr.toFixed(1)}% — consider pausing or refreshing.`
              : status === 'warning'
              ? `Frequency ${freq.toFixed(1)} — monitor closely. ${ctr.toFixed(1)}% CTR.`
              : `Healthy. ${ctr.toFixed(1)}% CTR, ${freq.toFixed(1)}x frequency. No fatigue signs.`,
          };
        });

        // Update fatigue badge in header
        const fatigueBadgeEl = document.querySelector('[data-fatigue-badge]');
        if (fatigueBadgeEl) {
          const needsAttention = fatigueAds.filter(a => a.status !== 'healthy').length;
          const healthy = fatigueAds.filter(a => a.status === 'healthy').length;
          fatigueBadgeEl.textContent = `${needsAttention} ad${needsAttention !== 1 ? 's' : ''} need${needsAttention === 1 ? 's' : ''} attention · ${healthy} healthy`;
        }

        grid.innerHTML = fatigueAds.map(a => `
          <div class="fatigue-card ${a.status}">
            <div class="fatigue-header">
              <span class="fatigue-name">${esc(a.name)}</span>
              <span class="badge badge-${a.status === 'danger' ? 'error' : a.status === 'warning' ? 'warning' : 'success'}">${a.status.charAt(0).toUpperCase() + a.status.slice(1)}</span>
            </div>
            <div class="fatigue-metrics">
              <div class="fatigue-metric">
                <span class="fatigue-metric-label">Frequency</span>
                <span class="fatigue-metric-value">${a.frequency}</span>
              </div>
              <div class="fatigue-metric">
                <span class="fatigue-metric-label">Avg CTR</span>
                <span class="fatigue-metric-value" style="color:${parseFloat(a.ctrDecay) < 5 ? 'var(--color-error)' : parseFloat(a.ctrDecay) < 8 ? 'var(--color-warning)' : 'var(--color-success)'}">${a.ctrDecay}%</span>
              </div>
              <div class="fatigue-metric">
                <span class="fatigue-metric-label">Avg CPM</span>
                <span class="fatigue-metric-value">$${a.cpmRise}</span>
              </div>
              <div class="fatigue-metric">
                <span class="fatigue-metric-label">Active Days</span>
                <span class="fatigue-metric-value">${a.days}d</span>
              </div>
            </div>
            <div class="fatigue-action">
              <i data-lucide="${a.status === 'danger' ? 'alert-triangle' : a.status === 'warning' ? 'eye' : 'check-circle'}"></i>
              <span>${esc(a.action)}</span>
            </div>
          </div>
        `).join('');

        if (window.lucide) lucide.createIcons({ nodes: [grid] });
      }
    }

    // ── Fatigue chart: daily CTR & frequency trend ──
    const analyticsData = await fetchAnalytics();
    if (analyticsData && typeof fatigueChart !== 'undefined' && fatigueChart) {
      const trend = analyticsData.charts?.fatigueTrend || [];
      if (trend.length >= 2) {
        fatigueChart.data.labels = trend.map(d => d.date || '');
        fatigueChart.data.datasets[0].data = trend.map(d => d.ctr || 0);
        fatigueChart.data.datasets[1].data = trend.map(d => d.frequency || 0);
        fatigueChart.update();
      }
    }

  } catch (e) {
    console.warn('[LIVE] updateFatiguePage error:', e.message);
  }
}

// ═══════════════════════════════════════════
// BUDGET MANAGER PAGE
// ═══════════════════════════════════════════

async function updateBudgetPage() {
  try {
    const [campaignData, analyticsData] = await Promise.all([
      fetchCampaigns(),
      fetchAnalytics(),
    ]);

    if (campaignData && campaignData.campaigns) {
      const campaigns = campaignData.campaigns;
      const active = campaigns.filter(c => c.status === 'ACTIVE');
      const dailySpendSeries = analyticsData?.charts?.dailyMerged || [];
      const referenceDate = analyticsData?.profitAnalysis?.todaySummary?.date || (dailySpendSeries.length > 0 ? dailySpendSeries[dailySpendSeries.length - 1].date : null);
      const todaySpendRow = dailySpendSeries.find(d => d.date === referenceDate) || (dailySpendSeries.length > 0 ? dailySpendSeries[dailySpendSeries.length - 1] : null);
      const latestDailySpend = todaySpendRow ? (todaySpendRow.spend || 0) : 0;
      const totalDailyBudget = active.reduce((sum, c) => {
        return sum + (c.dailyBudget ? parseInt(c.dailyBudget) / 100 : 0);
      }, 0);

      // ── Budget KPI cards ──
      const dailyBudgetEl = document.querySelector('[data-budget-kpi="daily"] .kpi-value');
      if (dailyBudgetEl) {
        dailyBudgetEl.textContent = totalDailyBudget > 0 ? '$' + totalDailyBudget.toFixed(0) + '/day' : '—';
      }

      const totalSpend = campaigns.reduce((sum, c) => {
        const m = c.metrics7d || {};
        return sum + (m.spend || 0);
      }, 0);

      const periodSpendEl = document.querySelector('[data-budget-kpi="periodSpend"] .kpi-value');
      if (periodSpendEl) {
        periodSpendEl.dataset.target = Math.round(totalSpend);
        periodSpendEl.dataset.prefix = '$';
        periodSpendEl.textContent = '$' + Math.round(totalSpend).toLocaleString();
      }

      // Budget remaining (daily)
      const remainingEl = document.querySelector('[data-budget-kpi="remaining"] .kpi-value');
      if (remainingEl) {
        if (totalDailyBudget > 0) {
          const remaining = Math.max(0, totalDailyBudget - latestDailySpend);
          remainingEl.textContent = '$' + remaining.toFixed(2) + '/day';
        } else {
          remainingEl.textContent = '—';
        }
      }

      // Pace indicator
      const paceEl = document.querySelector('[data-budget-kpi="pace"] .kpi-value');
      if (paceEl) {
        paceEl.textContent = active.length > 0 ? 'Active' : 'Paused';
        paceEl.className = 'kpi-value ' + (active.length > 0 ? 'pace-on-track' : '');
      }

      // Budget fill bar
      const budgetFill = document.querySelector('.budget-fill');
      if (budgetFill && totalDailyBudget > 0) {
        const pct = Math.min(100, (latestDailySpend / totalDailyBudget) * 100);
        budgetFill.style.width = pct + '%';
      }

      // ── Budget Pie Chart ──
      if (typeof budgetPieChart !== 'undefined' && budgetPieChart) {
        budgetPieChart.data.labels = campaigns.map(c => c.name);
        budgetPieChart.data.datasets[0].data = campaigns.map(c => {
          const m = c.metrics7d || {};
          return m.spend || 0;
        });
        budgetPieChart.update();
      }
    }

    // ── Budget Pace Chart ──
    if (analyticsData && analyticsData.charts?.dailyMerged && typeof budgetPaceChart !== 'undefined' && budgetPaceChart) {
      const spendData = analyticsData.charts.dailyMerged;
      const totalDailyBudget = campaignData ? campaignData.campaigns
        .filter(c => c.status === 'ACTIVE')
        .reduce((sum, c) => sum + (c.dailyBudget ? parseInt(c.dailyBudget) / 100 : 0), 0) : 110;

      const daysInPeriod = spendData.length;
      const totalBudget = totalDailyBudget * daysInPeriod;
      const targetLine = spendData.map((_, i) => (totalBudget / daysInPeriod) * (i + 1));

      let cumulative = 0;
      const actualCumulative = spendData.map(d => {
        cumulative += (d.spend || 0);
        return cumulative;
      });

      budgetPaceChart.data.labels = spendData.map(d => d.date);
      budgetPaceChart.data.datasets[0].data = targetLine;
      budgetPaceChart.data.datasets[1].data = actualCumulative;
      budgetPaceChart.update();
    }

    // ── Budget History (from optimizations of type 'budget') ──
    const optData = await fetchOptimizations(20);
    const budgetHistoryEl = document.getElementById('budgetHistory');
    if (budgetHistoryEl && optData && optData.optimizations) {
      const budgetOpts = optData.optimizations.filter(o => o.type === 'budget');
      if (budgetOpts.length === 0) {
        budgetHistoryEl.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--color-text-faint);padding:20px">No budget changes yet.</td></tr>';
      } else {
        budgetHistoryEl.innerHTML = budgetOpts.map(o => `
          <tr>
            <td>${timeSince(new Date(o.timestamp))}</td>
            <td>${esc(o.targetName || '—')}</td>
            <td>${esc(formatOptimizationScope(o.level))}</td>
            <td style="font-weight:600">${esc(o.action || '—')}</td>
            <td style="color:var(--color-text-muted)">${esc(o.reason || '—')}</td>
          </tr>
        `).join('');
      }
    }

  } catch (e) {
    console.warn('[LIVE] updateBudgetPage error:', e.message);
  }
}

// ═══════════════════════════════════════════
// SETTINGS PAGE
// ═══════════════════════════════════════════

async function updateSettingsPage() {
  try {
    const [overview, analyticsData, settingsData] = await Promise.all([
      fetchOverview(),
      fetchAnalytics(),
      fetchSettings(),
    ]);
    const k = overview?.kpis || {};
    const imwebAuth = settingsData?.imweb?.auth || null;

    // ── Imweb stats ──
    const imwebStatusEl = document.getElementById('settingsImwebStatus');
    if (imwebStatusEl) {
      const statusMeta = formatImwebAuthStatus(imwebAuth?.status);
      imwebStatusEl.className = `badge ${statusMeta.badge}`;
      imwebStatusEl.textContent = statusMeta.text;
    }

    const imwebSiteCodeEl = document.getElementById('settingsImwebSiteCode');
    if (imwebSiteCodeEl && settingsData?.imweb?.siteCode) {
      imwebSiteCodeEl.textContent = settingsData.imweb.siteCode;
    }

    const imwebTokenSourceEl = document.getElementById('settingsImwebTokenSource');
    if (imwebTokenSourceEl) {
      imwebTokenSourceEl.textContent = formatImwebAuthSource(imwebAuth?.tokenSource);
    }

    const imwebTokenExpiryEl = document.getElementById('settingsImwebTokenExpiry');
    if (imwebTokenExpiryEl) {
      imwebTokenExpiryEl.textContent = formatImwebExpiry(imwebAuth?.expiresAt);
    }

    const imwebAuthNoteEl = document.getElementById('settingsImwebAuthNote');
    if (imwebAuthNoteEl) {
      if (imwebAuth?.lastError) {
        imwebAuthNoteEl.textContent = imwebAuth.lastError;
      } else if (imwebAuth?.status === 'connected') {
        imwebAuthNoteEl.textContent = 'Refreshable token is healthy';
      } else if (imwebAuth?.status === 'misconfigured') {
        imwebAuthNoteEl.textContent = 'IMWEB_CLIENT_ID / IMWEB_CLIENT_SECRET missing';
      } else if (imwebAuth?.status === 'missing') {
        imwebAuthNoteEl.textContent = 'No persisted or env refresh token available';
      } else {
        imwebAuthNoteEl.textContent = 'Waiting for first successful token refresh';
      }
    }

    const imwebOrdersEl = document.getElementById('settingsImwebOrders');
    if (imwebOrdersEl) {
      imwebOrdersEl.textContent = (k.totalOrders || 0) + ' orders';
    }

    const imwebRevenueEl = document.getElementById('settingsImwebRevenue');
    if (imwebRevenueEl) {
      const grossRevenue = Math.round(k.revenue || 0);
      const refunded = Math.round(k.refunded || 0);
      const netRevenue = Math.round(k.netRevenue || 0);

      imwebRevenueEl.textContent = refunded > 0
        ? '₩' + grossRevenue.toLocaleString() + ' gross · ₩' + netRevenue.toLocaleString() + ' net'
        : '₩' + grossRevenue.toLocaleString();
    }

    // ── COGS stats (from analytics) ──
    if (analyticsData) {
      const cogsItemsEl = document.getElementById('settingsCogsItems');
      if (cogsItemsEl) {
        cogsItemsEl.textContent = (analyticsData.cogsItems || '—') + ' items';
      }
      const cogsTotalEl = document.getElementById('settingsCogs');
      if (cogsTotalEl) {
        const productCost = analyticsData.totalCOGS || 0;
        const shipping = analyticsData.totalShipping || 0;
        cogsTotalEl.textContent = productCost > 0
          ? '₩' + productCost.toLocaleString() + ' product + ₩' + shipping.toLocaleString() + ' shipping'
          : '—';
      }
    }

  } catch (e) {
    console.warn('[LIVE] updateSettingsPage error:', e.message);
  }
}

// ═══════════════════════════════════════════
// LIVE OPTIMIZATION TIMELINE
// ═══════════════════════════════════════════

async function updateOptTimeline() {
  // Fetch daily spend data from the spend-daily endpoint
  const spendData = await api('/spend-daily');

  // Update candlestick chart with live spend data
  if (typeof optTimelineChart !== 'undefined' && optTimelineChart && spendData && spendData.length > 0) {
    const labels = spendData.map(d => {
      const dt = new Date(d.date);
      return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });

    // Update the global arrays that the candlestick plugin reads
    if (typeof _candlestickOHLC !== 'undefined') {
      _candlestickOHLC = spendData.map(d => ({ o: d.o, h: d.h, l: d.l, c: d.c }));
    }
    if (typeof _candlestickData !== 'undefined') {
      _candlestickData = spendData;
      _candlestickChanges = spendData.map((d, i) => {
        if (i === 0) return { pct: 0, dir: '' };
        const prev = spendData[i - 1].spend;
        const pct = ((d.spend - prev) / prev * 100).toFixed(1);
        return { pct: Math.abs(pct), dir: d.spend >= prev ? '\u25b2' : '\u25bc' };
      });
    }

    optTimelineChart.data.labels = labels;
    optTimelineChart.data.datasets[0].data = spendData.map(d => d.c); // close values for tooltip
    optTimelineChart.data.datasets[1].data = spendData.map(d => d.cac);
    // Recalculate y-axis range
    const allVals = spendData.flatMap(d => [d.o, d.h, d.l, d.c]);
    const minV = Math.min(...allVals);
    const maxV = Math.max(...allVals);
    const pad = (maxV - minV) * 0.15;
    optTimelineChart.options.scales.y.min = Math.max(0, minV - pad * 2);
    optTimelineChart.options.scales.y.max = maxV + pad;
    optTimelineChart.update();

    // Update stats bar
    if (typeof updateCandlestickStats === 'function') {
      updateCandlestickStats(spendData);
    }
  }

  // Update type + priority donuts from live optimization stats
  const optData = await api('/optimizations?limit=500');
  if (optData && optData.stats) {
    if (typeof optTypeChart !== 'undefined' && optTypeChart) {
      const types = optData.stats.byType || {};
      optTypeChart.data.labels = Object.keys(types).map(t => t.charAt(0).toUpperCase() + t.slice(1));
      optTypeChart.data.datasets[0].data = Object.values(types);
      optTypeChart.update();
    }
    if (typeof optPriorityChart !== 'undefined' && optPriorityChart) {
      const prios = optData.stats.byPriority || {};
      const prioColors = { critical: '#ef4444', high: '#fb923c', medium: '#20808D', low: '#64748b' };
      optPriorityChart.data.labels = Object.keys(prios).map(p => p.charAt(0).toUpperCase() + p.slice(1));
      optPriorityChart.data.datasets[0].data = Object.values(prios);
      optPriorityChart.data.datasets[0].backgroundColor = Object.keys(prios).map(p => prioColors[p] || '#94a3b8');
      optPriorityChart.update();
    }

    // Update KPI cards
    const totalEl = document.getElementById('optTotal');
    const execEl = document.getElementById('optExecuted');
    const pendEl = document.getElementById('optPending');
    const scansEl = document.getElementById('optScans');
    if (totalEl) totalEl.textContent = optData.total || 0;
    if (execEl) execEl.textContent = optData.stats.executed || 0;
    if (pendEl) pendEl.textContent = optData.stats.pending || 0;
    if (scansEl) {
      const scanData = await api('/scans');
      scansEl.textContent = scanData ? scanData.history.length : 0;
    }
  }
}

// ═══════════════════════════════════════════
// POLLING & LIFECYCLE
// ═══════════════════════════════════════════

// ── Static fallback for when backend isn't available ──
function renderStaticCampaignsView() {
  // Backend is offline — show a clear offline message instead of stale data
  const activeContainer = document.getElementById('activeAdsContainer');
  const activeCount = document.getElementById('activeCount');
  const inactiveContainer = document.getElementById('inactiveAdsContainer');
  const inactiveCount = document.getElementById('inactiveCount');
  const lessonsSummaryEl = document.getElementById('lessonsSummary');

  if (activeContainer) {
    if (activeCount) activeCount.textContent = 'Backend offline';
    activeContainer.innerHTML = '<div class="empty-state" style="padding:32px;text-align:center;color:var(--color-text-faint)">Backend offline — live ad data unavailable. Start the server to connect.</div>';
  }
  if (lessonsSummaryEl) lessonsSummaryEl.innerHTML = '';
  if (inactiveContainer) {
    if (inactiveCount) inactiveCount.textContent = '—';
    inactiveContainer.innerHTML = '<div class="empty-state" style="padding:32px;text-align:center;color:var(--color-text-faint)">Backend offline — paused ad data unavailable.</div>';
  }
}

async function startLiveMode() {
  const available = await checkBackendAvailable();
  if (!available) {
    console.log('[LIVE] Backend not available, running in static mode');
    liveMode = false;
    renderStaticCampaignsView();
    return false;
  }

  console.log('[LIVE] Backend connected — enabling live mode');
  liveMode = true;

  // Show live indicator
  showLiveIndicator();

  // Initial fetch — each wrapped so one failure doesn't block the rest
  try { await updateOverviewKPIs(); } catch (e) { console.warn('[LIVE] updateOverviewKPIs error:', e.message); }
  try { await updateOptimizationLog(); } catch (e) { console.warn('[LIVE] updateOptimizationLog error:', e.message); }
  try { await updateLiveCampaigns(); } catch (e) { console.warn('[LIVE] updateLiveCampaigns error:', e.message); }
  try { await updateOptTimeline(); } catch (e) { console.warn('[LIVE] updateOptTimeline error:', e.message); }
  try { await updateAnalyticsPage(); } catch (e) { console.warn('[LIVE] updateAnalyticsPage error:', e.message); }
  try { await updateCalendarAnalysisPage(); } catch (e) { console.warn('[LIVE] updateCalendarAnalysisPage error:', e.message); }
  try { await updateSettingsPage(); } catch (e) { console.warn('[LIVE] updateSettingsPage error:', e.message); }

  // Wire up scan button for live scans
  const scanBtn = document.getElementById('runScanBtn');
  if (scanBtn) {
    // Remove existing listeners by cloning
    const newBtn = scanBtn.cloneNode(true);
    scanBtn.parentNode.replaceChild(newBtn, scanBtn);
    newBtn.addEventListener('click', async () => {
      newBtn.querySelector('span').textContent = 'Scanning...';
      newBtn.disabled = true;
      await triggerScan();
      // Poll for completion
      const checkDone = setInterval(async () => {
        const health = await api('/health');
        if (health && !health.isScanning) {
          clearInterval(checkDone);
          newBtn.querySelector('span').textContent = 'Run Scan Now';
          newBtn.disabled = false;
          document.getElementById('lastScan').textContent = 'just now';
          await updateOverviewKPIs();
          await updateOptimizationLog();
          await updateLiveCampaigns();
          await updateOptTimeline();
          await updateAnalyticsPage();
          await updateCalendarAnalysisPage();
        }
      }, 3000);
    });
  }

  // Poll overview KPIs + scan state every 30 seconds
  pollInterval = setInterval(async () => {
    await updateOverviewKPIs();
  }, 30000);

  // Update optimization log and timeline every 60 seconds
  setInterval(async () => {
    await updateOptimizationLog();
    await updateOptTimeline();
  }, 60000);

  // Update analytics if already on that page
  setInterval(async () => {
    if (typeof analyticsChartsInitialized !== 'undefined' && analyticsChartsInitialized) {
      await updateAnalyticsPage();
    }
    if (
      typeof analyticsChartsInitialized !== 'undefined' &&
      !analyticsChartsInitialized &&
      typeof profitChartsInitialized !== 'undefined' &&
      profitChartsInitialized
    ) {
      await updateAnalyticsPage();
    }
    if (typeof fatigueChartInitialized !== 'undefined' && fatigueChartInitialized) {
      await updateFatiguePage();
    }
    if (typeof budgetChartsInitialized !== 'undefined' && budgetChartsInitialized) {
      await updateBudgetPage();
    }
    if (getActiveDashboardPage() === 'calendar') {
      await updateCalendarAnalysisPage();
    }
  }, 120000);

  return true;
}

function showLiveIndicator() {
  // Add live badge next to "Agent Active"
  const statusLabel = document.querySelector('.status-label');
  if (statusLabel) {
    statusLabel.innerHTML = 'Agent Active <span id="liveDot" style="display:inline-block;width:6px;height:6px;background:#4ade80;border-radius:50%;margin-left:4px;animation:livePulse 2s infinite"></span>';
  }

  // Add CSS animation
  if (!document.getElementById('liveStyles')) {
    const style = document.createElement('style');
    style.id = 'liveStyles';
    style.textContent = `
      @keyframes livePulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }
      .optimization-item { display: flex; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--color-divider); }
      .optimization-item:last-child { border-bottom: none; }
      .opt-icon { width: 36px; height: 36px; border-radius: 8px; background: var(--color-surface-alt); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .opt-icon i { width: 16px; height: 16px; color: var(--color-primary); }
      .opt-content { flex: 1; min-width: 0; }
      .opt-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
      .opt-action { font-weight: 600; font-size: 0.9rem; }
      .opt-target { font-size: 0.8rem; color: var(--color-text-muted); margin-bottom: 2px; }
      .opt-reason { font-size: 0.8rem; color: var(--color-text-faint); }
      .opt-impact { font-size: 0.8rem; color: var(--color-primary); margin-top: 2px; }
      .opt-time { font-size: 0.75rem; color: var(--color-text-faint); margin-top: 4px; }
      .optimization-item.executed { opacity: 0.7; }
      .btn-sm { padding: 2px 8px; font-size: 0.75rem; }
      .badge-info { background: rgba(32, 128, 141, 0.2); color: #20808D; }
      .badge-danger { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
      .empty-state { padding: 32px; text-align: center; color: var(--color-text-faint); }
      #optStats { font-size: 0.8rem; color: var(--color-text-faint); }
      .live-badge { display: inline-flex; align-items: center; gap: 4px; background: rgba(74, 222, 128, 0.15); color: #4ade80; padding: 2px 8px; border-radius: 999px; font-size: 0.7rem; font-weight: 600; }
    `;
    document.head.appendChild(style);
  }
}

// ── Helpers ──
function timeSince(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

// ═══════════════════════════════════════════
// INIT — Try live mode, fall back to static
// ═══════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  registerSeriesWindowRefresher('overview', updateOverviewKPIs);
  registerSeriesWindowRefresher('profit-structure', updateAnalyticsPage);
  registerSeriesWindowRefresher('media-profitability', updateAnalyticsPage);
  registerSeriesWindowRefresher('revenue-quality', updateAnalyticsPage);
  initSeriesWindowControls();
  initCalendarAnalysisControls();

  // Attempt live connection after static content loads
  setTimeout(() => startLiveMode(), 1500);
});
