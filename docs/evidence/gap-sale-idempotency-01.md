# Evidence — GAP-SALE-IDEMPOTENCY-01: sale operation identity at the edge

_The sale-path analogue of RR-F03. RR-F03 gave the refund pipeline operation identity + canonical
payload identity; the sale pipeline had neither, so the same sale id committed twice with a different
payload double-appended locally. Reproduced on current `main` first, then fixed. Synthetic data;
not merged, not deployed._

- **Fix commits:** `cc1fb17` (the guard in `createEdgeNode.commit` + wiring in `main.ts`),
  `e813760` (the regression tests).
- **Branch:** `claude/new-session-lw91i4`, on top of `main` after PR #348 (`25ded0b`).
- **Verdict:** **PASS** — reproduced, fixed, and covered by integration + unit tests; full suite and
  the real-PostgreSQL job green.

## The gap (reproduced on current main)

`createEdgeNode.commit` appended a sale to the durable log on **every** call, with no
operation-identity guard — the exact exposure RR-F03 closed for refunds, left open on the sale side.
The same sale id committed twice with a different payload therefore wrote two conflicting durable
records and **both "succeeded"**. The split was hidden downstream: the sync outbox mints one
idempotency key per sale id, so the cloud deduped the send and only one sale was ever transmitted —
the disk and the cloud silently disagreed about what the lane recorded, and no exception surfaced
(against P-08).

Reproduction (the guardless `createEdgeNode`, which is exactly how `main.ts` wired the sale path
before this fix): commit `S-dup` for ₹50, then `S-dup` again for ₹60:

```
WITHOUT guard: a.committed=true b.committed=true b.refusedBecause=-                 durable_sales=2 queued=1
```

Two durable sale records under one id; only one queued — the second record has no path to the cloud
and no visible exception.

## The fix

The sale-path mirror of the returns guard (RR-F03), so the two pipelines behave identically.

- `edge/store-edge/src/index.ts` — `createEdgeNode` gains an optional `salesIdempotency` guard. The
  durable-write-and-queue is extracted into a `commitAndQueue` closure; when the guard is present,
  `commit` decides operation identity + canonical payload identity **before anything is written**:
  - an **identical retry** (`fresh`→`duplicate`) returns the original outcome — nothing is appended
    or queued a second time;
  - a **reused id with a different payload** (`conflict`) is refused with
    `refusedBecause: 'idempotency_conflict'` and a plain-English lane message ("Do not take payment —
    tell the manager"); nothing is written;
  - a genuinely **fresh** sale commits and queues exactly as before.
  Concurrent calls with the same id are serialised through a per-id `salesInFlight` map, so a race
  resolves to at most one durable write. A standalone/demo edge with no guard keeps the original
  behaviour (unit tests that construct the node directly still run).
- `edge/store-edge/src/main.ts` — the composition root builds `salesIdempotency` from the durable
  sale log at boot (each record's `id` + `canonicalHash` of the record) and injects it, so the rule
  holds **across a restart** — the exact mirror of how `returnsIdempotency` is built from the returns
  log.

Ledgers stay append-only (hard rule #2): a conflict is refused, never overwritten.

After the fix, same reproduction:

```
WITH guard   : a.committed=true b.committed=false b.refusedBecause=idempotency_conflict durable_sales=1 queued=1
```

## Commands and results

```
pnpm run typecheck   # exit 0
pnpm run lint        # exit 0
pnpm run secret-scan # exit 0  (1587 files checked, clean)
pnpm audit --audit-level=high  # exit 0 (only the pre-existing moderate vitest advisories remain)

pnpm test            # full non-DB suite
  Test Files  571 passed | 19 skipped (590)
       Tests  6354 passed | 262 skipped        # +7 new

DB_TESTS_REQUIRED=1 pnpm run test:db            # real disposable PostgreSQL 16.13
  Test Files  226 passed (226)
       Tests  1517 passed (1517)                # +7 new (the suite runs with the DB present too)
```

Tests: `tests/integration/sale-idempotency.test.ts` — same id + different money → explicit conflict,
nothing written/queued; identical retry → original outcome, no extra effect; ordinary fresh sale
still commits and queues; conflict enforced after a restart (rebuilt from the durable log) and an
identical retry after restart is still a harmless duplicate; two concurrent same-id calls race to at
most one write; canonical payload identity (key-order-independent, money-sensitive) and the
fresh/duplicate/conflict classifier for a sale id.

## Scope and honesty notes

- **The sale path is never blocked by this.** A fresh sale commits exactly as before; only a reused
  id is affected, and an identical retry is a harmless no-op — the safe behaviour a lost-reply retry
  (RR-F02) depends on.
- **Local at-most-once, per edge.** This is the edge-local guarantee, the mirror of RR-F03. It is
  not a claim of global at-most-once across lanes — the sale pipeline already collapses re-sends to
  one sale at the cloud via the per-sale idempotency key, and the disk/cloud agreement this fix
  restores is what that dedupe assumed.
- **No re-rate.** Headline completion stays **41.5%** — hardening of the M07/§31 offline sale path,
  not new maturity.
