// GST e-way bill — the document that must accompany a movement of goods (roadmap gap A23, CGST Rules 2017
// Rule 138). Before goods move — a sale delivered, a stock transfer between branches, a return to a
// supplier — an e-way bill must be generated on the government portal when the consignment value crosses a
// threshold, and it carries a validity that runs out by distance. It is the transport twin of the
// e-invoice: same disciplines, different document.
//
// Two thresholds, and they are NOT the same — the single most common way to get this wrong:
//   • **inter-State**: consignment value exceeding **₹50,000** (Rule 138, national).
//   • **intra-State (within Tamil Nadu)**: exceeding **₹1,00,000** (the TN notification raises the floor).
// The exact TN intra-State figure is a value to CONFIRM with the CA before a live run — it is exposed as a
// named constant here, not buried, so a correction is one edit. Getting it wrong in either direction is a
// real cost: too low and every small transfer is blocked for a document it does not need; too high and a
// movement travels illegal.
//
// The disciplines mirror the e-invoice engine deliberately (one shape to learn): eligibility is decided
// here; the Part-A request is built from validated fields; the portal's answer is turned into a record that
// **never fabricates the government's EWB number** (an `unknown`/timeout is its own state, never a silent
// success); validity is computed by distance; and a cancellation is allowed only inside the 24-hour window.
// Pure and deterministic — no clock, no I/O.

// --- thresholds (paise) — CONFIRM the intra-TN figure with the CA before production -------------------
/** Inter-State: an e-way bill is required above ₹50,000 consignment value (Rule 138, national). */
export const EWB_INTER_STATE_THRESHOLD_MINOR = 5_000_000;
/** Intra-Tamil-Nadu: the state notification sets the floor at ₹1,00,000 (CONFIRM with the CA). */
export const EWB_INTRA_STATE_THRESHOLD_MINOR = 10_000_000;

/** How the goods move — the route decides which threshold applies. */
export type SupplyRoute = 'intra_state' | 'inter_state';

/** Why the goods move. Rule 138 applies to far more than a sale — transfers and returns move goods too. */
export type MovementReason =
  | 'supply' // a sale delivered
  | 'stock_transfer' // between the store's own branches / warehouse
  | 'sales_return' // a return going back to a supplier
  | 'job_work'
  | 'import'
  | 'export'
  | 'other';

// --- eligibility -------------------------------------------------------------------------------------

export type EwbEligibilityReason = 'required' | 'below_threshold' | 'exempt_goods' | 'unreadable_value';

export interface EwbEligibilityResult {
  readonly required: boolean;
  readonly reason: EwbEligibilityReason;
  /** The threshold that applied, so a caller can explain the decision. */
  readonly thresholdMinor: number;
  readonly detail: string;
}

/**
 * Is an e-way bill required for this movement? Above the route's threshold (inter-State ₹50k, intra-TN
 * ₹1L), unless the goods are exempt. A value we cannot read is not a licence to skip the law — it fails
 * loud rather than passing quiet. Pure.
 */
export function assessEwayBillRequirement(input: {
  readonly consignmentValueMinor: number;
  readonly supplyRoute: SupplyRoute;
  /** The goods are on the exempt list (the caller determines this from the product; the engine honours it). */
  readonly exemptGoods?: boolean;
}): EwbEligibilityResult {
  const thresholdMinor = input.supplyRoute === 'inter_state'
    ? EWB_INTER_STATE_THRESHOLD_MINOR
    : EWB_INTRA_STATE_THRESHOLD_MINOR;
  if (!Number.isInteger(input.consignmentValueMinor) || input.consignmentValueMinor < 0) {
    return { required: false, reason: 'unreadable_value', thresholdMinor, detail: 'the consignment value is not a whole, non-negative amount — cannot assess the e-way-bill requirement' };
  }
  if (input.exemptGoods === true) {
    return { required: false, reason: 'exempt_goods', thresholdMinor, detail: 'the goods are exempt from the e-way-bill requirement' };
  }
  if (input.consignmentValueMinor > thresholdMinor) {
    return { required: true, reason: 'required', thresholdMinor, detail: `consignment value exceeds the ${input.supplyRoute === 'inter_state' ? 'inter-State ₹50,000' : 'intra-State ₹1,00,000'} threshold — an e-way bill is required before the goods move` };
  }
  return { required: false, reason: 'below_threshold', thresholdMinor, detail: `consignment value is at or below the ${input.supplyRoute === 'inter_state' ? 'inter-State ₹50,000' : 'intra-State ₹1,00,000'} threshold — no e-way bill needed` };
}

// --- validity by distance (Rule 138(10)) -------------------------------------------------------------

