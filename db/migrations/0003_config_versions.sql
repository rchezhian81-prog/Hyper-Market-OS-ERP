-- 0003_config_versions.sql
-- Versioned configuration (M01-FR-03) — configuration changes far more often than
-- code, so every change is a NEW immutable version with author, reason and effective
-- date; a rollback restores a prior value as a NEW version. This table is append-only
-- (⊕): versions are never overwritten or removed, so the full history is retained and
-- a rollback is auditable. Multi-tenant (ADR-0003): versions are numbered per
-- (tenant, key). Baseline §19: PostgreSQL. Forward-only.

CREATE TABLE IF NOT EXISTS config_versions (
  tenant_id         uuid        NOT NULL,
  config_key        text        NOT NULL,
  -- 1-based, monotonic per (tenant, key).
  version           integer     NOT NULL,
  value             jsonb        NOT NULL,
  author            text        NOT NULL,
  reason            text        NOT NULL,
  effective_at      timestamptz NOT NULL,
  -- Set to the restored version when this row was created by a rollback, else null.
  rolled_back_from  integer     NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT config_versions_pk PRIMARY KEY (tenant_id, config_key, version),
  CONSTRAINT config_versions_version_ck CHECK (version >= 1)
);

-- Read the current (latest) version, and the full history, for a tenant's key.
CREATE INDEX IF NOT EXISTS config_versions_key_idx
  ON config_versions (tenant_id, config_key, version);
