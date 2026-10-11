import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { withApprovals } from '../support/refund-approval';
import { approvedBody } from '../support/approval-request';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **WF-11 / M13-FR-02 / PF-14 residual — a returned unit held off the shelf gets a PERSON'S decision: restock, write off,
 * return to the supplier, or repair; the stock moves once, through the ordinary ledger; a material loss needs a second
 * person; every decision is audited.**
 *
 * A bill sells dal (batch D-07) and milk (batches M-1, M-2) from stock received at a cost. The customer returns two dal
 * (damaged), one milk M-1 (quarantine) and one milk M-2 (scrap) — all held off the shelf. Then, on the real head-office
 * API: a cashier may not decide; the manager restocks the M-1 milk (QC release — one `returned` movement, once, however
 * often it is re-sent); the M-2 milk is under a quality hold so it cannot go back on sale — it goes back to the supplier
 * instead (in and out, on-hand unchanged); one dal is written off — a material loss at head office's own cost needs
 * evidence and another person's approval, and lands on the write-off register; the other dal goes for repair, then back
 * on sale. In memory and, with DATABASE_URL, on real PostgreSQL. Synthetic data only.
 */

const AT = '2026-10-09T10:00:00.000Z';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const SALE = {
  saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-cash', locationId: 'store-1',
  tradingDay: '2026-10-09', committedAt: AT, totalMinor: 23_000, currency: 'INR', packVersion: 1,
  lines: [
    { productId: 'DAL', quantityMinor: 3, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 15_000, batchId: 'D-07', batchExpiry: '2026-12-31' },
    { productId: 'MILK', quantityMinor: 2, uom: 'each', unitPriceMinor: 2_000, lineTotalMinor: 4_000, batchId: 'M-1', batchExpiry: '2026-10-12' },
    { productId: 'MILK', quantityMinor: 2, uom: 'each', unitPriceMinor: 2_000, lineTotalMinor: 4_000, batchId: 'M-2', batchExpiry: '2026-10-15' },
  ],
  tenders: [{ kind: 'cash', amountMinor: 23_000 }],
};

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

interface Item { heldId: string; productId: string; batchId: string | null; disposition: string; state: string; decisions: { decision: string; decidedBy: string }[] }

async function shop(h: ApiHarness, t: string) {
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-mgr', 'store_manager');
  await h.provisionRole(t, 'u-cash', 'cashier');
  const receive = async (id: string, productId: string, batchId: string, qty: number, unitCostMinor: number) =>
    expect((await h.request({ method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId: t, idempotencyKey: `mv-${id}`,
      body: { movementId: id, productId, locationId: 'store-1', kind: 'received', quantityMinor: qty, uom: 'each', occurredAt: '2026-10-01T09:00:00.000Z', enteredBy: 'u-owner', unitCostMinor, batchId } })).status).toBe(202);
  await receive('rcv-dal', 'DAL', 'D-07', 10, 4_000);
  await receive('rcv-m1', 'MILK', 'M-1', 5, 1_500);
  await receive('rcv-m2', 'MILK', 'M-2', 5, 1_500);
  expect((await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-owner', tenantId: t, idempotencyKey: 'bank-S1', body: SALE })).status).toBe(202);
  const line = (productId: string, disposition: string, over: Record<string, unknown> = {}) => ({ productId, uom: 'each', quantityMinor: 1, disposition, ...over });
  const ret = await h.request({ method: 'POST', path: '/v1/sales/S1/returns', userId: 'u-owner', tenantId: t, idempotencyKey: 'ret-RT1',
    body: await withApprovals(h, t, 'u-owner', 'S1', {
      returnId: 'RT1', reasonCode: 'damaged_in_use', refundMinor: 14_000, refundTender: 'cash', approvedBy: 'u-mgr',
      lines: [line('DAL', 'damaged', { condition: 'torn pack' }), line('DAL', 'damaged', { condition: 'seal broken' }), line('MILK', 'quarantine', { batchId: 'M-1' }), line('MILK', 'scrap', { batchId: 'M-2' })],
    }) });
  expect(ret.status, JSON.stringify(ret.body)).toBe(201);
  const decide = (heldId: string, decisionId: string, body: Record<string, unknown>, userId = 'u-mgr') =>
    h.request({ method: 'POST', path: `/v1/returns/held-stock/${heldId}/decisions/${decisionId}`, userId, tenantId: t, idempotencyKey: `${decisionId}-${randomUUID()}`, body });
  const worklist = async (query: Record<string, string> = {}) =>
    (await h.request({ method: 'GET', path: '/v1/returns/held-stock/worklist', userId: 'u-mgr', tenantId: t, query })).body as { count: number; open: number; items: Item[] };
  const onHand = async (productId: string): Promise<number> =>
    ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: t, query: { productId } })).body as { rows: { onHandMinor: number }[] }).rows.reduce((s, r) => s + r.onHandMinor, 0);
  const moved = async () => (await h.store.readStream(t, STREAM.inventory, { type: 'InventoryMoved' })).map((e) => e.event.payload as { movementId: string; kind: string; productId: string; batchId?: string; approvedBy?: string });
  return { decide, worklist, onHand, moved };
}

