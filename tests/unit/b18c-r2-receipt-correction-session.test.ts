import { describe, it, expect } from 'vitest';
import { createReceiptCorrectionSession, correctionRowOf, RECEIPT_CORRECTION_WORDS } from '../../apps/web-erp/src/receipt-correction-session';
import { correctedSellable } from '../../services/inventory/src/goods-receipt-corrections';
import type { HeadOfficeHttp, HttpAnswer } from '../../apps/web-erp/src/head-office-http';
import type { GrnRecord } from '../../services/inventory/src/goods-receipt';

/** R2 · batch 18c (OB-873): the corrected quantity of a line, and the "Correct a saved receipt" box's model. */

describe('R2: a saved receipt corrected', () => {
  it('the quantity in stock from a line is the saved one plus every correction of it — the receipt itself is never changed', () => {
    const rec = { grnId: 'g', captured: { lines: [{ lineId: 'L1', sellableMinor: 10 }, { lineId: 'L2', sellableMinor: 5 }] } } as unknown as GrnRecord;
    const c = (lineId: string, deltaMinor: number, grnId = 'g') => ({ grnId, lineId, deltaMinor }) as never;
    expect(correctedSellable(rec, [c('L1', -2), c('L1', 1), c('L2', 3, 'other')])).toEqual({ L1: 9, L2: 5 });
  });

  it('opens a receipt by its number; saves only a complete form; asks for exactly this correction; then saves it with the approval', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const posts: HttpAnswer[] = [
      { result: 'refused', status: 422, code: 'correction_needs_approval', whatHappened: 'A second person who handles stock approves it first.' },
      { result: 'ok', status: 201, body: { requestId: 'req-1' } },
      { result: 'ok', status: 201, body: { correction: { correctionId: 'grc-1', documentNumber: 'GRC1/26-27/00001', lineId: 'L1', productId: 'RICE', wasMinor: 10, nowMinor: 8, deltaMinor: -2, valueMinor: 10_000, requestedBy: 'u-mgr', approvedBy: 'u-owner', reason: 'r', billExceptions: [{ says: 'A debit note to the supplier for ₹100.00 (before GST) is needed.' }] } } },
    ];
    const http: HeadOfficeHttp = {
      get: async (path) => {
        calls.push({ method: 'GET', path });
        if (path === '/v1/inventory/goods-receipt') return { result: 'ok', status: 200, body: { receipts: [{ grnId: 'grn-1', documentNumber: 'GRN1/26-27/00001', number: 'grn-1' }] } };
        return { result: 'ok', status: 200, body: { grnId: 'grn-1', receiptNumber: 'GRN1/26-27/00001', lines: [{ lineId: 'L1', productId: 'RICE', uom: 'ea', receivedMinor: 10, nowMinor: 10 }], corrections: [] } };
      },
      post: async (path, body) => { calls.push({ method: 'POST', path, body }); return posts.shift() ?? { result: 'lost_link' }; },
    };
    const s = createReceiptCorrectionSession({ userId: 'u-mgr', permissions: ['inventory.movement.append'] }, http, () => 'grc-1');
    expect(await s.open('GRN1/26-27/00009')).toBe('not_found');
    const v = await s.open('GRN1/26-27/00001');
    expect(v).toMatchObject({ grnId: 'grn-1', lines: [{ lineId: 'L1', receivedMinor: 10 }] });
    expect(await s.save('grn-1', { lineId: 'L1', right: '8', why: '' })).toEqual({ kind: 'invalid' });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect((await s.save('grn-1', { lineId: 'L1', right: '8', why: '10 keyed' })).kind).toBe('needs_approval');
    expect((await s.askApproval('grn-1', { lineId: 'L1', right: '8', why: '10 keyed' }, 'Correct')).kind).toBe('asked');
    const done = await s.save('grn-1', { lineId: 'L1', right: '8', why: '10 keyed' });
    expect(s.outcomeWords('en', done)).toBe('Saved: GRC1/26-27/00001 · 10 → 8 · ₹100.00 · Needs a person: A debit note to the supplier for ₹100.00 (before GST) is needed.');
    const p = calls.filter((c) => c.method === 'POST');
    expect(p.map((c) => c.path)).toEqual(['/v1/inventory/goods-receipt/grn-1/corrections/grc-1', '/v1/approvals/requests', '/v1/inventory/goods-receipt/grn-1/corrections/grc-1']);
    expect(p[1]!.body).toMatchObject({ kind: 'goods_receipt_correction', subjectRef: 'grc-1', valueMinor: null, details: { lineId: 'L1', correctQuantityMinor: 8, reason: '10 keyed', grnId: 'grn-1', correctionId: 'grc-1' } });
    expect(p[2]!.body).toMatchObject({ approvalId: 'req-1' });
    expect(createReceiptCorrectionSession({ permissions: ['inventory.availability.read'] }, http).may).toBe(false);
    expect(correctionRowOf({})).toBeNull();
    expect(Object.keys(RECEIPT_CORRECTION_WORDS.ta).sort()).toEqual(Object.keys(RECEIPT_CORRECTION_WORDS.en).sort());
  });
});
