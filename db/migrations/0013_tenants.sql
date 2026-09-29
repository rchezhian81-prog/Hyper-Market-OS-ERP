-- 0013 — a tenant nobody provisioned cannot accumulate rows.
-- ADR-0003 (the tenant is the top isolation boundary) / §35 / M36 / GAP-DATA-02 (the `tenants` FK half).
--
-- Why this migration exists
-- ------------------------
-- Every tenant-scoped table carries a `tenant_id`, and since 0012 the database confines each
-- statement to one tenant's rows. But nothing said WHICH tenants exist: a token minted for a tenant
-- nobody provisioned — a mis-typed id, a misconfigured identity provider, a retired shop — would
-- create a shadow tenant on its first write, with real-looking rows nobody owns or reviews.
--
-- What this does
-- --------------
--   * `tenants` — the register of provisioned tenants: who registered it, when. Append-only in
--     spirit (a tenant is retired by a later fact, never deleted) and row-level-secured like the rest.
--   * Back-fills every tenant that already holds rows (a database initialised before this migration
--     has tenants; they were provisioned by the people who ran it, and are recorded as such).
--   * A FOREIGN KEY from every uuid-keyed tenant table to `tenants`, added NOT VALID and then
--     VALIDATED so the backfill and the constraint land in one migration without a table rewrite.
--
-- The application registers a tenant at genesis / bootstrap (`EventStore.registerTenant`); a write
-- for any other tenant is refused by the database (foreign-key violation), which the store reports
-- as `TenantNotRegisteredError` and the API as 403 `tenant_not_registered`.
--
-- `audit_log` and `projection_snapshot` key on a TEXT tenant ('unauthenticated' is a legitimate
-- audit tenant) and stay outside the FK; they are still row-level-secured by 0012.
--
-- Additive. Reversible (DROP CONSTRAINT …; the table stays). No row is changed or removed.

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id      uuid        PRIMARY KEY,
  registered_at  timestamptz NOT NULL DEFAULT now(),
  -- Who provisioned it: 'system:genesis' (BOOTSTRAP_OWNER_* at boot), the operator who ran
  -- `tenant:bootstrap`, or 'migration:0013-backfill' for tenants that pre-date this register.
  registered_by  text        NOT NULL
);

COMMENT ON TABLE tenants IS
  'The register of provisioned tenants (ADR-0003, GAP-DATA-02). Every tenant-keyed row references it; a tenant nobody registered cannot accumulate rows.';

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_tenant_isolation ON tenants;
CREATE POLICY tenants_tenant_isolation ON tenants
  USING (sre_current_tenant() = '*' OR tenant_id::text = sre_current_tenant())
  WITH CHECK (sre_current_tenant() = '*' OR tenant_id::text = sre_current_tenant());

-- Back-fill: every tenant that already holds rows anywhere was provisioned by whoever ran this database.
INSERT INTO tenants (tenant_id, registered_by)
SELECT DISTINCT tenant_id, 'migration:0013-backfill' FROM event_ledger
UNION SELECT DISTINCT tenant_id, 'migration:0013-backfill' FROM sync_outbox
UNION SELECT DISTINCT tenant_id, 'migration:0013-backfill' FROM config_versions
UNION SELECT DISTINCT tenant_id, 'migration:0013-backfill' FROM idempotency_keys
UNION SELECT DISTINCT tenant_id, 'migration:0013-backfill' FROM number_series
ON CONFLICT (tenant_id) DO NOTHING;

ALTER TABLE event_ledger     ADD CONSTRAINT event_ledger_tenant_fk     FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) NOT VALID;
ALTER TABLE event_ledger     VALIDATE CONSTRAINT event_ledger_tenant_fk;

ALTER TABLE sync_outbox      ADD CONSTRAINT sync_outbox_tenant_fk      FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) NOT VALID;
ALTER TABLE sync_outbox      VALIDATE CONSTRAINT sync_outbox_tenant_fk;

ALTER TABLE config_versions  ADD CONSTRAINT config_versions_tenant_fk  FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) NOT VALID;
ALTER TABLE config_versions  VALIDATE CONSTRAINT config_versions_tenant_fk;

ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) NOT VALID;
ALTER TABLE idempotency_keys VALIDATE CONSTRAINT idempotency_keys_tenant_fk;

ALTER TABLE number_series    ADD CONSTRAINT number_series_tenant_fk    FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) NOT VALID;
ALTER TABLE number_series    VALIDATE CONSTRAINT number_series_tenant_fk;
