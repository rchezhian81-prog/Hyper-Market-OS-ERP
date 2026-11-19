import { describe, it, expect } from 'vitest';
import {
  receiptMonthLock, monthInWords, receiptMonthOf, goodsReceiptCorrectionRoutes,
  type ReceiptMonthState, type ReceiptCorrectionDeps,
} from '../../services/inventory/src/goods-receipt-corrections';
import { createReceiptCorrectionSession } from '../../apps/web-erp/src/receipt-correction-session';
import type { GrnRecord } from '../../services/inventory/src/goods-receipt';
import type { HeadOfficeHttp } from '../../apps/web-erp/src/head-office-http';

/**
 * R2 · batch 18c · OB-875 B (owner, 19 Nov 2026): a saved goods receipt is NOT corrected when its month's GST return is
 * filed, or its accounting month is closed and signed — until the CA signs the month off by reopening it (the existing
 * `period_reopen` approval). Head office refuses it in plain words; the screen shows those words.
 */

const N = 'GRN1/26-27/00001';
const open = (over: Partial<ReceiptMonthState> = {}): ReceiptMonthState => ({ period: '2026-10', accounts: 'open', filedReturns: [], ...over });

describe('OB-875 B: the month lock on correcting a saved receipt', () => {
  it('an open month with nothing filed is corrected', () => {
    expect(receiptMonthLock(N, open())).toEqual({ locked: false });
  });

  it('a closed and signed month is refused, pointing to the CA reopening it', () => {
    const lock = receiptMonthLock(N, open({ accounts: 'closed' }));
    expect(lock).toMatchObject({ locked: true, why: 'accounts_signed', period: '2026-10' });
    if (!lock.locked) throw new Error('locked');
    expect(lock.says).toBe(`${N} is dated October 2026. That month's accounts are closed and signed, so the receipt is not corrected until the CA signs the month off. Ask the CA to reopen October 2026 (Approvals → Reopen a signed accounting month), then correct the receipt.`);
  });

  it('a month whose GST return is filed is refused — and its words name the return', () => {
    const lock = receiptMonthLock(N, open({ filedReturns: [{ type: 'GSTR1', filedOn: '2026-11-11' }, { type: 'GSTR3B', filedOn: '2026-11-20' }] }));
    expect(lock).toMatchObject({ locked: true, why: 'gst_filed' });
    if (!lock.locked) throw new Error('locked');
    expect(lock.says).toMatch(/^GRN1\/26-27\/00001 is dated October 2026\. That month's GST return \(GSTR-1 and GSTR-3B\) is filed, so the receipt is not corrected until the CA signs the month off\./);
    expect(lock.says).toMatch(/Approvals → Reopen a signed accounting month/);
    // Filed AND signed: the signed words, naming the filed return too.
    const both = receiptMonthLock(N, open({ accounts: 'closed', filedReturns: [{ type: 'GSTR1', filedOn: '2026-11-11' }] }));
    expect(both.locked && both.says).toMatch(/That month's GST return \(GSTR-1\) is filed and its accounts are closed and signed/);
  });

  it('a month the CA reopened on or after the last filing is corrected; a reopen before a later filing is not enough', () => {
    const filed = [{ type: 'GSTR1', filedOn: '2026-11-11' }, { type: 'GSTR3B', filedOn: '2026-11-20' }];
    expect(receiptMonthLock(N, open({ filedReturns: filed, reopenedOn: '2026-11-20' }))).toEqual({ locked: false });
    expect(receiptMonthLock(N, open({ filedReturns: filed, reopenedOn: '2026-11-15' })).locked).toBe(true);
  });

  it('names the month in words, and takes the receipt\'s month from the shop\'s trading day', () => {
    expect([monthInWords('2026-01'), monthInWords('2026-12'), monthInWords('bad')]).toEqual(['January 2026', 'December 2026', 'bad']);
    expect(receiptMonthOf({ receivedAt: '2026-10-15T06:00:00.000Z' } as GrnRecord)).toBe('2026-10');
  });
});

describe('OB-875 B: head office refuses it before anyone is asked to approve, and the screen shows why', () => {
  const rec = {
    grnId: 'grn-1', number: 'grn-1', documentNumber: N, poId: null, warehouseId: 'wh-1', receivedBy: 'u', receivedAt: '2026-10-15T06:00:00.000Z',
    captured: { lines: [{ lineId: 'L1', productId: 'rice', sellableMinor: 10, uom: 'ea', unitCost: { minor: 5_000, currency: 'INR' }, batchId: null, expiry: null }] },
  } as unknown as GrnRecord;
  const deps = (state: ReceiptMonthState): ReceiptCorrectionDeps => ({
    grn: () => rec, corrections: () => [], onHandAt: () => 10, billsForOrder: () => [], now: () => '2026-11-19T06:00:00.000Z',
    commitCorrection: async () => { throw new Error('must not save'); },
    monthState: (_t, period) => ({ ...state, period }),
  });
  const ctx = { tenantId: 't', userId: 'u-mgr', branchId: null, scope: 'all', params: { grnId: 'grn-1', correctionId: 'c-1' }, query: {}, body: { lineId: 'L1', correctQuantityMinor: 8, reason: '10 keyed, 8 came' }, traceId: 'x' };

  it('POST is refused with code receipt_month_filed_or_signed; GET carries the same words', async () => {
    const routes = goodsReceiptCorrectionRoutes(deps(open({ filedReturns: [{ type: 'GSTR1', filedOn: '2026-11-11' }] })));
    const post = routes.find((r) => r.method === 'POST')!;
    const err = await Promise.resolve(post.handler(ctx as never)).then(() => undefined, (e: unknown) => e as { status: number; body: { code: string; whatHappened: string; wasItSaved: string } });
    expect(err?.status).toBe(409);
    expect(err?.body.code).toBe('receipt_month_filed_or_signed');
    expect(err?.body.wasItSaved).toBe('not_saved');
    expect(err?.body.whatHappened).toMatch(/That month's GST return \(GSTR-1\) is filed.*Nothing was changed\.$/);
    const get = routes.find((r) => r.method === 'GET')!;
    const view = (await get.handler({ ...ctx, body: undefined } as never)).body as { monthLocked?: { period: string; why: string; says: string } };
    expect(view.monthLocked).toMatchObject({ period: '2026-10', why: 'gst_filed' });
    // An open month: no lock in the view, and the POST goes on to ask for the second person (no approvals port here).
    const free = goodsReceiptCorrectionRoutes(deps(open()));
    expect(((await free.find((r) => r.method === 'GET')!.handler({ ...ctx, body: undefined } as never)).body as { monthLocked?: unknown }).monthLocked).toBeUndefined();
    const askFirst = await Promise.resolve(free.find((r) => r.method === 'POST')!.handler(ctx as never)).then(() => undefined, (e: unknown) => e as { body: { code: string } });
    expect(askFirst?.body.code).toBe('correction_needs_approval');
  });

  it('the screen model carries head office\'s words when the receipt is opened, and shows the refusal on Save', async () => {
    const says = `${N} is dated October 2026. That month's accounts are closed and signed, so the receipt is not corrected until the CA signs the month off. Ask the CA to reopen October 2026 (Approvals → Reopen a signed accounting month), then correct the receipt.`;
    const http: HeadOfficeHttp = {
      get: async (path) => path === '/v1/inventory/goods-receipt'
        ? { result: 'ok', status: 200, body: { receipts: [{ grnId: 'grn-1', documentNumber: N }] } }
        : { result: 'ok', status: 200, body: { grnId: 'grn-1', receiptNumber: N, lines: [], corrections: [], monthLocked: { period: '2026-10', why: 'accounts_signed', says } } },
      post: async () => ({ result: 'refused', status: 409, code: 'receipt_month_filed_or_signed', whatHappened: `${says} Nothing was changed.` }),
    };
    const s = createReceiptCorrectionSession({ permissions: ['inventory.movement.append'] }, http, () => 'grc-1');
    const v = await s.open(N);
    expect(v !== 'not_found' && v !== 'lost_link' && v.monthLocked).toBe(says);
    const out = await s.save('grn-1', { lineId: 'L1', right: '8', why: 'x' });
    expect(s.outcomeWords('en', out)).toBe(`Head office did not save it: ${says} Nothing was changed.`);
  });
});
