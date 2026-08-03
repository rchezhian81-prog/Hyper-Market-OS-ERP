// Durable versioned configuration store (M01-FR-03) — the persistent backing for the
// in-memory `ConfigStore` (packages/config). Every change is a NEW immutable version
// (author, reason, effective date); a rollback restores a prior value as a NEW version
// (append-only — the intervening versions are kept, never deleted). Versions are
// numbered per (tenant, key), so tenants never collide (ADR-0003). Depends only on the
// `SqlClient` port; testable without a live database.

import type { SqlClient, SqlRow } from './sql-client';

export interface ConfigVersionRecord {
  readonly tenantId: string;
  readonly key: string;
  /** 1-based, monotonic per (tenant, key). */
  readonly version: number;
  readonly value: unknown;
  readonly author: string;
  readonly reason: string;
  readonly effectiveAt: string;
  /** The version this one restored, if created by a rollback; else null. */
  readonly rolledBackFrom: number | null;
}

export interface ConfigVersionStore {
  /** Record a new value as the next version for a tenant's key. */
  set(tenantId: string, key: string, value: unknown, author: string, reason: string, effectiveAt: string): Promise<ConfigVersionRecord>;
  /** The current (latest) version for a key, or undefined if none. */
  current(tenantId: string, key: string): Promise<ConfigVersionRecord | undefined>;
  /** Full version history for a key, oldest first. */
  history(tenantId: string, key: string): Promise<readonly ConfigVersionRecord[]>;
  /** Restore a prior version's value as a NEW version (append-only). */
  rollback(tenantId: string, key: string, toVersion: number, author: string, reason: string, effectiveAt: string): Promise<ConfigVersionRecord>;
}

export class ConfigVersionNotFoundError extends Error {
  constructor(key: string, version: number) {
    super(`No version ${version} for config key "${key}".`);
    this.name = 'ConfigVersionNotFoundError';
  }
}

function composite(tenantId: string, key: string): string {
  return `${tenantId} ${key}`;
}

/** In-memory reference implementation — the behavioural contract, tenant-scoped. */
export class InMemoryConfigVersionStore implements ConfigVersionStore {
  private readonly byKey = new Map<string, ConfigVersionRecord[]>();

  private appendVersion(record: ConfigVersionRecord): ConfigVersionRecord {
    const id = composite(record.tenantId, record.key);
    const list = this.byKey.get(id) ?? [];
    list.push(record);
    this.byKey.set(id, list);
    return record;
  }

  set(tenantId: string, key: string, value: unknown, author: string, reason: string, effectiveAt: string): Promise<ConfigVersionRecord> {
    const version = (this.byKey.get(composite(tenantId, key))?.length ?? 0) + 1;
    return Promise.resolve(
      this.appendVersion(Object.freeze({ tenantId, key, version, value, author, reason, effectiveAt, rolledBackFrom: null })),
    );
  }

  current(tenantId: string, key: string): Promise<ConfigVersionRecord | undefined> {
    const list = this.byKey.get(composite(tenantId, key));
    return Promise.resolve(list && list.length > 0 ? list[list.length - 1] : undefined);
  }

  history(tenantId: string, key: string): Promise<readonly ConfigVersionRecord[]> {
    return Promise.resolve((this.byKey.get(composite(tenantId, key)) ?? []).slice());
  }

  rollback(tenantId: string, key: string, toVersion: number, author: string, reason: string, effectiveAt: string): Promise<ConfigVersionRecord> {
    const list = this.byKey.get(composite(tenantId, key)) ?? [];
    const target = list.find((v) => v.version === toVersion);
    if (target === undefined) {
      return Promise.reject(new ConfigVersionNotFoundError(key, toVersion));
    }
    const version = list.length + 1;
    return Promise.resolve(
      this.appendVersion(Object.freeze({ tenantId, key, version, value: target.value, author, reason, effectiveAt, rolledBackFrom: toVersion })),
    );
  }
}

const COLUMNS = 'tenant_id, config_key, version, value, author, reason, effective_at, rolled_back_from';

function rowToRecord(row: SqlRow): ConfigVersionRecord {
  const rolledBack = row['rolled_back_from'];
  const effectiveAt = row['effective_at'];
  return Object.freeze({
    tenantId: String(row['tenant_id']),
    key: String(row['config_key']),
    version: Number(row['version']),
    value: row['value'],
    author: String(row['author']),
    reason: String(row['reason']),
    effectiveAt: typeof effectiveAt === 'string' ? effectiveAt : new Date(String(effectiveAt)).toISOString(),
    rolledBackFrom: rolledBack === null || rolledBack === undefined ? null : Number(rolledBack),
  });
}

/**
 * SQL-backed versioned config store over `config_versions` (migration 0003) via the
 * `SqlClient` port. The next version is computed atomically per (tenant, key) with
 * COALESCE(MAX(version), 0) + 1 in the INSERT … SELECT, so concurrent writers can't
 * collide on a version number. Append-only — there is no update/delete of a version.
 */
export class SqlConfigVersionStore implements ConfigVersionStore {
  constructor(private readonly client: SqlClient) {}

  async set(tenantId: string, key: string, value: unknown, author: string, reason: string, effectiveAt: string): Promise<ConfigVersionRecord> {
    const rows = await this.client.query(
      `INSERT INTO config_versions (${COLUMNS})
       SELECT $1, $2, COALESCE(MAX(version), 0) + 1, $3, $4, $5, $6, NULL
       FROM config_versions WHERE tenant_id = $1 AND config_key = $2
       RETURNING ${COLUMNS}`,
      [tenantId, key, JSON.stringify(value), author, reason, effectiveAt],
    );
    return rowToRecord(rows[0]!);
  }

  async current(tenantId: string, key: string): Promise<ConfigVersionRecord | undefined> {
    const rows = await this.client.query(
      `SELECT ${COLUMNS} FROM config_versions WHERE tenant_id = $1 AND config_key = $2 ORDER BY version DESC LIMIT 1`,
      [tenantId, key],
    );
    return rows.length > 0 ? rowToRecord(rows[0]!) : undefined;
  }

  async history(tenantId: string, key: string): Promise<readonly ConfigVersionRecord[]> {
    const rows = await this.client.query(
      `SELECT ${COLUMNS} FROM config_versions WHERE tenant_id = $1 AND config_key = $2 ORDER BY version ASC`,
      [tenantId, key],
    );
    return rows.map(rowToRecord);
  }

  async rollback(tenantId: string, key: string, toVersion: number, author: string, reason: string, effectiveAt: string): Promise<ConfigVersionRecord> {
    const target = await this.client.query(
      `SELECT value FROM config_versions WHERE tenant_id = $1 AND config_key = $2 AND version = $3`,
      [tenantId, key, toVersion],
    );
    if (target.length === 0) {
      throw new ConfigVersionNotFoundError(key, toVersion);
    }
    const rows = await this.client.query(
      `INSERT INTO config_versions (${COLUMNS})
       SELECT $1, $2, COALESCE(MAX(version), 0) + 1, $3, $4, $5, $6, $7
       FROM config_versions WHERE tenant_id = $1 AND config_key = $2
       RETURNING ${COLUMNS}`,
      [tenantId, key, JSON.stringify(target[0]!['value']), author, reason, effectiveAt, toVersion],
    );
    return rowToRecord(rows[0]!);
  }
}
