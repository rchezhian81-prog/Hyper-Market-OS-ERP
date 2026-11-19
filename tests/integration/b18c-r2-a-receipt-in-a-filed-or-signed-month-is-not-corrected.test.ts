import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings, dayFromToday } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received } from '../support/p3-purchase';
import { approvedRequestId, sentWithApproval } from '../support/approval-request';
import { financeAdapter } from '../../services/api/src/adapters';
import { tradingMonthIn } from '../../packages/calendar/src/shop-clock';

/**
 * **R2 · batch 18c · OB-875 B (owner, 19 Nov 2026, in writing) — a saved goods receipt is NOT corrected once its month's GST
 * return is filed, or its accounting month is closed and signed, until the CA signs the month off (reopens it with the
 * existing `period_reopen` approval) — through the real API, in memory and on real PostgreSQL, with a cold restart.**
 *
 *   • an open month with nothing filed: the correction is saved (with the second person's approval);
 *   • GSTR-1 of the month recorded filed: refused at head office, in words that name the month and the way forward, before
 *     anyone is asked to approve; the receipt view carries the same words; nothing changed;
 *   • the month closed and signed as well: refused, the signed words;
 *   • the CA reopens the month (Approvals → Reopen a signed accounting month): the correction is saved.
 */

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const saidOf = (r: Res): string => (r.body as { error?: { whatHappened?: string } }).error?.whatHappened ?? '';
const RICE = [{ productId: 'rice', qty: 10, unitMinor: 5_000 }];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

describe.each(backings)('OB-875 B: a receipt in a filed or signed month is not corrected until the CA reopens it — on $name', ({ harness }) => {
  it('open month: saved; GST filed: refused; signed: refused; reopened by the CA: saved', async () => {
    let h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    let call = caller(h, T);
    await issuedOrder(call, 'po-1', RICE);
    await received(call, 'grn-1', 'po-1', RICE);
    const grn = ((await call('GET', '/v1/inventory/goods-receipt/grn-1', P3.OWNER)).body as { grn: { receivedAt: string; documentNumber: string } }).grn;
    const month = tradingMonthIn(grn.receivedAt);
    const inWords = `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
    const onHand = async (): Promise<number> =>
      ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: P3.OWNER, tenantId: T, query: { productId: 'rice' } })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows.find((r) => r.locationId === P3.BACK)?.onHandMinor ?? 0;
    const post = (id: string, body: Record<string, unknown>) => h.request({ method: 'POST', path: `/v1/inventory/goods-receipt/grn-1/corrections/${id}`, userId: P3.RECEIVER, tenantId: T, idempotencyKey: `corr-${randomUUID()}`, body });
    const approved = (id: string, body: Record<string, unknown>) => sentWithApproval(h, T, P3.RECEIVER, P3.OWNER, { kind: 'goods_receipt_correction', subjectRef: id, pathIds: { grnId: 'grn-1', correctionId: id }, valueMinor: null }, body, (b) => post(id, b));
    const view = async () => ((await call('GET', '/v1/inventory/goods-receipt/grn-1/corrections', P3.OWNER)).body as { monthLocked?: { period: string; why: string; says: string } }).monthLocked;

    // 1. An open month with nothing filed: corrected as before.
    expect(await view()).toBeUndefined();
    const c1 = await approved('c-1', { lineId: 'L1', correctQuantityMinor: 9, reason: '10 keyed, 9 came' });
    expect(c1.status, JSON.stringify(c1.body)).toBe(201);
    expect(await onHand()).toBe(9);

    // 2. The month's GSTR-1 is recorded filed (on the filing register): refused before anyone is asked to approve.
    const gst = `${month.slice(5, 7)}${month.slice(0, 4)}`;
    const filed = await call('POST', `/v1/finance/returns/GSTR1/${gst}/filed`, P3.OWNER, { arn: 'AA3311260000001', filedOn: dayFromToday(0) });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const body2 = { lineId: 'L1', correctQuantityMinor: 8, reason: 'one more bag was short' };
    const refusedFiled = await post('c-2', body2);
    expect(refusedFiled.status).toBe(409);
    expect(codeOf(refusedFiled)).toBe('receipt_month_filed_or_signed');
    expect(saidOf(refusedFiled)).toBe(`${grn.documentNumber} is dated ${inWords}. That month's GST return (GSTR-1) is filed, so the receipt is not corrected until the CA signs the month off. Ask the CA to close and sign ${inWords} and then reopen it (Approvals → Close and sign an accounting month, then Approvals → Reopen a signed accounting month), then correct the receipt. Nothing was changed.`);
    // Even with a second person's approval in hand, it is refused — head office decides, not the screen.
    expect(codeOf(await approved('c-2', body2))).toBe('receipt_month_filed_or_signed');
    expect(await view()).toMatchObject({ period: month, why: 'gst_filed' });
    expect(await onHand()).toBe(9);

    // 3. The month is closed and signed as well (the finance period close's own fact): refused in the signed words.
    await financeAdapter({ store: h.store, now: () => new Date().toISOString() }).markClosed(T, month, P3.MATCHER);
    const refusedSigned = await post('c-2', body2);
    expect(codeOf(refusedSigned)).toBe('receipt_month_filed_or_signed');
    expect(saidOf(refusedSigned)).toBe(`${grn.documentNumber} is dated ${inWords}. That month's GST return (GSTR-1) is filed and its accounts are closed and signed, so the receipt is not corrected until the CA signs the month off. Ask the CA to reopen ${inWords} (Approvals → Reopen a signed accounting month), then correct the receipt. Nothing was changed.`);

    h = harness(h); // ── COLD RESTART ──
    call = caller(h, T);
    expect(await view()).toMatchObject({ period: month, why: 'accounts_signed' });

    // 4. The CA signs it off: the existing reopen, approved by the accountant (not the owner who asks).
    const reason = 'a receipt keyed wrong must be corrected';
    const approvalId = await approvedRequestId(h, T, P3.OWNER, P3.MATCHER, { kind: 'period_reopen', subjectRef: month, details: { reason, period: month } });
    const reopened = await call('POST', `/v1/finance/periods/${month}/reopen`, P3.OWNER, { reason, approvalId });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(await view()).toBeUndefined();
    const c2 = await approved('c-3', body2);
    expect(c2.status, JSON.stringify(c2.body)).toBe(201);
    expect(await onHand()).toBe(8);
  }, 120_000);
});
