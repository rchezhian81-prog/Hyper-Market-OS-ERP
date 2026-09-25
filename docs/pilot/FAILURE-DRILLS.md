# Pilot failure drills — the resilience evidence map (Phase 6)

_Release candidate `pilot-rc-1`. Non-production pilot only._

The one rule behind all of these: **no accepted write is silently lost, duplicated or overwritten**
(P-08, hard rules #1/#2/#10). Every scenario the pilot plan requires is already proven by an automated
test; the table below is the evidence map. The pilot-specific, surface-level invariants are also
co-located in one runnable check, `tests/integration/pilot-failure-drills.test.ts` (5 cases), so a single
run answers "do the core resilience guarantees still hold?" before the floor pilot.

## The 16 scenarios → control → proof

| # | Scenario | Control | Proven by |
|---|----------|---------|-----------|
| 1 | Internet loss / offline-first | POS commits to local disk first, syncs later (hard rule #1) | `tests/integration/it-remembers.test.ts`; `tests/guardrails/pos-offline.test.ts`; `tests/e2e/the-served-till-takes-a-sale.e2e.ts` |
| 2 | Restart recovery (sales + refunds + failed-sync) | edge sync-pipeline + dead-letter log survive restart | `tests/integration/failed-sync-survives-restart.test.ts` (RR-F05/RR-F06) |
| 3 | Duplicate / replayed request | edge sale operation-identity + cloud idempotency | `tests/integration/sale-idempotency.test.ts`; **+ `pilot-failure-drills.test.ts` (replay = one effect)** |
| 4 | Concurrent tills / cross-lane | cloud cross-lane refund guard; per-tenant audit-chain serialisation (no fork) | `tests/integration/cross-lane-refund-guard.test.ts`; `tests/integration/audit-trail-store.test.ts` |
| 5 | Session expiry / token revocation | verify-only token authenticator; session-revocation decision | `tests/integration/authorization-is-enforced.test.ts`; `tests/unit/identity-token.test.ts`; `tests/unit/identity-session-revocation.test.ts`; **+ drill (tampered/expired → 401)** |
| 6 | Unauthorized-role refusal | default-deny RBAC | `tests/security/access-control-sweep.test.ts`; `tests/security/the-platform-admin-cannot-post-a-business-transaction.test.ts`; **+ drill (cashier write → 403)** |
| 7 | Cross-tenant refusal | per-tenant event store; tenant from signed token only | `tests/integration/pilot-seed.test.ts`; `tests/integration/authorization-is-enforced.test.ts`; **+ drill (B sees none of A)** |
| 8 | Negative stock / oversell | OMS promise reserves at most on-hand; movements-ledger negative is a **visible exception**, not silent | `tests/integration/orders-lifecycle.test.ts`; `tests/integration/inventory-availability.test.ts`; **+ drill (reserved == on-hand, never more)** |
| 9 | Duplicate prevention at each write | idempotency at sale / refund / GRN / resend boundaries | `tests/integration/refund-idempotency.test.ts`; `tests/integration/goods-receipt.test.ts`; `tests/integration/it-remembers.test.ts` |
| 10 | Delayed / lost provider reply | a lost reply is **UNCONFIRMED**, not a definite failure; retry resolves once | `tests/integration/refund-lost-reply.test.ts` (RR-F02) |
| 11 | Stale / conflicting data | conflict → visible exception, never silent last-write-wins (hard rule #10) | `tests/integration/day-close-reconcile-on-sync.test.ts`; `tests/integration/returns-reconcile-on-sync.test.ts`; `tests/unit/migration-cutover.test.ts` |
| 12 | Partial delivery / partial refund | partial handled + recorded, not dropped | `tests/e2e/delivery-route-partial-delivery.e2e.ts`; `tests/integration/orders-backorder.test.ts`; `tests/integration/store-credit-refund.test.ts` |
| 13 | Backup creation | dump + manifest with SHA-256 checksum + control totals | `tests/unit/ops-backup.test.ts`; `tests/integration/backup-verification.test.ts`; **executed:** `BACKUP-RESTORE-REHEARSAL.md` |
| 14 | Restore to a clean environment | reconciles rows + money + sequence exactly; refuses a non-empty target | `tests/unit/ops-backup.test.ts` (`reconcileRestore`); `tests/integration/backup-verification.test.ts`; `tests/integration/dr-readiness.test.ts`; **executed:** `BACKUP-RESTORE-REHEARSAL.md` |
| 15 | Rollback to previous release | `performRollback` (legacy parallel + restore-to-clean); config version rollback | `tests/unit/migration-cutover.test.ts`; `tests/integration/config-rollback.test.ts`; plan: `MIGRATION-AND-ROLLBACK.md` |
| 16 | Monitoring / alert delivery | `/livez`, `/readyz`, `standup:check`, unsent counter, dead-letter depth, reconciliation diff, audit verify — each alert has a **named owner** | `tests/unit/standup-check.test.ts`; `tests/unit/ops-health.test.ts`; `tests/integration/operational-health.test.ts`; watch-list: `MONITORING-AND-ALERTS.md` |

## The consolidated pilot resilience check

`tests/integration/pilot-failure-drills.test.ts` (5 cases, all driven through the real surface):
1. **Idempotent replay** — the same write with the same key produces exactly one durable effect.
2. **No oversell / no negative stock** — total reserved never exceeds on-hand.
3. **Unauthorized write refused** — a cashier is refused a privileged write (403).
4. **Cross-tenant isolation** — one tenant sees none of another's stock.
5. **Stale session refused** — a tampered or expired token is rejected (401), while a valid one is accepted.

## What must still be done as a LIVE drill on the stood-up environment

The tests above prove the logic. Two scenarios also need a **timed, executed drill** on the actual pilot
box before the floor pilot (they cannot be fully exercised in unit/integration):
- **Full rollback rehearsal** — redeploy the previous release and restore-to-clean under a simulated
  failure, measured against the RPO/RTO in `dr-readiness`. The backup+restore half is already executed
  (`BACKUP-RESTORE-REHEARSAL.md`); the redeploy half runs on stand-up (⛔ EX-01 / OA-5).
- **Monitoring/alert delivery** — confirm an alert actually reaches the **named incident owner** on the
  pilot's channel (the signals and ownership are tested; the delivery channel is a stand-up wiring step).

## Maturity

**Integration tested** — every scenario is proven by an automated test, and backup/restore was executed
for real on a disposable PostgreSQL 16. The full rollback + live alert-delivery drills become **pilot
verified** on the stood-up environment. Defect severity/handling for the drills is set in Phase 7.
