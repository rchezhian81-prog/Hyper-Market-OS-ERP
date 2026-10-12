import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/day-book';
import { STREAM } from '../../services/api/src/adapters';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **OB-66 "A" (owner, 11 Oct 2026, in writing, "Receive good, hold damaged") — a floor transfer arriving with damaged units at
 * a place under an open count (WF-08 · OB-59 · M08 · M28-FR-01 · M23 · P-08 · hard rules #2 #6 #10).**
 *
 * On the real head-office API (in memory and, with DATABASE_URL, on real PostgreSQL): the floor S1 holds 20 of P2 (₹10 each);
 * the back store sends 6 more on a floor indent. A count of P2 at S1 opens with the owner's default freeze (adjustments and
 * write-offs). The trolley arrives: 5 good, 1 damaged.
 *
 *   • The GOOD units are received at once — on the shelf, sellable (25) — and the damaged unit's write-off is HELD on the count
 *     plan (shown on its view beside the freeze breaches), NOT on hand: the counter counts the shelf (24 — one really is
 *     missing) and the variance is −1, never −2 (the damaged unit does not fake a count difference).
 *   • The month-end stock adjustment waits for the held write-off by name (never closed around it).
 *   • A second person approves the count: the −1 posts as ONE count correction, and the held write-off is applied ONCE —
 *     the damaged unit in and written off on the write-off register (on-hand stays at the counted 24). A re-sent approval
 *     applies nothing twice.
 *   • The books: the ONE stock-adjustment posting run books the count shortage and the write-off once each (inventory_loss
 *     ₹10, inventory_write_off ₹10); a re-run posts nothing; the month-end adjustment then books cost of goods sold ₹0 (nothing
 *     was sold — no loss counted twice) and the close's stock-value check agrees with the books.
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
const PERIOD = new Date().toISOString().slice(0, 7);
const TODAY = new Date().toISOString().slice(0, 10);
const HELD = 'ind-1:is-1-damaged-1';

