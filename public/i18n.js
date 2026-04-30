// ═══════════════════════════════════════════════════════
// AdPilot — Internationalization (EN / KR)
// ═══════════════════════════════════════════════════════

const I18N = {
  // ── Navigation ──
  'nav.overview':       { en: 'Summary',  kr: '요약' },
  'nav.analytics':      { en: 'Profit Summary', kr: '수익 요약' },
  'nav.calendar':       { en: 'Calendar', kr: '캘린더' },
  'nav.settings':       { en: 'Status',   kr: '상태' },

  // ── Header ──
  'header.lastScan':    { en: 'Last sync:',        kr: '마지막 동기화:' },
  'header.metaAds':     { en: 'Meta Ads',          kr: 'Meta 광고' },
  'header.imweb':       { en: 'Imweb',             kr: 'Imweb' },
  'header.googleSheets': { en: 'Google Sheets',    kr: 'Google Sheets' },

  // ── Page Titles ──
  'page.overview':      { en: 'Summary',  kr: '요약' },
  'page.analytics':     { en: 'Profit Summary', kr: '수익 요약' },
  'page.calendar':      { en: 'Calendar', kr: '캘린더' },
  'page.settings':      { en: 'Status',   kr: '상태' },

  // ── Overview KPI Labels ──
  'kpi.revenue':        { en: 'Revenue (Imweb)',    kr: '매출 (Imweb)' },
  'kpi.cogs':           { en: 'COGS',              kr: '매출원가' },
  'kpi.adspend':        { en: 'Ad Spend (Meta)',    kr: '광고비 (Meta)' },
  'kpi.profit':         { en: 'Gross Profit',       kr: '매출총이익' },
  'kpi.roas':           { en: 'ROAS',              kr: 'ROAS' },
  'kpi.purchases':      { en: 'Purchases (COGS)',   kr: '구매 (COGS)' },
  'kpi.ctr':            { en: 'CTR',               kr: 'CTR' },
  'kpi.cpa':            { en: 'Cost per Purchase',  kr: '구매당 비용' },

  // ── Overview Chart Titles ──
  'chart.revenueVsSpend': { en: 'Revenue vs Ad Spend', kr: '매출 vs 광고비' },
  'chart.dailyRoas':      { en: 'Daily ROAS',          kr: '일별 ROAS' },
  'chart.ctrCpc':         { en: 'CTR & CPC Trend',     kr: 'CTR & CPC 추이' },
  'chart.revenueByBrand': { en: 'Revenue by Brand',    kr: '브랜드별 매출' },
  'btn.viewAll':          { en: 'View All',            kr: '전체 보기' },
  'misc.createdWith':     { en: 'Created with Perplexity Computer', kr: 'Perplexity Computer로 제작됨' },
  'misc.all':             { en: 'All', kr: '전체' },
  'misc.day':             { en: 'Day', kr: '일' },
  'misc.week':            { en: 'Week', kr: '주' },
  'misc.month':           { en: 'Month', kr: '월' },
  'misc.waiting':         { en: 'Waiting', kr: '대기 중' },
  'misc.unknown':         { en: 'Unknown', kr: '알 수 없음' },

  // ── Overview Page Details ──
  'overview.trendsKicker': { en: 'Overview Trends', kr: '요약 추이' },
  'overview.trendsTitle':  { en: 'Daily revenue and efficiency', kr: '일별 매출 및 효율' },
  'overview.window':       { en: 'Time frame', kr: '기간' },
  'overview.windowAria':   { en: 'Overview trend time frame', kr: '요약 추이 기간 선택' },
  'overview.hourSubtitle': { en: 'All synced Imweb orders', kr: '동기화된 Imweb 주문 전체' },
  'overview.hourSource':   { en: 'Source: Imweb', kr: '소스: Imweb' },
  'overview.placeholderRevenue': { en: '— orders · — AOV', kr: '—건 주문 · 객단가 —' },
  'overview.placeholderMargin':  { en: '— margin', kr: '마진 —' },
  'overview.placeholderAvgDay':  { en: '— avg/day', kr: '일평균 —' },

  // ── Analytics KPIs ──
  'kpi.refundRate':     { en: 'Refund Rate (₩)',        kr: '환불률 (₩)' },
  'kpi.cancelRate':     { en: 'Cancel Rate (Sections)',  kr: '취소율 (섹션)' },
  'kpi.febRefund':      { en: 'Feb Refund Rate',        kr: '2월 환불률' },
  'kpi.marRefund':      { en: 'Mar Refund Rate',        kr: '3월 환불률' },

  // ── Analytics Chart Titles ──
  'chart.weekdayPerf':      { en: 'Ad Performance by Weekday',  kr: '요일별 광고 성과' },
  'chart.mediaEfficiency':  { en: 'Media Efficiency',           kr: '매체 효율' },
  'chart.hourVolume':       { en: 'Order Timing Distribution (KST)', kr: '주문 시간대 분포 (KST)' },
  'chart.monthlyRefund':    { en: 'Monthly Refund Comparison',  kr: '월별 환불 비교' },
  'chart.weekdayRevenue':   { en: 'Revenue by Day of Week',     kr: '요일별 매출' },
  'analytics.sectionKicker': { en: 'Profit Summary', kr: '수익 요약' },
  'analytics.sectionTitle':  { en: 'True profit and cost summary', kr: '실질 수익 및 비용 요약' },
  'analytics.sectionNote':   { en: 'Revenue, refunds, total costs, and true net profit in one place.', kr: '매출, 환불, 총비용, 실질 순이익을 한 곳에서 확인합니다.' },
  'analytics.hero.margin':   { en: 'Margin', kr: '마진' },
  'analytics.hero.trueRoas': { en: 'True ROAS', kr: '실질 ROAS' },
  'analytics.hero.runRate':  { en: '30d run rate', kr: '30일 런레이트' },
  'analytics.hero.waiting':  { en: 'Waiting for data...', kr: '데이터 대기 중...' },
  'analytics.hero.latestWaiting': { en: 'Latest completed day: waiting for covered data.', kr: '최신 완료일: 원가 포함 데이터 대기 중.' },
  'analytics.structureKicker': { en: 'Profit Structure', kr: '수익 구조' },
  'analytics.structureTitle':  { en: 'Revenue and cost movement', kr: '매출 및 비용 흐름' },
  'analytics.operationsKicker': { en: 'Operations Summary', kr: '운영 요약' },
  'analytics.operationsTitle': { en: 'Refund and order quality', kr: '환불 및 주문 품질' },
  'analytics.mediaKicker':    { en: 'Media Profitability', kr: '매체 수익성' },
  'analytics.mediaTitle':     { en: 'Which traffic patterns and campaigns create profit', kr: '어떤 트래픽 패턴과 캠페인이 수익을 만드는지' },
  'analytics.qualityKicker':  { en: 'Revenue Quality', kr: '매출 품질' },
  'analytics.qualityTitle':   { en: 'Refund pressure and settlement validation', kr: '환불 압력 및 정산 검증' },
  'analytics.window':         { en: 'Time frame', kr: '기간' },
  'analytics.windowStructureAria': { en: 'Profit structure time frame', kr: '수익 구조 기간 선택' },
  'analytics.windowMediaAria': { en: 'Media profitability time frame', kr: '매체 수익성 기간 선택' },
  'analytics.windowQualityAria': { en: 'Revenue quality time frame', kr: '매출 품질 기간 선택' },
  'analytics.kpi.grossRevenue': { en: 'Gross Revenue', kr: '총매출' },
  'analytics.kpi.netRevenue': { en: 'Net Revenue', kr: '순매출' },
  'analytics.kpi.refunds': { en: 'Refunds', kr: '환불' },
  'analytics.kpi.totalCosts': { en: 'Total Costs', kr: '총비용' },
  'analytics.kpi.trueNetProfit': { en: 'True Net Profit', kr: '실질 순이익' },
  'analytics.kpi.cogsCoverage': { en: 'COGS Coverage', kr: 'COGS 커버리지' },
  'analytics.kpi.blendedMargin': { en: 'Blended Margin', kr: '혼합 마진' },
  'analytics.kpi.trueRoas': { en: 'True ROAS', kr: '실질 ROAS' },
  'analytics.kpi.runRate30d': { en: '30d Profit Run Rate', kr: '30일 수익 런레이트' },
  'analytics.waterfallTitle': { en: 'Profit Movement', kr: '수익 흐름' },
  'analytics.waterfallGranularityAria': { en: 'Profit movement granularity', kr: '수익 흐름 단위 선택' },
  'analytics.coverageWaiting': { en: 'Waiting for data...', kr: '데이터 대기 중...' },
  'analytics.leaderboardTitle': { en: 'Campaign Profit Leaderboard', kr: '캠페인 수익 리더보드' },
  'analytics.leaderboardNote': { en: 'Revenue estimated (pixel-attributed) · 30D time frame', kr: '매출은 픽셀 귀속 기준 추정 · 30일 기준' },
  'analytics.leaderboardTableTitle': { en: 'Campaign estimates', kr: '캠페인 추정치' },
  'analytics.leaderboardTableNote': { en: 'Revenue model, spend, estimated ROAS, and margin.', kr: '매출 모델, 지출, 추정 ROAS, 마진.' },
  'analytics.leaderboard.estRevenue': { en: 'Est. Revenue', kr: '추정 매출' },
  'analytics.leaderboard.estCogs': { en: 'Est. COGS', kr: '추정 원가' },
  'analytics.leaderboard.grossProfit': { en: 'Gross Profit', kr: '매출총이익' },
  'analytics.leaderboard.estRoas': { en: 'Est. ROAS', kr: '추정 ROAS' },
  'analytics.leaderboard.margin': { en: 'Margin %', kr: '마진 %' },
  'analytics.reconciliationTitle': { en: 'Settlement Reconciliation', kr: '정산 대사' },
  'analytics.reconciliationDesc': { en: 'Card settlement rows are treated as validation only. They are not added into revenue totals.', kr: '카드 정산 행은 검증용으로만 사용되며 매출 합계에는 더해지지 않습니다.' },
  'analytics.reconciliationWaiting': { en: 'Waiting for reconciliation data...', kr: '정산 대사 데이터 대기 중...' },
  'analytics.reconciliationRollupTitle': { en: 'Daily Reconciliation Rollup', kr: '일별 정산 롤업' },
  'analytics.reconciliationWindowDefault': { en: 'Match time frame —', kr: '매칭 범위 —' },
  'analytics.recon.matchedNet': { en: 'Matched Net', kr: '일치 순액' },
  'analytics.recon.unmatchedSettlement': { en: 'Unmatched Settlement', kr: '미일치 정산' },
  'analytics.recon.unmatchedImweb': { en: 'Unmatched Imweb', kr: '미일치 Imweb' },
  'analytics.recon.methodMismatch': { en: 'Method Mismatch', kr: '결제 방식 차이' },
  'calendar.sectionKicker':   { en: 'Calendar', kr: '캘린더' },
  'calendar.sectionTitle':    { en: 'Zoom into any day or date range', kr: '특정 날짜나 기간을 자세히 보기' },
  'calendar.sectionNote':     { en: 'Revenue heatmap · click or drag dates · KST', kr: '매출 히트맵 · 날짜 클릭/드래그 · KST' },
  'calendar.date':            { en: 'Date', kr: '날짜' },
  'calendar.prev':            { en: 'Previous', kr: '이전' },
  'calendar.today':           { en: 'Today', kr: '오늘' },
  'calendar.next':            { en: 'Next', kr: '다음' },
  'calendar.loading':         { en: 'Loading calendar analysis...', kr: '캘린더 분석 불러오는 중...' },
  'calendar.selectedTitle':   { en: 'Selected Range', kr: '선택한 범위' },
  'calendar.selectedHint':    { en: 'Choose a day or drag across a period', kr: '날짜를 선택하거나 범위를 드래그하세요' },
  'calendar.selectedDesc':    { en: 'The drilldown will populate with profit, orders, refunds, campaign estimates, and product mix for the selected KST date range.', kr: '선택한 KST 날짜 범위에 대한 수익, 주문, 환불, 캠페인 추정치, 상품 구성이 아래에 표시됩니다.' },
  'calendar.settlementNet':   { en: 'Settlement Net', kr: '정산 순액' },
  'calendar.imwebNet':        { en: 'Imweb Net', kr: 'Imweb 순액' },
  'calendar.settlementGap':   { en: 'Settlement Gap', kr: '정산 차이' },
  'calendar.imwebGap':        { en: 'Imweb Gap', kr: 'Imweb 차이' },

  // ── Analytics Table Headers ──
  'th.day':             { en: 'Day',               kr: '요일' },
  'th.orders':          { en: 'Orders',            kr: '주문수' },
  'th.revenuePaid':     { en: 'Revenue (Paid)',    kr: '매출 (결제)' },
  'th.refunded':        { en: 'Refunded',          kr: '환불' },
  'th.netRevenue':      { en: 'Net Revenue',       kr: '순매출' },
  'th.adSpend':         { en: 'Ad Spend',          kr: '광고비' },
  'th.purchasesPixel':  { en: 'Meta-attributed Purchases', kr: '메타 귀속 구매' },
  'th.cpa':             { en: 'CPA',               kr: 'CPA' },

  'th.campaign':        { en: 'Campaign',          kr: '캠페인' },
  'th.status':          { en: 'Status',            kr: '상태' },
  'th.dailyBudget':     { en: 'Daily Budget',      kr: '일일 예산' },
  'th.spendWindow':     { en: 'Spend',             kr: '지출' },
  'th.purchases':       { en: 'Purchases',         kr: '구매' },
  'th.ctr':             { en: 'CTR',               kr: 'CTR' },
  'th.actions':         { en: 'Actions',           kr: '관리' },

  'th.time':            { en: 'Time',               kr: '시간' },
  'th.target':          { en: 'Target',             kr: '대상' },
  'th.scope':           { en: 'Scope',              kr: '범위' },
  'th.actionTaken':     { en: 'Action',             kr: '조치' },
  'th.reason':          { en: 'Reason',             kr: '사유' },

  // ── Settings Page ──
  'settings.sectionKicker': { en: 'Status', kr: '상태' },
  'settings.sectionTitle':  { en: 'Data source health', kr: '데이터 소스 상태' },
  'settings.sectionNote':   { en: 'Connection status and freshness for the data sources behind profit reporting.', kr: '수익 리포팅에 쓰이는 데이터 소스 연결 상태와 최신성을 확인합니다.' },
  'settings.longLivedToken': { en: 'Long-lived, ~60 days', kr: '장기 토큰, 약 60일' },

  // API connections
  'settings.metaApi':       { en: 'Meta Ads API Connection',  kr: 'Meta 광고 API 연결' },
  'settings.imwebStore':    { en: 'Imweb Store Connection',    kr: 'Imweb 스토어 연결' },
  'settings.cogsData':      { en: 'COGS Data (Google Sheets)', kr: '매출원가 데이터 (Google Sheets)' },
  'settings.cogsRangeFallback': { en: 'Feb 8 – Feb 28, 2026 (no March data)', kr: '2026년 2월 8일 – 2월 28일 (3월 데이터 없음)' },
  'settings.connStatus':    { en: 'Connection Status',         kr: '연결 상태' },
  'settings.connected':     { en: 'Connected',                kr: '연결됨' },
  'settings.partial':       { en: 'Partial',                  kr: '부분 연결' },
  'settings.adAccount':     { en: 'Ad Account',               kr: '광고 계정' },
  'settings.accessToken':   { en: 'Access Token',             kr: '액세스 토큰' },
  'settings.businessId':    { en: 'Business ID',              kr: '비즈니스 ID' },
  'settings.permissions':   { en: 'Permissions',              kr: '권한' },
  'settings.store':         { en: 'Store',                    kr: '스토어' },
  'settings.siteCode':      { en: 'Site Code',                kr: '사이트 코드' },
  'settings.scopes':        { en: 'Scopes',                   kr: '범위' },
  'settings.tokenSource':   { en: 'Token Source',             kr: '토큰 소스' },
  'settings.tokenExpiry':   { en: 'Token Expiry',             kr: '토큰 만료' },
  'settings.authNote':      { en: 'Auth Note',                kr: '인증 메모' },
  'settings.dataFreshness': { en: 'Data Freshness',           kr: '데이터 최신성' },
  'settings.lastRevenueSync': { en: 'Last Revenue Sync',      kr: '최근 매출 동기화' },
  'settings.totalOrders':   { en: 'Total Orders',             kr: '총 주문수' },
  'settings.revenue':       { en: 'Revenue',                  kr: '매출' },
  'settings.source':        { en: 'Source',                   kr: '소스' },
  'settings.coverage':      { en: 'Coverage',                 kr: '범위' },
  'settings.dataNote':      { en: 'Data Note',                kr: '데이터 메모' },
  'settings.lineItems':     { en: 'Line Items',               kr: '항목수' },
  'settings.totalCogs':     { en: 'Total COGS',               kr: '총 매출원가' },
  'settings.telegramBot':   { en: 'Telegram Approval Bot',    kr: '텔레그램 승인 봇' },
  'settings.bot':           { en: 'Bot',                      kr: '봇' },
  'settings.chat':          { en: 'Chat',                     kr: '채팅' },
  'settings.lastCheck':     { en: 'Last Check',               kr: '최근 확인' },
  'settings.botNote':       { en: 'Bot Note',                 kr: '봇 메모' },

  // ── Misc ──
  'misc.loading':       { en: 'Loading live ad data...', kr: '라이브 광고 데이터 로딩 중...' },
};

