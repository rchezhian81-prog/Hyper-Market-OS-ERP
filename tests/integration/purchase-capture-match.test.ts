import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { sealedDecision } from '../support/store-seal';
import { sentWithApproval } from '../support/approval-request';
import { STREAM } from '../../services/api/src/adapters';
import type { StoredMatch, SupplierInvoiceRecord } from '../../services/purchase/src/index';

/**
 * **The supplier invoice is a record, and the three-way match joins it to what head office HOLDS (SP-7a · audit findings
 * F02 · F04 · M07-FR-04 · M06-FR-04 · §28 · hard rules #4 #10).**
 *
 * Before SP-7a `/capture` took a caller-typed snapshot of what was ordered and received beside what was invoiced, so the
 * "three-way" match compared three figures one person typed in one go — it passed with no purchase order and no goods
 * receipt anywhere (F04). Now, through the real API and real per-tenant RBAC:
 *
 *   • an invoice is captured AS THE PAPER SAYS IT (its own lines, its printed total), read back, and matched against the
 *     STORED issued order and the receipts folded into it (SP-6) — what may be paid is the LOWEST of the three, the rest
 *     WITHHELD, and the verdict is recorded with its sources;
 *   • a body that names what was ordered or received is refused by name; the arithmetic the screen ran is re-run here;
 *   • one invoice, one record — a retry never doubles what a supplier is owed; a cashier holds neither right; one
 *     tenant's invoice never reaches another;
 *   • the relayed capture (the buyer's screen through the box) re-verifies the CAPTURER and the APPROVER from their
 *     grants and records-and-flags; an invoice nobody captured is NOT CHECKED, which is not the same answer as clean.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-09-30T10:00:00.000Z';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const post = (h: ApiHarness, path: string, userId: string, body: unknown, key: string, tenantId = A) => h.request({ method: 'POST', path, userId, tenantId, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string, userId: string, tenantId = A) => h.request({ method: 'GET', path, userId, tenantId });
const line = (productId: string, quantity: number, unitPriceMinor: number) => ({ productId, quantity, unitPriceMinor, lineTotalMinor: quantity * unitPriceMinor });
/** The paper: 10 × ₹5.00 of p1 and 4 × ₹10.00 of p2 = ₹90.00. */
const PAPER = { supplierId: 's-1', poId: 'po-1', declaredTotalMinor: 9000, lines: [line('p1', 10, 500), line('p2', 4, 1000)] };
/**
 * The capture as two people make it (ADR-0024): a body naming its checker (`approvedBy`) becomes that checker's own approval
 * in the engine — asked by the capturer for exactly this bill, decided in the checker's own session — and the capture names
 * it. When the checker may not approve (themselves, no authority, unknown), the engine's refusal comes back and nothing is
 * captured. No checker named: captured as sent (flagged `no_approval`).
 */
const capture = (h: ApiHarness, invoiceId: string, body: Record<string, unknown>, userId = 'u-buyer', key = `cap-${invoiceId}`) => {
  const { approvedBy, ...rest } = body;
  const send = (b: Record<string, unknown>) => post(h, `/v1/purchase/invoices/${invoiceId}/capture`, userId, b, key);
  if (typeof approvedBy !== 'string') return send(rest);
  const totalMinor = ((rest['lines'] ?? []) as { lineTotalMinor: number }[]).reduce((t, l) => t + l.lineTotalMinor, 0);
  return sentWithApproval(h, A, userId, approvedBy, { kind: 'supplier_invoice_check', subjectRef: invoiceId, pathIds: { invoiceId }, valueMinor: totalMinor }, rest, send);
};
const match = (h: ApiHarness, invoiceId: string, userId = 'u-checker', body: Record<string, unknown> = {}, key = `mat-${invoiceId}`) =>
  post(h, `/v1/purchase/invoices/${invoiceId}/match`, userId, body, key);
/** A bill as a current store computer relays it: the capturer it verified, sealed (`sealed: false` = an unsealed body). */
const relayed = (h: ApiHarness, invoiceId: string, over: Record<string, unknown> = {}, key = `sync-${invoiceId}`, sealed = true) => {
  const body = { invoiceId, ...PAPER, capturedBy: 'u-buyer', capturedAt: AT, approvedBy: 'u-checker', approvedAt: AT, storeId: 'store-1', source: 'buyer-screen', ...over };
  return post(h, `/v1/purchase/invoices/${invoiceId}/synced`, 'u-box', sealed ? sealedDecision(A, 'SupplierInvoiceCaptured', body) : body, key);
};
const matchesOnRecord = async (h: ApiHarness, invoiceId: string) =>
  (await h.store.readStream(A, STREAM.purchase, { type: 'InvoiceMatched' })).map((e) => e.event.payload as StoredMatch).filter((m) => m.invoiceId === invoiceId);

