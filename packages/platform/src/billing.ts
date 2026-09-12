// Recurring subscription billing: mandates, schedules, GST tax invoices and dunning (WP5, ADR-0014).
//
// This is the money path for selling the product itself — the layer that turns the M36 commercial
// model in `plans.ts` (what a tenant bought) into an actual monthly collection. It is written to the
// same rules as everything else in this package, and two of them decide its whole shape:
//
//   • **NON-PAYMENT NEVER STOPS THE SHOP TRADING.** A missed subscription debit is a *billing*
//     problem between us and the tenant. It may retry, escalate to a person, and switch off
//     *optional* features — it can never close a till (P-01, hard rule #1). `DunningStatus`
//     carries `mayContinueTrading: true` as a **literal type**, exactly like `meterUsage`, so no
//     edit can ever make non-payment stop a sale.
//   • **WE HOLD NO CARD DATA.** A mandate carries opaque provider references only — a customer ref,
//     a subscription ref, a mandate ref — never a number, a code, or a validity date of any
//     instrument (hard rule #3). The provider tokenises; we keep the tokens.
//
// It is also written to India's rules for auto-debit — the RBI Digital Payments e-Mandate
// Framework, 2026: a mandate is set up once with additional-factor authentication (AFA); after that,
// debits **up to ₹15,000** run without a per-charge OTP; a **pre-debit notification** is owed to the
// payer before each debit. Those three facts are encoded below, not left to the provider.
//
// Pure and deterministic: the clock and every amount are injected; no I/O; no provider imports.

import type { FeatureKey } from '../../tenant/src/tenant';

// ---------------------------------------------------------------------------------------------------
// Mandates — the authority to debit, held as references, never as an instrument.
// ---------------------------------------------------------------------------------------------------

/** The rails RBI's e-mandate framework covers. UPI Autopay is primary (cheapest under ₹15,000). */
export type BillingRail = 'upi_autopay' | 'card_emandate' | 'enach';

export type MandateStatus = 'pending' | 'active' | 'paused' | 'revoked' | 'failed';

/**
 * Opaque references to the provider's records. **There is deliberately nowhere here to put an
 * instrument detail** — no number, no code, no validity date — because the safest way to never leak
 * a card is to have no field that could hold one (hard rule #3).
 */
export interface ProviderReference {
  readonly customerRef: string;
  readonly subscriptionRef: string;
  readonly mandateRef: string;
}

export interface Mandate {
  readonly mandateId: string;
  readonly tenantId: string;
  readonly rail: BillingRail;
  readonly providerRef: ProviderReference;
  readonly status: MandateStatus;
  /** The ceiling the payer authorised. A debit above this is refused, never quietly attempted. */
  readonly maxAmountMinor: number;
  /** RBI: the mandate was registered with additional-factor authentication. */
  readonly createdWithAfa: boolean;
  readonly createdAt: string;
}

/** ₹15,000 in paise — RBI's ceiling for a recurring debit that needs no per-charge AFA. */
export const RBI_NO_AFA_CEILING_MINOR = 1_500_000;

export type ChargeGateReason =
  | 'mandate_not_active'
  | 'exceeds_mandate_cap'
  | 'needs_per_charge_afa';

export type ChargeGate =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly reason: ChargeGateReason; readonly detail: string };

/**
 * May this amount be auto-debited on this mandate, right now, without a person?
 *
 * Three ways the answer is no, and each is a different conversation:
 *   • the mandate is not active — set it up (or it was revoked/paused);
 *   • the amount is above the ceiling the payer authorised — get a fresh mandate, do not sneak it;
 *   • the amount is over the RBI no-AFA ceiling — this one debit needs a step-up authentication, so
 *     it is **not** an automatic debit and must not be attempted as one.
 *
 * The normal monthly path returns ok: a plan priced under ₹15,000 debits silently, as intended.
 */
