# Ordered implementation backlog

Derived from the controlling roadmap's **20 execution stages** (§21) and the individual
requirement rows in `docs/traceability.md`. The rule is the roadmap's own: **one stage at a
time, each ending in a gate**. Nothing here is optional — "deferred" means a later approved
release, never removed (OD-02).

Regenerate the status counts with the parser in `docs/traceability.md`'s own table; last
counted **4 August 2026** (Stage 19 complete).

## Where the build actually stands

**144 individual requirement rows: 143 built · 1 partial · 0 not started.**

| Module | Release | Built | Partial | Not started |
| --- | --- | --- | --- | --- |
| M01 Foundation & config | R1 | 4 | 0 | 0 |
| M02 Identity & access | R1 | 3 | 1 | 0 |
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
| M18 Orders | R5 | 4 | 0 | 0 |
| M19 Fulfilment & delivery | R5 | 4 | 0 | 0 |
| M20 Customer app & web | R4 | 4 | 0 | 0 |
| M21 CRM & service desk | R4 | 4 | 0 | 0 |
| M22 B2B | R6 | 4 | 0 | 0 |
| M23 Finance & Tally | R2 | 4 | 0 | 0 |
| M24 Supplier portals | R6 | 4 | 0 | 0 |
| M25 Workforce | R6 | 4 | 0 | 0 |
| M26 Facilities & assets | R6 | 4 | 0 | 0 |
| M27 Concession | R6 | 4 | 0 | 0 |
| M28 Waste & sustainability | R6 | 4 | 0 | 0 |
| M29 Owner intelligence | R2 | 4 | 0 | 0 |
| M30 Import & export | R2 | 4 | 0 | 0 |
| M31 Notifications & receipts | R2/R4 | 4 | 0 | 0 |
| M32 Integration platform | R1 | 4 | 0 | 0 |
| M33 Platform administration | R1 | 4 | 0 | 0 |
| M34 Audit & compliance | R1 | 4 | 0 | 0 |
| M35 Backup, DR, observability | R1 | 4 | 0 | 0 |
| M36 Multi-tenant platform | R8 | 4 | 0 | 0 |

**Nothing has been silently omitted.** Every row above traces to a requirement ID in
`docs/traceability.md`, and there are no "not started" rows left.

**The single remaining partial is M02-FR-01, and it is partial on purpose.** Named-account
rules, the MFA gate on privileged activation, session idle/absolute/device binding, bounded
offline cached identity, lockout and access review are all built and tested. What is *not*
here is **credential storage and MFA enrolment**, because those belong to the deployment
identity provider and putting them in this codebase would mean holding credentials in it —
hard rule #4. Closing this row would mean building the thing the rule forbids, so it stays
open and honest rather than being marked complete.

## Stage position

Stages 0–4 are complete (registers, discovery, requirements, UX/design system,
architecture/data/security). Stages 5–9 are complete **with their gates passed**, each with
written evidence in `docs/evidence/` — the gates are about proof, not code, and every one
was executed against a real PostgreSQL rather than asserted. That is why M01–M15 plus
M33–M35 are fully green: **the store-facing core of the product is built and proven.**

**Stages 5 to 10, 14 and 15 have all passed their gates.** Stage 11 is blocked on the
previous system's export rights (EX-02), which is a letter to send rather than code to
write; Stages 12–13 need the store and an owner GO. **Stage 16 (enterprise modules) is the
largest remaining block** — 16 requirement rows across M22, M24–M28 with almost nothing
built.

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

## Stage 14 — Customer commerce — ✅ **COMPLETE, GATE PASSED**
(taken out of order; Stage 11 is blocked on EX-02)
Gate: *one customer, end to end.*

