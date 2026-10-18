// Reverse charge (RCM) self-invoicing (R3 · A14 · CGST Act s.9(3)/9(4), s.31(3)(f)).
//
// Signed acceptance (OB-188): "for a purchase under a CA-configured RCM head, the system issues a self-invoice from its
// own gap-free series (A2 allocator). The RCM liability is counted as cash-only (never set off against ITC) in GSTR-3B
// Table 3.1(d). The matching ITC appears only after the liability is marked paid. A purchase under a head that is not
// configured raises no RCM. An unregistered supplier with no head configured is listed as an exception."
//
// Owner decision OB-143 "A" (16 Oct 2026, in writing): built now, SWITCHED OFF. The CA fills the list of heads (which
// purchases fall under reverse charge for this shop, at what rate, under which notification entry); the OWNER switches
// it on. Until then the head list is EMPTY and nothing here raises a liability — the GST page says it is switched off.
//
// Which purchases are reverse charge is the CA's call, never this code's: there is no built-in head. Pure.

import { allocateInvoiceNumber, financialYearOf, type InvoiceSeriesState } from '../../numbering/src/invoice-series';
import type { TaxHeads } from './gstr3b';
import type { PlaceOfSupply } from './inclusive-tax';

/** One reverse-charge head the CA configured (e.g. goods transport agency, legal services, security services). */
export interface RcmHead {
  /** A short code the purchase is tagged with (e.g. `GTA`). */
  readonly headCode: string;
  readonly name: string;
  /** The GST rate under reverse charge, basis points. */
  readonly rateBps: number;
  /** The CA's citation — the notification entry it falls under (e.g. "Notfn 13/2017-CT(R) entry 1"). */
  readonly notifiedUnder: string;
}

/** The reverse-charge control as it stands: whether it is on, and the CA's heads. */
export interface RcmControl {
  readonly switchedOn: boolean;
  readonly heads: readonly RcmHead[];
}

/** OB-143: switched off, no heads — the state every shop starts in. */
export const RCM_SWITCHED_OFF: RcmControl = Object.freeze({ switchedOn: false, heads: Object.freeze([]) as readonly RcmHead[] });

export class InvalidRcmInput extends Error {
  constructor(detail: string) {
    super(`Reverse charge: ${detail}`);
    this.name = 'InvalidRcmInput';
  }
}

const HEAD_CODE = /^[A-Z0-9][A-Z0-9_-]{0,15}$/;

/** Check a head the CA sends. @throws InvalidRcmInput naming what is wrong. */
export function validateRcmHead(h: RcmHead): void {
  if (typeof h.headCode !== 'string' || !HEAD_CODE.test(h.headCode)) throw new InvalidRcmInput('headCode must be 1–16 capital letters, digits, "-" or "_"');
  if (typeof h.name !== 'string' || h.name.trim() === '') throw new InvalidRcmInput('a head needs a name');
  if (!Number.isInteger(h.rateBps) || h.rateBps <= 0 || h.rateBps > 2800) throw new InvalidRcmInput('rateBps must be a whole number above 0 and at most 2800 (28%)');
  if (typeof h.notifiedUnder !== 'string' || h.notifiedUnder.trim() === '') throw new InvalidRcmInput('a head needs the notification entry it falls under (the CA\'s citation)');
}

/** An inward supply as recorded for reverse-charge purposes. */
export interface RcmPurchase {
  readonly purchaseId: string;
  readonly supplierId: string;
  /** The supplier's GSTIN from the supplier master; `null` means the supplier is unregistered. */
  readonly supplierGstin: string | null;
  /** The head the purchase is tagged with, if any. */
  readonly headCode?: string;
  /** The date of supply, YYYY-MM-DD. */
  readonly supplyDate: string;
  readonly taxableMinor: number;
  readonly placeOfSupply: PlaceOfSupply;
  readonly description: string;
}

export type RcmDecision =
  /** OB-143: reverse charge is switched off — nothing raised; the page says so. */
  | { readonly kind: 'switched_off'; readonly detail: string }
  /** A configured head: a self-invoice is issued and the tax is a cash liability. */
  | { readonly kind: 'self_invoice'; readonly head: RcmHead; readonly tax: TaxHeads; readonly detail: string }
  /** Not under a configured head: no reverse charge. */
  | { readonly kind: 'no_rcm'; readonly detail: string }
  /** An unregistered supplier with no configured head: no reverse charge, AND listed for a person (the CA). */
  | { readonly kind: 'exception'; readonly reason: 'unregistered_supplier_no_head'; readonly detail: string };

/** Tax at `rateBps` on `taxableMinor`, split by place of supply. CGST and SGST are each half the rate, rounded alike. */
export function reverseChargeTax(taxableMinor: number, rateBps: number, pos: PlaceOfSupply): TaxHeads {
  if (!Number.isInteger(taxableMinor) || taxableMinor <= 0) throw new InvalidRcmInput('taxableMinor must be a whole number of paise above 0');
  if (pos === 'inter_state') return { taxableMinor, cgstMinor: 0, sgstMinor: 0, igstMinor: Math.round((taxableMinor * rateBps) / 10_000) };
  const half = Math.round((taxableMinor * rateBps) / 20_000);
  return { taxableMinor, cgstMinor: half, sgstMinor: half, igstMinor: 0 };
}