export function assertMandateChargeable(input: {
  readonly mandate: Mandate;
  readonly amountMinor: number;
  /** Override the RBI ceiling only for a test or a future rule change. */
  readonly afaCeilingMinor?: number;
}): ChargeGate {
  const ceiling = input.afaCeilingMinor ?? RBI_NO_AFA_CEILING_MINOR;
  if (input.mandate.status !== 'active') {
    return {
      ok: false,
      reason: 'mandate_not_active',
      detail: `the mandate is ${input.mandate.status}, not active — nothing can be debited until it is set up`,
    };
  }
  if (input.amountMinor > input.mandate.maxAmountMinor) {
    return {
      ok: false,
      reason: 'exceeds_mandate_cap',
      detail: `₹${(input.amountMinor / 100).toFixed(2)} is above the ₹${(input.mandate.maxAmountMinor / 100).toFixed(2)} the payer authorised — a higher debit needs a new mandate, never a quiet attempt`,
    };
  }
  if (input.amountMinor > ceiling) {
    return {
      ok: false,
      reason: 'needs_per_charge_afa',
      detail: `₹${(input.amountMinor / 100).toFixed(2)} is over the ₹${(ceiling / 100).toFixed(2)} no-OTP ceiling — this debit needs a one-time authentication from the payer and cannot run automatically (RBI e-mandate 2026)`,
    };
  }
  return { ok: true, detail: `₹${(input.amountMinor / 100).toFixed(2)} may be debited automatically on this ${input.mandate.rail} mandate` };
}

// ---------------------------------------------------------------------------------------------------
// The recurring schedule — when the next debit falls, and when the payer must be told.
// ---------------------------------------------------------------------------------------------------

export type BillingCadence = 'monthly';

export interface BillingSchedule {
  readonly tenantId: string;
  readonly planId: string;
  readonly cadence: BillingCadence;
  readonly amountMinor: number;
  /** Day of the month to debit. 1–28 only, so no month is ever too short for it. */
  readonly anchorDay: number;
  readonly startsOn: string;
  /** Hours before each debit the payer must be notified (RBI pre-debit notice). */
  readonly preDebitNoticeHours: number;
}

export interface ScheduledCharge {
  readonly chargeOn: string;
  /** The deadline for the pre-debit notification — before this instant, the payer must be told. */
  readonly notifyBy: string;
  readonly amountMinor: number;
  readonly detail: string;
}

/** The next anchor-day date on or after a reference date. anchorDay ≤ 28, so month+1 is always valid. */
function nextAnchorOnOrAfter(referenceIso: string, anchorDay: number): string {
  const ref = new Date(referenceIso);
  const refMidnight = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
  let candidate = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), anchorDay);
  if (candidate < refMidnight) {
    candidate = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, anchorDay);
  }
  return new Date(candidate).toISOString().slice(0, 10);
}

/**
 * When is the next monthly debit, and by when must the payer be warned?
 *
 * The debit never falls before the schedule starts, and the pre-debit notice is computed from the
 * debit, not the other way round — because the notice is the payer's right (RBI), and a schedule
 * that debits first and explains later is exactly the surprise the rule exists to prevent (P-08).
 */
export function nextCharge(input: { readonly schedule: BillingSchedule; readonly asAt: string }): ScheduledCharge {
  const { schedule } = input;
  if (schedule.anchorDay < 1 || schedule.anchorDay > 28) {
    throw new RangeError(`anchorDay must be 1–28 (a day every month has), got ${schedule.anchorDay}`);
  }
  const reference = input.asAt > schedule.startsOn ? input.asAt : schedule.startsOn;
  const chargeOn = nextAnchorOnOrAfter(reference, schedule.anchorDay);
  const chargeTs = Date.parse(`${chargeOn}T00:00:00Z`);
  const notifyBy = new Date(chargeTs - schedule.preDebitNoticeHours * 3_600_000).toISOString();
  return {
    chargeOn,
    notifyBy,
    amountMinor: schedule.amountMinor,
    detail: `₹${(schedule.amountMinor / 100).toFixed(2)} on ${chargeOn}; tell the payer by ${notifyBy}`,
  };
}

