# `packages/persistence/`

The durable persistence layer — scaffolding. Turns the in-memory stores the domain engines
use into a **portable, testable** persistence contract backed by SQL (§19 baseline: PostgreSQL),
**without requiring a live database** to build or test.

## The write path (offline-first, P-01)

```
  POS / edge engine ──commit──▶ sync LedgerStore (in-memory projection)   ← hot path, no network
          │                     + SyncOutbox (queued for cloud)
          │
          ▼ (write-through / on sync)
   EventStore.append(tenantId, stream, event)   ← DURABLE append-only log
          │                                        embedded SQL at the edge,
          ▼                                        PostgreSQL in the cloud
   event_ledger table (migration 0001) ──projected──▶ read models (reporting)
```

The domain hot path stays **synchronous** (a sale never awaits I/O — hard rule #1). This
`EventStore` is the **async durable log** that events are written through and that the sync
agent drains into.

## What's here

- **`src/sql-client.ts`** — `SqlClient`, the **driver-agnostic** port (parameterised `query`).
  The adapters depend only on this, so nothing here imports a concrete driver (P-06).
- **`src/event-store.ts`** — the `EventStore` contract (async, **tenant-scoped**, append-only):
  - `InMemoryEventStore` — the **reference implementation** and the behavioural contract every
    store must satisfy (used in tests and at the edge before a durable store is wired).
  - `SqlEventStore` — backed by `event_ledger` (migration 0001) via `SqlClient`. Append uses
    `INSERT … ON CONFLICT DO NOTHING` (never `DO UPDATE` — the ledger is append-only) and reads
    back on conflict, so a replay is idempotent (§31.1).
- **`db/migrations/0001_event_ledger.sql`** — the append-only `event_ledger` table: tenant-scoped,
  idempotency unique **per tenant** (never cross-tenant, ADR-0003 / §35), INSERT-only.

## Guarantees (tested)

- **Idempotent append** — a replay of the same `(tenantId, idempotencyKey)` returns the existing
  row, never a second effect (§31.1).
- **Tenant isolation** — the same idempotency key under two tenants is **two distinct events**;
  a read for one tenant never sees another's (ADR-0003 / §35).
- **Append-only** — the store exposes **no** update/delete (hard rule #2); a correction is a new
  compensating event.

## The PostgreSQL connector & migration runner (built)

- **`src/pg-client.ts`** — `pgClient(pool)` adapts a node-postgres `Pool`/`PoolClient` to
  `SqlClient`. It is written against a **structural** `PgQueryable` interface, so this package
  never imports `pg` and stays portable; the deployment creates the real pool:

  ```ts
  import { Pool } from 'pg';
  import { pgClient, SqlEventStore } from '@sre/persistence';
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const events = new SqlEventStore(pgClient(pool));   // now durable on PostgreSQL
  ```

- **`src/migrations.ts`** — `runMigrations(client, migrations)` applies ordered forward-only
  migrations against any `SqlClient`, tracking them in a `schema_migrations` table so it is
  **idempotent** (a re-run applies nothing new). Unit-tested.
- **`scripts/migrate.mjs`** — the runnable CLI (loads `pg` at runtime): reads `db/migrations/`
  and applies pending scripts against `DATABASE_URL`.

  ```
  DATABASE_URL=…  pnpm db:migrate
  ```

## Remaining deployment steps (need a live database)

1. Provision a PostgreSQL instance and set `DATABASE_URL`, then run `pnpm db:migrate`.
2. Configure the driver to return `timestamptz` as ISO-8601 strings (or the store coerces a
   `Date` for you).
3. Harden the ledger at the database — revoke the app role's mutation privileges on
   `event_ledger` (defence-in-depth on top of the code guardrail
   `tests/guardrails/ledger-append-only`).

Tested in `tests/unit/persistence-event-store.test.ts`. Part of the repository layout in
`CLAUDE.md`.
