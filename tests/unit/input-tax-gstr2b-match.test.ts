import { describe, it, expect } from 'vitest';
import {
  readGstr2b, reviewItc, mayAccept, makeItcForPeriod, rupeesToPaise, normaliseInvoiceNo, readReversalAmounts,
  type BookedInvoice, type Gstr2bStatement, type ItcLineAction,
} from '../../packages/input-tax/src/index';

/**
 * R3 · A17 — the pure GSTR-2B engine. Signed sentence: "an imported GSTR-2B/IMS file is matched line by line against
 * matched supplier invoices (GSTIN + invoice no. + date + tax). Each line ends accepted, rejected or pending by a named
 * person. ITC claimed in 3B Table 4 equals the accepted lines only. A booked invoice missing from 2B, and a 2B line with
 * no booked invoice, each appear as exceptions. A reversal (Rule 37/42/43, free samples via A12) is a compensating entry."
 */

const SHOP = '33BBBBB2222B1Z6';
const SUP_A = '33AAAAA1111A1Z5';
const SUP_B = '29CCCCC3333C1Z7';

/** A synthetic GSTR-2B in the portal's own JSON shape. */
export const portal2b = (period = '102026') => ({
  data: {
    rtnprd: period, gstin: SHOP,
    docdata: {
      b2b: [
        { ctin: SUP_A, trdnm: 'Synthetic Foods', inv: [
          { inum: 'A/101', dt: '05-10-2026', val: '11800.00', txval: '10000.00', igst: 0, cgst: '900.00', sgst: '900.00', cess: 0, itcavl: 'Y', rev: 'N' },
          { inum: 'A/102', dt: '06-10-2026', val: 5900, items: [{ txval: 2500, cgst: 225, sgst: 225 }, { txval: 2500, cgst: 225, sgst: 225 }] },
        ] },
        { ctin: SUP_B, trdnm: 'Synthetic Oils', inv: [
          { inum: 'B-77', dt: '09-10-2026', val: '2240.00', txval: '2000.00', igst: '240.00' },
          { inum: 'B-78', dt: '10-10-2026', val: '1120.00', txval: '1000.00', igst: '120.00' },
        ] },
      ],
    },
  },
});

const booked = (over: Partial<BookedInvoice> & Pick<BookedInvoice, 'invoiceId'>): BookedInvoice => ({
  supplierId: 'sup-a', supplierGstin: SUP_A, supplierInvoiceNo: null, supplierInvoiceDate: null,
  igstMinor: 0, cgstMinor: 0, sgstMinor: 0, cessMinor: 0, threeWayMatched: true, ...over,
});

const BOOKS: readonly BookedInvoice[] = [
  booked({ invoiceId: 'inv-1', supplierInvoiceNo: 'a/101', supplierInvoiceDate: '2026-10-05', cgstMinor: 90_000, sgstMinor: 90_000 }),
  booked({ invoiceId: 'inv-2', supplierInvoiceNo: 'A/102', supplierInvoiceDate: '2026-10-06', cgstMinor: 45_000, sgstMinor: 44_000 }), // tax differs
  booked({ invoiceId: 'inv-3', supplierId: 'sup-b', supplierGstin: SUP_B, supplierInvoiceNo: 'B-77', supplierInvoiceDate: '2026-10-09', igstMinor: 24_000 }),
  booked({ invoiceId: 'inv-4', supplierId: 'sup-b', supplierGstin: SUP_B, supplierInvoiceNo: 'B-90', supplierInvoiceDate: '2026-10-20', igstMinor: 6_000 }), // not in 2B
  booked({ invoiceId: 'inv-5', supplierInvoiceNo: null, supplierInvoiceDate: null }), // cannot be compared
  booked({ invoiceId: 'inv-6', supplierInvoiceNo: 'A/200', supplierInvoiceDate: '2026-10-01', threeWayMatched: false }),
];