// ---------------------------------------------------------------------------------------------------
// GST tax invoice — a compliant Indian tax invoice for each successful debit.
// ---------------------------------------------------------------------------------------------------

/** A GSTIN's first two characters are the state code; a supply within one state splits CGST+SGST. */
export interface GstParty {
  readonly gstin: string;
  readonly name: string;
}

export type SupplyKind = 'intra_state' | 'inter_state';

export interface TaxLine {
  readonly label: 'CGST' | 'SGST' | 'IGST';
  readonly rateBps: number;
  readonly amountMinor: number;
}

export interface TaxInvoiceInput {
  readonly invoiceNumber: string;
  readonly issuedOn: string;
  readonly seller: GstParty;
  readonly buyer: GstParty;
  /** The plan price, exclusive of tax. GST is added on top. Configurable — never invented. */
  readonly taxableValueMinor: number;
  /** GST rate in basis points, e.g. 1800 = 18%. Configuration the owner sets. */
  readonly gstRateBps: number;
  /** SAC (Services Accounting Code) for the SaaS supply. Configuration. */
  readonly sacCode: string;
}

export interface TaxInvoice {
  readonly invoiceNumber: string;
  readonly issuedOn: string;
  readonly sellerGstin: string;
  readonly buyerGstin: string;
  readonly sacCode: string;
  readonly supply: SupplyKind;
  readonly taxableValueMinor: number;
  readonly taxLines: readonly TaxLine[];
  readonly totalTaxMinor: number;
  readonly totalMinor: number;
  readonly detail: string;
}

const GSTIN = /^[0-9]{2}[A-Z0-9]{13}$/;
const stateCodeOf = (gstin: string): string => gstin.slice(0, 2);

/**
 * Compute a GST tax invoice for one subscription charge.
 *
 * The only judgement here is intra- vs inter-state, and it is not a preference: a supply where the
 * seller and buyer are in the same state is CGST + SGST (the rate split in two); across states it is
 * a single IGST at the full rate. Getting it wrong is not a rounding error, it is a wrong tax return.
 *
 * The two halves of an intra-state split are made to **sum to the exact total tax** — CGST takes the
 * floor and SGST the remainder — so a ₹odd amount never loses or gains a paisa between the two lines.
 */
export function computeTaxInvoice(input: TaxInvoiceInput): TaxInvoice {
  for (const party of [input.seller, input.buyer]) {
    if (!GSTIN.test(party.gstin)) {
      throw new RangeError(`${party.name} has an invalid GSTIN "${party.gstin}" — a tax invoice needs a valid 15-character GSTIN`);
    }
  }
  if (input.taxableValueMinor < 0 || !Number.isInteger(input.taxableValueMinor)) {
    throw new RangeError(`taxable value must be a whole, non-negative number of paise, got ${input.taxableValueMinor}`);
  }

  const supply: SupplyKind =
    stateCodeOf(input.seller.gstin) === stateCodeOf(input.buyer.gstin) ? 'intra_state' : 'inter_state';

  const totalTaxMinor = Math.round((input.taxableValueMinor * input.gstRateBps) / 10_000);

  const taxLines: TaxLine[] =
    supply === 'intra_state'
      ? (() => {
          const cgst = Math.floor(totalTaxMinor / 2);
          const sgst = totalTaxMinor - cgst;
          const half = Math.round(input.gstRateBps / 2);
          return [
            { label: 'CGST' as const, rateBps: half, amountMinor: cgst },
            { label: 'SGST' as const, rateBps: input.gstRateBps - half, amountMinor: sgst },
          ];
        })()
      : [{ label: 'IGST' as const, rateBps: input.gstRateBps, amountMinor: totalTaxMinor }];

  return {
    invoiceNumber: input.invoiceNumber,
    issuedOn: input.issuedOn,
    sellerGstin: input.seller.gstin,
    buyerGstin: input.buyer.gstin,
    sacCode: input.sacCode,
    supply,
    taxableValueMinor: input.taxableValueMinor,
    taxLines,
    totalTaxMinor,
    totalMinor: input.taxableValueMinor + totalTaxMinor,
    detail:
      supply === 'intra_state'
        ? `₹${(input.taxableValueMinor / 100).toFixed(2)} + CGST/SGST ₹${(totalTaxMinor / 100).toFixed(2)} = ₹${((input.taxableValueMinor + totalTaxMinor) / 100).toFixed(2)} (SAC ${input.sacCode})`
        : `₹${(input.taxableValueMinor / 100).toFixed(2)} + IGST ₹${(totalTaxMinor / 100).toFixed(2)} = ₹${((input.taxableValueMinor + totalTaxMinor) / 100).toFixed(2)} (SAC ${input.sacCode})`,
  };
}

