import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import { aBranch } from '../support/a-branch';
import { approvedSuppliers } from '../support/approved-supplier';
import { DEFAULT_RETAIL_POSTING_MAP, type PostingMap } from '../../packages/finance/src/index';

/**
 * **OB-881 B (owner, 19 Nov 2026, in writing) — when the supplier's credit note for shelf stock sent back shows GST, the
 * accountant types it on "Supplier accepted" (OB-879) and the books reverse that input GST once — on the in-memory event
 * store and, with DATABASE_URL, on real PostgreSQL.**
 *
 *   • optional: without it, no GST reversal (as before);
 *   • refused in plain words: negative; more than the accepted amount at the highest GST rate on the item; CGST/SGST with
 *     IGST; an item with no GST rate known;
 *   • with it: the goods and the GST come off what is owed; the debit-note posting reverses the input GST through the
 *     accountant's own input-tax legs — and WAITS, named, while his mapping has none; once mapped, posted once;
 *   • the audit trail carries the GST.
 */

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const said = (r: Res): string => (r.body as { error?: { whatHappened?: string } }).error?.whatHappened ?? '';
interface Journal { kind: string; sourceId: string; lines: { accountCode: string; debitMinor: number; creditMinor: number }[] }

describe.each(useBackings())('OB-881 B: a supplier credit note\'s GST is reversed once — on $name', ({ harness }) => {
  it('is optional, checked against the item\'s GST rate, waits while unmapped, then posts once', async () => {
    const h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-acct', 'accountant');
    await aBranch(h, T, 'u-owner');
    await approvedSuppliers(h, T, 'sup-1');
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = 'u-acct', query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method !== 'GET' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    for (const p of ['OIL', 'GHEE']) {
      const rx = await req('POST', '/v1/inventory/movements', { movementId: `rx-${p}`, productId: p, locationId: 'store-1', kind: 'received', quantityMinor: 20, uom: 'ea', occurredAt: '2026-11-01T09:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 15_000 }, 'u-owner');
      expect(rx.status, JSON.stringify(rx.body)).toBe(202);
    }
    // The supplier's bill for the oil charged 5% (2.5% CGST + 2.5% SGST) — the GST rate head office knows on OIL.
    const bill = await req('POST', '/v1/purchase/invoices/inv-oil/capture', { supplierId: 'sup-1', declaredTotalMinor: 157_500, lines: [{ productId: 'OIL', quantity: 10, unitPriceMinor: 15_000, lineTotalMinor: 150_000, cgstMinor: 3_750, sgstMinor: 3_750 }] }, 'u-mgr');
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    for (const [id, p] of [['rts-a', 'OIL'], ['rts-b', 'OIL'], ['rts-c', 'GHEE']] as const) {
      const sent = await req('POST', `/v1/inventory/shelf-returns/${id}`, { productId: p, locationId: 'store-1', qty: 2, uom: 'ea', supplierId: 'sup-1', reason: 'expired' }, 'u-mgr');
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    }
    const accept = (note: string, body: Record<string, unknown>) =>
      req('POST', `/v1/purchase/suppliers/sup-1/shelf-return-debit-notes/${note}/accept`, { supplierCreditNoteNo: `CN-${note}`, supplierCreditNoteDate: '2026-11-18', ...body });
    const owed = async (): Promise<number> => ((await req('GET', '/v1/purchase/suppliers/sup-1/account')).body as { totals: { owedMinor: number } }).totals.owedMinor;

    // ── Refused in plain words; nothing recorded ─────────────────────────────────────────────────────────────────
    const neg = await accept('DN-RTS-rts-b', { cgstMinor: -750, sgstMinor: 750 });
    expect([codeOf(neg), said(neg)]).toEqual(['gst_cannot_be_negative', 'The GST on a credit note cannot be below nothing. Type it as the credit note shows it, without a minus sign.']);
    const over = await accept('DN-RTS-rts-b', { cgstMinor: 800, sgstMinor: 800 });
    expect(codeOf(over)).toBe('gst_more_than_the_rate_allows');
    expect(said(over)).toBe('The GST typed (₹16.00) is more than ₹300.00 at the highest GST rate on OIL (5%), which is ₹15.00.');
    expect(codeOf(await accept('DN-RTS-rts-b', { cgstMinor: 750, igstMinor: 750 }))).toBe('gst_heads_do_not_go_together');
    const unknown = await accept('DN-RTS-rts-c', { cgstMinor: 750, sgstMinor: 750 });
    expect(codeOf(unknown)).toBe('gst_rate_not_known');
    expect(said(unknown)).toMatch(/^Head office knows no GST rate for GHEE/);
    expect(await owed(), 'the bill is not matched yet, so nothing is owed; a refusal takes nothing off').toBe(0);

    // ── Without GST: as before. With GST: the goods AND the GST come off what is owed ─────────────────────────────
    expect((await accept('DN-RTS-rts-a', {})).status).toBe(201);
    const withGst = await accept('DN-RTS-rts-b', { cgstMinor: 750, sgstMinor: 750 });
    expect(withGst.status, JSON.stringify(withGst.body)).toBe(201);
    expect((withGst.body as { acceptance: { gst: unknown } }).acceptance.gst).toEqual({ cgstMinor: 750, sgstMinor: 750, igstMinor: 0, rateBps: 500 });
    expect(await owed()).toBe(-(30_000 + 31_500));
    const acct = (await req('GET', '/v1/purchase/suppliers/sup-1/account')).body as { shelfReturnDebitNotesTotal: { gstReversedMinor: number } };
    expect(acct.shelfReturnDebitNotesTotal.gstReversedMinor).toBe(1_500);
    // The same again is the same acceptance; the same note with a different GST is refused — never overwritten.
    expect(((await accept('DN-RTS-rts-b', { cgstMinor: 750, sgstMinor: 750 })).body as { alreadyAccepted?: boolean }).alreadyAccepted).toBe(true);
    expect(codeOf(await accept('DN-RTS-rts-b', { cgstMinor: 700, sgstMinor: 700 }))).toBe('debit_note_already_accepted');

    // ── The books: a mapping with no input-tax leg on the debit note → that note WAITS, named; the plain one posts ──
    const noTaxLegs: PostingMap = { rules: DEFAULT_RETAIL_POSTING_MAP.rules.map((r) => (r.kind === 'supplier_debit_note' ? { kind: r.kind, legs: r.legs.filter((l) => !/^(cgst|sgst|igst)$/.test(l.component)) } : r)) };
    expect((await req('PUT', '/v1/finance/posting-map', noTaxLegs)).status).toBeLessThan(300);
    const first = (await req('POST', '/v1/finance/payables/post', {})).body as { journals: Journal[]; exceptions: { sourceIds: string[]; reason: string }[] };
    expect(first.journals.map((j) => j.sourceId)).toEqual(['DN-RTS-rts-a']);
    expect(first.exceptions.map((e) => [e.sourceIds[0], e.reason])).toEqual([['DN-RTS-rts-b', 'tax_not_mapped']]);
    // The accountant's mapping with the input-tax legs: the GST is reversed once.
    expect((await req('PUT', '/v1/finance/posting-map', DEFAULT_RETAIL_POSTING_MAP)).status).toBeLessThan(300);
    const second = (await req('POST', '/v1/finance/payables/post', {})).body as { journals: Journal[] };
    expect(second.journals.map((j) => [j.kind, j.sourceId])).toEqual([['supplier_debit_note', 'DN-RTS-rts-b']]);
    expect(second.journals[0]!.lines).toEqual([
      { accountCode: 'supplier_payable', debitMinor: 31_500, creditMinor: 0 },
      { accountCode: 'purchases_grni', debitMinor: 0, creditMinor: 30_000 },
      { accountCode: 'gst_input_cgst', debitMinor: 0, creditMinor: 750 },
      { accountCode: 'gst_input_sgst', debitMinor: 0, creditMinor: 750 },
    ]);
    expect(((await req('POST', '/v1/finance/payables/post', {})).body as { journals: unknown[] }).journals, 'posted once').toEqual([]);
    const books = (await req('GET', '/v1/finance/payables')).body as { open: number };
    expect(books.open).toBe(0);

    // ── The audit trail carries the GST ─────────────────────────────────────────────────────────────────────────
    const trail = ((await req('GET', '/v1/audit/trail', undefined, 'u-owner', { action: 'supplier.debit_note.accepted' })).body as { matches: { after: Record<string, string> }[] }).matches;
    const b = trail.find((m) => m.after['debitNoteRef'] === 'DN-RTS-rts-b')!;
    expect([b.after['gstReversedMinor'], b.after['cgstMinor'], b.after['sgstMinor'], b.after['gstRateBps']]).toEqual(['1500', '750', '750', '500']);
    expect(trail.find((m) => m.after['debitNoteRef'] === 'DN-RTS-rts-a')!.after['gstReversedMinor']).toBe('0');
  }, 120_000);
});
