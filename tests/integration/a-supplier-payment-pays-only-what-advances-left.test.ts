import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received, capturedAndMatched } from '../support/p3-purchase';
import { approvedBody, sentWithApproval } from '../support/approval-request';
import type { ApiHarness } from '../support/api-harness';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';

// OB-341 (owner, 24 Oct 2026, in writing): "payment route subtracts applied advances automatically; only the balance is
// paid" (D10-FR-01 "AP/AR and advances" · M23-FR-01 · WF-18 · §28):
//   • the supplier owes ₹800 on two matched bills; a ₹500 advance, paid with a second person's approval, is set against the
//     first bill; a payment of the whole ₹800 is REFUSED — it would pay that bill twice — and the words name the advance
//     and the ₹300 balance; ₹300 is paid; then not one paisa more;
//   • from the other side, a new advance cannot be set against a bill that is already paid;
//   • an advance application undone by its reversal makes exactly that much payable again;
//   • a cashier cannot pay (403); a cold restart reads the same balance.
// Synthetic data. In memory and — with DATABASE_URL — on real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const wordsOf = (res: { body: unknown }): string => (res.body as { error?: { whatHappened?: string } }).error?.whatHappened ?? '';
const TODAY = new Date().toISOString().slice(0, 10);
const leg = (account: string, side: 'debit' | 'credit') => ({ account, side, component: 'amount' });
const MAP = {
  rules: [
    ...DEFAULT_RETAIL_POSTING_MAP.rules,
    { kind: 'supplier_advance', legs: [leg('supplier_advances', 'debit'), leg('bank_clearing', 'credit')] },
    { kind: 'supplier_advance_applied', legs: [leg('supplier_payable', 'debit'), leg('supplier_advances', 'credit')] },
  ],
};

describe.each(backings)('a supplier payment pays only what advances have not covered (OB-341 · D10-FR-01) — on $name', ({ harness }) => {
  it('the advance comes off automatically; the full bill is refused, the balance is paid; never twice; a reversal opens exactly its amount; a restart reads the same', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    for (const [id, qty] of [['a', 10], ['b', 6]] as const) {
      const lines = [{ productId: 'rice', qty, unitMinor: 5_000 }];
      await issuedOrder(call, `po-${id}`, lines);
      await received(call, `grn-${id}`, `po-${id}`, lines);
      await capturedAndMatched(call, `inv-${id}`, `po-${id}`, lines, undefined, 'sup-1', TODAY);
    }
    expect((await h.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: P3.MATCHER, tenantId: T, idempotencyKey: 'map-1', body: MAP })).status).toBeLessThan(300);

    // A ₹500 advance, paid with a second person's approval, set in full against the first bill (₹500).
    const advance = (advanceId: string, amountMinor: number) => async () => {
      const body = { supplierId: 'sup-1', amountMinor, paidOn: TODAY, method: 'bank_transfer', reference: `NEFT-${advanceId}`, poId: 'po-a' };
      const approved = await approvedBody(h, T, P3.PAYER, P3.PAY_APPROVER, 'supplier_payment', `advance:${advanceId}`, body, { advanceId }, amountMinor);
      return call('POST', `/v1/finance/supplier-advances/${advanceId}`, P3.PAYER, approved, `adv-${advanceId}`);
    };
    expect((await advance('adv-1', 50_000)()).status).toBe(201);
    const apply = (advanceId: string, appId: string, body: Record<string, unknown>) => call('POST', `/v1/finance/supplier-advances/${advanceId}/applications/${appId}`, P3.MATCHER, body, `app-${appId}`);
    expect((await apply('adv-1', 'app-1', { amountMinor: 50_000, invoiceId: 'inv-a', appliedOn: TODAY })).status).toBe(201);

    const pay = (hh: ApiHarness, paymentId: string, amountMinor: number, by: string = P3.PAYER) => {
      const body = { amountMinor, paidOn: TODAY, method: 'cash', reference: `CASH-${paymentId}` };
      return sentWithApproval(hh, T, by, P3.PAY_APPROVER, { kind: 'supplier_payment', subjectRef: `sup-1/${paymentId}`, pathIds: { supplierId: 'sup-1', paymentId }, valueMinor: amountMinor }, body,
        (b) => hh.request({ method: 'POST', path: `/v1/purchase/suppliers/sup-1/payments/${paymentId}`, userId: by, tenantId: T, idempotencyKey: `pay-${paymentId}`, body: b }));
    };

    // ── The whole ₹800 is refused: ₹500 of it is already paid by the advance — it would pay the first bill twice.
    const whole = await pay(h, 'pay-whole', 80_000);
    expect(whole.status, JSON.stringify(whole.body)).toBe(422);
    expect(codeOf(whole)).toBe('payment_exceeds_balance');
    expect(wordsOf(whole)).toMatch(/owed 80000 on the purchase register, of which advances already paid 50000; the balance to pay is 30000/);
    // ── Only the balance is paid.
    const balance = await pay(h, 'pay-1', 30_000);
    expect(balance.status, JSON.stringify(balance.body)).toBe(201);
    expect(balance.body).toMatchObject({ owedMinor: 50_000, advancesAppliedMinor: 50_000, balanceToPayMinor: 0 });
    // ── And not one paisa more.
    expect(codeOf(await pay(h, 'pay-more', 1))).toBe('payment_exceeds_balance');
    // From the other side: a new advance cannot be set against a bill that is already paid.
    expect((await advance('adv-2', 10_000)()).status).toBe(201);
    expect(codeOf(await apply('adv-2', 'app-2', { amountMinor: 10_000, invoiceId: 'inv-b', appliedOn: TODAY }))).toBe('more_than_is_owed');
    // A cashier cannot pay a supplier at all.
    expect((await h.request({ method: 'POST', path: '/v1/purchase/suppliers/sup-1/payments/pay-cash', userId: P3.CASHIER, tenantId: T, idempotencyKey: 'pay-cash', body: { amountMinor: 1, paidOn: TODAY, method: 'cash', reference: 'x' } })).status).toBe(403);

    // ── An application undone by its reversal makes exactly its amount payable again — not a paisa more.
    expect((await apply('adv-1', 'rev-1', { reverses: 'app-1', amountMinor: 20_000, appliedOn: TODAY })).status).toBe(201);
    expect(codeOf(await pay(h, 'pay-over', 20_001))).toBe('payment_exceeds_balance');

    // A cold restart reads the same balance: ₹200 payable, then nothing.
    const h2 = harness(h);
    const after = await pay(h2, 'pay-2', 20_000);
    expect(after.status, JSON.stringify(after.body)).toBe(201);
    expect(after.body).toMatchObject({ advancesAppliedMinor: 30_000, balanceToPayMinor: 0 });
    expect(codeOf(await pay(h2, 'pay-again', 1))).toBe('payment_exceeds_balance');
  }, 120_000);
});
