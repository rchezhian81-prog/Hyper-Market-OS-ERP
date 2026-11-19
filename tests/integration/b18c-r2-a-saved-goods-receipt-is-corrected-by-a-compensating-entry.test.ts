import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received, capturedAndMatched } from '../support/p3-purchase';
import { askForApproval, decide, sentWithApproval } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';

/**
 * **R2 · batch 18c — a saved goods receipt is CORRECTED when a wrong quantity was keyed (M07-FR-01/03 · M08-FR-01 · hard rules
 * #2, #10 · pilot audit B-5 · OB-873) — through the real API, in memory and on real PostgreSQL, with a cold restart.**
 *
 *   • the receipt is never changed — it keeps its number and its lines; the correction is its own record with a `GRC1/…`
 *     number, linked to it;
 *   • the stock ledger gets a compensating movement of the difference, the order's received quantity a compensating
 *     posting, so the open commitment reads the corrected figure;
 *   • a bill already matched against the old quantity becomes a visible exception — a debit note needed (fewer units) or
 *     a re-match (more units) — never silently changed;
 *   • it needs a reason and a second person's approval (never the person who asks);
 *   • a correction that would take stock below what is still there (already sold) is refused in plain words.
 */

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const RICE = [{ productId: 'rice', qty: 10, unitMinor: 5_000 }];
interface Correction { documentNumber?: string; receiptNumber: string; wasMinor: number; nowMinor: number; deltaMinor: number; valueMinor: number; approvedBy: string; orderCorrected: boolean; billExceptions: { invoiceId: string; kind: string; paid: boolean; valueMinor: number; says: string }[] }

