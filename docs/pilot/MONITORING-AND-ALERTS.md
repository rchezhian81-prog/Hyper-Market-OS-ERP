# Pilot monitoring & alerts

_Release candidate `pilot-rc-1` (commit `c45b948`). Non-production pilot only._

What to watch during the pilot, the threshold that should raise an alert, and where it goes. The system is
built so that **staleness and failure are visible, never silent** (P-08): the signals below already exist in
the product; this defines how to watch them. A named **incident owner** (Phase 8) receives every alert.

## Health signals

| Signal | Source | Green | Alert when | Action |
|---|---|---|---|---|
| API liveness | `GET /livez` | 200, `live:true` | not live 2× in a row | restart the api container |
| API readiness | `GET /readyz` | `ready:true` | not ready > 2 min | take out of rotation; check DB reachability (do **not** restart-loop) |
| Whole-stack readiness | `pnpm run standup:check` | GREEN | any RED | follow the RED line's instruction |
| DB up | compose healthcheck `pg_isready` | healthy | unhealthy > 1 min | investigate DB; API stays live-not-ready |
| Disk (edge + DB volume) | host / `EDGE_CAPACITY_BYTES` | < 80% | ≥ 85% | free space; edge keeps selling + queuing until full |

## Trading-integrity signals (P-08 — the ones a shop must never miss)

| Signal | Meaning | Alert when | Action |
|---|---|---|---|
| **Unsent counter** (edge) | sales committed locally, not yet synced | rising and **not draining** for > 30 min while online | check `CLOUD_API_URL`/token + connectivity; sales are safe (hard rule #1), the books are lagging |
| **Sync lag** | newest cloud event vs newest edge event | > agreed minutes | as above |
| **Dead-letter depth** (connector queue) | messages that failed after bounded retry | any dead letter | a person reviews it; it is **read, never auto-deleted** (hard rule #6) |
| **Reconciliation difference** (daily) | pilot totals vs legacy/parallel process | any non-zero unexplained | investigate before end-of-day sign-off |
| **Auth-attempt lockouts / 429s** | brute-force or a misconfigured client | spike | check source; lockout is by design |
| **Audit chain** | tamper-evidence | `verify:audit` non-zero exit | treat as a security incident (`security-incident.md`) |

## Where alerts go

- Pilot scale is one box + one branch, so alerting can be lightweight: the `standup:check` GREEN/RED line on a
  scheduled check, plus the daily reconciliation report (Phase 8 run-sheet), delivered to the **named incident
  owner**. A hosted pilot (EX-01/OA-5) wires the same signals to the host's monitoring/alerting.
- The signals are **exposed by the app** already (`/livez`, `/readyz`, `standup:check`, the unsent counter on
  the till, the dead-letter queue, the reconciliation report). This document is the watch-list, not new code.

## Escalation

P0/P1 (no sale possible on the floor; data-integrity doubt) → incident owner immediately, consider **rollback**
(legacy in parallel — `MIGRATION-AND-ROLLBACK.md`). P2 → same-day. P3/P4 → daily defect report (Phase 7 policy).
