# Payway payment confirmation recovery

## Failure addressed

The September 13 incident exposed a lost-update race: a polling task could load
tracking state, await network I/O, then overwrite an order registered by the
scanner during that wait. The next scan recreated the watch with a later start
time. A five-minute matching window then rejected the earlier approval, while
the direct monitor's advancing cursor also skipped it. The race is reproduced
in tests; historical logs support this sequence but do not retain every state
file version or establish who cancelled the order.

## Guarantees and limits

- In this single-process service, scanner registration and a running poll share
  one state object. Refreshes preserve an in-progress confirmation.
- Tracking writes use fsync and atomic replacement. Corrupt state stops the
  workflow instead of being overwritten with an empty history.
- Exact-order approvals are replayed over a bounded 24-hour recovery window.
  Amount, approval, terminal policy, and ambiguity checks still apply.
- A detected payment is saved before confirmation. Retries survive restart and
  continue for 24 hours; a verified Imweb write is not repeated for a Telegram retry.
- Imweb confirmation checks cancellation/closure first, then reads the order
  back after the PATCH. Telegram completion requires verified confirmation when
  automatic confirmation is enabled.
- New expirations, completion failures, and direct manual-review cases trigger
  Telegram attention warnings. Failed warnings retry; successful warnings are
  tracked. Existing historical expirations are not replayed as new alerts.

This does not guarantee zero incidents. Provider downtime, missing approvals,
outages beyond the recovery window, unavailable Telegram, and another bot's
mutations still need operator intervention. The tracking file is owned by one
Node process; multiple writers require shared transactional storage first.

## Timely confirmation

The normal-operation target is confirmation within 60 seconds after an approval
becomes visible in Payway. This is a target, not a provider availability guarantee.
Scheduled checks use start-to-start cadence (30 seconds by default), subtracting
processing time instead of adding another full interval afterward. A slow check
is followed by a one-second minimum gap, without overlapping confirmation polls.

Telegram delivery and warning requests run separately from scheduled confirmation
checks. Per-order notification tasks are deduplicated; their acknowledgments share
the single in-process state owner. Detected approvals remain reserved and durable
while Telegram is pending. Manual `runDueChecks` calls wait for notifications by
default; the scheduler explicitly uses `waitForNotifications: false`.

Failed Imweb confirmations persist their retry state immediately and send only
the independent attention warning. The payment-completion notification is not
started until confirmation succeeds, so blocked Telegram delivery cannot hold
the same order's next confirmation retry. A regression test reproduces this
failure on the earlier implementation and verifies a retry on the next poll.

The September 5 order's observed approval time is also replayed in tests with
late scanner registration and with no scanner watch. Both confirm exactly once
when the approval is available and Imweb remains eligible. This is conditional
coverage, not proof of the historical cause: September 5 runtime logs and order
cancellation history were unavailable during the investigation. Historical
cancelled orders are not automatically repaired by deploying these changes.

Single-order Imweb reads and confirmation requests have ten-second timeouts.
An ambiguous timeout is retried by checking Imweb status first, not blindly
repeating the PATCH. Confirmation failure schedules an attention alert immediately.
Poll duration and confirmation request duration are logged; `paymentFirstObservedAt`
and the actual `imwebConfirmation.confirmedAt` provide observation-to-confirmation
timing. These timestamps cannot reveal when Payway first published an approval.

## Operator response

1. Check the exact Imweb order number against Payway's merchant order reference,
   approval, amount, terminal and cancellation/refund status.
2. Read the Imweb order history. A Payway approval does not prove Imweb marked
   the order paid, and a Telegram tick is not the authoritative payment record.
3. For a cancelled/closed order, decide customer/order recovery separately.
   Do not automatically reopen it, collect another payment, or modify COGS.
4. Use `Imweb payment verified` and completion/error logs to trace new processing.
   A successful deployment or passing tests alone is not a real-order receipt.
5. If reverting code, preserve `/data/payway_payment_watch_state.json`; never
   clear tracking history to force retries. The old race returns on rollback.

Verification: `npm test`, `npm run lint`, and `git diff --check`. The watcher tests
cover concurrent registration, delayed approvals, restart recovery, warnings,
atomic-write failure, corruption, amount/ambiguity limits, and cancellation.

## Cloud reconciliation reports

The existing single-instance Render service runs a separate read-only audit at
14:00 and 21:00 Asia/Seoul. A one-minute scheduler checks the latest due slot;
startup catches up that slot once. A laptop or Codex session is not required.
The fast payment-confirmation watcher remains independent of these reports.

Each report checks Payway approvals/refunds against fresh Imweb order/payment
records for the current month, at least 48 hours across month boundaries, and
carried unresolved references. Older referenced orders extend the Payway range
once to include original approvals; any remaining missing approval needs review.
Nonstandard references and possible split payments require review, not amount-only
matching. This is Payway-to-Imweb coverage, not an audit of every other payment
provider. Historical approval-to-confirmation delays are timing review items,
not unpaid orders or proof of when Payway made an approval visible.

Every run sends Shue Updates a focused payment-confirmation check. Action-needed
alerts list paid-but-unconfirmed, paid-but-cancelled, or failed-confirmation cases,
counting affected orders once. Historical delays, refund/accounting mismatches,
and expired watches without payment proof stay in the saved audit, not the Telegram
warning count. Unmatched approvals/missing orders get a separate informational
caveat and cannot produce an unqualified all-clear. Missing pages, unavailable
sources, and missing cash fields produce an incomplete warning. Reports never
confirm, cancel, reopen, charge, refund, or modify COGS.
The destination ID and title must match before sending.

`/data/payment_reconciliation.json` stores reports, unresolved cases, and Telegram
receipts using atomic writes. Do not delete it to force a resend. Ambiguous sends
are not retried blindly; explicit rejections retry after at least five minutes.
Corrupt state or unavailable persistent storage stops delivery. Reports retain
62 recent slot receipts plus unresolved delivery records. This requires one Node
process on persistent storage; multiple instances require shared locking first.

Inspect authenticated `GET /api/audits/payments` and `[PAYMENT AUDIT]` logs for
schedule, last report, delivery status and message ID. Enabled by default on
Render, disabled locally; `PAYMENT_RECONCILIATION_ENABLED=false` disables it.
Deploy to the existing service, verify its exact commit and first Telegram receipt,
then pause the local Codex schedule. Rollback must preserve the state file.
While Render itself is down it cannot send reports; startup catches up only the
latest slot, not every missed notification. Scheduled delivery is not a guarantee
against provider outages or evidence that historical discrepancies were repaired.
