(function () {
  const live = window.AdPilotLive;

  if (!live) {
    throw new Error('AdPilotLive core must load before series window helpers.');
  }

  const SERIES_WINDOW_OPTIONS = Object.freeze({
    '7d': { label: '7D', days: 7 },
    '14d': { label: '14D', days: 14 },
    '30d': { label: '30D', days: 30 },
    all: { label: 'All', days: null },
  });

  const DEFAULT_SERIES_WINDOWS = Object.freeze({
    overview: '30d',
    campaigns: '7d',
    'profit-structure': '30d',
    'media-profitability': '30d',
    'revenue-quality': 'all',
  });

  const seriesWindowState = { ...DEFAULT_SERIES_WINDOWS };
  const seriesWindowRefreshers = new Map();

  function getSeriesWindowMeta(group) {
    const selectedKey = seriesWindowState[group] || DEFAULT_SERIES_WINDOWS[group] || 'all';
    const option = SERIES_WINDOW_OPTIONS[selectedKey] || SERIES_WINDOW_OPTIONS.all;
    const isKorean = document.documentElement.lang === 'ko';
    return {
      key: selectedKey,
      ...option,
      label: selectedKey === 'all' && isKorean ? '전체' : option.label,
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

    document.addEventListener('click', async event => {
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

  live.seriesWindows = {
    getSeriesWindowMeta,
    sliceRowsByWindow,
    updateSeriesWindowBadges,
    registerSeriesWindowRefresher,
    initSeriesWindowControls,
  };
})();
