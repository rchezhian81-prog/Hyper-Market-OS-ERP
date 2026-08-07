-- 0006 — an index for "the latest of this type in this stream".
--
-- Additive and reversible: an index, nothing else. No column changes, no data movement, no
-- rewrite of a single row (hard rule #2 and the migration rules both hold trivially here).
--
-- WHY IT EXISTS. "Current" in this system is always a fold over the stream, which is what makes
-- the ledger the only truth — but *the latest event of a type* is a fold whose answer sits at the
-- end, and reading forward to reach it is work nobody needs. The catalogue forced it: a shop
-- publishing a price list a day holds 365 packs a year, each one carrying its entire product
-- master, and answering "which version are we on?" was deserialising all of them to look at the
-- last. `event_ledger_stream_idx` is (tenant_id, stream, seq) and cannot serve that, because the
-- type is not in it — so the plan is a scan of the stream with a filter on top.
--
-- `seq DESC` so the newest row of a type is the first one the index yields.

CREATE INDEX IF NOT EXISTS event_ledger_stream_type_idx
  ON event_ledger (tenant_id, stream, type, seq DESC);
