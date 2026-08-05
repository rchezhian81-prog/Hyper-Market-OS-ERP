// API-06 Customer / Loyalty — customers, consent, points, cases.
//
// **Consent is checked at the moment of use, not at the moment of collection** (PRV-03/04, M16).
// A system that records consent once and then trusts every later send is a system where a
// withdrawal three months ago does not stop tomorrow's campaign. So nothing here returns a
// contactable customer: it returns a decision about *this* purpose, now, with the consent that was
// in force when the decision was made.
//
// And **withdrawal is as easy as giving** (PRV-04): there is one function, it takes the same
// shape either way, and there is no extra step on the way out.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';

export type ConsentPurpose = 'transactional' | 'marketing' | 'profiling' | 'third_party';
export type Channel = 'whatsapp' | 'sms' | 'email' | 'push' | 'post';

export interface ConsentRecord {
  readonly customerId: string;
  readonly purpose: ConsentPurpose;
  readonly channel: Channel;
  readonly given: boolean;
  readonly recordedAt: string;
  /** How it was captured or withdrawn — evidence, kept for both directions (PRV-02). */
  readonly evidence: string;
}

export type SendVerdict = 'may_send' | 'must_not_send' | 'no_consent_on_record';

export interface SendDecision {
  readonly customerId: string;
  readonly purpose: ConsentPurpose;
  readonly channel: Channel;
  readonly verdict: SendVerdict;
  /** The record the decision rested on, so it can be defended later. */
  readonly basis?: ConsentRecord;
  readonly decidedAt: string;
  readonly detail: string;
}

/**
 * May we contact this person, for this purpose, on this channel, right now?
 *
 * Transactional messages — "your order is ready" — do not need marketing consent and are not made
 * to wait for it, which is a real distinction rather than a loophole: a customer who bought
 * something is owed the message about the thing they bought.
 *
 * Absence of a record is `no_consent_on_record`, which is **not** the same as consent. Silence
 * has never been agreement anywhere else in this product and it is not agreement here.
 */
export function mayWeSend(input: {
  readonly customerId: string;
  readonly purpose: ConsentPurpose;
  readonly channel: Channel;
  readonly records: readonly ConsentRecord[];
  readonly now: string;
}): SendDecision {
  const base = { customerId: input.customerId, purpose: input.purpose, channel: input.channel, decidedAt: input.now };

  if (input.purpose === 'transactional') {
    return {
      ...base, verdict: 'may_send',
      detail: 'a transactional message about something the customer bought does not wait on marketing consent',
    };
  }

  // The LATEST record wins, whichever way it points. A withdrawal after a grant is a withdrawal.
  const latest = input.records
    .filter((r) => r.customerId === input.customerId && r.purpose === input.purpose && r.channel === input.channel)
    .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))[0];

  if (latest === undefined) {
    return {
      ...base, verdict: 'no_consent_on_record',
      detail: `nothing on record for ${input.purpose} on ${input.channel}. That is not consent — silence has never been agreement anywhere else in this product`,
    };
  }

  return {
    ...base,
    verdict: latest.given ? 'may_send' : 'must_not_send',
    basis: latest,
    detail: latest.given
      ? `consented ${latest.recordedAt} (${latest.evidence})`
      : `withdrawn ${latest.recordedAt} (${latest.evidence}) — a withdrawal after a grant is a withdrawal`,
  };
}

/** Record a grant or a withdrawal. One function, one shape, no extra step on the way out (PRV-04). */
export function recordConsent(input: Omit<ConsentRecord, 'recordedAt'> & { readonly now: string }): ConsentRecord {
  return {
    customerId: input.customerId, purpose: input.purpose, channel: input.channel,
    given: input.given, recordedAt: input.now, evidence: input.evidence,
  };
}

export interface CustomerDeps {
  readonly consentRecords: (tenantId: string, customerId: string) => Promise<readonly ConsentRecord[]> | readonly ConsentRecord[];
  readonly appendConsent: (tenantId: string, r: ConsentRecord) => Promise<void> | void;
  readonly pointsBalance: (tenantId: string, customerId: string) => Promise<number | undefined> | number | undefined;
  readonly now: () => string;
}

export function customerRoutes(deps: CustomerDeps): readonly Route[] {
  return [
    {
      api: 'API-06', method: 'GET', path: '/v1/customers/:customerId/consent',
      permission: 'customer.consent.read',
      handler: async (ctx) => ({
        status: 200,
        body: { records: await deps.consentRecords(ctx.tenantId, ctx.params['customerId'] ?? '') },
      }),
    },
    {
      api: 'API-06', method: 'POST', path: '/v1/customers/:customerId/consent',
      permission: 'customer.consent.write', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Partial<ConsentRecord>;
        if (typeof b.given !== 'boolean' || b.purpose === undefined || b.channel === undefined
          || b.evidence === undefined || b.evidence.trim().length < 5) {
          throw apiError(400, {
            code: 'consent_without_evidence',
            whatHappened: 'A consent record must say the purpose, the channel, which way it went, and how it was captured.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing changed. Send it with the evidence — it is what defends the record later, in both directions.',
          });
        }
        const record = recordConsent({
          customerId: ctx.params['customerId'] ?? '', purpose: b.purpose, channel: b.channel,
          given: b.given, evidence: b.evidence, now: deps.now(),
        });
        await deps.appendConsent(ctx.tenantId, record);
        return { status: 201, body: record };
      },
    },
    {
      api: 'API-06', method: 'GET', path: '/v1/customers/:customerId/may-we-send',
      permission: 'customer.consent.read',
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        return {
          status: 200,
          body: mayWeSend({
            customerId,
            purpose: (ctx.query['purpose'] ?? 'marketing') as ConsentPurpose,
            channel: (ctx.query['channel'] ?? 'email') as Channel,
            records: await deps.consentRecords(ctx.tenantId, customerId),
            now: deps.now(),
          }),
        };
      },
    },
    {
      api: 'API-06', method: 'GET', path: '/v1/customers/:customerId/points',
      permission: 'loyalty.points.read',
      handler: async (ctx) => {
        const balance = await deps.pointsBalance(ctx.tenantId, ctx.params['customerId'] ?? '');
        // Not-known is returned as not-known. A zero balance and an unknown one are different
        // answers to a customer standing at the counter.
        return {
          status: 200,
          body: { pointsBalance: balance, known: balance !== undefined, asAt: deps.now() },
        };
      },
    },
  ];
}
