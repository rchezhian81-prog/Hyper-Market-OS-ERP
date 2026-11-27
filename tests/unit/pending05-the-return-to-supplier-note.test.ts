import { describe, it, expect } from 'vitest';
import { printLayout, PRINT_KINDS, type PrintView } from '../../packages/documents/src/print-view';
import { readPrintView } from '../../apps/web-erp/src/print-documents-browser';

/**
 * **Pending list 27 Nov — item 5: a printed (or PDF) RETURN-TO-SUPPLIER NOTE** (S1 of batch 18c · roadmap §29
 * purchase_return · M10-FR-01 · M31-FR-02 · OB-874 C · OB-879 · OB-876 A).
 *
 * The A4 page's words for a return of shelf stock to the supplier, on the same shared sheet as the PO / GRN (batch 18b):
 *   • title "Return to supplier"; its RTS number and date; the shop and the supplier with their GSTINs;
 *   • the debit note's SDN number, where it went back from, why (and the note), who returned it, who approved it (only when
 *     a second person did), the e-way bill number (only when one applies) and where the debit note stands — "waiting for
 *     the supplier to accept" or "supplier accepted, credit note …";
 *   • the line with its batch and expiry (when held), quantity, rate, GST RATE and value — GST amounts are not worked out
 *     (OB-876 A): "GST amounts are on the debit note";
 *   • signature lines: handed over by (store) / received by (the supplier's driver). English and Tamil.
 * Nothing is invented: a fact head office does not hold reads "Not on record".
 */

const RTS: PrintView = {
  kind: 'supplier_return', documentNumber: 'RTS1/26-27/00002', date: '2026-11-20',
  shop: { name: 'SRE Hyper Market', legalName: 'SRE Hyper Market Private Limited', gstin: '33AABCS1429B1Z1', address: ['12 Main Road, Tiruppur'] },
  supplier: { id: 'sup-1', name: 'Kaveri Traders', gstin: '33ZZZZZ9999Z1ZF', address: [] },
  facts: [],
  lines: [{ productId: 'OIL', name: 'Sunflower oil 1L', hsn: '1512', quantityMinor: 6, uom: 'ea', rateMinor: 15_000, ratePer: 1, gstRateBps: 500, valueMinor: 90_000, batchId: 'B-OLD', expiry: '2026-11-15' }],
  totalMinor: 90_000, currency: 'INR', readAt: '2026-11-20T06:00:00.000Z',
  supplierReturn: {
    debitNoteNumber: 'SDN/26-27/00002', reason: 'damaged', note: 'pouches torn', returnedFrom: 'br-1', raisedBy: 'u-mgr', approvedBy: 'u-owner',
    ewbNo: null, valueSource: 'stock_cost', acceptance: null,
  },
};

