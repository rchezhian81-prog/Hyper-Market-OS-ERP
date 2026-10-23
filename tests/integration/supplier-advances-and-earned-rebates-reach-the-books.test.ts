import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received, capturedAndMatched } from '../support/p3-purchase';
import { approvedBody, sentWithApproval } from '../support/approval-request';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';

// D10-FR-01 ("AP/AR and advances") and D10-FR-04 ("loyalty/gift/rebate liabilities") with WF-18's close (OB-288 P5):
//   • a SUPPLIER ADVANCE is a payment: refused without a second person's approval (a typed name is refused by name); paid,
//     it is one journal through the accountant's mapping; set against the same supplier's matched bill, never more than it
//     has left or than is owed; undone only by a compensating reversal; register and ledger agree in the close;
//   • an EARNED REBATE (the purchase register's accrual) posts once to the books; a mapping that would count the income
//     twice is refused; the receipt then clears the receivable; register and ledger agree in the close.
// Synthetic data. In memory and — with DATABASE_URL — on real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const TODAY = new Date().toISOString().slice(0, 10);
const PERIOD = TODAY.slice(0, 7);
const leg = (account: string, side: 'debit' | 'credit') => ({ account, side, component: 'amount' });
const MAP = {
  rules: [
    ...DEFAULT_RETAIL_POSTING_MAP.rules,
    { kind: 'supplier_advance', legs: [leg('supplier_advances', 'debit'), leg('bank_clearing', 'credit')] },
    { kind: 'supplier_advance_applied', legs: [leg('supplier_payable', 'debit'), leg('supplier_advances', 'credit')] },
    { kind: 'supplier_rebate', legs: [leg('bank_clearing', 'debit'), leg('rebate_receivable', 'credit')] },
    { kind: 'supplier_rebate_accrual', legs: [leg('rebate_receivable', 'debit'), leg('supplier_rebate_income', 'credit')] },
  ],
};
const DOUBLE = { rules: MAP.rules.map((r) => (r.kind === 'supplier_rebate' ? { ...r, legs: [leg('bank_clearing', 'debit'), leg('supplier_rebate_income', 'credit')] } : r)) };

interface Advances { advances: { advanceId: string; paidMinor: number; appliedMinor: number; leftMinor: number; approvedBy: string }[]; registerLeftMinor: number; ledgerMinor: number | null; agrees: boolean }
interface Evidence { checks: { name: string; leftMinor: number; rightMinor: number }[]; notChecked: string[] }

