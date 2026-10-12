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
 * **OB-79 "A" (owner, 12 Oct 2026, in writing, "Yes, stop it") — floor restocking under a count that EXPLICITLY freezes
 * transfers (WF-08 · OB-59 · OB-66 · M09-FR-03 · P-08 · hard rules #2 #10).**
 *
 * Before: the direct floor-indent ISSUE (`POST /v1/floor/indents/:id/issues/:issueId`, `transferred_out` at the back store)
 * and the direct floor RECEIPT (`…/receipt`, `transferred_in` at the shelf) never asked the count freeze, so a planner who
 * ticked "transfers" still saw the shelf restocked under the count and only learnt of it as a breach. Now, on the real API —
 * in memory and, with DATABASE_URL, on real PostgreSQL:
 *
 *   • an open plan at the SHELF that names `transferred_in` for P1: the direct receipt is refused 409
 *     `frozen_by_a_stock_count` by name (same words as the plain transfer refusal), nothing written — the issue stays in
 *     transit, on-hand and the movement ledger unchanged, the plan shows no breach; a re-send is refused again;
 *   • an open plan at the BACK STORE that names `transferred_out` for P1: the direct issue is refused the same way — no issue
 *     recorded, no transfer, nothing moved;
 *   • not frozen: a product the plan does not count (P2) goes through; a role without the movement right is refused 403;
 *   • a RELAYED receipt (`…/receipt/synced`, the box's fact) under the same freeze is KEPT (202) and SHOWN on the plan as a
 *     freeze breach — never refused into the void;
 *   • once the plans are cancelled the refused issue and receipt land — exactly once (a replay collapses);
 *   • the owner's DEFAULT freeze (adjustments & write-offs) leaves issue and receipt alone, and a damaged unit on that receipt
 *     is still HELD on the plan (OB-66, unchanged).
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
const whatOf = (r: Res): string | undefined => (r.body as { error?: { whatHappened?: string } }).error?.whatHappened;
const SEED_AT = '2026-08-01T00:00:00.000Z';
const BACK = 'S1-BACK';
const FLOOR = 'S1';

describe.each(backings)('OB-79 — the direct floor-indent issue and receipt ask an explicit transfer freeze — on $name', ({ harness }) => {
  const shop = async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    for (const u of ['u-plan', 'u-appr', 'u-back', 'u-floor']) await h.provisionRole(T, u, 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.provisionRole(T, 'u-box', 'store_computer', [FLOOR]);
    let n = 0;
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, opts: { query?: Record<string, string>; key?: string } = {}): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(opts.query === undefined ? {} : { query: opts.query }), ...(method === 'GET' ? {} : { idempotencyKey: opts.key ?? `k-${n += 1}` }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const onHand = async (p: string, loc: string): Promise<number> =>
      ((await call('GET', '/v1/inventory/availability', 'u-owner', undefined, { query: { productId: p } })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows.filter((r) => r.locationId === loc).reduce((s, r) => s + r.onHandMinor, 0);
    const moves = async (): Promise<number> => (await h.store.readStream(T, STREAM.inventory, { type: 'InventoryMoved' })).length;
    const indent = async (id: string) => (await call('GET', `/v1/floor/indents/${id}`, 'u-owner')).body as { state: string; issues: { issueId: string; state: string }[] };
    await ok(call('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(call('POST', `/v1/org/nodes/${FLOOR}`, 'u-owner', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'store');
    await ok(call('POST', `/v1/org/nodes/${BACK}`, 'u-owner', { kind: 'warehouse', name: 'Store 1 back store', parentId: FLOOR, companyId: 'C1' }), 'back store');
    for (const [id, p, loc, q] of [['b-p1', 'P1', BACK, 100], ['b-p2', 'P2', BACK, 50], ['f-p1', 'P1', FLOOR, 20]] as const) {
      await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: id, productId: p, locationId: loc, kind: 'received', quantityMinor: q, uom: 'EA', occurredAt: SEED_AT, enteredBy: 'u-owner', unitCostMinor: 100 }), `seed ${id}`);
    }
    /** Asked by the planner, approved by a second manager — ready to be issued by the back store. */
    const askAndApprove = async (id: string, p: string, q: number) => {
      await ok(call('POST', `/v1/floor/indents/${id}`, 'u-plan', { fromLocationId: BACK, toLocationId: FLOOR, lines: [{ productId: p, quantityMinor: q, uom: 'EA' }], reason: 'shelf 4 empty' }), `ask ${id}`);
      await ok(call('POST', `/v1/floor/indents/${id}/approval`, 'u-appr', {}), `approve ${id}`);
    };
    const issue = (id: string, p: string, q: number, key?: string, by = 'u-back') => call('POST', `/v1/floor/indents/${id}/issues/is-1`, by, { lines: [{ productId: p, batchId: null, quantityMinor: q }] }, key === undefined ? {} : { key });
    const receive = (id: string, p: string, q: number, key?: string, damagedMinor?: number, by = 'u-floor') =>
      call('POST', `/v1/floor/indents/${id}/issues/is-1/receipt`, by, { counted: [{ productId: p, batchId: null, quantityMinor: q, ...(damagedMinor === undefined ? {} : { damagedMinor }) }] }, key === undefined ? {} : { key });
    const plan = async (planId: string, locationId: string, frozenKinds?: string[]) => {
      await ok(call('POST', `/v1/inventory/count-plans/${planId}`, 'u-plan', { locationId, productIds: ['P1'], recountThresholdMinor: 1_000_000, note: 'aisle 4', ...(frozenKinds === undefined ? {} : { frozenKinds }) }), `plan ${planId}`);
      await ok(call('POST', `/v1/inventory/count-plans/${planId}/open`, 'u-plan', {}), `open ${planId}`);
    };
    const breaches = async (planId: string) => ((await call('GET', `/v1/inventory/count-plans/${planId}`, 'u-plan')).body as { freezeBreaches: { kind: string; movementId: string }[] }).freezeBreaches;
    const view = async (planId: string) => (await call('GET', `/v1/inventory/count-plans/${planId}`, 'u-plan')).body as { heldWriteOffs: { heldId: string; state: string }[] };
    return { call, ok, onHand, moves, indent, askAndApprove, issue, receive, plan, breaches, view };
  };

  it('an explicit freeze refuses the direct issue and receipt by name, writing nothing; a relayed receipt is kept and shown; once cancelled they land once', async () => {
    const { call, ok, onHand, moves, indent, askAndApprove, issue, receive, plan, breaches } = await shop();
    // In flight before the counts: P1 and P2 issued to the shelf (in transit); a second P1 indent approved but not issued.
    await askAndApprove('ind-in', 'P1', 10);
    await ok(issue('ind-in', 'P1', 10), 'issue ind-in');
    await askAndApprove('ind-p2', 'P2', 5);
    await ok(issue('ind-p2', 'P2', 5), 'issue ind-p2');
    await askAndApprove('ind-relay', 'P1', 4);
    await ok(issue('ind-relay', 'P1', 4), 'issue ind-relay');
    await askAndApprove('ind-out', 'P1', 6);

    await plan('cp-shelf', FLOOR, ['transferred_in']);
    await plan('cp-back', BACK, ['transferred_out']);
    const before = [await onHand('P1', FLOOR), await onHand('P1', BACK), await moves()];

    // ── The receipt ONTO the counted shelf: refused by name, nothing written ─────────────────────────────────────
    const inRefused = await receive('ind-in', 'P1', 10, 'rcv-in');
    expect([inRefused.status, codeOf(inRefused)]).toEqual([409, 'frozen_by_a_stock_count']);
    expect(whatOf(inRefused)).toBe('P1 is being counted at S1 under count plan cp-shelf, which freezes "transferred_in" movements there until the count is approved or cancelled — so this floor-indent receipt cannot be recorded now (OB-59).');
    expect((inRefused.body as { error: { wasItSaved: string } }).error.wasItSaved).toBe('not_saved');
    expect((await indent('ind-in')).issues.map((i) => i.state)).toEqual(['in_transit']);
    expect(codeOf(await receive('ind-in', 'P1', 10, 'rcv-in')), 'a refusal is never banked as success').toBe('frozen_by_a_stock_count');

    // ── The issue OUT OF the counted back store: refused by name, nothing written ────────────────────────────────
    const outRefused = await issue('ind-out', 'P1', 6, 'iss-out');
    expect([outRefused.status, codeOf(outRefused)]).toEqual([409, 'frozen_by_a_stock_count']);
    expect(whatOf(outRefused)).toBe('P1 is being counted at S1-BACK under count plan cp-back, which freezes "transferred_out" movements there until the count is approved or cancelled — so this floor-indent issue cannot be recorded now (OB-59).');
    const out = await indent('ind-out');
    expect([out.state, out.issues]).toEqual(['approved', []]);
    expect((await call('GET', '/v1/warehouse/transfers/ind-out:is-1', 'u-owner')).status, 'no transfer was created').toBe(404);
    expect([await onHand('P1', FLOOR), await onHand('P1', BACK), await moves()]).toEqual(before);
    expect(await breaches('cp-shelf'), 'a refusal is not a breach — nothing landed').toEqual([]);
    expect(await breaches('cp-back')).toEqual([]);

    // ── Not frozen: a product the plans do not count; and a role without the right is refused before any of it ───
    expect((await receive('ind-p2', 'P2', 5)).status).toBe(201);
    expect((await receive('ind-in', 'P1', 10, undefined, undefined, 'u-cash')).status).toBe(403);
    expect((await issue('ind-out', 'P1', 6, undefined, 'u-cash')).status).toBe(403);

    // ── A RELAYED receipt is a fact that already happened: kept (202) and shown on the plan as a freeze breach ────
    const relayed = await call('POST', '/v1/floor/indents/ind-relay/issues/is-1/receipt/synced', 'u-box', {
      indentId: 'ind-relay', issueId: 'is-1', counted: [{ productId: 'P1', batchId: null, quantityMinor: 4 }], receivedBy: 'u-floor', at: new Date().toISOString(), storeId: FLOOR, source: 'indents-screen',
    });
    expect(relayed.status, JSON.stringify(relayed.body)).toBe(202);
    expect((await breaches('cp-shelf')).map((b) => b.kind)).toEqual(['transferred_in']);
    expect(await onHand('P1', FLOOR)).toBe((before[0] as number) + 4);

    // ── The freeze is what refused them: once the plans are cancelled, they land — once ──────────────────────────
    await ok(call('POST', '/v1/inventory/count-plans/cp-shelf/cancel', 'u-plan', { reason: 'aisle reset' }), 'cancel shelf');
    await ok(call('POST', '/v1/inventory/count-plans/cp-back/cancel', 'u-plan', { reason: 'aisle reset' }), 'cancel back');
    const shelf = await onHand('P1', FLOOR);
    expect((await receive('ind-in', 'P1', 10, 'rcv-in-2')).status).toBe(201);
    expect((await receive('ind-in', 'P1', 10, 'rcv-in-2')).status, 'the replay answers the first result').toBe(201);
    expect((await receive('ind-in', 'P1', 10, 'rcv-in-3')).body).toMatchObject({ alreadyReceived: true });
    expect(await onHand('P1', FLOOR)).toBe(shelf + 10);
    const back = await onHand('P1', BACK);
    expect((await issue('ind-out', 'P1', 6, 'iss-out-2')).status).toBe(201);
    expect((await issue('ind-out', 'P1', 6, 'iss-out-3')).body).toMatchObject({ alreadyIssued: true });
    expect(await onHand('P1', BACK)).toBe(back - 6);
  }, 90_000);

  it('the owner\'s default freeze (adjustments & write-offs) leaves issue and receipt alone, and a damaged unit is still held on the plan (OB-66)', async () => {
    const { ok, onHand, askAndApprove, issue, receive, plan, breaches, view } = await shop();
    await askAndApprove('ind-in', 'P1', 6);
    await ok(issue('ind-in', 'P1', 6), 'issue ind-in');
    await askAndApprove('ind-out', 'P1', 3);
    await plan('cp-shelf', FLOOR); // no frozen kinds named → OB-59 default
    await plan('cp-back', BACK);
    const shelf = await onHand('P1', FLOOR);
    const rcv = await receive('ind-in', 'P1', 5, undefined, 1);
    expect(rcv.status, JSON.stringify(rcv.body)).toBe(201);
    expect((rcv.body as { heldWriteOffs: { planId: string; quantityMinor: number }[] }).heldWriteOffs.map((x) => [x.planId, x.quantityMinor])).toEqual([['cp-shelf', 1]]);
    expect(await onHand('P1', FLOOR)).toBe(shelf + 5);
    expect((await view('cp-shelf')).heldWriteOffs.map((x) => x.state)).toEqual(['awaiting_close']);
    expect((await issue('ind-out', 'P1', 3)).status).toBe(201);
    expect(await breaches('cp-shelf')).toEqual([]);
    expect(await breaches('cp-back')).toEqual([]);
  }, 90_000);
});