describe.each(backings)('OB-66 — a damaged arrival under an open count: good units received, the write-off held and applied once — on $name', ({ harness }) => {
  it('receives the good units at once, holds the damaged write-off on the plan, applies it once at the close, and the books follow once', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    for (const u of ['u-plan', 'u-c1', 'u-appr', 'u-back', 'u-floor']) await h.provisionRole(T, u, 'store_manager');
    await h.provisionRole(T, 'u-acct', 'accountant');
    let n = 0;
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}` }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const onHand = async (loc = 'S1'): Promise<number> =>
      ((await call('GET', '/v1/inventory/availability', 'u-owner', undefined, { productId: 'P2' })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows.filter((r) => r.locationId === loc).reduce((s, r) => s + r.onHandMinor, 0);
    const movementIds = async (): Promise<string[]> => (await h.store.readStream(T, STREAM.inventory, { type: 'InventoryMoved' })).map((e) => (e.event.payload as { movementId: string }).movementId);
    const view = async () => (await call('GET', '/v1/inventory/count-plans/cp1', 'u-plan')).body as {
      plan: { state: string }; freezeBreaches: unknown[]; lines: { productId: string; state: string; varianceMinor: number; finalCountId: string }[];
      heldWriteOffs: { heldId: string; planId: string; quantityMinor: number; valueMinor: number; state: string; applied: { writeOffId: string; outcome: string } | null }[];
    };

    await ok(call('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(call('POST', '/v1/org/nodes/S1', 'u-owner', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'store');
    await ok(call('POST', '/v1/org/nodes/S1-BACK', 'u-owner', { kind: 'warehouse', name: 'Store 1 back store', parentId: 'S1', companyId: 'C1' }), 'back store');
    for (const [id, loc, qty] of [['s-floor', 'S1', 20], ['s-back', 'S1-BACK', 10]] as const) {
      await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: id, productId: 'P2', locationId: loc, kind: 'received', quantityMinor: qty, uom: 'EA', occurredAt: new Date(Date.now() - 60_000).toISOString(), enteredBy: 'u-owner', unitCostMinor: 1_000 }), id);
    }
    // The back store sends 6 to the floor — in transit when the count opens.
    await ok(call('POST', '/v1/floor/indents/ind-1', 'u-plan', { fromLocationId: 'S1-BACK', toLocationId: 'S1', lines: [{ productId: 'P2', quantityMinor: 6, uom: 'EA' }], reason: 'shelf 4 empty' }), 'indent');
    await ok(call('POST', '/v1/floor/indents/ind-1/approval', 'u-appr', {}), 'indent approval');
    await ok(call('POST', '/v1/floor/indents/ind-1/issues/is-1', 'u-back', { lines: [{ productId: 'P2', batchId: null, quantityMinor: 6 }] }), 'issue');

    // ── The count opens with the owner's default freeze (OB-59: adjustments and write-offs).
    await ok(call('POST', '/v1/inventory/count-plans/cp1', 'u-plan', { locationId: 'S1', productIds: ['P2'], recountThresholdMinor: 1_000_000, note: 'aisle 4' }), 'plan');
    await ok(call('POST', '/v1/inventory/count-plans/cp1/open', 'u-plan', {}), 'open');

    // ── The trolley arrives: 5 good, 1 damaged. Received at once — not refused (round 10 refused the whole receipt).
    const rcv = await call('POST', '/v1/floor/indents/ind-1/issues/is-1/receipt', 'u-floor', { counted: [{ productId: 'P2', batchId: null, quantityMinor: 5, damagedMinor: 1 }] });
    expect(rcv.status, JSON.stringify(rcv.body)).toBe(201);
    const rb = rcv.body as { heldWriteOffs: { heldId: string; planId: string; quantityMinor: number; valueMinor: number }[]; damaged: { heldForCount?: string }[] };
    expect(rb.heldWriteOffs.map((x) => [x.heldId, x.planId, x.quantityMinor, x.valueMinor])).toEqual([[HELD, 'cp1', 1, 1_000]]);
    expect(rb.damaged).toEqual([expect.objectContaining({ quantityMinor: 1, heldForCount: 'cp1' })]);
    // The good units are on the shelf; the damaged unit is NOT on hand and NOT written off yet.
    expect(await onHand()).toBe(25);
    expect(await onHand('S1-BACK')).toBe(4);
    expect((await movementIds()).filter((id) => id.includes('damaged') || id.includes('held'))).toEqual([]);
    expect(((await call('GET', '/v1/inventory/write-offs', 'u-owner')).body as { writeOffs: unknown[] }).writeOffs).toEqual([]);
    // On the plan's view, beside its freeze breaches (none: nothing frozen was written).
    let v = await view();
    expect(v.freezeBreaches).toEqual([]);
    expect(v.heldWriteOffs.map((x) => [x.heldId, x.state, x.applied])).toEqual([[HELD, 'awaiting_close', null]]);
    // A re-sent receipt holds nothing twice.
    expect((await call('POST', '/v1/floor/indents/ind-1/issues/is-1/receipt', 'u-floor', { counted: [{ productId: 'P2', batchId: null, quantityMinor: 5, damagedMinor: 1 }] })).body).toMatchObject({ alreadyReceived: true });
    expect((await view()).heldWriteOffs).toHaveLength(1);

    // ── The counter counts the SHELF: 24 (one unit really is missing). Judged against 25 — the variance is −1, not −2.
    await ok(call('POST', '/v1/inventory/count-plans/cp1/counts/k1', 'u-c1', { productId: 'P2', locationId: 'S1', uom: 'EA', countedMinor: 24 }), 'count');
    v = await view();
    expect(v.lines.map((l) => [l.productId, l.state, l.varianceMinor])).toEqual([['P2', 'cause_required', -1]]);

    // ── The month-end adjustment waits for the held write-off by name — the books are never closed around it.
    await ok(call('PUT', '/v1/finance/posting-map', 'u-acct', DEFAULT_RETAIL_POSTING_MAP), 'map');
    const early = await call('POST', `/v1/finance/periods/${PERIOD}/stock-adjustment`, 'u-acct', {});
    expect(codeOf(early)).toBe('stock_postings_outstanding');
    expect((early.body as { error: { whatHappened: string } }).error.whatHappened).toContain(`held_write_off:${HELD} (held for count plan cp1)`);

    // ── A second person approves: the −1 posts once; the held write-off is applied ONCE at the close.
    await ok(call('POST', '/v1/inventory/count-plans/cp1/counts/k1/cause', 'u-plan', { causeCode: 'theft_suspected', note: 'one tin missing from the front' }), 'cause');
    const appr = await ok(call('POST', '/v1/inventory/count-plans/cp1/approve', 'u-appr', { reason: 'aisle 4 done' }), 'approve');
    expect((appr.body as { heldWriteOffsApplied: { writeOffId: string; outcome: string }[] }).heldWriteOffsApplied.map((a) => [a.writeOffId, a.outcome])).toEqual([[`held-${HELD}`, 'approved']]);
    expect(await onHand()).toBe(24); // the counted shelf: the damaged unit came in and went out as a write-off
    const again = await ok(call('POST', '/v1/inventory/count-plans/cp1/approve', 'u-appr', { reason: 'aisle 4 done' }), 'approve again');
    expect(again.body).toMatchObject({ alreadyApproved: true, heldWriteOffsApplied: [] });
    const ids = await movementIds();
    expect(ids.filter((id) => id === `${HELD}-held-in`)).toHaveLength(1);
    expect(ids.filter((id) => id === `writeoff-held-${HELD}`)).toHaveLength(1);
    expect(ids.filter((id) => id === 'count:k1')).toHaveLength(1);
    const wos = ((await call('GET', '/v1/inventory/write-offs', 'u-owner')).body as { writeOffs: { id: string; qtyRemoved: number; valueMinor: number; reasonCode: string; lossType: string }[] }).writeOffs;
    expect(wos.map((w) => [w.id, w.qtyRemoved, w.valueMinor, w.reasonCode, w.lossType])).toEqual([[`held-${HELD}`, 1, 1_000, 'arrived_damaged', 'damage']]);
    v = await view();
    expect(v.plan.state).toBe('approved');
    expect(v.freezeBreaches).toEqual([]); // its own applied write-off is not a breach of its freeze
    expect(v.heldWriteOffs.map((x) => [x.state, x.applied?.writeOffId, x.applied?.outcome])).toEqual([['applied', `held-${HELD}`, 'approved']]);
    expect(await onHand()).toBe(24);

    // ── The books: ONE posting run books the count shortage and the write-off once each; a re-run posts nothing.
    const run = await ok(call('POST', '/v1/finance/stock-adjustments/post', 'u-acct', {}), 'post');
    const journals = (run.body as { posted: { entryId: string; lines: { accountCode: string; debitMinor: number; creditMinor: number }[] }[] }).posted;
    expect(journals.map((j) => [j.entryId, j.lines]).sort()).toEqual([
      ['stock-adjustment:count:k1', [{ accountCode: 'inventory_loss', debitMinor: 1_000, creditMinor: 0 }, { accountCode: 'inventory', debitMinor: 0, creditMinor: 1_000 }]],
      [`stock-adjustment:write_off:held-${HELD}`, [{ accountCode: 'inventory_write_off', debitMinor: 1_000, creditMinor: 0 }, { accountCode: 'inventory', debitMinor: 0, creditMinor: 1_000 }]],
    ].sort());
    expect((await call('POST', '/v1/finance/stock-adjustments/post', 'u-acct', {})).body).toMatchObject({ posted: [] });
    const ledger = (await h.store.readStream(T, 'finance', { type: 'JournalPosted' })).map((e) => (e.event.payload as { entryId: string }).entryId);
    expect(ledger.filter((id) => id === `stock-adjustment:write_off:held-${HELD}`)).toHaveLength(1);

    // ── The month end: stock in the books −₹20 (the two losses) + purchases ₹300 − closing 28 @ ₹10 = ₹0 cost of goods sold
    //    (nothing was sold — neither loss is counted a second time); the close's stock check agrees with the books.
    const adj = await call('POST', `/v1/finance/periods/${PERIOD}/stock-adjustment`, 'u-acct', {});
    expect(adj.status, JSON.stringify(adj.body)).toBe(201);
    expect((adj.body as { posted: { stockPeriod: Record<string, number> } }).posted.stockPeriod).toMatchObject({ booksInventoryBeforeMinor: -2_000, purchasesMinor: 30_000, closingValueMinor: 28_000, costOfSalesMinor: 0 });
    const ev = (await call('GET', `/v1/finance/periods/${PERIOD}/independent-evidence`, 'u-acct')).body as { checks: { name: string; leftMinor: number; rightMinor: number }[] };
    expect(ev.checks.find((c) => c.name === `Stock value at the close of ${PERIOD}`)).toMatchObject({ leftMinor: 28_000, rightMinor: 28_000 });
  }, 120_000);
});
