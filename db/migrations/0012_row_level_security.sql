-- 0012 — tenant isolation enforced in the DATABASE, not only in application code.
-- ADR-0003 (the tenant is the top isolation boundary) / §35 / OB-01 / SEC-12 / GAP-DATA-02.
--
-- Why this migration exists
-- ------------------------
-- Every tenant-scoped query the application runs carries `WHERE tenant_id = $1`, and the
-- kernel's outbound scan refuses a reply that names a foreign tenant. Both are application
-- code. A missing filter in one new adapter, a report that joins two tables and forgets the
-- predicate on one of them, a support engineer's ad-hoc query — none of these are caught by
-- anything the database itself enforces. The August audit called this GAP-DATA-02: "isolation
-- is application-level only (defence rests on the one backstop)".
--
-- What this does
-- --------------
-- Row-level security on every tenant-scoped table, keyed on a per-TRANSACTION setting
-- `app.tenant_id` that the application sets from the SIGNED token's tenant and nothing else:
--
--   * unset      → NO rows are visible and NO row can be written (fail closed);
--   * a tenant   → only that tenant's rows, for reads AND writes (WITH CHECK refuses an
--                  insert or update that names another tenant);
--   * '*'        → the PLATFORM scope: every row. Reserved for the operator tools that must see
--                  the whole database — backup, restore verification, migration load — set
--                  explicitly by a named person, never by the API.
--
-- `FORCE ROW LEVEL SECURITY` makes the policies bind the table OWNER too, which is the role the
-- application connects as. Without FORCE, RLS would protect against every role except the one
-- that matters.
--
-- What this does NOT claim
-- -----------------------
-- A superuser, or the owner running `ALTER TABLE … NO FORCE`, can step around it — visibly,
-- deliberately, in the log. This is defence in depth on top of the application filter, not a
-- replacement for it: the application still binds `tenant_id` in every statement, and now the
-- database refuses the statement that forgot to.
--
-- Additive and reversible (ALTER … DISABLE ROW LEVEL SECURITY; DROP POLICY). No data is read,
-- written or transformed. `schema_migrations` carries no tenant and is untouched.

-- The current tenant scope, as text, or NULL when unset (`missing_ok = true` never raises).
CREATE OR REPLACE FUNCTION sre_current_tenant() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')
$$;

COMMENT ON FUNCTION sre_current_tenant() IS
  'The per-transaction tenant scope (app.tenant_id) RLS policies bind to; ''*'' is the platform scope for operator tools; NULL means nothing is visible.';

-- One policy shape for every table: the row's tenant must equal the scope, or the scope is '*'.
-- uuid columns are compared as text so one expression serves every table.

ALTER TABLE event_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS event_ledger_tenant_isolation ON event_ledger;
CREATE POLICY event_ledger_tenant_isolation ON event_ledger
  USING (sre_current_tenant() = '*' OR tenant_id::text = sre_current_tenant())
  WITH CHECK (sre_current_tenant() = '*' OR tenant_id::text = sre_current_tenant());

ALTER TABLE sync_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sync_outbox_tenant_isolation ON sync_outbox;
CREATE POLICY sync_outbox_tenant_isolation ON sync_outbox
  USING (sre_current_tenant() = '*' OR tenant_id::text = sre_current_tenant())
  WITH CHECK (sre_current_tenant() = '*' OR tenant_id::text = sre_current_tenant());

ALTER TABLE config_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS config_versions_tenant_isolation ON config_versions;
CREATE POLICY config_versions_tenant_isolation ON config_versions
  USING (sre_current_tenant() = '*' OR tenant_id::text = sre_current_tenant())
  WITH CHECK (sre_current_tenant() = '*' OR tenant_id::text = sre_current_tenant());

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS idempotency_keys_tenant_isolation ON idempotency_keys;
CREATE POLICY idempotency_keys_tenant_isolation ON idempotency_keys
  USING (sre_current_tenant() = '*' OR tenant_id::text = sre_current_tenant())
  WITH CHECK (sre_current_tenant() = '*' OR tenant_id::text = sre_current_tenant());

ALTER TABLE number_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE number_series FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS number_series_tenant_isolation ON number_series;
CREATE POLICY number_series_tenant_isolation ON number_series
  USING (sre_current_tenant() = '*' OR tenant_id::text = sre_current_tenant())
  WITH CHECK (sre_current_tenant() = '*' OR tenant_id::text = sre_current_tenant());

-- audit_log.tenant_id is text and 'unauthenticated' is a legitimate value: the kernel scopes an
-- unauthenticated request's audit row to that pseudo-tenant, so the policy shape is unchanged.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_log_tenant_isolation ON audit_log;
CREATE POLICY audit_log_tenant_isolation ON audit_log
  USING (sre_current_tenant() = '*' OR tenant_id = sre_current_tenant())
  WITH CHECK (sre_current_tenant() = '*' OR tenant_id = sre_current_tenant());

ALTER TABLE projection_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE projection_snapshot FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projection_snapshot_tenant_isolation ON projection_snapshot;
CREATE POLICY projection_snapshot_tenant_isolation ON projection_snapshot
  USING (sre_current_tenant() = '*' OR tenant_id = sre_current_tenant())
  WITH CHECK (sre_current_tenant() = '*' OR tenant_id = sre_current_tenant());
