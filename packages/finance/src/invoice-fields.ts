// Mandatory tax-invoice fields under CGST Rule 46 (roadmap v2.1 A1). A "tax invoice" that is missing a
// mandatory field is not a valid tax invoice — the buyer cannot claim input credit against it and the
// shop can be penalised — so this checks an assembled invoice for every field the rule requires and
// names each one that is absent or malformed, rather than letting a silently-incomplete invoice out.
//
// It validates the fields the acceptance names: the "Tax Invoice" heading, the supplier GSTIN, a
// consecutive invoice number (≤16 characters, Rule 46 form) and its date, the HSN, the taxable value,
// the rate, the CGST+SGST / IGST split matching the place of supply, and the place of supply itself.
// Pure and deterministic — object in, findings out.

import type { PlaceOfSupply } from './inclusive-tax';

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

  if (inv.documentType !== 'Tax Invoice') problems.push('documentType (must be exactly "Tax Invoice")');
  if (typeof inv.supplierGstin !== 'string' || !GSTIN.test(inv.supplierGstin)) problems.push('supplierGstin (a valid 15-character GSTIN)');
  if (typeof inv.invoiceNumber !== 'string' || !INVOICE_NUMBER.test(inv.invoiceNumber)) problems.push('invoiceNumber (≤16 chars, alphanumeric with - or /)');
  if (typeof inv.invoiceDate !== 'string' || !DATE.test(inv.invoiceDate) || Number.isNaN(Date.parse(`${inv.invoiceDate}T00:00:00.000Z`))) problems.push('invoiceDate (YYYY-MM-DD)');
  if (typeof inv.hsnCode !== 'string' || inv.hsnCode.trim() === '') problems.push('hsnCode');
  if (!Number.isInteger(inv.taxableMinor) || (inv.taxableMinor as number) <= 0) problems.push('taxableMinor (a positive amount)');
  if (!Number.isInteger(inv.rateBps) || (inv.rateBps as number) < 0) problems.push('rateBps (the tax rate)');

  const pos = inv.placeOfSupply;
  if (pos !== 'intra_state' && pos !== 'inter_state') {
    problems.push('placeOfSupply (intra_state or inter_state)');
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
