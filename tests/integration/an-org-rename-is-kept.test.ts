import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';

/**
 * **An org rename is kept (audit PA-05 · M01-FR-01 · P-08).** The audit renamed a branch: the route answered 201 with
 * the new name, and the next read still showed the old one. The stored fact was keyed on the node's STRUCTURE (kind,
 * parent, company, GSTIN, status) and not its name, so the store collapsed the rename into the earlier record as a
 * duplicate — a success that was silently discarded. Now every edit that changes anything is a new version of the node;
 * sending exactly what is held is the only thing that collapses. Rename, rename back, restart — each read says the truth.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5';
const OWNER = 'u-owner';
const put = (h: ApiHarness, t: string, id: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/org/nodes/${id}`, userId: OWNER, tenantId: t, idempotencyKey: key, body });
const nameOf = async (h: ApiHarness, t: string, id: string): Promise<string> =>
  ((await h.request({ method: 'GET', path: `/v1/org/nodes/${id}`, userId: OWNER, tenantId: t })).body as { node: { name: string } }).node.name;

async function renameAndRevert(h: ApiHarness, t: string): Promise<void> {
  await h.seedOwner(t, OWNER);
  expect((await put(h, t, 'C1', { kind: 'company', name: 'SRE Retail' }, 'c1')).status).toBe(201);
  expect((await put(h, t, 'B1', { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }, 'b1-a')).status).toBe(201);
  const renamed = await put(h, t, 'B1', { kind: 'branch', name: 'Store One — Gandhipuram', parentId: 'C1', companyId: 'C1' }, 'b1-b');
  expect(renamed.status).toBe(201);
  expect(await nameOf(h, t, 'B1')).toBe('Store One — Gandhipuram');
  // back to the first name: a NEW edit (its own request), not a replay of the first one — it must land too
  expect((await put(h, t, 'B1', { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }, 'b1-c')).status).toBe(201);
  expect(await nameOf(h, t, 'B1')).toBe('Store One');
  // the same request again (a lost reply re-sent under its key) changes nothing
  expect((await put(h, t, 'B1', { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }, 'b1-c')).status).toBe(201);
  expect(await nameOf(h, t, 'B1')).toBe('Store One');
  // and sending exactly what is held under a new key is not a new version either: nothing to record
  const before = (await h.store.readStream(t, 'org\u001fnodes', { type: 'OrgNodeSet' })).length;
  expect((await put(h, t, 'B1', { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }, 'b1-d')).status).toBe(201);
  expect((await h.store.readStream(t, 'org\u001fnodes', { type: 'OrgNodeSet' })).length).toBe(before);
}

describe('an org rename is kept (PA-05)', () => {
  it('rename, rename back and restart: every read gives the name last saved', async () => {
    const h = apiHarness();
    await renameAndRevert(h, A);
    expect(await nameOf(apiHarness({ store: h.store }), A, 'B1')).toBe('Store One');
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
const PG_TENANT = `c${Date.now().toString(16).slice(-7)}-cccc-4ccc-8ccc-${'c'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('an org rename is kept on real PostgreSQL (PA-05)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });
  const harness = () => { const sql = pgPoolClient(pool); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };

  it('rename, rename back, and a second instance reads the same name', async () => {
    await renameAndRevert(harness(), PG_TENANT);
    expect(await nameOf(harness(), PG_TENANT, 'B1')).toBe('Store One');
  });
});