export interface EwbValidity {
  readonly validityDays: number;
  /** The last date (YYYY-MM-DD) the e-way bill is valid — it expires at the end of this day. */
  readonly validUpto: string;
  readonly detail: string;
}

const DAY_MS = 86_400_000;

/**
 * The validity of an e-way bill by distance (Rule 138(10)): for regular cargo, up to 200 km is one day and
 * each further 200 km (or part) adds a day; for over-dimensional cargo the slab is 20 km. `generatedOn` is
 * a `YYYY-MM-DD` date; `validUpto` is the last valid day. Pure.
 */
export function ewayBillValidity(input: {
  readonly distanceKm: number;
  readonly generatedOn: string;
  readonly overDimensional?: boolean;
}): EwbValidity {
  if (!Number.isFinite(input.distanceKm) || input.distanceKm < 0) {
    throw new InvalidEwayBillInput(`distanceKm must be a non-negative number, but reads "${input.distanceKm}"`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.generatedOn) || Number.isNaN(Date.parse(input.generatedOn))) {
    throw new InvalidEwayBillInput(`generatedOn must be a date like 2026-08-12, but reads "${input.generatedOn}"`);
  }
  const slabKm = input.overDimensional === true ? 20 : 200;
  const validityDays = Math.max(1, Math.ceil(input.distanceKm / slabKm));
  // validUpto = generation day + (validityDays - 1): a 1-day bill is valid to the end of the generation day.
  const validUpto = new Date(Date.parse(input.generatedOn) + (validityDays - 1) * DAY_MS).toISOString().slice(0, 10);
  return {
    validityDays,
    validUpto,
    detail: `${validityDays} day${validityDays === 1 ? '' : 's'} for ${input.distanceKm} km${input.overDimensional === true ? ' (over-dimensional cargo)' : ''} — valid to end of ${validUpto}`,
  };
}

// --- building the Part-A request ---------------------------------------------------------------------

/** The document types the portal accepts for an e-way bill. */
export type EwbDocType = 'INV' | 'BIL' | 'BOE' | 'CHL' | 'CNT' | 'OTH';

export interface EwayBillRequest {
  readonly supplierGstin: string;
  readonly recipientGstin?: string; // absent for an unregistered consignee (URP)
  readonly documentType: EwbDocType;
  readonly documentNumber: string;
  readonly documentDate: string;
  readonly financialYear: string;
  readonly hsnCode: string;
  readonly consignmentValueMinor: number;
  readonly supplyRoute: SupplyRoute;
  readonly movementReason: MovementReason;
  readonly fromPincode: string;
  readonly toPincode: string;
}

export type EwbBuildOutcome = 'built' | 'not_required' | 'invalid_request';

export interface EwbBuildResult {
  readonly built: boolean;
  readonly outcome: EwbBuildOutcome;
  readonly detail: string;
  readonly request?: EwayBillRequest;
  /** The portal's uniqueness basis (consignor GSTIN + doc type + number + FY) — our idempotency key. */
  readonly idempotencyKey?: string;
}

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PINCODE = /^[1-9][0-9]{5}$/;
const HSN = /^[0-9]{4,8}$/;
const DOCTYPES: ReadonlySet<EwbDocType> = new Set(['INV', 'BIL', 'BOE', 'CHL', 'CNT', 'OTH']);
// An EWB number is the 12-digit number the portal computes and returns. We never compute or invent it.
const EWB_NO = /^[0-9]{12}$/;

export class InvalidEwayBillInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEwayBillInput';
  }
}

/**
 * Build the canonical Part-A e-way-bill request from validated fields — but only if it is eligible AND
 * every mandatory field is present and well-formed. A malformed request must not be sent to the portal; it
 * would be rejected there, and catching it here names the problem instead of burning a submission. Part-B
 * (transporter / vehicle) is added before the goods actually move, not here. Pure.
 */