/** The cast, an ISSUED order (p1 10 @ ₹5, p2 4 @ ₹10) and a delivery against it that brought all the p1 and only 2 of the p2. */
async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-buyer', 'store_manager');   // captures; holds match too — but may never check their own capture
  await h.provisionRole(A, 'u-checker', 'store_manager'); // the second person
  await h.provisionRole(A, 'u-cash', 'cashier');          // no purchase right at all
  await h.provisionRole(A, 'u-box', 'cashier');           // the store box's sync identity
  expect((await post(h, '/v1/purchase/orders/po-1', 'u-buyer', { supplierId: 's-1', lines: [{ productId: 'p1', orderedQty: 10, unitCost: { minor: 500, currency: 'INR' } }, { productId: 'p2', orderedQty: 4, unitCost: { minor: 1000, currency: 'INR' } }] }, 'po-1')).status).toBe(201);
  expect((await post(h, '/v1/purchase/orders/po-1/approval', 'u-owner', { reason: 'fixture' }, 'po-1-approve')).status).toBe(200);
  expect((await post(h, '/v1/inventory/goods-receipt/grn-1', 'u-owner', {
    warehouseId: 'store-1', receivedOnDate: '2026-09-30', currency: 'INR', poId: 'po-1',
    lines: [
      { lineId: 'L1', productId: 'p1', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 500, currency: 'INR' }, condition: 'good' },
      { lineId: 'L2', productId: 'p2', orderedMinor: 4, countedMinor: 2, uom: 'ea', unitCost: { minor: 1000, currency: 'INR' }, condition: 'good' },
    ],
  }, 'grn-1')).status).toBe(201);
  return h;
}

