# SRE Retail OS — Data model (Stage 4)

- **Roadmap:** §29 (data model), §29.1 (money / time / precision), §31.1 (conflict & idempotency). Principle **P-02** (one commerce truth); **hard rule #2** (append-only ledgers), **#3** (no card data), **#6** (never delete audit/DLQ/exceptions), **#10** (conflicts are exceptions).
- **Purpose:** The authoritative logical shape of the **Store-Core (R2)** data and the rules every table obeys. The physical PostgreSQL schema, migrations and data dictionary (`../../db/`) implement this from Stage 5.

> Logical model only — no DDL yet. Store facts (`⟳ AVR-##`) are confirmed in Stage 1, not
> guessed. Later-release domains (R4–R5) are named at family level, not detailed here.

## 1. Modelling rules — apply to every entity

| Rule | Detail |
| --- | --- |
| **Global id** | Every business record has a globally unique id (UUID/ULID) minted at creation, valid **offline**, stable across sync — so edge-minted records merge without collision. |
| **Document numbers** | Human-facing numbers (receipt/invoice/PO/GRN) come from **gap-free per-type series** (M01-FR-02); offline lanes use **reserved ranges** to avoid duplicates. |
| **Money (§29.1)** | Stored as integer **minor units + explicit currency code**; never a float; fixed precision per currency. |
| **Quantity** | Always carries a **UOM**; weight precision is UOM-aware. |
| **Time (§29.1)** | Stored **UTC**; presented in store time zone; business dating uses the **trading-day rule** (M01-FR-02). |
| **Append-only ledgers (#2)** | Ledger / movement / journal / audit tables are **INSERT-only**; balances are **projected** from events, never stored-and-overwritten; a correction is a **compensating event**. Enforced by `tests/guardrails/ledger-append-only.test.ts`. |
| **Idempotency (§31.1)** | Every event/command carries an **idempotency id** and a source reference; replay collapses to one effect; conflicts become **exceptions**, never last-write-wins (#10). |
| **No hard delete** | Records are versioned/statused, not destroyed, where history matters; **audit, dead-letter and migration-exception rows are never deleted** (#6). |
| **Scope** | Every record carries **company/branch** scope for RBAC and reporting (M01-FR-01). |
| **No card data (#3)** | Payment records store **provider token + last-4 + status only** — never PAN, CVV or expiry. Enforced by `card-data.test.ts`. |

## 2. Core domains & key entities (Store-Core R2)

### Identity & Platform (M01–M02, M33–M35)
`Company`, `GstRegistration`, `Branch/Store`, `Warehouse`, `Department` (governed
hierarchy, M01-FR-01) · `User`, `Role`, `Permission`, `ApprovalRequest` (maker-checker,
M02) · `ConfigVersion`, `FeatureFlag`, `NumberSeries`, `DocumentTemplate` (versioned,
rollback, M01-FR-02/03) · `AuditEvent` **(append-only:** who/what/when/where/before/after,
M34-FR-01) · `BackupRun`, `HealthMetric` (M35).

### Catalogue & Pricing (M03–M05)
`Product` (+ `Barcode` incl. variable-weight, `PackHierarchy` unit/inner/case/pallet,
`Attribute`/allergen/nutrition/origin, `TaxClass`/HSN, regulated flag, **recall block**)
· `PriceVersion` (effective-dated, **approved**, never overwritten) · `Promotion` (rules,
guardrails, start/end) · `CompletenessScore` (D01).

### Inventory (M08–M11)
`StockMovement` **(append-only event:** qty, sign, location, batch, reason, source ref,
idempotency id — M08-FR-01) · `Batch/Lot` (expiry, cold-chain) · `Bin/Location` ·
`StockStateProjection` (on-hand / available / reserved / quarantine / damaged / expired /
in-transit — M08-FR-02; **availability = on-hand − reserved − quarantine − damaged −
expired**) · `Adjustment` (reason-coded **compensating** event, approved — M08-FR-03).

### Purchase & Supplier (M06–M07, M30)
`Supplier` (+ **bank-change verification**, M06-FR-01) · `Requisition`, `Rfq`, `Quotation`
· `PurchaseOrder` · `Grn` (receipt event) · `SupplierInvoice` (**bulk import**, three-way
**PO-GRN-invoice match**, M07-FR-04 / M30-FR-01).

### POS & Cash (M12–M15)
`Sale` **(immutable, globally unique id** — M12-FR-03), `SaleLine` · `Tender` (**token/ref
+ status:** pending / authorized / settled — never PAN) · `Refund`/`Exchange` (M13) ·
`TillSession` (float / pickup / safe-drop / **close** aligned to trading day — M14) ·
`SuspendedBill` (durable locally).

### Finance (M23)
`LedgerAccount` (chart), `LedgerMapping` · `Journal` **(append-only posting;** finance
reads the operational ledger and posts, never edits it — M23-FR-01) · `ApArItem` ·
`ReconciliationItem` (matched / **exception with value**) · `TallyOutboxItem` (+
**dead-letter**, M23-FR-04) · `Period` (open / **closed** — reopen only with approval) ·
`ControlTotal` (**signed before close**, QG-07).

## 3. Cross-domain invariants (P-02, "one commerce truth")
- One shared identity for product, price, stock, customer and order across all channels.
- **Reserved online stock is not sellable to a walk-in** (no oversell, M08-FR-02 / §6.2).
- Balances (stock, cash, points) are **projections from the event log** — the log is the
  truth; a screen never holds a number the events can't reconstruct (NFR-15).

## 4. Read models & projections (Reporting, M29)
Reporting/BI reads from **projections / read models** built from domain events, never by
mutating a source ledger. Each projection carries a **freshness/watermark** so nothing
stale is shown as live (P-08).

## 5. The edge copy (offline)
Each store edge holds a **signed, versioned cache** of config/product/price/tax + a local
transaction store + the **outbox**. Because ids are global and events are idempotent,
edge-minted records (sales, movements) merge cleanly on sync. Full protocol in
`offline-sync.md`.

## 6. Deferred (named, not invented)
Customer/consent/loyalty (M16–M17), OMS/order/reservation (M18), fulfilment/delivery
(M19), CRM/case (M21) and B2B (M22) entities are named at family level and expanded when
their release (R4–R5) is reached, per the roadmap sequence.
