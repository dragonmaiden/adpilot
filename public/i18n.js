// ═══════════════════════════════════════════════════════
// AdPilot — Internationalization (EN / KR)
// ═══════════════════════════════════════════════════════

const I18N = {
  // ── Navigation ──
  'nav.overview':       { en: 'Executive Summary', kr: '요약' },
  'nav.campaigns':      { en: 'Live Performance',  kr: '실시간 성과' },
  'nav.analytics':      { en: 'Profit Analytics',  kr: '수익 분석' },
  'nav.calendar':       { en: 'Calendar Analysis', kr: '캘린더 분석' },
  'nav.optimizations':  { en: 'Decision Center',   kr: '의사결정 센터' },
  'nav.fatigue':        { en: 'Creative Health',   kr: '크리에이티브 상태' },
  'nav.budget':         { en: 'Spend Pacing',      kr: '지출 페이싱' },
  'nav.settings':       { en: 'Guardrails',         kr: '가드레일' },

  // ── Header ──
  'header.runScan':     { en: 'Run Scan',          kr: '스캔 실행' },
  'header.lastScan':    { en: 'Last scan:',        kr: '마지막 스캔:' },
  'header.agentActive': { en: 'Agent Active',      kr: '에이전트 활성' },
  'header.nextScan':    { en: 'Next scan in',      kr: '다음 스캔까지' },
  'header.metaAds':     { en: 'Meta Ads',          kr: 'Meta 광고' },
  'header.imweb':       { en: 'Imweb',             kr: 'Imweb' },
  'header.googleSheets': { en: 'Google Sheets',    kr: 'Google Sheets' },

  // ── Page Titles ──
  'page.overview':      { en: 'Executive Summary', kr: '요약' },
  'page.campaigns':     { en: 'Live Performance',  kr: '실시간 성과' },
  'page.analytics':     { en: 'Profit Analytics',  kr: '수익 분석' },
  'page.calendar':      { en: 'Calendar Analysis', kr: '캘린더 분석' },
  'page.optimizations': { en: 'Decision Center',   kr: '의사결정 센터' },
  'page.fatigue':       { en: 'Creative Health',   kr: '크리에이티브 상태' },
  'page.budget':        { en: 'Spend Pacing',      kr: '지출 페이싱' },
  'page.settings':      { en: 'Guardrails',         kr: '가드레일' },

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
  'chart.recentAI':       { en: 'Recent AI Actions',   kr: '최근 AI 활동' },
  'btn.viewAll':          { en: 'View All',            kr: '전체 보기' },
  'misc.toggleMenu':      { en: 'Toggle menu',         kr: '메뉴 열기/닫기' },
  'misc.toggleTheme':     { en: 'Toggle theme',        kr: '테마 전환' },
  'misc.createdWith':     { en: 'Created with Perplexity Computer', kr: 'Perplexity Computer로 제작됨' },
  'misc.all':             { en: 'All', kr: '전체' },
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
  'overview.workflowTitle': { en: 'Operator Workflow', kr: '운영 워크플로' },
  'overview.workflowDesc':  { en: 'This page stays executive. Use the workflow surfaces below when you need live decisions, approvals, pacing, or fatigue detail.', kr: '이 페이지는 경영 요약에 집중합니다. 실시간 의사결정, 승인, 페이싱, 크리에이티브 상태 점검이 필요할 때 아래 워크플로를 사용하세요.' },
  'overview.workflow.liveBadge': { en: 'Operate here', kr: '여기서 운영' },
  'overview.workflow.liveTitle': { en: 'Live Performance', kr: '실시간 성과' },
  'overview.workflow.liveDesc': { en: 'Watch active ads, pending decisions, budget pressure, and the campaigns that need action first.', kr: '활성 광고, 대기 중인 의사결정, 예산 압박, 우선 조치가 필요한 캠페인을 확인합니다.' },
  'overview.workflow.liveButton': { en: 'Open Live Performance', kr: '실시간 성과 열기' },
  'overview.workflow.diagnoseBadge': { en: 'Diagnose', kr: '진단' },
  'overview.workflow.diagnoseTitle': { en: 'Creative Health', kr: '크리에이티브 상태' },
  'overview.workflow.diagnoseDesc': { en: 'Review fatigue, CTR decay, frequency, and CPM pressure when creative performance starts to slip.', kr: '크리에이티브 성과가 약해질 때 피로도, CTR 하락, 빈도, CPM 압박을 점검합니다.' },
  'overview.workflow.diagnoseButton': { en: 'Open Creative Health', kr: '크리에이티브 상태 열기' },
  'overview.workflow.monitorBadge': { en: 'Monitor', kr: '모니터링' },
  'overview.workflow.monitorTitle': { en: 'Spend Pacing', kr: '지출 페이싱' },
  'overview.workflow.monitorDesc': { en: 'Check daily budget headroom, allocation, and whether delivery is running ahead or behind plan.', kr: '일일 예산 여유, 배분 현황, 집행 속도가 계획보다 빠른지 느린지 확인합니다.' },
  'overview.workflow.monitorButton': { en: 'Open Spend Pacing', kr: '지출 페이싱 열기' },
  'overview.workflow.aiBadge': { en: 'Business decisions', kr: '비즈니스 의사결정' },
  'overview.workflow.aiTitle': { en: 'Decision Center', kr: '의사결정 센터' },
  'overview.workflow.aiDesc': { en: 'Review live budget decisions, fix-input blockers, explicit hold states, and portfolio guidance without micromanaging Meta delivery.', kr: 'Meta 집행을 미세하게 건드리지 않고 라이브 예산 결정, 입력 수정 차단 요인, 명시적 유지 상태, 포트폴리오 가이드를 확인합니다.' },
  'overview.workflow.aiButton': { en: 'Open Decision Center', kr: '의사결정 센터 열기' },

  // ── Analytics KPIs ──
  'kpi.refundRate':     { en: 'Refund Rate (₩)',        kr: '환불률 (₩)' },
  'kpi.cancelRate':     { en: 'Cancel Rate (Sections)',  kr: '취소율 (섹션)' },
  'kpi.febRefund':      { en: 'Feb Refund Rate',        kr: '2월 환불률' },
  'kpi.marRefund':      { en: 'Mar Refund Rate',        kr: '3월 환불률' },

  // ── Analytics Chart Titles ──
  'chart.dailyProfit':      { en: 'Daily Profit Trend',         kr: '일별 수익 추이' },
  'chart.weeklyProfit':     { en: 'Weekly Profit',              kr: '주간 수익' },
  'chart.weekdayPerf':      { en: 'Ad Performance by Weekday',  kr: '요일별 광고 성과' },
  'chart.hourVolume':       { en: 'Order Timing Distribution (KST)', kr: '주문 시간대 분포 (KST)' },
  'chart.weeklyCpa':        { en: 'Main Campaign Weekly CPA',   kr: '주요 캠페인 주간 CPA' },
  'chart.monthlyRefund':    { en: 'Monthly Refund Comparison',  kr: '월별 환불 비교' },
  'chart.weekdayRevenue':   { en: 'Revenue by Day of Week',     kr: '요일별 매출' },
  'analytics.sectionKicker': { en: 'Profit Analytics', kr: '수익 분석' },
  'analytics.sectionTitle':  { en: 'Deep-dive margin diagnostics', kr: '마진 심층 진단' },
  'analytics.sectionNote':   { en: 'Trend shape, refund drag, campaign efficiency, and settlement validation live together here.', kr: '추이 구조, 환불 영향, 캠페인 효율, 정산 검증을 이 페이지에서 함께 확인합니다.' },
  'analytics.hero.margin':   { en: 'Margin', kr: '마진' },
  'analytics.hero.trueRoas': { en: 'True ROAS', kr: '실질 ROAS' },
  'analytics.hero.runRate':  { en: '30d run rate', kr: '30일 런레이트' },
  'analytics.hero.waiting':  { en: 'Waiting for data...', kr: '데이터 대기 중...' },
  'analytics.hero.latestWaiting': { en: 'Latest completed day: waiting for covered data.', kr: '최신 완료일: 원가 포함 데이터 대기 중.' },
  'analytics.structureKicker': { en: 'Profit Structure', kr: '수익 구조' },
  'analytics.structureTitle':  { en: 'How net profit is formed over time', kr: '순이익이 시간에 따라 어떻게 형성되는지' },
  'analytics.mediaKicker':    { en: 'Media Profitability', kr: '매체 수익성' },
  'analytics.mediaTitle':     { en: 'Which traffic patterns and campaigns create profit', kr: '어떤 트래픽 패턴과 캠페인이 수익을 만드는지' },
  'analytics.qualityKicker':  { en: 'Revenue Quality', kr: '매출 품질' },
  'analytics.qualityTitle':   { en: 'Refund pressure and settlement validation', kr: '환불 압력 및 정산 검증' },
  'analytics.window':         { en: 'Time frame', kr: '기간' },
  'analytics.windowStructureAria': { en: 'Profit structure time frame', kr: '수익 구조 기간 선택' },
  'analytics.windowMediaAria': { en: 'Media profitability time frame', kr: '매체 수익성 기간 선택' },
  'analytics.windowQualityAria': { en: 'Revenue quality time frame', kr: '매출 품질 기간 선택' },
  'analytics.kpi.cogsCoverage': { en: 'COGS Coverage', kr: 'COGS 커버리지' },
  'analytics.kpi.blendedMargin': { en: 'Blended Margin', kr: '혼합 마진' },
  'analytics.kpi.trueRoas': { en: 'True ROAS', kr: '실질 ROAS' },
  'analytics.kpi.runRate30d': { en: '30d Profit Run Rate', kr: '30일 수익 런레이트' },
  'analytics.waterfallTitle': { en: 'Daily Profit Waterfall', kr: '일별 수익 워터폴' },
  'analytics.waterfall.fullCoverage': { en: 'All items costed', kr: '모든 품목 원가 입력 완료' },
  'analytics.waterfall.partialCoverage': { en: 'COGS rows present but incomplete', kr: '원가 행은 있으나 미완성' },
  'analytics.waterfall.pendingRecovery': { en: 'Canceled / recovery pending', kr: '취소 후 환급 대기' },
  'analytics.waterfall.missingCoverage': { en: 'No COGS rows yet', kr: '원가 행 아직 없음' },
  'analytics.coverageTitle': { en: 'Data Coverage & Confidence', kr: '데이터 커버리지 및 신뢰도' },
  'analytics.coverageWaiting': { en: 'Waiting for data...', kr: '데이터 대기 중...' },
  'analytics.leaderboardTitle': { en: 'Campaign Profit Leaderboard', kr: '캠페인 수익 리더보드' },
  'analytics.leaderboardNote': { en: 'Revenue estimated (pixel-attributed) · all available data', kr: '매출은 픽셀 귀속 기준 추정 · 전체 사용 가능 데이터' },
  'analytics.leaderboard.estRevenue': { en: 'Est. Revenue', kr: '추정 매출' },
  'analytics.leaderboard.estCogs': { en: 'Est. COGS', kr: '추정 원가' },
  'analytics.leaderboard.grossProfit': { en: 'Gross Profit', kr: '매출총이익' },
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
  'calendar.sectionKicker':   { en: 'Calendar Analysis', kr: '캘린더 분석' },
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

  // ── Campaigns Page ──
  'campaigns.liveAds':        { en: 'Top Active Ads',                   kr: '핵심 활성 광고' },
  'campaigns.overview':       { en: 'Campaign Control Table',           kr: '캠페인 제어 테이블' },
  'campaigns.pausedLessons':  { en: 'Paused ads and what they taught',  kr: '중지된 광고와 학습 내용' },
  'campaigns.sectionKicker':  { en: 'Live Performance', kr: '실시간 성과' },
  'campaigns.sectionTitle':   { en: 'Act on what needs attention now', kr: '지금 필요한 조치를 바로 확인' },
  'campaigns.window':         { en: 'Time frame', kr: '기간' },
  'campaigns.windowAria':     { en: 'Campaign performance time frame', kr: '캠페인 성과 기간 선택' },
  'campaigns.kpi.activeCampaigns': { en: 'Active Campaigns', kr: '활성 캠페인' },
  'campaigns.kpi.profitConfidence': { en: 'Profit Confidence', kr: '수익 신뢰도' },
  'campaigns.kpi.strongestCampaign': { en: 'Strongest Campaign', kr: '가장 강한 캠페인' },
  'campaigns.kpi.spendPace': { en: 'Spend Pace Today', kr: '오늘 지출 속도' },
  'campaigns.kpi.burnRisk':  { en: 'Spend Without Sales', kr: '매출 없는 지출' },
  'campaigns.topAdsKicker': { en: 'Top Active Ads', kr: '핵심 활성 광고' },
  'campaigns.signalsKicker': { en: 'Live Read', kr: '라이브 읽기' },
  'campaigns.signalsTitle':  { en: 'What needs watching right now', kr: '지금 살펴봐야 할 것' },
  'campaigns.signalsLoading': { en: 'Loading live signals...', kr: '라이브 신호 불러오는 중...' },
  'campaigns.intradayKicker': { en: 'Intraday Pace', kr: '당일 페이스' },
  'campaigns.intradayTitle': { en: 'Is today’s spend turning into real profit yet?', kr: '오늘 지출이 실제 이익으로 이어지고 있나요?' },
  'campaigns.intradayDesc': { en: 'Spend, revenue, and profit share one money scale here. Profit means revenue after product costs, fees, and ad spend.', kr: '여기서는 지출, 매출, 이익이 같은 금액 축을 씁니다. 이익은 상품 원가, 수수료, 광고비를 뺀 뒤의 금액입니다.' },
  'campaigns.intradayConfidence': { en: 'Profit data confidence', kr: '이익 데이터 신뢰도' },
  'campaigns.intradayLoading': { en: 'Loading intraday pace...', kr: '당일 페이스 불러오는 중...' },
  'campaigns.dailyContextKicker': { en: 'Recent Days', kr: '최근 흐름' },
  'campaigns.dailyContextTitle': { en: 'Recent spend and CAC trend', kr: '최근 지출과 CAC 추이' },
  'campaigns.dailyContextDesc': { en: 'Use recent days as the backdrop for whether today’s pace looks normal, strong, or off-shape.', kr: '오늘 페이스가 평소 수준인지, 좋은지, 어긋나는지 판단하는 배경으로 최근 흐름을 봅니다.' },
  'campaigns.dailyContextLoading': { en: 'Loading daily context...', kr: '일별 맥락 불러오는 중...' },
  'campaigns.dailyContextRefreshing': { en: 'Refreshing recent trend...', kr: '최근 흐름 새로고침 중...' },
  'th.campaign':        { en: 'Campaign',          kr: '캠페인' },
  'th.status':          { en: 'Status',            kr: '상태' },
  'th.dailyBudget':     { en: 'Daily Budget',      kr: '일일 예산' },
  'th.spendWindow':     { en: 'Spend',             kr: '지출' },
  'th.purchases':       { en: 'Purchases',         kr: '구매' },
  'th.ctr':             { en: 'CTR',               kr: 'CTR' },
  'th.actions':         { en: 'Actions',           kr: '관리' },

  // ── Optimizations Page ──
  'kpi.totalOpt':       { en: 'AI Suggestions Logged', kr: '기록된 AI 제안' },
  'kpi.autoExec':       { en: 'Executed',            kr: '실행됨' },
  'kpi.pending':        { en: 'Needs Approval Now',  kr: '현재 승인 필요' },
  'kpi.awaitingTelegram': { en: 'Awaiting Telegram', kr: '텔레그램 응답 대기' },
  'kpi.advisory':       { en: 'Advisory Suggestions', kr: '참고용 제안' },
  'kpi.scans':          { en: 'Scans Completed',     kr: '완료된 스캔' },
  'chart.spendCac':     { en: 'Spend & CAC Trend',   kr: '지출 & CAC 추이' },
  'chart.actionType':   { en: 'Actions by Type',     kr: '유형별 활동' },
  'chart.actionPriority': { en: 'Actions by Priority', kr: '우선순위별 활동' },
  'opt.liveLog':        { en: 'Historical AI Suggestions & Outcomes',  kr: '과거 AI 제안 및 결과 이력' },
  'opt.activityHub':    { en: 'What changed recently', kr: '최근 무엇이 바뀌었는지' },
  'opt.activityHubDesc': { en: 'Only fresh state changes stay here. Audit history and research detail belong further down the page.', kr: '신선한 상태 변화만 여기에 남기고 감사 이력과 연구 세부 내용은 더 아래로 보냅니다.' },
  'opt.activityHubKicker': { en: 'Recent Changes', kr: '최근 변화' },
  'opt.recentActivity': { en: 'Recent Agent Activity', kr: '최근 에이전트 활동' },
  'opt.archiveTitle':   { en: 'Audit history and grouped families', kr: '감사 이력과 그룹화된 패밀리' },
  'opt.clusterKicker':  { en: 'Grouped Families', kr: '그룹화된 패밀리' },
  'opt.clusterDesc':    { en: 'Open this only when you need audit detail, grouped macro decisions, fix-input history, or the latest reasoning behind an older family.', kr: '감사 세부 내용, 그룹화된 매크로 결정, 입력 수정 이력, 오래된 패밀리의 최신 사유가 필요할 때만 여세요.' },
  'opt.rawHistorySummary': { en: 'Raw per-scan history', kr: '원시 스캔 이력' },
  'optimizations.sectionKicker': { en: 'Decision Center', kr: '의사결정 센터' },
  'optimizations.sectionTitle': { en: 'Business decisions, guardrails, and operating context', kr: '비즈니스 의사결정, 가드레일, 운영 맥락' },
  'optimizations.sectionNote': { en: 'Start at the top. If there is nothing urgent to decide, the next priority is fixing inputs, respecting hold states, or reviewing portfolio guidance.', kr: '상단부터 보세요. 긴급히 결정할 것이 없다면 다음 우선순위는 입력 수정, 유지 상태 존중, 포트폴리오 가이드 검토입니다.' },
  'optimizations.heroKicker': { en: 'Owner Focus', kr: '소유자 포커스' },
  'optimizations.heroWaitingTitle': { en: 'Waiting for AI operations data...', kr: 'AI 운영 데이터 대기 중...' },
  'optimizations.heroWaitingBody': { en: 'Once the next refresh lands, this space will tell you what needs a decision, what inputs need work, and when the right move is to leave delivery alone.', kr: '다음 새로고침이 오면 이 영역이 결정이 필요한 것, 어떤 입력을 고쳐야 하는지, 그리고 언제 집행을 그대로 두는 것이 맞는지 알려줍니다.' },
  'optimizations.heroNextMove': { en: 'Next move', kr: '다음 조치' },
  'optimizations.heroSafeIgnore': { en: 'Safe to ignore', kr: '지금 무시해도 되는 것' },
  'optimizations.spendContext': { en: 'Spend Context', kr: '지출 맥락' },
  'optimizations.chartDesc': { en: 'Daily spend transitions in KRW with CAC overlay. Spend comes from Meta; CAC uses actual daily purchase counts when COGS coverage exists.', kr: 'KRW 기준 일별 지출 변화에 CAC를 겹쳐 보여줍니다. 지출은 Meta 기준이며 CAC는 COGS 커버리지가 있을 때 실제 일별 구매 수를 사용합니다.' },
  'optimizations.legendSpend': { en: 'Spend (L)', kr: '지출 (좌)' },
  'optimizations.legendCac': { en: 'CAC (R)', kr: 'CAC (우)' },
  'optimizations.legendTarget': { en: 'Target CPA', kr: '목표 CPA' },
  'optimizations.legendBudget': { en: 'Budget', kr: '예산' },
  'optimizations.legendEvents': { en: 'Decision markers', kr: '결정 마커' },
  'optimizations.eventsWaiting': { en: 'Decision markers will appear after the next clustered refresh.', kr: '다음 클러스터 새로고침 후 결정 마커가 표시됩니다.' },
  'optimizations.kpiActionNow': { en: 'Decide Now', kr: '지금 결정' },
  'optimizations.kpiBacklog': { en: 'Fix Inputs', kr: '입력 수정' },
  'optimizations.kpiFriction': { en: 'Hold', kr: '유지' },
  'optimizations.kpiPortfolio': { en: 'Portfolio Guidance', kr: '포트폴리오 가이드' },
  'optimizations.kpiRepeatPressure': { en: 'Resolved (24h)', kr: '해결됨 (24시간)' },
  'optimizations.queueKicker': { en: 'Action Center', kr: '액션 센터' },
  'optimizations.queueTitle': { en: 'Decisions you can still take', kr: '아직 내릴 수 있는 결정' },
  'optimizations.queueDesc': { en: 'Only fresh budget or stop-loss decisions and active Telegram reply waits belong here.', kr: '최신 예산/가드레일 결정과 실제 텔레그램 응답 대기만 여기에 남습니다.' },
  'optimizations.backlogKicker': { en: 'Fix Inputs', kr: '입력 수정' },
  'optimizations.backlogTitle': { en: 'Inputs or trust to fix first', kr: '먼저 고칠 입력 또는 신뢰' },
  'optimizations.backlogDesc': { en: 'These are non-delivery fixes: measurement trust, creative supply, and other inputs that should improve before the next budget change.', kr: '이것들은 집행 조작이 아니라 입력 수정입니다. 측정 신뢰, 크리에이티브 공급, 다음 예산 변경 전에 개선해야 하는 기타 입력입니다.' },
  'optimizations.holdKicker': { en: 'Hold', kr: '유지' },
  'optimizations.holdTitle': { en: 'Let Meta keep delivering', kr: 'Meta가 계속 집행하게 두기' },
  'optimizations.holdDesc': { en: 'These are explicit no-change states. The right move is to leave delivery alone until the next meaningful shift.', kr: '이것들은 명시적인 변경 없음 상태입니다. 다음 의미 있는 변화가 올 때까지 집행을 그대로 두는 것이 맞습니다.' },
  'optimizations.portfolioKicker': { en: 'Portfolio Guidance', kr: '포트폴리오 가이드' },
  'optimizations.portfolioTitle': { en: 'Macro budget direction for the next pass', kr: '다음 운영 사이클을 위한 거시 예산 방향' },
  'optimizations.portfolioDesc': { en: 'These are advisory macro moves: portfolio scale, reduce, or reallocation guidance that should shape the next planning pass.', kr: '이것들은 참고용 거시 움직임입니다. 다음 운영 사이클을 위한 포트폴리오 확장, 축소, 또는 재배분 가이드입니다.' },
  'optimizations.archiveKicker': { en: 'Archive & Diagnostics', kr: '아카이브 및 진단' },
  'optimizations.archiveTitle': { en: 'Audit history and grouped families', kr: '감사 이력과 그룹화된 패밀리' },
  'opt.allTypes':       { en: 'All Types',           kr: '전체 유형' },
  'opt.budget':         { en: 'Budget',              kr: '예산' },
  'opt.creative':       { en: 'Creative',            kr: '크리에이티브' },
  'opt.status':         { en: 'Status',              kr: '상태' },
  'opt.waiting':        { en: 'Waiting for backend connection and first scan...', kr: '백엔드 연결 및 첫 번째 스캔 대기 중...' },
  'opt.allStatuses':    { en: 'All States', kr: '전체 상태' },
  'opt.openBacklog':    { en: 'Live Decisions', kr: '라이브 결정' },
  'opt.awaitingTelegram': { en: 'Fix Inputs', kr: '입력 수정' },
  'opt.advisoryOnly':   { en: 'Hold', kr: '유지' },
  'opt.portfolioOnly':  { en: 'Portfolio Guidance', kr: '포트폴리오 가이드' },
  'opt.researchOnly':   { en: 'Research', kr: '리서치' },
  'opt.cleanupOnly':    { en: 'Cleanup', kr: '정리' },
  'opt.resolved':       { en: 'Resolved', kr: '해결됨' },

  // Candlestick stats
  'stat.totalSpend':    { en: 'TOTAL SPEND',  kr: '총 지출' },
  'stat.peakDay':       { en: 'PEAK DAY',     kr: '최고 일' },
  'stat.avgDaily':      { en: 'AVG DAILY',    kr: '일 평균' },
  'stat.days':          { en: 'DAYS',          kr: '일수' },
  'stat.avgCac':        { en: 'AVG CAC',       kr: '평균 CAC' },
  'stat.peakDate':      { en: 'PEAK DATE',     kr: '최고 날짜' },

  // ── Fatigue Detection Page ──
  'fatigue.monitor':    { en: 'Creative Health Monitor',  kr: '크리에이티브 상태 모니터' },
  'fatigue.desc':       { en: 'The agent monitors frequency, CTR decay, and CPM rise to detect creative fatigue before it damages performance.', kr: '에이전트가 빈도, CTR 감소, CPM 상승을 모니터링하여 성과에 영향을 미치기 전에 크리에이티브 피로도를 감지합니다.' },
  'fatigue.indicators': { en: 'Fatigue Indicators Over Time', kr: '시간 경과에 따른 피로도 지표' },
  'fatigue.sectionKicker': { en: 'Creative Health', kr: '크리에이티브 상태' },
  'fatigue.sectionTitle': { en: 'Watch fatigue before it damages performance', kr: '성과를 해치기 전에 피로도를 확인' },
  'fatigue.sectionNote': { en: 'This page owns creative diagnosis: active fatigue signals, pressure trends, and paused-ad learnings.', kr: '이 페이지는 크리에이티브 진단 전용입니다. 현재 피로 신호, 압박 추이, 중지 광고 학습 내용을 확인합니다.' },
  'fatigue.windowRecent': { en: 'Recent 14 day creative health view', kr: '최근 14일 크리에이티브 상태 보기' },
  'fatigue.learnKicker': { en: 'Creative Learnings', kr: '크리에이티브 학습' },

  // ── Budget Manager Page ──
  'budget.daily':       { en: 'Active Budget Pool',    kr: '활성 예산 풀' },
  'budget.periodSpend': { en: 'Spend This Time Frame',     kr: '이 기간 지출' },
  'budget.remaining':   { en: 'Budget Headroom',       kr: '예산 여유' },
  'budget.pace':        { en: 'Pace',                  kr: '속도' },
  'chart.budgetAlloc':  { en: 'Budget Allocation by Campaign', kr: '캠페인별 예산 배분' },
  'chart.dailyPace':    { en: 'Daily Spend Pace',              kr: '일별 지출 속도' },
  'budget.history':     { en: 'Budget Decision History',    kr: '예산 의사결정 이력' },
  'budget.sectionKicker': { en: 'Spend Pacing', kr: '지출 페이싱' },
  'budget.sectionTitle':  { en: 'Track budget headroom and delivery pace', kr: '예산 여유와 집행 속도 추적' },
  'budget.sectionNote':   { en: 'This page is for pacing and budget pressure only. Live campaign decisions stay on Live Performance.', kr: '이 페이지는 페이싱과 예산 압박만 다룹니다. 실시간 캠페인 의사결정은 실시간 성과 탭에서 확인합니다.' },
  'th.time':            { en: 'Time',               kr: '시간' },
  'th.target':          { en: 'Target',             kr: '대상' },
  'th.scope':           { en: 'Scope',              kr: '범위' },
  'th.actionTaken':     { en: 'Action',             kr: '조치' },
  'th.reason':          { en: 'Reason',             kr: '사유' },

  // ── Settings Page ──
  'settings.agentConfig':       { en: 'Operating Guardrails',         kr: '운영 가드레일' },
  'settings.scanFreq':          { en: 'Scan Frequency',              kr: '스캔 주기' },
  'settings.scanFreqDesc':      { en: 'How often the decision engine refreshes campaign, trust, and pacing context', kr: '의사결정 엔진이 캠페인, 신뢰도, 페이싱 맥락을 새로 고치는 주기' },
  'settings.maxBudgetChange':   { en: 'Max Daily Budget Change',     kr: '최대 일일 예산 변경폭' },
  'settings.maxBudgetDesc':     { en: "Maximum percentage the engine can move a campaign budget in one scan", kr: '엔진이 한 번의 스캔에서 움직일 수 있는 최대 캠페인 예산 비율' },
  'settings.autoPause':         { en: 'Hard Stop-Loss Threshold (CPA)',  kr: '하드 스톱로스 임계값 (CPA)' },
  'settings.autoPauseDesc':     { en: 'Pause a campaign only when CPA breaches this stop-loss threshold over a sustained window', kr: 'CPA가 지속 구간 동안 이 스톱로스 임계값을 넘을 때만 캠페인을 중지합니다' },
  'settings.fatigueSens':       { en: 'Creative Pressure Sensitivity', kr: '크리에이티브 압박 민감도' },
  'settings.fatigueSensDesc':   { en: 'How readily the system flags weak creative supply before more budget is added', kr: '더 많은 예산을 넣기 전에 시스템이 약한 크리에이티브 공급을 얼마나 민감하게 감지할지 설정합니다' },
  'settings.autoMode':          { en: 'Approval-Gated Execution',             kr: '승인 기반 실행' },
  'settings.autoModeDesc':      { en: 'When enabled, executable campaign budget and stop-loss actions can request approval during scans. When disabled, everything stays advisory-only.', kr: '활성화 시 실행 가능한 캠페인 예산 및 스톱로스 조치가 스캔 중 승인을 요청할 수 있습니다. 비활성화 시 모든 항목이 참고용으로만 남습니다.' },
  'settings.budgetRealloc':     { en: 'Portfolio Reallocation Guidance',         kr: '포트폴리오 재배분 가이드' },
  'settings.budgetReallocDesc': { en: 'Allow portfolio-level reallocation advisories when contribution diverges across campaigns', kr: '캠페인 간 공헌 이익 차이가 벌어질 때 포트폴리오 수준 재배분 가이드를 허용합니다' },
  'settings.notifChannel':      { en: 'Notification Channel',        kr: '알림 채널' },
  'settings.notifChannelDesc':  { en: 'Where to send alerts about significant changes or issues', kr: '중요한 변경 사항 또는 문제에 대한 알림을 보낼 곳' },
  'settings.emailInApp':        { en: 'Email + In-App', kr: '이메일 + 인앱' },
  'settings.emailOnly':         { en: 'Email Only', kr: '이메일만' },
  'settings.inAppOnly':         { en: 'In-App Only', kr: '인앱만' },
  'settings.slack':             { en: 'Slack', kr: 'Slack' },
  'settings.webhook':           { en: 'Webhook', kr: 'Webhook' },
  'settings.low':               { en: 'Low',    kr: '낮음' },
  'settings.medium':            { en: 'Medium', kr: '보통' },
  'settings.high':              { en: 'High',   kr: '높음' },

  // Scan frequency options
  'settings.every10':   { en: 'Every 10 minutes', kr: '10분마다' },
  'settings.every15':   { en: 'Every 15 minutes', kr: '15분마다' },
  'settings.every30':   { en: 'Every 30 minutes', kr: '30분마다' },
  'settings.everyHour': { en: 'Every hour',       kr: '1시간마다' },
  'settings.every2h':   { en: 'Every 2 hours',    kr: '2시간마다' },
  'settings.every4h':   { en: 'Every 4 hours',    kr: '4시간마다' },
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

  if (typeof window.renderCountdown === 'function') {
    window.renderCountdown();
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
