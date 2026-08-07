# `db/data-dictionary/`

The canonical data model: entities, fields, types, precision, retention and audit rules.

- **Roadmap:** §29 (data model), §29.1 (money/time/precision), §31.1 (idempotency/conflict). API-01…13.
- **Relationship to architecture:** this is the **field-level expansion** of
  `../../docs/architecture/data-model.md`, for **Store-Core (R2)**.
- **Status:** **logical** dictionary — no DDL or migrations yet (those land in
  `../migrations/` from Stage 5). Types are portable/logical; the physical PostgreSQL
  schema implements them. Coding stays on HOLD until D3/D4/D5/D8 close.

## Conventions

### Standard columns (present on every table unless noted)
| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid | PK; minted at creation; **offline-safe (globally unique)** |
| `tenant_id` | uuid | **Top isolation boundary** (ADR-0003); FK → Tenant; **every record and query is tenant-scoped** |
| `company_id` | uuid | Scope within the tenant (M01-FR-01); FK → Company |
| `branch_id` | uuid null | Branch scope; null = company-wide |
| `created_at` / `updated_at` | timestamptz | **UTC** (§29.1) |
| `created_by` / `updated_by` | uuid | User ref (audit, M34) |

**Tenant isolation (ADR-0003).** SRE Retail OS is a commercial multi-tenant product: a
`tenant` is a retail business (a customer). Every table carries `tenant_id`, every query
filters by it, and **cross-tenant access is a critical security threat** (§35). SRE Hyper
Market is tenant #1. Store-specific values are **per-tenant configuration** (see
`packages/tenant` settings + `packages/config`), never hard-coded.

Mutable master records also carry `version int` and a `status` enum.

### Append-only event tables — marked **⊕**
Columns: `id`, `idempotency_key` (UQ), `source_ref`, `occurred_at timestamptz`.
**INSERT-only — no UPDATE/DELETE** (hard rule #2); a change is a new **compensating**
event. Enforced by `tests/guardrails/ledger-append-only.test.ts`.

### Types & markers
- **Money:** `<name>_minor bigint` **+** `currency char(3)` — integer **minor units**,
  never a float (§29.1).
- **Quantity:** `<name>_qty numeric` **+** `<name>_uom text`.
- **Time:** `timestamptz` stored UTC; business dating via the **trading-day rule** (M01-FR-02).
- `enum{…}` allowed values listed inline; `jsonb` for structured-but-flexible payloads.
- **Markers:** **⊕** append-only · **⟳ AVR-##** value/shape depends on a Stage 1 store
  fact · **🔒** sensitive (PII/payment — handled per `../../docs/security/threat-privacy-model.md`)
  · PK / FK / UQ / IDX for keys.

## Domain files
| File | Domain | Modules |
| --- | --- | --- |
| `identity-platform.md` | Identity & Platform | M01–M02, M32–M35 |
| `catalogue-pricing.md` | Catalogue & Pricing | M03–M05 |
| `inventory.md` | Inventory | M08–M11 |
| `purchase-supplier.md` | Purchase & Supplier | M06–M07, M30 |
| `pos-cash.md` | POS & Cash | M12–M15 |
| `finance.md` | Finance | M23 |

## Reporting / BI (M29)
Reporting owns **no source tables** — it reads **projections / read models** built from
domain events, each carrying a **freshness watermark** (P-08). Projections are derived and
rebuildable, so they are documented with their source events, not here as master data.

## Deferred
Customer/loyalty (M16–M17), OMS (M18), fulfilment (M19), CRM (M21) and B2B (M22) entities
are expanded when their release (R4–R5) is reached — not invented ahead of the roadmap.
