# `packages/` — the SRE Retail OS foundation

The shared, **storage-agnostic, fully-tested** building blocks (Stage 5). Every
non-negotiable rule in `CLAUDE.md` is enforced *here*, in code, so the layers above (a
database-backed persistence layer, the domain services, the apps) inherit the guarantees
instead of re-implementing them. Each package is pure domain logic — no I/O; where an engine
needs storage or a clock, it is **injected**, which is why everything is deterministic and
testable. `pnpm check` runs typecheck + lint + secret-scan + the whole suite.

> Onboarding note for the second custodian (D4, AID-10): this file is the map. Read a
> package's `README.md`, then its one source file and its test — each is small and self-
> contained. The offline-sale example below shows how they fit together.

## Layers

```
  Compositions   price-list · pricing · promotions · (real domain operations)
                 tender · sale · receiving ·
                 adjustment · counts · returns ·
                 cash · till · day-close · loyalty ·
                 reconciliation · purchasing · orders ·
                 fulfilment · customer · waste · b2b ·
                 notifications · reporting
       ▲
  Engines        ledger · approvals · rbac ·     (one invariant each)
                 sync · numbering · calendar · config ·
                 tenant · loss-prevention · price-guard ·
                 replenishment · fefo · finance · bank-controls ·
                 traceability
       ▲
  Contracts      money · quantity · rate ·       (the shared vocabulary & shapes)
                 enums · event
       ▲
  Persistence    persistence (SqlClient port ·   (durable, tenant-scoped storage
                 EventStore · OutboxStore ·       + read-model projections;
                 ConfigVersionStore · projection  in-memory ref + SQL adapter)
                 · DDL 0001-3)
```

## The packages

