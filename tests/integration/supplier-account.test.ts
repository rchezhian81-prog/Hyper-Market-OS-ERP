import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { sentWithApproval } from '../support/approval-request';
import { STREAM } from '../../services/api/src/adapters';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import type { StoredMatch } from '../../services/purchase/src/index';
import type { SupplierAccountStatement } from '../../services/purchase/src/supplier-account';

/**
 * **The supplier account, the payable and the journal (SP-7b · audit finding F04's payable half · M23-FR-01 · M07-FR-03 ·
 * M07-FR-04 · §28 · P-02 · P-08 · QG-07 · hard rules #2 #4 #5, API-03 / API-04 / API-09).**
 *
 * Until SP-7b the matched payable reached nothing: no supplier account, no statement, no journal (F04). Now, through the
 * real API and real per-tenant RBAC:
 *
 *   • what a supplier is OWED is read from the registers head office already holds — the invoice (SP-7a), its latest
 *     three-way match, the order and the receipts folded into it (SP-6) — never typed: an unmatched invoice is owed nothing,
 *     a matched one owes the lowest of three and withholds the rest; a second person's RETURN or CLAIM of quarantined stock
 *     raises a debit note for the quantity that WAS received (and so paid for); refused stock is said and never owed;
 *   • the tenant's match TOLERANCES are the owner's, applied to every match and recorded on every verdict — never a body's;
 *   • a REJECTED over-delivery is a supplier return pending until it has physically gone back, then recorded, once;
 *   • the accountant's mapping turns the account into balanced journals — an accrual, a reversal when a re-match owes
 *     less, a debit note once — and the purchase register and the finance ledger reconcile as two figures reached two
 *     different ways, the difference (and exactly what is unposted) always visible; a kind the mapping does not name is
 *     a named exception until the mapping does.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const post = (h: ApiHarness, path: string, userId: string, body: unknown, key: string, tenantId = A) => h.request({ method: 'POST', path, userId, tenantId, idempotencyKey: key, body });
const put = (h: ApiHarness, path: string, userId: string, body: unknown, key: string) => h.request({ method: 'PUT', path, userId, tenantId: A, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string, userId: string, tenantId = A, query?: Readonly<Record<string, string>>) => h.request({ method: 'GET', path, userId, tenantId, ...(query === undefined ? {} : { query }) });
const line = (productId: string, quantity: number, unitPriceMinor: number) => ({ productId, quantity, unitPriceMinor, lineTotalMinor: quantity * unitPriceMinor });
/** The paper: 10 × ₹5.00 of p1 and 4 × ₹10.00 of p2 = ₹90.00, against po-1. */
const PAPER = { supplierId: 's-1', poId: 'po-1', declaredTotalMinor: 9000, lines: [line('p1', 10, 500), line('p2', 4, 1000)] };
/** The buyer captures the bill; the checker approves exactly it in their own session first (ADR-0024). */
const capture = (h: ApiHarness, invoiceId: string, body: Record<string, unknown>, key = `cap-${invoiceId}`) =>
  sentWithApproval(h, A, 'u-buyer', 'u-checker', {
    kind: 'supplier_invoice_check', subjectRef: invoiceId, pathIds: { invoiceId },
    valueMinor: ((body['lines'] ?? []) as { lineTotalMinor: number }[]).reduce((t, l) => t + l.lineTotalMinor, 0),
  }, body, (b) => post(h, `/v1/purchase/invoices/${invoiceId}/capture`, 'u-buyer', b, key));
const match = (h: ApiHarness, invoiceId: string, key = `mat-${invoiceId}`) => post(h, `/v1/purchase/invoices/${invoiceId}/match`, 'u-checker', {}, key);
const dispose = (h: ApiHarness, grnId: string, lineId: string, disposition: string, key: string) =>
  post(h, `/v1/inventory/goods-receipt/${grnId}/lines/${lineId}/disposition`, 'u-boss', { disposition, reason: `${disposition} — inspected on the dock` }, key);
