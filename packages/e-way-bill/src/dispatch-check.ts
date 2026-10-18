// May these goods leave? The e-way-bill gate on a dispatch (R3 · A23 remainder · CGST Rules 2017 Rule 138).
//
// Signed sentence: "a dispatch at or below the threshold proceeds. One above it without a `generated` e-way bill is
// refused by name. With one, it proceeds and the movement links to the EWB number." So, for one movement:
//
//   • its consignment value and route decide whether an e-way bill is required — the same `assessEwayBillRequirement`
//     the register uses (inter-State over ₹50,000, intra-Tamil-Nadu over ₹1,00,000);
//   • when the route is not known (a GST registration of either end is not on the organisation), the LOWER, inter-State
//     threshold applies — the gate never assumes the more lenient one (P-08); the answer says why;
//   • required and the movement's e-way bill is `generated` with its 12-digit number: it proceeds, carrying that number;
//   • required and there is none, or it is pending, rejected or cancelled: REFUSED, naming the movement, its value, the
//     threshold and the state of its e-way bill;
//   • lines whose cost head office does not hold are counted out of the value and SAID — the gate never pretends a
//     value is complete.
//
// Pure and deterministic.

import { assessEwayBillRequirement, type SupplyRoute, type EwbLifecycleState } from './e-way-bill';

export type DispatchEwbVerdict =
  | { readonly outcome: 'not_required'; readonly consignmentValueMinor: number; readonly thresholdMinor: number; readonly supplyRoute: SupplyRoute | 'not_known'; readonly unvaluedLines: number; readonly detail: string }
  | { readonly outcome: 'covered'; readonly ewbNo: string; readonly movementId: string; readonly consignmentValueMinor: number; readonly thresholdMinor: number; readonly supplyRoute: SupplyRoute | 'not_known'; readonly unvaluedLines: number; readonly detail: string }
  | { readonly outcome: 'refused'; readonly code: 'ewb_required'; readonly movementId: string; readonly consignmentValueMinor: number; readonly thresholdMinor: number; readonly supplyRoute: SupplyRoute | 'not_known'; readonly ewbState: EwbLifecycleState | 'none'; readonly detail: string };

const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The route between two GST state codes; `not_known` when either is missing. */
export function supplyRouteBetween(fromStateCode: string | null, toStateCode: string | null): SupplyRoute | 'not_known' {
  if (fromStateCode === null || toStateCode === null || fromStateCode === '' || toStateCode === '') return 'not_known';
  return fromStateCode === toStateCode ? 'intra_state' : 'inter_state';
}

export function checkDispatchEwb(input: {
  /** The e-way-bill register's movement this dispatch is generated under. */
  readonly movementId: string;
  /** The value of the lines head office holds a cost for, in paise. */
  readonly consignmentValueMinor: number;
  /** Lines whose cost is not held — left out of the value, and said. */
  readonly unvaluedLines: number;
  readonly supplyRoute: SupplyRoute | 'not_known';
  /** The movement's e-way bill as the register folds it; undefined when none was ever submitted. */
  readonly ewb: { readonly state: EwbLifecycleState; readonly ewbNo?: string } | undefined;
}): DispatchEwbVerdict {
  const route = input.supplyRoute;
  const assessed = assessEwayBillRequirement({ consignmentValueMinor: input.consignmentValueMinor, supplyRoute: route === 'not_known' ? 'inter_state' : route });
  const routeWords = route === 'not_known' ? ' (the GST state of one end is not known, so the lower inter-State threshold applies)' : '';
  const unvalued = input.unvaluedLines > 0 ? `; ${input.unvaluedLines} line(s) have no cost on record and are not in the value` : '';
  const base = { consignmentValueMinor: input.consignmentValueMinor, thresholdMinor: assessed.thresholdMinor, supplyRoute: route };
  if (!assessed.required) {
    return { outcome: 'not_required', ...base, unvaluedLines: input.unvaluedLines, detail: `${rupees(input.consignmentValueMinor)} is at or below the ${rupees(assessed.thresholdMinor)} threshold${routeWords} — no e-way bill needed${unvalued}` };
  }
  if (input.ewb?.state === 'generated' && typeof input.ewb.ewbNo === 'string' && /^[0-9]{12}$/.test(input.ewb.ewbNo)) {
    return { outcome: 'covered', ewbNo: input.ewb.ewbNo, movementId: input.movementId, ...base, unvaluedLines: input.unvaluedLines, detail: `covered by e-way bill ${input.ewb.ewbNo}${unvalued}` };
  }
  const state = input.ewb?.state ?? 'none';
  const why = state === 'none' ? 'no e-way bill has been generated for it' : `its e-way bill is ${state.replace(/_/g, ' ')}, not generated`;
  return {
    outcome: 'refused', code: 'ewb_required', movementId: input.movementId, ...base, ewbState: state,
    detail: `movement ${input.movementId} is worth ${rupees(input.consignmentValueMinor)}, above the ${rupees(assessed.thresholdMinor)} threshold${routeWords}, and ${why}${unvalued}`,
  };
}