| Package | Concern | Key rule it enforces |
| --- | --- | --- |
| `contracts` | Value primitives & shared shapes | Exact money/quantity/rate (never a float, §29.1); de-duplicated events (§30.2/§31.1) |
| `persistence` | Durable stores + projections + Postgres | Tenant-scoped event log (append-only), retry/dead-letter sync outbox, versioned config, read-model projections; driver-agnostic `SqlClient` port + DDL 0001–3 + **`pgClient` connector** and **migration runner** (`pnpm db:migrate`) (§30.2/§31.1/§31, M01-FR-03, §29, §19, ADR-0003) |
| `ledger` | Append-only event ledger | Balances are projected from events, never overwritten (hard rule #2) |
| `approvals` | Maker-checker | The maker can never decide their own request (§28) |
| `rbac` | Access control | Default-deny; least privilege (P-04, M02-FR-02) |
| `sync` | Offline outbox | Idempotent sync; dead-letter never dropped (P-01, §31, hard rule #6) |
| `numbering` | Document numbers | Gap-free & unique per type; offline reserved ranges (M01-FR-02) |
| `calendar` | Trading-day rule | Consistent business day for close/GST (M01-FR-02, A-13) |
| `config` | Versioned config | Every change is a new version; rollback is non-destructive (M01-FR-03) |
| `tenant` | Multi-tenant entitlements | Each tenant chooses its optional modules; default-off, isolated (ADR-0003, M36) |
| `loss-prevention` | Anomaly detection | Configurable void/refund/discount/no-sale/cash rules → linked exceptions; detect-only (M15-FR-01, P-03) |
| `bank-controls` | Bank fraud controls | Bank-change verification (maker≠approver); duplicate bank-account → block payment (M06-FR-01, M15-FR-03, §28) |
| `price-guard` | Margin-floor / MRP controls | Reject above MRP; below floor/cost blocked pending a separate approver + reason (M05-FR-02, §28) |
| `replenishment` | Reorder suggestions | What/how much to reorder from parameters (reorder point/safety/max, demand×lead); advisory only, buyer approves (M09-FR-02, hard rule #5) |
| `fefo` | FEFO & expiry list | Allocate earliest-expiry first; never expired/recalled; near-expiry→markdown, expired→dispose (M10-FR-01) |
| `traceability` | Lot trace & recall | Trace a batch supplier↔customer over the ledger; recall blocks sale offline, closes with retained evidence (M10-FR-03/04) |
| `finance` | Ledger→journal posting | Mapping-driven balanced double-entry (GST included); unmapped→visible exception (M23-FR-01/02, P-08) |
| `reconciliation` | Payment reconciliation | Match tenders↔settlements by token/amount; valued exceptions; never a card PAN (M23-FR-03, hard rule #3) |
| `loyalty` | Loyalty points | Money-like append-only earn/burn/reverse; projected balance; offline cap; never negative (M17-FR-01) |
| `purchasing` | Purchase orders | Issue with a separate approver + value limit; open commitment = ordered−received−cancelled (M06-FR-02/04, §28) |
| `orders` | Order lifecycle & reservation | Auditable order state machine; reserve stock with no oversell (available-to-promise) (M18-FR-01/02, §6.2) |
| `fulfilment` | Delivery / substitution / COD | Delivery state machine + proof; customer-confirmed substitution; COD reconciliation cash/UPI only (M19-FR-01/03/04) |
| `customer` | Dedup & consent | Duplicate detection (uncertain→review, never auto-merge); consent-scoped send blocked on breach (M16-FR-01/02, PRV) |
| `waste` | Write-off | Reason-coded compensating loss; material needs a separate approver + evidence (M28-FR-01, §28) |
| `b2b` | B2B credit & commission | Credit-limit block pending approval; contract-expiry policy; exact commission (M22-FR-01/03, §28) |
| `notifications` | Consent-safe sends | Send blocked on any breach (template/suppression/consent/budget); retry + visible dead-letter (M31-FR-03/04, hard rule #6) |
| `reporting` | Owner KPIs & freshness | Exact sales/margin/basket/tender aggregation; stale/missing never shown as fresh (M29-FR-01, P-08) |
| `receipt` | Receipt build / render / print | From the committed sale; totals must balance; PAN refused; reprint stamped + reasoned; ESC/POS; printer failure never costs the sale (M31-FR-02, M12-FR-02) |
| `catalogue` | Lane catalogue, barcode scan & snapshot builder | O(1) offline lookup from a versioned snapshot; weight/price-embedded barcodes; recalled/non-sellable refused at the scan; builder resolves prices by precedence and excludes anything it can't price safely (M03, M05, M12, §31, §32) |
| `price-list` | Effective-dated prices | Resolve by precedence (customer>channel>zone>store); no early activation; append-only history (M05-FR-01, P-02) |
| `pricing` | Line & bill pricing | Exact gross/discount/net/tax/total (M12/M05/M23) |
| `promotions` | Best-price engine | Deterministic best price (BOGO/multibuy/coupon/member); no expired/unpublished; stacking/exclusion (M05-FR-03, P-02) |
| `tender` | Tender settlement | Split tenders balance; never a fake approval (M12-FR-03) |
| `sale` | Local sale commit | Commit locally first, sync idempotently (hard rule #1, M12) |
| `receiving` | Goods-receipt commit | Inbound stock to the ledger, queued for sync, idempotent (M07) |
| `adjustment` | Stock adjustment | Reason-coded compensating move; material ones need a separate approver (M08-FR-03, §28) |
| `counts` | Cycle/blind count | Blind count vs projected ledger; a variance becomes a valued, approved compensating adjustment (M09-FR-04, §28) |
| `returns` | Return & refund commit | Line returned at most once; disposition decides availability; material/no-receipt refund needs a separate approver; card/UPI reversal stays pending (M13, §28) |
| `cash` | Till cash movements | Float/loan/pickup/safe-drop as an append-only chain; one custodian per till; no overdraw (M14-FR-01) |
| `till` | Cashier shift / till close | Blind count → over/short; material variance is a reason-coded valued exception; fully offline (M14-FR-02) |
| `day-close` | Store/day close + reopen | Locks a day only once its trading-day cut-off has passed and it is fully reconciled; reopen needs a separate approver (M14-FR-04) |
| `import` | Template-driven data in | RFC-4180 parse; per-row errors with line numbers; duplicates→review (never auto-merge); control totals must reconcile; separate approver; all-or-nothing commit (M30-FR-01/03/04, §28) |
| `audit` | Audit & compliance evidence | Tamper-evident hash-chained trail with no edit/delete in the API; action reconstructable from evidence alone; retention *plans*, never deletes; legal hold beats retention (M34-FR-01/02, NFR-15, hard rule #6) |
| `export` | Domain data out | Your data is yours — open CSV + machine-readable schema; permission default-deny, branch scope enforced, PII redacted (not dropped), every export audited (M30-FR-02, NFR-12, OD-09) |

## How they compose — the offline sale

`packages/sale`'s `commitSale(input, stockLedger, outbox)` is the worked example (see
`sale/src/sale.ts`):

1. **`tender.settle`** confirms the sale is fully paid — a pending card tender does **not**
   count, so a sale can't be committed on a fake approval.
2. Stock movements are appended to the **`ledger`** (the local stock ledger) — append-only,
   so the balance is always the sum of events.
3. The sale is enqueued to the **`sync`** outbox for the cloud — the till keeps trading with
   the network cable out (hard rule #1), and the sale syncs **exactly once** later (§31.1).

Everything is exact `money`, every event carries an idempotency key, and a retried commit
collapses to one effect. That is the whole offline-first POS transaction, in tested code.

## Conventions

- **Value types export flat, operations as namespaces.** `import { Money } from
  '@sre/contracts'` for the type; `MoneyOps.add(a, b)` / `QuantityOps.add(a, b)` for the
  maths (they share operation names). `RateOps` likewise.
- **Pure + injected dependencies.** No package does I/O. Ledgers, outboxes, timestamps and
  ids are passed in — a database-backed store or a real clock slots in without touching the
  logic.
- **Tests live in `tests/`** (the repo's layout), one file per package, importing the
  specific source module.

## What builds on this next (needs the outside world)

- A **database-backed** persistence layer (the `LedgerStore`/outbox/config stores backed by
  PostgreSQL) — needs the hosting environment (ADR-0002 + the vendor pick, D3).
- The **store-specific modules** (billing, stock, pricing, GST wired to real data) — need
  the Stage 1 store facts (`docs/discovery/store-facts-questionnaire.md`, finding A-11).
