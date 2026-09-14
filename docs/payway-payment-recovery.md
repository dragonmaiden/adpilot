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
