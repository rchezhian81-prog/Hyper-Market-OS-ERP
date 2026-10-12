import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **WF-08 · OB-59 — a plain warehouse transfer asks the count freeze like every other direct head-office movement.**
 *
 * Before: `POST /v1/warehouse/transfers/:id/receive` posted `transferred_in` at a place where an open count had EXPLICITLY
 * frozen `transferred_in`, and the plan only showed it afterwards as a freeze breach; the dispatch posted `transferred_out`
 * the same way. Every other direct head-office route refuses a frozen kind by name (relayed box records are the ones
 * kept-and-shown). Now, on the real API — in memory and, with DATABASE_URL, on real PostgreSQL:
 *
 *   • an open plan at S1 that names `transferred_in` and `transferred_out` for P1: the receipt INTO S1 and the dispatch OUT
 *     OF S1 are each refused 409 `frozen_by_a_stock_count` in the same words as the other refusals; nothing is written (the
 *     transfer keeps its state, on-hand and the movement ledger are unchanged, the plan shows NO breach);
 *   • a product the plan does not count (P2) and the other end of a transfer (WH) are not frozen — they go through;
 *   • re-sending the refused receipt (same key) is refused again — a refusal is never banked as success;
 *   • once the plan is cancelled the same receipt and dispatch land — exactly once (a replay collapses);
 *   • the owner's DEFAULT freeze (adjustments & write-offs, OB-59) leaves transfers alone: receipt and dispatch land with
 *     the plan open, and the plan shows no breach for them.
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
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const SEED_AT = '2026-08-01T00:00:00.000Z';
const line = (productId: string, quantityMinor: number) => ({ productId, batchId: null, quantityMinor, uom: 'EA', unitCost: { minor: 100, currency: 'INR' } });

