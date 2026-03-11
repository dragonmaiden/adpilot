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

  function formatTimestamp(value) {
    if (!value) return '—';
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return '—';
    return dt.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatSourceStatus(source) {
    if (!source) return { text: 'Unknown', badge: 'badge-neutral' };
    if (source.stale) return { text: 'Cached Data', badge: 'badge-warning' };

    const map = {
      connected: { text: 'Fresh', badge: 'badge-success' },
      loaded: { text: 'Cached', badge: 'badge-neutral' },
      error: { text: 'Unavailable', badge: 'badge-error' },
      unknown: { text: 'Unknown', badge: 'badge-neutral' },
    };
    return map[source.status] || { text: source.status || 'Unknown', badge: 'badge-neutral' };
  }

  function formatTelegramStatus(status) {
    const map = {
      connected: { text: 'Connected', badge: 'badge-success' },
      error: { text: 'Error', badge: 'badge-error' },
      misconfigured: { text: 'Misconfigured', badge: 'badge-danger' },
      unknown: { text: 'Checking', badge: 'badge-neutral' },
    };
    return map[status] || { text: status || 'Unknown', badge: 'badge-neutral' };
  }

  function formatTelegramBotLabel(telegramStatus) {
    if (telegramStatus?.botUsername) {
      return '@' + telegramStatus.botUsername;
    }
    if (telegramStatus?.botId) {
      return 'Bot #' + telegramStatus.botId;
    }
    return '—';
  }

  function maskChatId(chatId) {
    const value = String(chatId || '').trim();
    if (!value) return '—';
    if (value.length <= 4) return value;
    return value.slice(0, 2) + '•••' + value.slice(-2);
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
      const imwebData = settingsData?.imweb?.data || settingsData?.sources?.imweb || null;
      const telegramStatus = settingsData?.telegram || null;

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
        const tokenMismatchNote = imwebAuth?.refreshTokenMismatch
          ? ' Persisted token and IMWEB_REFRESH_TOKEN differ. Reseed one canonical token source.'
          : '';

        if (imwebData?.stale && imwebAuth?.lastError) {
          imwebAuthNoteEl.textContent = 'Using cached revenue data. Latest Imweb sync failed: ' + imwebAuth.lastError + tokenMismatchNote;
        } else if (imwebAuth?.lastError) {
          imwebAuthNoteEl.textContent = imwebAuth.lastError + tokenMismatchNote;
        } else if (imwebAuth?.refreshTokenMismatch) {
          imwebAuthNoteEl.textContent = 'Persisted token and IMWEB_REFRESH_TOKEN differ. Keep one canonical token source and reseed before the next refresh window.';
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

      const imwebDataStatusEl = document.getElementById('settingsImwebDataStatus');
      if (imwebDataStatusEl) {
        const statusMeta = formatSourceStatus(imwebData);
        imwebDataStatusEl.innerHTML = `<span class="badge ${statusMeta.badge}">${statusMeta.text}</span>`;
      }

      const imwebLastSyncEl = document.getElementById('settingsImwebLastSync');
      if (imwebLastSyncEl) {
        imwebLastSyncEl.textContent = formatTimestamp(imwebData?.lastSuccessAt);
      }

      const imwebOrdersEl = document.getElementById('settingsImwebOrders');
      if (imwebOrdersEl) {
        imwebOrdersEl.textContent = (k.totalOrders || 0) + ' orders' + (imwebData?.stale ? ' (stale)' : '');
      }

      const imwebRevenueEl = document.getElementById('settingsImwebRevenue');
      if (imwebRevenueEl) {
        const grossRevenue = Math.round(k.revenue || 0);
        const refunded = Math.round(k.refunded || 0);
        const netRevenue = Math.round(k.netRevenue || 0);

        const revenueText = refunded > 0
          ? '₩' + grossRevenue.toLocaleString() + ' gross · ₩' + netRevenue.toLocaleString() + ' net'
          : '₩' + grossRevenue.toLocaleString();
        imwebRevenueEl.textContent = imwebData?.stale ? revenueText + ' (stale)' : revenueText;
      }

      const telegramStatusEl = document.getElementById('settingsTelegramStatus');
      if (telegramStatusEl) {
        const statusMeta = formatTelegramStatus(telegramStatus?.status);
        telegramStatusEl.className = `badge ${statusMeta.badge}`;
        telegramStatusEl.textContent = statusMeta.text;
      }

      const telegramBotEl = document.getElementById('settingsTelegramBot');
      if (telegramBotEl) {
        telegramBotEl.textContent = formatTelegramBotLabel(telegramStatus);
      }

      const telegramChatEl = document.getElementById('settingsTelegramChat');
      if (telegramChatEl) {
        telegramChatEl.textContent = maskChatId(telegramStatus?.chatId);
      }

      const telegramLastCheckEl = document.getElementById('settingsTelegramLastCheck');
      if (telegramLastCheckEl) {
        telegramLastCheckEl.textContent = formatTimestamp(telegramStatus?.lastCheckedAt || telegramStatus?.lastOkAt);
      }

      const telegramNoteEl = document.getElementById('settingsTelegramNote');
      if (telegramNoteEl) {
        if (telegramStatus?.lastError) {
          telegramNoteEl.textContent = telegramStatus.lastError;
        } else if (telegramStatus?.status === 'connected') {
          telegramNoteEl.textContent = 'Approval messages and scan summaries can be delivered.';
        } else if (telegramStatus?.status === 'misconfigured') {
          telegramNoteEl.textContent = 'Check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.';
        } else {
          telegramNoteEl.textContent = 'Waiting for first successful Telegram API check.';
        }
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