export function buildEwayBillRequest(input: {
  readonly request: Omit<EwayBillRequest, 'financialYear'> & { readonly financialYear?: string };
  readonly eligibility: EwbEligibilityResult;
}): EwbBuildResult {
  if (!input.eligibility.required) {
    return { built: false, outcome: 'not_required', detail: input.eligibility.detail };
  }
  const r = input.request;
  const problems: string[] = [];
  if (!GSTIN.test(r.supplierGstin)) problems.push('the supplier (consignor) GSTIN is missing or malformed');
  if (r.recipientGstin !== undefined && !GSTIN.test(r.recipientGstin)) problems.push('the recipient GSTIN, if given, must be a valid GSTIN');
  if (!DOCTYPES.has(r.documentType)) problems.push('the document type must be one of INV/BIL/BOE/CHL/CNT/OTH');
  if (typeof r.documentNumber !== 'string' || r.documentNumber.trim() === '') problems.push('the document number is missing');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.documentDate) || Number.isNaN(Date.parse(r.documentDate))) problems.push('the document date must be a date like 2026-08-12');
  if (!HSN.test(r.hsnCode)) problems.push('the HSN code must be 4–8 digits');
  if (!Number.isInteger(r.consignmentValueMinor) || r.consignmentValueMinor <= 0) problems.push('the consignment value must be a positive whole amount');
  if (!PINCODE.test(r.fromPincode)) problems.push('the dispatch (from) pincode must be 6 digits');
  if (!PINCODE.test(r.toPincode)) problems.push('the delivery (to) pincode must be 6 digits');
  if (problems.length > 0) {
    return { built: false, outcome: 'invalid_request', detail: `the e-way-bill request is not valid, so it must not be sent to the portal: ${problems.join('; ')}` };
  }
  const financialYear = r.financialYear ?? financialYearOf(r.documentDate);
  const request: EwayBillRequest = { ...r, financialYear };
  return {
    built: true,
    outcome: 'built',
    detail: 'ready to generate on the e-way-bill portal',
    request,
    idempotencyKey: `${r.supplierGstin}|${r.documentType}|${r.documentNumber}|${financialYear}`,
  };
}

