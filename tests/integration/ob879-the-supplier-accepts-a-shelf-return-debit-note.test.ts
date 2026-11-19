import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import { aBranch } from '../support/a-branch';
import { approvedSuppliers } from '../support/approved-supplier';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';

/**
 * **OB-879 (batch 19 · under OB-874 C, owner 19 Nov 2026) — "Supplier accepted" for a debit note on shelf stock returned to
 * the supplier — on the in-memory event store and, with DATABASE_URL, on real PostgreSQL.**
 *
 *   • a shelf-return debit note waits, shown and NOT taken off what is owed, until the supplier accepts it;
 *   • the accountant records the supplier's credit-note number and date (both required); the amount defaults to the note's,
 *     a lower one needs a reason and the difference stays shown; more than the note, a future date: refused in plain words;
 *   • only then is it taken off what is owed — once; the same acceptance again is the same one; a different one is refused;
 *   • it reaches the books once as a debit note; the audit trail names who, the credit note and the amounts;
 *   • the same permission as issuing a debit note (`purchase.invoice.match`): a cashier cannot.
 */

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
interface Account {
  shelfReturnDebitNotes: { debitNoteRef: string; number: string; state: string; nettedInBalance: boolean; acceptance: null | { supplierCreditNoteNo: string; acceptedMinor: number; differenceMinor: number; reason?: string } }[];
  shelfReturnDebitNotesTotal: { valueMinor: number; acceptedMinor: number; notAcceptedMinor: number };
  totals: { owedMinor: number; debitNotesMinor: number };
}

