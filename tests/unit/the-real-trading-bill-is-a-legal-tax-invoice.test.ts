import { describe, it, expect } from 'vitest';
import {
  buildTaxInvoice, taxInvoiceRows, invoiceRenderProblems, taxInvoiceText, invoiceAmount, invoiceRate, invoiceQuantity, indiaDateTime, invoiceRoundOff,
  UNREGISTERED_RECIPIENT_DETAILS_FROM_MINOR, type TaxInvoiceInput, type TaxInvoiceDocument, type InvoiceRow, type InvoiceField,
} from '../../packages/receipt/src/index';
import { requiredHsnDigits, OWNER_TURNOVER_BAND_FOR_HSN_MINOR, gstStateOf, INVOICE_CUM_BILL_OF_SUPPLY_TITLE } from '../../packages/finance/src/index';

/**
 * **OB-271 · roadmap v2.1 A1 / A2 / A4 / A8 / A9 · CGST Rule 46 — the real-trading bill is a legal GST tax invoice, or it is
 * not issued.** The invoice is built from the committed bill and the shop's legal identity (legal name, address, GSTIN from
 * the store's setup), the A1 checker runs on every line, the HSN has the digits the owner's turnover band needs (OB-149:
 * ₹5–10 crore → 6), an over-the-counter sale splits CGST + SGST with the store's State as the place of supply, and the tax
 * comes out of the MRP to the paisa. THE CONTRACT: a render missing ANY mandatory field fails. Synthetic data only.
 */

const SHOP = { legalName: 'SRE Hyper Market Private Limited', gstin: '33ABCDE1234F1Z5', placeOfBusiness: ['12 Main Road', 'Tiruppur 641601, Tamil Nadu'] };
const LINES: TaxInvoiceInput['lines'] = [
  { description: 'Toor dal 1kg', hsnCode: '071360', quantityMinor: 2, uom: 'ea', unitPriceMinor: 10_500, lineTotalMinor: 21_000, taxRateBps: 500 },
  { description: 'Bath soap 100g', hsnCode: '34011190', quantityMinor: 1, uom: 'ea', unitPriceMinor: 5_900, lineTotalMinor: 5_900, taxRateBps: 1_800 },
  { description: 'துவரம் பருப்பு (loose)', hsnCode: '071360', quantityMinor: 1_250, uom: 'kg', unitPriceMinor: 12_000, lineTotalMinor: 15_000, taxRateBps: 500 },
];
// 20:00 UTC on 21 Oct is 01:30 on 22 Oct in India — the invoice is dated in India time.
const INPUT: TaxInvoiceInput = { identity: SHOP, number: 'L1-000123', committedAt: '2026-10-21T20:00:00.000Z', laneId: 'lane-1', cashierId: 'u-lanecash', lines: LINES, tenders: [{ kind: 'card', amountMinor: 41_900, machineRef: '123456' }] };

const built = (input: TaxInvoiceInput = INPUT): TaxInvoiceDocument => {
  const b = buildTaxInvoice(input);
  if (!b.ok) throw new Error(b.laneMessage);
  return b.doc;
};
const codes = (input: TaxInvoiceInput): string[] => { const b = buildTaxInvoice(input); return b.ok ? [] : b.problems.map((p) => p.code); };

