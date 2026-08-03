# Traceability

Traces every requirement from design through to a passing test and the release it
shipped in. Part of the Definition of Done in `CLAUDE.md`.

The roadmap (§37) provides a **family-level** baseline proving every requirement
family has an implementation route. **Stage 2 expands this to one row per
individual requirement** (`M##-FR-##`, `D##-FR-##`, `SEC-##`, `PRV-##`, `AI-NFR-##`,
`MG-##`, etc.) with design, code, automated-test and release references. No
requirement may reach **Done** without a complete individual row.

## Family-level baseline (roadmap §37)

| Requirement family | Workflow | Screens | Contract | Data | Test family | Release | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M01–M02, M33–M35 | WF-20 | Admin/Security | API-01/API-11 | Identity/Platform | Security, RBAC, DR, release | R1 | Not started |
| M03–M05 | WF-01/WF-06 | Product/Merchandising | API-02 | Product/Commercial | Catalogue/price/promotion/offline pack | R2 | Not started |
| M06–M07, M24 | WF-02–WF-05 | Purchase/Supplier | API-03 | Commercial/Purchase | PO/receipt/match/import | R2 | Not started |
| M08–M11 | WF-06–WF-09 | Inventory/Warehouse | API-04 | Inventory | Ledger/count/expiry/recall/offline | R2 | Not started |
| M12–M15 | WF-10–WF-12 | POS/Cash | API-05 | POS/Finance | Performance/offline/tender/fraud | R2 | Not started |
| M23, M29 | WF-05/WF-12/WF-18 | Finance/Owner | API-09/API-10 | POS/Finance | GST/Tally/reconciliation/profitability | R2 | Not started |
| MG programme | WF-19 | Migration | API-12 | Migration + all domains | Full-history trial/reconcile/cutover | R3 | Not started |
| M16–M17, M20–M21 | WF-13/WF-16/WF-17 | Customer/CRM | API-06/API-07 | Commercial/Order | Privacy/loyalty/order/refund | R4 | Not started |
| M18–M19 | WF-14–WF-15 | Picker/Delivery | API-07/API-08 | Order/Fulfilment | Reservation/substitution/proof/settlement | R5 | Not started |
| M22, M25–M28 | Relevant | B2B/Workforce/Facilities | Domain APIs | Operations/Commercial | Role UAT/compliance | R6 | Not started |
| A01–A10 | All governed | AI control + role surfaces | API-13 | AI + authorized domains | Evaluation/injection/authority/cost/kill switch | R7 | Not started |
| M36/innovation | Controlled extension | Admin/selected | Versioned APIs/events | Tenant/config | Isolation/upgrade/rollback | R8 | Not started |

## Design artifacts (Stage 3–4)

Store-Core requirements are now covered at **design level** by the artifacts below; the
individual rows keep `Design → docs/requirements/M##.md` as their requirement anchor and
stay **In design** until code + tests exist (Definition of Done). These are the design
references those rows resolve to:

| Artifact | Location | Covers |
| --- | --- | --- |
| Screen specs (all 14 §27 surfaces) | `docs/design/screens/` + `docs/design/design-system.md` | UX/QG-02 for every role surface |
| Architecture overview | `docs/architecture/README.md` | §19 planes, bounded contexts → API-01…13 |
| Data model (§29) | `docs/architecture/data-model.md` | entity/rule model, one-commerce-truth |
| API & event catalogue (§30) | `docs/api/catalogue.md` | API-01…13, conventions, §30.2 events |
| Offline-sync design (§31) | `docs/architecture/offline-sync.md` | P-01 detail, sync protocol, conflicts |
| Migration design (§34) | `docs/architecture/migration-design.md` | MG-01…12 pipeline, QG-07 control totals |
| Threat & privacy model (§35) | `docs/security/threat-privacy-model.md` | trust boundaries, STRIDE, PRV, QG-06 |
| Field-level data dictionary | `db/data-dictionary/` | six Store-Core domains, field level |

## Foundation code (Stage 5 — build begun)

The first real application code. These units are store-fact-independent; store-specific
modules still wait on the Stage 1 facts (finding A-11).