describe.each(useBackings())('OB-879: the supplier accepts a shelf-return debit note — on $name', ({ harness }) => {
  it('waits until accepted; the acceptance is recorded once, audited, taken off what is owed once, and posted once', async () => {
    const h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-acct', 'accountant');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await aBranch(h, T, 'u-owner');
    await approvedSuppliers(h, T, 'sup-1');
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = 'u-acct', query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method !== 'GET' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const rx = await req('POST', '/v1/inventory/movements', { movementId: 'rx-oil', productId: 'OIL', locationId: 'store-1', kind: 'received', quantityMinor: 20, uom: 'ea', occurredAt: '2026-11-01T09:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 15_000 }, 'u-owner');
    expect(rx.status, JSON.stringify(rx.body)).toBe(202);
    // ₹300 of oil back to the supplier (below the write-off limit: the manager's own act).
    const sent = await req('POST', '/v1/inventory/shelf-returns/rts-a', { productId: 'OIL', locationId: 'store-1', qty: 2, uom: 'ea', supplierId: 'sup-1', reason: 'expired' }, 'u-mgr');
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const ref = 'DN-RTS-rts-a';
    const account = async (): Promise<Account> => (await req('GET', '/v1/purchase/suppliers/sup-1/account')).body as Account;

    // Waiting: shown, not netted.
    let a = await account();
    expect(a.shelfReturnDebitNotes.map((d) => [d.debitNoteRef, d.state, d.nettedInBalance, d.acceptance])).toEqual([[ref, 'waiting_for_supplier', false, null]]);
    expect(a.totals.owedMinor).toBe(0);
    expect(a.shelfReturnDebitNotesTotal).toMatchObject({ valueMinor: 30_000, acceptedMinor: 0, notAcceptedMinor: 0 });

    const accept = (body: Record<string, unknown>, userId = 'u-acct', note = ref) => req('POST', `/v1/purchase/suppliers/sup-1/shelf-return-debit-notes/${note}/accept`, body, userId);
    // Refused, in plain words, with nothing recorded.
    expect(codeOf(await accept({ supplierCreditNoteDate: '2026-11-18' }))).toBe('not_readable_as_a_supplier_acceptance');
    expect(codeOf(await accept({ supplierCreditNoteNo: 'CN-77' }))).toBe('not_readable_as_a_supplier_acceptance');
    expect(codeOf(await accept({ supplierCreditNoteNo: 'CN-77', supplierCreditNoteDate: '2999-01-01' }))).toBe('credit_note_dated_in_the_future');
    const more = await accept({ supplierCreditNoteNo: 'CN-77', supplierCreditNoteDate: '2026-11-18', acceptedMinor: 30_001 });
    expect(codeOf(more)).toBe('accepted_more_than_the_note');
    const less = await accept({ supplierCreditNoteNo: 'CN-77', supplierCreditNoteDate: '2026-11-18', acceptedMinor: 25_000 });
    expect(codeOf(less)).toBe('reason_needed_for_less');
    expect((less.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/Say why the supplier accepted less — the difference of ₹50\.00 stays shown/);
    expect(codeOf(await accept({ supplierCreditNoteNo: 'CN-77', supplierCreditNoteDate: '2026-11-18' }, 'u-acct', 'DN-RTS-nothing'))).toBe('not_found');
    // The same permission as issuing a debit note (purchase.invoice.match): the cashier cannot.
    expect((await accept({ supplierCreditNoteNo: 'CN-77', supplierCreditNoteDate: '2026-11-18' }, 'u-cash')).status).toBe(403);
    expect((await account()).totals.owedMinor, 'nothing taken off by a refusal').toBe(0);

    // Accepted: ₹250 of the ₹300, with a reason — taken off what is owed once; ₹50 stays shown.
    const ok = await accept({ supplierCreditNoteNo: 'CN-77', supplierCreditNoteDate: '2026-11-18', acceptedMinor: 25_000, reason: 'one tin was past the date he takes back' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    a = await account();
    expect(a.shelfReturnDebitNotes[0]).toMatchObject({ state: 'accepted', nettedInBalance: true, acceptance: { supplierCreditNoteNo: 'CN-77', acceptedMinor: 25_000, differenceMinor: 5_000, reason: 'one tin was past the date he takes back' } });
    expect(a.totals.owedMinor).toBe(-25_000);
    expect(a.shelfReturnDebitNotesTotal).toMatchObject({ valueMinor: 0, acceptedMinor: 25_000, notAcceptedMinor: 5_000 });
    // The same acceptance again is the same one; a different one is refused — never overwritten.
    const again = await accept({ supplierCreditNoteNo: 'CN-77', supplierCreditNoteDate: '2026-11-18', acceptedMinor: 25_000, reason: 'again' });
    expect([again.status, (again.body as { alreadyAccepted?: boolean }).alreadyAccepted]).toEqual([200, true]);
    expect(codeOf(await accept({ supplierCreditNoteNo: 'CN-78', supplierCreditNoteDate: '2026-11-18' }))).toBe('debit_note_already_accepted');
    expect((await account()).totals.owedMinor, 'taken off once').toBe(-25_000);

    // The books: once, as a debit note, at the accepted amount.
    expect((await req('PUT', '/v1/finance/posting-map', DEFAULT_RETAIL_POSTING_MAP)).status).toBeLessThan(300);
    const posted = await req('POST', '/v1/finance/payables/post', {});
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    const journals = (posted.body as { journals: { kind: string; sourceId: string; lines: { accountCode: string; debitMinor: number; creditMinor: number }[] }[] }).journals;
    expect(journals.map((j) => [j.kind, j.sourceId])).toEqual([['supplier_debit_note', ref]]);
    expect(journals[0]!.lines).toEqual([{ accountCode: 'supplier_payable', debitMinor: 25_000, creditMinor: 0 }, { accountCode: 'purchases_grni', debitMinor: 0, creditMinor: 25_000 }]);
    expect(((await req('POST', '/v1/finance/payables/post', {})).body as { journals: unknown[] }).journals).toEqual([]);

    // The audit trail: who, the supplier's credit note, the amounts.
    const trail = ((await req('GET', '/v1/audit/trail', undefined, 'u-owner', { action: 'supplier.debit_note.accepted' })).body as { matches: { actorId: string; reason?: string; after: Record<string, string> }[] }).matches;
    expect(trail.map((m) => [m.actorId, m.after['debitNoteRef'], m.after['supplierCreditNoteNo'], m.after['acceptedMinor'], m.after['differenceMinor'], m.reason])).toEqual([
      ['u-acct', ref, 'CN-77', '25000', '5000', 'one tin was past the date he takes back'],
    ]);
  }, 120_000);
});
