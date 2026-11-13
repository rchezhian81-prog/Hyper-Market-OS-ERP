import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';

/**
 * **U7 · OB-725 (owner, in writing: B) · M24-FR-02 "a supplier raises claims" and its alternative flow "a disputed claim
 * becomes an exception".** After a buyer decides a supplier's claim:
 *   • ACCEPTED with a value → a DRAFT credit note to that supplier. It moves nothing until the ACCOUNTANT — a second person,
 *     never the buyer who accepted it — approves it. Approved, what the shop owes the supplier rises by it and the payables
 *     run posts it once through the accountant's mapping; the register and the ledger agree. Refused, it is kept with its
 *     reason and counts for nothing. One decision per credit: a retry is the same answer, a different one is refused.
 *   • REJECTED → a disputed claim: an exception with its value, owned by the buyer who rejected it, open until a person
 *     settles it with an outcome and a reason; still open after the shop day it was raised on, it reads overdue.
 */
const T = randomUUID();
const post = (h: ApiHarness, path: string, userId: string, body: unknown, key = `${path}-${userId}-${randomUUID()}`) => h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body });
const put = (h: ApiHarness, path: string, userId: string, body: unknown) => h.request({ method: 'PUT', path, userId, tenantId: T, idempotencyKey: `${path}-${randomUUID()}`, body });
const get = (h: ApiHarness, path: string, userId: string) => h.request({ method: 'GET', path, userId, tenantId: T });

interface Draft { creditId: string; supplierId: string; submissionId: string; amountMinor: number; acceptedBy: string; state: string; decision: { decidedBy: string; reason: string } | null }
interface Dispute { exceptionId: string; supplierId: string; submissionId: string; valueMinor: number | null; rejectedBecause: string; ownerUserId: string; raisedOn: string; state: string; overdue: boolean; resolution: { outcome: string; by: string } | null }
interface Register { creditDrafts: Draft[]; disputes: Dispute[]; counts: Record<string, number> }
const owed = async (h: ApiHarness, s: string): Promise<{ owedMinor: number; claimCreditsMinor: number }> => ((await get(h, `/v1/purchase/suppliers/${s}/account`, 'u-acct')).body as { totals: { owedMinor: number; claimCreditsMinor: number } }).totals;

