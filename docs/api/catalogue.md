# SRE Retail OS — API & event catalogue (Stage 4)

- **Roadmap:** §30 (API design), §30.2 (domain events), §31 (offline/sync). **API-01…API-13.** Principle **P-06** (open & portable). Contracts live in `../../packages/contracts/`.
- **Purpose:** The versioned contract surface between clients, edge and cloud, and the durable business events that are the integration backbone. **Store-Core (R2)** domains are detailed; later domains are named and expanded at their release.

> No endpoint code or OpenAPI/event schemas yet — those are produced per domain from
> Stage 5. This catalogue fixes the conventions and the domain/event map.

## 1. Conventions — all APIs
- **Versioned (P-06):** major version in the path (`/v1/…`); additive-only within a major;
  a breaking change is a new major with a deprecation window.
- **Auth:** OAuth2/OIDC bearer tokens issued by Identity (API-01); every request carries
  **company/branch scope**; least privilege (SEC); **no shared logins** (hard rule #4).
- **Idempotency (§31.1):** every write accepts an **`Idempotency-Key`**; safe replay
  returns the same result — **mandatory** for edge→cloud sync so a resent sale or movement
  applies once.
- **Errors:** structured, typed errors carrying the §27.1 three-part content — *what
  happened · whether data was saved · the next safe action*.
- **Pagination/filtering:** cursor pagination; filter by company/branch/warehouse/dept.
- **Events (§30.2):** state changes publish **durable domain events** to the broker
  (at-least-once, **idempotent consumers**, retry + **dead-letter**). Events — not
  synchronous call chains — are how domains integrate.
- **Audit/observability:** every write is audited (M34) and traceable (NFR-15).
- **No card data (hard rule #3):** no PAN/CVV/expiry crosses any API — provider tokens
  and refs only.

## 2. API domains (API-01…API-13)

| API | Domain | Modules | Key resources | Release |
| --- | --- | --- | --- | --- |
| API-01 | Identity / Admin | M01–M02 | orgs, branches, users, roles, approvals, config, number series | R1 |
| API-02 | Catalogue | M03–M05 | products, barcodes, prices, promotions, tax classes | R2 |
| API-03 | Purchase | M06–M07, M30 | suppliers, POs, GRNs, invoices, matches | R2 |
| API-04 | Inventory | M08–M11 | movements (append), availability, batches, adjustments, counts | R2 |
| API-05 | POS | M12–M15 | sales, tenders, refunds, till sessions | R2 |
| API-06 | Customer / Loyalty | M16–M17, M21 | customers, consent, points, cases | R4 |
| API-07 | OMS | M18 | orders, reservations, routing | R5 |
| API-08 | Fulfilment / Delivery | M19 | picks, packs, routes, proof | R5 |
| API-09 | Finance | M23 | journals, AP/AR, reconciliation, period close, Tally | R2 |
| API-10 | Reporting | M29 | read models / KPIs (read-only, freshness) | R2 |
| API-11 | Platform | M32–M35 | flags, jobs, devices, support access, audit, backup/health | R1 |
| API-12 | Migration | MG-01–MG-12 | staging, mapping, exceptions, reconciliation | R3 |
| API-13 | AI | A01–A10 | agent runs, evidence, budget, kill switch | R7 |

## 3. Core Store-Core flows (illustrative)
- **POS sale (API-05, edge-first):** commit locally → queue in the outbox → on sync
  `POST /v1/sales` with an `Idempotency-Key` → `SaleCommitted`. Tender emits
  `TenderAuthorized` / `TenderUncertain` / `TenderSettled`. **Never blocks on the network**
  (hard rule #1); **never carries a card number** (hard rule #3).
- **Stock movement (API-04):** `POST /v1/inventory/movements` **appends** an event →
  `InventoryMoved`; balance is projected; replay is safe. Adjustments →
  `InventoryAdjusted` (reason-coded, approved).
- **Price change (API-02):** draft → **approve (separate approver)** → effective-dated
  publish into the signed edge price pack.
- **Finance reconciliation (API-09):** import bank/gateway statements → match →
  `ReconciliationExceptionRaised` / `…Resolved`; **period close is blocked until control
  totals validate** (QG-07) → `PeriodClosed` / `PeriodReopened`.

## 4. Named domain events (§30.2, confirmed in Store-Core specs)
`SaleCommitted` · `TenderAuthorized` / `TenderUncertain` / `TenderSettled` ·
`InventoryMoved` · `InventoryAdjusted` · `ReconciliationExceptionRaised` /
`ReconciliationExceptionResolved` · `PeriodClosed` / `PeriodReopened`.
*(Additional events are defined per module as each is expanded — this list grows with the
build; it is not invented ahead of the roadmap.)*

## 5. Contracts & portability (P-06)
- Contracts are **versioned schemas** in `packages/contracts/` (request/response + event
  payloads), the single source both edge and cloud build against.
- Documented data models and **exports** for portability; a **connector SDK** (M32) wraps
  Tally, payment providers, GST, messaging (WhatsApp), logistics and hardware behind
  versioned, idempotent adapters with retry + dead-letter.

## 6. Deferred
Full endpoint specs and OpenAPI/event schemas are produced per domain as each release is
built. R4/R5/R7 domains (Customer/CRM, OMS/Fulfilment, AI) are named at family level here
and expanded when their release is reached.
