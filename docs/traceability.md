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
| Goods receiving (integration) | M07 (receiving/GRN) — inbound stock, offline, idempotent | `packages/receiving/src/receiving.ts` | `tests/unit/receiving.test.ts` (3 tests) |
| Stock adjustment (integration) | M08-FR-03 (reason-coded, approved compensating) / §28 | `packages/adjustment/src/adjustment.ts` | `tests/unit/adjustment.test.ts` (6 tests) |
| Return & refund commit (integration) | M13-FR-01/02/03 (at-most-once, disposition, approval/cap; never invent reversal) / §28 | `packages/returns/src/returns.ts` | `tests/unit/returns.test.ts` (15 tests) |
| Cashier shift / till close | M14-FR-02 (blind count, over/short, valued exception) — fully offline | `packages/till/src/till.ts` | `tests/unit/till.test.ts` (6 tests) |
| Store/day close + controlled reopen | M14-FR-04 (trading-day-aligned lock; block on open exceptions/unsent; approved reopen) | `packages/day-close/src/day-close.ts` | `tests/unit/day-close.test.ts` (8 tests) |
| Till cash movements | M14-FR-01 (float/loan/pickup/safe-drop; one custodian per till; no overdraw; append-only) | `packages/cash/src/cash.ts` | `tests/unit/cash.test.ts` (8 tests) |
| Cycle/blind count reconciliation | M09-FR-04 (blind count vs projected ledger; valued variance → approved compensating adjustment) / §28 | `packages/counts/src/counts.ts` | `tests/unit/counts.test.ts` (8 tests) |
| Replenishment suggestions | M09-FR-02 (reorder point/safety/max; demand×lead; advisory only, buyer approves) / hard rule #5 / AI-NFR-12 | `packages/replenishment/src/replenishment.ts` | `tests/unit/replenishment.test.ts` (12 tests) |
| FEFO allocation & expiry list | M10-FR-01 (sell earliest-expiry first; never expired/recalled; markdown/dispose list) | `packages/fefo/src/fefo.ts` | `tests/unit/fefo.test.ts` (9 tests) |
| Lot traceability & recall | M10-FR-03 (batch trace supplier↔customer over ledger) + M10-FR-04 (recall block offline; close with retained evidence) / hard rule #6 | `packages/traceability/src/` | `tests/unit/traceability.test.ts` (5 tests) |
| Loss-prevention anomaly rules | M15-FR-01 / P-03 (configurable void/refund/discount/no-sale/cash rules; linked exceptions; detect-only) | `packages/loss-prevention/src/loss-prevention.ts` | `tests/unit/loss-prevention.test.ts` (9 tests) |
| Promotions best-price engine | M05-FR-03 (deterministic best price; BOGO/multibuy/coupon/member; no expired/unpublished; stacking/exclusion) / P-02 | `packages/promotions/src/promotions.ts` | `tests/unit/promotions.test.ts` (11 tests) |
| Margin-floor / MRP price controls | M05-FR-02 (reject above MRP; below floor/cost blocked pending approval + reason) / §28 | `packages/price-guard/src/price-guard.ts` | `tests/unit/price-guard.test.ts` (10 tests) |
| Effective-dated price resolution | M05-FR-01 / P-02 (precedence customer>channel>zone>store; no early activation; append-only history; version lock) | `packages/price-list/src/price-list.ts` | `tests/unit/price-list.test.ts` (10 tests) |
| Finance posting (ledger→journals) | M23-FR-01/02 (mapping-driven balanced double-entry; GST component; unmapped→exception) / P-08 / §28 | `packages/finance/src/posting.ts` | `tests/unit/finance-posting.test.ts` (7 tests) |
| Payment reconciliation | M23-FR-03 (match tenders↔settlements by token/amount; valued exceptions; no card PAN) / hard rule #3 | `packages/reconciliation/src/reconciliation.ts` | `tests/unit/reconciliation.test.ts` (7 tests) |
| Loyalty points (earn/burn/reverse) | M17-FR-01 (money-like append-only; projected balance; offline cap; never negative) / §31 | `packages/loyalty/src/loyalty.ts` | `tests/unit/loyalty.test.ts` (8 tests) |
| Purchase orders & open commitment | M06-FR-02/04 (issue with separate approver + value limit; open = ordered−received−cancelled) / §28 | `packages/purchasing/src/purchasing.ts` | `tests/unit/purchasing.test.ts` (8 tests) |
| Bank fraud controls | M06-FR-01 (bank-change verification, maker≠approver) + M15-FR-03 (duplicate bank-account → block) / §28 | `packages/bank-controls/src/` | `tests/unit/bank-controls.test.ts` (8 tests) |
| Order lifecycle & reservation | M18-FR-01/02 (auditable state machine; reserve stock; no oversell) / §6.2 | `packages/orders/src/` | `tests/unit/orders.test.ts` (10 tests) |
| Fulfilment (delivery/substitution/COD) | M19-FR-01/03/04 (delivery state machine + proof; customer-confirmed substitution; COD recon, cash/UPI only) / A04 / hard rule #3 | `packages/fulfilment/src/` | `tests/unit/fulfilment.test.ts` (10 tests) |
| Customer dedup & consent | M16-FR-01 (duplicate detection, no auto-merge; uncertain→review) + M16-FR-02 (consent-scoped send, breach blocked) / P-08 / PRV | `packages/customer/src/` | `tests/unit/customer.test.ts` (9 tests) |
| Waste / write-off | M28-FR-01 (reason-coded compensating loss; material needs separate approver + evidence) / §28 / hard rule #2 | `packages/waste/src/waste.ts` | `tests/unit/waste.test.ts` (8 tests) |
| B2B credit & commission | M22-FR-01 (credit-limit block pending approval; contract expiry) + M22-FR-03 (exact commission) / §28 | `packages/b2b/src/` | `tests/unit/b2b.test.ts` (10 tests) |
| Notifications (guard + queue) | M31-FR-03 (consent-safe send, blocked on breach) + M31-FR-04 (retry/dead-letter, suppression, template approval) / hard rule #6 | `packages/notifications/src/` | `tests/unit/notifications.test.ts` (9 tests) |
| Owner KPIs & freshness | M29-FR-01 / D13 (exact sales/margin/basket/tender aggregation; stale/missing never shown as fresh) / P-08 | `packages/reporting/src/` | `tests/unit/reporting.test.ts` (7 tests) |
| Durable event store (persistence) | §30.2 / §31.1 / hard rule #2 / ADR-0003 — append-only, tenant-scoped, idempotent; SqlClient port + `event_ledger` DDL | `packages/persistence/src/`, `db/migrations/0001_event_ledger.sql` | `tests/unit/persistence-event-store.test.ts` (8 tests) |
| Durable sync outbox (persistence) | P-01 / §31 / hard rule #6 — tenant-scoped, idempotent enqueue, retry, visible dead-letter; `sync_outbox` DDL | `packages/persistence/src/outbox-store.ts`, `db/migrations/0002_sync_outbox.sql` | `tests/unit/persistence-outbox-store.test.ts` (8 tests) |
| Durable versioned config (persistence) | M01-FR-03 / ADR-0003 — append-only versions per (tenant,key); rollback as a new version; `config_versions` DDL | `packages/persistence/src/config-store.ts`, `db/migrations/0003_config_versions.sql` | `tests/unit/persistence-config-store.test.ts` (7 tests) |
| Projection read-models (persistence) | §29 (read models derived from events) / P-08 — incremental fold with watermark + freshness time; rebuildable | `packages/persistence/src/projection.ts` | `tests/unit/persistence-projection.test.ts` (6 tests) |
| PostgreSQL connector + migration runner | §19 baseline (PostgreSQL) / P-06 — `pg`→`SqlClient` adapter (structural, portable); idempotent migration runner + runnable CLI | `packages/persistence/src/pg-client.ts`, `packages/persistence/src/migrations.ts`, `scripts/migrate.mjs` | `tests/unit/persistence-pg-connector.test.ts` (5 tests) |
| **POS app shell** (first app) | M12–M15 / D04 / hard rule #1 / §27.1 — Sale-screen session composing pricing·promotions·tender·sale; offline PWA shell to the Stage 3 spec | `apps/pos/src/session.ts`, `apps/pos/web/` | `tests/unit/pos-session.test.ts` (13 tests) |
| POS build pipeline + view adapter | §19 delivery (CI/CD build tooling) — esbuild bundle of the tested model into the shell; display-primitive adapter so the view holds no rules | `apps/pos/src/view-adapter.ts`, `apps/pos/src/browser-entry.ts`, `scripts/build-pos.mjs` | `tests/unit/pos-view-adapter.test.ts` (6 tests) |
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
| M05-FR-01 | 2 | `docs/requirements/M05.md` | `packages/price-list/src/price-list.ts` | `tests/unit/price-list.test.ts` | R2 | Foundation built (precedence resolution; effective-dated; append-only history; version lock) |
| M05-FR-02 | 2 | `docs/requirements/M05.md` | `packages/price-guard/src/price-guard.ts` | `tests/unit/price-guard.test.ts` | R2 | Foundation built (MRP ceiling; below floor/cost needs a separate approver + reason) |
| M05-FR-03 | 2 | `docs/requirements/M05.md` | `packages/promotions/src/promotions.ts` | `tests/unit/promotions.test.ts` | R2 | Foundation built (deterministic best price; BOGO/multibuy/coupon/member; expired/unpublished never apply) |
| M05-FR-04 | 2 | `docs/requirements/M05.md` | — | — | R2 | In design |
| M06-FR-01 | 2 | `docs/requirements/M06.md` | `packages/bank-controls/src/bank-verification.ts` | `tests/unit/bank-controls.test.ts` | R2 | Foundation built (bank-change verification, maker≠approver; unverified blocks payment) |
| M06-FR-02 | 2 | `docs/requirements/M06.md` | `packages/purchasing/src/purchasing.ts` | `tests/unit/purchasing.test.ts` | R2 | Foundation built (issue with separate approver; value limit via approvals; SoD) |
| M06-FR-03 | 2 | `docs/requirements/M06.md` | — | — | R2 | In design |
| M06-FR-04 | 2 | `docs/requirements/M06.md` | `packages/purchasing/src/purchasing.ts` | `tests/unit/purchasing.test.ts` | R2 | Foundation built (open commitment = ordered−received−cancelled; over-receipt signalled) |
| M07-FR-01 | 2 | `docs/requirements/M07.md` | — | — | R2 | In design |
| M07-FR-02 | 2 | `docs/requirements/M07.md` | — | — | R2 | In design |
| M07-FR-03 | 2 | `docs/requirements/M07.md` | — | — | R2 | In design |
| M07-FR-04 | 2 | `docs/requirements/M07.md` | — | — | R2 | In design |
| M08-FR-01 | 2 | `docs/requirements/M08.md` | — | — | R2 | In design |
| M08-FR-02 | 2 | `docs/requirements/M08.md` | — | — | R2 | In design |
| M08-FR-03 | 2 | `docs/requirements/M08.md` | — | — | R2 | In design |
| M08-FR-04 | 2 | `docs/requirements/M08.md` | — | — | R2 | In design |
| M09-FR-01 | 2 | `docs/requirements/M09.md` | — | — | R2 | In design |
| M09-FR-02 | 2 | `docs/requirements/M09.md` | `packages/replenishment/src/replenishment.ts` | `tests/unit/replenishment.test.ts` | R2 | Foundation built (reorder point/safety/max; demand×lead; advisory only) |
| M09-FR-03 | 2 | `docs/requirements/M09.md` | — | — | R2 | In design |
| M09-FR-04 | 2 | `docs/requirements/M09.md` | `packages/counts/src/counts.ts` | `tests/unit/counts.test.ts` | R2 | Foundation built (blind count → valued variance → approved compensating adjustment) |
| M10-FR-01 | 2 | `docs/requirements/M10.md` | `packages/fefo/src/fefo.ts` | `tests/unit/fefo.test.ts` | R2 | Foundation built (FEFO allocation; expired/recalled never sold; expiry action list) |
| M10-FR-02 | 2 | `docs/requirements/M10.md` | — | — | R2 | In design |
| M10-FR-03 | 2 | `docs/requirements/M10.md` | `packages/traceability/src/traceability.ts` | `tests/unit/traceability.test.ts` | R2 | Foundation built (batch trace inbound/outbound over the ledger; forward-trace pending sale batch-tagging) |
| M10-FR-04 | 2 | `docs/requirements/M10.md` | `packages/traceability/src/recall.ts` | `tests/unit/traceability.test.ts` | R2 | Foundation built (recall block offline; close only with retained evidence) |
| M11-FR-01 | 2 | `docs/requirements/M11.md` | — | — | R2 | In design |
| M11-FR-02 | 2 | `docs/requirements/M11.md` | — | — | R2 | In design |
| M11-FR-03 | 2 | `docs/requirements/M11.md` | — | — | R2 | In design |
| M11-FR-04 | 2 | `docs/requirements/M11.md` | — | — | R2 | In design |
| M12-FR-01 | 2 | `docs/requirements/M12.md` | — | — | R2 | In design |
| M12-FR-02 | 2 | `docs/requirements/M12.md` | — | — | R2 | In design |
| M12-FR-03 | 2 | `docs/requirements/M12.md` | — | — | R2 | In design |
| M12-FR-04 | 2 | `docs/requirements/M12.md` | — | — | R2 | In design |
| M13-FR-01 | 2 | `docs/requirements/M13.md` | `packages/returns/src/returns.ts` | `tests/unit/returns.test.ts` | R2 | Foundation built (at-most-once, offline receipted return) |
| M13-FR-02 | 2 | `docs/requirements/M13.md` | `packages/returns/src/returns.ts` | `tests/unit/returns.test.ts` | R2 | Foundation built (disposition → availability) |
| M13-FR-03 | 2 | `docs/requirements/M13.md` | `packages/returns/src/returns.ts` | `tests/unit/returns.test.ts` | R2 | Foundation built (refund cap + separate-approver threshold) |
| M13-FR-04 | 2 | `docs/requirements/M13.md` | `packages/returns/src/returns.ts` | `tests/unit/returns.test.ts` | R2 | Partial — domain honoured (card/UPI refund stays pending, never invented); provider reversal deferred |
| M14-FR-01 | 2 | `docs/requirements/M14.md` | `packages/cash/src/cash.ts` | `tests/unit/cash.test.ts` | R2 | Foundation built (float/loan/pickup/safe-drop; one custodian; no overdraw) |
| M14-FR-02 | 2 | `docs/requirements/M14.md` | `packages/till/src/till.ts` | `tests/unit/till.test.ts` | R2 | Foundation built (blind count, over/short, valued exception) |
| M14-FR-03 | 2 | `docs/requirements/M14.md` | — | — | R2 | In design |
| M14-FR-04 | 2 | `docs/requirements/M14.md` | `packages/day-close/src/day-close.ts` | `tests/unit/day-close.test.ts` | R2 | Foundation built (trading-day lock; block on open exceptions/unsent; approved reopen) |
| M15-FR-01 | 2 | `docs/requirements/M15.md` | `packages/loss-prevention/src/loss-prevention.ts` | `tests/unit/loss-prevention.test.ts` | R2 | Foundation built (configurable rules → linked exceptions; detect-only) |
| M15-FR-02 | 2 | `docs/requirements/M15.md` | — | — | R2 | In design |
| M15-FR-03 | 2 | `docs/requirements/M15.md` | `packages/bank-controls/src/duplicate-bank.ts` | `tests/unit/bank-controls.test.ts` | R2 | Foundation built (duplicate bank-account detection → block pending review) |
| M15-FR-04 | 2 | `docs/requirements/M15.md` | — | — | R2 | In design |
| M16-FR-01 | 2 | `docs/requirements/M16.md` | `packages/customer/src/matching.ts` | `tests/unit/customer.test.ts` | R4 | Foundation built (duplicate detection; uncertain→review; never auto-merge) |
| M16-FR-02 | 2 | `docs/requirements/M16.md` | `packages/customer/src/consent.ts` | `tests/unit/customer.test.ts` | R4 | Foundation built (consent-scoped send; breach blocked; immediate withdrawal) |
| M16-FR-03 | 2 | `docs/requirements/M16.md` | — | — | R4 | In design |
| M16-FR-04 | 2 | `docs/requirements/M16.md` | — | — | R4 | In design |
| M17-FR-01 | 2 | `docs/requirements/M17.md` | `packages/loyalty/src/loyalty.ts` | `tests/unit/loyalty.test.ts` | R4 | Foundation built (money-like append-only points; projected balance; offline cap; never negative) |
| M17-FR-02 | 2 | `docs/requirements/M17.md` | — | — | R4 | In design |
| M17-FR-03 | 2 | `docs/requirements/M17.md` | — | — | R4 | In design |
| M17-FR-04 | 2 | `docs/requirements/M17.md` | — | — | R4 | In design |
| M18-FR-01 | 2 | `docs/requirements/M18.md` | `packages/orders/src/lifecycle.ts` | `tests/unit/orders.test.ts` | R5 | Foundation built (auditable order lifecycle state machine) |
| M18-FR-02 | 2 | `docs/requirements/M18.md` | `packages/orders/src/reservation.ts` | `tests/unit/orders.test.ts` | R5 | Foundation built (stock reservation; available-to-promise; no oversell) |
| M18-FR-03 | 2 | `docs/requirements/M18.md` | — | — | R5 | In design |
| M18-FR-04 | 2 | `docs/requirements/M18.md` | — | — | R5 | In design |
| M19-FR-01 | 2 | `docs/requirements/M19.md` | `packages/fulfilment/src/delivery.ts` | `tests/unit/fulfilment.test.ts` | R5 | Foundation built (customer-confirmed substitution, A04) |
| M19-FR-02 | 2 | `docs/requirements/M19.md` | — | — | R5 | In design |
| M19-FR-03 | 2 | `docs/requirements/M19.md` | `packages/fulfilment/src/delivery.ts` | `tests/unit/fulfilment.test.ts` | R5 | Foundation built (delivery state machine; proof of delivery required) |
| M19-FR-04 | 2 | `docs/requirements/M19.md` | `packages/fulfilment/src/cod.ts` | `tests/unit/fulfilment.test.ts` | R5 | Foundation built (COD reconciliation, cash/UPI only, valued exceptions) |
| M20-FR-01 | 2 | `docs/requirements/M20.md` | — | — | R4 | In design |
| M20-FR-02 | 2 | `docs/requirements/M20.md` | — | — | R4 | In design |
| M20-FR-03 | 2 | `docs/requirements/M20.md` | — | — | R4 | In design |
| M20-FR-04 | 2 | `docs/requirements/M20.md` | — | — | R4 | In design |
| M21-FR-01 | 2 | `docs/requirements/M21.md` | — | — | R4 | In design |
| M21-FR-02 | 2 | `docs/requirements/M21.md` | — | — | R4 | In design |
| M21-FR-03 | 2 | `docs/requirements/M21.md` | — | — | R4 | In design |
| M21-FR-04 | 2 | `docs/requirements/M21.md` | — | — | R4 | In design |
| M22-FR-01 | 2 | `docs/requirements/M22.md` | `packages/b2b/src/credit.ts` | `tests/unit/b2b.test.ts` | R6 | Foundation built (credit-limit block pending approval; contract-expiry policy) |
| M22-FR-02 | 2 | `docs/requirements/M22.md` | — | — | R6 | In design |
| M22-FR-03 | 2 | `docs/requirements/M22.md` | `packages/b2b/src/commission.ts` | `tests/unit/b2b.test.ts` | R6 | Foundation built (exact salesperson commission with cap) |
| M22-FR-04 | 2 | `docs/requirements/M22.md` | — | — | R6 | In design |
| M23-FR-01 | 2 | `docs/requirements/M23.md` | `packages/finance/src/posting.ts` | `tests/unit/finance-posting.test.ts` | R2 | Foundation built (mapping-driven balanced double-entry; unmapped→exception) |
| M23-FR-02 | 2 | `docs/requirements/M23.md` | `packages/finance/src/posting.ts` | `tests/unit/finance-posting.test.ts` | R2 | Partial — GST posts as a mapped component; credit/debit notes & returns reports pending |
| M23-FR-03 | 2 | `docs/requirements/M23.md` | `packages/reconciliation/src/reconciliation.ts` | `tests/unit/reconciliation.test.ts` | R2 | Foundation built (tender↔settlement match; valued exceptions; no card PAN) |
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
| M28-FR-01 | 2 | `docs/requirements/M28.md` | `packages/waste/src/waste.ts` | `tests/unit/waste.test.ts` | R6 | Foundation built (reason-coded compensating write-off; material needs separate approver + evidence) |
| M28-FR-02 | 2 | `docs/requirements/M28.md` | — | — | R6 | In design |
| M28-FR-03 | 2 | `docs/requirements/M28.md` | — | — | R6 | In design |
| M28-FR-04 | 2 | `docs/requirements/M28.md` | — | — | R6 | In design |
| M29-FR-01 | 2 | `docs/requirements/M29.md` | `packages/reporting/src/` | `tests/unit/reporting.test.ts` | R2 | Foundation built (exact sales/margin/basket/tender KPIs; freshness fresh/stale/missing) |
| M29-FR-02 | 2 | `docs/requirements/M29.md` | — | — | R2 | In design |
| M29-FR-03 | 2 | `docs/requirements/M29.md` | — | — | R2 | In design |
| M29-FR-04 | 2 | `docs/requirements/M29.md` | — | — | R2 | In design |
| M30-FR-01 | 2 | `docs/requirements/M30.md` | — | — | R2 | In design |
| M30-FR-02 | 2 | `docs/requirements/M30.md` | — | — | R2 | In design |
| M30-FR-03 | 2 | `docs/requirements/M30.md` | — | — | R2 | In design |
| M30-FR-04 | 2 | `docs/requirements/M30.md` | — | — | R2 | In design |
| M31-FR-01 | 2 | `docs/requirements/M31.md` | — | — | R2 | In design |
| M31-FR-02 | 2 | `docs/requirements/M31.md` | — | — | R2 | In design |
| M31-FR-03 | 2 | `docs/requirements/M31.md` | `packages/notifications/src/guard.ts` | `tests/unit/notifications.test.ts` | R4 | Foundation built (consent-safe send guard; blocked on breach) |
| M31-FR-04 | 2 | `docs/requirements/M31.md` | `packages/notifications/src/queue.ts` | `tests/unit/notifications.test.ts` | R4 | Foundation built (retry + visible dead-letter; suppression; template approval) |
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
| _Cross-cutting sets — SEC-01…12, PRV-01…10, NFR-01…15, AI-NFR-01…12, MG-01…12 — mapped in_ `docs/requirements/cross-cutting.md` _(each tied to the guardrail/package/ADR that addresses it); verified per item at its build stage / quality gate._ | | | | | | |
