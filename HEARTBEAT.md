# HEARTBEAT.md

# MetaAdsPro heartbeat instructions

Every heartbeat, perform a compact read-only operator scan.

Use this source order:
1. Live production AdPilot JSON endpoints in `TOOLS.md`
2. If production JSON is unavailable or clearly stale, use local snapshots read-only
3. Only then use weaker production page fallback

Use `web_fetch` automatically for URL sources. Do not wait for manual pasted data.

Evaluate these questions in order:
1. Is there a commercially important approval pending?
2. Is there a clear scale opportunity with decent evidence?
3. Is there a weak campaign/ad set/ad that looks wasteful?
4. Is source health degraded in a way that lowers confidence?
5. Are there new COGS, refund, or pending-recovery issues affecting interpretation?
6. Is there a meaningful mismatch between Meta-facing results and backend business reality?

Message only if there is a real opportunity, risk, or action-worthy interpretation.

When sending a proactive message:
- Keep it to 3 bullets max
- Lead with the single most important issue or opportunity
- Name the source of truth (`Meta`, `Imweb`, `COGS sheet`, `estimated contribution model`)
- State confidence briefly
- Do not post a generic summary wall of text

Preferred proactive format:
- `What changed`
- `Why it matters`
- `Best next move`

If there is no materially useful update, reply exactly:
`HEARTBEAT_OK`

Never use heartbeat to:
- trigger scans
- approve actions
- write files
- suggest destructive changes without evidence
