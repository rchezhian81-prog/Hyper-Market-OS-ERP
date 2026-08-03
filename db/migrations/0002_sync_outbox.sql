-- 0002_sync_outbox.sql
-- The durable store-edge → cloud sync outbox behind P-01 (offline first) and §31: a
-- locally-committed event is enqueued here, the sync agent drains pending rows to the
-- cloud and acknowledges each, and an item that repeatedly fails to apply moves to a
-- VISIBLE dead-letter state and is NEVER removed (hard rule #6). Unlike event_ledger
-- this is a MUTABLE working table (state/attempts advance as an item syncs) — it is
-- not a ledger, so it is not append-only; the events it carries are the append-only
-- record. Multi-tenant (ADR-0003): keyed per tenant. Baseline §19: PostgreSQL.

CREATE TABLE IF NOT EXISTS sync_outbox (
  tenant_id     uuid        NOT NULL,
  -- The event's idempotency key — the dedupe identity in the outbox (§31.1).
  idem_key      text        NOT NULL,
  event         jsonb       NOT NULL,
  -- 'pending' | 'acknowledged' | 'dead_letter'
  state         text        NOT NULL DEFAULT 'pending',
  attempts      integer     NOT NULL DEFAULT 0,
  reason        text        NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sync_outbox_pk PRIMARY KEY (tenant_id, idem_key),
  CONSTRAINT sync_outbox_state_ck CHECK (state IN ('pending', 'acknowledged', 'dead_letter')),
  CONSTRAINT sync_outbox_attempts_ck CHECK (attempts >= 0)
);

-- Drain the pending queue for a tenant in enqueue order.
CREATE INDEX IF NOT EXISTS sync_outbox_pending_idx
  ON sync_outbox (tenant_id, created_at)
  WHERE state = 'pending';

-- The visible dead-letter queue (poison items, never dropped).
CREATE INDEX IF NOT EXISTS sync_outbox_dead_idx
  ON sync_outbox (tenant_id)
  WHERE state = 'dead_letter';
