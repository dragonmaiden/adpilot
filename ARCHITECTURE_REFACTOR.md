# AdPilot Architecture Refactor Plan

## Owner's Priority List (verbatim)
1. **Stabilize API contracts** — each endpoint returns one clean, versioned response shape — no raw Meta/Imweb shapes leaking to UI
2. **Move transforms to backend** — chart-ready arrays — precomputed aggregates — explicit null/default handling
3. **Add server-side validation** — schema checks — fail loudly if vendor payload shape changes
4. **Persist lightweight snapshots locally** — raw vendor dumps or normalized JSON — enough for debugging and recovery

## Target Architecture Layers
```
raw vendor fetchers → normalization layer → analytics/aggregation layer → presentation API layer → dumb UI renderer
```

## The Real Enemy
"Contract drift: vendor API shape changes, server returns inconsistent structures, frontend silently assumes wrong format, charts break without obvious logs"

---

## Implementation Guide

### Phase 1: Stabilize API Contracts

Create a new directory `server/contracts/` with explicit versioned response schemas.

**What to create:**

`server/contracts/v1.js` — export factory functions that build every API response from normalized data. The UI code should only ever see these shapes. Example:

```js
// Every endpoint has a builder
module.exports = {
  API_VERSION: 'v1',

  overview({ kpis, campaigns, dailyMerged, hourlyOrders, scanStats, lastScan, isScanning }) {
    return {
      apiVersion: 'v1',
      ready: true,
      lastScan,
      isScanning,
      kpis: {
        revenue: kpis.revenue ?? 0,
        refunded: kpis.refunded ?? 0,
        netRevenue: kpis.netRevenue ?? 0,
        totalOrders: kpis.totalOrders ?? 0,
        adSpend: kpis.adSpend ?? 0,
        adSpendKRW: kpis.adSpendKRW ?? 0,
        purchases: kpis.purchases ?? 0,
        cpa: kpis.cpa ?? 0,
        ctr: kpis.ctr ?? 0,
        roas: kpis.roas ?? 0,
        refundRate: kpis.refundRate ?? 0,
        cancelRate: kpis.cancelRate ?? 0,
        cogs: null, // placeholder until Google Sheets connected
      },
      campaigns, // already normalized
      // CHART-READY arrays — frontend does zero transformation
      charts: {
        dailyMerged,    // [{date, revenue, refunded, orders, spend, purchases, clicks, impressions, ctr, cpc}, ...]
        hourlyOrders,   // [{hour: 0, orders: 9}, {hour: 1, orders: 1}, ...]
        weekdayPerf,    // [{day: 'Mon', spend, purchases, cpa, ctr, revenue, ...}, ...]
        weeklyAgg,      // [{week, profit, revenue, refunded, spend, purchases, cpa}, ...]
        monthlyRefunds, // [{month, revenue, refunded}, ...]
        dailyProfit,    // [{date, profit}, ...]
      },
      scanStats,
    };
  },
  // ... similar for analytics, campaigns, postmortem, spend-daily, etc.
};
```

Key contract rules:
- Every numeric field uses `?? 0` or `?? null` — never undefined
- Every array field is always an array, never a dict or null
- `charts` object contains ONLY chart-ready arrays — no dicts, no raw vendor shapes
- apiVersion field in every response for future versioning

### Phase 2: Move Transforms to Backend

The transform functions currently in `public/live.js` (lines 86-206) must move to `server/transforms/`:

Create `server/transforms/charts.js`:
- `buildDailyMerged(revenueByDay, dailyInsights)` — already written in live.js, move verbatim
- `buildWeekdayPerf(daily)` — move from live.js
- `buildHourlyOrders(hourlyArr)` — move from live.js
- `buildWeeklyAgg(daily, usdToKrw)` — move from live.js
- `buildMonthlyRefunds(daily)` — move from live.js
- `buildDailyProfit(daily, usdToKrw)` — move from live.js

Then update `server/index.js` endpoints:
- `/api/overview` — compute ALL chart data server-side, return via contract builder
- `/api/analytics` — same, return chart-ready arrays
- `/api/spend-daily` — already mostly server-side, wrap in contract

Then update `public/live.js`:
- REMOVE all `build*` transform functions
- Frontend simply receives arrays and plugs them into Chart.js datasets
- No dict-to-array conversion, no aggregation, no null checking — that's all backend now

### Phase 3: Server-Side Validation

Create `server/validation/vendorSchemas.js`:

Add shape validators for vendor API responses:
```js
function validateMetaCampaigns(data) {
  // Check each campaign has: id, name, status, daily_budget
  // Log warning if unexpected fields or missing required fields
}

function validateImwebOrders(data) {
  // Check list items have: totalPaymentPrice, totalRefundedPrice, wtime, sections
  // Log warning if shape changed
}

function validateMetaInsights(data) {
  // Check each row has: date_start, spend, impressions, clicks, actions
}
```

Integrate into scheduler.js scan pipeline:
- After each vendor fetch, run validation
- Log structured warnings: `[VALIDATION] Meta campaigns response missing field 'daily_budget' on 2 items`
- If critical fields missing, throw (fail loudly) rather than silently producing garbage charts

### Phase 4: Persist Snapshots

In scheduler.js, after each successful scan:
```js
// Save raw vendor dumps (already partially done with latest_data.json)
saveData(`snapshots/${scanId}_meta_campaigns.json`, campaigns);
saveData(`snapshots/${scanId}_meta_insights.json`, { campaignInsights, adSetInsights, adInsights });
saveData(`snapshots/${scanId}_imweb_orders.json`, orders);
saveData(`snapshots/${scanId}_normalized.json`, latestData);
```

Add snapshot cleanup: keep last 48 snapshots (2 days at hourly scans), delete older ones.

Add a debug endpoint: `GET /api/snapshots` — list available snapshots with timestamps.
Add `GET /api/snapshots/:scanId` — retrieve a specific snapshot for debugging.

---

## File Changes Summary

### New files to create:
- `server/contracts/v1.js` — response shape builders
- `server/transforms/charts.js` — chart data transform functions (moved from live.js)
- `server/validation/vendorSchemas.js` — vendor payload shape validators

### Files to modify:
- `server/index.js` — use contract builders, call transforms server-side, add snapshot endpoints
- `server/modules/scheduler.js` — add validation after vendor fetches, add snapshot persistence
- `public/live.js` — REMOVE transform functions, simplify to just consume chart-ready arrays from API

### Files NOT to modify:
- `server/modules/metaClient.js` — raw fetcher, leave as-is
- `server/modules/imwebClient.js` — raw fetcher, leave as-is (processOrders stays here as it's normalization of raw vendor data)
- `server/modules/optimizer.js` — leave as-is
- `server/modules/telegram.js` — leave as-is
- `server/config.js` — leave as-is
- `public/app.js` — leave as-is (chart initialization is fine)
- `public/index.html` — leave as-is
- `public/style.css`, `public/base.css` — leave as-is

## Important Notes
- The `processOrders()` function in imwebClient.js is part of the normalization layer — it converts raw Imweb order data into a standard shape. It should stay in imwebClient.js.
- The scheduler already saves `latest_data.json` and `latest_scan.json` — enhance this with timestamped snapshots.
- The USD_TO_KRW rate (1450) is in config.js — use `config.currency.usdToKrw` everywhere, don't hardcode in transforms.
- After refactor, `live.js` should have ZERO data transformation logic — it just fetches and plugs arrays into charts.
- Git: push all changes to `main` branch on `dragonmaiden/adpilot`.
