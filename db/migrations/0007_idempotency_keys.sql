-- 0007 — durable idempotency keys.
--
-- Additive: one new table, no change to anything that exists.
--
-- WHY IT EXISTS. The kernel refuses a DIFFERENT request sent under an already-used
-- Idempotency-Key — the control that stops a sale of 400 being answered with the stored
-- result of a sale of 250 — and it was reading that from an in-memory map. Two
-- consequences, neither visible in a test and both certain in production:
--
--   * a restart or a deploy empties it, so the guard silently stops applying to every
--     key minted before the restart;
--   * two API instances behind a load balancer never share it, so the guard does not
--     apply at all.
--
-- THIS TABLE IS A CACHE, NOT A LEDGER, and the distinction matters because rows here
-- may legitimately be expired. That is not deleting audit evidence (hard rule #6): the
-- event ledger holds what happened and is append-only and untouchable; this holds "what
-- we answered a given key with", so that a retry gets the same answer. An expired key
-- simply means a retry that arrives days late is executed again — which is safe,
-- because every append in the system is keyed and the ledger dedupes.
--
-- Nothing here may be UPDATEd. The first answer under a key is the answer, forever:
-- rewriting it is precisely the confusion the guard exists to prevent.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id     uuid        NOT NULL,
  key           text        NOT NULL,
  -- Hash of (method, path, body). A different hash under the same key is refused.
  request_hash  text        NOT NULL,
  status        integer     NOT NULL,
  body          jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- For expiring old keys, which is an operational job and not something the application
-- does on a request path.
CREATE INDEX IF NOT EXISTS idempotency_keys_age_idx
  ON idempotency_keys (created_at);