describe.each(backings)('supplier advances and earned rebates reach the books (D10-FR-01 · D10-FR-04 · WF-18) — on $name', ({ harness }) => {
  it('an advance is paid with a second person\'s approval, set against a bill, undone by a reversal; an accrual posts once; the close agrees; a restart reads the same', async () => {
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
    const advance = { supplierId: 'sup-1', amountMinor: 100_000, paidOn: TODAY, method: 'bank_transfer', reference: 'NEFT-ADV-1', poId: 'po-a' };
    const pay = (body: Record<string, unknown>, who: string = P3.PAYER) => call('POST', '/v1/finance/supplier-advances/adv-1', who, body, `adv-${randomUUID()}`);

    // ── D10-FR-01: refused without a second person; a typed name is refused by name; a cashier cannot.
    expect(codeOf(await pay(advance))).toBe('advance_needs_approval');
    expect(codeOf(await pay({ ...advance, approvedBy: P3.PAY_APPROVER }))).toBe('approver_named_without_approval');
    expect((await pay(advance, P3.CASHIER)).status).toBe(403);
    // With the approval but no mapping rule yet: refused, and the approval is NOT used up.
    const approved = await approvedBody(h, T, P3.PAYER, P3.PAY_APPROVER, 'supplier_payment', 'advance:adv-1', advance, { advanceId: 'adv-1' }, 100_000);
    expect(codeOf(await pay(approved))).toBe('supplier_advance_not_mapped');
    expect((await h.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: P3.MATCHER, tenantId: T, idempotencyKey: 'map-1', body: MAP })).status).toBeLessThan(300);
    const paid = await pay(approved);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body).toMatchObject({ advance: { approvedBy: P3.PAY_APPROVER, amountMinor: 100_000 }, entryId: 'supplier-advance:adv-1' });
    expect(((await pay(approved)).body as { alreadyRecorded: boolean }).alreadyRecorded).toBe(true);

    // ── Set against a bill: the same supplier's matched bill, never more than it has left.
    const apply = (appId: string, body: Record<string, unknown>) => call('POST', `/v1/finance/supplier-advances/adv-1/applications/${appId}`, P3.MATCHER, body, `app-${randomUUID()}`);
    expect(codeOf(await apply('app-x', { amountMinor: 100_001, invoiceId: 'inv-a', appliedOn: TODAY }))).toBe('more_than_the_advance_has_left');
    expect(codeOf(await apply('app-x', { amountMinor: 1_000, invoiceId: 'inv-nope', appliedOn: TODAY }))).toBe('not_this_suppliers_matched_bill');
    expect((await apply('app-1', { amountMinor: 30_000, invoiceId: 'inv-a', appliedOn: TODAY })).status).toBe(201);
    // A wrong application is undone by a compensating reversal — never deleted, never more than it set.
    expect(codeOf(await apply('rev-x', { reverses: 'app-1', amountMinor: 30_001, appliedOn: TODAY }))).toBe('reversal_exceeds_application');
    expect((await apply('rev-1', { reverses: 'app-1', amountMinor: 10_000, appliedOn: TODAY })).status).toBe(201);
    const adv = (await call('GET', '/v1/finance/supplier-advances', P3.MATCHER)).body as Advances;
    expect(adv.advances).toEqual([expect.objectContaining({ advanceId: 'adv-1', paidMinor: 100_000, appliedMinor: 20_000, leftMinor: 80_000, approvedBy: P3.PAY_APPROVER })]);
    expect(adv).toMatchObject({ registerLeftMinor: 80_000, ledgerMinor: 80_000, agrees: true });

    // ── D10-FR-04: the accrual the purchase register earned posts once; a mapping that counts the income twice is refused.
    const scheme = { supplierId: 'sup-1', basis: 'purchase_value', rateBp: 300, startsOn: `${TODAY.slice(0, 4)}-01-01`, endsOn: `${TODAY.slice(0, 4)}-12-31` };
    const sch = await sentWithApproval(h, T, P3.OWNER, P3.MATCHER, { kind: 'rebate_scheme', subjectRef: 'rb-1', pathIds: { schemeId: 'rb-1' } }, scheme,
      (body) => h.request({ method: 'POST', path: '/v1/purchase/rebate-schemes/rb-1', userId: P3.OWNER, tenantId: T, idempotencyKey: 'scheme-rb-1', body }));
    expect(sch.status, JSON.stringify(sch.body)).toBe(201);
    expect((await call('POST', '/v1/purchase/rebate-schemes/rb-1/accruals/q', P3.OWNER, { periodFrom: `${TODAY.slice(0, 4)}-01-01`, periodTo: TODAY })).status).toBe(201);
    expect((await h.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: P3.MATCHER, tenantId: T, idempotencyKey: 'map-2', body: DOUBLE })).status).toBeLessThan(300);
    expect(codeOf(await call('POST', '/v1/finance/rebate-accruals/post', P3.MATCHER, {}, 'acc-1'))).toBe('rebate_income_counted_twice');
    expect((await h.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: P3.MATCHER, tenantId: T, idempotencyKey: 'map-3', body: MAP })).status).toBeLessThan(300);
    expect((await call('POST', '/v1/finance/rebate-accruals/post', P3.CASHIER, {}, 'acc-c')).status).toBe(403);
    const posted = await call('POST', '/v1/finance/rebate-accruals/post', P3.MATCHER, {}, 'acc-2');
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    expect((posted.body as { posted: { rebateAccrual: { deltaMinor: number } }[] }).posted.map((j) => j.rebateAccrual.deltaMinor)).toEqual([2_400]); // 3% of ₹800
    expect((await call('POST', '/v1/finance/rebate-accruals/post', P3.MATCHER, {}, 'acc-3')).body).toMatchObject({ posted: [] });
    // The money arrives: the receipt clears the receivable.
    expect((await call('POST', '/v1/finance/rebate-receipts/rb-1/receipts/r1', P3.MATCHER, { amountMinor: 2_000, receivedOn: TODAY, reference: 'NEFT-RB-1' })).status).toBe(201);
    expect(((await call('GET', '/v1/finance/rebate-accruals', P3.MATCHER)).body as { agrees: boolean; lines: unknown[] })).toMatchObject({
      agrees: true, lines: [expect.objectContaining({ schemeId: 'rb-1', registerAccruedMinor: 2_400, ledgerAccruedMinor: 2_400, receivedMinor: 2_000, ledgerReceivableMinor: 400 })],
    });

    // ── WF-18: the close compares the advance register with the ledger, the accruals with the ledger, and payables net of advances.
    expect((await call('POST', '/v1/finance/payables/post', P3.MATCHER, {})).status).toBe(201);
    const e = (await call('GET', `/v1/finance/periods/${PERIOD}/independent-evidence`, P3.MATCHER)).body as Evidence;
    expect(e.checks.find((c) => c.name === `Supplier advances as at the close of ${PERIOD}`)).toMatchObject({ leftMinor: 80_000, rightMinor: 80_000 });
    expect(e.checks.find((c) => c.name === `Supplier rebates earned as at the close of ${PERIOD}`)).toMatchObject({ leftMinor: 2_400, rightMinor: 2_400 });
    const ap = e.checks.find((c) => c.name === `Supplier payables as at the close of ${PERIOD}`)!;
    expect(ap.leftMinor).toBe(ap.rightMinor);
    expect(ap.leftMinor).toBe(80_000 - 20_000); // ₹800 owed on the bills, ₹200 of it settled from the advance

    // A cold restart reads the same advance and the same accrual.
    const h2 = harness(h);
    expect(((await h2.request({ method: 'GET', path: '/v1/finance/supplier-advances', userId: P3.MATCHER, tenantId: T })).body as Advances)).toMatchObject({ registerLeftMinor: 80_000, agrees: true });
    expect((await h2.request({ method: 'GET', path: '/v1/finance/rebate-accruals', userId: P3.MATCHER, tenantId: T })).body).toMatchObject({ agrees: true, ledgerAccruedMinor: 2_400 });
  }, 120_000);
});