describe.each(backings)('WF-11 — a person decides each held returned unit — on $name', ({ harness }) => {
  it('restock once, refused while the batch is held, back to the supplier, a governed write-off, and repair then restock — each audited', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await shop(h, t);

    const start = await s.worklist();
    expect(start).toMatchObject({ count: 4, open: 4 });
    const [dal1, dal2, milk1, milk2] = start.items;
    expect([dal1!.productId, dal2!.productId, milk1!.batchId, milk2!.batchId]).toEqual(['DAL', 'DAL', 'M-1', 'M-2']);
    expect(start.items.every((i) => i.state === 'held')).toBe(true);
    // Dal: 10 received − 3 sold; milk: 10 − 4. Held units are not on the shelf.
    expect(await s.onHand('DAL')).toBe(7);
    expect(await s.onHand('MILK')).toBe(6);

    // ── A cashier may not decide; a decision with no reason is not read.
    expect((await s.decide(milk1!.heldId, 'd-cash', { decision: 'restock', reasonCode: 'looks_fine' }, 'u-cash')).status).toBe(403);
    expect(codeOf(await s.decide(milk1!.heldId, 'd-noreason', { decision: 'restock' }))).toBe('not_readable_as_a_held_stock_decision');
    expect(codeOf(await s.decide('held-nope', 'd-x', { decision: 'restock', reasonCode: 'x' }))).toBe('held_unit_not_found');

    // ── Restock the M-1 milk: ONE `returned` movement under its batch, on-hand +1. Re-sent: the same answer, no second unit.
    const restock = await s.decide(milk1!.heldId, 'd-milk1', { decision: 'restock', reasonCode: 'qc_passed', note: 'seal intact, cold' });
    expect(restock.status, JSON.stringify(restock.body)).toBe(201);
    expect(restock.body).toMatchObject({ state: 'restocked', decision: { decision: 'restock', decidedBy: 'u-mgr', batchId: 'M-1', movementIds: [`held-${milk1!.heldId}-restock`] } });
    expect(await s.onHand('MILK')).toBe(7);
    const again = await s.decide(milk1!.heldId, 'd-milk1', { decision: 'restock', reasonCode: 'qc_passed', note: 'seal intact, cold' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadyRecorded: true });
    expect(await s.onHand('MILK')).toBe(7);
    expect((await s.moved()).filter((m) => m.movementId === `held-${milk1!.heldId}-restock`)).toEqual([expect.objectContaining({ kind: 'returned', batchId: 'M-1' })]);
    // Closed once: a second, different decision is refused by name.
    expect(codeOf(await s.decide(milk1!.heldId, 'd-milk1-b', { decision: 'write_off', reasonCode: 'changed_mind' }))).toBe('held_unit_already_decided');
    expect(codeOf(await s.decide(dal1!.heldId, 'd-milk1', { decision: 'repair', reasonCode: 'x' }))).toBe('decision_id_reused');

    // ── M-2 is on quality hold: it does not go back on sale. It goes back to the supplier — in and out, on-hand unchanged.
    expect((await h.request({ method: 'POST', path: '/v1/quality/holds/M-2', userId: 'u-owner', tenantId: t, idempotencyKey: 'hold-m2', body: { productId: 'MILK', reason: 'supplier advisory' } })).status).toBe(201);
    const blocked = await s.decide(milk2!.heldId, 'd-milk2', { decision: 'restock', reasonCode: 'qc_passed' });
    expect(codeOf(blocked)).toBe('batch_blocked_from_sale');
    expect(await s.onHand('MILK')).toBe(7);
    expect(codeOf(await s.decide(milk2!.heldId, 'd-milk2-rts', { decision: 'return_to_supplier', reasonCode: 'supplier_advisory' }))).toBe('not_readable_as_a_held_stock_decision');
    const rts = await s.decide(milk2!.heldId, 'd-milk2-rts', { decision: 'return_to_supplier', reasonCode: 'supplier_advisory', supplierId: 'sup-dairy', supplierRef: 'RMA-77' });
    expect(rts.status, JSON.stringify(rts.body)).toBe(201);
    expect(rts.body).toMatchObject({ state: 'returned_to_supplier', decision: { supplierId: 'sup-dairy', supplierRef: 'RMA-77' } });
    expect(await s.onHand('MILK')).toBe(7);
    expect((await s.moved()).filter((m) => m.movementId.startsWith(`held-${milk2!.heldId}`)).map((m) => m.kind)).toEqual(['returned', 'returned_to_supplier']);

    // ── Write off a dal. The owner sets the material-loss line at ₹10 — one dal at ₹40 cost is material.
    expect((await h.request({ method: 'POST', path: '/v1/inventory/write-off-threshold', userId: 'u-owner', tenantId: t, idempotencyKey: 'thr', body: { thresholdMinor: 1_000 } })).status).toBe(200);
    const wo = { decision: 'write_off', reasonCode: 'pack_torn_contents_spilt', lossType: 'damage' };
    expect(codeOf(await s.decide(dal1!.heldId, 'd-dal1', wo))).toBe('write_off_needs_evidence');
    expect(codeOf(await s.decide(dal1!.heldId, 'd-dal1', { ...wo, evidenceRef: 'photo-17', valueMinor: 0 }))).toBe('write_off_value_is_the_stock_cost');
    expect(codeOf(await s.decide(dal1!.heldId, 'd-dal1', { ...wo, evidenceRef: 'photo-17' }))).toBe('write_off_needs_approval');
    // A typed second person is refused by name — an approval is the checker's own act.
    expect((await s.decide(dal1!.heldId, 'd-dal1', { ...wo, evidenceRef: 'photo-17', approvedBy: 'u-owner' })).status).toBeGreaterThanOrEqual(400);
    expect(await s.onHand('DAL')).toBe(7);
    const woBody = await approvedBody(h, t, 'u-mgr', 'u-owner', 'stock_write_off', `held-${dal1!.heldId}`, { ...wo, evidenceRef: 'photo-17' }, { heldId: dal1!.heldId, decisionId: 'd-dal1' }, 4_000);
    const written = await s.decide(dal1!.heldId, 'd-dal1', woBody);
    expect(written.status, JSON.stringify(written.body)).toBe(201);
    expect(written.body).toMatchObject({ state: 'written_off', decision: { valueMinor: 4_000, valueSource: 'stock_cost', approvedBy: 'u-owner', evidenceRef: 'photo-17', writeOffId: `held-${dal1!.heldId}` } });
    expect(await s.onHand('DAL')).toBe(7); // in as a return, out as waste
    expect((await s.moved()).filter((m) => m.movementId.includes(dal1!.heldId)).map((m) => m.kind)).toEqual(['returned', 'wasted']);
    const register = (await h.request({ method: 'GET', path: '/v1/inventory/write-offs', userId: 'u-owner', tenantId: t })).body as { writeOffs: Record<string, unknown>[]; totalLossMinor: number };
    expect(register.writeOffs).toEqual([expect.objectContaining({ id: `held-${dal1!.heldId}`, productId: 'DAL', valueMinor: 4_000, requiredApproval: true, approvedBy: 'u-owner', raisedBy: 'u-mgr', lossType: 'damage' })]);
    expect(register.totalLossMinor).toBe(4_000);

    // ── The other dal goes for repair (nothing moves), cannot go twice, then comes back and is restocked.
    const repair = await s.decide(dal2!.heldId, 'd-dal2-repair', { decision: 'repair', reasonCode: 'reseal_pack' });
    expect(repair.body).toMatchObject({ state: 'at_repair', decision: { movementIds: [] } });
    expect(codeOf(await s.decide(dal2!.heldId, 'd-dal2-repair-2', { decision: 'repair', reasonCode: 'again' }))).toBe('held_unit_already_at_repair');
    expect(await s.onHand('DAL')).toBe(7);
    expect((await s.worklist({ state: 'open' })).items.map((i) => [i.heldId, i.state])).toEqual([[dal2!.heldId, 'at_repair']]);
    const back = await s.decide(dal2!.heldId, 'd-dal2-back', { decision: 'restock', reasonCode: 'resealed_ok' });
    expect(back.body).toMatchObject({ state: 'restocked' });
    expect(await s.onHand('DAL')).toBe(8);

    // ── Nothing left to decide; every unit and every decision is kept (hard rule #6).
    const end = await s.worklist();
    expect(end).toMatchObject({ count: 4, open: 0 });
    expect(end.items.find((i) => i.heldId === dal2!.heldId)!.decisions.map((d) => d.decision)).toEqual(['repair', 'restock']);
    expect((await h.request({ method: 'GET', path: '/v1/returns/held-stock', userId: 'u-owner', tenantId: t })).body).toMatchObject({ count: 4 });
    // Each decision is in the audit trail, attributed to the person who made it.
    const audit = (await h.store.readStream(t, streamName(STREAM.audit, 'domain-trail'))).map((e) => JSON.stringify(e.event.payload));
    const decidedIds = audit.filter((a) => a.includes('returns.held_stock.decided')).map((a) => /"objectId":"([^"]+)"/.exec(a)?.[1]);
    expect(audit.filter((a) => a.includes('returns.held_stock.decided')).every((a) => a.includes('"actorId":"u-mgr"'))).toBe(true);
    expect(decidedIds.sort()).toEqual([milk1!.heldId, milk2!.heldId, dal1!.heldId, dal2!.heldId, dal2!.heldId].sort());
  }, 60_000);

  it('a unit under a quality hold never goes back on sale; a small loss needs no second person', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await shop(h, t);
    const { items } = await s.worklist();
    const milk1 = items.find((i) => i.batchId === 'M-1')!;
    expect((await h.request({ method: 'POST', path: '/v1/quality/holds/M-1', userId: 'u-owner', tenantId: t, idempotencyKey: 'hold-m1', body: { productId: 'MILK', reason: 'temperature excursion' } })).status).toBe(201);
    expect(codeOf(await s.decide(milk1.heldId, 'd-1', { decision: 'restock', reasonCode: 'qc_passed' }, 'u-owner'))).toBe('batch_blocked_from_sale');
    // Write-off of a small loss needs no second person: one milk at ₹15 is under the default ₹500 line.
    const small = await s.decide(milk1.heldId, 'd-2', { decision: 'write_off', reasonCode: 'temperature_excursion' });
    expect(small.status, JSON.stringify(small.body)).toBe(201);
    expect(small.body).toMatchObject({ decision: { valueMinor: 1_500, approvedBy: null, evidenceRef: null } });
  }, 60_000);

  it('two people decide the same unit at the same moment: one decision lands, the other is refused by name — stock moves once', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await shop(h, t);
    const dal = (await s.worklist()).items[0]!;
    const results = await Promise.all([
      s.decide(dal.heldId, 'd-race-a', { decision: 'restock', reasonCode: 'qc_passed' }, 'u-mgr'),
      s.decide(dal.heldId, 'd-race-b', { decision: 'restock', reasonCode: 'qc_passed' }, 'u-owner'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(['concurrent_change', 'held_unit_already_decided']).toContain(codeOf(loser));
    expect(await s.onHand('DAL')).toBe(8);
    expect((await s.worklist()).items.find((i) => i.heldId === dal.heldId)!.decisions).toHaveLength(1);
  }, 60_000);
});
