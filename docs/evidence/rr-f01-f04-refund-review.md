# Evidence — RR-F01…RR-F04: the Codex restart/refund review findings

_Verification record for the four open Codex findings. Each was reproduced against **current `main`**
first (not the audited commit), then repaired in the owner-directed order, in one PR with separate
reviewable commits. Synthetic data only; nothing here touches production (hard rule #7). Not merged,
not deployed._

- **Baseline audited commit (findings' origin):** `12d84937457765acff7bc33a6c47499d0dc52f8e`
- **Repaired on:** `claude/new-session-lw91i4`, on top of `main` after PR #345 (RR-F05/06) and #346 (js-yaml).
- **Verdict:** **PASS** — all four reproduced, fixed, and covered by regression tests; full suite and
  the real-PostgreSQL job green. The two findings that cannot be fully solved offline (cross-lane
  at-most-once) are handled by an explicit safe policy and recorded as a separate gap, not overclaimed.

| Finding | Fix commit | Reproduced (before → after) |
|---|---|---|
| RR-F01 untrusted request mutates the lane log | `0adc015` | text/plain + foreign Origin: 200, 1 record written → **refused (415/403), 0 written** |
| RR-F03 reused refund id, different money | `ededd39` | both committed, 2 records → **conflict, 1 record**; identical retry is a no-op |
| RR-F04 second full refund via stale history | `26506ba` | sold 1, two refunds committed → **over-return refused, 1 record**; partials still pass |
| RR-F02 lost reply reported as definite failure | `cd574c0` | lost reply → committed:false → **resolved to committed via idempotent retry; unreachable → unconfirmed, never a false failure** |

Findings register (owner step 2): `docs/audit/CODEX_RESTART_REFUND_REVIEW_FINDINGS.md` (commit `3bb85d1`).

---

## RR-F01 — authorize before writing · `edge/store-edge/src/lane-server.ts`

CORS headers and the loopback bind are not caller authorization: a `text/plain` cross-origin request
is a CORS *simple request* delivered with no preflight, so the record was written before the missing
CORS header could stop the reply being read. Now `laneCallRefusal` decides authorization **before the
body is read**: a foreign `Origin` → 403, a non-`application/json` content type → 415. A request with
no Origin (same-origin, or a non-browser client already on this machine — inside the loopback trust
boundary) with JSON is allowed, so authorized offline operation is preserved. Tests:
`tests/integration/lane-server-authorization.test.ts` (the exact probe on both routes writes nothing;
foreign origin refused even with JSON; text/plain refused even with no Origin; authorized path
commits; unit checks of the decision).

## RR-F03 — operation identity + canonical payload identity · `edge/store-edge/src/idempotency.ts`, `index.ts`

A refund id is an operation identity. The edge now decides a reused id **before** writing: identical
canonical payload → returns the original outcome, nothing written again; different money under the
same id → `idempotency_conflict`, nothing written. Rebuilt from the durable returns log at boot
(holds across restart); a per-id in-flight map coalesces concurrent same-id calls. The till surfaces a
conflict as `RefundConflictError`. Tests: `tests/integration/refund-idempotency.test.ts` (conflict,
identical retry, restart, concurrency, cloud-queue count, till error type, canonical-hash unit).

## RR-F04 — entitlement from trusted data · `edge/store-edge/src/entitlement.ts`, `index.ts`

Entitlement is computed from what the box durably knows — how much each sale it rang sold (its sale
log) and how much has already come back (its returns log) — never the numbers the request supplies.
A refund exceeding the unreturned quantity is refused (`over_return`); the returned side is reserved
atomically so two refunds of the last unit cannot both pass; rebuilt from the logs at boot. Legitimate
partial refunds up to the sold quantity all pass (it does not reject every refund). A sale this edge
did not ring (cross-lane / no receipt) has no trusted local record: it is allowed under the existing
approval/cap controls and its global at-most-once is left to cloud reconciliation — **never claimed
locally** (recorded as `GAP-REFUND-XLANE-01`). The till surfaces an over-return as
`RefundNotEntitledError`. Tests: `tests/integration/refund-entitlement.test.ts` (valid-then-invalid,
partials, restart, concurrency, cross-lane safe policy, till error type, entitlement unit).

## RR-F02 — a lost reply is uncertain, not failure · `apps/pos/src/browser-entry.ts`, `till-session.ts`

A dropped reply on the refund route is retried by re-posting the **same** record; the edge dedupes it
(RR-F03), so the retry resolves whether the first attempt landed with no risk of a second refund. Only
when the store cannot be reached at all — after the retries — is the outcome reported as
**unconfirmed** (`committed:false` but explicitly not a definite failure: hold, do not re-run), which
the till surfaces as `RefundUncertainError`. This matters because a reply can be lost *after* a durable
fsync (a power cut between the write and the HTTP reply), where "definitely failed, use another lane"
is exactly what would cause a double refund. The sale route stays a definite refusal on a lost reply
(not idempotent yet — `GAP-SALE-IDEMPOTENCY-01`), so no unsafe retry there. Recording, cash handover
and provider settlement stay distinct. Tests: `tests/integration/refund-lost-reply.test.ts`.

---

## Commands and results

```
pnpm run typecheck   # exit 0
pnpm run lint        # exit 0
pnpm run secret-scan # exit 0 (clean)
pnpm audit --audit-level=high   # exit 0 (js-yaml cleared in #346; only the pre-existing moderate vitest advisory remains, below threshold)

pnpm test            # full non-DB suite
  Test Files  569 passed | 19 skipped (588)
       Tests  6337 passed | 262 skipped (6599)     # +44 new RR-F01..RR-F04 tests over the RR-F05/06 baseline

# Real, disposable PostgreSQL 16.13 (isolated, synthetic, never production), port 55432:
DB_TESTS_REQUIRED=1 pnpm run test:db
  Test Files  224 passed (224)
       Tests  1504 passed (1504)
```

## Scope, safe policy and honesty notes

- The four findings are reproduced and fixed; the RR-F05/RR-F06 recovery tests are retained and green.
- **Explicit safe policy for what cannot be solved offline:** a refund whose original sale is not on
  this edge cannot be entitlement-checked locally, so at-most-once across lanes is deferred to cloud
  reconciliation and never claimed locally (`GAP-REFUND-XLANE-01`). A newly noticed sale-path analogue
  of RR-F03 is recorded as `GAP-SALE-IDEMPOTENCY-01`. Both are recorded separately and do **not**
  renumber or replace RR-F01…RR-F06.
- **Sale path unchanged** on the money-critical write: sale commit still commits-then-queues; the only
  addition is an in-memory, post-write note of what a sale sold (for refund entitlement), which cannot
  affect the sale.
- **No re-rate.** Headline completion stays **41.5%** — hardening of existing M13 refund / offline
  controls, not new maturity.
```
