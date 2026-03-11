/* ============================================
   AdPilot — Live Data Layer
   Connects dashboard to backend API
   ============================================ */

const API_BASE = window.location.origin + '/api';
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

function formatCompactKrw(value) {
  const amount = Number.isFinite(value) ? value : 0;
  if (Math.abs(amount) >= 1_000_000) {
    return '₩' + (amount / 1_000_000).toFixed(1) + 'M';
  }
  return '₩' + (amount / 1000).toFixed(0) + 'K';
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
    ? formatCompactKrw(amount)
    : '-' + formatCompactKrw(Math.abs(amount));
}

function formatRateMetricDetail(metric, fallback) {
  if (!metric || metric.numerator == null || metric.denominator == null) {
    return fallback;
  }

  if (metric.unit === 'currency') {
    return `${formatCompactKrw(metric.numerator)} of ${formatCompactKrw(metric.denominator)}`;
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

function calcClientCpa(spend, purchases) {
  return purchases > 0 ? spend / purchases : 0;
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

function getUtcWeekKey(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map(value => Number.parseInt(value, 10));
  if (!year || !month || !day) return '';

  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday);
  return date.toISOString().slice(0, 10);
}

function buildWeeklyAggFromDaily(dailyRows, profitRows = []) {
  const weeks = {};

  for (const row of dailyRows) {
    const weekKey = getUtcWeekKey(row.date);
    if (!weekKey) continue;
    if (!weeks[weekKey]) {
      weeks[weekKey] = {
        week: weekKey,
        revenue: 0,
        refunded: 0,
        spend: 0,
        purchases: 0,
        profit: 0,
      };
    }

    weeks[weekKey].revenue += toFiniteNumber(row.revenue);
    weeks[weekKey].refunded += toFiniteNumber(row.refunded);
    weeks[weekKey].spend += toFiniteNumber(row.spend);
    weeks[weekKey].purchases += toFiniteNumber(row.purchases);
  }

  for (const row of profitRows) {
    const weekKey = getUtcWeekKey(row.date);
    if (!weekKey) continue;
    if (!weeks[weekKey]) {
      weeks[weekKey] = {
        week: weekKey,
        revenue: 0,
        refunded: 0,
        spend: 0,
        purchases: 0,
        profit: 0,
      };
    }

    weeks[weekKey].profit += toFiniteNumber(row.trueNetProfit ?? row.profit);
  }

  return Object.values(weeks)
    .sort((left, right) => left.week.localeCompare(right.week))
    .map(week => ({
      week: week.week,
      profit: Math.round(week.profit),
      revenue: week.revenue,
      refunded: week.refunded,
      spend: week.spend,
      purchases: week.purchases,
      cpa: Number.parseFloat(calcClientCpa(week.spend, week.purchases).toFixed(2)),
    }));
}

function buildWeekdayPerfFromDaily(dailyRows) {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const aggregates = dayNames.map(day => ({
    day,
    spend: 0,
    purchases: 0,
    revenue: 0,
    refunded: 0,
    orders: 0,
  }));

  for (const row of dailyRows) {
    const [year, month, day] = String(row.date || '').split('-').map(value => Number.parseInt(value, 10));
    if (!year || !month || !day) continue;

    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const aggregate = aggregates[weekday];
    aggregate.spend += toFiniteNumber(row.spend);
    aggregate.purchases += toFiniteNumber(row.purchases);
    aggregate.revenue += toFiniteNumber(row.revenue);
    aggregate.refunded += toFiniteNumber(row.refunded);
    aggregate.orders += toFiniteNumber(row.orders);
  }

  return aggregates.map(aggregate => ({
    day: aggregate.day,
    spend: aggregate.spend,
    purchases: aggregate.purchases,
    cpa: Number.parseFloat(calcClientCpa(aggregate.spend, aggregate.purchases).toFixed(2)),
    revenue: aggregate.revenue,
    refunded: aggregate.refunded,
    orders: aggregate.orders,
    paid: aggregate.revenue,
    net: aggregate.revenue - aggregate.refunded,
  }));
}

function buildMonthlyRefundsFromDaily(dailyRows) {
  const months = {};

  for (const row of dailyRows) {
    const monthKey = String(row.date || '').slice(0, 7);
    if (!monthKey) continue;
    if (!months[monthKey]) {
      months[monthKey] = { month: monthKey, revenue: 0, refunded: 0 };
    }
    months[monthKey].revenue += toFiniteNumber(row.revenue);
    months[monthKey].refunded += toFiniteNumber(row.refunded);
  }

  return Object.values(months).sort((left, right) => left.month.localeCompare(right.month));
}

function buildCoverageMeta(waterfallRows) {
  const rows = sortRowsByDate(waterfallRows, 'date');
  if (rows.length === 0) {
    return {
      totalDays: 0,
      daysWithCOGS: 0,
      coverageRatio: 0,
      cogsCoveredRange: {},
      missingRanges: [],
      confidence: { level: 'low', label: 'Waiting for data' },
    };
  }

  const coveredRows = rows.filter(row => row.hasCOGS);
  const missingRows = rows.filter(row => !row.hasCOGS);
  const coverageRatio = coveredRows.length / rows.length;

  let confidence = { level: 'low', label: 'Low confidence' };
  if (coverageRatio >= 0.9) {
    confidence = { level: 'high', label: 'High confidence' };
  } else if (coverageRatio >= 0.6) {
    confidence = { level: 'medium', label: 'Medium confidence' };
  }

  return {
    totalDays: rows.length,
    daysWithCOGS: coveredRows.length,
    coverageRatio,
    cogsCoveredRange: coveredRows.length > 0
      ? { from: coveredRows[0].date, to: coveredRows[coveredRows.length - 1].date }
      : {},
    missingRanges: missingRows.map(row => row.date),
    confidence,
  };
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
async function updateDashboard() {
  const data = await fetchOverview();
  if (!data) return;

  const k = data.kpis;

  // Update KPI cards that have data-live attributes
  updateKPI('liveRevenue', '₩' + Math.round(k.revenue || 0).toLocaleString());
  updateKPI('liveAdSpend', '$' + (k.adSpend || 0).toFixed(0));
  updateKPI('liveROAS', k.roas != null ? k.roas.toFixed(2) + 'x' : '—');
  updateKPI('livePurchases', (k.purchases || 0).toString());
  updateKPI('liveCPA', k.cpa != null ? '$' + k.cpa.toFixed(2) : '—');
  updateKPI('liveCTR', (k.ctr || 0).toFixed(2) + '%');
  updateKPI('liveRefundRate', (k.refundRate || 0).toFixed(1) + '%');
  updateKPI('liveNetRevenue', '₩' + Math.round(k.netRevenue || 0).toLocaleString());

  // Update last scan time
  if (data.lastScan) {
    const ago = timeSince(new Date(data.lastScan));
    const el = document.getElementById('lastScan');
    if (el) el.textContent = ago;
  }

  // Update scanning state
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

  // Pulse the live indicator
  const liveDot = document.getElementById('liveDot');
  if (liveDot) liveDot.classList.add('pulse');
  setTimeout(() => { if (liveDot) liveDot.classList.remove('pulse'); }, 1000);
}

// ── Overview KPIs from /api/overview ──
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
      const budget = c.daily_budget ? `$${(parseInt(c.daily_budget) / 100).toFixed(2)}` : '-';
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

    const febRefundEl = document.querySelector('[data-kpi-analytics="febRefundRate"] .kpi-value');
    if (febRefundEl && data.febRefundRate != null) {
      febRefundEl.textContent = data.febRefundRate.toFixed(1) + '%';
    }
    const febSubEl = document.querySelector('[data-kpi-analytics="febRefundRate"] .kpi-delta span');
    if (febSubEl) {
      const febData = (data.charts?.monthlyRefunds || []).find(m => m.month === '2026-02');
      if (febData) febSubEl.textContent = '₩' + (febData.refunded / 1000).toFixed(0) + 'K refunded of ₩' + (febData.revenue / 1000000).toFixed(1) + 'M';
    }

    const marRefundEl = document.querySelector('[data-kpi-analytics="marRefundRate"] .kpi-value');
    if (marRefundEl && data.marRefundRate != null) {
      marRefundEl.textContent = data.marRefundRate.toFixed(1) + '%';
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
    const profitWeeklyAgg = buildWeeklyAggFromDaily(profitDaily, profitWaterfall);
    const mediaDaily = sliceRowsByWindow(allDailyMerged, 'media-profitability');
    const mediaWeeklyAgg = buildWeeklyAggFromDaily(mediaDaily);
    const weekdayPerf = buildWeekdayPerfFromDaily(mediaDaily);
    const qualityDaily = sliceRowsByWindow(allDailyMerged, 'revenue-quality');
    const monthlyRefunds = buildMonthlyRefundsFromDaily(qualityDaily);

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
  const coverage = buildCoverageMeta(waterfall);
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
        return sum + (c.daily_budget ? parseInt(c.daily_budget) / 100 : 0);
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
        .reduce((sum, c) => sum + (c.daily_budget ? parseInt(c.daily_budget) / 100 : 0), 0) : 110;

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
  try { await updateDashboard(); } catch (e) { console.warn('[LIVE] updateDashboard error:', e.message); }
  try { await updateOverviewKPIs(); } catch (e) { console.warn('[LIVE] updateOverviewKPIs error:', e.message); }
  try { await updateOptimizationLog(); } catch (e) { console.warn('[LIVE] updateOptimizationLog error:', e.message); }
  try { await updateLiveCampaigns(); } catch (e) { console.warn('[LIVE] updateLiveCampaigns error:', e.message); }
  try { await updateOptTimeline(); } catch (e) { console.warn('[LIVE] updateOptTimeline error:', e.message); }
  try { await updateAnalyticsPage(); } catch (e) { console.warn('[LIVE] updateAnalyticsPage error:', e.message); }
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
          await updateDashboard();
          await updateOverviewKPIs();
          await updateOptimizationLog();
          await updateLiveCampaigns();
          await updateOptTimeline();
          await updateAnalyticsPage();
        }
      }, 3000);
    });
  }

  // Poll every 30 seconds
  pollInterval = setInterval(async () => {
    await updateDashboard();
  }, 30000);

  // Update optimization log and timeline every 60 seconds
  setInterval(async () => {
    await updateOptimizationLog();
    await updateOptTimeline();
    await updateOverviewKPIs();
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
function updateKPI(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

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

  // Attempt live connection after static content loads
  setTimeout(() => startLiveMode(), 1500);
});