describe('OB-271 — the tax invoice is built from the bill and the shop\'s setup (A1 · A4 · A8 · A9)', () => {
  it('a complete bill: "Tax Invoice", the supplier, number, India date, place of supply, CGST + SGST per rate, to the paisa', () => {
    const doc = built();
    expect(doc.title).toBe('Tax Invoice');
    expect(doc.supplier).toEqual({ ...SHOP, stateCode: '33', stateName: 'Tamil Nadu' });
    expect(doc).toMatchObject({ number: 'L1-000123', date: '2026-10-22', time: '01:30', reverseCharge: false });
    expect(doc.placeOfSupply).toEqual({ kind: 'intra_state', stateCode: '33', stateName: 'Tamil Nadu' });
    // A9: ₹210 at 5% → ₹200.00 + ₹5.00 CGST + ₹5.00 SGST; ₹59 at 18% → ₹50.00 + ₹4.50 + ₹4.50; ₹150 at 5% → ₹142.86 + 3.57 + 3.57.
    expect(doc.lines.map((l) => [l.taxableMinor, l.cgstMinor, l.sgstMinor])).toEqual([[20_000, 500, 500], [5_000, 450, 450], [14_286, 357, 357]]);
    for (const l of doc.lines) expect(l.taxableMinor + l.cgstMinor + l.sgstMinor).toBe(l.lineTotalMinor);
    expect(doc.bands).toEqual([
      { rateBps: 500, taxableMinor: 34_286, cgstMinor: 857, sgstMinor: 857 },
      { rateBps: 1_800, taxableMinor: 5_000, cgstMinor: 450, sgstMinor: 450 },
    ]);
    // OB-279 · A10: the bill's CGST (₹13.07) and SGST (₹13.07) each round to ₹13 — the round off is −14 paise, and the
    // bill's total is the ROUNDED total, which reconciles both ways.
    expect(doc).toMatchObject({ cgstExactMinor: 1_307, sgstExactMinor: 1_307, cgstMinor: 1_300, sgstMinor: 1_300, goodsMinor: 41_900, roundOffMinor: -14, totalMinor: 41_886, untaxedMinor: 0 });
    expect(doc.taxableMinor + doc.untaxedMinor + doc.cgstMinor + doc.sgstMinor).toBe(doc.totalMinor);
    expect(doc.goodsMinor + doc.roundOffMinor).toBe(doc.totalMinor);
  });

  it('OB-279 · A10: each tax component rounds to the nearest rupee — 50 paise and up rounds UP, below rounds down', () => {
    const dal = { description: 'Toor dal 1kg', hsnCode: '071360', quantityMinor: 1, uom: 'ea', unitPriceMinor: 10_500, lineTotalMinor: 10_500, taxRateBps: 500 };
    // ₹105 at 5%: ₹2.50 CGST and ₹2.50 SGST — each 50 paise, so each rounds UP to ₹3; the bill is ₹106.00.
    expect(built({ ...INPUT, lines: [dal] })).toMatchObject({ cgstMinor: 300, sgstMinor: 300, roundOffMinor: 100, totalMinor: 10_600 });
    expect(invoiceRoundOff([{ lineTotalMinor: 10_500, taxRateBps: 500 }])).toEqual({ cgstExactMinor: 250, sgstExactMinor: 250, cgstMinor: 300, sgstMinor: 300, roundOffMinor: 100 });
    // ₹1 at 12%: 5 paise CGST and 6 paise SGST — each below 50, so each rounds DOWN to ₹0; the bill is 89 paise.
    const sweet = built({ ...INPUT, lines: [{ description: 'Sweet', hsnCode: '170490', quantityMinor: 1, uom: 'ea', unitPriceMinor: 100, lineTotalMinor: 100, taxRateBps: 1_200 }] });
    expect(sweet).toMatchObject({ cgstMinor: 0, sgstMinor: 0, roundOffMinor: -11, totalMinor: 89 });
    // ₹10.99 at 18%: ₹0.84 + ₹0.84 → ₹1 + ₹1; the round off is never more than ₹1 either way.
    expect(invoiceRoundOff([{ lineTotalMinor: 1_099, taxRateBps: 1_800 }]).roundOffMinor).toBe(32);
    // What the till is about to charge must be that rounded total, to the paisa.
    expect(codes({ ...INPUT, lines: [dal], totalMinor: 10_500 })).toEqual(['totals']);
    expect(codes({ ...INPUT, lines: [dal], totalMinor: 10_600 })).toEqual([]);
  });

  it('A9 · A8: an odd paisa of tax lands on SGST, never lost — ₹1 at 12% is 89p + 5p CGST + 6p SGST', () => {
    const doc = built({ ...INPUT, lines: [{ description: 'Sweet', hsnCode: '170490', quantityMinor: 1, uom: 'ea', unitPriceMinor: 100, lineTotalMinor: 100, taxRateBps: 1_200 }] });
    expect(doc.lines[0]).toMatchObject({ taxableMinor: 89, cgstMinor: 5, sgstMinor: 6, lineTotalMinor: 100 });
  });

  it('A4 · OB-149: the owner\'s ₹5–10 crore band needs a 6-digit HSN — 4 digits are refused, 6 and 8 are kept', () => {
    expect(requiredHsnDigits(OWNER_TURNOVER_BAND_FOR_HSN_MINOR)).toBe(6);
    expect(codes({ ...INPUT, lines: [{ ...LINES[0]!, hsnCode: '0713' }] })).toEqual(['line_hsn_digits']);
    expect(codes({ ...INPUT, lines: [{ ...LINES[0]!, hsnCode: '071360' }] })).toEqual([]);
    expect(codes({ ...INPUT, lines: [{ ...LINES[0]!, hsnCode: '07136000' }] })).toEqual([]);
    // A tax class that is not an HSN code (letters), or none at all, is refused — never padded.
    expect(codes({ ...INPUT, lines: [{ ...LINES[0]!, hsnCode: 'TC-5' }] })).toEqual(['line_hsn']);
    const { hsnCode: _gone, ...noHsn } = LINES[0]!;
    void _gone;
    expect(codes({ ...INPUT, lines: [noHsn] })).toEqual(['line_hsn']);
  });

  it('the shop\'s setup: no legal name, no address, no or a malformed GSTIN — each refused by name, in words, all at once', () => {
    expect(codes({ ...INPUT, identity: null })).toEqual(expect.arrayContaining(['supplier_legal_name', 'supplier_address', 'supplier_gstin']));
    expect(codes({ ...INPUT, identity: { ...SHOP, legalName: '  ' } })).toEqual(['supplier_legal_name']);
    expect(codes({ ...INPUT, identity: { ...SHOP, placeOfBusiness: [] } })).toEqual(['supplier_address']);
    expect(codes({ ...INPUT, identity: { ...SHOP, gstin: '' } })).toEqual(['supplier_gstin']);
    expect(codes({ ...INPUT, identity: { ...SHOP, gstin: 'NOT-A-GSTIN' } })).toEqual(expect.arrayContaining(['supplier_gstin']));
    const r = buildTaxInvoice({ ...INPUT, identity: { ...SHOP, gstin: '' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.laneMessage).toMatch(/^This bill cannot be issued as a legal tax invoice, so it was NOT saved — do not take money\. the shop's GSTIN is not set up/);
  });

  it('the number (≤16, Rule 46(b)) and the date must read; a line needs a name, a quantity, a unit and a value', () => {
    expect(codes({ ...INPUT, number: 'L1/2026-27/00000123' })).toEqual(['invoice_number']);
    expect(codes({ ...INPUT, committedAt: 'not a time' })).toEqual(['invoice_date']);
    expect(codes({ ...INPUT, lines: [{ ...LINES[0]!, description: '' }] })).toEqual(['line_description']);
    expect(codes({ ...INPUT, lines: [{ ...LINES[0]!, quantityMinor: 0 }] })).toEqual(['line_quantity']);
    expect(codes({ ...INPUT, lines: [{ ...LINES[0]!, uom: '' }] })).toEqual(['line_unit']);
    expect(codes({ ...INPUT, lines: [] })).toEqual(['line_description']);
  });

  it('OB-278 · Rule 46A: any untaxed (exempt / nil) line makes ONE "Invoice-cum-Bill of Supply"; an all-taxed bill stays a "Tax Invoice"', () => {
    const coriander = { description: 'Fresh coriander', hsnCode: '070999', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_000, lineTotalMinor: 1_000, taxRateBps: 0 };
    const doc = built({ ...INPUT, lines: [LINES[0]!, coriander] });
    expect(doc.title).toBe(INVOICE_CUM_BILL_OF_SUPPLY_TITLE);
    expect(doc.lines[1]).toMatchObject({ untaxed: true, rateBps: 0, taxableMinor: 1_000, cgstMinor: 0, sgstMinor: 0 });
    expect(doc).toMatchObject({ taxableMinor: 20_000, untaxedMinor: 1_000, cgstMinor: 500, sgstMinor: 500, roundOffMinor: 0, totalMinor: 22_000 });
    expect(doc.bands.map((b) => b.rateBps)).toEqual([500]); // the untaxed value is not a GST band
    expect(built({ ...INPUT, lines: [coriander] }).title).toBe(INVOICE_CUM_BILL_OF_SUPPLY_TITLE);
    expect(built().title).toBe('Tax Invoice');
    // An untaxed line still needs its HSN code (Rule 49 / 46A).
    expect(codes({ ...INPUT, lines: [{ ...coriander, hsnCode: '' }] })).toEqual(['line_hsn']);
  });

  it('OB-280: a bill of ₹50,000 or more is refused — "bill this on the old system"', () => {
    const veg = { description: 'Vegetables (bulk)', hsnCode: '070999', quantityMinor: 1, uom: 'ea', unitPriceMinor: 0, lineTotalMinor: 0, taxRateBps: 0 };
    expect(codes({ ...INPUT, lines: [{ ...veg, unitPriceMinor: UNREGISTERED_RECIPIENT_DETAILS_FROM_MINOR, lineTotalMinor: UNREGISTERED_RECIPIENT_DETAILS_FROM_MINOR }] })).toEqual(['recipient_details']);
    expect(codes({ ...INPUT, lines: [{ ...veg, unitPriceMinor: UNREGISTERED_RECIPIENT_DETAILS_FROM_MINOR - 1, lineTotalMinor: UNREGISTERED_RECIPIENT_DETAILS_FROM_MINOR - 1 }] })).toEqual([]);
    const r = buildTaxInvoice({ ...INPUT, lines: [{ ...veg, unitPriceMinor: 60_000_00, lineTotalMinor: 60_000_00 }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.laneMessage).toContain('bill this on the old system');
  });

  it('A8: the GSTIN\'s first two digits are the State the sale is supplied in', () => {
    expect(gstStateOf('33ABCDE1234F1Z5')).toEqual({ code: '33', name: 'Tamil Nadu' });
    expect(gstStateOf('32ABCDE1234F1Z5')).toEqual({ code: '32', name: 'Kerala' });
    expect(gstStateOf('00ABCDE1234F1Z5')).toBeUndefined();
    expect(indiaDateTime('2026-10-21T18:29:00.000Z')).toEqual({ date: '2026-10-21', time: '23:59' });
    expect(indiaDateTime('2026-10-21T18:30:00.000Z')).toEqual({ date: '2026-10-22', time: '00:00' });
  });
});

/** Every mandatory field a render must show, and the rows that carry it. */
const MANDATORY: readonly InvoiceField[] = [
  'title', 'supplier_legal_name', 'supplier_address', 'supplier_gstin', 'invoice_number', 'invoice_date', 'place_of_supply',
  'reverse_charge', 'line_description', 'line_hsn', 'line_quantity', 'line_taxable_value', 'line_rate', 'cgst', 'sgst',
  // OB-279: the bill's rounded CGST and SGST, and the round off (this bill's is −14 paise).
  'cgst_total', 'sgst_total', 'round_off', 'total', 'signatory',
];
/** OB-278: a combined bill also shows its untaxed value. */
const COMBINED_MANDATORY: readonly InvoiceField[] = [...MANDATORY.filter((f) => f !== 'round_off'), 'untaxed_total'];
const CORIANDER = { description: 'Fresh coriander', hsnCode: '070999', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_000, lineTotalMinor: 1_000, taxRateBps: 0 };

describe('THE CONTRACT (A1): a render that is missing any field fails', () => {
  const doc = built();

  it('a complete render, in English and in Tamil, shows every mandatory field', () => {
    expect(invoiceRenderProblems(taxInvoiceRows(doc), doc)).toEqual([]);
    expect(invoiceRenderProblems(taxInvoiceRows(doc, { language: 'ta' }), doc)).toEqual([]);
    expect(invoiceRenderProblems(taxInvoiceRows(doc, { duplicate: true }), doc)).toEqual([]);
  });

  it.each(MANDATORY)('without the rows carrying "%s", the render FAILS the contract', (field) => {
    const rows = taxInvoiceRows(doc).filter((r) => !r.fields.includes(field));
    expect(invoiceRenderProblems(rows, doc).length).toBeGreaterThan(0);
  });

  it.each(MANDATORY)('with "%s" printed blank, the render FAILS the contract', (field) => {
    const rows: InvoiceRow[] = taxInvoiceRows(doc).map((r) => (r.fields.includes(field) ? { ...r, text: '', left: '', right: '' } : r));
    expect(invoiceRenderProblems(rows, doc).length).toBeGreaterThan(0);
  });

  it.each(COMBINED_MANDATORY)('OB-278: an invoice-cum-bill of supply without "%s" FAILS the contract', (field) => {
    const combined = built({ ...INPUT, lines: [LINES[0]!, CORIANDER] });
    expect(invoiceRenderProblems(taxInvoiceRows(combined), combined)).toEqual([]);
    expect(invoiceRenderProblems(taxInvoiceRows(combined).filter((r) => !r.fields.includes(field)), combined).length).toBeGreaterThan(0);
  });

  it('OB-278: the wrong heading fails — a plain "Tax Invoice" over an untaxed line, or the combined heading over taxed lines only', () => {
    const combined = built({ ...INPUT, lines: [LINES[0]!, CORIANDER] });
    expect(invoiceRenderProblems(taxInvoiceRows({ ...combined, title: 'Tax Invoice' }), { ...combined, title: 'Tax Invoice' }).length).toBeGreaterThan(0);
    expect(invoiceRenderProblems(taxInvoiceRows({ ...doc, title: INVOICE_CUM_BILL_OF_SUPPLY_TITLE }), { ...doc, title: INVOICE_CUM_BILL_OF_SUPPLY_TITLE }).length).toBeGreaterThan(0);
  });

  it('OB-279: a render whose figures do not add up FAILS — the rounded tax and the values must be the total', () => {
    const wrong = { ...doc, cgstMinor: doc.cgstMinor + 100 };
    expect(invoiceRenderProblems(taxInvoiceRows(wrong), wrong)).toContain('a total that adds up');
  });

  it('a line\'s field printed on ANOTHER line\'s row does not count — each line shows its own', () => {
    const rows = taxInvoiceRows(doc).map((r) => (r.line === 1 && r.fields.includes('line_hsn') ? { ...r, line: 0 } : r));
    expect(invoiceRenderProblems(rows, doc)).toEqual(expect.arrayContaining(['line 2: the HSN code']));
  });

  it('the printed words: "Tax Invoice", GSTIN, HSN per line, "CGST @ 2.5%", the place of supply — and a reprint says DUPLICATE', () => {
    const text = taxInvoiceText(taxInvoiceRows(doc)).join('\n');
    expect(text).toMatch(/^ +Tax Invoice$/m);
    expect(text).toContain('GSTIN: 33ABCDE1234F1Z5');
    expect(text).toContain('Place of supply: Tamil Nadu (33)');
    expect(text).toContain('Tax payable on reverse charge: No');
    expect(text).toMatch(/HSN 071360 · GST 5%/);
    expect(text).toMatch(/^ {2}CGST @ 2\.5% +8\.57$/m);
    expect(text).toMatch(/^ {2}SGST @ 9% +4\.50$/m);
    expect(text).toMatch(/^CGST \(rounded to ₹\) +13\.00$/m);
    expect(text).toMatch(/^SGST \(rounded to ₹\) +13\.00$/m);
    expect(text).toMatch(/^Round off +-0\.14$/m);
    expect(text).toMatch(/^Total \(incl\. GST\) +418\.86$/m);
    expect(text).toContain('Paid: Card (approval 123456)');
    expect(text).not.toContain('DUPLICATE');
    expect(taxInvoiceText(taxInvoiceRows(doc, { duplicate: true })).join('\n')).toContain('DUPLICATE — reprint');
    const ta = taxInvoiceText(taxInvoiceRows(doc, { language: 'ta', duplicate: true })).join('\n');
    expect(ta).toContain('Tax Invoice / வரி விலைப்பட்டியல்');
    expect(ta).toContain('நகல் (DUPLICATE)');
    expect(ta).toContain('வழங்கல் இடம்: Tamil Nadu (33)');
    expect(ta).toContain('துவரம் பருப்பு (loose)');
    // OB-278 in both languages: the combined heading, and an untaxed line shown as exempt / nil with no tax.
    const combined = built({ ...INPUT, lines: [LINES[0]!, CORIANDER] });
    const en = taxInvoiceText(taxInvoiceRows(combined)).join('\n');
    expect(en).toContain('Invoice-cum-Bill of Supply');
    expect(en).toMatch(/HSN 070999 · Exempt \/ nil — no GST +Value 10\.00/);
    expect(en).toMatch(/^Exempt \/ nil-rated value \(no GST\) +10\.00$/m);
    const taCombined = taxInvoiceText(taxInvoiceRows(combined, { language: 'ta' })).join('\n');
    expect(taxInvoiceRows(combined, { language: 'ta' })[0]!.text).toBe('Invoice-cum-Bill of Supply / விலைப்பட்டியல் மற்றும் வழங்கல் பில்');
    expect(taxInvoiceRows(combined, { language: 'ta' }).find((r) => r.line === 1 && r.fields.includes('line_rate'))?.left).toContain('Exempt / nil (விலக்கு / பூஜ்யம்) — GST இல்லை');
    expect(taCombined).toContain('விலக்கு / பூஜ்ய மதிப்பு (GST இல்லை)');
    expect(invoiceRenderProblems(taxInvoiceRows(combined, { language: 'ta' }), combined)).toEqual([]);
    // 58 mm: every line fits 32 columns.
    expect(taxInvoiceText(taxInvoiceRows(doc), 32).every((l) => l.length <= 32)).toBe(true);
  });

  it('amounts, rates and quantities as printed', () => {
    expect(invoiceAmount(41_900)).toBe('419.00');
    expect(invoiceAmount(5)).toBe('0.05');
    expect(invoiceRate(250)).toBe('2.5%');
    expect(invoiceRate(1_800)).toBe('18%');
    expect(invoiceRate(25)).toBe('0.25%');
    expect(invoiceQuantity(2, 'ea')).toBe('2 Nos');
    expect(invoiceQuantity(1_250, 'kg')).toBe('1.250 kg'); // OB-31: weighed goods with their three decimals
    expect(invoiceQuantity(500, 'g')).toBe('500 g');
  });
});
