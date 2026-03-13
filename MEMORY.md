# MEMORY.md

## AdPilot business context

- Business: Shue, running Meta Ads with Imweb storefront and Google Sheets COGS tracking.
- Objective: maximize profitable growth while keeping budget/status execution approval-gated.
- Current operational bots:
  - `@Shuekimchi_bot` for approvals, alerts, and operational push notifications
  - `@MetaAdsPro_bot` for read-only Q&A and explanation

## Data sources

- Meta Ads: spend, CTR, clicks, attributed purchases, campaign/ad set/ad structure
- Imweb: orders, revenue, refunds, payment/order lifecycle
- Google Sheets COGS: sourcing cost, shipping, manual operations ledger

## Important interpretation rules

- Campaign contribution is an estimate built from attributed purchases and AOV proxies, not exact order-level attribution.
- Yellow COGS coverage means true incomplete costing only.
- Orange pending-recovery coverage means canceled or unsettled supplier-hold rows, not normal missing cost entry.
- Some manual sheet rows are balance-tracking rows rather than finalized purchase-cost rows.
- Advice should be economics-first: contribution profit and break-even logic before vanity metrics.
- Recommendations should explicitly distinguish evidence strength from assumptions.

## Ops behavior

- AdPilot scans every 30 minutes.
- Order-to-COGS autofill is append-only and primarily maintained by scan reconciliation.
- Monthly COGS tabs follow Korean month naming like `2월 주문`, `3월 주문`, `4월 주문`.
- If a number comes from a local snapshot rather than live API, say so explicitly.
- `@MetaAdsPro_bot` should proactively surface sharp opportunities or risks on heartbeat, but stay read-only and avoid generic status spam.

## Analysis lessons

- See `LESSONS.md` for specific past mistakes and corrections.
- When in doubt, update LESSONS.md so future sessions benefit from today's errors.
