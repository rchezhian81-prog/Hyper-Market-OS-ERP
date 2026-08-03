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
| Product master (write side) | M03-FR-01/02/03/04 / P-02 / §9.3 / §28 / D01 — draft-vs-publish validation naming every gap in plain English; typed per-tenant category attributes; food allergen declaration (empty list ≠ silence), Legal Metrology fields, age flag; effective-dated MRP; recall block stops sale and purchase offline; exact reversible pack conversions; one barcode ↔ one item; duplicate review with graded evidence and approved reversible merge | `packages/product/src/` | `tests/unit/product-master.test.ts` (19), `tests/unit/product-pack.test.ts` (9), `tests/unit/product-duplicates.test.ts` (13) |
| Stock states, availability & health metrics | M08-FR-02/04 / §6.2 / hard rule #2 / P-08 — position projected from state-transfer movements per product×location×batch; reserved/quarantine/damaged/expired/in-transit excluded from sellable; expired+quarantine never sellable by any policy; negative stock blocked or raised as a visible exception; ageing/turns/GMROI/stockouts exact in BigInt basis points with `not_meaningful` instead of a fabricated ratio | `packages/stock/src/` | `tests/unit/stock-position.test.ts` (14), `tests/unit/stock-metrics.test.ts` (13) |
| Goods-in capture, discrepancy & three-way match | M07-FR-02/03/04 / D03-FR-05 / §28 / P-03 / P-08 — batch/expiry/temperature mandatory where the master requires; expired refused, damaged/QC-failed/breached quarantined (not sellable); short/excess/MRP valued and owned; PO↔GRN↔invoice match blocks payment out of tolerance with receiver ≠ approver; landed cost apportioned by value to the paisa | `packages/receiving/src/capture.ts`, `packages/receiving/src/three-way-match.ts` | `tests/unit/goods-in.test.ts` (23 tests) |
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
| Local catalogue cache & barcode lookup | M03 / M03-FR-02 / M12 / §31 / §32 — O(1) offline scan, weight/price-embedded barcodes (per-tenant rules), recall+status refusal, age flag, staleness | `packages/catalogue/src/catalogue.ts` | `tests/unit/catalogue.test.ts` (10), `tests/unit/pos-barcode-scan.test.ts` (7) |
| Catalogue snapshot builder | M03 → M05-FR-01 → §31 / P-08 / M05-FR-02 — price resolved by precedence at build time; unpriced/above-MRP/untaxed excluded with reasons; deterministic | `packages/catalogue/src/snapshot-builder.ts` | `tests/unit/catalogue-snapshot-builder.test.ts` (10 tests) |
| **Store-edge sync agent** | P-01 / §31 / §31.1 / hard rules #6 & #10 — ordered idempotent drain, retry + backoff, visible dead-letter, conflict→exception, honest health | `edge/sync-agent/src/` | `tests/unit/sync-agent.test.ts` (12 tests) |
| **Owner app shell** (2nd app) | M29 / M29-FR-01/02/03 / D13 / P-03 / P-08 — executive brief: KPIs, top-3 attention, grouped drillable alerts, approvals inbox, freshness; works with AI off | `apps/owner-app/src/brief.ts`, `apps/owner-app/web/` | `tests/unit/owner-brief.test.ts` (9 tests) |
| **Web ERP shell** (3rd app) | §27 role surfaces / P-07 / P-04 / M02 / §28 — permission-derived navigation (default-deny, branch-scoped) and the approvals workbench (SoD visible, escalation not a failing button) | `apps/web-erp/src/` | `tests/unit/web-erp-shell.test.ts` (14 tests) |
| **Picker/packer app shell** (4th app) | M19-FR-01/02 / M18 / D09 / A04 / §31 — scan-ordered picking, customer-confirmed substitution, weighed final price at pick, manifest derived from what was packed, PII minimised | `apps/picker-app/src/pick-session.ts` | `tests/unit/picker-session.test.ts` (17 tests) |
| **Delivery app shell** (5th app) | M19-FR-03/04 / D09 / §31 / hard rule #3 — proof-gated delivery, COD to the paisa + end-of-shift settlement, failure→reattempt/RTO, geofence flag, contribution stop rules, PII minimised | `apps/delivery-app/src/route-session.ts` | `tests/unit/delivery-route.test.ts` (15 tests) |
| Receipt printing | M31-FR-02 / M12-FR-02 / hard rules #1 & #3 — built from the committed sale, balancing totals enforced, PAN refused, reprint stamped + reasoned, ESC/POS, printer failure never costs the sale | `packages/receipt/src/` | `tests/unit/receipt.test.ts` (14 tests) |
| **Template-driven import** (audit A-03) | M30-FR-01/03/04 / §28 — RFC-4180 parser, per-row errors with line numbers, duplicates to review (never auto-merge), referential integrity, control-total reconciliation, separate approver, atomic commit | `packages/import/src/` | `tests/unit/import.test.ts` (22 tests, incl. the 80-line invoice) |
| Audit & compliance evidence | M34-FR-01/02 / NFR-15 / SEC-07 / PRV-08 / hard rule #6 — hash-chained append-only trail (no edit/delete in the API), tamper detection naming every break, reconstruct-from-evidence, search, legal hold beating retention, plan-not-delete retention, sealed evidence pack | `packages/audit/src/` | `tests/unit/audit.test.ts` (19 tests) |
| Named accounts, sessions & access lifecycle | M02-FR-01/04 / SEC-03 / SEC-11 / §28 / §31 / hard rule #4 — no credential field exists in the package; generic/shared accounts and duplicate contacts refused at creation; MFA gate on privileged activation; idle/absolute/device-bound sessions with a time-bounded offline cached identity; lockout; access review flagging privileged-without-MFA and dormant; joiner/mover/leaver where a mover replaces scope and a leaver is blocked on orphaned owned items, revocation as priority sync; emergency access time-bound at grant, self-expiring, never extendable in place | `packages/identity/src/` | `tests/unit/identity-account.test.ts` (18), `tests/unit/identity-lifecycle.test.ts` (16) |
| Org hierarchy & branch lifecycle | M01-FR-01/04 / §28 / §31 / ADR-0003 / hard rule #6 — company→GSTIN→branch→warehouse→department with checksum-validated unique GSTIN (duplicate names the holder), activation blocked without company+registration, cross-tenant parent refused, scope/ancestry/GSTIN resolution cycle-safe; governed open/temporary-close/reopen/permanent-close returning every blocker at once, permanent closure blocked on stock, cash, open documents, unsent sync and exceptions, owner-approved with maker≠approver, retained closure evidence | `packages/org/src/` | `tests/unit/org-hierarchy.test.ts` (17), `tests/unit/org-branch-lifecycle.test.ts` (13) |
| Licence, risk & incident registers | M34-FR-03/04 / §9.3 / QG-06 / QG-08 / hard rule #6 — obligation register refusing an unnamed owner; escalating expiry alerts that keep shouting after the date and name the person; evidence-missing flag; close-with-reason, never delete; incident→control and remediation→owner links enforced; attestation staleness; open critical risk blocks its gate; risk acceptance needs a named author and rationale | `packages/compliance/src/` | `tests/unit/compliance-obligations.test.ts` (16), `tests/unit/compliance-risk.test.ts` (12) |
| Domain export (no lock-in) | M30-FR-02 / NFR-12 / OD-09 / P-06 / P-04 / §28 / PRV — open CSV + machine-readable schema; permission default-deny, branch scope enforced, sensitive columns redacted not dropped; audit record per export; round-trip through our own importer proven | `packages/export/src/` | `tests/unit/export.test.ts` (8 tests) |
| Tenant feature entitlements | ADR-0003 / M33·D12·M36 (multi-tenant; choose-able modules) | `packages/tenant/src/tenant.ts` | `tests/unit/tenant.test.ts` (6 tests) |
| Per-tenant settings | ADR-0003 (choose-able settings, defaults, per-tenant, versioned) | `packages/tenant/src/settings.ts` | `tests/unit/tenant-settings.test.ts` (5 tests) |