// ── Current language state ──
let currentLang = localStorage.getItem('adpilot-lang') || 'en';

/**
 * Get a translated string by key.
 */
function t(key) {
  const entry = I18N[key];
  if (!entry) return key;
  return entry[currentLang] || entry.en || key;
}

/**
 * Apply translations to all elements with data-i18n attribute.
 */
function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const text = t(key);
    if (el.tagName === 'OPTION') {
      el.textContent = text;
    } else if (el.tagName === 'INPUT') {
      el.placeholder = text;
    } else {
      el.textContent = text;
    }
  });

  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    const key = el.getAttribute('data-i18n-aria-label');
    el.setAttribute('aria-label', t(key));
  });

  // Update html lang attribute
  document.documentElement.lang = currentLang === 'kr' ? 'ko' : 'en';
}

/**
 * Set language and apply.
 */
function setLanguage(lang) {
  currentLang = lang;
  localStorage.setItem('adpilot-lang', lang);
  applyTranslations();
  // Update toggle button state
  const enBtn = document.getElementById('langEn');
  const krBtn = document.getElementById('langKr');
  if (enBtn && krBtn) {
    enBtn.classList.toggle('active', lang === 'en');
    krBtn.classList.toggle('active', lang === 'kr');
  }

  if (window.AdPilotLive && typeof window.AdPilotLive.refresh === 'function' && window.AdPilotLive.isLiveEnabled?.()) {
    window.AdPilotLive.refresh();
  }
}

/**
 * Initialize language toggle on DOM ready.
 */
function initI18n() {
  // Apply saved language
  applyTranslations();
  // Set toggle button initial state
  const enBtn = document.getElementById('langEn');
  const krBtn = document.getElementById('langKr');
  if (enBtn) {
    enBtn.classList.toggle('active', currentLang === 'en');
    enBtn.addEventListener('click', () => setLanguage('en'));
  }
  if (krBtn) {
    krBtn.classList.toggle('active', currentLang === 'kr');
    krBtn.addEventListener('click', () => setLanguage('kr'));
  }
}

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initI18n);
} else {
  initI18n();
}

window.t = t;
window.applyTranslations = applyTranslations;
window.getCurrentLang = () => currentLang;
