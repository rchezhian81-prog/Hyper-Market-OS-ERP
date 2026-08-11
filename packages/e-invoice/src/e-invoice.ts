// GST e-invoicing — IRN + signed QR for B2B invoices (roadmap v2.1 A20). Where the shop's aggregate
// annual turnover is over ₹5 crore, every B2B / export / SEZ invoice and every credit/debit note must be
// registered with the Invoice Registration Portal (IRP), which returns an Invoice Reference Number (IRN)
// and a digitally SIGNED QR that must be printed on the document. B2C is excluded.
//
// This is the deterministic core, and it holds one discipline above all: **the IRN and the QR are the
// government's signature, and this system never fabricates them.** It decides eligibility, builds the
// canonical request, and — given whatever the IRP actually answered — produces the record to store,
// refusing to store a malformed IRN or an empty QR as if it were real. That is the e-invoice equivalent
// of "never store a card number": a forged or absent government signature must never be dressed up as a
// valid one. And, like a payment reversal, an UNKNOWN answer from the IRP is a first-class state — the
// invoice is not e-invoiced until the IRP has actually confirmed it, and pretending otherwise issues a
// legally invalid B2B invoice.
//
// The turnover threshold is the SAME ₹5 crore used for the HSN digit count (A4), imported rather than
// restated so the two cannot drift. Pure and deterministic.

import { HSN_SIX_DIGIT_TURNOVER_THRESHOLD_MINOR, checkTaxInvoiceFields, type TaxInvoiceFields } from '../../finance/src/index';
import { financialYearOf } from '../../numbering/src/index';

/** How the supply is classified for e-invoicing. Only B2C is excluded. */
export type SupplyType = 'b2b' | 'b2c' | 'export' | 'sez' | 'deemed_export';
/** The IRP document types: tax invoice, credit note, debit note. */
export type EInvoiceDocType = 'INV' | 'CRN' | 'DBN';

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
// An IRN is the 64-hex-character hash the IRP computes and returns. We never compute or invent it.
const IRN = /^[0-9a-fA-F]{64}$/;
const NEEDS_RECIPIENT_GSTIN: ReadonlySet<SupplyType> = new Set(['b2b', 'sez', 'deemed_export']);

// --- eligibility ------------------------------------------------------------------

export type EligibilityReason = 'required' | 'below_threshold' | 'b2c_excluded' | 'no_recipient_gstin';

export interface EligibilityResult {
  readonly required: boolean;
  readonly reason: EligibilityReason;
  readonly detail: string;
}

/**
 * Is an IRN mandatory for this document? Over the ₹5 crore threshold AND a registered-buyer supply
 * (B2B / SEZ / deemed-export / export). B2C is excluded, and a "B2B" supply with no valid recipient
 * GSTIN is B2C in substance and treated as excluded rather than sent to the IRP to be rejected.
 */
export function assessEInvoiceEligibility(input: {
  readonly annualTurnoverMinor: number;
  readonly supplyType: SupplyType;
  readonly recipientGstin?: string;
  readonly documentType: EInvoiceDocType;
}): EligibilityResult {
  if (!Number.isInteger(input.annualTurnoverMinor) || input.annualTurnoverMinor < 0) {
    // A turnover we cannot read is not a licence to skip the law — fail loud rather than pass quiet.
    return { required: false, reason: 'below_threshold', detail: 'the annual turnover is not a whole, non-negative amount — cannot assess e-invoicing eligibility' };
  }
  if (input.annualTurnoverMinor <= HSN_SIX_DIGIT_TURNOVER_THRESHOLD_MINOR) {
    return { required: false, reason: 'below_threshold', detail: 'annual aggregate turnover is at or below ₹5 crore — e-invoicing is not mandatory' };
  }
  if (input.supplyType === 'b2c') {
    return { required: false, reason: 'b2c_excluded', detail: 'a B2C supply — e-invoicing excludes B2C' };
  }
  if (NEEDS_RECIPIENT_GSTIN.has(input.supplyType) && (typeof input.recipientGstin !== 'string' || !GSTIN.test(input.recipientGstin))) {
    return { required: false, reason: 'no_recipient_gstin', detail: 'no valid recipient GSTIN — a supply to an unregistered buyer is B2C for e-invoicing' };
  }
  return { required: true, reason: 'required', detail: 'a registered-buyer supply over ₹5 crore — an IRN and signed QR are mandatory (B2C excluded)' };
}

// --- building the IRP request ------------------------------------------------------

export interface IrnRequest {
  readonly supplierGstin: string;
  readonly documentType: EInvoiceDocType;
  readonly documentNumber: string;
  readonly documentDate: string;
  readonly financialYear: string;
  readonly recipientGstin?: string;
  readonly taxableMinor: number;
}

export type BuildOutcome = 'built' | 'not_required' | 'invalid_invoice';

export interface BuildResult {
  readonly built: boolean;
  readonly outcome: BuildOutcome;
  readonly detail: string;
  readonly request?: IrnRequest;
  /** The IRP's own uniqueness basis (supplier GSTIN + doc type + number + FY) — our idempotency key. */
  readonly idempotencyKey?: string;
}