describe('a supplier invoice is captured as the paper says it and matched against what head office holds (SP-7a)', () => {
  it('captured, read back, matched over the STORED order and receipts: pays the lowest of three, withholds the rest, records the verdict with its sources', async () => {
    const h = await seeded();
    const cap = await capture(h, 'inv-1', { ...PAPER, approvedBy: 'u-checker' });
    expect(cap.status).toBe(201);
    expect(cap.body).toMatchObject({ alreadyCaptured: false, flags: [], invoice: { invoiceId: 'inv-1', supplierId: 's-1', poId: 'po-1', totalMinor: 9000, capturedBy: 'u-buyer', approvedBy: 'u-checker', source: 'head-office' } });
    const read = (await get(h, '/v1/purchase/invoices/inv-1', 'u-owner')).body as { invoice: SupplierInvoiceRecord; match: StoredMatch | null };
    expect(read.invoice.lines).toEqual(PAPER.lines);
    expect(read.match).toBeNull();

    // The match: p1 agrees (10 / 10 / 10 @ ₹5); p2 was invoiced 4 but only 2 arrived → pay 2 × ₹10, hold ₹20 back.
    const m = await match(h, 'inv-1');
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({
      invoiceId: 'inv-1', poId: 'po-1', blocked: true, payableMinor: 7000, invoicedMinor: 9000, withheldMinor: 2000, matchedBy: 'u-checker', flags: [],
      lines: [
        { productId: 'p1', status: 'matched', payableMinor: 5000 },
        { productId: 'p2', status: 'blocked', quantityDifference: 2, payableMinor: 2000 },
      ],
      sources: { invoice: { capturedBy: 'u-buyer', totalMinor: 9000 }, order: { status: 'issued', supplierId: 's-1', lineCount: 2 }, received: 'goods_receipts_folded_into_the_order' },
    });
    expect(((await get(h, '/v1/purchase/invoices/inv-1', 'u-owner')).body as { match: StoredMatch }).match).toMatchObject({ payableMinor: 7000 });
    // The rest of the p2 arrives → the same invoice now matches clean; the new verdict is a new record, the old one kept.
    expect((await post(h, '/v1/inventory/goods-receipt/grn-2', 'u-owner', {
      warehouseId: 'store-1', receivedOnDate: '2026-09-30', currency: 'INR', poId: 'po-1',
      lines: [{ lineId: 'L1', productId: 'p2', orderedMinor: 4, countedMinor: 2, uom: 'ea', unitCost: { minor: 1000, currency: 'INR' }, condition: 'good' }],
    }, 'grn-2')).status).toBe(201);
    expect((await match(h, 'inv-1', 'u-checker', {}, 'mat-inv-1-again')).body).toMatchObject({ blocked: false, payableMinor: 9000, withheldMinor: 0 });
    expect((await matchesOnRecord(h, 'inv-1')).map((r) => r.payableMinor)).toEqual([7000, 9000]);
    const list = (await get(h, '/v1/purchase/invoices', 'u-owner')).body as { count: number; unmatchedCount: number; blockedCount: number };
    expect(list).toMatchObject({ count: 1, unmatchedCount: 0, blockedCount: 0 });
  });

  it('the body may not say what was ordered or received (F04): the old snapshot shape is refused by name on capture AND on match; nothing is saved', async () => {
    const h = await seeded();
    const snapshot = await capture(h, 'inv-f04', { lines: [{ productId: 'p1', orderedQty: 10, receivedQty: 10, invoicedQty: 20, orderedUnitMinor: 500, invoicedUnitMinor: 500 }] });
    expect(snapshot.status).toBe(400);
    expect(codeOf(snapshot)).toBe('invoice_carries_caller_claims');
    expect(codeOf(await capture(h, 'inv-f04b', { ...PAPER, ordered: [] }))).toBe('invoice_carries_caller_claims');
    expect(codeOf(await match(h, 'inv-x', 'u-checker', { lines: [{ productId: 'p1' }] }))).toBe('invoice_carries_caller_claims');
    expect(codeOf(await match(h, 'inv-x', 'u-checker', { received: [] }))).toBe('invoice_carries_caller_claims');
    expect((await get(h, '/v1/purchase/invoices/inv-f04', 'u-owner')).status).toBe(404);
    expect(((await get(h, '/v1/purchase/invoices', 'u-owner')).body as { count: number }).count).toBe(0);
  });

  it('re-runs the arithmetic the screen ran: a line that does not multiply, or lines that do not add up to the printed total, are refused and nothing is saved', async () => {
    const h = await seeded();
    const bad = await capture(h, 'inv-arith', { ...PAPER, lines: [{ productId: 'p1', quantity: 10, unitPriceMinor: 500, lineTotalMinor: 4999 }, line('p2', 4, 1000)] });
    expect(bad.status).toBe(422);
    expect(codeOf(bad)).toBe('invoice_line_does_not_multiply');
    const short = await capture(h, 'inv-sum', { ...PAPER, declaredTotalMinor: 9500 });
    expect(short.status).toBe(422);
    expect(codeOf(short)).toBe('does_not_add_up_to_the_invoice_total');
    expect(codeOf(await capture(h, 'inv-empty', { ...PAPER, lines: [] }))).toBe('not_readable_as_a_supplier_invoice');
    expect(codeOf(await capture(h, 'inv-neg', { ...PAPER, lines: [{ productId: 'p1', quantity: -1, unitPriceMinor: 500, lineTotalMinor: -500 }] }))).toBe('not_readable_as_a_supplier_invoice');
    expect(((await get(h, '/v1/purchase/invoices', 'u-owner')).body as { count: number }).count).toBe(0);
    // And an invoice nobody captured is NOT CHECKED — blocked with nothing to compare, which is not the same answer as clean.
    const ghost = (await match(h, 'inv-ghost')).body as StoredMatch;
    expect(ghost).toMatchObject({ blocked: true, payableMinor: 0, flags: ['invoice_unknown'], sources: { invoice: null, order: null, received: 'none' } });
    expect(ghost.detail).toContain('no lines were found');
  });

  it('one invoice, one record: the same key replays, a re-minted key finds it already captured, the match still pays once; a cashier holds no right; another tenant sees nothing', async () => {
    const h = await seeded();
    expect((await capture(h, 'inv-dup', PAPER)).status).toBe(201);
    expect((await capture(h, 'inv-dup', PAPER)).status).toBe(201); // same key → the kernel replays the same answer
    const again = await capture(h, 'inv-dup', PAPER, 'u-buyer', 'cap-dup-2');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadyCaptured: true });
    expect(((await get(h, '/v1/purchase/invoices', 'u-owner')).body as { count: number }).count).toBe(1);
    expect(((await match(h, 'inv-dup')).body as StoredMatch).invoicedMinor).toBe(9000); // not 18000
    // Nobody checked it yet — said on the record, not silent.
    expect(((await get(h, '/v1/purchase/invoices/inv-dup', 'u-owner')).body as { invoice: SupplierInvoiceRecord }).invoice.governanceFlags).toEqual(['no_approval']);
    // A cashier holds neither capture nor match nor read; the box identity cannot capture directly; a buyer cannot use the sync route.
    expect((await capture(h, 'inv-cash', PAPER, 'u-cash')).status).toBe(403);
    expect((await match(h, 'inv-dup', 'u-cash')).status).toBe(403);
    expect((await get(h, '/v1/purchase/invoices/inv-dup', 'u-cash')).status).toBe(403);
    expect((await capture(h, 'inv-box', PAPER, 'u-box')).status).toBe(403);
    expect((await post(h, '/v1/purchase/invoices/inv-s/synced', 'u-buyer', { invoiceId: 'inv-s', ...PAPER, capturedBy: 'u-buyer', capturedAt: AT }, 'sync-by-person')).status).toBe(403);
    // Tenant B never captured that invoice — A's record did not leak.
    await h.seedOwner(B, 'u-owner-b');
    expect((await get(h, '/v1/purchase/invoices/inv-dup', 'u-owner-b', B)).status).toBe(404);
    expect(((await post(h, '/v1/purchase/invoices/inv-dup/match', 'u-owner-b', {}, 'mat-b', B)).body as StoredMatch)).toMatchObject({ blocked: true, payableMinor: 0 });
  });

  it('the capturer cannot be the checker (§28); no order, an unknown order and an order not yet issued are said — and an unissued order counts as nothing ordered', async () => {
    const h = await seeded();
    const self = await capture(h, 'inv-self', { ...PAPER, approvedBy: 'u-buyer' });
    expect(self.status).toBe(422);
    expect(codeOf(self)).toBe('self_approval');
    expect((await get(h, '/v1/purchase/invoices/inv-self', 'u-owner')).status).toBe(404);
    // A person head office does not know, or one without the right to check bills, cannot approve one — refused at the
    // decision, nothing captured (before 2b-vi-b-3 the bill was recorded with their typed name and only flagged).
    expect((await capture(h, 'inv-ghost', { ...PAPER, approvedBy: 'u-nobody' })).status).toBe(403);
    expect((await capture(h, 'inv-cash', { ...PAPER, approvedBy: 'u-cash' })).status).toBe(403);
    // A typed checker is refused by name (audit PA-03).
    expect(codeOf(await post(h, '/v1/purchase/invoices/inv-typed/capture', 'u-buyer', { ...PAPER, approvedBy: 'u-checker' }, 'cap-typed'))).toBe('approver_named_without_approval');
    // Captured before anyone checked it: recorded and flagged — the match and the payment still need a second person.
    expect(((await capture(h, 'inv-ghost-ok', PAPER)).body as { flags: string[] }).flags).toEqual(['no_approval']);
    expect(((await capture(h, 'inv-cash-ok', PAPER)).body as { flags: string[] }).flags).toEqual(['no_approval']);
    // No order named: received as-is; the match has nothing ordered or received to agree with → blocked.
    const none = (await capture(h, 'inv-noorder', { ...PAPER, poId: null, approvedBy: 'u-checker' })).body as { flags: string[] };
    expect(none.flags).toEqual(['no_purchase_order']);
    expect((await match(h, 'inv-noorder')).body).toMatchObject({ blocked: true, payableMinor: 0, flags: ['no_purchase_order'], sources: { order: null, received: 'none' } });
    // The match may name the order the invoice did not — head office's copy of it. SP-7c: two earlier bills against po-1 are
    // already on file above (inv-ghost-ok, inv-cash-ok), so this THIRD bill for the same goods is judged against what they left —
    // nothing — and the three are said to over-claim the order (invoiced-to-date), instead of each being paid in full.
    expect((await match(h, 'inv-noorder', 'u-checker', { poId: 'po-1' }, 'mat-noorder-po')).body).toMatchObject({
      poId: 'po-1', payableMinor: 0, withheldMinor: 9000, blocked: true, flags: ['order_over_invoiced'],
      sources: { order: { status: 'issued', supplierId: 's-1' }, received: 'goods_receipts_folded_into_the_order', invoicedBefore: { p1: 20, p2: 8 } },
    });
    // An unknown order, and a supplier that differs from the order's.
    expect(((await capture(h, 'inv-unknown', { ...PAPER, poId: 'po-nope', approvedBy: 'u-checker' })).body as { flags: string[] }).flags).toEqual(['order_unknown']);
    expect(((await capture(h, 'inv-other', { ...PAPER, supplierId: 's-2', approvedBy: 'u-checker' })).body as { flags: string[] }).flags).toEqual(['supplier_differs_from_order']);
    // A proposed, unissued order: nobody committed to it, so the invoice cannot agree with it.
    expect((await post(h, '/v1/purchase/orders/po-draft', 'u-buyer', { supplierId: 's-1', lines: [{ productId: 'p1', orderedQty: 10, unitCost: { minor: 500, currency: 'INR' } }] }, 'po-draft')).status).toBe(201);
    expect(((await capture(h, 'inv-draft', { ...PAPER, poId: 'po-draft', approvedBy: 'u-checker' })).body as { flags: string[] }).flags).toEqual(['order_not_issued']);
    expect((await match(h, 'inv-draft')).body).toMatchObject({ blocked: true, payableMinor: 0, flags: ['order_not_issued'], sources: { order: { status: 'proposed' }, received: 'none' } });
  });

  it('relayed from the buyer\'s screen (synced): the capturer and the checker are re-verified from THEIR grants and every breach is said — never silently trusted, never dropped; the record is one however often it is relayed', async () => {
    const h = await seeded();
    const first = await relayed(h, 'inv-r1');
    expect(first.status).toBe(202);
    // The checker the store's screen TYPED is kept as a claim, never as an approval (2b-vi-c-3 · register row 17b): no store
    // computer verified that person, so the bill is recorded unchecked and the check is the checker's own act — the match.
    expect(first.body).toMatchObject({
      alreadyCaptured: false, flags: ['no_approval', 'approver_not_verified_at_store'],
      invoice: { invoiceId: 'inv-r1', capturedBy: 'u-buyer', approvedBy: null, approvalClaimedBy: 'u-checker', relayedBy: 'u-box', source: 'buyer-screen', storeId: 'store-1', poId: 'po-1' },
    });
    expect((await relayed(h, 'inv-r1', {}, 'sync-inv-r1-again')).body).toMatchObject({ alreadyCaptured: true });
    expect((await match(h, 'inv-r1')).body).toMatchObject({ payableMinor: 7000, sources: { invoice: { capturedBy: 'u-buyer' } } });
    // A capturer head office does not know; a capturer without the right; the capturer naming themselves as checker; no checker.
    expect(((await relayed(h, 'inv-r2', { capturedBy: 'u-ghost', approvedBy: 'u-checker' })).body as { flags: string[] }).flags).toEqual(['capturer_unknown', 'no_approval', 'approver_not_verified_at_store']);
    expect(((await relayed(h, 'inv-r3', { capturedBy: 'u-cash' })).body as { flags: string[] }).flags).toEqual(['capturer_lacks_authority', 'no_approval', 'approver_not_verified_at_store']);
    expect(((await relayed(h, 'inv-r4', { approvedBy: 'u-buyer' })).body as { flags: string[] }).flags).toEqual(['no_approval', 'self_approved']);
    expect(((await relayed(h, 'inv-r5', { approvedBy: null })).body as { flags: string[] }).flags).toEqual(['no_approval']);
    // A bill the store computer did not vouch for — no seal — is said; one changed after the seal no longer matches.
    expect(((await relayed(h, 'inv-r6', { approvedBy: null }, 'sync-inv-r6', false)).body as { flags: string[] }).flags).toEqual(['decider_not_verified_at_store', 'no_approval']);
    // Malformed or not adding up → refused by name (the box dead-letters it for a person); the path and body must agree.
    expect(codeOf(await relayed(h, 'inv-r7', { declaredTotalMinor: 1 }))).toBe('does_not_add_up_to_the_invoice_total');
    expect(codeOf(await relayed(h, 'inv-r8', { invoiceId: 'inv-other' }))).toBe('not_readable_as_a_relayed_invoice');
    expect(codeOf(await relayed(h, 'inv-r9', { capturedBy: undefined }))).toBe('not_readable_as_a_relayed_invoice');
    expect(((await get(h, '/v1/purchase/invoices', 'u-owner')).body as { count: number }).count).toBe(6);
  });
});