describe('pending 5 — the return-to-supplier note (A4)', () => {
  it('is a print kind of its own', () => {
    expect(PRINT_KINDS).toContain('supplier_return');
  });

  it('waiting: RTS number, SDN number, why, who returned and approved it, the batch and expiry, the value, GST rates only, the two signatures', () => {
    const page = printLayout(RTS, 'en');
    expect(page.title).toBe('Return to supplier');
    expect(page.head).toEqual([{ label: 'Number', value: 'RTS1/26-27/00002' }, { label: 'Date', value: '20/11/2026' }]);
    expect(page.parties.map((p) => [p.heading, p.name, p.lines.at(-1)])).toEqual([
      ['From (the shop)', 'SRE Hyper Market', 'GSTIN: 33AABCS1429B1Z1'], ['To (the supplier)', 'Kaveri Traders', 'GSTIN: 33ZZZZZ9999Z1ZF'],
    ]);
    expect(page.facts).toEqual([
      { label: 'Debit note', value: 'SDN/26-27/00002' },
      { label: 'Returned from', value: 'br-1' },
      { label: 'Why it goes back', value: 'Damaged — pouches torn' },
      { label: 'Returned by', value: 'u-mgr' },
      { label: 'Approved by (second person)', value: 'u-owner' },
      { label: 'Status', value: 'Waiting for the supplier to accept — the debit note is not taken off what is owed yet' },
    ]);
    expect(page.table.head).toEqual(['No.', 'Item', 'HSN', 'Batch / expiry', 'Quantity', 'Rate (₹)', 'GST rate', 'Value (₹)']);
    expect(page.table.rows).toEqual([['1', 'Sunflower oil 1L (OIL)', '1512', 'B-OLD · expires 15/11/2026', '6', '150.00', '5%', '900.00']]);
    expect(page.totals).toEqual([{ label: 'Total value at these rates', value: '₹900.00', strong: true }]);
    expect(page.notes.join(' ')).toMatch(/before GST.*GST amounts are on the debit note/);
    expect(page.signatures).toEqual(['Handed over by (store)', 'Received by (supplier\'s driver)']);
  });

  it('no second person, no e-way bill: neither line is printed; an e-way bill prints its number', () => {
    const own = printLayout({ ...RTS, supplierReturn: { ...RTS.supplierReturn!, approvedBy: null } }, 'en');
    expect(own.facts.map((f) => f.label)).not.toContain('Approved by (second person)');
    expect(own.facts.map((f) => f.label)).not.toContain('E-way bill');
    const ewb = printLayout({ ...RTS, supplierReturn: { ...RTS.supplierReturn!, ewbNo: '391000654321' } }, 'en');
    expect(ewb.facts).toContainEqual({ label: 'E-way bill', value: '391000654321' });
  });

  it('accepted: the supplier\'s credit note, its date, what came off, what was not accepted and why, and the GST it showed (recorded figures only)', () => {
    const page = printLayout({ ...RTS, supplierReturn: { ...RTS.supplierReturn!, acceptance: {
      creditNoteNo: 'CN-77', creditNoteDate: '2026-11-22', acceptedMinor: 75_000, differenceMinor: 15_000, reason: 'one pouch was not his', gst: { cgstMinor: 1_875, sgstMinor: 1_875, igstMinor: 0 },
    } } }, 'en');
    expect(page.facts.find((f) => f.label === 'Status')!.value).toBe(
      'Supplier accepted, credit note CN-77 dated 22/11/2026 — ₹750.00 taken off what is owed; ₹150.00 not accepted (one pouch was not his); GST on the supplier\'s credit note ₹37.50',
    );
  });

  it('no batch, no expiry, no cost: each says so — never blank, never guessed', () => {
    const page = printLayout({ ...RTS, lines: [{ ...RTS.lines[0]!, batchId: null, expiry: null, rateMinor: null, gstRateBps: null }], supplierReturn: { ...RTS.supplierReturn!, valueSource: 'cost_unknown', note: null } }, 'en');
    expect(page.table.rows[0]).toEqual(['1', 'Sunflower oil 1L (OIL)', '1512', 'No batch named', '6', 'Not on record', 'Not on record', '900.00']);
    expect(page.facts.find((f) => f.label === 'Why it goes back')!.value).toBe('Damaged');
    expect(page.notes.join(' ')).toMatch(/value was typed by the person who returned it/);
    const noExpiry = printLayout({ ...RTS, lines: [{ ...RTS.lines[0]!, expiry: null }] }, 'en');
    expect(noExpiry.table.rows[0]![3]).toBe('B-OLD · expiry not on record');
  });

  it('Tamil prints Tamil words', () => {
    const page = printLayout(RTS, 'ta');
    expect(page.title).toBe('விநியோகஸ்தருக்குத் திருப்பும் குறிப்பு');
    expect(page.facts[0]!.label).toBe('பற்றுக் குறிப்பு');
    expect(page.facts.find((f) => f.value.startsWith('விநியோகஸ்தர் ஏற்க'))).toBeDefined();
    expect(page.signatures).toEqual(['ஒப்படைத்தவர் (கடை)', 'பெற்றவர் (விநியோகஸ்தரின் ஓட்டுநர்)']);
  });

  it('the browser reads it from head office\'s print view for returns, keeps it, and prints the kept copy offline', async () => {
    const kept = new Map<string, string>();
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); } };
    const asked: string[] = [];
    const live = await readPrintView('supplier_return', 'rts-1', (async (url: string) => { asked.push(url); return new Response(JSON.stringify({ view: RTS }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch, storage);
    expect(asked).toEqual(['/v1/documents/print/supplier-returns/rts-1']);
    expect(live.state).toBe('live');
    const off = await readPrintView('supplier_return', 'rts-1', (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch, storage);
    expect(off).toEqual({ state: 'kept', view: RTS });
  });
});