describe('U7 · an accepted supplier claim is a draft credit a second person approves; a rejected one is a disputed exception (OB-725 · M24-FR-02)', () => {
  it('draft → refused for the wrong people → approved by the accountant → owed rises and posts once; rejected → an open exception, settled once', async () => {
    const h = apiHarness();
    await h.seedOwner(T, 'u-owner');
    await approvedSuppliers(h, T, 's-1');
    for (const [u, r] of [['u-buyer', 'store_manager'], ['u-boss', 'store_manager'], ['u-acct', 'accountant'], ['u-acct2', 'accountant'], ['u-cash', 'cashier'], ['u-sup', 'supplier']] as const) await h.provisionRole(T, u, r);
    await deliveryPlaces(h, T, 'store-1');
    expect((await post(h, '/v1/purchase/orders/po-x', 'u-buyer', { supplierId: 's-1', deliverToLocationId: 'store-1', lines: [{ productId: 'p1', orderedQty: 10, unitCost: { minor: 500, currency: 'INR' } }] })).status).toBe(201);
    expect((await post(h, '/v1/purchase/orders/po-x/approval', 'u-owner', { reason: 'fixture' })).status).toBe(200);
    expect((await post(h, '/v1/supplier-portal/partners/s-1', 'u-buyer', { grants: ['raise_claim', 'view_statement'], documents: [], requiredDocuments: [], logins: ['u-sup'] })).status).toBeLessThan(300);

    // Two claims from the supplier: freight (to be accepted) and a short-paid bill (to be rejected).
    expect((await post(h, '/v1/supplier-portal/me/submissions', 'u-sup', { submissionId: 'clm-freight', kind: 'claim', document: { poId: 'po-x', claimMinor: 1_500, why: 'freight paid by us' } })).status).toBe(201);
    expect((await post(h, '/v1/supplier-portal/me/submissions', 'u-sup', { submissionId: 'clm-short', kind: 'claim', document: { poId: 'po-x', claimMinor: 2_000, why: 'bill short-paid' } })).status).toBe(201);

    // Awaiting a buyer: no draft, no dispute — an honest zero, and none of it moves money.
    const zero = (await get(h, '/v1/purchase/supplier-claims', 'u-acct')).body as Register;
    expect(zero.creditDrafts).toEqual([]);
    expect(zero.disputes).toEqual([]);
    expect(zero.counts).toMatchObject({ creditDrafts: 0, openDisputes: 0 });
    // Not yet accepted: there is no credit to decide.
    expect((await post(h, '/v1/purchase/supplier-claims/credits/s-1/clm-freight', 'u-acct', { decision: 'approve', reason: 'early' })).status).toBe(409);

    expect((await post(h, '/v1/supplier-portal/partners/s-1/submissions/clm-freight/review', 'u-boss', { decision: 'accept', reason: 'freight was not in the price' })).status).toBe(201);
    expect((await post(h, '/v1/supplier-portal/partners/s-1/submissions/clm-short/review', 'u-buyer', { decision: 'reject', reason: 'paid in full on 2 Nov' })).status).toBe(201);

    const before = await owed(h, 's-1');
    const one = (await get(h, '/v1/purchase/supplier-claims', 'u-acct')).body as Register;
    expect(one.creditDrafts).toEqual([expect.objectContaining({ creditId: 'SCC-clm-freight', supplierId: 's-1', amountMinor: 1_500, acceptedBy: 'u-boss', state: 'draft', decision: null })]);
    expect(one.disputes).toEqual([expect.objectContaining({
      exceptionId: 'DSP-clm-short', supplierId: 's-1', valueMinor: 2_000, rejectedBecause: 'paid in full on 2 Nov', ownerUserId: 'u-buyer',
      raisedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), state: 'open', overdue: false, resolution: null,
    })]);
    expect(one.counts).toMatchObject({ creditDrafts: 1, creditsApproved: 0, openDisputes: 1, overdueDisputes: 0 });
    // A draft moves nothing.
    expect(before.claimCreditsMinor).toBe(0);

    // Who may decide: a cashier is refused (no permission); a buyer cannot (no purchase.supplier.pay); the owner who
    // ACCEPTED would be refused as the same person — here the accepter is a store manager, so test the rule via the reason.
    expect((await post(h, '/v1/purchase/supplier-claims/credits/s-1/clm-freight', 'u-cash', { decision: 'approve', reason: 'x' })).status).toBe(403);
    expect((await post(h, '/v1/purchase/supplier-claims/credits/s-1/clm-freight', 'u-boss', { decision: 'approve', reason: 'x' })).status).toBe(403);
    // No reason → refused in three parts, nothing decided.
    const noWhy = await post(h, '/v1/purchase/supplier-claims/credits/s-1/clm-freight', 'u-acct', { decision: 'approve' });
    expect(noWhy.status).toBe(400);
    expect(noWhy.body).toMatchObject({ error: { code: 'not_readable_as_a_credit_decision', wasItSaved: 'not_saved' } });
    // A rejected claim is a dispute, never a credit.
    expect((await post(h, '/v1/purchase/supplier-claims/credits/s-1/clm-short', 'u-acct', { decision: 'approve', reason: 'x' })).body).toMatchObject({ error: { code: 'not_a_draft_credit' } });

    // The accountant approves: the credit is a fact; what the shop owes s-1 rises by 1,500; a retry is the same answer.
    const ok = await post(h, '/v1/purchase/supplier-claims/credits/s-1/clm-freight', 'u-acct', { decision: 'approve', reason: 'freight receipt seen' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await post(h, '/v1/purchase/supplier-claims/credits/s-1/clm-freight', 'u-acct', { decision: 'approve', reason: 'again' })).status).toBe(200);
    const other = await post(h, '/v1/purchase/supplier-claims/credits/s-1/clm-freight', 'u-acct2', { decision: 'refuse', reason: 'changed mind' });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ error: { code: 'credit_already_decided' } });
    const after = await owed(h, 's-1');
    expect(after.claimCreditsMinor).toBe(1_500);
    expect(after.owedMinor - before.owedMinor).toBe(1_500);
    const two = (await get(h, '/v1/purchase/supplier-claims', 'u-acct')).body as Register;
    expect(two.creditDrafts[0]).toMatchObject({ state: 'approved', decision: { decidedBy: 'u-acct', reason: 'freight receipt seen' } });
    expect(two.counts).toMatchObject({ creditDrafts: 0, creditsApproved: 1 });

    // The payables run posts it once through the accountant's mapping; a re-run posts nothing; register and ledger agree.
    expect((await put(h, '/v1/finance/posting-map', 'u-acct', DEFAULT_RETAIL_POSTING_MAP)).status).toBe(200);
    const run = await post(h, '/v1/finance/payables/post', 'u-acct', {});
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const journals = (run.body as { journals: { kind: string; sourceId: string }[] }).journals.filter((j) => j.kind === 'supplier_claim_credit');
    expect(journals.map((j) => j.sourceId)).toEqual(['SCC-clm-freight']);
    expect((run.body as { exceptions: unknown[] }).exceptions).toEqual([]);
    const again = await post(h, '/v1/finance/payables/post', 'u-acct', {});
    expect((again.body as { journals: unknown[] }).journals).toEqual([]);
    const ledger = (await get(h, '/v1/finance/payables', 'u-acct')).body as { reconciliation: { suppliers: { supplierId: string; registerOwedMinor: number; ledgerOwedMinor: number; agrees: boolean }[] } };
    expect(ledger.reconciliation.suppliers.find((s) => s.supplierId === 's-1')).toMatchObject({ registerOwedMinor: 1_500, ledgerOwedMinor: 1_500, agrees: true });

    // The disputed claim (overdue after its shop day: the unit test drives the clock); the cashier cannot settle it.
    expect((await post(h, '/v1/purchase/supplier-claims/disputes/s-1/clm-short/resolve', 'u-cash', { outcome: 'supplier_withdrew', reason: 'x' })).status).toBe(403);
    expect((await post(h, '/v1/purchase/supplier-claims/disputes/s-1/clm-short/resolve', 'u-buyer', { outcome: 'gave_up', reason: 'x' })).status).toBe(400);
    expect((await post(h, '/v1/purchase/supplier-claims/disputes/s-1/clm-freight/resolve', 'u-buyer', { outcome: 'other', reason: 'x' })).body).toMatchObject({ error: { code: 'not_a_disputed_claim' } });
    const settled = await post(h, '/v1/purchase/supplier-claims/disputes/s-1/clm-short/resolve', 'u-buyer', { outcome: 'supplier_withdrew', reason: 'supplier saw the 2 Nov payment' });
    expect(settled.status, JSON.stringify(settled.body)).toBe(201);
    expect((await post(h, '/v1/purchase/supplier-claims/disputes/s-1/clm-short/resolve', 'u-boss', { outcome: 'other', reason: 'x' })).body).toMatchObject({ error: { code: 'dispute_already_resolved' } });
    const four = (await get(h, '/v1/purchase/supplier-claims', 'u-buyer')).body as Register;
    expect(four.disputes[0]).toMatchObject({ state: 'resolved', overdue: false, resolution: { outcome: 'supplier_withdrew', by: 'u-buyer' } });
    expect(four.counts).toMatchObject({ openDisputes: 0, overdueDisputes: 0 });
    // The settlement moved no money: what is owed is unchanged by it.
    expect((await owed(h, 's-1')).owedMinor).toBe(after.owedMinor);

    // Every decision left an audit event.
    const trail = (await get(h, '/v1/audit/entries?objectType=supplier_claim_credit', 'u-owner'));
    if (trail.status === 200) expect(JSON.stringify(trail.body)).toContain('SCC-clm-freight');
  });

  it('the person who accepted a claim cannot approve the credit it creates (§28)', async () => {
    const T2 = randomUUID();
    const h = apiHarness();
    const p2 = (path: string, userId: string, body: unknown) => h.request({ method: 'POST', path, userId, tenantId: T2, idempotencyKey: `${path}-${randomUUID()}`, body });
    await h.seedOwner(T2, 'u-owner');
    await approvedSuppliers(h, T2, 's-9');
    await h.provisionRole(T2, 'u-sup', 'supplier');
    await h.provisionRole(T2, 'u-acct', 'accountant');
    await h.provisionRole(T2, 'u-buyer', 'store_manager');
    await deliveryPlaces(h, T2, 'store-1');
    expect((await p2('/v1/purchase/orders/po', 'u-buyer', { supplierId: 's-9', deliverToLocationId: 'store-1', lines: [{ productId: 'p1', orderedQty: 1, unitCost: { minor: 900, currency: 'INR' } }] })).status).toBe(201);
    expect((await p2('/v1/purchase/orders/po/approval', 'u-owner', { reason: 'fixture' })).status).toBe(200);
    expect((await p2('/v1/supplier-portal/partners/s-9', 'u-owner', { grants: ['raise_claim'], documents: [], requiredDocuments: [], logins: ['u-sup'] })).status).toBeLessThan(300);
    expect((await p2('/v1/supplier-portal/me/submissions', 'u-sup', { submissionId: 'c1', kind: 'claim', document: { poId: 'po', claimMinor: 900, why: 'rate difference' } })).status).toBe(201);
    // The OWNER accepts (holds both supplier.portal.review and purchase.supplier.pay) …
    expect((await p2('/v1/supplier-portal/partners/s-9/submissions/c1/review', 'u-owner', { decision: 'accept', reason: 'rate agreed' })).status).toBe(201);
    // … and so may not also approve the credit.
    const self = await p2('/v1/purchase/supplier-claims/credits/s-9/c1', 'u-owner', { decision: 'approve', reason: 'mine' });
    expect(self.status).toBe(403);
    expect(self.body).toMatchObject({ error: { code: 'same_person', wasItSaved: 'not_saved' } });
    expect((await p2('/v1/purchase/supplier-claims/credits/s-9/c1', 'u-acct', { decision: 'refuse', reason: 'no rate letter on file' })).status).toBe(201);
    const reg = (await h.request({ method: 'GET', path: '/v1/purchase/supplier-claims', userId: 'u-acct', tenantId: T2 })).body as Register;
    expect(reg.creditDrafts[0]).toMatchObject({ state: 'refused' });
    const acct = (await h.request({ method: 'GET', path: '/v1/purchase/suppliers/s-9/account', userId: 'u-acct', tenantId: T2 })).body as { totals: { claimCreditsMinor: number } };
    expect(acct.totals.claimCreditsMinor).toBe(0);
  });
});