/**
 * Build the canonical IRP request from an assembled tax invoice — but only if it is eligible AND every
 * mandatory Rule 46 field is present. A malformed invoice must NOT be sent to the IRP; it would be
 * rejected there, and catching it here names the missing fields instead of burning a submission.
 */
export function buildIrnRequest(input: {
  readonly invoice: TaxInvoiceFields;
  readonly eligibility: EligibilityResult;
  readonly documentType: EInvoiceDocType;
  readonly recipientGstin?: string;
}): BuildResult {
  if (!input.eligibility.required) {
    return { built: false, outcome: 'not_required', detail: input.eligibility.detail };
  }
  const check = checkTaxInvoiceFields(input.invoice);
  if (!check.valid) {
    return { built: false, outcome: 'invalid_invoice', detail: `the invoice is not Rule-46 valid, so it must not be sent to the IRP: ${check.problems.join('; ')}` };
  }
  const fy = financialYearOf(input.invoice.invoiceDate as string).label;
  const request: IrnRequest = {
    supplierGstin: input.invoice.supplierGstin as string,
    documentType: input.documentType,
    documentNumber: input.invoice.invoiceNumber as string,
    documentDate: input.invoice.invoiceDate as string,
    financialYear: fy,
    ...(typeof input.recipientGstin === 'string' ? { recipientGstin: input.recipientGstin } : {}),
    taxableMinor: input.invoice.taxableMinor as number,
  };
  return {
    built: true,
    outcome: 'built',
    detail: 'ready to register with the IRP',
    request,
    idempotencyKey: `${request.supplierGstin}|${request.documentType}|${request.documentNumber}|${fy}`,
  };
}

// --- applying the IRP's answer -----------------------------------------------------

/** What the IRP adapter returns. `unknown` is a first-class, expected answer (a timeout is not "failed"). */
export type IrpResult =
  | { readonly status: 'registered'; readonly irn: string; readonly signedQr: string; readonly ackNo: string; readonly ackDate: string }
  | { readonly status: 'duplicate'; readonly irn: string; readonly signedQr?: string }
  | { readonly status: 'rejected'; readonly errors: readonly string[] }
  | { readonly status: 'unknown'; readonly reason: string };

/** The port a real GSP/IRP connector implements. A live adapter wraps an async call and returns `unknown`
 *  on a timeout rather than throwing — a thrown timeout is how "unknown" wrongly becomes "failed". */
export interface EInvoiceProvider {
  register(request: IrnRequest): IrpResult | Promise<IrpResult>;
}

export type EInvoiceState = 'registered' | 'rejected' | 'pending_unknown' | 'provider_error';

export interface EInvoiceRecord {
  readonly invoiceId: string;
  readonly state: EInvoiceState;
  readonly irn?: string;
  readonly signedQr?: string;
  readonly ackNo?: string;
  readonly ackDate?: string;
  readonly errors?: readonly string[];
  readonly detail: string;
}

/**
 * Turn whatever the IRP actually answered into the record to store. The one rule that matters: a
 * `registered`/`duplicate` outcome is stored ONLY if it carries a well-formed IRN (and, on a fresh
 * registration, a non-empty signed QR). A malformed IRN or an empty QR is a `provider_error`, never a
 * stored "registered" — the system will not print a government signature it did not actually receive.
 * An `unknown` answer is `pending_unknown`: the invoice is not e-invoiced yet, and must not be treated
 * as though it were.
 */
export function applyIrpResult(input: { readonly invoiceId: string; readonly result: IrpResult }): EInvoiceRecord {
  const { invoiceId, result } = input;
  switch (result.status) {
    case 'registered':
    case 'duplicate': {
      const qrOk = result.status === 'duplicate' || (typeof result.signedQr === 'string' && result.signedQr.trim() !== '');
      if (!IRN.test(result.irn) || !qrOk) {
        return { invoiceId, state: 'provider_error', detail: 'the IRP response did not carry a well-formed IRN and signed QR — it is NOT stored as registered (a signature we did not receive is never fabricated)' };
      }
      return {
        invoiceId,
        state: 'registered',
        irn: result.irn,
        ...(typeof result.signedQr === 'string' && result.signedQr !== '' ? { signedQr: result.signedQr } : {}),
        ...(result.status === 'registered' ? { ackNo: result.ackNo, ackDate: result.ackDate } : {}),
        detail: result.status === 'duplicate'
          ? 'the IRP already held this invoice — the existing IRN was returned (idempotent, no second registration)'
          : 'registered — IRN obtained and signed QR received; print both on the invoice',
      };
    }
    case 'rejected':
      return { invoiceId, state: 'rejected', errors: result.errors, detail: `the IRP rejected the invoice: ${result.errors.join('; ')}` };
    case 'unknown':
      return { invoiceId, state: 'pending_unknown', detail: `no clear answer from the IRP (${result.reason}) — the IRN status is UNKNOWN until reconciled; the invoice must NOT be issued as e-invoiced yet` };
  }
}