| # | Work | Requirement | State |
| --- | --- | --- | --- |
| 14.1 | Data-subject rights and retention handling | M16-FR-03 | ✅ done |
| 14.2 | Segments, lifetime value, engagement history | M16-FR-04 | ✅ done |
| 14.3 | Coupons, referrals, memberships, personalised offers | M17-FR-02 | ✅ done |
| 14.4 | Gift cards, store credit, fraud limits, liability reconciliation | M17-FR-03 | ✅ done |
| 14.5 | Household pooling and omnichannel balance consistency | M17-FR-04 | ✅ done |
| 14.6 | Customer app and web storefront | M20 (all 4) | ✅ done |
| 14.7 | CRM and service desk | M21 (all 4) | ✅ done |
| 14.8 | Versioned templates and immutable documents | M31-FR-01, D07–D08 | ✅ done |
| 14.9 | Stage 14 gate evidence — one customer, end to end | QG-06 | ✅ **PASSED** — `docs/evidence/stage-14-one-customer.md` |

**M16, M17, M20, M21 and M31 are now complete.** EX-04/05 (messaging providers) and EX-11
(app-store accounts) gate *delivery and publication*, not the build. **EX-13 — an
independent penetration test — is the one genuine gate before customer launch** and needs a
paid engagement; it is the only outstanding item on this stage and belongs to the owner.

## Stage 15 — Fulfilment and delivery — ✅ **COMPLETE, GATE PASSED**
Gate: *pick to doorstep.*

| # | Work | Requirement | State |
| --- | --- | --- | --- |
| 15.1 | Pickup, scheduled/express routing, dark stores, contribution | M18-FR-03 / D09 | ✅ done |
| 15.2 | Cancellation, substitution, channel reconciliation | M18-FR-04 / A04 | ✅ done |
| 15.3 | Packing, handling requirements, dispatch manifest | M19-FR-02 / D09 | ✅ done |
| 15.4 | Stage 15 gate evidence — pick to doorstep | QG-04 | ✅ **PASSED** — `docs/evidence/stage-15-pick-to-doorstep.md` |

**M18 and M19 are now complete.** The M20 delivery surfaces are covered by the storefront's
tracking view (Stage 14).

## Stage 16 — Enterprise modules — ✅ **COMPLETE, GATE PASSED**
(taken out of order with Stages 14 and 15; Stage 11 is blocked on EX-02)
Gate: *beyond the till — everything the shop does that is not a walk-in sale still tells
the truth.*

| # | Work | Requirement | State |
| --- | --- | --- | --- |
| 16.1 | Quote → order → proforma → challan → tax invoice | M22-FR-02 | ✅ done |
| 16.2 | B2B portal, due-date ageing, allocated payments, collections | M22-FR-04 | ✅ done |
| 16.3 | Supplier portal — isolation, compliance at the action, submissions, statements | M24 (all 4) | ✅ done |
| 16.4 | Rosters, gated tasks, checklists, incentives, SOPs | M25 (all 4) | ✅ done |
| 16.5 | Assets, AMC, downtime, energy | M26-FR-01/04 | ✅ done |
| 16.6 | Cold room and power monitoring, IoT readiness | M26-FR-02 | ✅ done |
| 16.7 | Cleaning, pest, fire, safety schedules and incidents | M26-FR-03 | ✅ done |
| 16.8 | Concession contracts, stock ownership, settlement, expiry | M27 (all 4) | ✅ done |
| 16.9 | Scrap and recycling sales | M28-FR-02 | ✅ done |
| 16.10 | Carry bags, reusable packaging, packaging stock | M28-FR-03 | ✅ done |
| 16.11 | Waste, energy and sustainability reporting | M28-FR-04 | ✅ done |
| 16.12 | Stage 16 gate evidence — beyond the till | QG-06 | ✅ **PASSED** — `docs/evidence/stage-16-beyond-the-till.md` |

**M22, M24, M25, M26, M27 and M28 are now complete.** M27 and M28's `ownership` column on the
shared stock ledger and the POS concession attribution are additive wiring steps at the
persistence and lane layers; live IoT sensor ingestion (D14) is a deployment step, not a
build one. **Only M32 (integration platform) and M36 (multi-tenant platform) remain
unstarted**, in Stages 19 and 18 respectively.

