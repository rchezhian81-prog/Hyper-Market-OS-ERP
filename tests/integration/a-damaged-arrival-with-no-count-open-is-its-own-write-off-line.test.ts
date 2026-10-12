import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/day-book';
import { STREAM, streamName, floorIndentsAdapter } from '../../services/api/src/adapters';
import type { StoredWriteOff } from '../../services/inventory/src/write-off';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **OB-71 "A" (owner, 12 Oct 2026, in writing, "Own write-off line") — a damaged arrival when NO count is open goes on the
 * write-off register as its own write-off line, posted once to the books (D05-FR-05 · M28-FR-01 · M08 · M23 · WF-18 · P-08 ·
 * hard rules #2 #6 #10).**
 *
 * Before OB-71 a damaged floor-indent receipt with no open count wrote a `wasted` movement and NO register record: the loss
 * left the stock ledger but reached the books only inside month-end cost of goods sold. On the real head-office API (in memory
 * and, with DATABASE_URL, on real PostgreSQL): the floor S1 holds 20 of P2 (₹10 each), the back store 10. Two floor indents:
 *
 *   • ind-1 counted in on the DIRECT route: 5 good + 1 damaged. On-hand at the floor +5; the damaged unit is written off in
 *     the SAME write as the receipt — one `wasted` posting and ONE register write-off (damage / arrived_damaged, ₹10 = the cost
 *     it left the back store with). A role without receiving rights is refused (403) and records nothing; a re-sent receipt
 *     (direct, and the same receipt relayed by the store computer) adds nothing.
 *   • ind-2 counted in on the store computer's RELAYED route: 2 good + 1 damaged — its own register write-off; a re-relay adds
 *     nothing.
 *   • The month-end stock adjustment refuses while either write-off is unposted (naming it). The ONE stock-adjustment posting
 *     run posts exactly one `inventory_write_off` journal per write-off at ₹10; a re-run posts nothing.
 *   • 3 are sold at the floor. Month end: stock in the books −₹20 (the two write-offs) + purchases ₹300 − closing 25 @ ₹10 =
 *     cost of goods sold ₹30 — exactly the 3 sold, the ₹20 of damage NOT inside it (counted once, on its own line); the
 *     close's stock-value check agrees with the books.
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
type Line = { accountCode: string; debitMinor: number; creditMinor: number };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const PERIOD = new Date().toISOString().slice(0, 7);
// Seed a minute ago (never in the future of the receipt), but never before this month began.
const SEED_AT = new Date(Math.max(Date.now() - 60_000, Date.parse(`${PERIOD}-01T00:00:00.000Z`))).toISOString();
const WO1 = 'arrived-ind-1:is-1-damaged-1';
const WO2 = 'arrived-ind-2:is-2-damaged-1';

describe.each(backings)('OB-71 — a damaged arrival with no count open is its own write-off line, posted once — on $name', ({ harness }) => {
  it('writes the damaged units off on the register in the receipt\'s own write (direct and relayed), posts each once, and keeps them out of cost of goods sold', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    for (const u of ['u-plan', 'u-appr', 'u-back', 'u-floor']) await h.provisionRole(T, u, 'store_manager');
    await h.provisionRole(T, 'u-acct', 'accountant');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
    let n = 0;
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}` }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const onHand = async (loc = 'S1'): Promise<number> =>
      ((await call('GET', '/v1/inventory/availability', 'u-owner', undefined, { productId: 'P2' })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows.filter((r) => r.locationId === loc).reduce((s, r) => s + r.onHandMinor, 0);
    const movementIds = async (): Promise<string[]> => (await h.store.readStream(T, STREAM.inventory, { type: 'InventoryMoved' })).map((e) => (e.event.payload as { movementId: string }).movementId);
    const register = async () => ((await call('GET', '/v1/inventory/write-offs', 'u-owner')).body as { writeOffs: { id: string; productId: string; locationId: string; qtyRemoved: number; valueMinor: number; reasonCode: string; lossType: string; valueSource?: string; unitCostMinor?: number }[] }).writeOffs;
    const writeOffEvents = async (): Promise<string[]> => (await h.store.readStream(T, streamName(STREAM.inventory, 'write-offs'), { type: 'WriteOffCommitted' })).map((e) => (e.event.payload as { id: string }).id);
    const directReceipt = (u: string, indentId: string, issueId: string, good: number) =>
      call('POST', `/v1/floor/indents/${indentId}/issues/${issueId}/receipt`, u, { counted: [{ productId: 'P2', batchId: null, quantityMinor: good, damagedMinor: 1 }] });
    const relayedReceipt = (u: string, indentId: string, issueId: string, good: number) =>
      call('POST', `/v1/floor/indents/${indentId}/issues/${issueId}/receipt/synced`, u, { indentId, issueId, counted: [{ productId: 'P2', batchId: null, quantityMinor: good, damagedMinor: 1 }], receivedBy: 'u-floor', at: new Date().toISOString(), storeId: 'S1', source: 'indents-screen' });

    await ok(call('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(call('POST', '/v1/org/nodes/S1', 'u-owner', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'store');
    await ok(call('POST', '/v1/org/nodes/S1-BACK', 'u-owner', { kind: 'warehouse', name: 'Store 1 back store', parentId: 'S1', companyId: 'C1' }), 'back store');
    for (const [id, loc, qty] of [['s-floor', 'S1', 20], ['s-back', 'S1-BACK', 10]] as const) {
      await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: id, productId: 'P2', locationId: loc, kind: 'received', quantityMinor: qty, uom: 'EA', occurredAt: SEED_AT, enteredBy: 'u-owner', unitCostMinor: 1_000 }), id);
    }
    for (const [indentId, issueId, qty] of [['ind-1', 'is-1', 6], ['ind-2', 'is-2', 3]] as const) {
      await ok(call('POST', `/v1/floor/indents/${indentId}`, 'u-plan', { fromLocationId: 'S1-BACK', toLocationId: 'S1', lines: [{ productId: 'P2', quantityMinor: qty, uom: 'EA' }], reason: 'shelf 4 empty' }), `${indentId} ask`);
      await ok(call('POST', `/v1/floor/indents/${indentId}/approval`, 'u-appr', {}), `${indentId} approval`);
      await ok(call('POST', `/v1/floor/indents/${indentId}/issues/${issueId}`, 'u-back', { lines: [{ productId: 'P2', batchId: null, quantityMinor: qty }] }), `${indentId} issue`);
    }
    // No count is open anywhere.
    expect(((await call('GET', '/v1/inventory/count-plans', 'u-plan')).body as { plans?: unknown[] }).plans ?? []).toEqual([]);

    // ── Permissions: a role without receiving rights is refused on both routes and records nothing.
    expect((await directReceipt('u-cash', 'ind-1', 'is-1', 5)).status).toBe(403);
    expect((await directReceipt('u-acct', 'ind-1', 'is-1', 5)).status).toBe(403);
    expect((await relayedReceipt('u-acct', 'ind-1', 'is-1', 5)).status).toBe(403);
    expect(await register()).toEqual([]);
    expect(await onHand()).toBe(20);

    // ── ind-1 on the DIRECT route: 5 good + 1 damaged.
    const rcv = await directReceipt('u-floor', 'ind-1', 'is-1', 5);
    expect(rcv.status, JSON.stringify(rcv.body)).toBe(201);
    const rb = rcv.body as { writeOffs: { id: string; valueMinor: number }[]; heldWriteOffs: unknown[]; posted: string[] };
    expect(rb.heldWriteOffs).toEqual([]);
    expect(rb.writeOffs.map((w) => [w.id, w.valueMinor])).toEqual([[WO1, 1_000]]);
    expect(rb.posted).toContain('ind-1:is-1-damaged-1');
    expect(await onHand()).toBe(25); // +5: the damaged unit came in and went out in the same write
    expect(await onHand('S1-BACK')).toBe(1);
    expect((await register()).map((w) => [w.id, w.productId, w.locationId, w.qtyRemoved, w.valueMinor, w.reasonCode, w.lossType, w.valueSource, w.unitCostMinor]))
      .toEqual([[WO1, 'P2', 'S1', 1, 1_000, 'arrived_damaged', 'damage', 'stock_cost', 1_000]]);
    // Its stock effect is the receipt's one `wasted` posting — not a second `writeoff-` one.
    let ids = await movementIds();
    expect(ids.filter((id) => id === 'ind-1:is-1-damaged-1')).toHaveLength(1);
    expect(ids.filter((id) => id.startsWith('writeoff-'))).toEqual([]);
    // The audit names the write-off.
    const trail = (await h.store.readStream(T, streamName(STREAM.audit, 'domain-trail'))).map((e) => JSON.stringify(e.event.payload));
    expect(trail.filter((a) => a.includes('floor_indent.receive') && a.includes(`"writeOffs":"${WO1}"`))).toHaveLength(1);

    // ── Replays add nothing: the same receipt again (direct), and the same receipt relayed by the store computer.
    expect((await directReceipt('u-floor', 'ind-1', 'is-1', 5)).body).toMatchObject({ alreadyReceived: true });
    expect((await relayedReceipt('u-box', 'ind-1', 'is-1', 5)).body).toMatchObject({ alreadyReceived: true });
    expect(await writeOffEvents()).toEqual([WO1]);
    expect(await onHand()).toBe(25);

    // ── ind-2 on the store computer's RELAYED route: 2 good + 1 damaged — its own write-off line; a re-relay adds nothing.
    const rel = await relayedReceipt('u-box', 'ind-2', 'is-2', 2);
    expect(rel.status, JSON.stringify(rel.body)).toBe(202);
    expect((rel.body as { writeOffs: { id: string }[] }).writeOffs.map((w) => w.id)).toEqual([WO2]);
    expect((await relayedReceipt('u-box', 'ind-2', 'is-2', 2)).body).toMatchObject({ alreadyReceived: true });
    expect((await directReceipt('u-floor', 'ind-2', 'is-2', 2)).body).toMatchObject({ alreadyReceived: true });
    expect(await writeOffEvents()).toEqual([WO1, WO2]);
    expect(await onHand()).toBe(27);
    ids = await movementIds();
    expect(ids.filter((id) => id.includes('-damaged-'))).toEqual(['ind-1:is-1-damaged-1', 'ind-2:is-2-damaged-1']);

    // ── The receipt's write itself, re-sent (a retry after a commit whose reply was lost): the register entry is keyed on its
    //    id, so it lands once — on-hand and the register are unchanged.
    const write = floorIndentsAdapter({ store: h.store, now: () => new Date().toISOString() });
    const ind1 = (await write.indent(T, 'ind-1'))!;
    const tr1 = (await write.transferOf(T, 'ind-1:is-1'))!;
    const wo1 = (await h.store.readStream(T, streamName(STREAM.inventory, 'write-offs'), { type: 'WriteOffCommitted' }))[0]!.event.payload as StoredWriteOff;
    await write.recordReceipt(T, ind1, tr1, [], [], [], undefined, [], [wo1]);
    await write.recordReceipt(T, ind1, tr1, [], [], [], undefined, [], [wo1]);
    expect(await writeOffEvents()).toEqual([WO1, WO2]);
    expect(await onHand()).toBe(27);

    // ── The month end waits for them by name: adjusting first would hide them inside cost of goods sold.
    await ok(call('PUT', '/v1/finance/posting-map', 'u-acct', DEFAULT_RETAIL_POSTING_MAP), 'map');
    const early = await call('POST', `/v1/finance/periods/${PERIOD}/stock-adjustment`, 'u-acct', {});
    expect(codeOf(early)).toBe('stock_postings_outstanding');
    expect((early.body as { error: { whatHappened: string } }).error.whatHappened).toContain(`write_off:${WO1}`);
    expect((early.body as { error: { whatHappened: string } }).error.whatHappened).toContain(`write_off:${WO2}`);

    // ── The ONE posting run posts exactly one inventory_write_off per write-off at ₹10; a re-run posts nothing.
    expect((await call('POST', '/v1/finance/stock-adjustments/post', 'u-cash', {})).status).toBe(403);
    const run = await ok(call('POST', '/v1/finance/stock-adjustments/post', 'u-acct', {}), 'post');
    const journals = (run.body as { posted: { entryId: string; lines: Line[] }[]; exceptions: unknown[] });
    expect(journals.exceptions).toEqual([]);
    const wl = (v: number): Line[] => [{ accountCode: 'inventory_write_off', debitMinor: v, creditMinor: 0 }, { accountCode: 'inventory', debitMinor: 0, creditMinor: v }];
    expect(journals.posted.map((j) => [j.entryId, j.lines]).sort()).toEqual([
      [`stock-adjustment:write_off:${WO1}`, wl(1_000)],
      [`stock-adjustment:write_off:${WO2}`, wl(1_000)],
    ].sort());
    expect((await call('POST', '/v1/finance/stock-adjustments/post', 'u-acct', {})).body).toMatchObject({ posted: [] });
    const ledger = (await h.store.readStream(T, 'finance', { type: 'JournalPosted' })).map((e) => e.event.payload as { entryId: string; lines: Line[] });
    expect(ledger.filter((j) => j.entryId.startsWith('stock-adjustment:'))).toHaveLength(2);
    expect(ledger.flatMap((j) => j.lines).filter((l) => l.accountCode === 'inventory_write_off').reduce((s, l) => s + l.debitMinor - l.creditMinor, 0)).toBe(2_000);

    // ── 3 sell at the floor. Month end: −₹20 + ₹300 − 25 @ ₹10 = ₹30 cost of goods sold — the 3 sold, the damage NOT in it.
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'sale-1', productId: 'P2', locationId: 'S1', kind: 'sold', quantityMinor: 3, uom: 'EA', occurredAt: new Date().toISOString(), enteredBy: 'u-floor' }), 'sale');
    expect(await onHand()).toBe(24);
    const adj = await call('POST', `/v1/finance/periods/${PERIOD}/stock-adjustment`, 'u-acct', {});
    expect(adj.status, JSON.stringify(adj.body)).toBe(201);
    expect((adj.body as { posted: { stockPeriod: Record<string, number> } }).posted.stockPeriod)
      .toMatchObject({ booksInventoryBeforeMinor: -2_000, purchasesMinor: 30_000, closingValueMinor: 25_000, costOfSalesMinor: 3_000 });
    const ev = (await call('GET', `/v1/finance/periods/${PERIOD}/independent-evidence`, 'u-acct')).body as { checks: { name: string; leftMinor: number; rightMinor: number }[] };
    expect(ev.checks.find((c) => c.name === `Stock value at the close of ${PERIOD}`)).toMatchObject({ leftMinor: 25_000, rightMinor: 25_000 });
    expect(ev.checks.find((c) => c.name === `Count differences and write-offs for ${PERIOD}`)).toMatchObject({ leftMinor: 2_000, rightMinor: 2_000 });
  }, 120_000);
});
