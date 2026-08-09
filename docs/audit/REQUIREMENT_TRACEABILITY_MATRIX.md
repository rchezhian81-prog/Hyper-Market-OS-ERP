# Requirement Traceability Matrix (Audit Overlay)

_Deep architecture audit, 2026-08-09. This is an **audit verification overlay** on the repo's own
`docs/traceability.md` (144 FR rows, guardrail-enforced) — it does not replace it. Purpose: separate
"domain-logic built" from "assembled & verified", per module family, with the honest assembly-ladder status and
the gap that blocks each from being production-verified._

## How to read this
- The repo's `docs/traceability.md` is **trustworthy and machine-checked** (`traceability-integrity.test.ts`
  fails CI on any drift: missing paths, count mismatches, un-evidenced "built" rows, family status not derived
  from rows). This audit **verifies that guardrail exists and works** and does not re-litigate the 144 rows.
- The number that matters for production readiness is the **assembly ladder**, not the FR "built" count.

## Assembly-ladder reality (verified from `docs/traceability.md:80-99`)
| Rung | Count | Modules (verified) |
|---|---|---|
| PRODUCTION VERIFIED | **0** | — |
| UAT VERIFIED | **0** | — |
| E2E VERIFIED | **1** | M12 POS |
| INTEGRATION TESTED | **2** | M08 stock, M33 tenant setup |
| WIRED | **~6** | M02, M05, M09, M11, M15, M26 |
| PARTIALLY WIRED | **~27** | most others (M23 finance, M29 reporting flagged "thin") |
| ENGINE ONLY / NOT STARTED | remainder | assorted FRs inside partial modules |

**Derived coverage:** WIRED+ ≈ 25% · INTEGRATION-TESTED+ ≈ 8% · E2E ≈ 3% · PRODUCTION 0%. Only **9 modules** have
registered on-disk evidence (`completion-ladder-has-evidence.test.ts:20-30`).

## Traceability integrity of the DoD chain (requirement → design → code → test)
| Chain link | Present & enforced? | Evidence |
|---|---|---|
| Requirement ID + acceptance criteria | **Yes** — every FR has an Appendix-B record | `docs/requirements/M01.md:17-75` |
| Design reference | Yes — `docs/design`, `docs/architecture` | present |
| Implementation reference (path exists) | **Yes, enforced** — CI fails on a missing path | `traceability-integrity.test.ts:54-68` |
| Test reference (impl+test named for "built") | **Yes, enforced** | `:70-86` |
| Backlog counts match rows + headline | **Yes, enforced** | `:89-125` |
| Family status derived from rows | **Yes, enforced** | `:172-196` |
| Completion ladder needs on-disk evidence | **Yes, enforced** | `completion-ladder-has-evidence.test.ts:60-101` |
| **Wired ≠ verified distinction** | **Yes, explicit** — the doc states "built" certifies domain logic, "not a system anybody can switch on" | `traceability.md:135-139` |

**Verdict:** the traceability *machinery* is **Production-verified as an artifact** — among the best this auditor
has seen. The weakness is not the matrix; it is that the matrix honestly records a low assembly-and-verification
percentage.

## Module-family audit view (status + the gap that blocks production)
| Family | Domain logic | Assembly status | Blocking gap to production |
|---|---|---|---|
| M01–M02, M33–M35 (identity/RBAC/setup/audit/platform) | Built | M02 WIRED, M33 INTEGRATION-TESTED | No pentest/RLS/token-revocation; support-expiry at API (GAP-SEC-04/05/06, DATA-02) |
| M03–M05 (catalogue/pricing/promotions) | Built | M05 WIRED | No inbound pack sync (GAP-SYNC-01); no live UAT |
| M06–M07, M24 (purchase/supplier) | Built | Partial | Thin service; no live supplier/GST provider |
| **M08–M11 (stock/warehouse/production)** | Built | **M08 INTEGRATION-TESTED, M09/M11 WIRED** | Offline numbering unwired (GAP-SYNC-02); returns↔stock integration; no live UAT |
| M12–M15 (POS/offline/loss-prevention) | Built | **M12 E2E-VERIFIED**, M15 WIRED | The strongest family; still 0 production/real-device |
| M16–M17, M20–M21 (customer/loyalty/storefront) | Built | Partial | DSR not on API (GAP-SEC-02); loyalty/returns FRs engine-only |
| M18–M19 (orders/fulfilment) | Built | Partial | Routing engine-only; no real logistics provider |
| M22, M25–M28 (b2b/concession/facilities) | Built | M26 WIRED | Thin services; no live UAT |
| **M23, M29 (finance / reporting)** | Built | **Partial — flagged "thin"** | **The owner's core surfaces**; no Tally provider; reporting read-models thin (GAP-ARCH-01) |
| M36 (platform/innovation) | Built | Partial | Entitlement control-plane wired; paid-plan owner-blocked (OA-12) |
| AI (A01–A10 / API-13) | Built (governance) | Wired (simulator) | No live model/RAG/prompt-versioning/AI-audit route (GAP-AI-01) |

## The traceability risk this audit adds (not in the repo's own matrix)
**GAP-ARCH-01 — proven-engine ↔ running-service drift.** The traceability rows point at the tested *engines* in
`packages/`, but 6 of 7 services re-implement thinly and **35/77 packages are imported only by their own tests**
(`traceability.md:135-139`). So a green "built" row can certify an engine that **no running path executes**. The
matrix is honest about this in prose, but the per-row status does not distinguish "engine tested" from "this
exact engine runs in the service." **Recommendation (RTM-01):** extend the traceability schema with a
`wired_via` column naming the service/adapter that imports the engine on the running path, so the drift becomes
a machine-checked fact, not a prose caveat. This is the single highest-value traceability improvement.

## Recommendation summary
1. **RTM-01 (P1):** add a `wired_via` column + guardrail so "built" cannot hide "unwired engine".
2. **RTM-02 (P1):** as modules reach real UAT/production, extend the ladder guardrail to require UAT/production
   *evidence* (a pilot sign-off doc) for those rungs — today only WIRED/INTEGRATION rungs are evidence-gated.
3. **RTM-03 (P2):** publish OpenAPI (ADR-A09) and cross-check the API catalogue against it in the surface
   contract test, closing the last doc-vs-code gap on the API surface.
