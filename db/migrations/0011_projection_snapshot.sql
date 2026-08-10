-- Projection snapshots (CORE-03 inc2).
--
-- WHY. A read model in this system is DERIVED by folding the append-only event ledger, and a fold
-- that always starts at seq 0 grows without bound as the shop trades. A snapshot is the folded
-- state at a WATERMARK, so a read resumes from it and folds only the tail behind it.
--
-- NOT A SOURCE OF TRUTH. Every row here is derived and DISPOSABLE: it is rebuildable from
-- event_ledger, and dropping this whole table costs a rebuild, never data (hard rule #2 is about the
-- ledger, which a snapshot never replaces). So this table carries no append-only guard and no audit
-- chain — unlike event_ledger, a snapshot row is MEANT to be overwritten (the newest fold for a key
-- wins) and MEANT to be safely truncated.
--
-- SHAPE. Keyed by (tenant_id, stream, projection) — tenant-scoped like everything else (§35). The
-- whole Snapshot (its ProjectionResult + takenAt) is stored as one JSONB `data`, so the store is
-- generic over any projection state; a snapshot is only ever loaded whole by its key, never queried
-- inside, so no further columns or indexes are needed. Additive and idempotent (re-runnable, QG-08).

CREATE TABLE IF NOT EXISTS projection_snapshot (
  tenant_id  text        NOT NULL,
  stream     text        NOT NULL,
  projection text        NOT NULL,
  data       jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, stream, projection)
);
