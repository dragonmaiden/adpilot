(function () {
  const live = window.AdPilotLive;

  if (!live) {
    throw new Error('AdPilotLive core must load before shared helpers.');
  }

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

  function safeConfidenceLevel(level) {
    return SAFE_CONFIDENCE_LEVELS.has(level) ? level : 'low';
  }

  function isKorean() {
    return document.documentElement.lang === 'ko';
  }

  function getLocale() {
    return isKorean() ? 'ko-KR' : 'en-US';
  }

  function tr(enValue, krValue) {
    return isKorean() ? krValue : enValue;
  }

  function formatSignedKrw(value) {
    const amount = Number.isFinite(value) ? value : 0;
    return amount >= 0
      ? '₩' + Math.round(amount).toLocaleString()
      : '-₩' + Math.abs(Math.round(amount)).toLocaleString();
  }

  function formatCompactKrw(value) {
    const amount = Number.isFinite(value) ? value : 0;
    if (typeof formatKRW === 'function') {
      return formatKRW(amount);
    }
    return formatKrw(amount);
  }

  function formatSignedCompactKrw(value) {
    const amount = Number.isFinite(value) ? value : 0;
    return amount >= 0
      ? formatCompactKrw(amount)
      : '-' + formatCompactKrw(Math.abs(amount));
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

  function formatKstTimestamp(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';

    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date).replace(':', '.').replace(/\s/g, '').toLowerCase();
  }

  function humanizeEnum(value) {
    return String(value || '—')
      .toLowerCase()
      .replace(/_/g, ' ')
      .replace(/\b\w/g, char => char.toUpperCase());
  }

  function localizeSystemText(value) {
    const text = String(value || '');
    if (!isKorean()) return text;

    const fixedMap = {
      'TELEGRAM_BOT_TOKEN format is invalid': 'TELEGRAM_BOT_TOKEN 형식이 올바르지 않습니다',
      'No Imweb tokens available. Set IMWEB_REFRESH_TOKEN env var for first deploy.': '사용 가능한 Imweb 토큰이 없습니다. 첫 배포를 위해 IMWEB_REFRESH_TOKEN 환경 변수를 설정하세요.',
      'No persisted or env refresh token available': '저장된 토큰 또는 환경 변수 리프레시 토큰이 없습니다',
      'IMWEB_CLIENT_ID / IMWEB_CLIENT_SECRET missing': 'IMWEB_CLIENT_ID / IMWEB_CLIENT_SECRET이 없습니다',
      'chat not found': '채팅을 찾을 수 없습니다',
      'Refreshable token is healthy': '갱신 가능한 토큰 상태가 정상입니다',
      'Waiting for first successful token refresh': '첫 성공적인 토큰 갱신 대기 중',
    };

    if (fixedMap[text]) return fixedMap[text];
    return text;
  }

  function timeSince(date) {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return tr('just now', '방금 전');
    if (seconds < 3600) return tr(`${Math.floor(seconds / 60)} min ago`, `${Math.floor(seconds / 60)}분 전`);
    if (seconds < 86400) return tr(`${Math.floor(seconds / 3600)}h ago`, `${Math.floor(seconds / 3600)}시간 전`);
    return tr(`${Math.floor(seconds / 86400)}d ago`, `${Math.floor(seconds / 86400)}일 전`);
  }

  live.shared = {
    esc,
    safeConfidenceLevel,
    isKorean,
    getLocale,
    tr,
    formatSignedKrw,
    formatCompactKrw,
    formatSignedCompactKrw,
    formatKrw,
    formatUsd,
    formatPercent,
    formatCount,
    formatKstTimestamp,
    humanizeEnum,
    localizeSystemText,
    timeSince,
  };
})();
