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
    'profit-structure': 'all',
    'order-patterns': 'all',
  });
  const SERIES_WINDOW_GROUP_CONTEXT = Object.freeze({
    'profit-structure': { page: 'analytics' },
    'order-patterns': { page: 'analytics' },
  });

  const seriesWindowState = { ...DEFAULT_SERIES_WINDOWS };
  const seriesWindowRefreshers = new Map();

  function translate(enValue, krValue) {
    return live.shared?.tr ? live.shared.tr(enValue, krValue) : (document.documentElement.lang === 'ko' ? krValue : enValue);
  }

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

  function ensureSeriesWindowStatus(groupEl) {
    const group = groupEl?.dataset?.seriesWindowGroup;
    const toolbar = groupEl?.closest('.range-toolbar');
    if (!group || !toolbar) return null;

    let statusEl = toolbar.querySelector(`[data-series-window-status="${group}"]`);
    if (!statusEl) {
      statusEl = document.createElement('span');
      statusEl.className = 'range-toolbar-status';
      statusEl.dataset.seriesWindowStatus = group;
      statusEl.setAttribute('aria-live', 'polite');
      statusEl.setAttribute('aria-atomic', 'true');
      toolbar.appendChild(statusEl);
    }

    return statusEl;
  }

  function setSeriesWindowPageLoading(group, isLoading) {
    const context = SERIES_WINDOW_GROUP_CONTEXT[group];
    const page = context?.page;
    if (!page) return;

    const pageEl = document.querySelector(`.page[data-page="${page}"]`);
    if (!pageEl) return;

    if (isLoading) {
      pageEl.dataset.seriesWindowLoading = group;
      return;
    }

    if (pageEl.dataset.seriesWindowLoading === group) {
      delete pageEl.dataset.seriesWindowLoading;
    }
  }

  function setSeriesWindowLoading(group, isLoading) {
    const statusText = isLoading
      ? translate(
          `Refreshing ${getSeriesWindowMeta(group).label} view...`,
          `${getSeriesWindowMeta(group).label} 보기 업데이트 중...`
        )
      : '';

    document.querySelectorAll(`[data-series-window-group="${group}"]`).forEach(groupEl => {
      groupEl.dataset.loading = isLoading ? 'true' : 'false';
      groupEl.setAttribute('aria-busy', isLoading ? 'true' : 'false');
      groupEl.querySelectorAll('[data-series-window-value]').forEach(button => {
        button.disabled = isLoading;
      });

      const statusEl = ensureSeriesWindowStatus(groupEl);
      if (statusEl) {
        statusEl.textContent = statusText;
        statusEl.dataset.visible = isLoading ? 'true' : 'false';
      }
    });

    setSeriesWindowPageLoading(group, isLoading);
  }

  function waitForNextPaint() {
    return new Promise(resolve => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(resolve);
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
    document.querySelectorAll('[data-series-window-group]').forEach(groupEl => {
      ensureSeriesWindowStatus(groupEl);
    });

    document.addEventListener('click', async event => {
      const button = event.target.closest('[data-series-window-value]');
      if (!button) return;

      const groupEl = button.closest('[data-series-window-group]');
      const group = groupEl?.dataset.seriesWindowGroup;
      const nextValue = button.dataset.seriesWindowValue;
      if (!group || !SERIES_WINDOW_OPTIONS[nextValue]) return;
      if (groupEl?.dataset.loading === 'true') return;
      if (seriesWindowState[group] === nextValue) return;

      seriesWindowState[group] = nextValue;
      syncSeriesWindowControls();
      setSeriesWindowLoading(group, true);

      try {
        await waitForNextPaint();
        await refreshSeriesWindowGroup(group);
      } finally {
        setSeriesWindowLoading(group, false);
      }
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
