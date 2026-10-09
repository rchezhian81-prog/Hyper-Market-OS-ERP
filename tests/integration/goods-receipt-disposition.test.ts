import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { LINE_DISPOSITIONS } from '../../services/inventory/src/goods-receipt';

/**
 * **Quarantined and refused stock on a delivery gets a DISPOSITION — accept / return / claim — by a second person who is
 * not the receiver (SP-6 · W06 · M07-FR-03 · §28 · hard rules #2/#5/#6/#10, API-04).**
 *
 * Until SP-6 the GRN recorded damaged, QC-failed or expired stock as quarantined or refused and the review list surfaced
 * it — and nothing could be done with it on the system: no route accepted it into stock after inspection, sent it back
 * to the supplier, or raised the claim. Now `POST /v1/inventory/goods-receipt/:grnId/lines/:lineId/disposition` does
 * one of the three, once per line, valued at the delivered cost (the figure the supplier account works from, SP-7):
 * an ACCEPT releases the quarantined stock as its own inbound movement in the same append; a RETURN or CLAIM moves no
 * stock and records the value; refused (expired) stock can never be accepted. The receiver cannot decide their own
 * delivery; a cashier may not decide at all. Synthetic data (hard rule #7).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-09-30T09:00:00.000Z';
const WH = 'wh-1';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Grn {
  grnId: string; availableMinor: number;
  captured: { lines: { lineId: string; sellableMinor: number; quarantinedMinor: number; rejectedMinor: number; disposition: string }[] };
  dispositions?: { lineId: string; disposition: string; quantityMinor: number; valueMinor: number; decidedBy: string; movementIds: string[]; via: string }[];
}
interface Disposed { disposition: string; quantityMinor: number; valueMinor: number; movementIds: string[]; availableMinor: number; awaitsDecision: boolean; alreadyDecided: boolean }

const post = (h: ApiHarness, path: string, userId: string, body: unknown, key: string) => h.request({ method: 'POST', path, userId, tenantId: A, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string, userId: string, query?: Readonly<Record<string, string>>) => h.request({ method: 'GET', path, userId, tenantId: A, ...(query === undefined ? {} : { query }) });
const receive = (h: ApiHarness, grnId: string, lines: Record<string, unknown>[], userId = 'u-receiver') =>
  post(h, `/v1/inventory/goods-receipt/${grnId}`, userId, { warehouseId: WH, receivedOnDate: '2026-09-30', currency: 'INR', lines }, grnId);
const line = (lineId: string, productId: string, extra: Record<string, unknown> = {}) =>
  ({ lineId, productId, orderedMinor: 100, countedMinor: 100, uom: 'ea', unitCost: { minor: 5000, currency: 'INR' }, condition: 'good', ...extra });
const dispose = (h: ApiHarness, grnId: string, lineId: string, userId: string, disposition: string, key: string, reason = `${disposition} — inspected on the dock`) =>
  post(h, `/v1/inventory/goods-receipt/${grnId}/lines/${lineId}/disposition`, userId, { disposition, reason }, key);
const readGrn = async (h: ApiHarness, grnId: string) => (await get(h, `/v1/inventory/goods-receipt/${grnId}`, 'u-owner')).body as { grn: Grn; awaitsDecision: boolean; awaitingDisposition: string[] };
const onHand = async (h: ApiHarness, productId: string): Promise<number> =>
  ((await get(h, '/v1/inventory/availability', 'u-owner', { productId })).body as { rows: { onHandMinor: number }[] }).rows.reduce((s, r) => s + r.onHandMinor, 0);
const ledger = async (h: ApiHarness) => (await h.store.readStream(A, 'inventory', { type: 'InventoryMoved' })).map((e) => e.event.payload as Record<string, unknown>);

/** The cast and the product master (p1 and p3 untracked). */
async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-receiver', 'store_manager'); // receives; holds approve too — but never on their own delivery
  await h.provisionRole(A, 'u-boss', 'store_manager');     // the second person
  await h.provisionRole(A, 'u-cashier', 'cashier');        // no approval authority
  await h.store.append(A, STREAM.catalogue, makeEvent({
    id: `pack-${A}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
    payload: {
      snapshot: {
        tenantId: A, version: 1, builtAt: AT, scope: { tenantId: A, storeId: 'store-1' },
        products: [
          { productId: 'p1', sku: 'p1', name: 'Toor dal 1kg', unitPriceMinor: 16_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false, handling: 'ambient' },
          { productId: 'p3', sku: 'p3', name: 'Biscuits 100g', unitPriceMinor: 2_000, taxBps: 1800, status: 'active', uom: 'ea', batchTracked: false, handling: 'ambient' },
        ],
        barcodes: [],
      },
    },
  }));
  expect((await post(h, '/v1/inventory/receipt-policy', 'u-owner', { excessToleranceBp: 500, shortageToleranceBp: 200, nearExpiryDays: 7 }, 'pol')).status).toBe(201);
  return h;
}

describe('quarantined and refused stock on a delivery is disposed of by a second person — accept / return / claim (M07-FR-03)', () => {
  it('a damaged line waits for a disposition; ACCEPT releases it to stock as one inbound movement, once, and the receipt no longer waits', async () => {
    const h = await seeded();
    const res = await receive(h, 'g1', [line('L1', 'p1', { condition: 'damaged' }), line('L2', 'p3', { unitCost: { minor: 200, currency: 'INR' } })]);
    expect(res.status).toBe(201);
    expect(await onHand(h, 'p1')).toBe(0); // quarantined: in the building, not sellable
    expect(await onHand(h, 'p3')).toBe(100);
    let read = await readGrn(h, 'g1');
    expect(read.awaitsDecision).toBe(true);
    expect(read.awaitingDisposition).toEqual(['L1']);
    expect(((await get(h, '/v1/inventory/goods-receipt', 'u-owner')).body as { awaitingDispositionCount: number; needingApprovalCount: number })).toMatchObject({ awaitingDispositionCount: 1, needingApprovalCount: 1 });

    // Inspected on the dock — the damage was the outer case only: a second person accepts it.
    const ok = await dispose(h, 'g1', 'L1', 'u-boss', 'accept', 'd1');
    expect(ok.status).toBe(200);
    expect(ok.body as Disposed).toMatchObject({ disposition: 'accept', quantityMinor: 100, valueMinor: 500_000, movementIds: ['g1:L1:accepted'], availableMinor: 200, awaitsDecision: false, alreadyDecided: false });
    expect(await onHand(h, 'p1')).toBe(100);
    read = await readGrn(h, 'g1');
    expect(read.awaitsDecision).toBe(false);
    expect(read.awaitingDisposition).toEqual([]);
    expect(read.grn.dispositions).toEqual([expect.objectContaining({ lineId: 'L1', disposition: 'accept', quantityMinor: 100, valueMinor: 500_000, decidedBy: 'u-boss', movementIds: ['g1:L1:accepted'], via: 'direct' })]);
    // The movement names both people and carries the delivered cost — the ledger IS the audit for stock.
    expect((await ledger(h)).find((m) => m['movementId'] === 'g1:L1:accepted')).toMatchObject({ kind: 'received', quantityMinor: 100, enteredBy: 'u-receiver', approvedBy: 'u-boss', unitCostMinor: 5000, locationId: WH });
    // The same accept again — same key or a new one — is one effect.
    expect((await dispose(h, 'g1', 'L1', 'u-boss', 'accept', 'd1')).status).toBe(200);
    expect((await dispose(h, 'g1', 'L1', 'u-boss', 'accept', 'd1-again')).body as Disposed).toMatchObject({ alreadyDecided: true, availableMinor: 200 });
    expect(await onHand(h, 'p1')).toBe(100);
    expect((await ledger(h)).filter((m) => m['movementId'] === 'g1:L1:accepted')).toHaveLength(1);
    // A different disposition afterwards is a second truth — refused.
    expect(codeOf(await dispose(h, 'g1', 'L1', 'u-boss', 'return', 'd2'))).toBe('line_already_disposed');
  });

  it('RETURN sends it back and CLAIM keeps the value on the record: neither moves stock, both carry the delivered value for the supplier account', async () => {
    const h = await seeded();
    await receive(h, 'g2', [line('L1', 'p1', { condition: 'damaged' }), line('L2', 'p3', { qc: 'failed', unitCost: { minor: 200, currency: 'INR' } })]);
    expect((await readGrn(h, 'g2')).awaitingDisposition).toEqual(['L1', 'L2']);
    const back = await dispose(h, 'g2', 'L1', 'u-boss', 'return', 'r1', 'supplier collecting on Friday');
    expect(back.body as Disposed).toMatchObject({ disposition: 'return', quantityMinor: 100, valueMinor: 500_000, movementIds: [], availableMinor: 0, awaitsDecision: true });
    const claim = await dispose(h, 'g2', 'L2', 'u-boss', 'claim', 'c1', 'unsaleable — destroying, claiming the value');
    expect(claim.body as Disposed).toMatchObject({ disposition: 'claim', quantityMinor: 100, valueMinor: 20_000, movementIds: [], availableMinor: 0, awaitsDecision: false });
    expect(await onHand(h, 'p1')).toBe(0);
    expect(await onHand(h, 'p3')).toBe(0);
    const read = await readGrn(h, 'g2');
    expect(read.awaitsDecision).toBe(false);
    expect(read.grn.dispositions?.map((d) => [d.lineId, d.disposition, d.valueMinor])).toEqual([['L1', 'return', 500_000], ['L2', 'claim', 20_000]]);
    expect((await ledger(h)).filter((m) => String(m['movementId']).startsWith('g2:'))).toHaveLength(0); // nothing of g2 ever reached stock
  });

  it('refused (expired) stock can be returned or claimed but never accepted — expired stock is never sellable, whoever asks', async () => {
    const h = await seeded();
    await receive(h, 'g3', [line('L1', 'p3', { expiry: '2026-08-01', unitCost: { minor: 200, currency: 'INR' } })]);
    const grn = (await readGrn(h, 'g3')).grn;
    expect(grn.captured.lines[0]).toMatchObject({ disposition: 'rejected', rejectedMinor: 100, sellableMinor: 0 });
    const accept = await dispose(h, 'g3', 'L1', 'u-boss', 'accept', 'a1');
    expect(accept.status).toBe(422);
    expect(codeOf(accept)).toBe('cannot_accept_refused_stock');
    expect(await onHand(h, 'p3')).toBe(0);
    expect((await dispose(h, 'g3', 'L1', 'u-boss', 'claim', 'c1')).body as Disposed).toMatchObject({ disposition: 'claim', quantityMinor: 100, valueMinor: 20_000, movementIds: [] });
  });

  it('the receiver cannot dispose of their own delivery; a cashier may not dispose at all; a clean line, an unknown line and an unknown receipt are refused by name; a malformed body is 400', async () => {
    const h = await seeded();
    await receive(h, 'g4', [line('L1', 'p1', { condition: 'damaged' }), line('L2', 'p3', { unitCost: { minor: 200, currency: 'INR' } })]);
    const self = await dispose(h, 'g4', 'L1', 'u-receiver', 'accept', 's1');
    expect(self.status).toBe(422);
    expect(codeOf(self)).toBe('self_approval');
    expect((await dispose(h, 'g4', 'L1', 'u-cashier', 'accept', 's2')).status).toBe(403);
    expect(await onHand(h, 'p1')).toBe(0);
    const clean = await dispose(h, 'g4', 'L2', 'u-boss', 'accept', 's3');
    expect(clean.status).toBe(409);
    expect(codeOf(clean)).toBe('nothing_to_dispose');
    expect((await dispose(h, 'g4', 'L9', 'u-boss', 'accept', 's4')).status).toBe(404);
    expect(codeOf(await dispose(h, 'g4', 'L9', 'u-boss', 'accept', 's4b'))).toBe('line_unknown');
    expect((await dispose(h, 'g-nowhere', 'L1', 'u-boss', 'accept', 's5')).status).toBe(404);
    expect(codeOf(await post(h, '/v1/inventory/goods-receipt/g4/lines/L1/disposition', 'u-boss', { disposition: 'shred', reason: 'x' }, 's6'))).toBe('not_readable_as_a_disposition');
    expect(codeOf(await post(h, '/v1/inventory/goods-receipt/g4/lines/L1/disposition', 'u-boss', { disposition: 'accept' }, 's7'))).toBe('not_readable_as_a_disposition');
    expect(LINE_DISPOSITIONS).toEqual(['accept', 'return', 'claim']);
    // Still waiting — nothing above changed anything.
    expect((await readGrn(h, 'g4')).awaitingDisposition).toEqual(['L1']);
  });

  it('survives a restart: the disposition and the released stock are rebuilt from the event store', async () => {
    const h = await seeded();
    await receive(h, 'g5', [line('L1', 'p1', { condition: 'damaged' })]);
    await dispose(h, 'g5', 'L1', 'u-boss', 'accept', 'a1');
    const restarted = apiHarness({ store: h.store });
    expect((await readGrn(restarted, 'g5')).grn.dispositions).toEqual([expect.objectContaining({ lineId: 'L1', disposition: 'accept' })]);
    expect((await readGrn(restarted, 'g5')).awaitsDecision).toBe(false);
    expect(await onHand(restarted, 'p1')).toBe(100);
    // And the accepted stock was released once — a re-accept on the rebuilt surface adds nothing.
    expect((await dispose(restarted, 'g5', 'L1', 'u-boss', 'accept', 'a2')).body as Disposed).toMatchObject({ alreadyDecided: true });
    expect(await onHand(restarted, 'p1')).toBe(100);
  });
});
