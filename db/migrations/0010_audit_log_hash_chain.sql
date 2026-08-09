-- 0010 — seal the audit trail with a per-tenant hash chain (audit FND-02 / GAP-SEC-03).
--
-- WHY. The audit_log is append-only at the database (0004/0008 refuse UPDATE and DELETE), but the
-- rows were not bound to one another: nothing linked a row to the one before it, so a row inserted,
-- removed or reordered BEHIND the database — a restored backup with a row quietly dropped, a direct
-- write by whoever holds the credentials — left no trace. Append-only stops edits through the
-- application; it does not make an out-of-band change DETECTABLE. This does.
--
-- HOW. Each row now carries the SHA-256 hash of its predecessor within the same tenant (§35) and a
-- hash over its own sealed contents. The kernel's SqlAuditSink computes these (services/kernel/
-- src/audit-chain.ts), so the seal has one definition shared by the writer and the verifier
-- (scripts/verify-audit-chain.mjs). Additive and idempotent (re-runnable — QG-08): two nullable
-- columns and one unique index; existing rows keep NULL and are an unsealed prefix the verifier
-- skips.
--
-- FORK GUARD. A tenant's chain must be linear. The unique index on (tenant_id, prev_hash) makes a
-- fork — two rows claiming the same predecessor — impossible to commit, so even a bug or a race
-- cannot silently branch the chain; it fails loudly (the sink reports it) instead. NULLs are
-- distinct in a unique index, so the unsealed legacy prefix is unaffected.

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash text;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS hash      text;

CREATE UNIQUE INDEX IF NOT EXISTS audit_log_chain_uq ON audit_log (tenant_id, prev_hash);
