import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { MemoryIdempotencyStore, SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { RECALL_NOTICE_STREAM, RECALL_PHONED_EVENT } from '../../services/api/src/lane2-recall-adapters';

/**
 * **OB-387 (owner decision, 26 Oct 2026) — a "phoned" tick per customer on the recall call list (who, when; append-only,
 * audited); any tick refuses the withdrawal by name. The "no customer phoned" self-confirmation stays as an extra.**
 * Through the real API, in memory and on real PostgreSQL, with cold restarts.
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
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store, idempotency: new MemoryIdempotencyStore() }) },
];
if (DATABASE_URL !== undefined) {
  const pg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: pg, restart: () => pg() });
}

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
type CallEntry = { customerRef: string; phoned: { by: string; at: string } | null };
const listOf = (r: Res) => r.body as { callList: CallEntry[]; phonedCount: number; recall: { status: string } };

const sale = (saleId: string, batchId: string, customerRef?: string) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId: 'S1', cashierId: 'u-owner', tradingDay: '2030-06-10', committedAt: '2030-06-10T10:00:00Z',
  totalMinor: 9_000, currency: 'INR', packVersion: 1, ...(customerRef === undefined ? {} : { customerRef }),
  lines: [{ productId: 'DAL', quantityMinor: 1, uom: 'ea', unitPriceMinor: 9_000, lineTotalMinor: 9_000, batchId }],
  tenders: [{ kind: 'cash', amountMinor: 9_000 }],
});

describe.each(backings)('OB-387: a "phoned" tick on the recall call list refuses the withdrawal — on $name', ({ harness, restart }) => {
  const cast = async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    return { h, T };
  };
  const reqOf = (hh: () => ApiHarness, T: string) => (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', key?: string): Promise<Res> =>
    hh().request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: key ?? `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
  const setUp = async (req: ReturnType<typeof reqOf>, batchId: string) => {
    expect((await req('POST', '/v1/inventory/movements', { movementId: `rx-${batchId}`, productId: 'DAL', locationId: 'S1', kind: 'received', quantityMinor: 20, uom: 'ea', occurredAt: '2030-06-01T01:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 4_000, batchId, expiry: '2030-12-01' })).status).toBeLessThan(300);
    expect((await req('POST', '/v1/sales', sale(`S-A-${batchId}`, batchId, 'cust-A'))).status).toBeLessThan(300);
    expect((await req('POST', '/v1/sales', sale(`S-B-${batchId}`, batchId, 'cust-B'))).status).toBeLessThan(300);
    expect((await req('POST', `/v1/quality/recalls/${batchId}`, { reason: 'typed the wrong batch code' }, 'u-mgr')).status).toBe(201);
  };

  it('a tick records who and when, is sealed, stands first-wins — and the withdrawal is then refused by name, across a cold restart', async () => {
    const c = await cast();
    let h = c.h;
    const req = reqOf(() => h, c.T);
    await setUp(req, 'B-TICK');
    const before = listOf(await req('GET', '/v1/quality/recalls/B-TICK/notice-list', undefined, 'u-mgr'));
    expect(before.callList.map((e) => [e.customerRef, e.phoned])).toEqual([['cust-A', null], ['cust-B', null]]);
    expect(before.phonedCount).toBe(0);

    // Permission: a cashier may not tick; a customer not on the list is refused by name; nothing is written.
    expect((await req('POST', '/v1/quality/recalls/B-TICK/call-list/cust-A/phoned', undefined, 'u-cash')).status).toBe(403);
    const stranger = await req('POST', '/v1/quality/recalls/B-TICK/call-list/cust-Z/phoned', undefined, 'u-mgr');
    expect([stranger.status, codeOf(stranger)]).toEqual([404, 'customer_not_on_the_recall_call_list']);
    const noRecall = await req('POST', '/v1/quality/recalls/B-NONE/call-list/cust-A/phoned', undefined, 'u-mgr');
    expect(noRecall.status).toBe(404);
    expect((await h.store.readStream(c.T, RECALL_NOTICE_STREAM, { type: RECALL_PHONED_EVENT })).length).toBe(0);

    // The manager phones cust-A and ticks it.
    const ticked = await req('POST', '/v1/quality/recalls/B-TICK/call-list/cust-A/phoned', undefined, 'u-mgr', 'tick-1');
    expect(ticked.status, JSON.stringify(ticked.body)).toBe(201);
    expect(ticked.body).toMatchObject({ customerRef: 'cust-A', phoned: { by: 'u-mgr' }, alreadyTicked: false });
    // A lost reply re-sent is the same tick; a second tick by someone else is answered with the FIRST (never re-written).
    expect((await req('POST', '/v1/quality/recalls/B-TICK/call-list/cust-A/phoned', undefined, 'u-mgr', 'tick-1')).status).toBe(201);
    const again = await req('POST', '/v1/quality/recalls/B-TICK/call-list/cust-A/phoned', undefined, 'u-owner', 'tick-2');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadyTicked: true, phoned: { by: 'u-mgr' } });
    expect((await h.store.readStream(c.T, RECALL_NOTICE_STREAM, { type: RECALL_PHONED_EVENT })).length).toBe(1);

    h = restart(h); // ── COLD RESTART ──
    const after = listOf(await req('GET', '/v1/quality/recalls/B-TICK/notice-list', undefined, 'u-mgr'));
    expect(after.callList.find((e) => e.customerRef === 'cust-A')?.phoned).toMatchObject({ by: 'u-mgr' });
    expect(after.callList.find((e) => e.customerRef === 'cust-B')?.phoned).toBeNull();
    expect(after.phonedCount).toBe(1);

    // The self-confirmation stays as an extra: even with "nobody was phoned" claimed, the tick refuses it BY NAME.
    const refused = await req('POST', '/v1/quality/recalls/B-TICK/withdrawal', { reason: 'typed the wrong batch code', noCustomerPhoned: true }, 'u-mgr');
    expect([refused.status, codeOf(refused)]).toEqual([409, 'recall_customers_already_phoned']);
    const noWord = await req('POST', '/v1/quality/recalls/B-TICK/withdrawal', { reason: 'typed the wrong batch code' }, 'u-mgr');
    expect([noWord.status, codeOf(noWord)]).toEqual([400, 'recall_withdrawal_needs_no_phone_call_confirmed']);
    expect((listOf(await req('GET', '/v1/quality/recalls/B-TICK/notice-list', undefined, 'u-mgr'))).recall.status).toBe('open');

    // The seal: who ticked whom, once.
    const trail = (await h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: c.T, query: { action: 'quality.recall.customer.phoned' } })).body as { matches: { actorId: string; objectId: string; after: Record<string, string> | null }[] };
    expect(trail.matches.map((m) => [m.actorId, m.objectId, m.after?.['phoned']])).toEqual([['u-mgr', 'recall:B-TICK:customer:cust-A', 'yes']]);

    // Then it is closed with evidence; a closed recall takes no new tick.
    expect((await req('POST', '/v1/quality/recalls/B-TICK/closure', { evidenceRef: 'cust-A phoned 11 Jun: told it was a typing mistake' }, 'u-mgr')).status).toBe(200);
    const late = await req('POST', '/v1/quality/recalls/B-TICK/call-list/cust-B/phoned', undefined, 'u-mgr');
    expect([late.status, codeOf(late)]).toEqual([409, 'recall_is_not_open_for_phone_ticks']);
  });

  it('with no tick the withdrawal still goes through on the person\'s own word; a later recall on the same batch starts with no ticks', async () => {
    const c = await cast();
    let h = c.h;
    const req = reqOf(() => h, c.T);
    await setUp(req, 'B-CLEAN');
    const wd = await req('POST', '/v1/quality/recalls/B-CLEAN/withdrawal', { reason: 'typed the wrong batch code', noCustomerPhoned: true }, 'u-mgr');
    expect(wd.status, JSON.stringify(wd.body)).toBe(200);
    // A withdrawn recall takes no tick.
    const onWithdrawn = await req('POST', '/v1/quality/recalls/B-CLEAN/call-list/cust-A/phoned', undefined, 'u-mgr');
    expect([onWithdrawn.status, codeOf(onWithdrawn)]).toEqual([409, 'recall_is_not_open_for_phone_ticks']);

    h = restart(h); // ── COLD RESTART ──
    expect((await req('POST', '/v1/quality/recalls/B-CLEAN', { reason: 'supplier notice after all' }, 'u-mgr')).status).toBe(201);
    expect((await req('POST', '/v1/quality/recalls/B-CLEAN/call-list/cust-B/phoned', undefined, 'u-mgr')).status).toBe(201);
    const list = listOf(await req('GET', '/v1/quality/recalls/B-CLEAN/notice-list', undefined, 'u-mgr'));
    expect(list.callList.map((e) => [e.customerRef, e.phoned?.by ?? null])).toEqual([['cust-A', null], ['cust-B', 'u-mgr']]);
    const refused = await req('POST', '/v1/quality/recalls/B-CLEAN/withdrawal', { reason: 'mistake again', noCustomerPhoned: true }, 'u-mgr');
    expect([refused.status, codeOf(refused)]).toEqual([409, 'recall_customers_already_phoned']);
  });
});