| Unit | Requirement | Code | Tests |
| --- | --- | --- | --- |
| `Money` value primitive | §29.1 (exact money, no float) / M01-FR-02 (currency & precision) | `packages/contracts/src/money.ts` | `tests/unit/money.test.ts` (21 tests) |
| `Quantity` value primitive | data dictionary (UOM-aware, exact) | `packages/contracts/src/quantity.ts` | `tests/unit/quantity.test.ts` (9 tests) |
| `Rate` value primitive (exact %) | §29.1 / M05 (pricing) / M23 (tax) — basis points, rounded application | `packages/contracts/src/rate.ts` | `tests/unit/rate.test.ts` (9 tests) |
| Domain vocabularies & §27.1 states | data dictionary / §27.1 (tender, sale, stock, approval, lifecycle, connection) | `packages/contracts/src/enums.ts` | `tests/unit/enums.test.ts` (5 tests) |
| `DomainEvent` envelope | §30.2 (event backbone) / §31.1 (idempotency) | `packages/contracts/src/event.ts` | `tests/unit/domain-event.test.ts` (6 tests) |
| Append-only ledger engine | hard rule #2 / M08-FR-01 (append-only, projected balance) / §31.1 (idempotent) | `packages/ledger/src/ledger.ts` | `tests/unit/ledger.test.ts` (5 tests) |
| Maker-checker approval engine | §28 (separation of duties) / M02 (maker-checker, value-limit routing) | `packages/approvals/src/approvals.ts` | `tests/unit/approvals.test.ts` (10 tests) |
| RBAC access-control engine | P-04 (least privilege) / M02-FR-02 (role/branch/permission authz) | `packages/rbac/src/rbac.ts` | `tests/unit/rbac.test.ts` (7 tests) |
| Offline sync outbox | P-01 (offline first) / §31 (durable outbox, idempotent) / hard rule #6 (dead-letter never dropped) | `packages/sync/src/outbox.ts` | `tests/unit/outbox.test.ts` (5 tests) |
| Gap-free number series | M01-FR-02 (gap-free, unique per type, offline reserved ranges) | `packages/numbering/src/numbering.ts` | `tests/unit/numbering.test.ts` (6 tests) |
| Trading-day calculator | M01-FR-02 (trading-day rule) / A-13 | `packages/calendar/src/trading-day.ts` | `tests/unit/trading-day.test.ts` (6 tests) |
| Line & bill pricing (composition) | M12 (POS) / M05 (pricing) / M23 (tax) — Money × Quantity × Rate | `packages/pricing/src/pricing.ts` | `tests/unit/pricing.test.ts` (7 tests) |
| Tender settlement | M12-FR-03 (split tenders balance; no fake approval) | `packages/tender/src/tender.ts` | `tests/unit/tender.test.ts` (7 tests) |
| Versioned config + rollback | M01-FR-03 (append-only versions, non-destructive rollback) | `packages/config/src/config.ts` | `tests/unit/config.test.ts` (5 tests) |
| Local sale commit (integration) | hard rule #1 (commit local, sync idempotently) / M12 | `packages/sale/src/sale.ts` | `tests/unit/sale.test.ts` (4 tests) |
| Tenant feature entitlements | ADR-0003 / M33·D12·M36 (multi-tenant; choose-able modules) | `packages/tenant/src/tenant.ts` | `tests/unit/tenant.test.ts` (6 tests) |
| Per-tenant settings | ADR-0003 (choose-able settings, defaults, per-tenant, versioned) | `packages/tenant/src/settings.ts` | `tests/unit/tenant-settings.test.ts` (5 tests) |

## Individual requirement trace (expanded in Stage 2)

