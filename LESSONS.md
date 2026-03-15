# LESSONS.md

Log analysis mistakes, missed signals, and wrong calls here. Read this on startup to avoid repeating them.

Format: date — what happened — what was missed — what to do differently

## Lessons

- 2026-03-15 — Missed Imweb new-order rescue alert for an order that surfaced late in scans — the backstop trusted `wtime` instead of a broader rescue window, so an older same-day unpaid order skipped the pending alert and later jumped straight to the paid/COGS notification — for notification rescue logic, prefer a generous bounded reconciliation window over the narrow paid-order scan window.
