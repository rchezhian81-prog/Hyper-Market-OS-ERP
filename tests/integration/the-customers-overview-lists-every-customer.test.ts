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
 * **M16 (R4, signed OB-227 · OB-74): the Customers page's read.** "A person with the customer permission sees suggested
 * duplicates and segments on one page. A merge needs a second person and can be undone; nothing merges by itself. A
 * customer without profiling consent shows as 'not profiled', never silently left out. A person without the permission
 * is refused." The overview lists every customer from the banked sales with its segment, and the merges waiting for a
 * second person; nothing merges by being read. In memory and on real PostgreSQL, with a cold restart.
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
  const pg = () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: pg, restart: pg });
}

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
interface Overview { customers: { customerRef: string; segment: string; profiled: boolean; orders: number }[]; notProfiled: number; merges: { waitingForSecondPerson: { mergeId: string }[]; inForce: { mergeId: string }[]; reversed: { mergeId: string }[] }; mergesAnything: boolean }

describe.each(backings)('the customers overview lists every customer — on $name (M16)', ({ harness, restart }) => {
  it('segments with "not profiled" listed, merges waiting for a second person, a reversal, and a refusal without the permission', async () => {
    let h = harness();
    const T = randomUUID();
    if (h.store instanceof SqlEventStore) await h.store.registerTenant(T, 'test/provision');
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    let n = 0;
    for (const m of ['M-anu', 'M-anu-2', 'M-bala']) {
      n += 1;
      await ok(req('POST', '/v1/sales', {
        saleId: `S-${n}`, receiptNumber: `R-${n}`, laneId: 'lane-1', locationId: 'store-01', cashierId: 'u-owner', tradingDay: '2026-10-01', committedAt: '2026-10-01T06:00:00.000Z',
        totalMinor: 5_000, currency: 'INR', packVersion: 1, customerRef: m,
        lines: [{ productId: 'p-tea', quantityMinor: 1, uom: 'ea', unitPriceMinor: 5_000, lineTotalMinor: 5_000 }], tenders: [{ kind: 'cash', amountMinor: 5_000 }],
      }), `sale ${m}`);
    }
    for (const m of ['M-anu', 'M-anu-2']) await ok(req('POST', `/v1/customers/${m}/consent`, { purpose: 'profiling', channel: 'sms', given: true, evidence: 'synthetic desk consent' }), `consent ${m}`);

    expect((await req('GET', '/v1/customer/overview', undefined, 'u-cash')).status).toBe(403);
    let o = (await ok(req('GET', '/v1/customer/overview', undefined, 'u-mgr'), 'overview')).body as Overview;
    expect(o.customers.map((c) => [c.customerRef, c.segment, c.profiled])).toEqual([['M-anu', 'new', true], ['M-anu-2', 'new', true], ['M-bala', 'not_profiled', false]]);
    expect(o.notProfiled).toBe(1);
    expect(o.mergesAnything).toBe(false);

    // The suggested duplicates: a pure check over what the desk saw; it proposes, it never merges.
    const dup = (await ok(req('POST', '/v1/customer/duplicates', { customers: [{ customerId: 'M-anu', phone: '98400 11111', phoneVerified: true }, { customerId: 'M-anu-2', phone: '9840011111', phoneVerified: false }, { customerId: 'M-bala', phone: '98400 22222' }] }, 'u-mgr'), 'duplicates')).body as { matches: { customerIds: string[]; disposition: string }[] };
    expect(dup.matches.map((m) => [m.customerIds, m.disposition])).toEqual([[['M-anu', 'M-anu-2'], 'review']]);
    expect(((await ok(req('GET', '/v1/customer/overview', undefined, 'u-mgr'), 'overview 2')).body as Overview).merges.waitingForSecondPerson).toEqual([]);

    // A merge proposed by one person waits for ANOTHER; it is not in force until then.
    await ok(req('POST', '/v1/customers/M-anu/merges/mg-1', { mergedRef: 'M-anu-2', reason: 'same phone seen at the desk' }, 'u-mgr'), 'propose');
    h = restart(h);
    o = (await ok(req('GET', '/v1/customer/overview', undefined, 'u-mgr'), 'overview 3')).body as Overview;
    expect(o.merges.waitingForSecondPerson.map((m) => m.mergeId)).toEqual(['mg-1']);
    expect(o.merges.inForce).toEqual([]);
    expect((await req('POST', '/v1/customers/merges/mg-1/approve', {}, 'u-mgr')).status).toBe(403);
    await ok(req('POST', '/v1/customers/merges/mg-1/approve', {}), 'approve');
    o = (await ok(req('GET', '/v1/customer/overview', undefined, 'u-mgr'), 'overview 4')).body as Overview;
    expect(o.merges.inForce.map((m) => m.mergeId)).toEqual(['mg-1']);
    // Undo: the merge is kept and the reversal is a new fact.
    expect(codeOf(await req('POST', '/v1/customers/merges/mg-1/reverse', {}))).toBe('reversal_needs_a_reason');
    await ok(req('POST', '/v1/customers/merges/mg-1/reverse', { reason: 'two people after all' }), 'reverse');
    o = (await ok(req('GET', '/v1/customer/overview', undefined, 'u-mgr'), 'overview 5')).body as Overview;
    expect([o.merges.inForce, o.merges.reversed.map((m) => m.mergeId)]).toEqual([[], ['mg-1']]);
  }, 120_000);
});