## Individual requirement trace (expanded in Stage 2)

| Requirement ID | Stage | Design | Code | Tests | Release | Status |
| --- | --- | --- | --- | --- | --- | --- |
| M01-FR-01 | 2 | `docs/requirements/M01.md` | `packages/org/src/hierarchy.ts` | `tests/unit/org-hierarchy.test.ts` | R1 | Foundation built (company/GSTIN/branch/warehouse/department integrity; checksum-validated unique GSTIN rejecting duplicates by name; branch activation requires company + own registration; branch/department report scoping) |
| M01-FR-02 | 2 | `docs/requirements/M01.md` | `packages/calendar/src/`, `packages/numbering/src/` | `tests/unit/trading-day.test.ts`, `tests/unit/numbering.test.ts` | R1 | Foundation built (trading-day calendar; gap-free per-type number series with offline reserved ranges; exact currency in `contracts`) — document templates via `packages/receipt` |
| M01-FR-03 | 2 | `docs/requirements/M01.md` | `packages/config/src/`, `packages/tenant/src/`, `packages/persistence/src/config-store.ts` | `tests/unit/config.test.ts`, `tests/unit/tenant.test.ts`, `tests/unit/persistence-config-store.test.ts` | R1 | Foundation built (append-only config versions, non-destructive rollback, per-tenant feature flags default-off) |
| M01-FR-04 | 2 | `docs/requirements/M01.md` | `packages/org/src/branch-lifecycle.ts` | `tests/unit/org-branch-lifecycle.test.ts` | R1 | Foundation built (open/temporary-close/reopen/permanent-close; closure blocked with the exact reasons while stock, cash, open documents, unsent sync or exceptions remain; access revoked; audit and evidence retained) |
| M02-FR-01 | 2 | `docs/requirements/M02.md` | `packages/identity/src/account.ts` | `tests/unit/identity-account.test.ts` | R1 | Partial — named-account rules (shared/generic refused), MFA gate on privileged activation, session idle/absolute/device-binding, bounded offline cached identity, lockout and access review all built; credential storage and MFA enrolment belong to the deployment identity provider (deliberately no credentials in this codebase, hard rule #4) |
| M02-FR-02 | 2 | `docs/requirements/M02.md` | `packages/rbac/src/` | `tests/unit/rbac.test.ts`, `tests/unit/web-erp-shell.test.ts` | R1 | Foundation built (default-deny role/branch/permission authz; value limits via `packages/approvals`; permission-derived navigation) |
| M02-FR-03 | 2 | `docs/requirements/M02.md` | `packages/approvals/src/`, `apps/web-erp/src/approvals-workbench.ts` | `tests/unit/approvals.test.ts`, `tests/unit/web-erp-shell.test.ts` | R1 | Partial — maker≠checker, value-limit routing and escalation on exceeded authority built; **delegation** pending |
| M02-FR-04 | 2 | `docs/requirements/M02.md` | `packages/identity/src/lifecycle.ts` | `tests/unit/identity-lifecycle.test.ts` | R1 | Foundation built (joiner/mover/leaver with a mover replacing scope and never accumulating; leaver revoked with sessions closed and blocked until owned open items are reassigned; revocation as priority sync; emergency access time-bound at grant, self-expiring, specific-reason, separate approver, never extendable in place; emergency-access review) |
| M03-FR-01 | 2 | `docs/requirements/M03.md` | `packages/product/src/product.ts` | `tests/unit/product-master.test.ts` | R2 | Foundation built (one primary category enforced; typed per-tenant attributes validated; no category or tax class → cannot publish; incomplete stays a draft) |
| M03-FR-02 | 2 | `docs/requirements/M03.md` | `packages/product/src/pack.ts`, `packages/catalogue/src/catalogue.ts` | `tests/unit/product-pack.test.ts`, `tests/unit/catalogue.test.ts`, `tests/unit/pos-barcode-scan.test.ts` | R2 | Foundation built (one barcode ↔ one item enforced with the owner named; exact reversible unit/inner/case conversion; embedded weight/price barcodes per-tenant; barcode-coverage gaps reported) |
| M03-FR-03 | 2 | `docs/requirements/M03.md` | `packages/product/src/product.ts` | `tests/unit/product-master.test.ts` | R2 | Foundation built (HSN/tax class mandatory; effective-dated historised MRP; food allergen declaration required where an empty list means "none"; Legal Metrology net-quantity/packer fields; age flag; recall block stops sale and purchase offline) |
| M03-FR-04 | 2 | `docs/requirements/M03.md` | `packages/product/src/duplicates.ts`, `packages/product/src/product.ts` | `tests/unit/product-duplicates.test.ts`, `tests/unit/product-master.test.ts` | R2 | Foundation built (lifecycle drives sellability; duplicates graded with evidence and never auto-merged; merge needs a separate approver and is a reversible link, never a deletion) — bulk maintenance via `packages/import` (M30) |
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
| M07-FR-01 | 2 | `docs/requirements/M07.md` | `packages/receiving/src/` | `tests/unit/receiving.test.ts` | R2 | Partial — offline, idempotent goods receipt appending inbound movements per line; ASN and dock scheduling pending |
| M07-FR-02 | 2 | `docs/requirements/M07.md` | `packages/receiving/src/capture.ts` | `tests/unit/goods-in.test.ts` | R2 | Foundation built (count/batch/expiry/MRP/cost/condition/QC captured; batch+expiry mandatory for tracked items; near-expiry and MRP mismatch flagged; cold-chain evidence required) |
| M07-FR-03 | 2 | `docs/requirements/M07.md` | `packages/receiving/src/capture.ts` | `tests/unit/goods-in.test.ts` | R2 | Foundation built (short/excess/rejected; quarantine excluded from availability; over-tolerance excess needs approval; every discrepancy valued and owned) |
| M07-FR-04 | 2 | `docs/requirements/M07.md` | `packages/receiving/src/three-way-match.ts` | `tests/unit/goods-in.test.ts` | R2 | Foundation built (PO↔GRN↔invoice with valued variances; out-of-tolerance blocks payment, receiver ≠ approver; landed cost apportioned exactly) — OCR/e-invoice ingestion and AP posting pending D03/M23 wiring |
| M08-FR-01 | 2 | `docs/requirements/M08.md` | `packages/ledger/src/` | `tests/unit/ledger.test.ts` | R2 | Foundation built (immutable movement ledger; balances projected from events, never overwritten; idempotent replay) |
| M08-FR-02 | 2 | `docs/requirements/M08.md` | `packages/stock/src/position.ts` | `tests/unit/stock-position.test.ts` | R2 | Foundation built (availability derived from state; reserved removed from what a walk-in can buy; quarantine/expired never sellable by any policy; in-transit visible but not available until received) |
| M08-FR-03 | 2 | `docs/requirements/M08.md` | `packages/adjustment/src/`, `packages/waste/src/` | `tests/unit/adjustment.test.ts`, `tests/unit/waste.test.ts` | R2 | Foundation built (reason-coded compensating moves; material ones need a separate approver) — negative-stock policy pending the M08 stock service |
| M08-FR-04 | 2 | `docs/requirements/M08.md` | `packages/stock/src/metrics.ts` | `tests/unit/stock-metrics.test.ts` | R2 | Foundation built (ageing buckets valued with shares; turns, annualised turns and days of cover; GMROI; stockout impact as a labelled estimate) — reconciliation via `packages/counts` (M09-FR-04); valuation method feeds M23 |
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
| M12-FR-01 | 2 | `docs/requirements/M12.md` | `apps/pos/src/session.ts`, `packages/catalogue/src/` | `tests/unit/pos-session.test.ts`, `tests/unit/pos-barcode-scan.test.ts` | R2 | Foundation built (O(1) offline scan, quantity and weighed lines, price enquiry) — customer display pending the certified hardware matrix (§33) |
| M12-FR-02 | 2 | `docs/requirements/M12.md` | `apps/pos/src/session.ts`, `packages/receipt/src/` | `tests/unit/pos-session.test.ts`, `tests/unit/receipt.test.ts` | R2 | Partial — suspend/recall and receipts (build, render, ESC/POS, audited reprint) built; quotations and delivery sales pending M18/M19 wiring |
| M12-FR-03 | 2 | `docs/requirements/M12.md` | `packages/tender/src/` | `tests/unit/tender.test.ts` | R2 | Foundation built (cash/card/UPI/store-credit split tenders must balance; a pending card tender never counts as paid) |
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
| M30-FR-01 | 2 | `docs/requirements/M30.md` | `packages/import/src/` | `tests/unit/import.test.ts` | R2 | Foundation built (validate→preview→approve→commit; atomic; 80-line invoice proven) |
| M30-FR-02 | 2 | `docs/requirements/M30.md` | `packages/export/src/` | `tests/unit/export.test.ts` | R2 | Foundation built (open CSV + schema; permission, branch scope, PII redaction; audited; round-trip proven) |
| M30-FR-03 | 2 | `docs/requirements/M30.md` | `packages/import/src/import-job.ts` | `tests/unit/import.test.ts` | R2 | Foundation built (duplicates→review, mandatory, referential integrity, control-total reconciliation) |
| M30-FR-04 | 2 | `docs/requirements/M30.md` | `packages/import/src/import-job.ts` | `tests/unit/import.test.ts` | R2 | Partial — per-row errors with line numbers and all-or-nothing commit; job history/DQ score pending persistence |
| M31-FR-01 | 2 | `docs/requirements/M31.md` | — | — | R2 | In design |
| M31-FR-02 | 2 | `docs/requirements/M31.md` | `packages/receipt/src/` | `tests/unit/receipt.test.ts` | R2 | Foundation built (receipt from committed sale, gap-free number, offline print, audited reprint) |
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
| M34-FR-01 | 2 | `docs/requirements/M34.md` | `packages/audit/src/audit-trail.ts` | `tests/unit/audit.test.ts` | R1 | Foundation built (immutable who/what/when/where/before/after; no edit/delete in the API; hash chain detects tampering; reconstruct from evidence; offline flag) |
| M34-FR-02 | 2 | `docs/requirements/M34.md` | `packages/audit/src/retention.ts` | `tests/unit/audit.test.ts` | R1 | Foundation built (search; legal hold overrides retention; statutory/no-policy never proposed; plan-not-delete; sealed evidence pack) |
| M34-FR-03 | 2 | `docs/requirements/M34.md` | `packages/compliance/src/obligations.ts` | `tests/unit/compliance-obligations.test.ts` | R1 | Foundation built (licence/certificate register; a named person is mandatory; escalating alerts that keep shouting after expiry; evidence retrievable and never deleted, only closed with a reason) |
| M34-FR-04 | 2 | `docs/requirements/M34.md` | `packages/compliance/src/risk.ts` | `tests/unit/compliance-risk.test.ts` | R1 | Foundation built (risk/control/incident/remediation/attestation registers with enforced links; open critical risk blocks its gate; acceptance needs a named author and rationale; attestation staleness) |
| M35-FR-01 | 2 | `docs/requirements/M35.md` | — | — | R1 | In design |
| M35-FR-02 | 2 | `docs/requirements/M35.md` | — | — | R1 | In design |
| M35-FR-03 | 2 | `docs/requirements/M35.md` | — | — | R1 | In design |
| M35-FR-04 | 2 | `docs/requirements/M35.md` | — | — | R1 | In design |
| M36-FR-01 | 2 | `docs/requirements/M36.md` | — | — | R8 | In design |
| M36-FR-02 | 2 | `docs/requirements/M36.md` | — | — | R8 | In design |
| M36-FR-03 | 2 | `docs/requirements/M36.md` | — | — | R8 | In design |
| M36-FR-04 | 2 | `docs/requirements/M36.md` | — | — | R8 | In design |
| _Cross-cutting sets — SEC-01…12, PRV-01…10, NFR-01…15, AI-NFR-01…12, MG-01…12 — mapped in_ `docs/requirements/cross-cutting.md` _(each tied to the guardrail/package/ADR that addresses it); verified per item at its build stage / quality gate._ | | | | | | |
