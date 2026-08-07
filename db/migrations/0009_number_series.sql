-- 0009_number_series.sql
-- Gap-free document number series (M01-FR-02) — receipt, invoice, PO, GRN, statement
-- numbers must be gap-free and unique per (tenant, document type). Multi-tenant
-- (ADR-0003): the series is per (tenant, doc_type). Baseline §19: PostgreSQL. Forward-only.
--
-- This is a COUNTER, not a ledger. Unlike event_ledger / config_versions / audit_log
-- (which are append-only and guarded by 0004 against UPDATE/DELETE), a number series is
-- authoritative STATE: `next_seq` advances by exactly one per allocation. It is therefore
-- deliberately mutable and intentionally NOT append-only-guarded — the same distinction
-- the sync_outbox and idempotency_keys tables rest on.
--
-- Gap-free under concurrency comes from the atomic allocation the store performs:
--   INSERT ... VALUES (t, d, 2) ON CONFLICT (tenant_id, doc_type)
--   DO UPDATE SET next_seq = number_series.next_seq + 1 RETURNING next_seq - 1 AS seq
-- The ON CONFLICT UPDATE takes a row lock, so two concurrent allocations serialize on the
-- row and can neither collide on a number nor leave a gap. The allocated number then
-- becomes an immutable fact on the document it numbers (in the append-only event ledger).

CREATE TABLE IF NOT EXISTS number_series (
  tenant_id  uuid        NOT NULL,
  -- e.g. 'receipt', 'invoice', 'po', 'grn', 'statement'.
  doc_type   text        NOT NULL,
  -- The NEXT sequence number that would be allocated (>= 1). Advances by one per allocation.
  next_seq   bigint      NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT number_series_pk PRIMARY KEY (tenant_id, doc_type),
  CONSTRAINT number_series_next_ck CHECK (next_seq >= 1)
);
