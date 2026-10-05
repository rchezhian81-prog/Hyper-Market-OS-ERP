-- 0014 — write guards: an expected-version compare-and-append per business key (Wave 2a · audit PF-01,
-- SF-04, FUL-02, PA-11 · hard rule #10 · P-08).
--
-- The event ledger is append-only and idempotent, but idempotency alone does not stop two DIFFERENT
-- requests — two refunds of the same sale with two different ids, two transfers out of the same stock,
-- two reservations of the last unit — from each reading the same balance and each appending. The
-- independent audit of 4 October 2026 reproduced exactly that (PF-01: "concurrent distinct requests
-- spend/refund the same remaining balance twice").
--
-- The guard is one row per (tenant, key): a version the writer read before it decided, and must still
-- hold when it writes. A guarded append runs in ONE transaction: `UPDATE … SET version = version + 1
-- WHERE version = $expected` takes the row lock, so two competing writers serialise on it; the second
-- re-evaluates the WHERE after the first commits, finds the version moved, updates nothing, and its
-- whole batch rolls back. One succeeds, the other becomes a NAMED conflict — never silent last-write-wins.
--
-- The key is the business thing being spent: 'refund:<saleId>', 'stock:<location>:<product>',
-- 'reservation:<location>:<product>', 'audit-chain'. Versions only ever rise (append-only in spirit:
-- no row is deleted; the ledger itself still holds every event). Forward-only migration.

CREATE TABLE IF NOT EXISTS write_guards (
  tenant_id   uuid        NOT NULL,
  key         text        NOT NULL,
  version     bigint      NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT write_guards_pk PRIMARY KEY (tenant_id, key),
  CONSTRAINT write_guards_version_ck CHECK (version >= 0)
);

COMMENT ON TABLE write_guards IS
  'Expected-version guards for compare-and-append per business key (Wave 2a): a guarded ledger append bumps the key''s version in the same transaction and fails by name when the version it read has moved.';

-- Tenant isolation, as every tenant-scoped table (migration 0012): the policy binds the owner too.
ALTER TABLE write_guards ENABLE ROW LEVEL SECURITY;
ALTER TABLE write_guards FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS write_guards_tenant_isolation ON write_guards;
CREATE POLICY write_guards_tenant_isolation ON write_guards
  USING (sre_current_tenant() = '*' OR tenant_id::text = sre_current_tenant())
  WITH CHECK (sre_current_tenant() = '*' OR tenant_id::text = sre_current_tenant());

-- A guard row belongs to a registered tenant (migration 0013), like every other tenant-scoped row. The table is new
-- and empty, so the constraint is validated at once (0013's were added NOT VALID over existing rows and validated after).
ALTER TABLE write_guards ADD CONSTRAINT write_guards_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id);
