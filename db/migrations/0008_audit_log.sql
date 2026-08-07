-- 0008 — the audit trail. Additive: one new table and its append-only guards.
--
-- WHY IT EXISTS. Hard rule #6 says never delete audit evidence, and there was none to
-- delete: the kernel writes an audit entry for every write and every refusal, through an
-- OPTIONAL port, and the composition root never supplied one. `writeAudit` returned
-- immediately on every request. Not a crash — the trail simply was not being kept.
--
-- SEPARATE FROM event_ledger, deliberately. An audit entry is not a business event: it
-- records that somebody asked something and what they were told, including when the
-- answer was "no". It also has to record attempts by callers who have NO TENANT — an
-- unauthenticated request is exactly the kind worth keeping — and event_ledger's
-- tenant_id is a uuid that such a row could not satisfy. So tenant_id here is text, and
-- 'unauthenticated' is a legitimate value rather than a row that could not be written.
--
-- SAME APPEND-ONLY GUARANTEE. The triggers below are the ones from migration 0004: no
-- UPDATE, no DELETE, at the database rather than by convention. An audit trail somebody
-- can edit is not an audit trail, and this is the table where that matters most.

CREATE TABLE IF NOT EXISTS audit_log (
  seq             bigserial   PRIMARY KEY,
  -- Text, not uuid: 'unauthenticated' is a legitimate and interesting value.
  tenant_id       text        NOT NULL,
  user_id         text        NOT NULL,
  method          text        NOT NULL,
  path            text        NOT NULL,
  status          integer     NOT NULL,
  permission      text        NOT NULL,
  trace_id        text        NOT NULL,
  idempotency_key text,
  recorded_at     timestamptz NOT NULL DEFAULT now()
);

-- "What did this person do?" and "who touched this in the last hour?" are the two
-- questions ever asked of this table, at an incident or an audit.
CREATE INDEX IF NOT EXISTS audit_log_who_idx ON audit_log (tenant_id, user_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_when_idx ON audit_log (recorded_at DESC);

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION sre_refuse_mutation();

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION sre_refuse_mutation();
