import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller } from '../support/p3-purchase';
import { approvedRequestId } from '../support/approval-request';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

// OB-807 A (owner, 16 Nov 2026, in writing) for SUPPLIER ADVANCES (batch 14, under OB-801): an advance follows the same order
// as a supplier payment. Approval is asked with the TERMS — supplier, amount, how, order — and the paid date and the bank
// reference (UTR) are added when it is RECORDED, once the money has gone. Recording must match the approval; a day still
// to come is refused (the approval stays unused); one approval records one advance. Nothing is loosened. In memory and —
// with DATABASE_URL — on real PostgreSQL.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const leg = (account: string, side: 'debit' | 'credit') => ({ account, side, component: 'amount' });
const MAP = { rules: [...DEFAULT_RETAIL_POSTING_MAP.rules, { kind: 'supplier_advance', legs: [leg('supplier_advances', 'debit'), leg('bank_clearing', 'credit')] }] };
const DAY = 86_400_000;

describe.each(backings)('OB-807 A — a supplier advance is asked with the amount and recorded with the day and UTR — on $name', ({ harness }) => {
  it('asked on its terms; recorded with the day and UTR; a future day, other figures and a reused approval are refused', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    expect((await h.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: P3.MATCHER, tenantId: T, idempotencyKey: 'map-1', body: MAP })).status).toBeLessThan(300);
    const today = shopDateIn(new Date().toISOString());
    const tomorrow = shopDateIn(new Date(Date.now() + DAY).toISOString());
    const terms = { supplierId: 'sup-1', amountMinor: 50_000, method: 'bank_transfer', poId: 'po-a' };
    // The asker asks with the terms only — no paid day, no reference (they do not exist yet).
    const approvalId = await approvedRequestId(h, T, P3.PAYER, P3.PAY_APPROVER, { kind: 'supplier_payment', subjectRef: 'advance:adv-7', details: { ...terms, advanceId: 'adv-7' }, valueMinor: 50_000 });
    const pay = (id: string, body: Record<string, unknown>) => call('POST', `/v1/finance/supplier-advances/${id}`, P3.PAYER, body, `adv-${randomUUID()}`);

    // A day still to come is refused — and the approval is not used up.
    const future = await pay('adv-7', { ...terms, paidOn: tomorrow, reference: 'UTR-77', approvalId });
    expect(future.status).toBe(422);
    expect(codeOf(future)).toBe('paid_on_in_the_future');
    // Other figures than approved are refused (nothing loosened): a different amount, a different method.
    expect((await pay('adv-7', { ...terms, amountMinor: 60_000, paidOn: today, reference: 'UTR-77', approvalId })).status).toBeGreaterThanOrEqual(400);
    expect((await pay('adv-7', { ...terms, method: 'cash', paidOn: today, reference: 'UTR-77', approvalId })).status).toBeGreaterThanOrEqual(400);
    // Recorded with the day it was paid and its UTR: one journal, with who approved it.
    const paid = await pay('adv-7', { ...terms, paidOn: today, reference: 'UTR-77', approvalId });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body).toMatchObject({ advance: { advanceId: 'adv-7', amountMinor: 50_000, on: today, reference: 'UTR-77', approvedBy: P3.PAY_APPROVER } });
    // The same approval cannot record a second advance.
    const again = await pay('adv-8', { ...terms, paidOn: today, reference: 'UTR-78', approvalId });
    expect(again.status).toBeGreaterThanOrEqual(400);
    const reg = (await call('GET', '/v1/finance/supplier-advances', P3.MATCHER)).body as { advances: { advanceId: string; paidMinor: number }[] };
    expect(reg.advances.map((a) => [a.advanceId, a.paidMinor])).toEqual([['adv-7', 50_000]]);
  });
});
