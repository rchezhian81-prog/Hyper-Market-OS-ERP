// Mandatory tax-invoice fields under CGST Rule 46 (roadmap v2.1 A1). A "tax invoice" that is missing a
// mandatory field is not a valid tax invoice — the buyer cannot claim input credit against it and the
// shop can be penalised — so this checks an assembled invoice for every field the rule requires and
// names each one that is absent or malformed, rather than letting a silently-incomplete invoice out.
//
// It validates the fields the acceptance names: the "Tax Invoice" heading, the supplier GSTIN, a
// consecutive invoice number (≤16 characters, Rule 46 form) and its date, the HSN, the taxable value,
// the rate, the CGST+SGST / IGST split matching the place of supply, and the place of supply itself.
// Pure and deterministic — object in, findings out.
//
// OB-278 (owner, 21 Oct 2026) · CGST Rule 46A: a bill to an unregistered buyer that mixes taxed and untaxed (exempt or
// nil-rated) goods is ONE "Invoice-cum-Bill of Supply". The checker takes that heading too, and judges each line by what
// it is: a taxed line (rate above 0) carries the tax split as above; an untaxed line (rate 0) carries NO tax component and
// may stand only on an invoice-cum-bill of supply — on a plain "Tax Invoice" it is a problem, named. A plain "Bill of
// Supply" (Rule 49, untaxed goods only) is not a document this checker passes.

import type { PlaceOfSupply } from './inclusive-tax';

/** The two headings this checker passes: Rule 46's "Tax Invoice", and Rule 46A's combined document (OB-278). */
export const TAX_INVOICE_TITLE = 'Tax Invoice';
export const INVOICE_CUM_BILL_OF_SUPPLY_TITLE = 'Invoice-cum-Bill of Supply';

export interface TaxInvoiceFields {
  readonly documentType?: string;
  readonly supplierGstin?: string;
  readonly invoiceNumber?: string;
  readonly invoiceDate?: string;
  readonly hsnCode?: string;
  readonly taxableMinor?: number;
  readonly rateBps?: number;
  readonly placeOfSupply?: PlaceOfSupply;
  readonly taxComponents?: readonly string[];
}

export interface InvoiceFieldCheck {
  readonly valid: boolean;
  /** Each mandatory field that is missing or malformed, named so it can be fixed. */
  readonly problems: readonly string[];
  readonly detail: string;
}

// A GSTIN is 15 chars: 2-digit state code, 10-char PAN, 1 entity digit/letter, 'Z', 1 checksum char.
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
// Rule 46: an invoice number is up to 16 chars, alphanumeric with '-' and '/', unique per FY.
const INVOICE_NUMBER = /^[0-9A-Za-z/-]{1,16}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Check an assembled tax invoice for the mandatory Rule 46 fields (A1). Returns every missing or
 * malformed field by name; `valid` is true only when the list is empty.
 */
export function checkTaxInvoiceFields(inv: TaxInvoiceFields): InvoiceFieldCheck {
  const problems: string[] = [];

  const combined = inv.documentType === INVOICE_CUM_BILL_OF_SUPPLY_TITLE;
  if (inv.documentType !== TAX_INVOICE_TITLE && !combined) problems.push(`documentType (must be exactly "${TAX_INVOICE_TITLE}", or "${INVOICE_CUM_BILL_OF_SUPPLY_TITLE}" for taxed and untaxed goods together)`);
  if (typeof inv.supplierGstin !== 'string' || !GSTIN.test(inv.supplierGstin)) problems.push('supplierGstin (a valid 15-character GSTIN)');
  if (typeof inv.invoiceNumber !== 'string' || !INVOICE_NUMBER.test(inv.invoiceNumber)) problems.push('invoiceNumber (≤16 chars, alphanumeric with - or /)');
  if (typeof inv.invoiceDate !== 'string' || !DATE.test(inv.invoiceDate) || Number.isNaN(Date.parse(`${inv.invoiceDate}T00:00:00.000Z`))) problems.push('invoiceDate (YYYY-MM-DD)');
  if (typeof inv.hsnCode !== 'string' || inv.hsnCode.trim() === '') problems.push('hsnCode');
  if (!Number.isInteger(inv.taxableMinor) || (inv.taxableMinor as number) <= 0) problems.push('taxableMinor (a positive amount)');
  if (!Number.isInteger(inv.rateBps) || (inv.rateBps as number) < 0) problems.push('rateBps (the tax rate)');

  const pos = inv.placeOfSupply;
  // OB-278: an untaxed (exempt / nil-rated) line — no tax component at all, and only on an invoice-cum-bill of supply.
  const untaxed = inv.rateBps === 0;
  if (pos !== 'intra_state' && pos !== 'inter_state') {
    problems.push('placeOfSupply (intra_state or inter_state)');
  } else if (untaxed) {
    if (!combined) problems.push(`taxComponents (an untaxed line is billed on an "${INVOICE_CUM_BILL_OF_SUPPLY_TITLE}", not a plain "${TAX_INVOICE_TITLE}")`);
    if ((inv.taxComponents ?? []).length > 0) problems.push('taxComponents (an untaxed line carries no CGST, SGST or IGST)');
  } else {
    // The tax split must match the place of supply — an intra-State invoice showing IGST (or vice
    // versa) is wrong, not merely incomplete.
    const comps = new Set((inv.taxComponents ?? []).map((c) => c.toUpperCase()));
    if (pos === 'intra_state') {
      if (!comps.has('CGST') || !comps.has('SGST')) problems.push('taxComponents (an intra-State invoice needs CGST and SGST)');
      if (comps.has('IGST')) problems.push('taxComponents (an intra-State invoice must not carry IGST)');
    } else {
      if (!comps.has('IGST')) problems.push('taxComponents (an inter-State invoice needs IGST)');
      if (comps.has('CGST') || comps.has('SGST')) problems.push('taxComponents (an inter-State invoice must not carry CGST/SGST)');
    }
  }

  return {
    valid: problems.length === 0,
    problems,
    detail: problems.length === 0
      ? 'a valid tax invoice — every mandatory Rule 46 field is present and well-formed'
      : `not a valid tax invoice — ${problems.length} mandatory field(s) missing or malformed`,
  };
}