const account = async (h: ApiHarness, supplierId = 's-1', userId = 'u-owner', tenantId = A) => {
  const res = await get(h, `/v1/purchase/suppliers/${supplierId}/account`, userId, tenantId);
  return { status: res.status, body: res.body as SupplierAccountStatement };
};
const onHand = async (h: ApiHarness, productId: string): Promise<number> =>
  ((await get(h, '/v1/inventory/availability', 'u-owner', A, { productId })).body as { rows: { onHandMinor: number }[] }).rows.reduce((s, r) => s + r.onHandMinor, 0);
const receipt = (lines: Record<string, unknown>[], poId = 'po-1') => ({ warehouseId: 'store-1', receivedOnDate: '2026-09-30', currency: 'INR', poId, lines });
const rl = (lineId: string, productId: string, ordered: number, counted: number, unit: number, extra: Record<string, unknown> = {}) =>
  ({ lineId, productId, orderedMinor: ordered, countedMinor: counted, uom: 'ea', unitCost: { minor: unit, currency: 'INR' }, condition: 'good', ...extra });

interface Journal { entryId: string; kind: string; sourceId: string; supplierId: string; period: string; documentDate: string; lines: { accountCode: string; debitMinor: number; creditMinor: number }[]; postedBy: string }
interface PostBody { planned: number; journals: Journal[]; exceptions: { exceptionId: string; kind: string; reason: string; sourceIds: string[] }[]; suppliers: number }
interface ReadBody {
  journals: Journal[]; exceptions: { exceptionId: string; state: string }[]; open: number;
  reconciliation: { controlAccount: string | null; agrees: boolean; registerOwedMinor: number; ledgerOwedMinor: number; differenceMinor: number; leftDerivation: string; rightDerivation: string; suppliers: { supplierId: string; agrees: boolean; registerOwedMinor: number; ledgerOwedMinor: number; unposted: { kind: string; sourceId: string }[] }[] };
}

/**
 * The cast, an ISSUED order (p1 10 @ ₹5, p2 4 @ ₹10) and ONE delivery against it: all the p1 good, 2 of the p2 good, 2 of
 * the p2 damaged (quarantined — in the building, received against the order), and 5 more p1 that arrived expired (refused —
 * never received). Zero tolerance, so nothing is silently absorbed.
 */
async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await approvedSuppliers(h, A, 's-1'); // OB-32: an order needs an approved supplier
  await deliveryPlaces(h, A, 'store-1'); // OB-37: an order names the store it is delivered to
  await h.provisionRole(A, 'u-buyer', 'store_manager');   // captures invoices
  await h.provisionRole(A, 'u-checker', 'store_manager'); // the second person on the invoice
  await h.provisionRole(A, 'u-recv', 'store_manager');    // receives deliveries
  await h.provisionRole(A, 'u-boss', 'store_manager');    // the second person on the receipt
  await h.provisionRole(A, 'u-acct', 'accountant');       // posts the payables
  await h.provisionRole(A, 'u-cash', 'cashier');          // no right at all
  await h.seedOwner(B, 'u-owner-b');
  expect((await post(h, '/v1/inventory/receipt-policy', 'u-owner', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }, 'pol')).status).toBe(201);
  expect((await post(h, '/v1/purchase/orders/po-1', 'u-buyer', { supplierId: 's-1', deliverToLocationId: 'store-1', lines: [{ productId: 'p1', orderedQty: 10, unitCost: { minor: 500, currency: 'INR' } }, { productId: 'p2', orderedQty: 4, unitCost: { minor: 1000, currency: 'INR' } }] }, 'po-1')).status).toBe(201);
  expect((await post(h, '/v1/purchase/orders/po-1/approval', 'u-owner', { reason: 'fixture' }, 'po-1-approve')).status).toBe(200);
  const grn = await post(h, '/v1/inventory/goods-receipt/grn-1', 'u-recv', receipt([
    rl('L1', 'p1', 10, 10, 500),
    rl('L2', 'p2', 2, 2, 1000),
    rl('L3', 'p2', 2, 2, 1000, { condition: 'damaged' }),
    rl('L4', 'p1', 0, 5, 500, { batchId: 'old', expiry: '2026-01-01' }),
  ]), 'grn-1');
  expect(grn.status).toBe(201);
  expect((grn.body as { grn: { captured: { lines: { lineId: string; sellableMinor: number; quarantinedMinor: number; rejectedMinor: number }[] } } }).grn.captured.lines.map((l) => [l.lineId, l.sellableMinor, l.quarantinedMinor, l.rejectedMinor]))
    .toEqual([['L1', 10, 0, 0], ['L2', 2, 0, 0], ['L3', 0, 2, 0], ['L4', 0, 0, 5]]);
  return h;
}

