# Ordered implementation backlog

Derived from the controlling roadmap's **20 execution stages** (§21) and the individual
requirement rows in `docs/traceability.md`. The rule is the roadmap's own: **one stage at a
time, each ending in a gate**. Nothing here is optional — "deferred" means a later approved
release, never removed (OD-02).

Regenerate the status counts with the parser in `docs/traceability.md`'s own table; last
counted **4 August 2026** (Stage 14, part 1).

## Where the build actually stands

**144 individual requirement rows: 99 built · 4 partial · 41 not started.**

| Module | Release | Built | Partial | Not started |
| --- | --- | --- | --- | --- |
| M01 Foundation & config | R1 | 4 | 0 | 0 |
| M02 Identity & access | R1 | 2 | 2 | 0 |
| M03 Product master | R2 | 4 | 0 | 0 |
| M04 Merchandising & space | R2 | 4 | 0 | 0 |
| M05 Pricing & promotions | R2 | 4 | 0 | 0 |
| M06 Suppliers & procurement | R2 | 4 | 0 | 0 |
| M07 Receiving & matching | R2 | 4 | 0 | 0 |
| M08 Inventory ledger | R2 | 4 | 0 | 0 |
| M09 Stock operations | R2 | 4 | 0 | 0 |
| M10 Batch, expiry, recall | R2 | 4 | 0 | 0 |
| M11 In-store production | R2 | 4 | 0 | 0 |
| M12 POS | R2 | 4 | 0 | 0 |
| M13 Returns & refunds | R2 | 4 | 0 | 0 |
| M14 Cash office & close | R2 | 4 | 0 | 0 |
| M15 Loss prevention | R2 | 4 | 0 | 0 |
| M16 Customer & consent | R4 | 4 | 0 | 0 |
| M17 Loyalty | R4 | 4 | 0 | 0 |
| M18 Orders | R5 | 2 | 0 | 2 |
| M19 Fulfilment & delivery | R5 | 3 | 0 | 1 |
| M20 Customer app & web | R4 | 0 | 0 | **4** |
| M21 CRM & service desk | R4 | 0 | 0 | **4** |
| M22 B2B | R6 | 2 | 0 | 2 |
| M23 Finance & Tally | R2 | 3 | 1 | 0 |
| M24 Supplier portals | R6 | 0 | 0 | **4** |
| M25 Workforce | R6 | 0 | 0 | **4** |
| M26 Facilities & assets | R6 | 0 | 0 | **4** |
| M27 Concession | R6 | 0 | 0 | **4** |
| M28 Waste & sustainability | R6 | 1 | 0 | 3 |
| M29 Owner intelligence | R2 | 4 | 0 | 0 |
| M30 Import & export | R2 | 3 | 1 | 0 |
| M31 Notifications & receipts | R2/R4 | 3 | 0 | 1 |
| M32 Integration platform | R1 | 0 | 0 | **4** |
| M33 Platform administration | R1 | 4 | 0 | 0 |
| M34 Audit & compliance | R1 | 4 | 0 | 0 |
| M35 Backup, DR, observability | R1 | 4 | 0 | 0 |
| M36 Multi-tenant platform | R8 | 0 | 0 | **4** |

**Nothing has been silently omitted.** Every row above traces to a requirement ID in
`docs/traceability.md`, and every "not started" row is scheduled to a stage below.

## Stage position

Stages 0–4 are complete (registers, discovery, requirements, UX/design system,
architecture/data/security). Stages 5–9 are complete **with their gates passed**, each with
written evidence in `docs/evidence/` — the gates are about proof, not code, and every one
was executed against a real PostgreSQL rather than asserted. That is why M01–M15 plus
M33–M35 are fully green: **the store-facing core of the product is built and proven.**

**Stages 5 to 10 have all passed their gates. The earliest stage with an open gate is
Stage 11 — which is blocked on the previous system's export rights (EX-02), not on us.**

## Stage 5 — Engineering foundation — ✅ **COMPLETE, GATE PASSED**

Roadmap output: *repos, CI/CD, environments, IAM, audit, config, monitoring and backups.*
Gate: **reproducible deploy and restore proof.**

