import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received, capturedAndMatched } from '../support/p3-purchase';
import { approvedRequestId } from '../support/approval-request';
import type { ApiHarness } from '../support/api-harness';
import { paymentTerms } from '../../services/purchase/src/supplier-master';

// OB-807 A (owner, 16 Nov 2026, in writing) · daily-work defect D-046 · M23-FR-01 · §28: a supplier payment is APPROVED on
// its terms — the supplier, the amount, how it is paid and the bills it settles — before the money goes; the day it was
// paid and its bank reference (UTR) are added when it is RECORDED, because they exist only afterwards. Nothing is loosened:
//   • asked and approved with no day and no UTR, then recorded with them — exactly the approved terms;
//   • recording a different amount, different bills, another method or another payment with that approval is refused;
//   • the approval is used once; a day still to come is refused and leaves the approval unused; nothing without approval;
//   • an approval asked the older way (with its day and UTR) must still match them exactly.
// Synthetic data. In memory and — with DATABASE_URL — on real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const shopToday = (): string => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const tomorrow = (): string => new Date(Date.now() + 330 * 60_000 + 86_400_000).toISOString().slice(0, 10);

describe.each(backings)('OB-807 A: a supplier payment is approved before it is paid; the day and UTR come when it is recorded — on $name', ({ harness }) => {
  it('approve on terms, record with the day and UTR; a different amount, bills, method or payment is refused; once; never a day to come; never without approval', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    const TODAY = shopToday();
    for (const [id, qty] of [['a', 10], ['b', 6]] as const) {
      const lines = [{ productId: 'rice', qty, unitMinor: 5_000 }];
      await issuedOrder(call, `po-${id}`, lines);
      await received(call, `grn-${id}`, `po-${id}`, lines);
      await capturedAndMatched(call, `inv-${id}`, `po-${id}`, lines, undefined, 'sup-1', TODAY);
    }
    // The payment's terms: what is asked and approved BEFORE paying — no day, no reference.
    const terms = (paymentId: string, amountMinor: number, settles: readonly string[], method = 'cash') =>
      paymentTerms({ amountMinor, method, settles }, { supplierId: 'sup-1', paymentId });
    const approve = (paymentId: string, amountMinor: number, settles: readonly string[], method = 'cash') =>
      approvedRequestId(h, T, P3.PAYER, P3.PAY_APPROVER, { kind: 'supplier_payment', subjectRef: `sup-1/${paymentId}`, details: terms(paymentId, amountMinor, settles, method), valueMinor: amountMinor });
    const record = (hh: ApiHarness, paymentId: string, body: Record<string, unknown>) =>
      hh.request({ method: 'POST', path: `/v1/purchase/suppliers/sup-1/payments/${paymentId}`, userId: P3.PAYER, tenantId: T, idempotencyKey: `rec-${randomUUID()}`, body });

    const approvalId = await approve('pay-1', 50_000, ['inv-a']);
    const asked = { amountMinor: 50_000, method: 'cash', settles: ['inv-a'], approvalId };

    // Without the day and reference it cannot be recorded (the route needs them, as it always did) — and nothing is.
    expect((await record(h, 'pay-1', asked)).status).toBe(400);
    // A day still to come: refused by name, the approval is NOT used.
    const early = await record(h, 'pay-1', { ...asked, paidOn: tomorrow(), reference: 'CASH-1' });
    expect(early.status, JSON.stringify(early.body)).toBe(422);
    expect(codeOf(early)).toBe('paid_on_in_the_future');
    // Another amount, other bills, another method, another payment: each refused, nothing recorded, approval unused.
    expect(codeOf(await record(h, 'pay-1', { ...asked, amountMinor: 49_999, paidOn: TODAY, reference: 'CASH-1' }))).toBe('approval_does_not_match');
    expect(codeOf(await record(h, 'pay-1', { ...asked, settles: ['inv-b'], paidOn: TODAY, reference: 'CASH-1' }))).toBe('approval_does_not_match');
    expect(codeOf(await record(h, 'pay-1', { ...asked, method: 'upi', paidOn: TODAY, reference: 'CASH-1' }))).toBe('approval_does_not_match');
    expect(codeOf(await record(h, 'pay-2', { ...asked, paidOn: TODAY, reference: 'CASH-1' }))).toBe('approval_does_not_match');

    // Recorded with the day and reference typed after paying — exactly the approved terms.
    const ok = await record(h, 'pay-1', { ...asked, paidOn: TODAY, reference: 'CASH-1' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((ok.body as { payment: Record<string, unknown> }).payment).toMatchObject({ amountMinor: 50_000, paidOn: TODAY, reference: 'CASH-1', method: 'cash', settles: ['inv-a'], approvedBy: P3.PAY_APPROVER, recordedBy: P3.PAYER });

    // Used once: the same approval for another payment is refused; nothing more is recorded.
    expect(codeOf(await record(h, 'pay-3', { ...asked, paidOn: TODAY, reference: 'CASH-3' }))).toBe('approval_already_used');
    const approval3 = await approve('pay-3', 30_000, ['inv-b']);
    const second = await record(h, 'pay-3', { amountMinor: 30_000, method: 'cash', settles: ['inv-b'], approvalId: approval3, paidOn: TODAY, reference: 'CASH-3' });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(codeOf(await record(h, 'pay-4', { amountMinor: 30_000, method: 'cash', settles: ['inv-b'], approvalId: approval3, paidOn: TODAY, reference: 'CASH-4' }))).toBe('approval_already_used');

    // Never without approval.
    expect(codeOf(await record(h, 'pay-5', { amountMinor: 1, method: 'cash', paidOn: TODAY, reference: 'CASH-5' }))).toBe('payment_needs_approval');

    // A cold restart reads the same two payments, and nothing else.
    const after = harness(h);
    const account = await after.request({ method: 'GET', path: '/v1/purchase/suppliers/sup-1/account', userId: P3.PAYER, tenantId: T });
    const payments = ((account.body as { payments?: { paymentId: string; reference: string }[] }).payments ?? []).map((p) => `${p.paymentId}:${p.reference}`).sort();
    expect(payments).toEqual(['pay-1:CASH-1', 'pay-3:CASH-3']);
  });

  it('an approval asked the older way, with its day and UTR in it, still has to match them exactly', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    const TODAY = shopToday();
    const lines = [{ productId: 'rice', qty: 10, unitMinor: 5_000 }];
    await issuedOrder(call, 'po-a', lines);
    await received(call, 'grn-a', 'po-a', lines);
    await capturedAndMatched(call, 'inv-a', 'po-a', lines, undefined, 'sup-1', TODAY);
    const old = { amountMinor: 50_000, paidOn: TODAY, method: 'cash', reference: 'CASH-OLD' };
    const approvalId = await approvedRequestId(h, T, P3.PAYER, P3.PAY_APPROVER, { kind: 'supplier_payment', subjectRef: 'sup-1/pay-old', details: { ...old, supplierId: 'sup-1', paymentId: 'pay-old' }, valueMinor: 50_000 });
    const send = (body: Record<string, unknown>) => h.request({ method: 'POST', path: '/v1/purchase/suppliers/sup-1/payments/pay-old', userId: P3.PAYER, tenantId: T, idempotencyKey: `old-${randomUUID()}`, body });
    expect(codeOf(await send({ ...old, reference: 'CASH-OTHER', approvalId }))).toBe('approval_does_not_match');
    expect((await send({ ...old, approvalId })).status).toBe(201);
  });
});