// ---------------------------------------------------------------------------------------------------
// Dunning — what happens when a debit fails, and the one thing it must never do.
// ---------------------------------------------------------------------------------------------------

export type DunningState = 'current' | 'retrying' | 'past_due' | 'suspended';

export interface DunningStatus {
  readonly tenantId: string;
  readonly state: DunningState;
  readonly failedAttempts: number;
  /** Optional feature grants switched off for non-payment. NEVER core trading. */
  readonly suspendedGrants: readonly FeatureKey[];
  /** ALWAYS true — the whole point. Non-payment cannot close a shop (P-01, hard rule #1). */
  readonly mayContinueTrading: true;
  readonly nextAction: string;
  readonly detail: string;
}

export interface DunningPolicy {
  /** Automatic retries before a human is asked to step in. */
  readonly maxRetries: number;
  /** The optional features that go dark once an account is genuinely delinquent. */
  readonly suspendableGrants: readonly FeatureKey[];
}

export const startDunning = (tenantId: string): DunningStatus => ({
  tenantId,
  state: 'current',
  failedAttempts: 0,
  suspendedGrants: [],
  mayContinueTrading: true,
  nextAction: 'nothing — the account is current',
  detail: 'paid up',
});

/**
 * Advance the dunning state after a debit attempt.
 *
 * A success always returns the account to `current` and **restores every suspended feature** — the
 * customer paid, so the moment we know it, they get everything back. A failure climbs a ladder that
 * is deliberately slow and visible: retry automatically, then ask a person (`past_due`, features
 * still on — a grace so a bank glitch never dims a paying shop), and only then suspend the *optional*
 * features (`suspended`). At no rung does core trading stop; `mayContinueTrading` is typed `true`.
 */
export function onChargeResult(input: {
  readonly previous: DunningStatus;
  readonly outcome: 'succeeded' | 'failed';
  readonly policy: DunningPolicy;
}): DunningStatus {
  const { previous, policy } = input;

  if (input.outcome === 'succeeded') {
    return {
      tenantId: previous.tenantId,
      state: 'current',
      failedAttempts: 0,
      suspendedGrants: [],
      mayContinueTrading: true,
      nextAction: 'nothing — the debit went through and any suspended features are back on',
      detail: previous.suspendedGrants.length > 0 ? 'paid — features restored' : 'paid up',
    };
  }

  const failedAttempts = previous.failedAttempts + 1;

  if (failedAttempts <= policy.maxRetries) {
    return {
      tenantId: previous.tenantId,
      state: 'retrying',
      failedAttempts,
      suspendedGrants: [],
      mayContinueTrading: true,
      nextAction: `retry automatically (attempt ${failedAttempts} of ${policy.maxRetries})`,
      detail: `a debit failed — retrying, nothing switched off, the shop trades normally`,
    };
  }

  if (failedAttempts === policy.maxRetries + 1) {
    return {
      tenantId: previous.tenantId,
      state: 'past_due',
      failedAttempts,
      suspendedGrants: [],
      mayContinueTrading: true,
      nextAction: 'a person contacts the customer — automatic retries are exhausted; features are still on (grace)',
      detail: `past due after ${policy.maxRetries} retries — escalated to a person, still trading, still fully featured`,
    };
  }

  return {
    tenantId: previous.tenantId,
    state: 'suspended',
    failedAttempts,
    suspendedGrants: policy.suspendableGrants,
    mayContinueTrading: true,
    nextAction: 'optional features are suspended pending payment; the POS keeps working',
    detail:
      policy.suspendableGrants.length === 0
        ? `delinquent — nothing to suspend; the shop keeps trading regardless`
        : `delinquent — optional features suspended (${policy.suspendableGrants.join(', ')}); the shop keeps trading`,
  };
}

