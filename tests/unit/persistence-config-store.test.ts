import { describe, it, expect } from 'vitest';
import {
  InMemoryConfigVersionStore,
  SqlConfigVersionStore,
  ConfigVersionNotFoundError,
  type ConfigVersionStore,
  type SqlClient,
  type SqlRow,
} from '../../packages/persistence/src/index';

// The durable config store is append-only and versioned per (tenant, key); a
// rollback restores a prior value as a NEW version (M01-FR-03 / ADR-0003).

const AT1 = '2026-08-01T00:00:00Z';
const AT2 = '2026-08-02T00:00:00Z';
const AT3 = '2026-08-03T00:00:00Z';

function configStoreContract(makeStore: () => ConfigVersionStore) {
  it('records each change as the next version', async () => {
    const store = makeStore();
    const v1 = await store.set('t1', 'tax.rate', 1800, 'alice', 'initial', AT1);
    const v2 = await store.set('t1', 'tax.rate', 1200, 'bob', 'reduced', AT2);
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect((await store.current('t1', 'tax.rate'))?.value).toBe(1200);
    expect(await store.history('t1', 'tax.rate')).toHaveLength(2);
  });

  it('rolls back to a prior version as a new version (append-only)', async () => {
    const store = makeStore();
    await store.set('t1', 'tax.rate', 1800, 'alice', 'initial', AT1);
    await store.set('t1', 'tax.rate', 1200, 'bob', 'reduced', AT2);
    const v3 = await store.rollback('t1', 'tax.rate', 1, 'carol', 'revert', AT3);
    expect(v3.version).toBe(3); // a NEW version, not a deletion
    expect(v3.value).toBe(1800); // restores version 1's value
    expect(v3.rolledBackFrom).toBe(1);
    expect(await store.history('t1', 'tax.rate')).toHaveLength(3); // intervening version kept
  });

  it('rejects a rollback to a version that does not exist', async () => {
    const store = makeStore();
    await store.set('t1', 'tax.rate', 1800, 'alice', 'initial', AT1);
    await expect(store.rollback('t1', 'tax.rate', 9, 'carol', 'revert', AT3)).rejects.toBeInstanceOf(
      ConfigVersionNotFoundError,
    );
  });

  it('numbers versions independently per tenant', async () => {
    const store = makeStore();
    await store.set('t1', 'tax.rate', 1800, 'a', 'r', AT1);
    const other = await store.set('t2', 'tax.rate', 500, 'a', 'r', AT1);
    expect(other.version).toBe(1); // t2 starts fresh, unaffected by t1
    expect((await store.current('t1', 'tax.rate'))?.value).toBe(1800);
    expect((await store.current('t2', 'tax.rate'))?.value).toBe(500);
  });
}

describe('InMemoryConfigVersionStore (reference contract)', () => {
  configStoreContract(() => new InMemoryConfigVersionStore());
});

class FakeSqlClient implements SqlClient {
  readonly calls: { sql: string; params: readonly unknown[] }[] = [];
  private readonly responses: SqlRow[][] = [];
  program(rows: SqlRow[]): this {
    this.responses.push(rows);
    return this;
  }
  query<R extends SqlRow = SqlRow>(sql: string, params: readonly unknown[] = []): Promise<readonly R[]> {
    this.calls.push({ sql, params });
    return Promise.resolve((this.responses.shift() ?? []) as R[]);
  }
}

function row(overrides: Partial<SqlRow> = {}): SqlRow {
  return {
    tenant_id: 't1',
    config_key: 'tax.rate',
    version: 1,
    value: 1800,
    author: 'alice',
    reason: 'initial',
    effective_at: AT1,
    rolled_back_from: null,
    ...overrides,
  };
}

describe('SqlConfigVersionStore', () => {
  it('assigns the next version atomically in the INSERT', async () => {
    const client = new FakeSqlClient().program([row({ version: 2, value: 1200 })]);
    const store = new SqlConfigVersionStore(client);
    const rec = await store.set('t1', 'tax.rate', 1200, 'bob', 'reduced', AT2);
    expect(rec.version).toBe(2);
    const sql = client.calls[0]?.sql ?? '';
    expect(sql).toContain('INSERT INTO config_versions');
    expect(sql).toContain('COALESCE(MAX(version), 0) + 1'); // atomic next version
  });

  it('reads the target value then inserts a new rollback version', async () => {
    const client = new FakeSqlClient()
      .program([{ value: 1800 }]) // SELECT the target version's value
      .program([row({ version: 3, value: 1800, rolled_back_from: 1 })]); // INSERT the new version
    const store = new SqlConfigVersionStore(client);
    const rec = await store.rollback('t1', 'tax.rate', 1, 'carol', 'revert', AT3);
    expect(rec.version).toBe(3);
    expect(rec.rolledBackFrom).toBe(1);
    expect(client.calls[0]?.sql).toContain('SELECT value FROM config_versions');
  });

  it('throws when the rollback target is missing', async () => {
    const client = new FakeSqlClient().program([]); // SELECT returns no rows
    const store = new SqlConfigVersionStore(client);
    await expect(store.rollback('t1', 'tax.rate', 9, 'carol', 'revert', AT3)).rejects.toBeInstanceOf(
      ConfigVersionNotFoundError,
    );
  });
});
