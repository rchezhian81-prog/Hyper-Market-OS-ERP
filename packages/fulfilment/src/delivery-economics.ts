// What a delivery costs and what it earns — the contribution rule (D09-FR-06 · M19-FR-04 · OB-313), fleet settlement
// (D09-FR-06) and the courier-partner link built switched OFF (OB-294 · D14-FR-04).
//
// ── The contribution rule (OB-313, owner, 23 Oct 2026) ──────────────────────────────────────────────────────────
//
// "Below the owner's threshold, a new order for that slot or zone needs a manager's approval." The threshold is the
// owner's number and shows "not set" until he enters it; while it is not set the rule ONLY FLAGS — the order goes ahead
// and the dispatcher sees it lose money. The arithmetic is the tested `assessContribution` (items margin + delivery fee −
// delivery cost), computed in whole paise. Every input it needs that the shop has not given is said, by name, rather than
// read as a zero: a margin with an unknown cost price, or a delivery cost with no rate, is NOT ASSESSED — never assessed
// as profitable and never held on a guess (P-08).
//
// ── Fleet settlement ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Own drivers only (OB-294). A run is settled at the owner's fleet rate — per drop or per run — computed from the drops
// head office's own stop register holds, never from a figure somebody typed. Approval is a second person.
//
// ── The courier partner ──────────────────────────────────────────────────────────────────────────────────────────
//
// Built and switched OFF (OB-294). The running system composes the switched-off link, which sends nothing anywhere; the
// stand-in exists for tests. Nothing here buys a service or names a provider.
//
// Pure and deterministic.

import { assessContribution, type ContributionResult } from '../../orders/src/fulfilment-plan';

/** The owner's numbers. Every one is absent until he enters it, and shown as "not set". */
export interface DeliveryControls {
  /** D09-FR-05: how far from the stored address a proof may be taken and still be "at the door", in metres. */
  readonly geofenceRadiusMetres?: number;
  /** OB-313: the least a delivery order should contribute, in paise. Below it a new order needs a manager's approval. */
  readonly contributionThresholdMinor?: number;
  /** What one drop costs the shop (driver time, fuel, packing), in paise — feeds the contribution. */
  readonly costPerDropMinor?: number;
  /** What one straight-line kilometre from the store costs, in paise. */
  readonly costPerKmMinor?: number;
  /** D09-FR-06: what the shop settles its own fleet at. */
  readonly fleetRate?: FleetRate;
}

export interface FleetRate {
  readonly basis: 'per_drop' | 'per_run';
  readonly rateMinor: number;
}

export const CONTROL_KEYS = Object.freeze(['geofenceRadiusMetres', 'contributionThresholdMinor', 'costPerDropMinor', 'costPerKmMinor', 'fleetRate'] as const);

/** The delivery cost of one drop at a straight-line distance — or why it cannot be said. */
export function deliveryCostOf(controls: DeliveryControls, distanceMetres: number | undefined): number | 'rates_not_set' | 'no_distance' {
  if (controls.costPerDropMinor === undefined || controls.costPerKmMinor === undefined) return 'rates_not_set';
  if (distanceMetres === undefined) return 'no_distance';
  // Whole paise: the per-km rate times metres, divided once, rounded half up.
  return controls.costPerDropMinor + Math.floor((controls.costPerKmMinor * distanceMetres + 500) / 1000);
}

export type GateOutcome =
  /** Contributes at least the threshold. */
  | 'clear'
  /** The threshold is not set: the rule only flags (OB-313). `assessment.flagged` / `profitable` say what it found. */
  | 'flag_only'
  /** Below the owner's threshold: a manager approves before the order is picked or sent. */
  | 'needs_manager_approval'
  /** An input is missing (cost price, rates, distance) — said by name, never assessed on a guess. */
  | 'not_assessed';

export interface ContributionGate {
  readonly orderId: string;
  readonly outcome: GateOutcome;
  readonly thresholdMinor: number | null;
  readonly assessment: ContributionResult | null;
  /** What was missing, when not assessed. */
  readonly missing: readonly ('cost_price' | 'delivery_rates' | 'distance')[];
  readonly detail: string;
}