const read = (raw: unknown): Gstr2bStatement => {
  const r = readGstr2b(raw);
  if (!r.ok) throw new Error(r.problems.join('; '));
  return r.statement;
};
const act = (lineId: string, action: ItcLineAction['action'], by = 'u-acct', reason: string | null = action === 'accept' ? null : 'synthetic reason'): ItcLineAction =>
  ({ period: '2026-10', lineId, action, by, at: '2026-11-12T10:00:00.000Z', reason });

describe('reading the portal file', () => {
  it('reads the 2B JSON as the portal writes it — rupees to paise, DD-MM-YYYY to dates, items added', () => {
    const s = read(portal2b());
    expect(s).toMatchObject({ period: '2026-10', recipientGstin: SHOP });
    expect(s.lines).toHaveLength(4);
    expect(s.lines[0]).toMatchObject({ supplierGstin: SUP_A, supplierName: 'Synthetic Foods', invoiceNo: 'A/101', invoiceDate: '2026-10-05', invoiceValueMinor: 1_180_000, taxableMinor: 1_000_000, cgstMinor: 90_000, sgstMinor: 90_000, igstMinor: 0, portalItcAvailable: true, reverseCharge: false });
    expect(s.lines[1]).toMatchObject({ taxableMinor: 500_000, cgstMinor: 45_000, sgstMinor: 45_000, portalItcAvailable: null });
    expect(s.lines[0]!.lineId).toMatch(/^ln-[0-9a-f]{16}$/);
    expect(new Set(s.lines.map((l) => l.lineId)).size).toBe(4);
    // The same bill reads to the same line id every time — a person's action finds its line again.
    expect(read(portal2b()).lines[0]!.lineId).toBe(s.lines[0]!.lineId);
    // Without the `data` wrapper, and an IMS download's `stin`, read the same.
    const bare = { rtnprd: '102026', gstin: SHOP, docdata: { b2b: [{ stin: SUP_A, inv: [{ inum: 'X1', dt: '2026-10-02', val: 10, txval: 10 }] }] } };
    expect(read(bare).lines[0]).toMatchObject({ supplierGstin: SUP_A, invoiceNo: 'X1', invoiceDate: '2026-10-02' });
  });

  it('refuses a file it cannot read, naming every problem — nothing is half-read', () => {
    const bad = portal2b();
    const b2b = bad.data.docdata.b2b as unknown as Record<string, unknown>[];
    (b2b[0]!['inv'] as Record<string, unknown>[])[0]!['dt'] = '31-02-2026';
    (b2b[0]!['inv'] as Record<string, unknown>[])[1]!['val'] = '12.345';
    b2b[1]!['ctin'] = 'NOT-A-GSTIN';
    const r = readGstr2b(bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.join('\n')).toMatch(/invoice 1: the invoice date \(dt\) is not a date/);
    expect(r.problems.join('\n')).toMatch(/invoice 2: the invoice value \(val\) is not an amount/);
    expect(r.problems.join('\n')).toMatch(/supplier 2: the supplier GSTIN \(ctin\) is missing/);
    expect(readGstr2b({ data: { rtnprd: '132026', gstin: SHOP, docdata: { b2b: [] } } })).toMatchObject({ ok: false });
    expect(readGstr2b('not json')).toMatchObject({ ok: false });
    const twice = portal2b();
    (twice.data.docdata.b2b[0]!.inv as unknown[]).push({ inum: 'a/ 101', dt: '05-10-2026', val: 1 });
    expect((readGstr2b(twice) as { problems: string[] }).problems.join()).toMatch(/appears twice/);
  });

  it('turns rupees into paise exactly', () => {
    expect(rupeesToPaise('0.10')).toBe(10);
    expect(rupeesToPaise(1234.5)).toBe(123_450);
    expect(rupeesToPaise(undefined)).toBe(0);
    expect(rupeesToPaise('-1')).toBeNull();
    expect(rupeesToPaise('1.234')).toBeNull();
    expect(normaliseInvoiceNo(' inv 12 ')).toBe('INV12');
  });
});

