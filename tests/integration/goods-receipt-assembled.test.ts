import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';

/**
 * **A delivery scanned in on the warehouse handheld becomes ONE goods receipt against its order — with no second stock
 * posting (SP-6b · W06 remainder · M07-FR-01 · M06-FR-04 · §28 · hard rules #2 #10).**
 *
 * The real kernel and the real event-sourced adapters: the handheld's scans reach the scan register and post the store's
 * on-hand (SP-3a); "delivery complete" — relayed under the store box's credential, or asked for by a person at head office —
 * assembles the receipt from THAT register (never the body), measures it against the ISSUED order with the order's own
 * figures, runs the same capture the direct and relayed receipts run, records the GRN with NO `received` movement of its
 * own, and folds it into the order in the same append. Then the second-person decisions: a damaged line is accepted
 * once (the scans posted nothing for it); an over-tolerance excess — already on the shelf — is approved with no movement
 * or rejected and flagged for the supplier return; the receiver can decide neither. Refusals are by name and change nothing.
 *
 * Synthetic data only; nothing touches production (hard rule #7).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-09-30T09:00:00.000Z';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Line { lineId: string; productId: string; orderedMinor?: number; sellableMinor: number; quarantinedMinor: number; rejectedMinor: number; heldMinor: number; disposition: string; unitCost: { minor: number } }
interface Grn {
  grnId: string; poId: string | null; warehouseId: string; receivedBy: string; relayedBy?: string; source?: string; availableMinor: number; heldMinor: number;
  captured: { lines: Line[]; discrepancies: { lineId: string; kind: string; quantityMinor: number }[] };
  governanceFlags: string[]; poReceipt: { receiptId: string; receivedByProduct: Record<string, number> } | null;
  assembledFrom?: { scanCount: number; commandIds: string[]; scannedBy: string[]; completedBy: string; onHandByLine: Record<string, number>; onHandMovementIds: string[]; disagreements: unknown[] };
  excessDecision?: { decision: string; releasedMinor: number; movementIds: string[] };
  dispositions?: { lineId: string; movementIds: string[] }[];
}
interface AssembledBody { grn: Grn; alreadyReceived: boolean; flags: string[]; awaitsDecision: boolean; awaitingDisposition: string[] }

const post = (h: ApiHarness, path: string, userId: string, body: unknown, key: string) => h.request({ method: 'POST', path, userId, tenantId: A, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string, userId: string, query?: Readonly<Record<string, string>>) => h.request({ method: 'GET', path, userId, tenantId: A, ...(query === undefined ? {} : { query }) });
/** A scan as the box relays it from the handheld (SP-3a). */
const relayScan = (h: ApiHarness, commandId: string, grnId: string, productId: string, quantityMinor: number, over: Record<string, unknown> = {}) =>
  post(h, `/v1/inventory/receiving-scans/${commandId}/synced`, 'u-box', {
    commandId, grnId, productId, batchId: null, quantityMinor, uom: 'EA', source: 'po', poId: null, state: 'on_hand', expiry: null,
    receivedBy: 'u-worker', storeId: 'store-1', at: AT, ...over,
  }, `scan-${commandId}`);
/** "Delivery complete" as the box relays it (SP-6b). */
const complete = (h: ApiHarness, grnId: string, over: Record<string, unknown> = {}, key = `done-${grnId}`) =>
  post(h, `/v1/inventory/goods-receipt/${grnId}/assembled`, 'u-box', { grnId, poId: null, completedBy: 'u-worker', storeId: 'store-1', at: AT, scanCount: 0, commandIds: [], source: 'warehouse-handheld', ...over }, key);