| Requirement ID | Stage | Design | Code | Tests | Release | Status |
| --- | --- | --- | --- | --- | --- | --- |
| M01-FR-01 | 2 | `docs/requirements/M01.md` | — | — | R1 | In design |
| M01-FR-02 | 2 | `docs/requirements/M01.md` | — | — | R1 | In design |
| M01-FR-03 | 2 | `docs/requirements/M01.md` | — | — | R1 | In design |
| M01-FR-04 | 2 | `docs/requirements/M01.md` | — | — | R1 | In design |
| M02-FR-01 | 2 | `docs/requirements/M02.md` | — | — | R1 | In design |
| M02-FR-02 | 2 | `docs/requirements/M02.md` | — | — | R1 | In design |
| M02-FR-03 | 2 | `docs/requirements/M02.md` | — | — | R1 | In design |
| M02-FR-04 | 2 | `docs/requirements/M02.md` | — | — | R1 | In design |
| M03-FR-01 | 2 | `docs/requirements/M03.md` | — | — | R2 | In design |
| M03-FR-02 | 2 | `docs/requirements/M03.md` | — | — | R2 | In design |
| M03-FR-03 | 2 | `docs/requirements/M03.md` | — | — | R2 | In design |
| M03-FR-04 | 2 | `docs/requirements/M03.md` | — | — | R2 | In design |
| M04-FR-01 | 2 | `docs/requirements/M04.md` | — | — | R2 | In design |
| M04-FR-02 | 2 | `docs/requirements/M04.md` | — | — | R2 | In design |
| M04-FR-03 | 2 | `docs/requirements/M04.md` | — | — | R2 | In design |
| M04-FR-04 | 2 | `docs/requirements/M04.md` | — | — | R2 | In design |
| M05-FR-01 | 2 | `docs/requirements/M05.md` | — | — | R2 | In design |
| M05-FR-02 | 2 | `docs/requirements/M05.md` | — | — | R2 | In design |
| M05-FR-03 | 2 | `docs/requirements/M05.md` | — | — | R2 | In design |
| M05-FR-04 | 2 | `docs/requirements/M05.md` | — | — | R2 | In design |
| M06-FR-01 | 2 | `docs/requirements/M06.md` | — | — | R2 | In design |
| M06-FR-02 | 2 | `docs/requirements/M06.md` | — | — | R2 | In design |
| M06-FR-03 | 2 | `docs/requirements/M06.md` | — | — | R2 | In design |
| M06-FR-04 | 2 | `docs/requirements/M06.md` | — | — | R2 | In design |
| M07-FR-01 | 2 | `docs/requirements/M07.md` | — | — | R2 | In design |
| M07-FR-02 | 2 | `docs/requirements/M07.md` | — | — | R2 | In design |
| M07-FR-03 | 2 | `docs/requirements/M07.md` | — | — | R2 | In design |
| M07-FR-04 | 2 | `docs/requirements/M07.md` | — | — | R2 | In design |
| M08-FR-01 | 2 | `docs/requirements/M08.md` | — | — | R2 | In design |
| M08-FR-02 | 2 | `docs/requirements/M08.md` | — | — | R2 | In design |
| M08-FR-03 | 2 | `docs/requirements/M08.md` | — | — | R2 | In design |
| M08-FR-04 | 2 | `docs/requirements/M08.md` | — | — | R2 | In design |
| M09-FR-01 | 2 | `docs/requirements/M09.md` | — | — | R2 | In design |
| M09-FR-02 | 2 | `docs/requirements/M09.md` | — | — | R2 | In design |
| M09-FR-03 | 2 | `docs/requirements/M09.md` | — | — | R2 | In design |
| M09-FR-04 | 2 | `docs/requirements/M09.md` | — | — | R2 | In design |
| M10-FR-01 | 2 | `docs/requirements/M10.md` | — | — | R2 | In design |
| M10-FR-02 | 2 | `docs/requirements/M10.md` | — | — | R2 | In design |
| M10-FR-03 | 2 | `docs/requirements/M10.md` | — | — | R2 | In design |
| M10-FR-04 | 2 | `docs/requirements/M10.md` | — | — | R2 | In design |
| M11-FR-01 | 2 | `docs/requirements/M11.md` | — | — | R2 | In design |
| M11-FR-02 | 2 | `docs/requirements/M11.md` | — | — | R2 | In design |
| M11-FR-03 | 2 | `docs/requirements/M11.md` | — | — | R2 | In design |
| M11-FR-04 | 2 | `docs/requirements/M11.md` | — | — | R2 | In design |
| M12-FR-01 | 2 | `docs/requirements/M12.md` | — | — | R2 | In design |
| M12-FR-02 | 2 | `docs/requirements/M12.md` | — | — | R2 | In design |
| M12-FR-03 | 2 | `docs/requirements/M12.md` | — | — | R2 | In design |
| M12-FR-04 | 2 | `docs/requirements/M12.md` | — | — | R2 | In design |
| M13-FR-01 | 2 | `docs/requirements/M13.md` | — | — | R2 | In design |
| M13-FR-02 | 2 | `docs/requirements/M13.md` | — | — | R2 | In design |
| M13-FR-03 | 2 | `docs/requirements/M13.md` | — | — | R2 | In design |
| M13-FR-04 | 2 | `docs/requirements/M13.md` | — | — | R2 | In design |
| M14-FR-01 | 2 | `docs/requirements/M14.md` | — | — | R2 | In design |
| M14-FR-02 | 2 | `docs/requirements/M14.md` | — | — | R2 | In design |
| M14-FR-03 | 2 | `docs/requirements/M14.md` | — | — | R2 | In design |
| M14-FR-04 | 2 | `docs/requirements/M14.md` | — | — | R2 | In design |
| M15-FR-01 | 2 | `docs/requirements/M15.md` | — | — | R2 | In design |
| M15-FR-02 | 2 | `docs/requirements/M15.md` | — | — | R2 | In design |
| M15-FR-03 | 2 | `docs/requirements/M15.md` | — | — | R2 | In design |
| M15-FR-04 | 2 | `docs/requirements/M15.md` | — | — | R2 | In design |
| M16-FR-01 | 2 | `docs/requirements/M16.md` | — | — | R4 | In design |
| M16-FR-02 | 2 | `docs/requirements/M16.md` | — | — | R4 | In design |
| M16-FR-03 | 2 | `docs/requirements/M16.md` | — | — | R4 | In design |
| M16-FR-04 | 2 | `docs/requirements/M16.md` | — | — | R4 | In design |
| M17-FR-01 | 2 | `docs/requirements/M17.md` | — | — | R4 | In design |
| M17-FR-02 | 2 | `docs/requirements/M17.md` | — | — | R4 | In design |
| M17-FR-03 | 2 | `docs/requirements/M17.md` | — | — | R4 | In design |
| M17-FR-04 | 2 | `docs/requirements/M17.md` | — | — | R4 | In design |
| M18-FR-01 | 2 | `docs/requirements/M18.md` | — | — | R5 | In design |
| M18-FR-02 | 2 | `docs/requirements/M18.md` | — | — | R5 | In design |
| M18-FR-03 | 2 | `docs/requirements/M18.md` | — | — | R5 | In design |
| M18-FR-04 | 2 | `docs/requirements/M18.md` | — | — | R5 | In design |
| M19-FR-01 | 2 | `docs/requirements/M19.md` | — | — | R5 | In design |
| M19-FR-02 | 2 | `docs/requirements/M19.md` | — | — | R5 | In design |
| M19-FR-03 | 2 | `docs/requirements/M19.md` | — | — | R5 | In design |
| M19-FR-04 | 2 | `docs/requirements/M19.md` | — | — | R5 | In design |
| M20-FR-01 | 2 | `docs/requirements/M20.md` | — | — | R4 | In design |
| M20-FR-02 | 2 | `docs/requirements/M20.md` | — | — | R4 | In design |
| M20-FR-03 | 2 | `docs/requirements/M20.md` | — | — | R4 | In design |
| M20-FR-04 | 2 | `docs/requirements/M20.md` | — | — | R4 | In design |
| M21-FR-01 | 2 | `docs/requirements/M21.md` | — | — | R4 | In design |
| M21-FR-02 | 2 | `docs/requirements/M21.md` | — | — | R4 | In design |
| M21-FR-03 | 2 | `docs/requirements/M21.md` | — | — | R4 | In design |
| M21-FR-04 | 2 | `docs/requirements/M21.md` | — | — | R4 | In design |
| M22-FR-01 | 2 | `docs/requirements/M22.md` | — | — | R6 | In design |
| M22-FR-02 | 2 | `docs/requirements/M22.md` | — | — | R6 | In design |
| M22-FR-03 | 2 | `docs/requirements/M22.md` | — | — | R6 | In design |
| M22-FR-04 | 2 | `docs/requirements/M22.md` | — | — | R6 | In design |
| M23-FR-01 | 2 | `docs/requirements/M23.md` | — | — | R2 | In design |
| M23-FR-02 | 2 | `docs/requirements/M23.md` | — | — | R2 | In design |
| M23-FR-03 | 2 | `docs/requirements/M23.md` | — | — | R2 | In design |
| M23-FR-04 | 2 | `docs/requirements/M23.md` | — | — | R2 | In design |
| M24-FR-01 | 2 | `docs/requirements/M24.md` | — | — | R6 | In design |
| M24-FR-02 | 2 | `docs/requirements/M24.md` | — | — | R6 | In design |
| M24-FR-03 | 2 | `docs/requirements/M24.md` | — | — | R6 | In design |
| M24-FR-04 | 2 | `docs/requirements/M24.md` | — | — | R6 | In design |
| M25-FR-01 | 2 | `docs/requirements/M25.md` | — | — | R6 | In design |
| M25-FR-02 | 2 | `docs/requirements/M25.md` | — | — | R6 | In design |
| M25-FR-03 | 2 | `docs/requirements/M25.md` | — | — | R6 | In design |
| M25-FR-04 | 2 | `docs/requirements/M25.md` | — | — | R6 | In design |
| M26-FR-01 | 2 | `docs/requirements/M26.md` | — | — | R6 | In design |
| M26-FR-02 | 2 | `docs/requirements/M26.md` | — | — | R6 | In design |
| M26-FR-03 | 2 | `docs/requirements/M26.md` | — | — | R6 | In design |
| M26-FR-04 | 2 | `docs/requirements/M26.md` | — | — | R6 | In design |
| M27-FR-01 | 2 | `docs/requirements/M27.md` | — | — | R6 | In design |
| M27-FR-02 | 2 | `docs/requirements/M27.md` | — | — | R6 | In design |
| M27-FR-03 | 2 | `docs/requirements/M27.md` | — | — | R6 | In design |
| M27-FR-04 | 2 | `docs/requirements/M27.md` | — | — | R6 | In design |
| M28-FR-01 | 2 | `docs/requirements/M28.md` | — | — | R6 | In design |
| M28-FR-02 | 2 | `docs/requirements/M28.md` | — | — | R6 | In design |
| M28-FR-03 | 2 | `docs/requirements/M28.md` | — | — | R6 | In design |
| M28-FR-04 | 2 | `docs/requirements/M28.md` | — | — | R6 | In design |
| M29-FR-01 | 2 | `docs/requirements/M29.md` | — | — | R2 | In design |
| M29-FR-02 | 2 | `docs/requirements/M29.md` | — | — | R2 | In design |
| M29-FR-03 | 2 | `docs/requirements/M29.md` | — | — | R2 | In design |
| M29-FR-04 | 2 | `docs/requirements/M29.md` | — | — | R2 | In design |
| M30-FR-01 | 2 | `docs/requirements/M30.md` | — | — | R2 | In design |
| M30-FR-02 | 2 | `docs/requirements/M30.md` | — | — | R2 | In design |
| M30-FR-03 | 2 | `docs/requirements/M30.md` | — | — | R2 | In design |
| M30-FR-04 | 2 | `docs/requirements/M30.md` | — | — | R2 | In design |
| M31-FR-01 | 2 | `docs/requirements/M31.md` | — | — | R2 | In design |
| M31-FR-02 | 2 | `docs/requirements/M31.md` | — | — | R2 | In design |
| M31-FR-03 | 2 | `docs/requirements/M31.md` | — | — | R4 | In design |
| M31-FR-04 | 2 | `docs/requirements/M31.md` | — | — | R4 | In design |
| M32-FR-01 | 2 | `docs/requirements/M32.md` | — | — | R1 | In design |
| M32-FR-02 | 2 | `docs/requirements/M32.md` | — | — | R1 | In design |
| M32-FR-03 | 2 | `docs/requirements/M32.md` | — | — | R1 | In design |
| M32-FR-04 | 2 | `docs/requirements/M32.md` | — | — | R1 | In design |
| M33-FR-01 | 2 | `docs/requirements/M33.md` | — | — | R1 | In design |
| M33-FR-02 | 2 | `docs/requirements/M33.md` | — | — | R1 | In design |
| M33-FR-03 | 2 | `docs/requirements/M33.md` | — | — | R1 | In design |
| M33-FR-04 | 2 | `docs/requirements/M33.md` | — | — | R1 | In design |
| M34-FR-01 | 2 | `docs/requirements/M34.md` | — | — | R1 | In design |
| M34-FR-02 | 2 | `docs/requirements/M34.md` | — | — | R1 | In design |
| M34-FR-03 | 2 | `docs/requirements/M34.md` | — | — | R1 | In design |
| M34-FR-04 | 2 | `docs/requirements/M34.md` | — | — | R1 | In design |
| M35-FR-01 | 2 | `docs/requirements/M35.md` | — | — | R1 | In design |
| M35-FR-02 | 2 | `docs/requirements/M35.md` | — | — | R1 | In design |
| M35-FR-03 | 2 | `docs/requirements/M35.md` | — | — | R1 | In design |
| M35-FR-04 | 2 | `docs/requirements/M35.md` | — | — | R1 | In design |
| M36-FR-01 | 2 | `docs/requirements/M36.md` | — | — | R8 | In design |
| M36-FR-02 | 2 | `docs/requirements/M36.md` | — | — | R8 | In design |
| M36-FR-03 | 2 | `docs/requirements/M36.md` | — | — | R8 | In design |
| M36-FR-04 | 2 | `docs/requirements/M36.md` | — | — | R8 | In design |
| _(non-module requirement sets — SEC-01…12, PRV-01…10, NFR-01…15, AI-NFR-01…12, MG-01…12 — traced during their build stages)_ | | | | | | |
