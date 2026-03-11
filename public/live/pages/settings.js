(function () {
  const live = window.AdPilotLive;
  const { fetchOverview, fetchAnalytics, fetchSettings } = live.api;

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

  async function refreshSettingsPage() {
    try {
      const [overview, analyticsData, settingsData] = await Promise.all([
        fetchOverview(),
        fetchAnalytics(),
        fetchSettings(),
      ]);
      const k = overview?.kpis || {};
      const imwebAuth = settingsData?.imweb?.auth || null;

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
      console.warn('[LIVE] refreshSettingsPage error:', e.message);
    }
  }

  live.registerPage('settings', {
    refresh: refreshSettingsPage,
  });
})();