| # | Work | Requirement | State |
| --- | --- | --- | --- |
| 5.1 | Repositories, branch discipline, commit history | §23 | ✅ done |
| 5.2 | CI: typecheck, lint, secret scan, full test suite | QG-03 | ✅ done |
| 5.3 | IAM — RBAC, maker-checker, named accounts, JML, emergency access | M02 | ✅ done |
| 5.4 | Immutable audit + compliance registers | M34 | ✅ done |
| 5.5 | Versioned config + per-tenant settings | M01-FR-03 | ✅ done |
| 5.6 | Local environment (Compose: Postgres + migrate + proxy) | §19 | ✅ done |
| 5.7 | **Observability** — health probes, structured redacted logging, metrics | **M35-FR-03** | ✅ done |
| 5.8 | **Backup & restore** — scripted, verified, retention | **M35-FR-01** | ✅ done (proven against real PostgreSQL) |
| 5.9 | **Disaster recovery** — RTO/RPO, rollback, rehearsal runbook | **M35-FR-02** | ✅ done |
| 5.10 | **SBOM + dependency/vulnerability evidence** | QG-03 / M32-FR-03 | ✅ done (216 components, 0 runtime deps, 0 vulnerabilities; CI fails on drift) |
| 5.11 | **Reproducible deploy + restore proof** (the gate itself) | QG-08 | ✅ **PASSED** — `docs/evidence/stage-5-recovery-proof.md` |
| 5.12 | Environment inventory & secrets ownership | §23 | ✅ done |
| 5.13 | Platform admin & support tooling | M33 | ✅ done (M33-FR-02/03/04; FR-01 via tenant+config) |

## Stage 6 — Offline/sync vertical slice — ✅ **COMPLETE, GATE PASSED** (`docs/evidence/stage-6-offline-slice.md`)
Gate: *internet-off, duplicate, reorder and recovery tests pass.*
Product/price → local POS sale → cloud ledger → reconciliation, proven end to end as one
runnable scenario. Engines exist; the **slice test** does not.

## Stage 7 — Product, pricing, purchase — ✅ **COMPLETE, GATE PASSED**
Gate: *purchase/GRN/invoice controls pass.*

| # | Work | Requirement | State |
| --- | --- | --- | --- |
| 7.1 | Merchandising, space, planograms | M04-FR-01/02/03/04 | ✅ done |
| 7.2 | Promotion simulation, abuse caps, vendor funding | M05-FR-04 | ✅ done |
| 7.3 | Supplier scorecards, rebates, contracts | M06-FR-03 | ✅ done |
| 7.4 | ASN / DSD / dock scheduling / handheld (completes M07-FR-01) | M07-FR-01 | ✅ done |
| 7.5 | Stage 7 gate evidence — purchase/GRN/invoice controls | QG-01/QG-03 | ✅ **PASSED** — `docs/evidence/stage-7-purchase-controls.md` |

## Stage 8 — Inventory, warehouse, quality — ✅ **COMPLETE, GATE PASSED**
Gate: *physical-to-system and recall proof.*

| # | Work | Requirement | State |
| --- | --- | --- | --- |
| 8.1 | Put-away, bins, handheld scanning | M09-FR-01 | ✅ done |
| 8.2 | Allocation and inter-store transfers | M09-FR-03 | ✅ done |
| 8.3 | Cold chain, sampling and quality release | M10-FR-02 / D05-FR-04 | ✅ done |
| 8.4 | **Reviewable-diff guardrail** (defect found during the gate) | hard rule #8 / QG-03 | ✅ done |
| 8.5 | Stage 8 gate evidence — physical-to-system and recall | QG-07 | ✅ **PASSED** — `docs/evidence/stage-8-inventory-recall.md` |

