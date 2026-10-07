import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedRequestId, askForApproval, decide } from '../support/approval-request';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import type { StoredMatch } from '../../services/purchase/src/index';
import type { SupplierAccountStatement } from '../../services/purchase/src/supplier-account';
import type { SupplierRecord, SupplierListRow } from '../../services/purchase/src/supplier-master';

/**
 * **The supplier has one record and one balance, and gets paid safely (SP-7c · M06-FR-01 · M23-FR-01 · M23-FR-02 ·
 * M15-FR-03 · M07-FR-04 · §28 · P-02 · P-03 · hard rules #2 #4 #5, API-03).**
 *
 * Until SP-7c a supplier was an id other records happened to name. Now, through the real API and real per-tenant RBAC:
 *
 *   • a purchase user PROPOSES a supplier; a DIFFERENT person with the authority makes them active; the proposer cannot
 *     approve their own supplier and can never approve its bank details; a look-alike is SAID as a possible duplicate;
 *   • the list every screen reads puts the suppliers needing a person first and says WHY;
 *   • a PAYMENT is a fact a second person approved, recorded once — and REFUSED, nothing recorded, for a blocked supplier,
 *     for a bank payment with no independently verified account, for an account another holder shares, for the approver
 *     being the payer or lacking the authority, and for more than the balance owed; it nets the account and posts through
 *     the accountant's mapping;
 *   • a SECOND bill against the same order pays nothing for goods the first already claimed, and the pair is said to
 *     over-claim the order;
 *   • a debit note the account raised is ISSUED under a number from the tenant's own series, once;
 *   • the supplier's own portal statement reads the same account (one truth).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const post = (h: ApiHarness, path: string, userId: string, body: unknown, key: string, tenantId = A) => h.request({ method: 'POST', path, userId, tenantId, idempotencyKey: key, body });
const put = (h: ApiHarness, path: string, userId: string, body: unknown, key: string) => h.request({ method: 'PUT', path, userId, tenantId: A, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string, userId: string, tenantId = A) => h.request({ method: 'GET', path, userId, tenantId });
const line = (productId: string, quantity: number, unitPriceMinor: number) => ({ productId, quantity, unitPriceMinor, lineTotalMinor: quantity * unitPriceMinor });
const PAPER = { supplierId: 's-1', poId: 'po-1', declaredTotalMinor: 9000, lines: [line('p1', 10, 500), line('p2', 4, 1000)], approvedBy: 'u-checker' };
const rl = (lineId: string, productId: string, ordered: number, counted: number, unit: number, extra: Record<string, unknown> = {}) =>
  ({ lineId, productId, orderedMinor: ordered, countedMinor: counted, uom: 'ea', unitCost: { minor: unit, currency: 'INR' }, condition: 'good', ...extra });
const propose = (h: ApiHarness, supplierId: string, body: Record<string, unknown>, userId = 'u-buyer', key = `sup-${supplierId}`) => post(h, `/v1/purchase/suppliers/${supplierId}`, userId, body, key);
const approve = (h: ApiHarness, supplierId: string, userId: string, key = `sup-approve-${supplierId}-${userId}`) => post(h, `/v1/purchase/suppliers/${supplierId}/approval`, userId, { reason: 'documents checked' }, key);
// The owner asks for the change; `approvedBy` approves it in their own session (ADR-0024), and the change names that approval.
async function bank(h: ApiHarness, supplierId: string, account: string, approvedBy: string, key: string) {
  const change = { newAccount: account, requestedVia: 'letter', calledBackOn: '+91-800-1', numberWeAlreadyHeld: '+91-800-1', requestedAt: '2026-09-30T08:00:00.000Z' };
  const approvalId = await approvedRequestId(h, A, 'u-owner', approvedBy, { kind: 'supplier_bank_change', subjectRef: supplierId, details: { ...change, supplierId } });
  return post(h, `/v1/purchase/suppliers/${supplierId}/bank-details`, 'u-owner', { ...change, approvalId }, key);
}
const pay = (h: ApiHarness, supplierId: string, paymentId: string, body: Record<string, unknown>, userId = 'u-acct', key = `pay-${paymentId}`) =>
  post(h, `/v1/purchase/suppliers/${supplierId}/payments/${paymentId}`, userId, { amountMinor: 1000, paidOn: '2026-10-02', method: 'bank_transfer', reference: 'UTR-1', approvedBy: 'u-owner', ...body }, key);
const list = async (h: ApiHarness, userId = 'u-buyer', tenantId = A) => {
  const res = await get(h, '/v1/purchase/suppliers', userId, tenantId);
  return { status: res.status, body: res.body as { suppliers: SupplierListRow[]; count: number; needingAttentionCount: number; owedMinor: number } };
};
const one = async (h: ApiHarness, supplierId: string, userId = 'u-buyer') => {
  const res = await get(h, `/v1/purchase/suppliers/${supplierId}`, userId);
  return { status: res.status, body: res.body as { supplier: SupplierRecord | null; blocked: boolean; bank: { accountRef: string; verifiedBy: string } | null; duplicateBankAccount: boolean; account: SupplierAccountStatement; attention: string[] } };
};

/** The cast; an issued order (p1 10 @ ₹5, p2 4 @ ₹10); one delivery (2 of the p2 damaged); the bill matched clean at ₹90; the damaged 2 returned → DN ₹20 → owed ₹70. */
async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-buyer', 'store_manager');   // proposes suppliers, captures invoices
  await h.provisionRole(A, 'u-checker', 'store_manager'); // the second person on the invoice
  await h.provisionRole(A, 'u-recv', 'store_manager');    // receives
  await h.provisionRole(A, 'u-boss', 'store_manager');    // disposes
  await h.provisionRole(A, 'u-acct', 'accountant');       // approves suppliers, records payments, posts payables
  await h.provisionRole(A, 'u-cash', 'cashier');
  await h.seedOwner(B, 'u-owner-b');
  expect((await post(h, '/v1/inventory/receipt-policy', 'u-owner', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }, 'pol')).status).toBe(201);
  expect((await post(h, '/v1/purchase/orders/po-1', 'u-buyer', { supplierId: 's-1', lines: [{ productId: 'p1', orderedQty: 10, unitCost: { minor: 500, currency: 'INR' } }, { productId: 'p2', orderedQty: 4, unitCost: { minor: 1000, currency: 'INR' } }] }, 'po-1')).status).toBe(201);
  expect((await post(h, '/v1/purchase/orders/po-1/approval', 'u-owner', { reason: 'fixture' }, 'po-1-approve')).status).toBe(200);
  expect((await post(h, '/v1/inventory/goods-receipt/grn-1', 'u-recv', { warehouseId: 'store-1', receivedOnDate: '2026-09-30', currency: 'INR', poId: 'po-1', lines: [rl('L1', 'p1', 10, 10, 500), rl('L2', 'p2', 2, 2, 1000), rl('L3', 'p2', 2, 2, 1000, { condition: 'damaged' })] }, 'grn-1')).status).toBe(201);
  expect((await post(h, '/v1/purchase/invoices/inv-1/capture', 'u-buyer', PAPER, 'cap-inv-1')).status).toBe(201);
  expect(((await post(h, '/v1/purchase/invoices/inv-1/match', 'u-checker', {}, 'mat-inv-1')).body as StoredMatch).payableMinor).toBe(9000);
  expect((await post(h, '/v1/inventory/goods-receipt/grn-1/lines/L3/disposition', 'u-boss', { disposition: 'return', reason: 'dented' }, 'd-L3')).status).toBe(200);
  return h;
}