describe.each(backings)('R2: a saved goods receipt is corrected by a compensating entry — on $name', ({ harness }) => {
  it('numbers the correction, fixes stock and the order, raises the bill exception, needs a second person, refuses below what was sold', async () => {
    let h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    let call = caller(h, T);
    await issuedOrder(call, 'po-1', RICE);
    const grn = (await received(call, 'grn-1', 'po-1', RICE)).body as { grn?: { documentNumber?: string } };
    await capturedAndMatched(call, 'inv-1', 'po-1', RICE);
    const onHand = async (): Promise<number> =>
      ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: P3.OWNER, tenantId: T, query: { productId: 'rice' } })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows.find((r) => r.locationId === P3.BACK)?.onHandMinor ?? 0;
    const order = async () => ((await call('GET', '/v1/purchase/orders/po-1', P3.OWNER)).body as { order: { receivedByProduct: Record<string, number> }; openCommitment: { lines?: unknown } | null }).order;
    const grnNow = async () => ((await call('GET', '/v1/inventory/goods-receipt/grn-1', P3.OWNER)).body as { grn?: { documentNumber?: string; captured: { lines: { sellableMinor: number }[] } }; documentNumber?: string; captured?: { lines: { sellableMinor: number }[] } });
    const before = await grnNow();
    expect(await onHand()).toBe(10);
    expect((await order()).receivedByProduct['rice']).toBe(10);
    const post = (id: string, body: Record<string, unknown>, who: string = P3.RECEIVER) => h.request({ method: 'POST', path: `/v1/inventory/goods-receipt/grn-1/corrections/${id}`, userId: who, tenantId: T, idempotencyKey: `corr-${randomUUID()}`, body });

    // 10 were keyed; 8 came. No reason → refused; no approval → refused; the person asking cannot approve it.
    expect(codeOf(await post('c-1', { lineId: 'L1', correctQuantityMinor: 8 }))).toBe('reason_required');
    const body1 = { lineId: 'L1', correctQuantityMinor: 8, reason: '10 keyed, 8 bags on the pallet' };
    expect(codeOf(await post('c-1', body1))).toBe('correction_needs_approval');
    expect(await onHand()).toBe(10);
    const asked = await askForApproval(h, T, P3.RECEIVER, { kind: 'goods_receipt_correction', subjectRef: 'c-1', details: actionDetails(body1, { grnId: 'grn-1', correctionId: 'c-1' }), valueMinor: 10_000 });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect((await decide(h, T, P3.RECEIVER, (asked.body as { requestId: string }).requestId)).status).toBeGreaterThanOrEqual(400);
    expect((await decide(h, T, P3.BUYER, (asked.body as { requestId: string }).requestId)).status).toBe(201);
    const c1Res = await post('c-1', { ...body1, approvalId: (asked.body as { requestId: string }).requestId });
    expect(c1Res.status, JSON.stringify(c1Res.body)).toBe(201);
    const c1 = (c1Res.body as { correction: Correction }).correction;
    expect(c1.documentNumber).toMatch(/^GRC1\/\d\d-\d\d\/00001$/);
    expect([c1.wasMinor, c1.nowMinor, c1.deltaMinor, c1.valueMinor, c1.approvedBy, c1.orderCorrected]).toEqual([10, 8, -2, 10_000, P3.BUYER, true]);
    // The bill matched for 10 is now a visible exception: a debit note is needed.
    expect(c1.billExceptions.map((x) => [x.invoiceId, x.kind, x.paid, x.valueMinor])).toEqual([['inv-1', 'debit_note_needed', false, 10_000]]);
    expect(c1.billExceptions[0]!.says).toMatch(/A debit note to the supplier for ₹100\.00 \(before GST\) is needed/);

    h = harness(h); // ── COLD RESTART ──
    call = caller(h, T);

    // Stock and the order read the corrected figure; the receipt itself is unchanged.
    expect(await onHand()).toBe(8);
    expect((await order()).receivedByProduct['rice']).toBe(8);
    expect(await grnNow()).toEqual(before);
    void grn;

    // 9 actually came (one more found): +1, the bill now needs a re-match.
    const c2Res = await sentWithApproval(h, T, P3.RECEIVER, P3.OWNER, { kind: 'goods_receipt_correction', subjectRef: 'c-2', pathIds: { grnId: 'grn-1', correctionId: 'c-2' }, valueMinor: 5_000 },
      { lineId: 'L1', correctQuantityMinor: 9, reason: 'one more bag found behind the pallet' }, (b) => post('c-2', b));
    expect(c2Res.status, JSON.stringify(c2Res.body)).toBe(201);
    const c2 = (c2Res.body as { correction: Correction }).correction;
    expect(c2.documentNumber).toMatch(/^GRC1\/\d\d-\d\d\/00002$/);
    expect([c2.wasMinor, c2.deltaMinor, c2.billExceptions[0]?.kind]).toEqual([8, 1, 'rematch_needed']);
    expect(await onHand()).toBe(9);
    expect((await order()).receivedByProduct['rice']).toBe(9);

    // 8 are sold; only 1 is left — a correction to 0 would take stock below what was sold: refused in plain words.
    const sold = await call('POST', '/v1/inventory/movements', P3.OWNER, { movementId: 'sale-rice', productId: 'rice', locationId: P3.BACK, kind: 'sold', quantityMinor: 8, uom: 'ea', occurredAt: '2026-10-25T09:00:00.000Z', enteredBy: P3.OWNER });
    expect(sold.status, JSON.stringify(sold.body)).toBeLessThan(300);
    const tooFar = await sentWithApproval(h, T, P3.RECEIVER, P3.OWNER, { kind: 'goods_receipt_correction', subjectRef: 'c-3', pathIds: { grnId: 'grn-1', correctionId: 'c-3' }, valueMinor: 45_000 },
      { lineId: 'L1', correctQuantityMinor: 0, reason: 'nothing came' }, (b) => post('c-3', b));
    expect(codeOf(tooFar)).toBe('correction_below_what_was_sold');
    expect((tooFar.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/only 1 of rice are still at wh-1 — the rest were already sold or moved/);
    expect(await onHand()).toBe(1);

    // The receipt screen's view: the original, every correction, and the open bill exceptions.
    const view = (await call('GET', '/v1/inventory/goods-receipt/grn-1/corrections', P3.OWNER)).body as { lines: { receivedMinor: number; nowMinor: number }[]; corrections: Correction[]; openBillExceptions: { kind: string }[] };
    expect(view.lines).toEqual([expect.objectContaining({ receivedMinor: 10, nowMinor: 9 })]);
    expect(view.corrections).toHaveLength(2);
    expect(view.openBillExceptions.map((x) => x.kind)).toEqual(['debit_note_needed', 'rematch_needed']);
    // The audit trail names who asked, who approved, and why.
    const trail = ((await h.request({ method: 'GET', path: '/v1/audit/trail', userId: P3.OWNER, tenantId: T, query: { action: 'goods_receipt.correct' } })).body as { matches: { actorId: string; reason?: string; after: Record<string, string> }[] }).matches;
    expect(trail.map((m) => [m.actorId, m.after['approvedBy'], m.after['deltaMinor'], m.reason])).toEqual(expect.arrayContaining([
      [P3.RECEIVER, P3.BUYER, '-2', '10 keyed, 8 bags on the pallet'], [P3.RECEIVER, P3.OWNER, '1', 'one more bag found behind the pallet'],
    ]));
  }, 120_000);
});
