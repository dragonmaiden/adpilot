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

  function localizeOptimizationText(value) {
    const text = String(value || '');
    if (!isKorean()) return text;

    let match = text.match(/^Increase daily budget by (\$[\d.,]+) \((\d+)%\)$/);
    if (match) return `일일 예산 ${match[1]} (${match[2]}%) 증액`;

    match = text.match(/^Potential ([\d,]+) additional purchases\/day$/);
    if (match) return `하루 추가 구매 잠재 ${match[1]}건`;

    match = text.match(/^(\d+) optimizations · (\d+) errors$/);
    if (match) return `최적화 ${Number(match[1]).toLocaleString(getLocale())}건 · 오류 ${Number(match[2]).toLocaleString(getLocale())}건`;

    match = text.match(/^Last 7d CPA is (\$[\d.,]+) with ([\d,]+) purchases, while account true net profit is (₩[\d,]+) at ([\d.]+)% margin$/);
    if (match) return `최근 7일 CPA는 ${match[1]}, 구매 ${match[2]}건, 계정 실질 순이익은 ${match[3]}, 마진은 ${match[4]}%입니다`;

    match = text.match(/^Last 7d CPA is (\$[\d.,]+) with ([\d,]+) purchases — room to scale$/);
    if (match) return `최근 7일 CPA는 ${match[1]}, 구매 ${match[2]}건으로 확장 여지가 있습니다`;

    if (text === 'Failed to send Telegram approval request') {
      return '텔레그램 승인 요청 전송 실패';
    }
    if (text === 'Approval request sent to Telegram') {
      return '텔레그램으로 승인 요청 전송됨';
    }
    if (text === 'Already awaiting Telegram response') {
      return '이미 텔레그램 응답 대기 중';
    }
    if (text === 'Approved in Telegram') {
      return '텔레그램에서 승인됨';
    }
    if (text === 'Rejected in Telegram') {
      return '텔레그램에서 거절됨';
    }
    return text;
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

  function localizeCreativeText(value) {
    const text = String(value || '');
    if (!isKorean()) return text;

    let match = text.match(/^CTR is down ([\d.]+)% from peak\.?$/);
    if (match) return `CTR이 최고점 대비 ${match[1]}% 하락했습니다.`;

    match = text.match(/^CTR is down ([\d.]+)% from peak\. Recent CTR ([\d.]+)%\.$/);
    if (match) return `CTR이 최고점 대비 ${match[1]}% 하락했습니다. 최근 CTR은 ${match[2]}%입니다.`;

    match = text.match(/^Spent (\$[\d.,]+) with ([\d,]+) Meta-attributed purchases — manually paused or replaced by better creative$/);
    if (match) return `${match[1]}를 지출했고 메타 귀속 구매 ${match[2]}건이 발생했으며, 수동 중지되었거나 더 나은 크리에이티브로 교체되었습니다`;

    match = text.match(/^Spent (\$[\d.,]+) with zero Meta-attributed purchases — creative or targeting did not resonate$/);
    if (match) return `${match[1]}를 지출했지만 메타 귀속 구매가 없었습니다. 크리에이티브 또는 타게팅 반응이 약했습니다`;

    match = text.match(/^Good CTR \(([\d.]+)%\) but no Meta-attributed purchases — landing page or pricing may be the issue$/);
    if (match) return `CTR은 좋았지만(${match[1]}%) 메타 귀속 구매가 없었습니다. 랜딩 페이지 또는 가격 문제가 원인일 수 있습니다`;

    match = text.match(/^CTR dropped ([\d.]+)% from peak \(([\d.]+)% → ([\d.]+)%\) — audience fatigue$/);
    if (match) return `CTR이 최고점 대비 ${match[1]}% 하락했습니다 (${match[2]}% → ${match[3]}%). 오디언스 피로 가능성이 있습니다`;

    match = text.match(/^Stable delivery — CTR ([\d.]+)%, frequency ([\d.]+)\.$/);
    if (match) return `안정적 집행 — CTR ${match[1]}%, 빈도 ${match[2]}`;

    match = text.match(/^Recent CTR ([\d.]+)%\.$/);
    if (match) return `최근 CTR ${match[1]}%입니다.`;

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
    safeOptType,
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
    humanizeEnum,
    localizeOptimizationText,
    localizeSystemText,
    localizeCreativeText,
    timeSince,
  };
})();