/** The Indian financial year (April–March) label for a date, e.g. 2026-08-12 → "2026-27". */
function financialYearOf(dateStr: string): string {
  const d = new Date(Date.parse(dateStr));
  const y = d.getUTCFullYear();
  const startYear = d.getUTCMonth() >= 3 ? y : y - 1; // April (month 3) starts the FY
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

// --- applying the portal's answer --------------------------------------------------------------------

/** What the e-way-bill portal adapter returns. `unknown` is a first-class answer (a timeout is not "failed"). */
export type EwbResult =
  | { readonly status: 'generated'; readonly ewbNo: string; readonly ewbDate: string; readonly validUpto: string }
  | { readonly status: 'duplicate'; readonly ewbNo: string; readonly validUpto?: string }
  | { readonly status: 'rejected'; readonly errors: readonly string[] }
  | { readonly status: 'unknown'; readonly reason: string };

/** The port a real portal/GSP connector implements — returns `unknown` on a timeout rather than throwing. */
export interface EwayBillProvider {
  generate(request: EwayBillRequest): EwbResult | Promise<EwbResult>;
}

export type EwbState = 'generated' | 'rejected' | 'pending_unknown' | 'provider_error';

export interface EwbRecord {
  readonly movementId: string;
  readonly state: EwbState;
  readonly ewbNo?: string;
  readonly ewbDate?: string;
  readonly validUpto?: string;
  readonly errors?: readonly string[];
  readonly detail: string;
}

/**
 * Turn whatever the portal actually answered into the record to store. A `generated`/`duplicate` outcome is
 * stored only if it carries a well-formed 12-digit EWB number; a malformed one is a `provider_error`, never
 * a stored "generated" — the system will not print a portal number it did not receive. An `unknown` answer
 * is `pending_unknown`: the goods are not covered yet and must not move as though they were. Pure.
 */
export function applyEwbResult(input: { readonly movementId: string; readonly result: EwbResult }): EwbRecord {
  const { movementId, result } = input;
  switch (result.status) {
    case 'generated':
    case 'duplicate': {
      if (!EWB_NO.test(result.ewbNo)) {
        return { movementId, state: 'provider_error', detail: 'the portal response did not carry a well-formed 12-digit e-way-bill number — it is NOT stored as generated (a number we did not receive is never fabricated)' };
      }
      return {
        movementId,
        state: 'generated',
        ewbNo: result.ewbNo,
        ...(result.status === 'generated' ? { ewbDate: result.ewbDate, validUpto: result.validUpto } : (result.validUpto !== undefined ? { validUpto: result.validUpto } : {})),
        detail: result.status === 'duplicate'
          ? 'the portal already held this e-way bill — the existing number was returned (idempotent)'
          : 'generated — e-way-bill number obtained; it must travel with the goods',
      };
    }
    case 'rejected':
      return { movementId, state: 'rejected', errors: result.errors, detail: `the portal rejected the request: ${result.errors.join('; ')}` };
    case 'unknown':
      return { movementId, state: 'pending_unknown', detail: `no clear answer from the portal (${result.reason}) — the e-way-bill status is UNKNOWN until reconciled; the goods must NOT move as covered yet` };
  }
}

// --- cancellation + lifecycle fold -------------------------------------------------------------------

/** Hours an e-way bill may be cancelled within (Rule 138(9)); after that it stands unless rejected in transit. */
export const EWB_CANCEL_WINDOW_HOURS = 24;

/** May a generated e-way bill still be cancelled? Within 24 hours of generation, and not if verified in transit. */
export function assessEwbCancellation(input: {
  readonly generatedAt: string;
  readonly at: string;
  readonly verifiedInTransit?: boolean;
}): { readonly cancellable: boolean; readonly reason: string } {
  if (input.verifiedInTransit === true) {
    return { cancellable: false, reason: 'the e-way bill was verified in transit and can no longer be cancelled' };
  }
  const hours = (Date.parse(input.at) - Date.parse(input.generatedAt)) / 3_600_000;
  if (Number.isNaN(hours) || hours < 0) return { cancellable: false, reason: 'the cancellation time is not after the generation time' };
  if (hours > EWB_CANCEL_WINDOW_HOURS) return { cancellable: false, reason: `an e-way bill may only be cancelled within ${EWB_CANCEL_WINDOW_HOURS} hours of generation — this one is ${Math.floor(hours)}h old` };
  return { cancellable: true, reason: `within the ${EWB_CANCEL_WINDOW_HOURS}-hour cancellation window` };
}

export type EwbLifecycleState = 'generated' | 'rejected' | 'pending_unknown' | 'provider_error' | 'cancelled';

// --- the operator reconciliation queue (item 2) -----------------------------------------------------

/** The operator-facing status category an e-way bill falls into — the exception-queue vocabulary. */
export type EwbQueueCategory = 'generated' | 'rejected' | 'unknown' | 'error' | 'cancelled';

/** Map an e-way-bill lifecycle state to its operator-facing queue category. Pure, total. */
export function ewbQueueCategory(state: EwbLifecycleState): EwbQueueCategory {
  switch (state) {
    case 'generated': return 'generated';
    case 'rejected': return 'rejected';
    case 'pending_unknown': return 'unknown';
    case 'provider_error': return 'error';
    case 'cancelled': return 'cancelled';
  }
}

/**
 * Does this e-way bill need operator attention? An UNKNOWN outcome (awaiting/timeout — poll or reconcile),
 * a provider ERROR (a number that did not verify), or a REJECTION (fix and re-generate). `generated` and
 * `cancelled` are terminal — neither is an exception.
 */
export function isEwbException(state: EwbLifecycleState): boolean {
  return state === 'pending_unknown' || state === 'provider_error' || state === 'rejected';
}

export interface EwbAggregate {
  readonly movementId: string;
  readonly state: EwbLifecycleState;
  readonly request?: EwayBillRequest;
  readonly ewbNo?: string;
  readonly ewbDate?: string;
  readonly validUpto?: string;
  readonly errors?: readonly string[];
  readonly generatedAt?: string;
  readonly cancelledAt?: string;
  readonly cancelReason?: string;
  readonly detail: string;
}

export type EwbEvent =
  | { readonly kind: 'submitted'; readonly request: EwayBillRequest; readonly at: string }
  | { readonly kind: 'response'; readonly record: EwbRecord; readonly at: string }
  | { readonly kind: 'cancelled'; readonly reason: string; readonly at: string };

/** Fold a movement's append-only e-way-bill events into its current state. `undefined` if never submitted. */
export function foldEwayBill(movementId: string, events: readonly EwbEvent[]): EwbAggregate | undefined {
  let agg: EwbAggregate | undefined;
  for (const e of events) {
    if (e.kind === 'submitted') {
      if (agg === undefined) agg = { movementId, state: 'pending_unknown', request: e.request, detail: 'submitted — awaiting the portal' };
    } else if (e.kind === 'response') {
      if (agg === undefined) continue; // a response with no submission is ignored
      if (agg.state === 'generated' || agg.state === 'cancelled') continue; // generated/cancelled is final
      const r = e.record;
      agg = {
        ...agg,
        state: r.state as EwbLifecycleState,
        ...(r.ewbNo !== undefined ? { ewbNo: r.ewbNo } : {}),
        ...(r.ewbDate !== undefined ? { ewbDate: r.ewbDate } : {}),
        ...(r.validUpto !== undefined ? { validUpto: r.validUpto } : {}),
        ...(r.errors !== undefined ? { errors: r.errors } : {}),
        ...(r.state === 'generated' ? { generatedAt: e.at } : {}),
        detail: r.detail,
      };
    } else if (e.kind === 'cancelled') {
      if (agg?.state === 'generated') agg = { ...agg, state: 'cancelled', cancelledAt: e.at, cancelReason: e.reason, detail: `cancelled within the ${EWB_CANCEL_WINDOW_HOURS}h window: ${e.reason}` };
    }
  }
  return agg;
}
