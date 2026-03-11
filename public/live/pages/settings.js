(function () {
  const live = window.AdPilotLive;
  const { fetchOverview, fetchAnalytics, fetchSettings } = live.api;
  const { tr, getLocale, localizeSystemText } = live.shared;

  function formatImwebAuthSource(source) {
    const labels = {
      none: tr('No token loaded', '로드된 토큰 없음'),
      disk: tr('Persisted token file', '저장된 토큰 파일'),
      env: tr('Environment refresh token', '환경 변수 리프레시 토큰'),
      seed: tr('Manual seed token', '수동 시드 토큰'),
    };
    return labels[source] || source || '—';
  }

  function formatImwebAuthStatus(status) {
    const map = {
      connected: { text: tr('Connected', '연결됨'), badge: 'badge-success' },
      degraded: { text: tr('Degraded', '저하됨'), badge: 'badge-warning' },
      error: { text: tr('Auth Error', '인증 오류'), badge: 'badge-error' },
      refresh_only: { text: tr('Needs Refresh', '갱신 필요'), badge: 'badge-warning' },
      access_only: { text: tr('Token Loaded', '토큰 로드됨'), badge: 'badge-warning' },
      misconfigured: { text: tr('Misconfigured', '설정 오류'), badge: 'badge-danger' },
      missing: { text: tr('Missing Token', '토큰 없음'), badge: 'badge-neutral' },
    };
    return map[status] || { text: status || tr('Unknown', '알 수 없음'), badge: 'badge-neutral' };
  }

  function formatImwebExpiry(expiresAt) {
    if (!expiresAt) return '—';
    const dt = new Date(expiresAt);
    if (Number.isNaN(dt.getTime())) return '—';
    return dt.toLocaleString(getLocale(), {
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
    return dt.toLocaleString(getLocale(), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatSourceStatus(source) {
    if (!source) return { text: tr('Unknown', '알 수 없음'), badge: 'badge-neutral' };
    if (source.stale) return { text: tr('Cached Data', '캐시 데이터'), badge: 'badge-warning' };

    const map = {
      connected: { text: tr('Fresh', '최신'), badge: 'badge-success' },
      loaded: { text: tr('Cached', '캐시됨'), badge: 'badge-neutral' },
      error: { text: tr('Unavailable', '사용 불가'), badge: 'badge-error' },
      unknown: { text: tr('Unknown', '알 수 없음'), badge: 'badge-neutral' },
    };
    return map[source.status] || { text: source.status || tr('Unknown', '알 수 없음'), badge: 'badge-neutral' };
  }

  function formatTelegramStatus(status) {
    const map = {
      connected: { text: tr('Connected', '연결됨'), badge: 'badge-success' },
      error: { text: tr('Error', '오류'), badge: 'badge-error' },
      misconfigured: { text: tr('Misconfigured', '설정 오류'), badge: 'badge-danger' },
      unknown: { text: tr('Checking', '확인 중'), badge: 'badge-neutral' },
    };
    return map[status] || { text: status || tr('Unknown', '알 수 없음'), badge: 'badge-neutral' };
  }

  function formatTelegramBotLabel(telegramStatus) {
    if (telegramStatus?.botUsername) {
      return '@' + telegramStatus.botUsername;
    }
    if (telegramStatus?.botId) {
      return tr('Bot #', '봇 #') + telegramStatus.botId;
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
          ? tr(' Persisted token and IMWEB_REFRESH_TOKEN differ. Reseed one canonical token source.', ' 저장된 토큰과 IMWEB_REFRESH_TOKEN이 다릅니다. 하나의 기준 토큰 소스로 다시 시드하세요.')
          : '';

        if (imwebData?.stale && imwebAuth?.lastError) {
          imwebAuthNoteEl.textContent = tr('Using cached revenue data. Latest Imweb sync failed: ', '캐시된 매출 데이터를 사용 중입니다. 최근 Imweb 동기화 실패: ') + localizeSystemText(imwebAuth.lastError) + tokenMismatchNote;
        } else if (imwebAuth?.lastError) {
          imwebAuthNoteEl.textContent = localizeSystemText(imwebAuth.lastError) + tokenMismatchNote;
        } else if (imwebAuth?.refreshTokenMismatch) {
          imwebAuthNoteEl.textContent = tr('Persisted token and IMWEB_REFRESH_TOKEN differ. Keep one canonical token source and reseed before the next refresh window.', '저장된 토큰과 IMWEB_REFRESH_TOKEN이 다릅니다. 하나의 기준 토큰 소스를 유지하고 다음 갱신 전에 다시 시드하세요.');
        } else if (imwebAuth?.status === 'connected') {
          imwebAuthNoteEl.textContent = tr('Refreshable token is healthy', '갱신 가능한 토큰 상태가 정상입니다');
        } else if (imwebAuth?.status === 'misconfigured') {
          imwebAuthNoteEl.textContent = tr('IMWEB_CLIENT_ID / IMWEB_CLIENT_SECRET missing', 'IMWEB_CLIENT_ID / IMWEB_CLIENT_SECRET이 없습니다');
        } else if (imwebAuth?.status === 'missing') {
          imwebAuthNoteEl.textContent = tr('No persisted or env refresh token available', '저장된 토큰 또는 환경 변수 리프레시 토큰이 없습니다');
        } else {
          imwebAuthNoteEl.textContent = tr('Waiting for first successful token refresh', '첫 성공적인 토큰 갱신 대기 중');
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
        imwebOrdersEl.textContent = tr(
          `${(k.totalOrders || 0).toLocaleString(getLocale())} orders${imwebData?.stale ? ' (stale)' : ''}`,
          `${(k.totalOrders || 0).toLocaleString(getLocale())}건 주문${imwebData?.stale ? ' (캐시)' : ''}`
        );
      }

      const imwebRevenueEl = document.getElementById('settingsImwebRevenue');
      if (imwebRevenueEl) {
        const grossRevenue = Math.round(k.revenue || 0);
        const refunded = Math.round(k.refunded || 0);
        const netRevenue = Math.round(k.netRevenue || 0);

        const revenueText = refunded > 0
          ? tr(`₩${grossRevenue.toLocaleString(getLocale())} gross · ₩${netRevenue.toLocaleString(getLocale())} net`, `총 ₩${grossRevenue.toLocaleString(getLocale())} · 순 ₩${netRevenue.toLocaleString(getLocale())}`)
          : '₩' + grossRevenue.toLocaleString(getLocale());
        imwebRevenueEl.textContent = imwebData?.stale ? revenueText + tr(' (stale)', ' (캐시)') : revenueText;
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
          telegramNoteEl.textContent = localizeSystemText(telegramStatus.lastError);
        } else if (telegramStatus?.status === 'connected') {
          telegramNoteEl.textContent = tr('Approval messages and scan summaries can be delivered.', '승인 메시지와 스캔 요약을 전달할 수 있습니다.');
        } else if (telegramStatus?.status === 'misconfigured') {
          telegramNoteEl.textContent = tr('Check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.', 'TELEGRAM_BOT_TOKEN과 TELEGRAM_CHAT_ID를 확인하세요.');
        } else {
          telegramNoteEl.textContent = tr('Waiting for first successful Telegram API check.', '첫 성공적인 Telegram API 확인 대기 중.');
        }
      }

      if (analyticsData) {
        const cogsItemsEl = document.getElementById('settingsCogsItems');
        if (cogsItemsEl) {
          cogsItemsEl.textContent = tr(
            `${(analyticsData.cogsItems || '—').toString()} items`,
            `${(analyticsData.cogsItems || '—').toString()}개 항목`
          );
        }
        const cogsTotalEl = document.getElementById('settingsCogs');
        if (cogsTotalEl) {
          const productCost = analyticsData.totalCOGS || 0;
          const shipping = analyticsData.totalShipping || 0;
          cogsTotalEl.textContent = productCost > 0
            ? tr(`₩${productCost.toLocaleString(getLocale())} product + ₩${shipping.toLocaleString(getLocale())} shipping`, `상품 ₩${productCost.toLocaleString(getLocale())} + 배송 ₩${shipping.toLocaleString(getLocale())}`)
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
