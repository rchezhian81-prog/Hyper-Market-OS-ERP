import { describe, it, expect } from 'vitest';
import {
  foldSupplierAccount, foldAllSupplierAccounts, needsAttention,
  type ReceiptForAccount, type OrderForAccount,
} from '../../services/purchase/src/supplier-account';
import type { SupplierInvoiceRecord, StoredMatch } from '../../services/purchase/src/index';

/**
 * SP-7b (audit finding F04's payable half · M23-FR-01 · M07-FR-03 · P-02): the supplier account is a PROJECTION over the
 * invoice, match, order and receipt registers — what is owed is the latest match's payable, what is in dispute is its
 * withheld figure, a debit note is raised for the QUARANTINED quantity a second person returned or claimed (received, so
 * accrued), refused stock is said and never owed (the match already withheld it), and a rejected excess is a return
 * pending until it has gone back. Pure; the routes are covered in integration.
 */

const AT = '2026-09-30T10:00:00.000Z';
const invoice = (invoiceId: string, supplierId: string, totalMinor: number, poId: string | null = 'po-1', flags: string[] = []): SupplierInvoiceRecord => ({
  invoiceId, supplierId, poId, lines: [], declaredTotalMinor: totalMinor, totalMinor, currency: 'INR',
  capturedBy: 'u-buyer', capturedAt: AT, approvedBy: 'u-checker', approvedAt: AT, source: 'head-office', governanceFlags: flags,
});
const match = (invoiceId: string, payableMinor: number, invoicedMinor: number, flags: string[] = []): StoredMatch => ({
  invoiceId, poId: 'po-1', matchedBy: 'u-checker', matchedAt: AT, lines: [], payableMinor, invoicedMinor, withheldMinor: invoicedMinor - payableMinor,
  blocked: invoicedMinor !== payableMinor, detail: '', ownerAction: '',
  sources: { invoice: null, order: null, received: 'goods_receipts_folded_into_the_order' }, flags,
});
const orders: OrderForAccount[] = [{ poId: 'po-1', supplierId: 's-1', status: 'issued' }, { poId: 'po-2', supplierId: 's-2', status: 'issued' }];
const line = (lineId: string, productId: string, quarantined: number, rejected: number, held = 0, unit = 500) =>
  ({ lineId, productId, quarantinedMinor: quarantined, rejectedMinor: rejected, heldMinor: held, unitCost: { minor: unit, currency: 'INR' } });
const disposed = (lineId: string, productId: string, disposition: 'accept' | 'return' | 'claim', quantityMinor: number, valueMinor: number) =>
  ({ lineId, productId, disposition, quantityMinor, valueMinor, currency: 'INR', decidedBy: 'u-boss', decidedAt: AT, reason: `${disposition} it` });
const receipt = (grnId: string, poId: string | null, over: Partial<ReceiptForAccount> = {}): ReceiptForAccount =>
  ({ grnId, poId, receivedBy: 'u-recv', receivedAt: AT, heldMinor: 0, captured: { lines: [] }, ...over });

