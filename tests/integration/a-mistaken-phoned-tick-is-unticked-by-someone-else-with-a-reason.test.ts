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
import { RECALL_NOTICE_STREAM, RECALL_PHONED_EVENT, RECALL_UNTICKED_EVENT } from '../../services/api/src/lane2-recall-adapters';

/**
 * **OB-397 (owner decision, 26 Oct 2026) — a mistaken "phoned" tick on a recall call list may be unticked with a written
 * reason by someone other than the person who ticked; both stay on record; the withdrawal is judged on the ticks still
 * standing.** Through the real API, in memory and on real PostgreSQL, with a cold restart:
 *
 *   • the untick needs a reason (refused by name without one); the person who ticked is refused by name; a cashier is
 *     refused; a customer with no tick, or not on the list, is refused by name; nothing is written on a refusal;
 *   • the untick is a compensating event — the tick event is still there beside it (append-only); it is sealed on the audit
 *     trail with its reason; the call list shows both, and the customer as not phoned;
 *   • with a tick still standing on another customer the withdrawal is refused; once no tick stands it goes through;
 *   • a customer unticked and then truly phoned is ticked again — a new tick — and refuses the withdrawal again.
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
type History = { kind: string; by: string; reason?: string };
type CallEntry = { customerRef: string; phoned: { by: string; at: string } | null; phoneHistory: History[] };
const listOf = (r: Res) => r.body as { callList: CallEntry[]; phonedCount: number; recall: { status: string } };

const sale = (saleId: string, batchId: string, customerRef: string) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId: 'S1', cashierId: 'u-owner', tradingDay: '2030-06-10', committedAt: '2030-06-10T10:00:00Z',
  totalMinor: 9_000, currency: 'INR', packVersion: 1, customerRef,
  lines: [{ productId: 'DAL', quantityMinor: 1, uom: 'ea', unitPriceMinor: 9_000, lineTotalMinor: 9_000, batchId }],
  tenders: [{ kind: 'cash', amountMinor: 9_000 }],
});

describe.each(backings)('OB-397: a mistaken "phoned" tick is unticked by someone else, with a reason — on $name', ({ harness, restart }) => {
  it('compensating, audited, both on record; refused by name for the ticker; withdrawal judged on ticks still standing', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-mgr2', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', key?: string): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: key ?? `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const B = 'B-UNTICK';
    expect((await req('POST', '/v1/inventory/movements', { movementId: `rx-${B}`, productId: 'DAL', locationId: 'S1', kind: 'received', quantityMinor: 20, uom: 'ea', occurredAt: '2030-06-01T01:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 4_000, batchId: B, expiry: '2030-12-01' })).status).toBeLessThan(300);
    expect((await req('POST', '/v1/sales', sale('S-A', B, 'cust-A'))).status).toBeLessThan(300);
    expect((await req('POST', '/v1/sales', sale('S-B', B, 'cust-B'))).status).toBeLessThan(300);
    expect((await req('POST', `/v1/quality/recalls/${B}`, { reason: 'typed the wrong batch code' }, 'u-mgr')).status).toBe(201);
    const untick = (customer: string, userId: string, body: unknown = { reason: 'ticked the wrong row by mistake' }, key?: string) =>
      req('POST', `/v1/quality/recalls/${B}/call-list/${customer}/phoned/untick`, body, userId, key);
    const events = async (type: string) => (await h.store.readStream(T, RECALL_NOTICE_STREAM, { type })).length;

    // u-mgr ticks BOTH by mistake (meant only cust-B, who was really phoned).
    expect((await req('POST', `/v1/quality/recalls/${B}/call-list/cust-A/phoned`, undefined, 'u-mgr')).status).toBe(201);
    expect((await req('POST', `/v1/quality/recalls/${B}/call-list/cust-B/phoned`, undefined, 'u-mgr')).status).toBe(201);

    // Refusals, each by name; nothing written.
    expect([await untick('cust-A', 'u-mgr2', {}).then((r) => [r.status, codeOf(r)])]).toEqual([[400, 'recall_untick_needs_a_reason']]);
    expect([await untick('cust-A', 'u-mgr2', { reason: '  ' }).then((r) => [r.status, codeOf(r)])]).toEqual([[400, 'recall_untick_needs_a_reason']]);
    const self = await untick('cust-A', 'u-mgr');
    expect([self.status, codeOf(self)]).toEqual([403, 'recall_untick_by_the_person_who_ticked']);
    expect((await untick('cust-A', 'u-cash')).status).toBe(403);
    const stranger = await untick('cust-Z', 'u-mgr2');
    expect([stranger.status, codeOf(stranger)]).toEqual([404, 'customer_not_on_the_recall_call_list']);
    expect(await events(RECALL_UNTICKED_EVENT)).toBe(0);

    // u-mgr2 takes back the mistaken tick on cust-A, with a reason. A lost reply re-sent is the same untick.
    const ok = await untick('cust-A', 'u-mgr2', { reason: 'ticked the wrong row by mistake' }, 'untick-1');
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ untick: { tickedBy: 'u-mgr', untickedBy: 'u-mgr2', reason: 'ticked the wrong row by mistake' }, ticksStillStanding: 1 });
    expect((await untick('cust-A', 'u-mgr2', { reason: 'ticked the wrong row by mistake' }, 'untick-1')).status).toBe(201);
    const twice = await untick('cust-A', 'u-owner');
    expect([twice.status, codeOf(twice)]).toEqual([409, 'recall_customer_not_ticked_as_phoned']);
    // Append-only: the tick is still there beside its untick.
    expect([await events(RECALL_PHONED_EVENT), await events(RECALL_UNTICKED_EVENT)]).toEqual([2, 1]);

    h = restart(h); // ── COLD RESTART ──
    const list = listOf(await req('GET', `/v1/quality/recalls/${B}/notice-list`, undefined, 'u-mgr'));
    const a = list.callList.find((e) => e.customerRef === 'cust-A')!;
    expect(a.phoned).toBeNull();
    expect(a.phoneHistory).toEqual([
      expect.objectContaining({ kind: 'ticked', by: 'u-mgr' }),
      expect.objectContaining({ kind: 'unticked', by: 'u-mgr2', reason: 'ticked the wrong row by mistake' }),
    ]);
    expect(list.phonedCount).toBe(1);

    // cust-B's tick still stands: the withdrawal is refused by name.
    const refused = await req('POST', `/v1/quality/recalls/${B}/withdrawal`, { reason: 'typed the wrong batch code', noCustomerPhoned: true }, 'u-mgr');
    expect([refused.status, codeOf(refused)]).toEqual([409, 'recall_customers_already_phoned']);

    // The seal: who took back whose tick, and why.
    const trail = (await h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: T, query: { action: 'quality.recall.customer.unticked' } })).body as { matches: { actorId: string; objectId: string; reason?: string; before: Record<string, string> | null }[] };
    expect(trail.matches.map((m) => [m.actorId, m.objectId, m.reason, m.before?.['phonedBy']])).toEqual([['u-mgr2', `recall:${B}:customer:cust-A`, 'ticked the wrong row by mistake', 'u-mgr']]);

    // cust-A is truly phoned later: a NEW tick (the next round), by the owner this time; it stands again.
    const reTick = await req('POST', `/v1/quality/recalls/${B}/call-list/cust-A/phoned`, undefined, 'u-owner');
    expect(reTick.status, JSON.stringify(reTick.body)).toBe(201);
    expect(reTick.body).toMatchObject({ alreadyTicked: false, phoned: { by: 'u-owner' } });
    expect(listOf(await req('GET', `/v1/quality/recalls/${B}/notice-list`, undefined, 'u-mgr')).callList.find((e) => e.customerRef === 'cust-A')!.phoneHistory.map((x) => x.kind)).toEqual(['ticked', 'unticked', 'ticked']);
    // …and that one can be taken back too, by someone other than the owner.
    expect(codeOf(await untick('cust-A', 'u-owner'))).toBe('recall_untick_by_the_person_who_ticked');
    expect((await untick('cust-A', 'u-mgr2', { reason: 'owner ticked the wrong customer' })).status).toBe(201);
    // cust-B: also a mistake after all — taken back by u-mgr2; no tick stands, so the withdrawal goes through.
    expect((await untick('cust-B', 'u-mgr2', { reason: 'cust-B was not reached, wrong number' })).status).toBe(201);
    const wd = await req('POST', `/v1/quality/recalls/${B}/withdrawal`, { reason: 'typed the wrong batch code', noCustomerPhoned: true }, 'u-mgr');
    expect(wd.status, JSON.stringify(wd.body)).toBe(200);
    // A withdrawn recall takes no more unticks.
    expect(codeOf(await untick('cust-B', 'u-owner'))).toBe('recall_is_not_open_for_phone_ticks');
  }, 60_000);
});
