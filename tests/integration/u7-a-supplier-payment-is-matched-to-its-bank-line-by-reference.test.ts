import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness } from '../support/api-harness';
import { P3, p3Shop, caller, issuedOrder, received, capturedAndMatched } from '../support/p3-purchase';
import { sentWithApproval, approvedRequestId } from '../support/approval-request';

/**
 * **U7 · OB-723 (owner, in writing: B) · M23-FR-01 · M23-FR-03 · WF-18.** The accountant records a payment to a supplier —
 * amount, day, bank reference and the BILLS it settles — with a second person's approval (§28); payables outstanding falls.
 * On the bank reconciliation, the statement's debit line that names the payment's reference for exactly that amount is
 * MATCHED to the supplier payment (no exception to raise; one raised on it is refused); a line naming the same reference for
 * a different amount stays UNMATCHED with its value (never a silent match). A bill that is not the supplier's is refused by
 * name, and nothing is recorded.
 */
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const [y, m, d] = day.split('-');
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

describe('U7 · a supplier payment is matched to its bank line by reference (OB-723)', () => {
  it('pays two named bills; owed falls; the bank line naming the reference is matched to the payment; a mismatched amount stays unmatched', async () => {
    const h = apiHarness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    for (const [id, qty] of [['a', 10], ['b', 6]] as const) {
      const lines = [{ productId: 'rice', qty, unitMinor: 5_000 }];
      await issuedOrder(call, `po-${id}`, lines);
      await received(call, `grn-${id}`, `po-${id}`, lines);
      await capturedAndMatched(call, `inv-${id}`, `po-${id}`, lines, undefined, 'sup-1', day);
    }
    // The supplier's bank account, changed by letter, called back on the number already held, approved by a second person.
    const change = { newAccount: 'HDFC-0001-2345-6789', requestedVia: 'letter', calledBackOn: '+91-800-1', numberWeAlreadyHeld: '+91-800-1', requestedAt: '2026-09-30T08:00:00.000Z' };
    const approvalId = await approvedRequestId(h, T, P3.OWNER, P3.MATCHER, { kind: 'supplier_bank_change', subjectRef: 'sup-1', details: { ...change, supplierId: 'sup-1' } });
    const bank = await call('POST', '/v1/purchase/suppliers/sup-1/bank-details', P3.OWNER, { ...change, approvalId });
    expect(bank.status, JSON.stringify(bank.body)).toBeLessThan(300);
    const owedBefore = ((await call('GET', '/v1/purchase/suppliers/sup-1/account', P3.PAYER)).body as { totals: { owedMinor: number } }).totals.owedMinor;
    expect(owedBefore).toBe(80_000);

    const pay = (paymentId: string, body: Record<string, unknown>) => sentWithApproval(h, T, P3.PAYER, P3.PAY_APPROVER,
      { kind: 'supplier_payment', subjectRef: `sup-1/${paymentId}`, pathIds: { supplierId: 'sup-1', paymentId }, valueMinor: body['amountMinor'] as number }, body,
      (b) => h.request({ method: 'POST', path: `/v1/purchase/suppliers/sup-1/payments/${paymentId}`, userId: P3.PAYER, tenantId: T, idempotencyKey: `pay-${paymentId}-${randomUUID()}`, body: b }));

    // A bill that is not this supplier's is refused by name; nothing is recorded.
    const stranger = await pay('pay-x', { amountMinor: 30_000, paidOn: day, method: 'bank_transfer', reference: 'NEFT-X1', settles: ['inv-zz'] });
    expect(stranger.status, JSON.stringify(stranger.body)).toBe(422);
    expect(codeOf(stranger)).toBe('bill_not_this_suppliers');

    // ₹500 by bank transfer, settling inv-a, reference NEFT-77001.
    const paid = await pay('pay-1', { amountMinor: 50_000, paidOn: day, method: 'bank_transfer', reference: 'NEFT-77001', settles: ['inv-a'] });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body).toMatchObject({ payment: { settles: ['inv-a'], reference: 'NEFT-77001' }, owedMinor: 30_000 });
    expect(((await call('GET', '/v1/purchase/suppliers/sup-1/account', P3.PAYER)).body as { totals: { owedMinor: number } }).totals.owedMinor).toBe(30_000);

    // The bank statement: the ₹500 debit naming NEFT-77001 (the payment), and ₹300 naming NEFT-77001 again (a different
    // amount — not this payment) and a ₹100 debit naming nothing.
    const csv = ['Date,Reference,Narrative,Debit,Credit',
      `${d}/${m}/${y},NEFT-77001,SUP-1 PAYMENT,500.00,`,
      `${d}/${m}/${y},NEFT-77001 REV,SUP-1 PAYMENT,300.00,`,
      `${d}/${m}/${y},CHQ9,Rent,100.00,`].join('\n');
    const stmt = { statementId: 'BANK-U7', accountRef: 'current-1', fromDate: day, toDate: day, openingMinor: 1_000_000, closingMinor: 1_000_000 - 50_000 - 30_000 - 10_000, sourceName: 'u7.csv', csv };
    const imported = await call('POST', '/v1/finance/bank-statements', P3.MATCHER, stmt, 'stmt-u7');
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);

    const read = (await call('GET', '/v1/finance/bank-reconciliation', P3.MATCHER)).body as { lines: { lineId: string; amountMinor: number; match: { kind: string; paymentId?: string; supplierId?: string } }[]; totals: { matched: number; unmatched: number; unmatchedMinor: number } };
    expect(read.lines.map((l) => [l.amountMinor, l.match.kind, l.match.paymentId ?? null])).toEqual([
      [-50_000, 'supplier_payment', 'pay-1'],
      [-30_000, 'unmatched', null],
      [-10_000, 'unmatched', null],
    ]);
    expect(read.lines[0]!.match.supplierId).toBe('sup-1');
    expect(read.totals).toMatchObject({ matched: 1, unmatched: 2, unmatchedMinor: -40_000 });

    // A matched line needs no exception: raising one is refused by name.
    const raise = await call('POST', '/v1/finance/bank-reconciliation/exceptions/exc-u7', P3.MATCHER, { statementId: 'BANK-U7', lineId: read.lines[0]!.lineId, ownerUserId: P3.MATCHER, reason: 'check' }, 'exc-u7');
    expect(codeOf(raise)).toBe('line_already_matched');
  }, 120_000);
});
