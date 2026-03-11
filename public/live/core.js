(function () {
  const existing = window.AdPilotLive || {};
  const pages = new Map();
  const initializedPages = new Set();
  let liveEnabled = false;
  let pageActivatedHandler = null;

  function initializePage(name) {
    if (!name || initializedPages.has(name)) return;
    const page = pages.get(name);
    if (!page) return;
    initializedPages.add(name);
    if (typeof page.init === 'function') {
      page.init();
    }
  }

  const live = {
    ...existing,
    registerPage(name, page) {
      if (!name || !page) return;
      pages.set(name, page);
    },
    initPage(name) {
      initializePage(name);
    },
    async refresh(name) {
      const target = name || this.getActivePage();
      if (!liveEnabled || !target) return null;
      initializePage(target);
      const page = pages.get(target);
      if (!page || typeof page.refresh !== 'function') return null;
      return page.refresh();
    },
    handlePageActivated(name) {
      initializePage(name);
      if (typeof pageActivatedHandler === 'function') {
        return pageActivatedHandler(name);
      }
      return null;
    },
    setLiveEnabled(enabled) {
      liveEnabled = !!enabled;
    },
    isLiveEnabled() {
      return liveEnabled;
    },
    setPageActivatedHandler(handler) {
      pageActivatedHandler = typeof handler === 'function' ? handler : null;
    },
    getActivePage() {
      return document.querySelector('.page.active')?.dataset.page || 'overview';
    },
  };

  window.AdPilotLive = live;
})();
