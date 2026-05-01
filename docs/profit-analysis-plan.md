# AdPilot — Deep Daily Profit Analysis Page

## Context
The dashboard shows revenue, spend, ROAS, and a simple daily profit chart (revenue - refunds - ad spend in KRW), but this misses COGS, payment fees, and gives no campaign-level profit view. COGS data is partial (Feb 8–28 only), so every profit number needs a trust signal. The goal is a new **Profit** page answering 4 questions: **Did we make money today? Why? Which campaigns drove it? Can I trust the number?**

## Design Decisions
- **No new API endpoint** — extend `/api/analytics` with a `profitAnalysis` block (reuses existing `fetchAnalytics()` in frontend)
- **No new transform file** — add 3 functions to existing `charts.js` (~80 lines)
- **Campaign revenue = Meta pixel purchases × avg Imweb AOV** — Imweb has no campaign attribution, so this is the only option. Labeled as "estimated (pixel-attributed)"
- **COGS date keys already YYYY-MM-DD** — confirmed by `slice(0,7)` usage in cogsClient.js. Add defensive normalization
- **Payment fees = 3.3% of revenue** — standard Korean PG rate, add to `config.js`

## Files to Modify (7 files, ordered by implementation sequence)

### 1. `server/transforms/charts.js` — Add 3 transform functions

**`buildProfitWaterfall(dailyMerged, dailyCOGS, paymentFeeRate)`**
```
Input: dailyMerged array + cogsData.dailyCOGS dict + fee rate
Output: [{
  date, revenue, refunded, netRevenue,
  cogs, cogsShipping, adSpendKRW, paymentFees,
  trueNetProfit, hasCOGS (bool)
}, ...]
```
- `trueNetProfit = netRevenue - cogs - cogsShipping - adSpendKRW - paymentFees`
- `hasCOGS = false` when no COGS entry for that date

**`buildCampaignProfit(campaignInsights, campaigns, avgAOV, cogsData, totalRevenue, totalOrders)`**
```
Output: [{
  campaignId, campaignName, status,
  spend (USD), spendKRW, metaPurchases,
  estimatedRevenue (purchases × avgAOV),
  allocatedCOGS (proportional to revenue share),
  grossProfit, margin (%)
}, ...] sorted by grossProfit desc
```

**`buildDataCoverage(dailyMerged, dailyCOGS)`**
```
Output: {
  totalDays, daysWithCOGS, coverageRatio,
  confidence: { level: "high"|"medium"|"low", label, color },
  cogsCoveredRange: { from, to },
  missingRanges: [string, ...]
}
```
- high ≥ 80%, medium ≥ 40%, low < 40%

### 2. `server/config.js` — Add fee rate

```javascript
fees: { paymentFeeRate: 0.033 },
```

### 3. `server/contracts/v1.js` — Extend analytics contract

Add `profitAnalysis` block to the `analytics()` return:
```javascript
profitAnalysis: {
  waterfall: [],       // from buildProfitWaterfall
  campaignProfit: [],  // from buildCampaignProfit
  coverage: {},        // from buildDataCoverage
  todaySummary: null,  // { date, trueNetProfit, hasCOGS, confidence, verdict }
}
```

### 4. `server/index.js` — Wire transforms in `/api/analytics` route

After existing transform calls (line ~669), add:
```javascript
const dailyCOGS = cogs ? cogs.dailyCOGS : {};
const profitWaterfall = transforms.buildProfitWaterfall(dailyMerged, dailyCOGS, config.fees.paymentFeeRate);
const avgAOV = revenue.totalOrders > 0 ? revenue.netRevenue / revenue.totalOrders : 0;
const campaignProfit = transforms.buildCampaignProfit(data.campaignInsights, data.campaigns, avgAOV, cogs, revenue.netRevenue || 0, revenue.totalOrders || 0);
const dataCoverage = transforms.buildDataCoverage(dailyMerged, dailyCOGS);
// todaySummary from today's waterfall row
```
Pass all to contract call.

### 5. `public/index.html` — Add Profit page

**Nav item** (between Budget and Settings):
```html
<a href="#" class="nav-item" data-page="profit">
  <i data-lucide="coins"></i>
  <span data-i18n="nav.profit">Profit</span>
</a>
```

**Page layout** (top to bottom):
1. **Hero card** (`.profit-hero`): Today's verdict — "Profitable" / "Unprofitable" + net profit amount + confidence badge
2. **KPI row** (4 cards): Net Profit, COGS Coverage %, Blended Margin, True ROAS
3. **Waterfall chart** (full-width): Stacked bar — Revenue (green), Refunds (red↓), COGS (orange↓), Ad Spend (blue↓), Fees (gray↓), Net Profit line overlay. Days without COGS dimmed
4. **Campaign Profit Leaderboard** (table): Campaign | Status | Ad Spend | Purchases | Est. Revenue | Est. COGS | Gross Profit | Margin %
5. **Data Coverage card**: Covered date ranges, missing ranges, confidence explanation

### 6. `public/app.js` — Chart init + navigation

- Add `profitWaterfallChart` variable + `profitChartsInitialized` flag
- Add `initProfitCharts()` — creates stacked bar chart with 5 datasets + line overlay
- Wire into page navigation: init on first visit to profit page
- Add `profit` to page title maps

### 7. `public/live.js` — Data population

Add `updateProfitPage()`:
- Calls existing `fetchAnalytics()`
- Reads `data.profitAnalysis.{waterfall, campaignProfit, coverage, todaySummary}`
- Updates hero card, KPIs, waterfall chart, leaderboard table, coverage card
- Register in poll interval alongside other page updates

### 8. `public/style.css` — Minimal styles

- `.profit-hero` — highlighted card with large verdict text
- `.confidence-badge` + `.confidence-high/medium/low` — colored pill
- `.verdict-positive` / `.verdict-negative` — green/red
- `.cogs-estimated` — dimmed bar styling for days without COGS
- `.leaderboard-table` — reuses `.data-table` pattern

## Key Reuse Points
- `fetchAnalytics()` in live.js — no new fetcher needed
- `buildDailyMerged()` output — waterfall builds on top of it
- `contracts.analytics()` — extended, not replaced
- `.kpi-grid`, `.card`, `.chart-card`, `.data-table` — existing CSS classes
- Chart.js stacked bar pattern — already used in weekly profit chart

## Verification
1. `cd ~/adpilot && npm start`
2. `curl localhost:3000/api/analytics | jq '.profitAnalysis'` — verify new fields
3. Open dashboard → Profit page
4. Check: waterfall chart shows daily breakdown, days without COGS are dimmed
5. Check: campaign leaderboard sorted by profit, not ROAS
6. Check: confidence badge shows correct coverage level
7. Check: hero card answers "did we make money today?"
8. Test responsive: 768px and 480px breakpoints