/** Judge one delivery order against the owner's contribution rule (OB-313). */
export function contributionGate(input: {
  readonly orderId: string;
  /** Items margin in paise, or undefined when any line's cost price is not known. */
  readonly itemsMarginMinor: number | undefined;
  readonly deliveryFeeMinor: number;
  readonly orderValueMinor: number;
  readonly distanceMetres: number | undefined;
  readonly controls: DeliveryControls;
}): ContributionGate {
  const thresholdMinor = input.controls.contributionThresholdMinor ?? null;
  const cost = deliveryCostOf(input.controls, input.distanceMetres);
  const missing: ('cost_price' | 'delivery_rates' | 'distance')[] = [];
  if (input.itemsMarginMinor === undefined) missing.push('cost_price');
  if (cost === 'rates_not_set') missing.push('delivery_rates');
  if (cost === 'no_distance') missing.push('distance');
  if (missing.length > 0 || typeof cost !== 'number' || input.itemsMarginMinor === undefined) {
    return {
      orderId: input.orderId, outcome: 'not_assessed', thresholdMinor, assessment: null, missing,
      detail: `${input.orderId}: not assessed — ${missing.map((m) => (m === 'cost_price' ? 'a cost price is not known for every line' : m === 'delivery_rates' ? 'the delivery cost rates are not set' : 'the address has no distance on record')).join('; ')}. Nothing is held on a guess.`,
    };
  }
  const assessment = assessContribution({
    orderId: input.orderId, itemsMarginMinor: input.itemsMarginMinor, deliveryFeeChargedMinor: input.deliveryFeeMinor,
    deliveryCostMinor: cost, distanceMetres: input.distanceMetres ?? 0, orderValueMinor: input.orderValueMinor,
  });
  if (thresholdMinor === null) {
    return { orderId: input.orderId, outcome: 'flag_only', thresholdMinor, assessment, missing, detail: `${assessment.detail}. The owner's threshold is not set, so this is a flag only (OB-313).` };
  }
  const below = assessment.contributionMinor < thresholdMinor;
  return {
    orderId: input.orderId, outcome: below ? 'needs_manager_approval' : 'clear', thresholdMinor, assessment, missing,
    detail: below
      ? `${input.orderId} contributes ${assessment.contributionMinor} paise, below the owner's ${thresholdMinor}. A manager must approve it before it is picked or sent (OB-313).`
      : `${input.orderId} contributes ${assessment.contributionMinor} paise, at or above the owner's ${thresholdMinor}.`,
  };
}

/** What a run is settled at, from the drops head office holds — or why it cannot be. */
export function fleetSettlementOf(rate: FleetRate | undefined, drops: number): { readonly amountMinor: number } | 'rate_not_set' | 'no_drops' {
  if (rate === undefined) return 'rate_not_set';
  if (drops <= 0) return 'no_drops';
  return { amountMinor: rate.basis === 'per_drop' ? rate.rateMinor * drops : rate.rateMinor };
}

// ── The courier partner link (OB-294: built, switched OFF) ──────────────────────────────────────────────────────

export interface CourierHandOff {
  readonly orderId: string;
  /** A coarse area label — never the customer's name, number or full address. */
  readonly area: string;
  readonly codMinor: number;
}

export type CourierAnswer =
  | { readonly sent: false; readonly reason: 'link_off'; readonly detail: string }
  | { readonly sent: true; readonly partnerRef: string; readonly partner: string };

export interface CourierPartnerLink {
  readonly name: string;
  readonly on: boolean;
  handOff(job: CourierHandOff): Promise<CourierAnswer>;
}

/** The running system's link: off, sends nothing to anyone. */
export const SWITCHED_OFF_COURIER: CourierPartnerLink = Object.freeze({
  name: 'none',
  on: false,
  handOff: async (): Promise<CourierAnswer> => ({ sent: false, reason: 'link_off', detail: 'No courier partner is connected — own drivers only (OB-294). Nothing was sent.' }),
});

/** A stand-in partner for tests — answers with a made-up reference, talks to nobody. */
export function standInCourier(): CourierPartnerLink & { readonly handed: readonly CourierHandOff[] } {
  const handed: CourierHandOff[] = [];
  return {
    name: 'stand-in', on: true, handed,
    handOff: async (job) => { handed.push(job); return { sent: true, partnerRef: `STANDIN-${handed.length}`, partner: 'stand-in' }; },
  };
}