## Stage 17 — Governed AI agents
A01–A10 in authority order, with evaluation sets, budgets, kill switches. Needs EX-12.

## Stage 18 — Multi-branch and innovation — ✅ **COMPLETE, GATE PASSED**
(taken ahead of Stage 17, which is blocked on EX-12 — a paid model-gateway account)
Gate: *two shops, one system — and neither can see the other.*

| # | Work | Requirement | State |
| --- | --- | --- | --- |
| 18.1 | Tenant isolation, plans, entitlements, metering | M36-FR-01 | ✅ done |
| 18.2 | White-label branding and terminology without code forks | M36-FR-02 | ✅ done |
| 18.3 | Tenant export, closure, retention, upgrade compatibility | M36-FR-03 | ✅ done |
| 18.4 | Partner ecosystem, sandbox, versioned APIs, certification | M36-FR-04 | ✅ done |
| 18.5 | Self-checkout, scan-and-go, price kiosk | D04 | ✅ done |
| 18.6 | Shelf/POS/app/ESL price integrity and ESL push | D06, D14 | ✅ done |
| 18.7 | Stage 18 gate evidence — two shops, one system | QG-06 | ✅ **PASSED** — `docs/evidence/stage-18-two-shops-one-system.md` |

**M36 is now complete.** Subscription *billing* itself (a payment-provider integration) and the
published SDK / docs site / partner portal are commercial and packaging steps on top of this
surface, not build steps — they belong with OB-01. Multi-branch operations are already covered
by `packages/org` (hierarchy, branch lifecycle, GST-per-branch, built in Stage 5) and the
branch-scoped controls proven in Stages 8–16.

**M32 (integration platform) is now the only module with no rows built**, in Stage 19.

## Stage 19 — Operate and improve — ✅ **COMPLETE, GATE PASSED**
Gate: *the seams hold, and the till never notices.*

| # | Work | Requirement | State |
| --- | --- | --- | --- |
| 19.1 | Versioned APIs, service identities, idempotency, signed webhooks | M32-FR-01 | ✅ done |
| 19.2 | Connector SDK — mapping, throttling, bounded retry, non-deletable dead letter | M32-FR-02 | ✅ done |
| 19.3 | Managed secrets, rotation, revocation, usage monitoring | M32-FR-03 | ✅ done |
| 19.4 | Certified adapter/device matrix and integration health | M32-FR-04 | ✅ done |
| 19.5 | M33 remainder (config, device fleet, support access, status centre) | M33 (all 4) | ✅ done in Stage 5/7 |
| 19.6 | M35 remainder (backup, DR drills, observability, alerts) | M35 (all 4) | ✅ done in Stage 5 |
| 19.7 | Stage 19 gate evidence — the seams hold | QG-06 | ✅ **PASSED** — `docs/evidence/stage-19-the-seams-hold.md` |

**M32 is now complete, and with it EVERY module M01–M36 has its foundation built.** The
remaining provider-specific wire formats (Tally XML, the payment gateway, the GST e-invoice
portal, WhatsApp, a logistics partner) are **provider-account work**, not build work — they
need AVR-10/AVR-14 and EX-04/05, which are the owner's commercial onboarding steps. The
adapter contracts, certification matrix, retry/dead-letter behaviour and health surface they
plug into are built and tested.

**SLA and support operations** are carried by M33-FR-03/04 (time-boxed audited support access,
status centre) and M35-FR-03/04 (health from evidence, owned alerts with an acknowledgement
deadline), all built and gate-proven in Stages 5 and 7.

## Cross-cutting, continuous
M30 (import/export) ✅ · security (SEC), privacy (PRV) and audit evidence maintained every
stage · traceability updated with every unit · registers kept current.
