-- 0015 — per-subject data keys and the shredded-key list: crypto-shredding of personal data (audit FUL-12 ·
-- M16-FR-03 · M20-FR-04 · ADR-0025 · hard rules #2 and #6).
--
-- The event ledger is append-only and audit evidence is never deleted, so an erasure cannot remove a customer's
-- words from the events that hold them. Instead, the personal fields of customer-linked events are written
-- ENCRYPTED under a data key that belongs to one (tenant, subject, category); erasure DESTROYS that key. The
-- ciphertext stays in the ledger — the event, its amounts, dates and ids are untouched — but nobody can read
-- the personal text any more.
--
-- Two tables:
--   • subject_data_keys — one row per (tenant, subject, category): the data key, WRAPPED (AES-256-GCM) under the
--     key-encryption key the API holds in configuration (never in the database). Destroying a key overwrites the
--     wrapped key with NULL; nothing else about a row may ever change, and a row is never deleted, so the
--     "this key existed and was destroyed at …" fact stays. A destroyed key is never re-set.
--   • subject_key_shreds — the SHREDDED-KEY LIST: append-only, one row per destroyed key, with the request that
--     destroyed it. It is the list that WINS: a key row whose (tenant, subject, category) is on it is treated as
--     destroyed — and overwritten again — even if a restored backup brought the wrapped key back.
--
-- Forward-only; additive (no existing row is read or changed). Tenant-isolated like every tenant table (0012).

CREATE TABLE IF NOT EXISTS subject_data_keys (
  tenant_id     uuid        NOT NULL,
  subject_ref   text        NOT NULL,
  category      text        NOT NULL,
  -- The data key wrapped under the key-encryption key: 12-byte IV ‖ 16-byte tag ‖ 32-byte ciphertext. NULL = destroyed.
  wrapped_key   bytea,
  created_at    timestamptz NOT NULL DEFAULT now(),
  destroyed_at  timestamptz,
  CONSTRAINT subject_data_keys_pk PRIMARY KEY (tenant_id, subject_ref, category),
  CONSTRAINT subject_data_keys_destroyed_ck CHECK ((wrapped_key IS NULL) = (destroyed_at IS NOT NULL))
);

COMMENT ON TABLE subject_data_keys IS
  'Per-subject, per-category data keys for personal-data fields (ADR-0025). Wrapped under the configured key-encryption key; destroyed by overwriting with NULL (crypto-shredding). Never deleted.';

CREATE TABLE IF NOT EXISTS subject_key_shreds (
  tenant_id     uuid        NOT NULL,
  subject_ref   text        NOT NULL,
  category      text        NOT NULL,
  request_id    text        NOT NULL,
  shredded_by   text        NOT NULL,
  shredded_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subject_key_shreds_pk PRIMARY KEY (tenant_id, subject_ref, category)
);

COMMENT ON TABLE subject_key_shreds IS
  'The shredded-key list (ADR-0025): append-only. A (tenant, subject, category) on it has no readable key, whatever a restored backup holds.';

-- A key row may only be DESTROYED: wrapped_key and destroyed_at go from (key, NULL) to (NULL, a time); nothing else
-- may change, a destroyed key is never re-set, and no row is deleted.
CREATE OR REPLACE FUNCTION sre_subject_key_destroy_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'subject_data_keys rows are never deleted: a key is destroyed by overwriting it (ADR-0025).'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.subject_ref <> OLD.subject_ref OR NEW.category <> OLD.category
     OR NEW.created_at <> OLD.created_at OR NEW.wrapped_key IS NOT NULL
     OR (OLD.wrapped_key IS NULL AND NEW.destroyed_at IS DISTINCT FROM OLD.destroyed_at) THEN
    RAISE EXCEPTION 'subject_data_keys: the only change allowed is destroying the key (ADR-0025).'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subject_data_keys_destroy_only ON subject_data_keys;
CREATE TRIGGER subject_data_keys_destroy_only
  BEFORE UPDATE OR DELETE ON subject_data_keys
  FOR EACH ROW EXECUTE FUNCTION sre_subject_key_destroy_only();

DROP TRIGGER IF EXISTS subject_key_shreds_no_update ON subject_key_shreds;
CREATE TRIGGER subject_key_shreds_no_update
  BEFORE UPDATE ON subject_key_shreds
  FOR EACH ROW EXECUTE FUNCTION sre_refuse_mutation();

DROP TRIGGER IF EXISTS subject_key_shreds_no_delete ON subject_key_shreds;
CREATE TRIGGER subject_key_shreds_no_delete
  BEFORE DELETE ON subject_key_shreds
  FOR EACH ROW EXECUTE FUNCTION sre_refuse_mutation();

ALTER TABLE subject_data_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_data_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subject_data_keys_tenant_isolation ON subject_data_keys;
CREATE POLICY subject_data_keys_tenant_isolation ON subject_data_keys
  USING (sre_current_tenant() = '*' OR tenant_id::text = sre_current_tenant())
  WITH CHECK (sre_current_tenant() = '*' OR tenant_id::text = sre_current_tenant());

ALTER TABLE subject_key_shreds ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_key_shreds FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subject_key_shreds_tenant_isolation ON subject_key_shreds;
CREATE POLICY subject_key_shreds_tenant_isolation ON subject_key_shreds
  USING (sre_current_tenant() = '*' OR tenant_id::text = sre_current_tenant())
  WITH CHECK (sre_current_tenant() = '*' OR tenant_id::text = sre_current_tenant());

ALTER TABLE subject_data_keys ADD CONSTRAINT subject_data_keys_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id);
ALTER TABLE subject_key_shreds ADD CONSTRAINT subject_key_shreds_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id);