/** Decide what a purchase raises under reverse charge. Pure. */
export function decideRcm(purchase: RcmPurchase, control: RcmControl): RcmDecision {
  if (!control.switchedOn) {
    return { kind: 'switched_off', detail: 'reverse charge is switched off (OB-143) — nothing is raised until the CA has listed the heads and the owner switches it on' };
  }
  const head = purchase.headCode === undefined ? undefined : control.heads.find((h) => h.headCode === purchase.headCode);
  if (head !== undefined) {
    return {
      kind: 'self_invoice', head, tax: reverseChargeTax(purchase.taxableMinor, head.rateBps, purchase.placeOfSupply),
      detail: `${head.name} (${head.notifiedUnder}) is a configured reverse-charge head — a self-invoice is issued and the tax is paid in cash`,
    };
  }
  if (purchase.supplierGstin === null) {
    return {
      kind: 'exception', reason: 'unregistered_supplier_no_head',
      detail: `supplier ${purchase.supplierId} is unregistered and the purchase is ${purchase.headCode === undefined ? 'under no head' : `under "${purchase.headCode}", which is not a configured head`} — the CA must say whether reverse charge applies`,
    };
  }
  return { kind: 'no_rcm', detail: purchase.headCode === undefined ? 'no reverse-charge head' : `"${purchase.headCode}" is not a configured reverse-charge head` };
}

// ── the self-invoice series (A2) ────────────────────────────────────────────────────────────────────────────────

/** The self-invoice series prefix: RCM/<FY>/<seq> — 15 characters, inside Rule 46's 16. */
export const RCM_SELF_INVOICE_PREFIX = 'RCM';
export const RCM_SELF_INVOICE_PAD = 6;

/**
 * The next self-invoice number for a supply dated `dateISO`, given the numbers already issued. Gap-free and consecutive
 * within a financial year, resetting each April — the A2 allocator decides; this only reads where the series stands.
 */
export function nextSelfInvoiceNumber(issued: readonly { readonly seq: number; readonly fyCompact: string }[], dateISO: string): { readonly number: string; readonly seq: number; readonly fyCompact: string } {
  const fy = financialYearOf(dateISO).compact;
  const inYear = issued.filter((i) => i.fyCompact === fy).map((i) => i.seq);
  const state: InvoiceSeriesState = { fyCompact: fy, next: inYear.length === 0 ? 1 : Math.max(...inYear) + 1 };
  const alloc = allocateInvoiceNumber(state, { prefix: RCM_SELF_INVOICE_PREFIX, padTo: RCM_SELF_INVOICE_PAD, dateISO });
  return { number: alloc.number, seq: alloc.seq, fyCompact: alloc.financialYear.compact };
}

/** A self-invoice the shop issued to itself for a reverse-charge purchase. */
export interface RcmSelfInvoice {
  readonly number: string;
  readonly seq: number;
  readonly fyCompact: string;
  readonly purchaseId: string;
  readonly supplierId: string;
  readonly headCode: string;
  readonly supplyDate: string;
  readonly tax: TaxHeads;
  readonly issuedBy: string;
  readonly issuedAt: string;
}

/** The cash payment of a self-invoice's tax (a challan) — the ONLY way its ITC becomes available. */
export interface RcmPayment {
  readonly number: string;
  /** The challan reference (CPIN / CIN). */
  readonly challanRef: string;
  readonly paidOn: string;
  readonly paidBy: string;
}

/**
 * The reverse-charge figures GSTR-3B reads for one month (MMYYYY `period`, dates YYYY-MM-DD):
 *   • liability — 3.1(d): every self-invoice whose supply falls in the month;
 *   • itcPaid  — 4(A)(3): the tax of every self-invoice PAID in the month. An unpaid self-invoice gives no ITC.
 */
export function reverseChargeForPeriod(input: {
  readonly from: string; readonly to: string;
  readonly selfInvoices: readonly RcmSelfInvoice[];
  readonly payments: readonly RcmPayment[];
}): { readonly liability: TaxHeads; readonly itcPaid: TaxHeads; readonly unpaid: readonly string[] } {
  const zero: TaxHeads = { taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 };
  const add = (a: TaxHeads, b: TaxHeads): TaxHeads => ({ taxableMinor: a.taxableMinor + b.taxableMinor, cgstMinor: a.cgstMinor + b.cgstMinor, sgstMinor: a.sgstMinor + b.sgstMinor, igstMinor: a.igstMinor + b.igstMinor });
  const paidOn = new Map<string, string>();
  for (const p of input.payments) if (!paidOn.has(p.number)) paidOn.set(p.number, p.paidOn);
  let liability = zero;
  let itcPaid = zero;
  const unpaid: string[] = [];
  for (const s of input.selfInvoices) {
    if (s.supplyDate >= input.from && s.supplyDate <= input.to) {
      liability = add(liability, s.tax);
      if (!paidOn.has(s.number)) unpaid.push(s.number);
    }
    const paid = paidOn.get(s.number);
    if (paid !== undefined && paid >= input.from && paid <= input.to) itcPaid = add(itcPaid, s.tax);
  }
  return { liability, itcPaid, unpaid: unpaid.sort() };
}
