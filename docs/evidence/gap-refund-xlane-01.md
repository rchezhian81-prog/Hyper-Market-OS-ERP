# Evidence — GAP-REFUND-XLANE-01: cross-lane refund at-most-once (cloud)

_Verification record for the cloud half of double-refund protection. RR-F04 enforced at-most-once
locally per edge; this closes the cross-lane gap at the authoritative cloud guard. Reproduced on
current `main` first, then fixed. Synthetic data; not merged, not deployed._

- **Fix commits:** `a75bffc` (the pure rule in `packages/returns`), `b3c8880` (wiring the synced route + tests).
- **Branch:** `claude/new-session-lw91i4`, on top of `main` after PR #347.
- **Verdict:** **PASS** — reproduced, fixed, and covered by unit + integration tests; full suite and
  the real-PostgreSQL job green.

## The gap (reproduced on current main)

The desk route `POST /v1/sales/:saleId/returns` already refuses an over-return via `assessReturn`
against the whole cloud history. The **synced** route `POST /v1/sales/:saleId/returns/synced` — where
a refund that already happened at a lane reconciles — enforced only the §28 governance findings and
never checked global at-most-once. So a refund against a bill rung on another lane could over-return.

Reproduction (in-memory API harness): bank 1 unit (₹50), then two synced refunds of it under
different ids (two lanes):

```
RT1 status/flags: 202 []
RT2 status/flags: 202 []          <- accepted, NOT flagged
governance-exceptions count: 0    <- the over-return is not on the loss surface a person works
over-returns report: anyFound true [{ productId: P1, soldMinor: 1, returnedMinor: 2 }]
```

## The fix

A synced refund never rejects (the money already left the lane — hard rule #10), so the fix mirrors
the §28 pattern: **record and flag**, don't reject.

- `packages/returns/src/assess-return.ts` — `crossLaneRefundFindings(sale, priorReturns, priorRefunds,
  thisReturn)`: folds this return into the cloud history and returns `over_returned_goods` (cumulative
  returned of a product now exceeds sold) and/or `refund_exceeds_paid` (cumulative refunded now
  exceeds the bill total). Both added to `RefundGovernanceFinding`. Idempotent — the register and the
  refund total dedupe by return id.
- `services/pos/src/returns.ts` — the synced route computes these against `deps.originalSale` +
  `deps.priorReturns` + `deps.priorRefunds` and merges them into the recorded return's
  `governanceFlags`, so they surface on the existing `/v1/pos/return-governance-exceptions` loss
  report. A sale the cloud has not banked yet raises no such finding.

After the fix, same reproduction:

```
RT1 flags: []
RT2 status/flags: 202 ["over_returned_goods","refund_exceeds_paid"]
RT2 re-sync flags: ["over_returned_goods","refund_exceeds_paid"]   (idempotent)
governance-exceptions count: 1  ids: [{ id: RT2, f: [over_returned_goods, refund_exceeds_paid] }]
```

## Commands and results

```
pnpm run typecheck   # exit 0
pnpm run lint        # exit 0
pnpm run secret-scan # exit 0
pnpm audit --audit-level=high  # exit 0 (only the pre-existing moderate vitest advisory remains)

pnpm test            # full non-DB suite
  Test Files  ... passed | 19 skipped
       Tests  6347 passed | 262 skipped        # +10 new (6 integration + 4 unit)

DB_TESTS_REQUIRED=1 pnpm run test:db            # real disposable PostgreSQL 16.13
  Test Files  225 passed (225)
       Tests  1510 passed (1510)
```

Tests: `tests/integration/cross-lane-refund-guard.test.ts` (within-entitlement partials not flagged;
cross-lane over-return flagged + surfaced; money over-refund flagged independently; idempotent
re-sync; unknown sale recorded without a flag; over-return + §28 breach flagged together) and
`tests/unit/assess-return.test.ts` (the pure `crossLaneRefundFindings` arithmetic).

## Scope and honesty notes

- **Never rejects a synced refund** — the money already left the lane; a breach becomes a visible
  exception, consistent with the route's existing §28 handling and hard rule #10.
- **Best-effort at record time for the rare concurrent case:** two synced refunds racing for the last
  unit may each individually pass (neither sees the other's not-yet-recorded return); the aggregate is
  still caught by the `/v1/sales/:saleId/over-returns` report, which reads the final folded state. The
  sequential cross-lane case (the finding, and by far the common one) is flagged at sync time.
- **No re-rate.** Headline completion stays **41.5%** — hardening of the M13 refund controls.
```