describe('foldSupplierAccount — what is owed is read from the registers, never typed', () => {
  it('an unmatched invoice is owed nothing and wholly withheld; a matched one owes its payable and withholds the rest; totals add up', () => {
    const matches = new Map([['inv-2', match('inv-2', 7000, 9000)], ['inv-3', match('inv-3', 4000, 4000)]]);
    const a = foldSupplierAccount({
      supplierId: 's-1', invoices: [invoice('inv-1', 's-1', 5000), invoice('inv-2', 's-1', 9000), invoice('inv-3', 's-1', 4000), invoice('inv-x', 's-2', 1)],
      matchOf: (id) => matches.get(id), orders, receipts: [], asAt: AT,
    });
    expect(a.invoices.map((i) => [i.invoiceId, i.matched, i.payableMinor, i.withheldMinor, i.blocked])).toEqual([
      ['inv-1', false, 0, 5000, false], ['inv-2', true, 7000, 2000, true], ['inv-3', true, 4000, 0, false],
    ]);
    expect(a.totals).toEqual({
      invoicedMinor: 18_000, accruedMinor: 11_000, withheldMinor: 7000, debitNotesMinor: 0, paidMinor: 0, owedMinor: 11_000,
      unmatchedInvoices: 1, blockedInvoices: 1, pendingReturns: 0,
    });
    expect(needsAttention(a)).toBe(true);
    // Another supplier's invoice never reaches this account.
    expect(a.invoices.some((i) => i.invoiceId === 'inv-x')).toBe(false);
  });

  it('a RETURN or CLAIM of a quarantined line raises a debit note for the quarantined quantity at the delivered cost; an accept raises nothing; the balance nets it', () => {
    const grn = receipt('grn-1', 'po-1', {
      captured: { lines: [line('L1', 'p1', 4, 0), line('L2', 'p2', 3, 0), line('L3', 'p3', 2, 0)] },
      dispositions: [disposed('L1', 'p1', 'return', 4, 2000), disposed('L2', 'p2', 'claim', 3, 1500), disposed('L3', 'p3', 'accept', 2, 1000)],
    });
    const a = foldSupplierAccount({ supplierId: 's-1', invoices: [invoice('inv-1', 's-1', 9000)], matchOf: () => match('inv-1', 9000, 9000), orders, receipts: [grn], asAt: AT });
    expect(a.debitNotes.map((d) => [d.debitNoteRef, d.disposition, d.quantityMinor, d.valueMinor, d.decidedBy])).toEqual([
      ['DN-grn-1-L1', 'return', 4, 2000, 'u-boss'], ['DN-grn-1-L2', 'claim', 3, 1500, 'u-boss'],
    ]);
    expect(a.refusedNotOwed).toEqual([]);
    expect(a.totals).toMatchObject({ accruedMinor: 9000, debitNotesMinor: 3500, owedMinor: 5500 });
    expect(needsAttention(a)).toBe(false);
  });

  it('REFUSED stock (expired at the dock) never received against the order raises NO debit note — the match withheld it — and is said as never owed; a mixed line splits', () => {
    const grn = receipt('grn-1', 'po-1', {
      captured: { lines: [line('L1', 'p1', 0, 5), line('L2', 'p2', 2, 3)] },
      dispositions: [disposed('L1', 'p1', 'return', 5, 2500), disposed('L2', 'p2', 'claim', 5, 2500)],
    });
    const a = foldSupplierAccount({ supplierId: 's-1', invoices: [], matchOf: () => undefined, orders, receipts: [grn], asAt: AT });
    expect(a.debitNotes.map((d) => [d.lineId, d.quantityMinor, d.valueMinor])).toEqual([['L2', 2, 1000]]);
    expect(a.refusedNotOwed.map((r) => [r.lineId, r.disposition, r.quantityMinor, r.valueMinor])).toEqual([['L1', 'return', 5, 2500], ['L2', 'claim', 3, 1500]]);
    expect(a.totals).toMatchObject({ debitNotesMinor: 1000, owedMinor: -1000 });
  });

  it('a REJECTED over-delivery is a supplier return PENDING until it has gone back — valued at the delivered cost; an approved one is nothing to return', () => {
    const rejected = receipt('grn-r', 'po-1', {
      heldMinor: 6, captured: { lines: [line('L1', 'p1', 0, 0, 6, 250)] },
      excessDecision: { decision: 'rejected', decidedBy: 'u-boss', decidedAt: AT, reason: 'not ordered' },
    });
    const approved = receipt('grn-a', 'po-1', { heldMinor: 2, captured: { lines: [line('L1', 'p1', 0, 0, 2)] }, excessDecision: { decision: 'approved', decidedBy: 'u-boss', decidedAt: AT, reason: 'free' } });
    const pending = foldSupplierAccount({ supplierId: 's-1', invoices: [], matchOf: () => undefined, orders, receipts: [rejected, approved], asAt: AT });
    expect(pending.pendingSupplierReturns).toEqual([{ grnId: 'grn-r', poId: 'po-1', heldMinor: 6, valueMinor: 1500, currency: 'INR', decidedBy: 'u-boss', decidedAt: AT, returned: false, returnedAt: null }]);
    expect(pending.totals.pendingReturns).toBe(1);
    expect(needsAttention(pending)).toBe(true);
    const returned = foldSupplierAccount({
      supplierId: 's-1', invoices: [], matchOf: () => undefined, orders, asAt: AT,
      receipts: [{ ...rejected, excessReturn: { returnedBy: 'u-recv', returnedAt: '2026-10-01T09:00:00.000Z', quantityMinor: 6, valueMinor: 1500 } }],
    });
    expect(returned.pendingSupplierReturns[0]).toMatchObject({ returned: true, returnedAt: '2026-10-01T09:00:00.000Z' });
    expect(returned.totals.pendingReturns).toBe(0);
    expect(needsAttention(returned)).toBe(false);
  });

  it('SP-7c: payments recorded against THIS supplier net the balance (another supplier\'s do not); a debit note carries its number once issued; a supplier known only from a payment still has an account', () => {
    const grn = receipt('grn-1', 'po-1', { captured: { lines: [line('L1', 'p1', 4, 0)] }, dispositions: [disposed('L1', 'p1', 'return', 4, 2000)] });
    const pay = (paymentId: string, supplierId: string, amountMinor: number) => ({
      paymentId, supplierId, amountMinor, currency: 'INR' as const, paidOn: '2026-10-02', method: 'bank_transfer' as const, reference: 'UTR-1',
      recordedBy: 'u-acct', recordedAt: AT, approvedBy: 'u-owner', approvedAt: AT,
    });
    const a = foldSupplierAccount({
      supplierId: 's-1', invoices: [invoice('inv-1', 's-1', 9000)], matchOf: () => match('inv-1', 9000, 9000), orders, receipts: [grn], asAt: AT,
      payments: [pay('pay-1', 's-1', 3000), pay('pay-2', 's-1', 500), pay('pay-x', 's-9', 99_999)],
      debitNoteIssues: [{ debitNoteRef: 'DN-grn-1-L1', supplierId: 's-1', number: 'DN-000007', seq: 7, valueMinor: 2000, issuedBy: 'u-acct', issuedAt: AT }],
    });
    expect(a.payments.map((p) => p.paymentId)).toEqual(['pay-1', 'pay-2']);
    expect(a.totals).toMatchObject({ accruedMinor: 9000, debitNotesMinor: 2000, paidMinor: 3500, owedMinor: 3500 });
    expect(a.debitNotes[0]).toMatchObject({ debitNoteRef: 'DN-grn-1-L1', number: 'DN-000007', issuedBy: 'u-acct' });
    // Not issued → no number, said as null rather than an empty string.
    const unissued = foldSupplierAccount({ supplierId: 's-1', invoices: [], matchOf: () => undefined, orders, receipts: [grn], asAt: AT });
    expect(unissued.debitNotes[0]).toMatchObject({ number: null, issuedBy: null, issuedAt: null });
    const all = foldAllSupplierAccounts({ invoices: [], matchOf: () => undefined, orders: [], receipts: [], payments: [pay('pay-x', 's-9', 100)], asAt: AT });
    expect(all.accounts.map((x) => [x.supplierId, x.totals.paidMinor, x.totals.owedMinor])).toEqual([['s-9', 100, -100]]);
  });

  it('a receipt against ANOTHER supplier\'s order, or against no order head office knows, reaches this account not at all — and the latter is a named exception', () => {
    const theirs = receipt('grn-2', 'po-2', { captured: { lines: [line('L1', 'p1', 1, 0)] }, dispositions: [disposed('L1', 'p1', 'return', 1, 500)] });
    const orphan = receipt('grn-3', null, { captured: { lines: [line('L1', 'p1', 1, 0)] }, dispositions: [disposed('L1', 'p1', 'claim', 1, 500)] });
    const ghost = receipt('grn-4', 'po-9', { heldMinor: 1, captured: { lines: [line('L1', 'p1', 0, 0, 1)] }, excessDecision: { decision: 'rejected', decidedBy: 'u-boss', decidedAt: AT, reason: 'x' } });
    const quiet = receipt('grn-5', null, { captured: { lines: [line('L1', 'p1', 1, 0)] }, dispositions: [disposed('L1', 'p1', 'accept', 1, 500)] });
    const all = foldAllSupplierAccounts({ invoices: [invoice('inv-1', 's-1', 100)], matchOf: () => undefined, orders, receipts: [theirs, orphan, ghost, quiet], asAt: AT });
    expect(all.accounts.map((a) => [a.supplierId, a.debitNotes.length, a.totals.debitNotesMinor])).toEqual([['s-1', 0, 0], ['s-2', 1, 500]]);
    expect(all.unattributed).toEqual([
      { grnId: 'grn-3', reason: 'no_purchase_order', dispositions: 1, rejectedExcess: false },
      { grnId: 'grn-4', reason: 'order_unknown', dispositions: 0, rejectedExcess: true },
    ]);
  });
});
