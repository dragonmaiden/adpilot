# Render memory investigation — October 11, 2026

## Outcome and scope

Patch based on the deployed commit `53c74f10a9fede8af71a1b7729c09ff95c53f4f4`. The original `/Users/changyuesin/adpilot` checkout was clean at `12fd83d` and has not been changed. Work is isolated in `/Users/changyuesin/Documents/Codex/2026-10-11/task/adpilot`. This report records verification before publication. Publication and merge were subsequently authorized separately; no manual deployment, paid-capacity change, production-setting change or credential creation is part of this fix.

## Incident evidence

The delegating task supplied five confirmed 512 MiB OOM kills: four on October 8, and instance `5rzpl` on October 11 at 07:55:10 UTC, followed by availability at 07:55:21. Four crashes fell between the FX-refresh start and completion logs; one reached the economics-ledger stage. The 03:32:21 redeploy reused the October 3 commit. Sampled memory fluctuated around 278–407 MiB and did not capture the crash peak. A later scan completed at 08:39:42 UTC. These observations support investigating transient allocations rather than assuming steady leakage. The delegating task subsequently reported a sixth 512 MiB OOM at 09:33:35.913 UTC on October 11 (event `evt-db5lfrtg1s2s738hl9r0`, same instance), followed by order-fetch/payment-check logs at 09:40:29–09:40:40; exact recovery/full health were not established. This too preceded deployment of the patch.

`refreshFxRate()` updates a small FX object but invokes `scanStore.saveLatestData()`, which previously synchronously pretty-printed **every canonical and derived field** into one string and passed that string to `writeFileSync`. The same full-state write repeats throughout source collection, ledger construction, audit and final persistence. UTF-8 encoding can add another document-sized allocation. Snapshot sizing and saving also used whole-part `JSON.stringify`. The 252 MB snapshot total describes disk storage, not resident memory; retention and free-disk diagnostics do not establish a RAM cause.

`runScan()` already guards against overlapping scans with `getIsScanning()/setIsScanning()`. Payway polling has a `runningPoll` guard. No duplicate-loop cause was demonstrated. This patch preserves those guards and does not alter financial calculations, collection windows, payment workflows or checkpoints.

## Earlier resource-drain work

The connected GitHub search returned six accessible AdPilot PRs (#1–#6). None documented a Render resource-drain fix; the requested earlier PR could not be identified conclusively. Three relevant, confirmed earlier commits are:

- [`fad8080`](https://github.com/dragonmaiden/adpilot/commit/fad80803d3bdc5d9442865f7feef984e98e73058): bounds **disk** snapshot usage and preserves payment write headroom.
- [`1e3ba7b`](https://github.com/dragonmaiden/adpilot/commit/1e3ba7bb0c798aed23182b199818f84f9c88c137): keeps polling responsive during notification scans.
- [`53c74f1`](https://github.com/dragonmaiden/adpilot/commit/53c74f10a9fede8af71a1b7729c09ff95c53f4f4): fingerprints orders so unchanged raw financial payloads are not retransmitted to Postgres, reducing **network bandwidth**.

All three are already ancestors of the deployed code. The bandwidth patch still serializes individual orders for fingerprints; it does not bound full-state disk serialization. The current OOM has a distinct plausible mechanism. The evidence does not justify calling it the same proven cause as any earlier PR.

## Local implementation

Following repository principles B4 (prove behavior), B5 (measure before optimizing), B2 (one owner) and B12 (scope):

- `server/runtime/jsonFile.js` emits compact JSON in 64 KiB character chunks rather than a document-sized string/buffer. It is shared by scan state, last-successful Imweb backups, snapshot writes and snapshot byte sizing. Live serialization memory depends on chunk size, the largest scalar and object keys, rather than the complete document. Native scalar encoding preserves escaping, Unicode, null/nonfinite numbers, omission rules, date/toJSON values and ordinary financial JSON containers. Circular structures and BigInt fail loudly.
- Files are written to a private temporary sibling, synced and renamed after completion. Serialization failure, short writes and ENOSPC cannot truncate the previous recovery copy. Permissions remain `0600`; filenames and parsed recovery schemas remain compatible. Every checkpoint and canonical source record is retained.
- Snapshot reservation still measures actual UTF-8 bytes before pruning, now incrementally; retention limits, disk-headroom policy and failed-set cleanup are preserved.
- Memory-only diagnostics record RSS, heap, external and ArrayBuffer bytes around latest-data writes and after scan steps, plus process-lifetime peak RSS in KiB. No financial or customer payloads enter these logs. These readings identify stage boundaries; they are not a continuous peak trace.

## Reproduction and verification

The reproduction script is `scripts/memory-pressure.js`; invoke it with `old` or `new`. Raw local results were retained with the task artifacts. It builds 30,000 synthetic order-shaped rows with a 1 KiB payload, reused across nested orders/COGS/ledger collections, and a touched 160 MiB buffer to provide resident pressure. It writes the same state eight times. This pressure fixture is **not live financial data and not an estimate of production dataset size**.

| Runtime / limit | Old path | Fixed path |
| --- | --- | --- |
| macOS Node 26.4, unconstrained | 711.6 MiB peak RSS; 1.54 s | 339.9 MiB peak RSS; 4.31 s |
| macOS Node 26.4, 48 MiB V8 old-space limit | not run | eight writes succeed; 316.7 MiB peak RSS |
| Linux Node 22, Docker 512 MiB RAM, no swap, 384 MiB V8 old-space limit | exit 137; Docker `OOMKilled=true` | exit 0; `OOMKilled=false`; 262.2 MiB peak RSS; 11.14 s |

The fixed compact file measured 100,235,761 bytes; the old pretty-printed file measured 105,575,818 bytes. Linux tests used the already installed `node:22-bookworm-slim` image, disabled networking, and mounted the isolated source read-only. The two stopped benchmark containers were removed afterward. Process RSS excludes filesystem page cache; the container limit includes memory accounted to its cgroup.

Verification:

- Baseline before edits: `npm test` — 380/380 pass.
- After edits: `npm test` — 385/385 pass; `npm run lint` — clean.
- Focused JSON and snapshot tests: 10/10 pass, also verified in Linux Node 22 under a 512 MiB container limit.
- `node --check` on all touched JS files and `git diff --check` — pass.
- Regression coverage verifies financial/source round-trip and restart recovery, scalar encoding including Unicode chunk boundaries, refusal of cycles/BigInt, partial writes, ENOSPC and temporary-file cleanup, preservation of the latest recovery copy, bounded snapshot sizing, and repeated nested-document persistence in a 48 MiB V8 heap.

## Limits and remaining validation

The synthetic test establishes that whole-document persistence can reproduce a 512 MiB OOM and that this patch avoids it for the same fixture. It does **not** prove the five production kills share that cause. No current production latest-data file was available locally, and no live scan or production mutation was run.

The new writer remains synchronous and is slower on the deliberately large fixture. It trades CPU/time for lower peak allocation and recoverable writes. Actual event-loop delay needs checking on representative live-sized state before publication/deployment. Full JSON parsing during startup, vendor-response allocation, ledger construction, concurrent request work and exceptionally large individual scalar values remain possible memory pressure sources. No full-service 512 MiB end-to-end test was possible without live dependencies/data. Local full-suite verification used the available macOS dependencies; Linux verification covered the changed persistence code.

After the approved merge and automatic deployment, verify on representative sanitized production state and correlate stage memory diagnostics with high-resolution/cgroup memory around FX persistence and economics construction. Continue investigating if OOMs persist; do not treat service recovery or a completed scan as proof of resolution.