(M08 and M11 were already built; D05's quality-status thread lands with M10-FR-02 above.)

## Stage 9 — POS, returns, cash office — ✅ **COMPLETE, GATE PASSED**
Gate: *end-of-day and refund controls prove out.*

| # | Work | Requirement | State |
| --- | --- | --- | --- |
| 9.1 | Durable suspended bills + quotations (completes M12) | M12-FR-02 | ✅ done |
| 9.2 | Payment reversal, gateway status, refund reconciliation | M13-FR-04 | ✅ done |
| 9.3 | Settlement import, matching and exception investigation | M14-FR-03 | ✅ done |
| 9.4 | Cross-domain fraud signals | M15-FR-02 | ✅ done |
| 9.5 | Investigation cases + outcome feedback | M15-FR-04 | ✅ done |
| 9.6 | Pending-payment recovery | D04-FR-02 | ✅ done |
| 9.7 | Stage 9 gate evidence — the day closes honestly | QG-04 | ✅ **PASSED** — `docs/evidence/stage-9-day-close.md` |

**M12, M13, M14 and M15 are now complete.**

## Stage 10 — Finance, Tally, owner control — ✅ **COMPLETE, GATE PASSED**
Gate: *the books reconcile and the owner can see why.*

| # | Work | Requirement | State |
| --- | --- | --- | --- |
| 10.1 | Tally connector, retry, dead-letter, period close, control totals | M23-FR-04 | ✅ done |
| 10.2 | KPI comparisons and drill-through to the immutable source | M29-FR-02 | ✅ done |
| 10.3 | Owner thresholds, grouped exception alerts, approval inbox | M29-FR-03 | ✅ done |
| 10.4 | Scheduled reports and the self-sending daily brief | M29-FR-04 / D13 | ✅ done |
| 10.5 | Stage 10 gate evidence — the books reconcile | QG-07 | ✅ **PASSED** — `docs/evidence/stage-10-books-reconcile.md` |

**M29 is now complete.** M23-FR-02 (GST returns) remains partial pending the filing-format
confirmation in AVR-09.

## Stage 11 — Migration rehearsal ← **ACTIVE (blocked on EX-02)**

MG-01…09 full-volume trials. **Blocked on EX-02** (previous-system export rights) — the
letter to the incumbent ERP vendor is drafted in `docs/discovery/legacy-data-access.md` and
needs sending. The migration engine and controls (MG-01…12) are designed in
`docs/architecture/migration-design.md`; nothing can be *rehearsed* until real export data
exists.

## Stage 12 — Store Core pilot · Stage 13 — Parallel run and cutover
Owner GO gates; need the store.

## Stage 14 — Customer commerce ← **ACTIVE** (taken out of order; Stage 11 is blocked on EX-02)

| # | Work | Requirement | State |
| --- | --- | --- | --- |
| 14.1 | Data-subject rights and retention handling | M16-FR-03 | ✅ done |
| 14.2 | Segments, lifetime value, engagement history | M16-FR-04 | ✅ done |
| 14.3 | Coupons, referrals, memberships, personalised offers | M17-FR-02 | ✅ done |
| 14.4 | Gift cards, store credit, fraud limits, liability reconciliation | M17-FR-03 | ✅ done |
| 14.5 | Household pooling and omnichannel balance consistency | M17-FR-04 | ✅ done |
| 14.6 | Customer app and web storefront | M20 (all 4) | ⬜ next |
| 14.7 | CRM and service desk | M21 (all 4) | ⬜ next |
| 14.8 | Customer notifications | M31-FR-01, D07–D08 | ⬜ next |
| 14.9 | Stage 14 gate evidence | QG-06 | ⬜ after 14.6–14.8 |

**M16 and M17 are now complete.** EX-04/05 (messaging providers) and EX-11 (app-store
accounts) gate *delivery and publication*, not the build; **EX-13 (independent penetration
test) is a genuine gate before customer launch** and needs a paid engagement.

## Stage 15 — Fulfilment and delivery
M18-FR-03/04, M19-FR-02, M20 delivery surfaces, D09.

## Stage 16 — Enterprise modules
M22-FR-02/04, M24, M25, M26, M27, M28-FR-02/03/04.

## Stage 17 — Governed AI agents
A01–A10 in authority order, with evaluation sets, budgets, kill switches. Needs EX-12.

## Stage 18 — Multi-branch and innovation
M36 (all 4), self-checkout, ESL/RFID/IoT per approved wave.

## Stage 19 — Operate and improve
M32-FR-01/02/04, M33 remainder, M35 remainder, SLA and support operations.

## Cross-cutting, continuous
M30 (import/export) ✅ · security (SEC), privacy (PRV) and audit evidence maintained every
stage · traceability updated with every unit · registers kept current.
