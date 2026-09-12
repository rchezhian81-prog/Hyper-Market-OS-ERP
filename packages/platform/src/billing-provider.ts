// The recurring-billing provider port, and the SANDBOX implementation used until the owner is a
// live merchant (WP5, ADR-0014).
//
// The whole point of this interface is that **the domain never imports a provider**. Everything that
// is regulated or has to be right — the schedule, the RBI ceilings, the GST invoice, the dunning
// ladder — lives in `billing.ts` and is tested without a network. A provider only does the two
// things a provider must: set up a mandate with the payer's bank/UPI app, and tell us whether a
// debit went through. Swapping Razorpay for another provider is a second implementation of this
// interface, not a change to a single rule.
//
// `SandboxRecurringBillingProvider` is a real runtime mode, not a test double: ADR-0014 says the
// system runs in sandbox until a live Razorpay merchant account + KYC exist, so this is what the
// product legitimately runs on today. It moves no money and reaches no network — it deterministically
// stands in for the provider so the whole funnel can be exercised end-to-end before go-live.

import { createHash } from 'node:crypto';
import {
  RBI_NO_AFA_CEILING_MINOR,
  type BillingRail,
  type BillingSchedule,
  type Mandate,
  type ProviderReference,
} from './billing';
import type { Plan } from './plans';

export interface CreateSubscriptionInput {
  readonly tenantId: string;
  readonly plan: Plan;
  readonly rail: BillingRail;
  /** Day of the month to debit (1–28). */
  readonly anchorDay: number;
  readonly startsOn: string;
  readonly preDebitNoticeHours: number;
}

export interface CreatedSubscription {
  readonly providerRef: ProviderReference;
  readonly mandate: Mandate;
  readonly schedule: BillingSchedule;
  /** Where the payer completes mandate authorisation (AFA). Sandbox returns a non-live placeholder. */
  readonly authorisationUrl: string;
}

/**
 * A normalised charge outcome — the provider maps its own event shape onto this. `tenantId` is the
 * reference we attach when creating the subscription and the provider echoes back on every event, so
 * a webhook is attributed to the right tenant without a cross-tenant lookup (§35).
 */
export interface ProviderChargeEvent {
  readonly tenantId: string;
  readonly subscriptionRef: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly chargeRef: string;
  readonly amountMinor: number;
  readonly at: string;
}

export interface RecurringBillingProvider {
  readonly mode: 'sandbox' | 'live';
  createSubscription(input: CreateSubscriptionInput): Promise<CreatedSubscription>;
  cancelSubscription(input: { readonly providerRef: ProviderReference; readonly at: string }): Promise<void>;
  /** True when the inbound webhook is genuinely from the provider. */
  verifyWebhook(input: { readonly rawBody: string; readonly signature: string }): boolean;
  /** Normalise a verified webhook body into a charge outcome, or `undefined` if it is not one. */
  parseChargeEvent(rawBody: string): ProviderChargeEvent | undefined;
}

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The signature the sandbox expects — a plain digest of the body (a live provider signs with HMAC). */
export const sandboxSignature = (rawBody: string): string => `sandbox:${sha256Hex(rawBody)}`;

export class SandboxRecurringBillingProvider implements RecurringBillingProvider {
  readonly mode = 'sandbox' as const;

  async createSubscription(input: CreateSubscriptionInput): Promise<CreatedSubscription> {
    const ref = sha256Hex(`${input.tenantId}:${input.plan.planId}:${input.rail}`).slice(0, 16);
    const providerRef: ProviderReference = {
      customerRef: `sbx_cust_${sha256Hex(input.tenantId).slice(0, 12)}`,
      subscriptionRef: `sbx_sub_${ref}`,
      mandateRef: `sbx_umn_${ref}`,
    };
    // Authorise up to the RBI no-OTP ceiling (or the plan price if higher), so the monthly debit and
    // modest overage run automatically while anything unusual still trips the per-charge AFA gate.
    const maxAmountMinor = Math.max(input.plan.monthlyPriceMinor, RBI_NO_AFA_CEILING_MINOR);
    const mandate: Mandate = {
      mandateId: `mnd_${ref}`,
      tenantId: input.tenantId,
      rail: input.rail,
      providerRef,
      // The sandbox stands in for a payer who has completed AFA on their bank/UPI app.
      status: 'active',
      maxAmountMinor,
      createdWithAfa: true,
      createdAt: input.startsOn,
    };
    const schedule: BillingSchedule = {
      tenantId: input.tenantId,
      planId: input.plan.planId,
      cadence: 'monthly',
      amountMinor: input.plan.monthlyPriceMinor,
      anchorDay: input.anchorDay,
      startsOn: input.startsOn,
      preDebitNoticeHours: input.preDebitNoticeHours,
    };
    return { providerRef, mandate, schedule, authorisationUrl: `sandbox://mandate/${providerRef.mandateRef}` };
  }

  async cancelSubscription(): Promise<void> {
    // Nothing to call in sandbox — the cancellation fact is recorded by the caller in the ledger.
  }

  verifyWebhook(input: { readonly rawBody: string; readonly signature: string }): boolean {
    return input.signature === sandboxSignature(input.rawBody);
  }

  parseChargeEvent(rawBody: string): ProviderChargeEvent | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const e = parsed as Record<string, unknown>;
    const outcome = e['outcome'];
    if (
      typeof e['tenantId'] !== 'string' ||
      typeof e['subscriptionRef'] !== 'string' ||
      typeof e['chargeRef'] !== 'string' ||
      typeof e['amountMinor'] !== 'number' ||
      typeof e['at'] !== 'string' ||
      (outcome !== 'succeeded' && outcome !== 'failed')
    ) {
      return undefined;
    }
    return {
      tenantId: e['tenantId'],
      subscriptionRef: e['subscriptionRef'],
      outcome,
      chargeRef: e['chargeRef'],
      amountMinor: e['amountMinor'],
      at: e['at'],
    };
  }
}
