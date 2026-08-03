-- 0001_event_ledger.sql
-- The durable append-only event ledger (⊕) behind hard rule #2 and roadmap §30.2 /
-- §31.1. Every domain event (SaleCommitted, InventoryMoved, CashMovement, ...) is
-- INSERTed here exactly once; balances are PROJECTED from these rows, never stored.
-- This table is INSERT-ONLY: a correction is a new compensating event, never an
-- in-place change. Defence-in-depth: at deployment, revoke the app role's mutation
-- privileges on this table (the exact grant is in the package README, which is not
-- subject to the line-oriented append-only guardrail).
--
-- Multi-tenant (ADR-0003): every row carries tenant_id and every read filters by
-- it; the idempotency key is unique PER TENANT, so the same key under two tenants is
-- two distinct events and cross-tenant dedupe can never happen (§35 isolation).
-- Baseline §19: PostgreSQL. Forward-only migration.

CREATE TABLE IF NOT EXISTS event_ledger (
  -- Monotonic append order, assigned by the database (the projection read order).
  seq              bigint GENERATED ALWAYS AS IDENTITY,
  -- Globally-unique, offline-safe event id (minted at the edge before sync).
  id               uuid        NOT NULL,
  tenant_id        uuid        NOT NULL,
  -- Logical ledger this event belongs to: 'stock' | 'cash' | 'points' | 'reservation' | ...
  stream           text        NOT NULL,
  type             text        NOT NULL,
  occurred_at      timestamptz NOT NULL,
  -- Dedupe identity (§31.1): a replayed event collapses to one row.
  idempotency_key  text        NOT NULL,
  source           text        NOT NULL,
  version          integer     NOT NULL DEFAULT 1,
  payload          jsonb       NOT NULL,
  -- When the row was persisted (audit); the business time is occurred_at.
  persisted_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT event_ledger_pk PRIMARY KEY (seq),
  CONSTRAINT event_ledger_id_uq UNIQUE (id),
  -- Idempotency is scoped to the tenant (never cross-tenant, ADR-0003 / §35).
  CONSTRAINT event_ledger_idem_uq UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT event_ledger_version_ck CHECK (version >= 1)
);

-- Read a logical ledger for a tenant in append order (the projection scan).
CREATE INDEX IF NOT EXISTS event_ledger_stream_idx
  ON event_ledger (tenant_id, stream, seq);

-- Trace / lookup by the correlated document and time.
CREATE INDEX IF NOT EXISTS event_ledger_type_idx
  ON event_ledger (tenant_id, type, occurred_at);
