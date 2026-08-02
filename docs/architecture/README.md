# SRE Retail OS — Architecture overview (Stage 4)

- **Roadmap:** §19 (technology baseline), §29 (data model), §30 (APIs/events), §31 (offline/sync), §34 (migration), §35 (security/privacy). Principles **P-01…P-08**.
- **Purpose:** How the pieces fit so the store keeps trading with no internet (P-01) while the cloud holds one commerce truth (P-02). This overview is the Stage 4 map; the data model, API catalogue, offline-sync and threat-model docs detail each part. It **applies** the §19 baseline fixed in `../adr/0001-baseline-decisions.md` — no substitution (any would need a new ADR).

> No application code yet (coding is on HOLD until D3/D4/D5/D8 close). Stage 4 produces
> the design that the build implements from Stage 5 onward.

## 1. The three planes

```
  CLIENTS                         CLOUD (central truth, P-02)
  ┌───────────────┐              ┌──────────────────────────────────────┐
  │ POS (PWA)     │  edge-first  │ Domain services (bounded contexts)    │
  │ Owner app     │◄────────────►│ PostgreSQL + Redis · object storage   │
  │ Manager app   │   HTTPS/API  │ Durable message broker (§30.2 events) │
  │ Customer app  │              │ AI model gateway · Identity/RBAC      │
  │ Picker/Deliv. │              │ ERP/Admin SSR web · Reporting/BI      │
  │ Web store     │              └──────────────▲───────────────────────┘
  └──────▲────────┘                             │ idempotent sync
         │ LAN (no cloud round-trip, hard rule #1)   (outbox/inbox)
  ┌──────┴───────────────────────────────────┐ │
  │ STORE EDGE (in each store)                ├─┘
  │ Containerised local services + local DB   │
  │ LAN-first POS · signed config/price cache │
  │ durable outbox · idempotent sync agent    │
  └───────────────────────────────────────────┘
```

- **Store edge** — containerised local services and a local relational database in each
  store. Serves the LAN-first POS path, holds a **signed, versioned cache** of
  config/product/price/tax/stock, keeps the durable **outbox**, and syncs idempotently to
  cloud. The store trades with the internet cut (P-01, hard rule #1).
- **Cloud** — the modular **domain services** (one bounded context per domain family),
  PostgreSQL + Redis, object storage for documents, the durable broker, the AI model
  gateway, Identity/RBAC, and the ERP/Admin SSR web app. System of record and the "one
  commerce truth" (P-02).
- **Clients** — POS (desktop/PWA, edge-first), owner/manager/customer/picker/delivery
  apps (cross-platform, must run on a low-spec Android), and the customer web store.

## 2. Container view (§19 baseline realized)

| Plane | Container | Baseline (§19) | Responsibility |
| --- | --- | --- | --- |
| Client | POS shell | Desktop/PWA | Sub-second scan; offline core sale; talks to the edge, not cloud |
| Client | Role & customer apps | Cross-platform, low-spec Android | Manager/owner/picker/delivery/customer surfaces (Stage 3 specs) |
| Client | ERP/Admin web | TypeScript + SSR framework | Back-office, config, approvals |
| Edge | Local services + DB | Containers + local relational DB | LAN-first sale, cache, outbox, sync agent |
| Cloud | Domain services | Modular domain services | Business logic per bounded context |
| Cloud | Data | PostgreSQL + Redis + object storage | Records, cache/projections, documents |
| Cloud | Broker | Durable broker (idempotency/retry/DLQ) | §30.2 domain events; integration backbone |
| Cloud | AI gateway | Central model gateway | Scoped tools, evidence, budget, kill switch |
| Delivery | Platform | Containers + IaC + CI/CD | Build, deploy, environments |

## 3. Domain services (bounded contexts → API-01…13)

Only **Store-Core (R2)** contexts are detailed in Stage 4; the rest are named at family
level and expanded when their release is reached — nothing invented ahead of the roadmap.

| Service (context) | Modules | API | Owns (data) | Release |
| --- | --- | --- | --- | --- |
| Identity & Platform | M01–M02, M32–M35 | API-01/11 | orgs, users, roles, config, audit, health | R1 |
| Catalogue & Pricing | M03–M05 | API-02 | product, price, promotion, tax class | R2 |
| Purchase & Supplier | M06–M07, M30 | API-03 | supplier, PO, GRN, invoice | R2 |
| Inventory | M08–M11 | API-04 | stock ledger (append-only), batches, bins | R2 |
| POS & Cash | M12–M15 | API-05 | sale, tender, refund, till session | R2 |
| Finance | M23 | API-09 | ledger mapping, journals, reconciliation | R2 |
| Reporting / BI | M29 | API-10 | read models / projections (read-only) | R2 |
| Customer & Loyalty / CRM | M16–M17, M21 | API-06 | customer, consent, points, cases | R4 |
| OMS & Fulfilment | M18–M19 | API-07/08 | order, reservation, pick, delivery | R5 |
| Migration | MG-01–MG-12 | API-12 | staging, mapping, exceptions | R3 |
| AI gateway | A01–A10 | API-13 | agent registry, runs, budgets, kill switch | R7 |

Contexts are logical bounded contexts with versioned contracts; the physical deployment
topology (modular monolith first, splittable later) is an infrastructure choice made in
Stage 5 within the §19 baseline — a commitment that deviates would be recorded as an ADR.

## 4. Principles → architecture

| Principle | Structural mechanism |
| --- | --- |
| P-01 Offline first | Edge plane; LAN-first POS; signed cache; durable outbox; idempotent sync |
| P-02 One commerce truth | Shared product/price/stock/customer/order identity; events as the single log |
| P-03 Control by exception | Exceptions/approvals are first-class records and events surfaced to role surfaces |
| P-04 Secure by design | Identity/RBAC on every call; encryption; tokenized payments; least privilege |
| P-05 Human-governed AI | AI gateway drafts; deterministic rules/humans commit; agents never write the DB |
| P-06 Open & portable | Versioned APIs/contracts; documented data model; exports; connector SDK |
| P-07 Usability by role | Role apps, each the simplest surface its role needs (Stage 3 specs) |
| P-08 No silent failure | Sync-lag/freshness/unsent counts visible; conflicts and DLQ are visible exceptions |

## 5. Cross-cutting concerns

- **Identity & RBAC (M01/M02):** every call scoped to company/branch; maker-checker and
  separation of duties; **no shared logins** (hard rule #4).
- **Messaging (§30.2):** durable broker; idempotency keys; retry with **dead-letter that
  is never dropped** (hard rule #6); consumers idempotent.
- **AI gateway (A01–A10):** scoped tools, evidence + confidence, budget cap, kill switch;
  **never writes the database, never commits a critical change** (hard rule #5) — enforced
  by `tests/guardrails/ai-agent-db-write.test.ts`.
- **Observability (M35):** metrics/logs/traces, sync-lag and health; every state
  reconstructable from immutable events without a screen (NFR-15).
- **Time & money (§29.1):** timestamps UTC-stored / store-tz-presented; the trading-day
  rule (M01-FR-02) governs day close, reporting and GST periods; money is explicit
  currency + fixed precision, never a float.

## 6. Sibling Stage 4 documents
- `data-model.md` — §29 logical data model and the rules every entity obeys.
- `../api/catalogue.md` — §30 API and event catalogue.
- `offline-sync.md` — §31 offline-first and sync design (the P-01 detail).
- `../security/threat-privacy-model.md` — §35 threat and privacy model.
- `../cutover/migration-design.md` — §34 migration/cutover design.