describe('matching, actions and the claim', () => {
  const statement = read(portal2b());
  const id = (no: string) => statement.lines.find((l) => l.invoiceNo === no)!.lineId;

  it('matches each line on GSTIN + number + date + tax, and names both kinds of exception', () => {
    const r = reviewItc({ period: '2026-10', statements: [statement], booked: BOOKS, actions: [], reversals: [] });
    const by = (no: string) => r.lines.find((l) => l.invoiceNo === no)!;
    expect(by('A/101')).toMatchObject({ match: 'matched', bookedInvoiceId: 'inv-1', state: 'awaiting_a_person' });
    expect(by('A/102')).toMatchObject({ match: 'differs', differences: ['sgst'], bookedInvoiceId: 'inv-2' });
    expect(by('B-77')).toMatchObject({ match: 'matched', bookedInvoiceId: 'inv-3' });
    expect(by('B-78')).toMatchObject({ match: 'not_in_books', bookedInvoiceId: null });
    expect(r.exceptions.notInBooks).toEqual([id('B-78')]);
    expect(r.exceptions.differs).toEqual([id('A/102')]);
    expect(r.exceptions.missingFrom2b.map((b) => b.invoiceId)).toEqual(['inv-4']);
    expect(r.exceptions.incompleteBooked).toEqual([{ invoiceId: 'inv-5', supplierId: 'sup-a', why: ['no_supplier_invoice_number', 'no_supplier_invoice_date'] }]);
    expect(r.exceptions.notThreeWayMatched).toEqual(['inv-6']);
    // Nobody has acted: nothing is claimed, and it says so — never a zero.
    expect(r.claim).toEqual({ status: 'not_reconciled', reason: '4 line(s) of the 2026-10 GSTR-2B are awaiting a person\'s accept, reject or pending' });
    expect(r.totals.awaitingCount).toBe(4);
  });

  it('the claim is the ACCEPTED lines only, once every line has a person\'s action', () => {
    const actions = [act(id('A/101'), 'accept'), act(id('B-77'), 'accept'), act(id('A/102'), 'pending'), act(id('B-78'), 'reject')];
    const r = reviewItc({ period: '2026-10', statements: [statement], booked: BOOKS, actions, reversals: [] });
    expect(r.claim).toEqual({ status: 'reconciled', igstMinor: 24_000, cgstMinor: 90_000, sgstMinor: 90_000, cessMinor: 0, reversed: { igstMinor: 0, cgstMinor: 0, sgstMinor: 0, cessMinor: 0 }, acceptedLines: 2 });
    expect(r.totals.pending).toMatchObject({ cgstMinor: 45_000, sgstMinor: 45_000 });
    expect(r.totals.rejected).toMatchObject({ igstMinor: 12_000 });
    expect(r.lines.find((l) => l.invoiceNo === 'A/101')).toMatchObject({ state: 'accepted', actedBy: 'u-acct' });
    // A change of mind is a newer action — the latest stands.
    const later = reviewItc({ period: '2026-10', statements: [statement], booked: BOOKS, actions: [...actions, { ...act(id('B-77'), 'pending'), by: 'u-owner' }], reversals: [] });
    expect(later.claim).toMatchObject({ status: 'reconciled', igstMinor: 0, cgstMinor: 90_000, acceptedLines: 1 });
    expect(later.lines.find((l) => l.invoiceNo === 'B-77')).toMatchObject({ state: 'pending', actedBy: 'u-owner' });
  });

  it('only a matched line may be accepted; an accept on an unmatched line never counts', () => {
    const r = reviewItc({ period: '2026-10', statements: [statement], booked: BOOKS, actions: [], reversals: [] });
    expect(r.lines.filter(mayAccept).map((l) => l.invoiceNo)).toEqual(['A/101', 'B-77']);
    const forced = reviewItc({ period: '2026-10', statements: [statement], booked: BOOKS, actions: [act(id('B-78'), 'accept')], reversals: [] });
    expect(forced.lines.find((l) => l.invoiceNo === 'B-78')!.state).toBe('awaiting_a_person');
  });

  it('a reversal is its own compensating record beside the accepted credit', () => {
    const actions = [act(id('A/101'), 'accept'), act(id('B-77'), 'accept'), act(id('A/102'), 'reject'), act(id('B-78'), 'reject')];
    const reversal = { reversalId: 'rv-1', period: '2026-10', rule: 'free_samples' as const, sourceRef: 'A12 free sample FS-1', reason: 'given away free', igstMinor: 0, cgstMinor: 1_000, sgstMinor: 1_000, cessMinor: 0, by: 'u-acct', at: '2026-11-12T10:00:00.000Z' };
    const r = reviewItc({ period: '2026-10', statements: [statement], booked: BOOKS, actions, reversals: [reversal, { ...reversal, reversalId: 'rv-other', period: '2026-09' }] });
    expect(r.claim).toMatchObject({ status: 'reconciled', cgstMinor: 90_000, reversed: { cgstMinor: 1_000, sgstMinor: 1_000 } });
    expect(r.reversals.map((x) => x.reversalId)).toEqual(['rv-1']);
    expect(readReversalAmounts({ cgstMinor: 5 })).toEqual({ igstMinor: 0, cgstMinor: 5, sgstMinor: 0, cessMinor: 0 });
    expect(readReversalAmounts({})).toBeNull();
    expect(readReversalAmounts({ cgstMinor: -1 })).toBeNull();
  });

  it('a bill already in an earlier month\'s 2B is not counted twice; a late-reported bill clears its exception', () => {
    const sept = read({ data: { rtnprd: '092026', gstin: SHOP, docdata: { b2b: [{ ctin: SUP_A, inv: [{ inum: 'A/101', dt: '05-10-2026', val: 1, cgst: 900, sgst: 900 }] }] } } });
    const r = reviewItc({ period: '2026-10', statements: [sept, statement], booked: BOOKS, actions: [], reversals: [] });
    expect(r.lines.find((l) => l.invoiceNo === 'A/101')).toMatchObject({ match: 'in_an_earlier_2b', earlierPeriod: '2026-09' });
    // inv-4 (dated 20 Oct) is missing from the October 2B; it turns up in November's — October's exception list clears.
    const nov = read({ data: { rtnprd: '112026', gstin: SHOP, docdata: { b2b: [{ ctin: SUP_B, inv: [{ inum: 'B-90', dt: '20-10-2026', val: 1, igst: 60 }] }] } } });
    expect(reviewItc({ period: '2026-10', statements: [statement], booked: BOOKS, actions: [], reversals: [] }).exceptions.missingFrom2b).toHaveLength(1);
    expect(reviewItc({ period: '2026-11', statements: [statement, nov], booked: BOOKS, actions: [], reversals: [] }).exceptions.missingFrom2b).toHaveLength(0);
  });

  it('no 2B uploaded → not reconciled, said; the port answers the same, and refuses a non-month', async () => {
    const r = reviewItc({ period: '2026-12', statements: [statement], booked: BOOKS, actions: [], reversals: [] });
    expect(r.imported).toBe(false);
    expect(r.claim).toEqual({ status: 'not_reconciled', reason: 'no GSTR-2B has been uploaded for 2026-12' });
    const port = makeItcForPeriod(async (_t, period) => reviewItc({ period, statements: [statement], booked: BOOKS, actions: [act(id('A/101'), 'accept'), act(id('B-77'), 'accept'), act(id('A/102'), 'reject'), act(id('B-78'), 'reject')], reversals: [] }));
    expect(await port('t', '2026-10')).toEqual({ status: 'reconciled', igstMinor: 24_000, cgstMinor: 90_000, sgstMinor: 90_000, cessMinor: 0 });
    expect(await port('t', '2026-12')).toMatchObject({ status: 'not_reconciled' });
    expect(await port('t', 'October')).toEqual({ status: 'not_reconciled', reason: 'October is not a month (YYYY-MM)' });
  });
});