// ---------------------------------------------------------------------------------------------------
// The subscription as a fold — the append-only history of one tenant's billing, read forward.
// ---------------------------------------------------------------------------------------------------

/**
 * A billing fact. Subscriptions are append-only (hard rule #2): starting a subscription, giving
 * notice, and each charge attempt are separate immutable facts, and the current state is read by
 * folding them — never by overwriting a status column.
 */
export type BillingEvent =
  | {
      readonly kind: 'subscription_started';
      readonly planId: string;
      readonly rail: BillingRail;
      readonly mandate: Mandate;
      readonly schedule: BillingSchedule;
      readonly startedOn: string;
      readonly by: string;
    }
  | { readonly kind: 'subscription_cancelled'; readonly endsOn: string; readonly by: string; readonly at: string }
  | {
      readonly kind: 'charge_recorded';
      readonly outcome: 'succeeded' | 'failed';
      readonly chargeRef: string;
      readonly amountMinor: number;
      readonly at: string;
    };

export interface BillingSnapshot {
  readonly tenantId: string;
  readonly planId: string;
  readonly rail: BillingRail;
  readonly mandate: Mandate;
  readonly schedule: BillingSchedule;
  readonly startedOn: string;
  /** Set once notice is given. Service continues until this date. */
  readonly endsOn?: string;
  readonly dunning: DunningStatus;
  /** The next debit and its pre-debit notice — absent once the subscription has ended. */
  readonly nextCharge?: ScheduledCharge;
  readonly detail: string;
}

/**
 * Read a tenant's current billing state by folding its history.
 *
 * The subscription is the LATEST `subscription_started` (a re-subscribe after a lapse is a new
 * fact, not an edit); a cancellation on or before it is ignored, one after it sets `endsOn`. Dunning
 * is folded from `startDunning` through every charge in order, so the delinquency state is derived,
 * never stored and never guessed. A subscription that has already ended has no next charge.
 *
 * Returns `undefined` when the tenant has never subscribed — a real answer ("not a customer yet"),
 * distinct from any particular state of one who has.
 */
export function foldBilling(input: {
  readonly tenantId: string;
  readonly events: readonly BillingEvent[];
  readonly policy: DunningPolicy;
  readonly asAt: string;
}): BillingSnapshot | undefined {
  let started: Extract<BillingEvent, { kind: 'subscription_started' }> | undefined;
  for (const e of input.events) if (e.kind === 'subscription_started') started = e;
  if (started === undefined) return undefined;

  // Only facts at or after the current subscription start count toward its state.
  const since = input.events.slice(input.events.lastIndexOf(started));

  let endsOn: string | undefined;
  let dunning = startDunning(input.tenantId);
  for (const e of since) {
    if (e.kind === 'subscription_cancelled') endsOn = e.endsOn;
    else if (e.kind === 'charge_recorded') {
      dunning = onChargeResult({ previous: dunning, outcome: e.outcome, policy: input.policy });
    }
  }

  const ended = endsOn !== undefined && input.asAt > endsOn;
  const upcoming = ended ? undefined : nextCharge({ schedule: started.schedule, asAt: input.asAt });

  return {
    tenantId: input.tenantId,
    planId: started.planId,
    rail: started.rail,
    mandate: started.mandate,
    schedule: started.schedule,
    startedOn: started.startedOn,
    endsOn,
    dunning,
    nextCharge: upcoming,
    detail: ended
      ? `subscription ended ${endsOn}`
      : endsOn !== undefined
        ? `on ${started.planId}, ending ${endsOn}; ${dunning.detail}`
        : `on ${started.planId}; ${dunning.detail}`,
  };
}