describe('the supplier master — one record, one balance, paid safely (SP-7c)', () => {
  it('a purchase user PROPOSES a supplier, a DIFFERENT person approves it, a look-alike is said as a possible duplicate, the list says who needs a person and why; nothing for a cashier or another tenant', async () => {
    const h = await seeded();
    // Before any master record the supplier the order names is on the list, said to have none.
    let rows = (await list(h)).body;
    expect(rows.suppliers).toEqual([expect.objectContaining({ supplierId: 's-1', name: null, status: 'no_master_record', needsAttention: true, attention: ['no_master_record', 'no_verified_bank_account'] })]);
    expect(rows.owedMinor).toBe(7000);

    const created = await propose(h, 's-1', { name: 'Amma Traders', gstin: '33aaaaa0000a1z5', phone: '+91-98400-00000', paymentTermsDays: 30, documents: [{ documentId: 'd1', kind: 'gst_registration', reference: '33AAAAA0000A1Z5', validFrom: '2026-01-01', validUntil: '2027-12-31' }] });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ created: true, supplier: { supplierId: 's-1', name: 'Amma Traders', gstin: '33AAAAA0000A1Z5', status: 'proposed', createdBy: 'u-buyer', approvedBy: null, possibleDuplicates: [], version: 1, documents: [{ documentId: 'd1', kind: 'gst_registration' }] } });
    expect(codeOf(await propose(h, 's-bad', { gstin: 'x' }))).toBe('not_readable_as_a_supplier');
    expect(codeOf(await propose(h, 's-bad', { name: 'X', documents: [{ documentId: 'd', kind: 'passport', reference: 'r', validFrom: '2026-01-01', validUntil: '2027-01-01' }] }))).toBe('not_readable_as_a_supplier');
    // A second supplier with the same name (any case) is SAID to be a possible duplicate — not refused, not silently taken.
    const twin = await propose(h, 's-2', { name: 'amma traders', gstin: '29BBBBB0000B1Z9' });
    expect(twin.status).toBe(201);
    expect((twin.body as { supplier: SupplierRecord }).supplier.possibleDuplicates).toEqual(['s-1']);
    rows = (await list(h)).body;
    expect(rows.suppliers.find((r) => r.supplierId === 's-1')).toMatchObject({ name: 'Amma Traders', status: 'proposed', attention: ['awaiting_approval', 'no_verified_bank_account'] });
    expect(rows.suppliers.find((r) => r.supplierId === 's-2')).toMatchObject({ status: 'proposed', attention: ['awaiting_approval', 'possible_duplicate'] });
    expect(rows).toMatchObject({ count: 2, needingAttentionCount: 2 });

    // A store manager holds no approval right at all; the accountant (finance) approves; again is a no-op. And even someone
    // who holds BOTH rights (the owner) cannot approve a supplier they themselves proposed (§28).
    expect((await approve(h, 's-1', 'u-buyer')).status).toBe(403);
    expect((await approve(h, 's-1', 'u-checker')).status).toBe(403);
    expect((await propose(h, 's-3', { name: 'Gamma Dairy' }, 'u-owner')).status).toBe(201);
    expect(codeOf(await approve(h, 's-3', 'u-owner'))).toBe('self_approval');
    expect((await one(h, 's-3')).body.supplier).toMatchObject({ status: 'proposed', approvedBy: null });
    expect((await approve(h, 's-3', 'u-acct')).body).toMatchObject({ alreadyApproved: false, supplier: { status: 'active', approvedBy: 'u-acct' } });
    const approved = await approve(h, 's-1', 'u-acct');
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ alreadyApproved: false, supplier: { status: 'active', approvedBy: 'u-acct', version: 2 } });
    expect((await approve(h, 's-1', 'u-acct', 'sup-approve-again')).body).toMatchObject({ alreadyApproved: true });
    expect(codeOf(await approve(h, 's-nobody', 'u-acct'))).toBe('not_found');
    // An update by another purchase user is a new version; who created it never changes; the status holds.
    const updated = await propose(h, 's-1', { name: 'Amma Traders Pvt Ltd', gstin: '33AAAAA0000A1Z5' }, 'u-checker', 'sup-s-1-v3');
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ created: false, supplier: { name: 'Amma Traders Pvt Ltd', status: 'active', createdBy: 'u-buyer', updatedBy: 'u-checker', approvedBy: 'u-acct', version: 3 } });

    const s1 = await one(h, 's-1');
    expect(s1.status).toBe(200);
    expect(s1.body).toMatchObject({ supplier: { version: 3 }, blocked: false, bank: null, duplicateBankAccount: false, attention: ['no_verified_bank_account'] });
    expect(s1.body.account.totals).toMatchObject({ accruedMinor: 9000, debitNotesMinor: 2000, paidMinor: 0, owedMinor: 7000 });
    expect((await one(h, 's-nobody')).status).toBe(404);
    expect((await list(h, 'u-cash')).status).toBe(403);
    expect((await one(h, 's-1', 'u-cash')).status).toBe(403);
    expect((await propose(h, 's-9', { name: 'X' }, 'u-cash')).status).toBe(403);
    expect((await list(h, 'u-owner-b', B)).body).toMatchObject({ count: 0, suppliers: [] });
  });

  it('the creator of a supplier can never approve its bank details (M06-FR-01 · §28); a verified account appears on the record; two suppliers sharing an account are both flagged', async () => {
    const h = await seeded();
    expect((await propose(h, 's-1', { name: 'Amma Traders' })).status).toBe(201);
    expect((await propose(h, 's-2', { name: 'Beta Foods' })).status).toBe(201);
    // The store manager who created the supplier cannot approve where its money goes — they hold no bank-approval
    // authority at all, so the engine refuses them (ADR-0024).
    const change = { newAccount: 'tok-acct-1', requestedVia: 'letter', calledBackOn: '+91-800-1', numberWeAlreadyHeld: '+91-800-1', requestedAt: '2026-09-30T08:00:00.000Z' };
    const asked = await askForApproval(h, A, 'u-owner', { kind: 'supplier_bank_change', subjectRef: 's-1', details: { ...change, supplierId: 's-1' } });
    expect((await decide(h, A, 'u-buyer', (asked.body as { requestId: string }).requestId)).status).toBe(403);
    // A creator who DOES hold it — a second owner who set the supplier up — is refused at the change itself (M06-FR-01 · §28).
    await h.provisionOwner(A, 'u-owner-2');
    expect((await propose(h, 's-3', { name: 'Gamma Oils' }, 'u-owner-2')).status).toBe(201);
    const byCreator = await bank(h, 's-3', 'tok-acct-3', 'u-owner-2', 'bank-1');
    expect(byCreator.status).toBe(422);
    expect(codeOf(byCreator)).toBe('supplier_creator_cannot_approve_bank');
    expect((await one(h, 's-3')).body.bank).toBeNull();
    expect((await one(h, 's-1')).body.bank).toBeNull();
    expect((await bank(h, 's-1', 'tok-acct-1', 'u-acct', 'bank-2')).status).toBe(200);
    const s1 = (await one(h, 's-1')).body;
    // Who asked is the signed-in owner, never a name in the body; who verified is the accountant who approved it.
    expect(s1.bank).toEqual({ accountRef: 'tok-acct-1', requestedBy: 'u-owner', verifiedBy: 'u-acct', changedAt: '2026-09-30T08:00:00.000Z' });
    expect(s1.attention).toEqual(['awaiting_approval']);
    // The other supplier is pointed at the SAME account — both are flagged (M15-FR-03), on the list and on the record.
    expect((await bank(h, 's-2', 'tok-acct-1', 'u-acct', 'bank-3')).status).toBe(200);
    const rows = (await list(h)).body.suppliers;
    expect(rows.find((r) => r.supplierId === 's-1')!.attention).toContain('duplicate_bank_account');
    expect(rows.find((r) => r.supplierId === 's-2')!.attention).toContain('duplicate_bank_account');
    expect((await one(h, 's-2')).body.duplicateBankAccount).toBe(true);
  });

  it('a PAYMENT is a fact a second person approved, recorded once, refused for a blocked supplier / no verified bank account / a shared account / the payer as approver / more than owed — and it nets the account and posts through the mapping', async () => {
    const h = await seeded();
    expect((await propose(h, 's-1', { name: 'Amma Traders' })).status).toBe(201);
    expect((await approve(h, 's-1', 'u-acct')).status).toBe(200);
    // Nobody may pay who may not: the store manager and the cashier hold no payment right.
    expect((await pay(h, 's-1', 'p-mgr', {}, 'u-buyer')).status).toBe(403);
    expect((await pay(h, 's-1', 'p-cash', {}, 'u-cash')).status).toBe(403);
    // Malformed → nothing.
    expect(codeOf(await pay(h, 's-1', 'p-bad', { amountMinor: 0 }))).toBe('not_readable_as_a_supplier_payment');
    expect(codeOf(await pay(h, 's-1', 'p-bad2', { method: 'gold' }))).toBe('not_readable_as_a_supplier_payment');
    // A bank payment with no independently verified account → refused (M06-FR-01: an unverified bank change blocks payment).
    const noBank = await pay(h, 's-1', 'p-1', {});
    expect(noBank.status).toBe(409);
    expect(codeOf(noBank)).toBe('no_verified_bank_account');
    // Cash needs no account: recorded, once, approved by the owner; the balance falls 7000 → 6000.
    const cash = await pay(h, 's-1', 'p-cash-1', { method: 'cash', reference: 'petty cash voucher 12' });
    expect(cash.status).toBe(201);
    expect(cash.body).toMatchObject({ alreadyRecorded: false, owedMinor: 6000, payment: { paymentId: 'p-cash-1', amountMinor: 1000, method: 'cash', recordedBy: 'u-acct', approvedBy: 'u-owner' } });
    expect((await pay(h, 's-1', 'p-cash-1', { method: 'cash', reference: 'petty cash voucher 12' }, 'u-acct', 'pay-p-cash-1-again')).body).toMatchObject({ alreadyRecorded: true, owedMinor: 6000 });
    expect((await one(h, 's-1')).body.account.totals).toMatchObject({ paidMinor: 1000, owedMinor: 6000 });

    // The account verified (by someone other than the creator) → a bank transfer may be recorded — but not by the payer approving
    // themselves, not on an approver without the authority, not for more than is owed, and not while the supplier is under a hold.
    expect((await bank(h, 's-1', 'tok-acct-1', 'u-acct', 'bank-1')).status).toBe(200);
    expect(codeOf(await pay(h, 's-1', 'p-self', { approvedBy: 'u-acct' }))).toBe('self_approval');
    expect(codeOf(await pay(h, 's-1', 'p-weak', { approvedBy: 'u-checker' }))).toBe('approver_lacks_authority');
    expect(codeOf(await pay(h, 's-1', 'p-ghost', { approvedBy: 'u-nobody' }))).toBe('approver_lacks_authority');
    expect(codeOf(await pay(h, 's-1', 'p-too-much', { amountMinor: 6001 }))).toBe('payment_exceeds_balance');
    expect((await post(h, '/v1/purchase/suppliers/s-1/block-status', 'u-buyer', { blocked: true, reason: 'quality dispute' }, 'blk-1')).status).toBe(200);
    expect(codeOf(await pay(h, 's-1', 'p-blocked', {}))).toBe('supplier_blocked');
    expect((await list(h)).body.suppliers[0]!.attention).toContain('blocked');
    expect((await post(h, '/v1/purchase/suppliers/s-1/block-status', 'u-buyer', { blocked: false, reason: 'resolved' }, 'blk-2')).status).toBe(200);
    const transfer = await pay(h, 's-1', 'p-2', { amountMinor: 2000, reference: 'UTR-77' });
    expect(transfer.status).toBe(201);
    expect(transfer.body).toMatchObject({ owedMinor: 4000, payment: { method: 'bank_transfer', amountMinor: 2000 } });
    // Nothing was recorded for any refusal: exactly two payments on the account.
    const acct = (await one(h, 's-1')).body.account;
    expect(acct.payments.map((p) => [p.paymentId, p.amountMinor])).toEqual([['p-cash-1', 1000], ['p-2', 2000]]);
    expect(acct.totals).toMatchObject({ accruedMinor: 9000, debitNotesMinor: 2000, paidMinor: 3000, owedMinor: 4000 });
    // Another supplier pointed at the same account → payment to EITHER is blocked until reviewed (M15-FR-03).
    expect((await propose(h, 's-2', { name: 'Beta Foods' })).status).toBe(201);
    expect((await bank(h, 's-2', 'tok-acct-1', 'u-acct', 'bank-2')).status).toBe(200);
    expect(codeOf(await pay(h, 's-1', 'p-dup', {}))).toBe('duplicate_bank_account');

    // The payments post through the accountant's mapping and the two derivations agree at 4000.
    expect((await put(h, '/v1/finance/posting-map', 'u-acct', DEFAULT_RETAIL_POSTING_MAP, 'map-1')).status).toBe(200);
    const posted = (await post(h, '/v1/finance/payables/post', 'u-acct', {}, 'pay-post-1')).body as { journals: { kind: string; sourceId: string; lines: { accountCode: string; debitMinor: number; creditMinor: number }[] }[] };
    expect(posted.journals.map((j) => [j.kind, j.sourceId])).toEqual([['supplier_invoice', 'inv-1'], ['supplier_debit_note', 'DN-grn-1-L3'], ['supplier_payment', 'p-cash-1'], ['supplier_payment', 'p-2']]);
    expect(posted.journals[3]!.lines).toEqual([{ accountCode: 'supplier_payable', debitMinor: 2000, creditMinor: 0 }, { accountCode: 'bank_clearing', debitMinor: 0, creditMinor: 2000 }]);
    const recon = ((await get(h, '/v1/finance/payables', 'u-acct')).body as { reconciliation: { agrees: boolean; registerOwedMinor: number; ledgerOwedMinor: number } }).reconciliation;
    expect(recon).toMatchObject({ agrees: true, registerOwedMinor: 4000, ledgerOwedMinor: 4000 });
  });

  it('a SECOND bill against the same order pays nothing for goods the first already claimed, is withheld in full, and the pair is said to over-claim the order; the first is untouched', async () => {
    const h = await seeded();
    expect((await post(h, '/v1/purchase/invoices/inv-2/capture', 'u-buyer', PAPER, 'cap-inv-2')).status).toBe(201);
    const second = (await post(h, '/v1/purchase/invoices/inv-2/match', 'u-checker', {}, 'mat-inv-2')).body as StoredMatch;
    expect(second).toMatchObject({ blocked: true, payableMinor: 0, invoicedMinor: 9000, withheldMinor: 9000, flags: ['order_over_invoiced'] });
    expect(second.sources.invoicedBefore).toEqual({ p1: 10, p2: 4 });
    expect(second.lines.map((l) => [l.productId, l.status, l.payableMinor])).toEqual([['p1', 'blocked', 0], ['p2', 'blocked', 0]]);
    // The first bill re-matched still pays in full — nothing was invoiced before it.
    const first = (await post(h, '/v1/purchase/invoices/inv-1/match', 'u-checker', {}, 'mat-inv-1-again')).body as StoredMatch;
    expect(first).toMatchObject({ blocked: false, payableMinor: 9000, flags: [] });
    expect(first.sources.invoicedBefore).toEqual({});
    // The account: accrued stays 9000, the second bill wholly withheld, and the supplier flagged for a person.
    const acct = (await one(h, 's-1')).body;
    expect(acct.account.totals).toMatchObject({ invoicedMinor: 18_000, accruedMinor: 9000, withheldMinor: 9000, owedMinor: 7000, blockedInvoices: 1 });
    expect(acct.attention).toEqual(expect.arrayContaining(['blocked_invoices', 'withheld', 'over_invoiced']));
  });

  it('a debit note the account raised is ISSUED under a number from the tenant\'s series, once, by a person with the match authority; the account then carries the number', async () => {
    const h = await seeded();
    expect((await one(h, 's-1')).body.account.debitNotes[0]).toMatchObject({ debitNoteRef: 'DN-grn-1-L3', valueMinor: 2000, number: null });
    expect((await post(h, '/v1/purchase/suppliers/s-1/debit-notes/DN-grn-1-L3/issue', 'u-cash', {}, 'dn-cash')).status).toBe(403);
    expect(codeOf(await post(h, '/v1/purchase/suppliers/s-1/debit-notes/DN-nope/issue', 'u-checker', {}, 'dn-nope'))).toBe('not_found');
    const issued = await post(h, '/v1/purchase/suppliers/s-1/debit-notes/DN-grn-1-L3/issue', 'u-checker', {}, 'dn-1');
    expect(issued.status).toBe(201);
    expect(issued.body).toMatchObject({ debitNoteRef: 'DN-grn-1-L3', number: 'DN-000001', issuedBy: 'u-checker', valueMinor: 2000, alreadyIssued: false });
    expect((await post(h, '/v1/purchase/suppliers/s-1/debit-notes/DN-grn-1-L3/issue', 'u-acct', {}, 'dn-1-again')).body).toMatchObject({ number: 'DN-000001', alreadyIssued: true });
    expect((await one(h, 's-1')).body.account.debitNotes[0]).toMatchObject({ number: 'DN-000001', issuedBy: 'u-checker' });
    // A second note (the sound p2 line returned too) takes the next number — gap-free.
    expect((await post(h, '/v1/inventory/goods-receipt/grn-2', 'u-recv', { warehouseId: 'store-1', receivedOnDate: '2026-09-30', currency: 'INR', poId: 'po-1', lines: [rl('L1', 'p1', 0, 3, 500, { condition: 'damaged' })] }, 'grn-2')).status).toBe(201);
    expect((await post(h, '/v1/inventory/goods-receipt/grn-2/lines/L1/disposition', 'u-boss', { disposition: 'claim', reason: 'crushed' }, 'd-g2')).status).toBe(200);
    expect((await post(h, '/v1/purchase/suppliers/s-1/debit-notes/DN-grn-2-L1/issue', 'u-checker', {}, 'dn-2')).body).toMatchObject({ number: 'DN-000002', valueMinor: 1500 });
  });

  it('the supplier\'s OWN portal statement reads the same account (P-02): invoiced, our debit note as their credit, the payment, the withheld figure disputed — and it reconciles', async () => {
    const h = await seeded();
    await h.provisionRole(A, 'u-sup', 'supplier');
    expect((await post(h, '/v1/supplier-portal/partners/s-1', 'u-owner', { grants: ['view_orders', 'view_statement'], documents: [], requiredDocuments: [], logins: ['u-sup'] }, 'partner-s-1')).status).toBe(201);
    expect((await propose(h, 's-1', { name: 'Amma Traders' })).status).toBe(201);
    expect((await approve(h, 's-1', 'u-acct')).status).toBe(200);
    expect((await pay(h, 's-1', 'p-cash-1', { method: 'cash', reference: 'voucher 3' })).status).toBe(201);
    // A second bill wholly withheld → disputed on the statement, never folded into the balance.
    expect((await post(h, '/v1/purchase/invoices/inv-2/capture', 'u-buyer', PAPER, 'cap-inv-2')).status).toBe(201);
    expect(((await post(h, '/v1/purchase/invoices/inv-2/match', 'u-checker', {}, 'mat-inv-2')).body as StoredMatch).withheldMinor).toBe(9000);
    const mine = await get(h, '/v1/supplier-portal/me/statement', 'u-sup');
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ partnerId: 's-1', accessible: true, invoicedMinor: 9000, creditedMinor: 2000, paidMinor: 1000, closingMinor: 6000, disputedMinor: 9000, reconciles: true });
    const refs = ((mine.body as { lines: { documentRef: string; kind: string; status: string }[] }).lines).map((l) => [l.documentRef, l.kind, l.status]);
    expect(refs).toEqual(expect.arrayContaining([
      ['account:invoice:inv-1', 'invoice', 'open'], ['account:invoice:inv-2:withheld', 'invoice', 'disputed'],
      ['account:debit-note:DN-grn-1-L3', 'credit_note', 'open'], ['account:payment:p-cash-1', 'payment', 'settled'],
    ]));
    // The same figure the buyer's review reads and the account holds.
    expect(((await get(h, '/v1/supplier-portal/partners/s-1/statement', 'u-owner')).body as { closingMinor: number }).closingMinor).toBe(6000);
    expect((await one(h, 's-1')).body.account.totals.owedMinor).toBe(6000);
  });
});
