# Evidence — RR-F05 / RR-F06: restart recovery for sales and refunds

_Verification record for the two restart-recovery findings from the PR #345 review. Prepared for
review within the existing PR; not merged or deployed. Synthetic data only — nothing here touches
production (hard rule #7)._

- **Fix commit:** `98ea05b` (`RR-F05/RR-F06: durable failed-sync store and correct restart recovery`)
- **Branch:** `claude/new-session-lw91i4` (PR #345), on top of `main` including the merged js-yaml
  security fix (#346, squash `91a528a`).
- **Verdict:** **PASS** — the defect is reproduced against the real edge, fixed, and proven by
  regression tests; the full suite and the real-PostgreSQL job are green with no assertion weakened.

---

## The finding (RR-F06), confirmed first-hand before the fix

Driving the **real** `startEdge` with a cloud that permanently refuses one sale (HTTP 400):

```
DEAD-LETTERS before restart: 1        # the failed sale is dead-lettered, visible
sales cursor after dead-letter: 1     # the durable cursor advanced OVER it
DEAD-LETTERS after restart: 0 | unsent after restart: 0   # <-- gone. neither kept nor re-queued
```

The dead-letter lived only in the in-memory `SyncOutbox`; the cursor was advanced past it (a
dead-letter counted as "finished"); on restart the record was below the cursor and the in-memory
dead-letter died with the process. A refund that could not sync would vanish with nothing saying so —
the exact silent discard hard rule #6 forbids.

The same advance added the finished prefix of the **deduped** outbox to the cursor, so a duplicate
record in the log left the cursor permanently one short and re-sent the tail on every restart
(RR-F05).

## After the fix — same reproduction

```
DEAD-LETTERS before restart: 1
sales cursor after dead-letter: 1
DEAD-LETTERS after restart: 1 | unsent after restart: 0   # recovered, visible, not blindly re-sent
```

## What changed

| File | Role |
|------|------|
| `edge/store-edge/src/dead-letter-log.ts` (new) | Durable, append-only failed-sync store: payload, reason, attempts, timestamps and resolution history, folded from its facts. Reuses the length-framed, fsync'd, truncation-visible log format. |
| `edge/store-edge/src/sync-pipeline.ts` (new) | One pipeline's restore + cursor advance + dead-letter durability, shared by sales and refunds. A position is DONE only when acknowledged or **durably** dead-lettered; the cursor is derived per log position from a fixed base. |
| `edge/store-edge/src/sync-cursor.ts` | `writeCursor` is now atomic (temp file → fsync → rename → dir fsync) so an interrupted checkpoint write cannot tear. |
| `edge/store-edge/src/main.ts` | Wires two pipelines, opens their durable dead-letter stores, persists new dead-letters **before** advancing each cursor, and exposes `syncOnce()`. The sale path is untouched. |
| `tests/unit/edge-dead-letter-log.test.ts` (new) | The store's fold: payload/reason/attempts/history; latest state wins; unreadable facts skipped, not guessed. |
| `tests/integration/failed-sync-survives-restart.test.ts` (new) | The behavioural regression suite (below). |

## Requirements covered

**RR-F05 — restart recovery for BOTH sales and refunds**
- Checkpoints track actual durable-log positions — derived per keyed log position from a fixed base,
  so duplicates collapse correctly (test: *duplicate record does not strand the cursor*, cursor ends
  at `2` for two copies, delivered once).
- Repeated idle cycles do not advance incorrectly — the base-relative computation is idempotent
  (a `syncOnce` then a `stop` no longer double-count; caught and fixed during testing).
- Records hidden by previously-incorrect checkpoints are recovered — a dead-letter sitting below an
  incorrect cursor is restored from the durable store (test); a checkpoint claiming more than the log
  holds triggers a full safe re-scan (test).
- Safe replay without duplicate financial effects — re-sends dedupe at the cloud on the event key; a
  restored dead-letter is never auto-retried (test).
- Duplicate, malformed and interrupted-checkpoint cases handled explicitly (tests).

**RR-F06 — failed-sync records survive restart**
- Payload, failure reason, attempts, timestamps and resolution history persisted and restored
  (unit + integration tests); history never reset on restart (attempts preserved, `5` after a budget
  exhaustion).
- Unresolved failures stay visible and actionable after restart (`deadLetterCount` is `1` on the
  restarted edge, for both the sale and refund pipelines).
- Never silently discarded — append-only store, a resolution is a new entry, never an edit.

## Commands and results

```
# Reproduction (real startEdge, permanently-refusing cloud) — before vs after: see above.

pnpm run typecheck            # exit 0
pnpm run lint                 # exit 0
pnpm run secret-scan          # exit 0 (clean)

pnpm test                     # full non-DB suite
  Test Files  565 passed | 19 skipped (584)
       Tests  6309 passed | 262 skipped (6571)      # +16 new RR-F05/RR-F06 tests

# Real, disposable PostgreSQL 16.13 (isolated, synthetic, never production), port 55432:
DB_TESTS_REQUIRED=1 pnpm run test:db                 # tests/integration + tests/migration
  Test Files  220 passed (220)
       Tests  1476 passed (1476)                     # +11 new (the integration file runs here too)
  pnpm db:migrate x2 -> 11 applied, then 0 (idempotent); backup->drop->restore reconciles exactly.

pnpm exec vitest run tests/unit/edge-dead-letter-log.test.ts \
                     tests/integration/failed-sync-survives-restart.test.ts
  Test Files  2 passed (2)
       Tests  16 passed (16)
```

## Scope and honesty notes

- The approved per-lane offline architecture and the durable append-only log are preserved; the sale
  path (`commitLocally`, `createEdgeNode.commit`, `file-log` append) is byte-for-byte unchanged.
- One limitation stated plainly: a record that a **pre-fix** box dead-lettered-and-skipped, with no
  durable store yet written, cannot be resurrected retroactively (there is no record of it). Going
  forward the durable store and the corrected advance prevent any new such loss, and a checkpoint
  that is *provably* corrupt (claims more than the log holds) re-scans and recovers.
- **No re-rate.** Headline completion stays **41.5%** — this is hardening of an existing capability
  (§31 durable outbox / recovery), not new maturity.
- The other four PR #345 review findings remain **open**, untouched by this change.