describe('the supplier account is read from the registers, never typed (SP-7b · F04 payable half)', () => {
  it('an unmatched invoice is owed nothing; the match accrues the lowest of three; a RETURN of quarantined stock raises a debit note that nets the balance; refused stock is said and never owed; every figure is head office\'s own', async () => {
    const h = await seeded();
    // No invoice yet: the supplier is known (an order names them) and owed nothing; an unknown supplier is NOT a zero.
    expect((await account(h)).body.totals).toEqual({ invoicedMinor: 0, accruedMinor: 0, withheldMinor: 0, debitNotesMinor: 0, paidMinor: 0, owedMinor: 0, unmatchedInvoices: 0, blockedInvoices: 0, pendingReturns: 0 });
    expect((await account(h, 's-nobody')).status).toBe(404);

    // The invoice arrives and is captured as the paper says it — until it is MATCHED nothing is owed and the whole of it is withheld.
    expect((await capture(h, 'inv-1', PAPER)).status).toBe(201);
    const unmatched = (await account(h)).body;
    expect(unmatched.invoices).toEqual([expect.objectContaining({ invoiceId: 'inv-1', matched: false, payableMinor: 0, withheldMinor: 9000, invoicedMinor: 9000, capturedBy: 'u-buyer', approvedBy: 'u-checker' })]);
    expect(unmatched.totals).toMatchObject({ accruedMinor: 0, withheldMinor: 9000, owedMinor: 0, unmatchedInvoices: 1 });
    const list = (await get(h, '/v1/purchase/suppliers/accounts', 'u-owner')).body as { accounts: { supplierId: string; needsAttention: boolean }[]; needingAttentionCount: number; owedMinor: number; unattributed: unknown[] };
    expect(list).toMatchObject({ accounts: [{ supplierId: 's-1', needsAttention: true }], needingAttentionCount: 1, owedMinor: 0, unattributed: [] });

    // Matched: p1 10/10/10 @ ₹5 = 5000; p2 ordered 4, RECEIVED 4 (2 sellable + 2 quarantined — in our custody), invoiced 4 @ ₹10 = 4000 → clean, 9000 accrued.
    const m = (await match(h, 'inv-1')).body as StoredMatch;
    expect(m).toMatchObject({ blocked: false, payableMinor: 9000, withheldMinor: 0, sources: { received: 'goods_receipts_folded_into_the_order', policy: { quantityToleranceBps: 0, priceToleranceBps: 100, immaterialMinor: 100, defaulted: true } } });
    let a = (await account(h)).body;
    expect(a.invoices[0]).toMatchObject({ matched: true, payableMinor: 9000, withheldMinor: 0, blocked: false });
    expect(a.totals).toMatchObject({ accruedMinor: 9000, withheldMinor: 0, debitNotesMinor: 0, owedMinor: 9000, unmatchedInvoices: 0 });
    expect(a.debitNotes).toEqual([]);
    expect(a.refusedNotOwed).toEqual([]);

    // The second person RETURNS the damaged p2 (L3): a debit note for the 2 units at the delivered ₹10 — they were received against the
    // order and so are inside the 9000 accrued — nets the balance to 7000. The RECEIVER cannot dispose of their own delivery.
    expect(codeOf(await post(h, '/v1/inventory/goods-receipt/grn-1/lines/L3/disposition', 'u-recv', { disposition: 'return', reason: 'mine' }, 'd-self'))).toBe('self_approval');
    expect((await dispose(h, 'grn-1', 'L3', 'return', 'd-L3')).status).toBe(200);
    a = (await account(h)).body;
    expect(a.debitNotes).toEqual([expect.objectContaining({ debitNoteRef: 'DN-grn-1-L3', grnId: 'grn-1', lineId: 'L3', productId: 'p2', poId: 'po-1', disposition: 'return', quantityMinor: 2, valueMinor: 2000, currency: 'INR', decidedBy: 'u-boss' })]);
    expect(a.totals).toMatchObject({ accruedMinor: 9000, debitNotesMinor: 2000, owedMinor: 7000 });

    // The refused p1 (L4, expired at the dock) is CLAIMED: it was never received against the order, the match never paid for it, so
    // NO debit note — a second one would count the same shortfall twice. It is said, as never owed.
    expect((await dispose(h, 'grn-1', 'L4', 'claim', 'd-L4')).status).toBe(200);
    a = (await account(h)).body;
    expect(a.debitNotes).toHaveLength(1);
    expect(a.refusedNotOwed).toEqual([{ grnId: 'grn-1', lineId: 'L4', productId: 'p1', poId: 'po-1', disposition: 'claim', quantityMinor: 5, valueMinor: 2500, currency: 'INR' }]);
    expect(a.totals).toMatchObject({ debitNotesMinor: 2000, owedMinor: 7000, pendingReturns: 0 });
    // The same disposition again (a retry) changes nothing; the account is a read, so it cannot double.
    expect((await dispose(h, 'grn-1', 'L3', 'return', 'd-L3-again')).body).toMatchObject({ alreadyDecided: true });
    expect((await account(h)).body.totals.owedMinor).toBe(7000);

    // Nothing to see for a cashier; nothing at all for another tenant.
    expect((await account(h, 's-1', 'u-cash')).status).toBe(403);
    expect((await get(h, '/v1/purchase/suppliers/accounts', 'u-cash')).status).toBe(403);
    expect((await account(h, 's-1', 'u-owner-b', B)).status).toBe(404);
    expect(((await get(h, '/v1/purchase/suppliers/accounts', 'u-owner-b', B)).body as { count: number }).count).toBe(0);
  });

  it('the match tolerances are the TENANT\'S: the owner sets them once, every verdict records which applied, a store manager cannot set them, and a 4% price difference flips from blocked to matched', async () => {
    const h = await seeded();
    // Without a policy the engine's defaults apply and the verdict SAYS so: p1 invoiced at ₹5.20 (4% over) is out of the 1% tolerance
    // and the ₹2.00 difference is material → blocked, paying the lower price.
    const dear = { ...PAPER, declaredTotalMinor: 9200, lines: [line('p1', 10, 520), line('p2', 4, 1000)] };
    expect((await capture(h, 'inv-dear', dear)).status).toBe(201);
    const strict = (await match(h, 'inv-dear')).body as StoredMatch;
    expect(strict).toMatchObject({ blocked: true, payableMinor: 9000, withheldMinor: 200, lines: [{ productId: 'p1', status: 'blocked', priceDifferenceMinor: 20 }, { productId: 'p2', status: 'matched' }] });
    expect(strict.sources.policy).toEqual({ quantityToleranceBps: 0, priceToleranceBps: 100, immaterialMinor: 100, defaulted: true });
    expect((await get(h, '/v1/purchase/match-policy', 'u-owner')).body).toEqual({ policy: null, defaultPolicy: { quantityToleranceBps: 0, priceToleranceBps: 100, immaterialMinor: 100 }, inForce: { quantityToleranceBps: 0, priceToleranceBps: 100, immaterialMinor: 100 } });

    // Only the owner sets the tolerances; a malformed policy is refused by name.
    expect((await post(h, '/v1/purchase/match-policy', 'u-checker', { quantityToleranceBps: 0, priceToleranceBps: 500, immaterialMinor: 100 }, 'mp-mgr')).status).toBe(403);
    expect(codeOf(await post(h, '/v1/purchase/match-policy', 'u-owner', { quantityToleranceBps: -1, priceToleranceBps: 500, immaterialMinor: 100 }, 'mp-bad'))).toBe('not_readable_as_a_match_policy');
    expect(codeOf(await post(h, '/v1/purchase/match-policy', 'u-owner', { quantityToleranceBps: 0, priceToleranceBps: 20_000, immaterialMinor: 100 }, 'mp-bad2'))).toBe('not_readable_as_a_match_policy');
    const set = await post(h, '/v1/purchase/match-policy', 'u-owner', { quantityToleranceBps: 0, priceToleranceBps: 500, immaterialMinor: 100 }, 'mp-1');
    expect(set.status).toBe(201);
    expect(set.body).toMatchObject({ policy: { quantityToleranceBps: 0, priceToleranceBps: 500, immaterialMinor: 100, setBy: 'u-owner' } });
    expect((await get(h, '/v1/purchase/match-policy', 'u-checker')).body).toMatchObject({ policy: { priceToleranceBps: 500, setBy: 'u-owner' }, inForce: { priceToleranceBps: 500 } });

    // The same invoice re-matched under the tenant's 5%: inside tolerance, no longer blocked — still paying the LOWER price (the
    // tolerance decides whether a person must look, never what is paid); the verdict names the policy that applied.
    const lenient = (await match(h, 'inv-dear', 'mat-inv-dear-2')).body as StoredMatch;
    expect(lenient).toMatchObject({ blocked: false, payableMinor: 9000, withheldMinor: 200, lines: [{ productId: 'p1', status: 'matched', payableMinor: 5000 }, { productId: 'p2', status: 'matched' }] });
    expect(lenient.sources.policy).toEqual({ quantityToleranceBps: 0, priceToleranceBps: 500, immaterialMinor: 100, defaulted: false });
    // Both verdicts are on the record — the first is not rewritten, and the second is not swallowed as a replay of it (it pays the
    // same figure but is no longer blocked: a different fact, keyed as one).
    const verdicts = (await h.store.readStream(A, STREAM.purchase, { type: 'InvoiceMatched' })).map((e) => e.event.payload as StoredMatch).filter((v) => v.invoiceId === 'inv-dear');
    expect(verdicts.map((v) => [v.blocked, v.sources.policy?.defaulted])).toEqual([[true, true], [false, false]]);
    // A body carrying tolerances with the match is still refused: the policy is the owner's, never the caller's.
    expect(codeOf(await post(h, '/v1/purchase/invoices/inv-dear/match', 'u-checker', { lines: [], priceToleranceBps: 10_000 }, 'mat-cheat'))).toBe('invoice_carries_caller_claims');
    // The account shows the invoice accrued at 9000 with 200 in dispute, not blocked.
    expect((await account(h)).body.invoices.find((i) => i.invoiceId === 'inv-dear')).toMatchObject({ payableMinor: 9000, withheldMinor: 200, blocked: false });
  });

  it('a REJECTED over-delivery is a supplier return PENDING on the account until it has gone back: recorded once, no stock invented to move (the held units never reached on-hand), refused before a second person rejects it', async () => {
    const h = await seeded();
    // 13 p1 on a second delivery against an order of 10 that grn-1 already received in full. Since SF-02 (Wave 3) a receipt
    // is judged against what is LEFT on the order — nothing — so all 13 are HELD (before SF-02 this fixture put 10 more on
    // the shelf against the same 10 ordered: the audit's over-receipt). The line's "10 ordered" is the sender's old figure,
    // so the record also says the ordered quantity disagrees. Nobody has decided it yet.
    expect((await post(h, '/v1/inventory/goods-receipt/grn-2', 'u-recv', receipt([rl('L1', 'p1', 10, 13, 500)]), 'grn-2')).status).toBe(201);
    expect(await onHand(h, 'p1')).toBe(10); // grn-1's 10 only — the 13 held are counted, in the building, and NOT on-hand
    expect(codeOf(await post(h, '/v1/inventory/goods-receipt/grn-2/excess/returned', 'u-recv', { reason: 'van' }, 'ret-early'))).toBe('excess_not_rejected');
    expect((await account(h)).body.pendingSupplierReturns).toEqual([]);

    // The second person REJECTS it → the account shows a pending return of 13 at ₹5.00 and needs attention.
    expect((await post(h, '/v1/inventory/goods-receipt/grn-2/excess/decide', 'u-boss', { decision: 'rejected', reason: 'not ordered' }, 'ex-2')).status).toBe(200);
    let a = (await account(h)).body;
    expect(a.pendingSupplierReturns).toEqual([expect.objectContaining({ grnId: 'grn-2', poId: 'po-1', heldMinor: 13, valueMinor: 6500, decidedBy: 'u-boss', returned: false, returnedAt: null })]);
    expect(a.totals.pendingReturns).toBe(1);
    expect(((await get(h, '/v1/purchase/suppliers/accounts', 'u-owner')).body as { accounts: { needsAttention: boolean }[] }).accounts[0]!.needsAttention).toBe(true);

    // The goods go back: recorded once, valued, NO movement (the held units were never on-hand); the same again appends nothing; the
    // account no longer waits. A cashier may not record it.
    const before = await onHand(h, 'p1');
    const ret = await post(h, '/v1/inventory/goods-receipt/grn-2/excess/returned', 'u-recv', { reason: 'collected by the supplier van' }, 'ret-2');
    expect(ret.status).toBe(200);
    expect(ret.body).toMatchObject({ grnId: 'grn-2', quantityMinor: 13, valueMinor: 6500, movementIds: [], returnedBy: 'u-recv', alreadyReturned: false, flags: ['nothing_left_on_order', 'ordered_quantity_disagrees', 'product_rules_unverified', 'handling_unknown', 'excess_returned_to_supplier'] });
    expect(await onHand(h, 'p1')).toBe(before);
    expect((await post(h, '/v1/inventory/goods-receipt/grn-2/excess/returned', 'u-recv', { reason: 'again' }, 'ret-2b')).body).toMatchObject({ alreadyReturned: true });
    expect((await post(h, '/v1/inventory/goods-receipt/grn-2/excess/returned', 'u-cash', { reason: 'x' }, 'ret-2c')).status).toBe(403);
    a = (await account(h)).body;
    expect(a.pendingSupplierReturns[0]).toMatchObject({ returned: true });
    expect(a.pendingSupplierReturns[0]!.returnedAt).not.toBeNull();
    expect(a.totals.pendingReturns).toBe(0);
    expect(((await get(h, '/v1/inventory/goods-receipt/grn-2', 'u-owner')).body as { grn: { governanceFlags: string[]; excessReturn: { quantityMinor: number } } }).grn).toMatchObject({ governanceFlags: ['nothing_left_on_order', 'ordered_quantity_disagrees', 'product_rules_unverified', 'handling_unknown', 'excess_returned_to_supplier'], excessReturn: { quantityMinor: 13 } });
  });

  it('the accountant posts the account through the mapping: accrual + debit note as balanced journals, the register and the ledger reconcile as two derivations, a re-run posts nothing, an unmapped kind is a named exception until the mapping names it, and a re-match that owes less REVERSES by its own journal', async () => {
    const h = await seeded();
    expect((await capture(h, 'inv-1', PAPER)).status).toBe(201);
    expect(((await match(h, 'inv-1')).body as StoredMatch).payableMinor).toBe(9000);
    expect((await dispose(h, 'grn-1', 'L3', 'return', 'd-L3')).status).toBe(200);

    // No mapping → nothing posts, said by name. Before any posting the reconciliation shows the register (7000) against a ledger of 0.
    const refused = await post(h, '/v1/finance/payables/post', 'u-acct', {}, 'pay-0');
    expect(refused.status).toBe(409);
    expect(codeOf(refused)).toBe('posting_map_not_defined');
    let read = (await get(h, '/v1/finance/payables', 'u-acct')).body as ReadBody;
    expect(read.reconciliation).toMatchObject({ controlAccount: null, agrees: false, registerOwedMinor: 7000, ledgerOwedMinor: 0, differenceMinor: 7000 });
    expect(read.reconciliation.suppliers[0]!.unposted.map((u) => [u.kind, u.sourceId])).toEqual([['supplier_invoice', 'inv-1'], ['supplier_debit_note', 'DN-grn-1-L3']]);

    // A mapping that names the invoice but NOT the debit note: the accrual posts, the note is a VISIBLE exception, and the two
    // derivations disagree by exactly the note.
    const partial = { rules: DEFAULT_RETAIL_POSTING_MAP.rules.filter((r) => r.kind !== 'supplier_debit_note') };
    expect((await put(h, '/v1/finance/posting-map', 'u-acct', partial, 'map-1')).status).toBe(200);
    const first = await post(h, '/v1/finance/payables/post', 'u-acct', {}, 'pay-1');
    expect(first.status).toBe(201);
    const firstBody = first.body as PostBody;
    expect(firstBody).toMatchObject({ planned: 2, suppliers: 1 });
    expect(firstBody.journals.map((j) => [j.entryId, j.kind, j.sourceId, j.supplierId, j.postedBy, j.lines])).toEqual([[
      'payables:supplier_invoice:inv-1:1', 'supplier_invoice', 'inv-1', 's-1', 'u-acct',
      [{ accountCode: 'purchases_grni', debitMinor: 9000, creditMinor: 0 }, { accountCode: 'supplier_payable', debitMinor: 0, creditMinor: 9000 }],
    ]]);
    expect(firstBody.exceptions).toEqual([expect.objectContaining({ exceptionId: 'payables:supplier_debit_note:DN-grn-1-L3:unmapped_kind', kind: 'supplier_debit_note', reason: 'unmapped_kind', sourceIds: ['DN-grn-1-L3'] })]);
    read = (await get(h, '/v1/finance/payables', 'u-acct')).body as ReadBody;
    expect(read).toMatchObject({ open: 1, exceptions: [{ state: 'open' }] });
    expect(read.reconciliation).toMatchObject({ controlAccount: 'supplier_payable', agrees: false, registerOwedMinor: 7000, ledgerOwedMinor: 9000, differenceMinor: -2000 });
    expect(read.reconciliation.suppliers[0]!.unposted.map((u) => u.sourceId)).toEqual(['DN-grn-1-L3']);
    expect(read.reconciliation.leftDerivation).not.toBe(read.reconciliation.rightDerivation);
    // The vouchers are journals like any other: the period fold sees the month.
    expect(((await get(h, '/v1/finance/periods', 'u-acct')).body as { periods: { period: string; state: string }[] }).periods).toEqual([{ period: firstBody.journals[0]!.period, state: 'open' }]);

    // The accountant names the kind → the debit note posts as the mirror image, the exception is RESOLVED (never deleted), the two
    // figures agree; a re-run posts nothing twice.
    expect((await put(h, '/v1/finance/posting-map', 'u-acct', DEFAULT_RETAIL_POSTING_MAP, 'map-2')).body).toMatchObject({ version: 2 });
    const second = (await post(h, '/v1/finance/payables/post', 'u-acct', {}, 'pay-2')).body as PostBody;
    expect(second.journals.map((j) => [j.entryId, j.kind, j.lines])).toEqual([[
      'payables:supplier_debit_note:DN-grn-1-L3:1', 'supplier_debit_note',
      [{ accountCode: 'supplier_payable', debitMinor: 2000, creditMinor: 0 }, { accountCode: 'purchases_grni', debitMinor: 0, creditMinor: 2000 }],
    ]]);
    expect(second.exceptions).toEqual([]);
    read = (await get(h, '/v1/finance/payables', 'u-acct')).body as ReadBody;
    expect(read).toMatchObject({ open: 0, exceptions: [{ state: 'resolved' }] });
    expect(read.reconciliation).toMatchObject({ agrees: true, registerOwedMinor: 7000, ledgerOwedMinor: 7000, differenceMinor: 0, suppliers: [{ supplierId: 's-1', agrees: true, unposted: [] }] });
    const rerun = await post(h, '/v1/finance/payables/post', 'u-acct', {}, 'pay-3');
    expect(rerun.status).toBe(200);
    expect(rerun.body).toMatchObject({ planned: 0, journals: [], exceptions: [] });
    expect(((await get(h, '/v1/finance/payables', 'u-acct')).body as ReadBody).journals).toHaveLength(2);

    // The order is AMENDED down to 8 of p1 (a second person, with a reason) → the re-match owes less (8 × ₹5 + 4 × ₹10 = 8000) → the
    // ledger is brought level by a REVERSAL journal of 1000, never by editing the accrual (hard rule #2); the figures agree again at 6000.
    expect((await post(h, '/v1/purchase/orders/po-1/amendments', 'u-owner', { amendmentId: 'am-1', reason: 'supplier could only fill 8', lines: [{ productId: 'p1', orderedQty: 8, unitCost: { minor: 500, currency: 'INR' } }, { productId: 'p2', orderedQty: 4, unitCost: { minor: 1000, currency: 'INR' } }] }, 'am-1')).status).toBe(200);
    // (Invoiced equals received, so the engine calls the line matched — but it still pays the LOWEST of the three and withholds the rest.)
    expect(((await match(h, 'inv-1', 'mat-inv-1-2')).body as StoredMatch)).toMatchObject({ payableMinor: 8000, withheldMinor: 1000, blocked: false });
    expect((await account(h)).body.totals).toMatchObject({ accruedMinor: 8000, withheldMinor: 1000, debitNotesMinor: 2000, owedMinor: 6000 });
    const third = (await post(h, '/v1/finance/payables/post', 'u-acct', {}, 'pay-4')).body as PostBody;
    expect(third.journals.map((j) => [j.entryId, j.kind, j.lines])).toEqual([[
      'payables:supplier_invoice_reversal:inv-1:1', 'supplier_invoice_reversal',
      [{ accountCode: 'supplier_payable', debitMinor: 1000, creditMinor: 0 }, { accountCode: 'purchases_grni', debitMinor: 0, creditMinor: 1000 }],
    ]]);
    read = (await get(h, '/v1/finance/payables', 'u-acct')).body as ReadBody;
    expect(read.reconciliation).toMatchObject({ agrees: true, registerOwedMinor: 6000, ledgerOwedMinor: 6000 });
    expect(read.journals.map((j) => j.entryId)).toEqual(['payables:supplier_invoice:inv-1:1', 'payables:supplier_debit_note:DN-grn-1-L3:1', 'payables:supplier_invoice_reversal:inv-1:1']);
    // Every voucher is on the finance stream as a JournalPosted like any other (the period fold and the close gate read them).
    expect((await h.store.readStream(A, STREAM.finance, { type: 'JournalPosted' })).map((e) => (e.event.payload as { entryId: string }).entryId)).toHaveLength(3);

    // A cashier posts and reads nothing; a store manager (finance.period.read) reads the reconciliation but cannot post.
    expect((await post(h, '/v1/finance/payables/post', 'u-cash', {}, 'pay-cash')).status).toBe(403);
    expect((await get(h, '/v1/finance/payables', 'u-cash')).status).toBe(403);
    expect((await post(h, '/v1/finance/payables/post', 'u-buyer', {}, 'pay-mgr')).status).toBe(403);
    expect((await get(h, '/v1/finance/payables', 'u-buyer')).status).toBe(200);
    // Another tenant's ledger is empty and reconciles to nothing.
    expect(((await get(h, '/v1/finance/payables', 'u-owner-b', B)).body as ReadBody).reconciliation).toMatchObject({ suppliers: [], registerOwedMinor: 0, ledgerOwedMinor: 0 });
  });
});
