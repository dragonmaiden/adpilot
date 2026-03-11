(function () {
  const live = window.AdPilotLive;

  if (!live) {
    throw new Error('AdPilotLive core must load before shared helpers.');
  }

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

  function safeOptType(type) {
    return SAFE_OPT_TYPES.has(type) ? type : 'bid';
  }

  function safeConfidenceLevel(level) {
    return SAFE_CONFIDENCE_LEVELS.has(level) ? level : 'low';
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
    if (amount >= 1000000) return '₩' + (amount / 1000000).toFixed(1) + 'M';
    if (amount >= 1000) return '₩' + (amount / 1000).toFixed(0) + 'K';
    return '₩' + Math.round(amount).toLocaleString();
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

  function humanizeEnum(value) {
    return String(value || '—')
      .toLowerCase()
      .replace(/_/g, ' ')
      .replace(/\b\w/g, char => char.toUpperCase());
  }

  function timeSince(date) {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    return Math.floor(seconds / 86400) + 'd ago';
  }

  live.shared = {
    esc,
    safeOptType,
    safeConfidenceLevel,
    formatSignedKrw,
    formatCompactKrw,
    formatSignedCompactKrw,
    formatKrw,
    formatUsd,
    formatPercent,
    formatCount,
    humanizeEnum,
    timeSince,
  };
})();
