# TOOLS.md

## Primary read-only source

Production AdPilot is the source of truth for current-state questions.

For any current-state question:
1. use live production AdPilot JSON endpoints first
2. only then use local snapshot files with `read` if production is unavailable or clearly stale
3. use production page content as the weakest fallback

Only fall back to asking the user for data if all read-only sources are unavailable or clearly stale.

Do not let stale local auth/scan errors outrank fresher live production source-health data.
If local files say Imweb is broken but production `/api/settings` or `/api/health` says sources are connected, trust production for “right now” answers.

## Preferred live production endpoints

Use these first when answering questions like:
- `check now`
- `top risks`
- `top opportunities`
- `what changed`
- `currently`

Primary:

- `https://adpilot-6bxs.onrender.com/api/health`
- `https://adpilot-6bxs.onrender.com/api/settings`
- `https://adpilot-6bxs.onrender.com/api/overview`
- `https://adpilot-6bxs.onrender.com/api/optimizations?limit=20`

Deeper drill-down when needed:

- `https://adpilot-6bxs.onrender.com/api/analytics`
- `https://adpilot-6bxs.onrender.com/api/campaigns?days=7d`
- `https://adpilot-6bxs.onrender.com/api/reconciliation`
- `https://adpilot-6bxs.onrender.com/api/calendar-analysis`

## Analysis framework files

Use these workspace files to sharpen analysis quality:

- `OPERATING-PLAYBOOK.md` for diagnostic order and decision quality
- `INPUT-CONTRACT.md` for normalizing incomplete inputs
- `TASK-TEMPLATES.md` for reusable answer structures and analysis modes

## Local snapshot fallback

If live production JSON is unavailable, prefer these local files read-only before scraping a weaker web source:

- `/Users/sekoyaz/Desktop/adpilot/server/data/latest_data.json`
- `/Users/sekoyaz/Desktop/adpilot/server/data/latest_scan.json`
- `/Users/sekoyaz/Desktop/adpilot/server/data/all_optimizations.json`
- `/Users/sekoyaz/Desktop/adpilot/server/data/scan_history.json`

When using local snapshots, say clearly that the answer is from a local snapshot and may lag production.

## Business map

- Meta Ads provides campaigns, ad sets, ads, spend, clicks, CTR, and attributed purchases.
- Imweb provides orders, revenue, refunds, and customer/order details.
- Google Sheets COGS provides sourcing cost, shipping, and manual operational ledger rows.
- AdPilot combines these into profit, pacing, optimization, and approval context.
- `@Shuekimchi_bot` owns approvals and operational alerts.
- `@MetaAdsPro_bot` is read-only Q&A and explanation.

## Important business caveats

- Campaign contribution is still an estimate, not exact order-to-campaign attribution.
- Some zero-cost COGS rows are not “missing cost”; they can be pending recovery or supplier-hold rows after customer cancellation.
- COGS sheet autofill is append-only and routes to monthly tabs like `3월 주문`, `4월 주문`.
- Order logging currently relies primarily on the 30-minute scan reconciliation path, with webhook support when available.

## Response style

- Use numbers directly.
- Name the source of truth behind important claims.
- If asked to take action, point the user to the approval bot or dashboard instead of trying to execute it yourself.
- Diagnose economics first, then platform metrics.
- Separate signal from noise.
- Avoid broad summaries when a sharper operator note is possible.
