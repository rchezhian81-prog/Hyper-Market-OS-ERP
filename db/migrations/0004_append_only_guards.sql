-- 0004 — enforce append-only in the DATABASE, not only in application code.
-- Hard rule #2 (ledgers are append-only) / M34-FR-01 (any attempt to edit or delete
-- an audit record fails) / SEC-07 (tamper-evident) / NFR-15.
--
-- Why this migration exists
-- ------------------------
-- Verifying migration 0001 against a real PostgreSQL instance showed that
-- `event_ledger` accepted both `UPDATE` and `DELETE`. The application code has no
-- API that can express either — `Ledger` and `SqlEventStore` deliberately offer only
-- `append` — but that protects the ledger only from OUR code. It does not protect it
-- from a psql session, a support engineer, a compromised service account, a careless
-- future migration, or an ORM someone adds in two years.
--
-- The requirement is that editing an audit record FAILS, not that our code declines
-- to try. So the guarantee belongs where the data lives.
--
-- What this does NOT claim
-- -----------------------
-- A superuser can drop a trigger. This is defence in depth, not an absolute: it
-- turns "anyone with a database connection can quietly rewrite history" into "you
-- must deliberately and visibly disable a named guard first", which is precisely the
-- difference between an accident and an act. The hash chain in `packages/audit`
-- remains the detector of last resort.
--
-- Reversible: dropping the triggers restores the previous behaviour. Additive only —
-- no data is read, written or transformed.

CREATE OR REPLACE FUNCTION sre_refuse_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Table "%" is append-only: % is refused. A correction is a new compensating entry, never an edit (hard rule #2 / M34-FR-01).',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION sre_refuse_mutation() IS
  'Refuses UPDATE/DELETE on append-only tables. Corrections are compensating entries.';

-- The event ledger: every sale, stock movement, cash movement and audit fact.
DROP TRIGGER IF EXISTS event_ledger_no_update ON event_ledger;
CREATE TRIGGER event_ledger_no_update
  BEFORE UPDATE ON event_ledger
  FOR EACH ROW EXECUTE FUNCTION sre_refuse_mutation();

DROP TRIGGER IF EXISTS event_ledger_no_delete ON event_ledger;
CREATE TRIGGER event_ledger_no_delete
  BEFORE DELETE ON event_ledger
  FOR EACH ROW EXECUTE FUNCTION sre_refuse_mutation();

-- Config versions: a rollback is a NEW version (M01-FR-03), never an edit of an old
-- one, so the history of who changed what and when stays intact.
DROP TRIGGER IF EXISTS config_versions_no_update ON config_versions;
CREATE TRIGGER config_versions_no_update
  BEFORE UPDATE ON config_versions
  FOR EACH ROW EXECUTE FUNCTION sre_refuse_mutation();

DROP TRIGGER IF EXISTS config_versions_no_delete ON config_versions;
CREATE TRIGGER config_versions_no_delete
  BEFORE DELETE ON config_versions
  FOR EACH ROW EXECUTE FUNCTION sre_refuse_mutation();

-- Deliberately NOT guarded: `sync_outbox`. It is mutable by design — attempts,
-- next-retry time and dead-letter state change as an item is worked (§31). Its
-- durability guarantee is that items are never SILENTLY dropped, which is enforced
-- by the dead-letter workflow, not by immutability.
