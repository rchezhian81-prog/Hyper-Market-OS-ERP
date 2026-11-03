import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **W5 · OB-686 (owner, 3 Nov 2026) · P-03 · OB-01 — the limits the programmers built in: the safety ones kept and said to be
 * built-in, the rest gone until the owner types his own. In memory AND on real PostgreSQL, with a restart.**
 *   • the probing views (M24-FR-04 supplier portal · M22-FR-04 business-customer portal) count from 3 refusals and SAY it is
 *     built-in (`builtIn: true`); a count asked for is not;
 *   • the labour-cost guide (M25-FR-01 · OB-142): no built-in 12% — with no guide the cost and its share are shown and nothing
 *     is compared (16.8% is not "above" anything); the owner sets his own guide (only he may), it then applies, a guide typed
 *     for a what-if still wins, and it survives a restart;
 *   • the business-customer chasing steps are in tests/integration/b2b-collections.test.ts (OB-686 block).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const sqlHarness = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: sqlHarness, restart: sqlHarness });
}
type Res = { status: number; body: unknown };
const DAY = '2026-09-14';

describe.each(backings)('OB-686: the built-in limits — labelled or gone — on $name', ({ harness, restart }) => {
  it('the probing views say their 3 refusals are built-in; an asked-for count is not', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.enableFeature(T, 'b2b');
    const get = (path: string, query: Record<string, string> = {}): Promise<Res> => h.request({ method: 'GET', path, userId: 'u-owner', tenantId: T, query });
    for (const path of ['/v1/supplier-portal/probing', '/v1/b2b-portal/probing']) {
      expect((await get(path)).body, path).toMatchObject({ threshold: 3, builtIn: true });
      expect((await get(path, { threshold: '5' })).body, path).toMatchObject({ threshold: 5, builtIn: false });
    }
  });

  it('the labour-cost guide: none built in — no comparison; the owner sets his own, which then applies and survives a restart', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    const req = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    for (const [id, rate] of [['E1', 9_000], ['E2', 12_000]] as const) {
      expect((await req('POST', `/v1/hr/workforce/employees/${id}`, 'u-mgr', { name: `Staff ${id}`, branchId: 'b1', roles: ['cashier'], active: true, hourlyRateMinor: rate })).status).toBeLessThan(300);
      expect((await req('POST', `/v1/hr/workforce/attendance/${id}/${DAY}`, 'u-mgr', { hours: 8 })).status).toBeLessThan(300);
    }
    const cost = async (query: Record<string, string> = {}) => (await req('GET', '/v1/hr/workforce/labour-cost', 'u-mgr', undefined, { branchId: 'b1', date: DAY, salesMinor: '1000000', ...query })).body as Record<string, unknown>;

    // No guide anywhere: 16.8% of sales is shown, and nothing is compared (the old built-in 12% would have flagged it).
    expect(await cost()).toMatchObject({ labourCostMinor: 168_000, labourBps: 1_680, guideBps: null, aboveGuide: false, guideFrom: 'not_set' });
    expect(((await req('GET', '/v1/hr/workforce/labour-cost-guide', 'u-mgr')).body as { state: string }).state).toBe('not_set');

    // Only the owner sets it; a guide that does not read is refused.
    expect((await req('POST', '/v1/hr/workforce/labour-cost-guide', 'u-mgr', { guideBps: 1_500 })).status).toBe(403);
    for (const bad of [{ guideBps: 0 }, { guideBps: 10_001 }, { guideBps: 12.5 }, {}]) {
      const r = await req('POST', '/v1/hr/workforce/labour-cost-guide', 'u-owner', bad);
      expect([r.status, (r.body as { error: { code: string } }).error.code], JSON.stringify(bad)).toEqual([400, 'not_readable_as_a_labour_guide']);
    }
    const set = await req('POST', '/v1/hr/workforce/labour-cost-guide', 'u-owner', { guideBps: 1_500 });
    expect(set.status).toBe(201);
    expect(set.body).toMatchObject({ state: 'set', guide: { guideBps: 1_500, setBy: 'u-owner' } });

    // His 15% now applies: 16.8% is above it. A guide typed for a what-if still wins (20% — within it).
    expect(await cost()).toMatchObject({ guideBps: 1_500, aboveGuide: true, guideFrom: 'owner' });
    expect(await cost({ guideBps: '2000' })).toMatchObject({ guideBps: 2_000, aboveGuide: false, guideFrom: 'typed' });

    // He changes it; the newest applies, and a restart keeps it.
    expect((await req('POST', '/v1/hr/workforce/labour-cost-guide', 'u-owner', { guideBps: 1_800 })).status).toBe(201);
    h = restart(h);
    expect(await cost()).toMatchObject({ guideBps: 1_800, aboveGuide: false, guideFrom: 'owner' });
  });
});