describe.each(backings)('a plain transfer asks the count freeze at both ends — on $name (WF-08 · OB-59)', ({ harness }) => {
  const shop = async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    for (const u of ['u-plan', 'u-mgr', 'u-c1']) await h.provisionRole(T, u, 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    let n = 0;
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, opts: { query?: Record<string, string>; key?: string } = {}): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(opts.query === undefined ? {} : { query: opts.query }), ...(method === 'GET' ? {} : { idempotencyKey: opts.key ?? `k-${n += 1}` }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const onHand = async (p: string, loc: string): Promise<number> =>
      ((await call('GET', '/v1/inventory/availability', 'u-owner', undefined, { query: { productId: p } })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows.filter((r) => r.locationId === loc).reduce((s, r) => s + r.onHandMinor, 0);
    const moves = async (): Promise<number> => (await h.store.readStream(T, STREAM.inventory, { type: 'InventoryMoved' })).length;
    const state = async (t: string): Promise<string> => ((await call('GET', `/v1/warehouse/transfers/${t}`, 'u-owner')).body as { state: string }).state;
    await ok(call('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(call('POST', '/v1/org/nodes/S1', 'u-owner', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'store');
    await ok(call('POST', '/v1/org/nodes/WH', 'u-owner', { kind: 'warehouse', name: 'Central warehouse', parentId: 'C1', companyId: 'C1' }), 'warehouse');
    for (const [id, p, loc, q] of [['s1-p1', 'P1', 'S1', 100], ['s1-p2', 'P2', 'S1', 50], ['wh-p1', 'P1', 'WH', 40], ['wh-p2', 'P2', 'WH', 40]] as const) {
      await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: id, productId: p, locationId: loc, kind: 'received', quantityMinor: q, uom: 'EA', occurredAt: SEED_AT, enteredBy: 'u-owner', unitCostMinor: 100 }), `seed ${id}`);
    }
    // Proposed by the owner, dispatched by a manager (§28: the proposer does not approve their own), counted in by another.
    const propose = (t: string, from: string, to: string, p: string, q: number) => ok(call('POST', `/v1/warehouse/transfers/${t}`, 'u-owner', { fromLocationId: from, toLocationId: to, lines: [line(p, q)] }), `propose ${t}`);
    const dispatch = (t: string, key?: string) => call('POST', `/v1/warehouse/transfers/${t}/dispatch`, 'u-mgr', {}, key === undefined ? {} : { key });
    const receive = (t: string, p: string, q: number, key?: string) => call('POST', `/v1/warehouse/transfers/${t}/receive`, 'u-c1', { counted: [{ productId: p, batchId: null, quantityMinor: q }] }, key === undefined ? {} : { key });
    const plan = async (planId: string, frozenKinds?: string[]) => {
      await ok(call('POST', `/v1/inventory/count-plans/${planId}`, 'u-plan', { locationId: 'S1', productIds: ['P1'], recountThresholdMinor: 1_000_000, note: 'aisle 4', ...(frozenKinds === undefined ? {} : { frozenKinds }) }), 'plan');
      await ok(call('POST', `/v1/inventory/count-plans/${planId}/open`, 'u-plan', {}), 'open');
    };
    const breaches = async (planId: string) => ((await call('GET', `/v1/inventory/count-plans/${planId}`, 'u-plan')).body as { freezeBreaches: { kind: string }[] }).freezeBreaches;
    return { call, ok, onHand, moves, state, propose, dispatch, receive, plan, breaches };
  };

  it('an explicit transferred_in / transferred_out freeze refuses the receipt and the dispatch by name, writing nothing; once cancelled they land once', async () => {
    const { call, ok, onHand, moves, state, propose, dispatch, receive, plan, breaches } = await shop();
    // In flight before the count: P1 and P2 from the warehouse into S1 (dispatched), and P1 from S1 out to the warehouse.
    await propose('t-in', 'WH', 'S1', 'P1', 10);
    await ok(dispatch('t-in'), 'dispatch t-in');
    await propose('t-in-p2', 'WH', 'S1', 'P2', 5);
    await ok(dispatch('t-in-p2'), 'dispatch t-in-p2');
    await propose('t-out', 'S1', 'WH', 'P1', 5);
    await propose('t-wh', 'WH', 'S1', 'P1', 3); // its dispatch leaves the warehouse, which nobody is counting

    await plan('cp1', ['transferred_in', 'transferred_out']);
    const before = [await onHand('P1', 'S1'), await onHand('P1', 'WH'), await moves()];

    // ── The receipt INTO the counted place: refused by name, nothing written ─────────────────────────────────────
    const inRefused = await receive('t-in', 'P1', 10, 'rcv-t-in');
    expect([inRefused.status, codeOf(inRefused)]).toEqual([409, 'frozen_by_a_stock_count']);
    expect((inRefused.body as { error: { whatHappened: string; wasItSaved: string } }).error).toMatchObject({
      whatHappened: 'P1 is being counted at S1 under count plan cp1, which freezes "transferred_in" movements there until the count is approved or cancelled — so this transfer receipt cannot be recorded now (OB-59).',
      wasItSaved: 'not_saved',
    });
    expect(await state('t-in')).toBe('in_transit');
    // The same request again is refused again — a refusal is never banked as a success.
    expect(codeOf(await receive('t-in', 'P1', 10, 'rcv-t-in'))).toBe('frozen_by_a_stock_count');

    // ── The dispatch OUT OF the counted place: refused by name, nothing written ──────────────────────────────────
    const outRefused = await dispatch('t-out', 'dsp-t-out');
    expect([outRefused.status, codeOf(outRefused)]).toEqual([409, 'frozen_by_a_stock_count']);
    expect((outRefused.body as { error: { whatHappened: string } }).error.whatHappened).toBe('P1 is being counted at S1 under count plan cp1, which freezes "transferred_out" movements there until the count is approved or cancelled — so this transfer dispatch cannot be recorded now (OB-59).');
    expect(await state('t-out')).toBe('proposed');
    expect([await onHand('P1', 'S1'), await onHand('P1', 'WH'), await moves()]).toEqual(before);
    expect(await breaches('cp1'), 'a refusal is not a breach — nothing landed').toEqual([]);

    // ── Not frozen: a product the plan does not count, and the far end nobody is counting ────────────────────────
    expect((await receive('t-in-p2', 'P2', 5)).status).toBe(200);
    expect((await dispatch('t-wh')).status).toBe(200);
    expect(await breaches('cp1')).toEqual([]);
    // A role without the movement right is refused before any of it (403).
    expect((await call('POST', '/v1/warehouse/transfers/t-in/receive', 'u-cash', { counted: [{ productId: 'P1', batchId: null, quantityMinor: 10 }] })).status).toBe(403);

    // ── The freeze is what refused them: once the plan is cancelled, they land — once ────────────────────────────
    await ok(call('POST', '/v1/inventory/count-plans/cp1/cancel', 'u-plan', { reason: 'aisle reset' }), 'cancel');
    const p1S1 = await onHand('P1', 'S1');
    expect((await receive('t-in', 'P1', 10, 'rcv-t-in-2')).status).toBe(200);
    expect((await receive('t-in', 'P1', 10, 'rcv-t-in-2')).status).toBe(200); // the replay answers the first result
    expect(await state('t-in')).toBe('received');
    expect(await onHand('P1', 'S1')).toBe(p1S1 + 10);
    expect((await dispatch('t-out', 'dsp-t-out-2')).status).toBe(200);
    expect((await dispatch('t-out', 'dsp-t-out-2')).status).toBe(200);
    expect(await onHand('P1', 'S1')).toBe(p1S1 + 10 - 5);
  }, 60_000);

  it('the owner\'s default freeze (adjustments & write-offs) leaves transfers alone at the counted place', async () => {
    const { ok, onHand, state, propose, dispatch, receive, plan, breaches } = await shop();
    await propose('t-in', 'WH', 'S1', 'P1', 10);
    await ok(dispatch('t-in'), 'dispatch t-in');
    await propose('t-out', 'S1', 'WH', 'P1', 5);
    await plan('cp2'); // no frozen kinds named → OB-59 default
    const p1 = await onHand('P1', 'S1');
    expect((await receive('t-in', 'P1', 10)).status).toBe(200);
    expect((await dispatch('t-out')).status).toBe(200);
    expect([await state('t-in'), await state('t-out')]).toEqual(['received', 'in_transit']);
    expect(await onHand('P1', 'S1')).toBe(p1 + 10 - 5);
    expect(await breaches('cp2')).toEqual([]);
  }, 60_000);
});