const readGrn = async (h: ApiHarness, grnId: string) => (await get(h, `/v1/inventory/goods-receipt/${grnId}`, 'u-owner')).body as { grn: Grn; awaitsDecision: boolean; awaitingDisposition: string[] };
const onHandAt = async (h: ApiHarness, productId: string, locationId = 'store-1'): Promise<number> =>
  ((await get(h, '/v1/inventory/availability', 'u-owner', { productId })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows.filter((r) => r.locationId === locationId).reduce((s, r) => s + r.onHandMinor, 0);
const movementIds = async (h: ApiHarness) => (await h.store.readStream(A, STREAM.inventory, { type: 'InventoryMoved' })).map((e) => (e.event.payload as { movementId: string }).movementId);
const orderOf = async (h: ApiHarness, poId: string) => (await get(h, `/v1/purchase/orders/${poId}`, 'u-owner')).body as { order: { receivedByProduct: Record<string, number> }; openCommitment: { fullyReceived: boolean; lines: { productId: string; orderedQty: number; receivedQty: number; openQty: number }[] } };
const issue = async (h: ApiHarness, poId: string, lines: { productId: string; orderedQty: number }[]) => {
  expect((await post(h, `/v1/purchase/orders/${poId}`, 'u-worker', { supplierId: 's-1', lines: lines.map((l) => ({ ...l, unitCost: { minor: 100, currency: 'INR' } })) }, `${poId}-propose`)).status).toBe(201);
  expect((await post(h, `/v1/purchase/orders/${poId}/approval`, 'u-owner', { reason: 'fixture' }, `${poId}-approve`)).status).toBe(200);
};

/** The cast, the product master (p-rice and p-dal untracked, p-milk batch-tracked), a zero-tolerance policy, one issued order. */
async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-worker', 'store_manager'); // scans and completes deliveries; holds approve too — never on their own
  await h.provisionRole(A, 'u-boss', 'store_manager');   // the second person
  await h.provisionRole(A, 'u-box', 'cashier');          // the store box's sync identity
  await h.store.append(A, STREAM.catalogue, makeEvent({
    id: `pack-${A}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
    payload: {
      snapshot: {
        tenantId: A, version: 1, builtAt: AT, scope: { tenantId: A, storeId: 'store-1' },
        products: [
          { productId: 'p-rice', sku: 'p-rice', name: 'Rice 5kg', unitPriceMinor: 40_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false },
          { productId: 'p-dal', sku: 'p-dal', name: 'Toor dal 1kg', unitPriceMinor: 16_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false },
          { productId: 'p-milk', sku: 'p-milk', name: 'Milk 500ml', unitPriceMinor: 3_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: true },
        ],
      },
    },
  }));
  expect((await post(h, '/v1/inventory/receipt-policy', 'u-owner', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }, 'pol')).status).toBe(201);
  await issue(h, 'po-1', [{ productId: 'p-rice', orderedQty: 10 }, { productId: 'p-dal', orderedQty: 5 }]);
  // A costed receipt of p-rice at the central warehouse earlier — head office knows what p-rice costs (₹1.00), p-dal it never bought.
  expect((await post(h, '/v1/inventory/goods-receipt/grn-0', 'u-owner', {
    warehouseId: 'wh-1', receivedOnDate: '2026-09-29', currency: 'INR',
    lines: [{ lineId: 'L1', productId: 'p-rice', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 100, currency: 'INR' }, condition: 'good' }],
  }, 'grn-0')).status).toBe(201);
  return h;
}

describe('the handheld\'s scans become ONE goods receipt against the order — no second posting, folded into the order (SP-6b)', () => {
  it('four good scans and a damaged one of rice, five of dal → one GRN: three lines from the register, ordered figures the order\'s, sellable stock exactly what the scans posted, the order\'s remainder down in the same append', async () => {
    const h = await seeded();
    for (const [i, q] of [1, 1, 1, 1].entries()) expect((await relayScan(h, `c${i + 1}`, 'grn-1', 'p-rice', q, { poId: 'po-1' })).status).toBe(202);
    expect((await relayScan(h, 'd1', 'grn-1', 'p-rice', 1, { state: 'damaged', poId: 'po-1' })).status).toBe(202);
    expect((await relayScan(h, 'c5', 'grn-1', 'p-dal', 5, { poId: 'po-1' })).status).toBe(202);
    // The scans have already posted the good stock (SP-3a); the order is untouched; no receipt exists.
    expect(await onHandAt(h, 'p-rice')).toBe(4);
    expect(await onHandAt(h, 'p-dal')).toBe(5);
    expect((await orderOf(h, 'po-1')).order.receivedByProduct).toEqual({});
    expect((await get(h, '/v1/inventory/goods-receipt/grn-1', 'u-owner')).status).toBe(404);

    const done = await complete(h, 'grn-1', { poId: 'po-1', scanCount: 6, commandIds: ['c1', 'c2', 'c3', 'c4', 'd1', 'c5'] });
    expect(done.status).toBe(202);
    const body = done.body as AssembledBody;
    expect(body.alreadyReceived).toBe(false);
    const g = body.grn;
    // Available = what may be sold: 4 rice + 5 dal (the damaged rice is quarantined); nothing held.
    expect(g).toMatchObject({ grnId: 'grn-1', poId: 'po-1', warehouseId: 'store-1', receivedBy: 'u-worker', relayedBy: 'u-box', source: 'warehouse-handheld', availableMinor: 9, heldMinor: 0 });
    // One line per product + posture, the good line first; the order's 10 spread as 4 on the good line and the remaining 6 on the damaged one.
    expect(g.captured.lines.map((l) => [l.lineId, l.productId, l.sellableMinor, l.quarantinedMinor, l.disposition, l.unitCost.minor])).toEqual([
      ['grn-1:1', 'p-rice', 4, 0, 'sellable', 100],
      ['grn-1:2', 'p-rice', 0, 1, 'quarantine', 100],
      ['grn-1:3', 'p-dal', 5, 0, 'sellable', 0], // head office never bought dal — captured unvalued, and SAID
    ]);
    expect(g.captured.discrepancies.map((d) => [d.lineId, d.kind, d.quantityMinor])).toEqual([['grn-1:2', 'short', 5], ['grn-1:2', 'damaged', 1]]);
    expect(g.governanceFlags).toEqual(['cost_unknown']);
    expect(g.assembledFrom).toEqual({
      scanCount: 6, commandIds: ['c1', 'c2', 'c3', 'c4', 'd1', 'c5'], scannedBy: ['u-worker'], completedBy: 'u-worker', completedAt: AT,
      onHandByLine: { 'grn-1:1': 4, 'grn-1:2': 0, 'grn-1:3': 5 },
      onHandMovementIds: ['recv:grn-1:c1', 'recv:grn-1:c2', 'recv:grn-1:c3', 'recv:grn-1:c4', 'recv:grn-1:c5'], disagreements: [],
    });
    // Received against the order = sellable + quarantined (in our custody): 5 rice, 5 dal → 5 rice open, dal closed — in the same append.
    expect(g.poReceipt).toEqual({ receiptId: 'grn-1', receivedByProduct: { 'p-rice': 5, 'p-dal': 5 } });
    expect(await orderOf(h, 'po-1')).toMatchObject({ order: { receivedByProduct: { 'p-rice': 5, 'p-dal': 5 } }, openCommitment: { fullyReceived: false, lines: [{ productId: 'p-rice', receivedQty: 5, openQty: 5 }, { productId: 'p-dal', receivedQty: 5, openQty: 0 }] } });
    // NO second posting: on-hand is what the scans posted, and the ledger carries no movement keyed on the receipt's lines.
    expect(await onHandAt(h, 'p-rice')).toBe(4);
    expect(await onHandAt(h, 'p-dal')).toBe(5);
    expect((await movementIds(h)).filter((id) => id.startsWith('grn-1:'))).toEqual([]);
    // The damaged line waits for a second person; the review list says so.
    expect(body.awaitsDecision).toBe(true);
    expect(body.awaitingDisposition).toEqual(['grn-1:2']);
    expect(((await get(h, '/v1/inventory/goods-receipt', 'u-owner')).body as { count: number; awaitingDispositionCount: number })).toMatchObject({ count: 2, awaitingDispositionCount: 1 });

    // Idempotent: the same completion again — the same key (a retry after a lost reply) replays the same answer, a re-minted key
    // finds the receipt already on file — and a person asking head office to assemble it gets the SAME receipt.
    expect((await complete(h, 'grn-1', { poId: 'po-1', scanCount: 6, commandIds: ['c1', 'c2', 'c3', 'c4', 'd1', 'c5'] })).status).toBe(202);
    expect((await complete(h, 'grn-1', { poId: 'po-1' }, 'done-grn-1-again')).body).toMatchObject({ alreadyReceived: true, grn: { grnId: 'grn-1' } });
    const direct = await post(h, '/v1/inventory/goods-receipt/grn-1/assemble', 'u-boss', { poId: 'po-1' }, 'assemble-1');
    expect(direct.status).toBe(200);
    expect(direct.body).toMatchObject({ alreadyReceived: true });
    expect(((await get(h, '/v1/inventory/goods-receipt', 'u-owner')).body as { count: number }).count).toBe(2);
    expect((await orderOf(h, 'po-1')).order.receivedByProduct).toEqual({ 'p-rice': 5, 'p-dal': 5 });

    // The damaged line: the receiver cannot dispose of it; the second person ACCEPTS it → ONE movement for the units the scans held out.
    expect(codeOf(await post(h, '/v1/inventory/goods-receipt/grn-1/lines/grn-1:2/disposition', 'u-worker', { disposition: 'accept', reason: 'mine' }, 'disp-self'))).toBe('self_approval');
    const accepted = await post(h, '/v1/inventory/goods-receipt/grn-1/lines/grn-1:2/disposition', 'u-boss', { disposition: 'accept', reason: 'only the sack was torn' }, 'disp-1');
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ quantityMinor: 1, movementIds: ['grn-1:grn-1:2:accepted'], availableMinor: 10, awaitsDecision: false });
    expect(await onHandAt(h, 'p-rice')).toBe(5);
    expect((await movementIds(h)).filter((id) => id.startsWith('grn-1:'))).toEqual(['grn-1:grn-1:2:accepted']);
  });

  it('a delivery over the order is HELD on the receipt but is already on the shelf: approval accepts it where it is (no movement, the order told); rejection moves nothing and flags it for the supplier return', async () => {
    const h = await seeded();
    await issue(h, 'po-2', [{ productId: 'p-rice', orderedQty: 10 }]);
    await issue(h, 'po-3', [{ productId: 'p-rice', orderedQty: 10 }]);
    for (const grnId of ['grn-2', 'grn-3']) {
      for (let i = 1; i <= 12; i += 1) expect((await relayScan(h, `${grnId}-c${i}`, grnId, 'p-rice', 1)).status).toBe(202);
    }
    expect(await onHandAt(h, 'p-rice')).toBe(24);

    const two = (await complete(h, 'grn-2', { poId: 'po-2' })).body as AssembledBody;
    expect(two.grn).toMatchObject({ availableMinor: 10, heldMinor: 2 });
    expect(two.grn.captured.lines[0]).toMatchObject({ sellableMinor: 10, heldMinor: 2 });
    expect(two.grn.governanceFlags).toEqual(['excess_already_on_hand']);
    expect(two.awaitsDecision).toBe(true);
    expect(two.grn.poReceipt).toEqual({ receiptId: 'grn-2', receivedByProduct: { 'p-rice': 10 } });
    expect(await onHandAt(h, 'p-rice')).toBe(24); // the receipt posted nothing — the 12 were already there

    // The receiver cannot approve their own excess; the second person does → released on paper, NO movement, the order told of the over-receipt.
    expect(codeOf(await post(h, '/v1/inventory/goods-receipt/grn-2/excess/decide', 'u-worker', { decision: 'approved', reason: 'mine' }, 'ex-self'))).toBe('self_approval');
    const approved = await post(h, '/v1/inventory/goods-receipt/grn-2/excess/decide', 'u-boss', { decision: 'approved', reason: 'supplier confirmed the extra two are free' }, 'ex-2');
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ decision: 'approved', releasedMinor: 2, movementIds: [], availableMinor: 12, heldMinor: 2 });
    expect(await onHandAt(h, 'p-rice')).toBe(24);
    expect((await movementIds(h)).filter((id) => id.includes('grn-2'))).toEqual(Array.from({ length: 12 }, (_, i) => `recv:grn-2:grn-2-c${i + 1}`));
    expect(await orderOf(h, 'po-2')).toMatchObject({ order: { receivedByProduct: { 'p-rice': 12 } }, openCommitment: { lines: [{ receivedQty: 12, openQty: -2 }] } });
    expect((await readGrn(h, 'grn-2')).grn.governanceFlags).toEqual(['excess_already_on_hand']);

    // The other delivery's excess is REJECTED: nothing moves (nothing is invented to move it); the units are flagged for the
    // supplier return (SP-7) and never count as received against the order.
    const three = (await complete(h, 'grn-3', { poId: 'po-3' })).body as AssembledBody;
    expect(three.grn).toMatchObject({ availableMinor: 10, heldMinor: 2 });
    const rejected = await post(h, '/v1/inventory/goods-receipt/grn-3/excess/decide', 'u-boss', { decision: 'rejected', reason: 'not ordered — going back' }, 'ex-3');
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ decision: 'rejected', releasedMinor: 0, movementIds: [], availableMinor: 10, heldMinor: 2 });
    expect(await onHandAt(h, 'p-rice')).toBe(24);
    const after = (await readGrn(h, 'grn-3')).grn;
    expect(after.governanceFlags).toEqual(['excess_already_on_hand', 'excess_on_hand_pending_return']);
    expect(after.excessDecision).toMatchObject({ decision: 'rejected', releasedMinor: 0, movementIds: [] });
    expect((await orderOf(h, 'po-3')).order.receivedByProduct).toEqual({ 'p-rice': 10 });
    // Neither delivery waits for a person any more; the same decision again is a no-op, a different one is refused.
    expect(((await get(h, '/v1/inventory/goods-receipt', 'u-owner')).body as { heldExcessCount: number; needingApprovalCount: number })).toMatchObject({ heldExcessCount: 0, needingApprovalCount: 0 });
    expect((await post(h, '/v1/inventory/goods-receipt/grn-3/excess/decide', 'u-boss', { decision: 'rejected', reason: 'again' }, 'ex-3b')).body).toMatchObject({ alreadyDecided: true });
    expect(codeOf(await post(h, '/v1/inventory/goods-receipt/grn-3/excess/decide', 'u-boss', { decision: 'approved', reason: 'changed my mind' }, 'ex-3c'))).toBe('excess_already_decided');
    expect(await onHandAt(h, 'p-rice')).toBe(24);
  });

  it('refusals by name, nothing changed: no scans; a malformed completion; a batch-tracked item scanned without its batch; a caller without the right; an unknown completer is recorded and flagged', async () => {
    const h = await seeded();
    // No scans for the delivery → nothing to assemble; the box dead-letters this for a person.
    const none = await complete(h, 'grn-x', { poId: 'po-1' });
    expect(none.status).toBe(422);
    expect(codeOf(none)).toBe('no_scans_for_receipt');
    expect((await get(h, '/v1/inventory/goods-receipt/grn-x', 'u-owner')).status).toBe(404);
    // Malformed: no completedBy.
    const bad = await post(h, '/v1/inventory/goods-receipt/grn-x/assembled', 'u-box', { grnId: 'grn-x', at: AT }, 'bad');
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_receiving_completion');
    // A batch-tracked item scanned with no batch: the master's rule holds here as on every receipt — refused, the scans stay on the register.
    expect((await relayScan(h, 'm1', 'grn-m', 'p-milk', 6, { poId: null })).status).toBe(202);
    const milk = await complete(h, 'grn-m');
    expect(milk.status).toBe(422);
    expect(codeOf(milk)).toBe('receipt_line_incomplete');
    expect((await get(h, '/v1/inventory/goods-receipt/grn-m', 'u-owner')).status).toBe(404);
    expect(((await get(h, '/v1/inventory/receiving-scans', 'u-owner', { grnId: 'grn-m' })).body as { count: number }).count).toBe(1);
    // The box's identity cannot use the person's route, and a person without the right cannot assemble at all.
    expect((await post(h, '/v1/inventory/goods-receipt/grn-m/assemble', 'u-box', {}, 'a-box')).status).toBe(403);
    // A completer head office does not know is recorded — the goods are in the building — and flagged, never silently trusted.
    expect((await relayScan(h, 'g1', 'grn-g', 'p-rice', 2, { receivedBy: 'u-ghost' })).status).toBe(202);
    const ghost = (await complete(h, 'grn-g', { completedBy: 'u-ghost' })).body as AssembledBody;
    expect(ghost.grn).toMatchObject({ receivedBy: 'u-ghost', availableMinor: 2, poId: null, poReceipt: null });
    expect(ghost.grn.governanceFlags).toEqual(expect.arrayContaining(['receiver_unknown', 'no_purchase_order']));
    expect(ghost.grn.assembledFrom?.scannedBy).toEqual(['u-ghost']);
  });

  it('the order comes from head office\'s register: an order it does not hold is said and folded into nothing; the scans\' own order is used when the completion names none', async () => {
    const h = await seeded();
    expect((await relayScan(h, 'u1', 'grn-u', 'p-rice', 3, { poId: 'po-nope' })).status).toBe(202);
    const unknown = (await complete(h, 'grn-u', { poId: 'po-nope' })).body as AssembledBody;
    expect(unknown.grn).toMatchObject({ poId: 'po-nope', poReceipt: null, availableMinor: 3 });
    expect(unknown.grn.governanceFlags).toContain('order_unknown');
    // No order on the completion → the scans named po-1 → folded into it.
    expect((await relayScan(h, 's1', 'grn-s', 'p-dal', 2, { poId: 'po-1' })).status).toBe(202);
    const fromScans = (await complete(h, 'grn-s')).body as AssembledBody;
    expect(fromScans.grn).toMatchObject({ poId: 'po-1', poReceipt: { receiptId: 'grn-s', receivedByProduct: { 'p-dal': 2 } } });
    expect((await orderOf(h, 'po-1')).order.receivedByProduct).toEqual({ 'p-dal': 2 });
  });
});
