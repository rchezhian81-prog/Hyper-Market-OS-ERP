-- 0005 — event ids are domain-supplied text, unique PER TENANT.
-- ADR-0003 (tenant is the top isolation boundary) / §30.2 (event envelope) /
-- M36 (multi-tenant platform).
--
-- Why this migration exists
-- ------------------------
-- The Stage 6 vertical slice ran the real POS, sync agent and event store against a
-- real PostgreSQL for the first time, and the very first sale failed to sync:
--
--     invalid input syntax for type uuid: "evt-S-OFFLINE-1"
--
-- `event_ledger.id` was declared `uuid`, but a `DomainEvent` carries a readable,
-- domain-supplied identifier derived from the document it belongs to. The unit tests
-- for `SqlEventStore` used a fake SQL client that accepted any string, so nothing
-- caught it. Only real engines against a real database could.
--
-- Fixing the type exposed the more serious problem underneath it
-- -------------------------------------------------------------
-- The old constraint was `UNIQUE (id)` — GLOBAL across every tenant. With
-- domain-supplied ids that is a cross-tenant collision waiting to happen: two shops
-- both minting `evt-S-1` from their own gap-free numbering would collide, and the
-- second tenant's sale would be silently rejected by the first tenant's data.
--
-- In a multi-tenant product the uniqueness boundary is the tenant, always
-- (ADR-0003). So:
--
--   * `id` becomes `text` — matching what the domain actually produces, and keeping
--     ids readable, which matters at 9pm when someone is tracing one sale;
--   * uniqueness becomes `UNIQUE (tenant_id, id)`, the correct boundary. The
--     idempotency constraint was already tenant-scoped and is unchanged.
--
-- Safe and reversible: `text` accepts every value a `uuid` column already held, so
-- existing rows convert without loss. Additive in effect — no row is read, written
-- or removed, and the append-only guards from 0004 remain in force.

ALTER TABLE event_ledger
  ALTER COLUMN id TYPE text USING id::text;

ALTER TABLE event_ledger
  DROP CONSTRAINT IF EXISTS event_ledger_id_uq;

ALTER TABLE event_ledger
  ADD CONSTRAINT event_ledger_id_uq UNIQUE (tenant_id, id);

COMMENT ON COLUMN event_ledger.id IS
  'Domain-supplied event identifier (§30.2). Text, not uuid: readable ids matter when tracing one sale. Unique per tenant, never globally (ADR-0003).';
