// ═══════════════════════════════════════════════════════
// AdPilot — Internationalization (EN / KR)
// ═══════════════════════════════════════════════════════

const I18N = {
  // ── Navigation ──
  'nav.overview':       { en: 'Overview',          kr: '개요' },
  'nav.campaigns':      { en: 'Campaigns',         kr: '캠페인' },
  'nav.analytics':      { en: 'Analytics',         kr: '분석' },
  'nav.optimizations':  { en: 'Optimizations',     kr: '최적화' },
  'nav.fatigue':        { en: 'Fatigue Detection',  kr: '피로도 감지' },
  'nav.budget':         { en: 'Budget Manager',     kr: '예산 관리' },
  'nav.settings':       { en: 'Settings',           kr: '설정' },

  // ── Header ──
  'header.runScan':     { en: 'Run Scan Now',      kr: '스캔 실행' },
  'header.lastScan':    { en: 'Last scan:',        kr: '마지막 스캔:' },
  'header.agentActive': { en: 'Agent Active',      kr: '에이전트 활성' },
  'header.nextScan':    { en: 'Next scan in',      kr: '다음 스캔' },

  // ── Page Titles ──
  'page.overview':      { en: 'Overview',          kr: '개요' },
  'page.campaigns':     { en: 'Campaigns',         kr: '캠페인' },
  'page.analytics':     { en: 'Analytics',         kr: '분석' },
  'page.optimizations': { en: 'Optimizations',     kr: '최적화' },
  'page.fatigue':       { en: 'Fatigue Detection',  kr: '피로도 감지' },
  'page.budget':        { en: 'Budget Manager',     kr: '예산 관리' },
  'page.settings':      { en: 'Settings',           kr: '설정' },

  // ── Overview KPI Labels ──
  'kpi.revenue':        { en: 'Revenue (Imweb)',    kr: '매출 (Imweb)' },
  'kpi.cogs':           { en: 'COGS',              kr: '매출원가' },
  'kpi.adspend':        { en: 'Ad Spend (Meta)',    kr: '광고비 (Meta)' },
  'kpi.profit':         { en: 'Gross Profit',       kr: '매출총이익' },
  'kpi.roas':           { en: 'ROAS',              kr: 'ROAS' },
  'kpi.purchases':      { en: 'Purchases (Meta)',   kr: '구매 (Meta)' },
  'kpi.ctr':            { en: 'CTR',               kr: 'CTR' },
  'kpi.cpa':            { en: 'Cost per Purchase',  kr: '구매당 비용' },

  // ── Overview Chart Titles ──
  'chart.revenueVsSpend': { en: 'Revenue vs Ad Spend', kr: '매출 vs 광고비' },
  'chart.dailyRoas':      { en: 'Daily ROAS',          kr: '일별 ROAS' },
  'chart.ctrCpc':         { en: 'CTR & CPC Trend',     kr: 'CTR & CPC 추이' },
  'chart.revenueByBrand': { en: 'Revenue by Brand',    kr: '브랜드별 매출' },
  'chart.recentAI':       { en: 'Recent AI Actions',   kr: '최근 AI 활동' },
  'btn.viewAll':          { en: 'View All',            kr: '전체 보기' },

  // ── Analytics KPIs ──
  'kpi.refundRate':     { en: 'Refund Rate (₩)',        kr: '환불률 (₩)' },
  'kpi.cancelRate':     { en: 'Cancel Rate (Sections)',  kr: '취소율 (섹션)' },
  'kpi.febRefund':      { en: 'Feb Refund Rate',        kr: '2월 환불률' },
  'kpi.marRefund':      { en: 'Mar Refund Rate',        kr: '3월 환불률' },

  // ── Analytics Chart Titles ──
  'chart.dailyProfit':      { en: 'Daily Profit Trend',         kr: '일별 수익 추이' },
  'chart.weeklyProfit':     { en: 'Weekly Profit',              kr: '주간 수익' },
  'chart.weekdayPerf':      { en: 'Ad Performance by Weekday',  kr: '요일별 광고 성과' },
  'chart.hourVolume':       { en: 'Order Volume by Hour (KST)', kr: '시간대별 주문량 (KST)' },
  'chart.weeklyCpa':        { en: 'Main Campaign Weekly CPA',   kr: '주요 캠페인 주간 CPA' },
  'chart.monthlyRefund':    { en: 'Monthly Refund Comparison',  kr: '월별 환불 비교' },
  'chart.weekdayRevenue':   { en: 'Revenue by Day of Week',     kr: '요일별 매출' },

  // ── Analytics Table Headers ──
  'th.day':             { en: 'Day',               kr: '요일' },
  'th.orders':          { en: 'Orders',            kr: '주문수' },
  'th.revenuePaid':     { en: 'Revenue (Paid)',    kr: '매출 (결제)' },
  'th.refunded':        { en: 'Refunded',          kr: '환불' },
  'th.netRevenue':      { en: 'Net Revenue',       kr: '순매출' },
  'th.adSpend':         { en: 'Ad Spend',          kr: '광고비' },
  'th.purchasesPixel':  { en: 'Purchases (Pixel)', kr: '구매 (픽셀)' },
  'th.cpa':             { en: 'CPA',               kr: 'CPA' },

  // ── Campaigns Page ──
  'campaigns.liveAds':        { en: 'Live Ads',                        kr: '라이브 광고' },
  'campaigns.overview':       { en: 'Campaigns Overview',              kr: '캠페인 개요' },
  'campaigns.pausedLessons':  { en: 'Paused Ads — Performance Lessons', kr: '일시중지 광고 — 성과 분석' },
  'th.campaign':        { en: 'Campaign',          kr: '캠페인' },
  'th.status':          { en: 'Status',            kr: '상태' },
  'th.dailyBudget':     { en: 'Daily Budget',      kr: '일일 예산' },
  'th.spend7d':         { en: 'Spend (7d)',        kr: '지출 (7일)' },
  'th.purchases':       { en: 'Purchases',         kr: '구매' },
  'th.ctr':             { en: 'CTR',               kr: 'CTR' },
  'th.actions':         { en: 'Actions',           kr: '관리' },

  // ── Optimizations Page ──
  'kpi.totalOpt':       { en: 'Total Optimizations', kr: '총 최적화' },
  'kpi.autoExec':       { en: 'Auto-Executed',       kr: '자동 실행' },
  'kpi.pending':        { en: 'Pending Approval',    kr: '승인 대기' },
  'kpi.scans':          { en: 'Scans Completed',     kr: '완료된 스캔' },
  'chart.spendCac':     { en: 'SPEND & CAC — DAILY', kr: '지출 & CAC — 일별' },
  'chart.actionType':   { en: 'Actions by Type',     kr: '유형별 활동' },
  'chart.actionPriority': { en: 'Actions by Priority', kr: '우선순위별 활동' },
  'opt.liveLog':        { en: 'Live Optimization Log', kr: '실시간 최적화 로그' },
  'opt.allTypes':       { en: 'All Types',           kr: '전체 유형' },
  'opt.budget':         { en: 'Budget',              kr: '예산' },
  'opt.bid':            { en: 'Bid',                 kr: '입찰' },
  'opt.creative':       { en: 'Creative',            kr: '크리에이티브' },
  'opt.status':         { en: 'Status',              kr: '상태' },
  'opt.schedule':       { en: 'Schedule',            kr: '일정' },
  'opt.targeting':      { en: 'Targeting',           kr: '타겟팅' },
  'opt.waiting':        { en: 'Waiting for backend connection and first scan...', kr: '백엔드 연결 및 첫 번째 스캔 대기 중...' },

  // Candlestick stats
  'stat.totalSpend':    { en: 'TOTAL SPEND',  kr: '총 지출' },
  'stat.peakDay':       { en: 'PEAK DAY',     kr: '최고 일' },
  'stat.avgDaily':      { en: 'AVG DAILY',    kr: '일 평균' },
  'stat.days':          { en: 'DAYS',          kr: '일수' },
  'stat.avgCac':        { en: 'AVG CAC',       kr: '평균 CAC' },
  'stat.peakDate':      { en: 'PEAK DATE',     kr: '최고 날짜' },

  // ── Fatigue Detection Page ──
  'fatigue.monitor':    { en: 'Ad Fatigue Monitor',  kr: '광고 피로도 모니터' },
  'fatigue.desc':       { en: 'The agent monitors frequency, CTR decay, and CPM rise to detect ad fatigue before it damages performance.', kr: '에이전트가 빈도, CTR 감소, CPM 상승을 모니터링하여 성과에 영향을 미치기 전에 광고 피로도를 감지합니다.' },
  'fatigue.indicators': { en: 'Fatigue Indicators Over Time', kr: '시간 경과에 따른 피로도 지표' },

  // ── Budget Manager Page ──
  'budget.daily':       { en: 'Daily Budget (Active)', kr: '일일 예산 (활성)' },
  'budget.periodSpend': { en: 'Period Spend',          kr: '기간 지출' },
  'budget.remaining':   { en: 'Budget Remaining',      kr: '잔여 예산' },
  'budget.pace':        { en: 'Pace',                  kr: '속도' },
  'chart.budgetAlloc':  { en: 'Budget Allocation by Campaign', kr: '캠페인별 예산 배분' },
  'chart.dailyPace':    { en: 'Daily Spend Pace',              kr: '일별 지출 속도' },
  'budget.history':     { en: 'Budget Reallocation History',    kr: '예산 재배분 내역' },
  'th.time':            { en: 'Time',               kr: '시간' },
  'th.fromCampaign':    { en: 'From Campaign',      kr: '기존 캠페인' },
  'th.toCampaign':      { en: 'To Campaign',        kr: '이동 캠페인' },
  'th.amount':          { en: 'Amount',             kr: '금액' },
  'th.reason':          { en: 'Reason',             kr: '사유' },

  // ── Settings Page ──
  'settings.agentConfig':       { en: 'Agent Configuration',         kr: '에이전트 설정' },
  'settings.scanFreq':          { en: 'Scan Frequency',              kr: '스캔 주기' },
  'settings.scanFreqDesc':      { en: 'How often the agent scans your campaigns for optimization opportunities', kr: '에이전트가 캠페인 최적화 기회를 스캔하는 주기' },
  'settings.maxBudgetChange':   { en: 'Max Daily Budget Change',     kr: '최대 일일 예산 변경폭' },
  'settings.maxBudgetDesc':     { en: "Maximum percentage the agent can adjust a campaign's daily budget per scan", kr: '에이전트가 스캔당 조정할 수 있는 최대 예산 비율' },
  'settings.autoPause':         { en: 'Auto-pause Threshold (CPA)',  kr: '자동 중지 임계값 (CPA)' },
  'settings.autoPauseDesc':     { en: 'Pause campaigns when CPA exceeds this amount for 24+ hours', kr: 'CPA가 24시간 이상 이 금액을 초과하면 캠페인 중지' },
  'settings.fatigueSens':       { en: 'Fatigue Detection Sensitivity', kr: '피로도 감지 민감도' },
  'settings.fatigueSensDesc':   { en: 'How aggressively the agent flags creatives for fatigue', kr: '에이전트가 크리에이티브 피로도를 감지하는 민감도' },
  'settings.autoMode':          { en: 'Autonomous Mode',             kr: '자율 모드' },
  'settings.autoModeDesc':      { en: 'When enabled, the agent applies optimizations automatically. When disabled, it only suggests changes.', kr: '활성화 시 에이전트가 자동으로 최적화를 적용합니다. 비활성화 시 변경 사항만 제안합니다.' },
  'settings.budgetRealloc':     { en: 'Budget Reallocation',         kr: '예산 재배분' },
  'settings.budgetReallocDesc': { en: 'Allow the agent to move budget between campaigns based on performance', kr: '성과에 따라 캠페인 간 예산 이동 허용' },
  'settings.creativeRotation':  { en: 'Creative Rotation',           kr: '크리에이티브 교체' },
  'settings.creativeRotDesc':   { en: 'Automatically rotate underperforming creatives when fatigue is detected', kr: '피로도가 감지되면 성과가 낮은 크리에이티브를 자동 교체' },
  'settings.notifChannel':      { en: 'Notification Channel',        kr: '알림 채널' },
  'settings.notifChannelDesc':  { en: 'Where to send alerts about significant changes or issues', kr: '중요한 변경 사항 또는 문제에 대한 알림을 보낼 곳' },
  'settings.low':               { en: 'Low',    kr: '낮음' },
  'settings.medium':            { en: 'Medium', kr: '보통' },
  'settings.high':              { en: 'High',   kr: '높음' },

  // Scan frequency options
  'settings.every15':   { en: 'Every 15 minutes', kr: '15분마다' },
  'settings.every30':   { en: 'Every 30 minutes', kr: '30분마다' },
  'settings.everyHour': { en: 'Every hour',       kr: '1시간마다' },
  'settings.every2h':   { en: 'Every 2 hours',    kr: '2시간마다' },
  'settings.every4h':   { en: 'Every 4 hours',    kr: '4시간마다' },

  // API connections
  'settings.metaApi':       { en: 'Meta Ads API Connection',  kr: 'Meta 광고 API 연결' },
  'settings.imwebStore':    { en: 'Imweb Store Connection',    kr: 'Imweb 스토어 연결' },
  'settings.cogsData':      { en: 'COGS Data (Google Sheets)', kr: '매출원가 데이터 (Google Sheets)' },
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
  'settings.totalOrders':   { en: 'Total Orders',             kr: '총 주문수' },
  'settings.revenue':       { en: 'Revenue',                  kr: '매출' },
  'settings.source':        { en: 'Source',                   kr: '소스' },
  'settings.coverage':      { en: 'Coverage',                 kr: '범위' },
  'settings.lineItems':     { en: 'Line Items',               kr: '항목수' },
  'settings.totalCogs':     { en: 'Total COGS',               kr: '총 매출원가' },

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

  // Update dynamic page title for the currently active page
  const activeNav = document.querySelector('.nav-item.active');
  const pageTitleEl = document.getElementById('pageTitle');
  if (activeNav && pageTitleEl) {
    const page = activeNav.dataset.page;
    const key = 'page.' + page;
    if (I18N[key]) pageTitleEl.textContent = t(key);
  }

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
