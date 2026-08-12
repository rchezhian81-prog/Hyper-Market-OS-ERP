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
import { assessPointsMovement, type PointsKind, type StoredPointsMovement } from '../../../packages/loyalty/src/assess-points';
import { assessChildDataProcessing, type ChildDataActivity } from '../../../packages/customer/src/child-data-guard';

const CHILD_DATA_ACTIVITIES: readonly ChildDataActivity[] = [
  'account_enrolment', 'marketing', 'profiling', 'behavioural_tracking', 'targeted_advertising', 'transactional', 'service',
];

/** A points movement as it is persisted — a signed delta, the reason, and where it came from. */
export interface RecordedPointsMovement {
  readonly movementId: string;
  readonly customerId: string;
  readonly delta: number;
  readonly reason: PointsKind;
  readonly sourceRef: string | null;
  readonly at: string;
}

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
  /** Every points movement for a customer, for the burn guard (the balance is their sum). */
  readonly pointsMovements: (tenantId: string, customerId: string) => Promise<readonly StoredPointsMovement[]> | readonly StoredPointsMovement[];
  /** Append a points movement. Idempotent on the movement id. */
  readonly recordPointsMovement: (tenantId: string, customerId: string, m: RecordedPointsMovement) => Promise<void> | void;
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
      // C4 / DPDP s.9 — may we process this person's data for this activity, given their age and whether a
      // parent's consent is on record? A pure decision, commits nothing and stores no child's data: a child
      // (under 18) needs verifiable parental consent for enrolment/marketing/profiling, and tracking or
      // targeted advertising of a child is refused outright (parental consent cannot cure it). Age unproven
      // → a child-restricted activity is refused (it never assumes an adult). Read-only; gated on the same
      // consent-read the enrolling counter staff already hold.
      api: 'API-06', method: 'POST', path: '/v1/customers/child-data/check',
      permission: 'customer.consent.read', idempotent: true,
      handler: (ctx) => {
        const b = (ctx.body ?? {}) as { activity?: unknown; ageYears?: unknown; dateOfBirth?: unknown; parentalConsentVerified?: unknown };
        if (typeof b.activity !== 'string' || !CHILD_DATA_ACTIVITIES.includes(b.activity as ChildDataActivity)) {
          throw apiError(400, {
            code: 'not_readable_as_a_child_data_check',
            whatHappened: 'A child-data check needs an activity — one of account_enrolment, marketing, profiling, behavioural_tracking, targeted_advertising, transactional or service.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing changed. Send the activity (and the age or date of birth) and try again.',
          });
        }
        const decision = assessChildDataProcessing({
          activity: b.activity as ChildDataActivity,
          ...(typeof b.ageYears === 'number' ? { ageYears: b.ageYears } : {}),
          ...(typeof b.dateOfBirth === 'string' ? { dateOfBirth: b.dateOfBirth } : {}),
          ...(b.parentalConsentVerified === true ? { parentalConsentVerified: true } : {}),
          asOf: deps.now(),
        });
        return { status: 200, body: decision };
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
    {
      // Earn, burn or reverse points (M17-FR-01). Points are money-like: the balance is projected
      // from these movements, never stored, and a burn can never take it below zero. The cloud is
      // the authoritative balance across every lane and channel (P-02) — an offline lane's cap is a
      // safeguard, not the truth.
      api: 'API-06', method: 'POST', path: '/v1/customers/:customerId/points',
      permission: 'loyalty.points.write', idempotent: true,
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const b = (ctx.body ?? {}) as { movementId?: unknown; kind?: unknown; points?: unknown; sourceRef?: unknown };
        const kinds: readonly PointsKind[] = ['earn', 'burn', 'reversal'];
        if (typeof b.movementId !== 'string' || b.movementId.trim() === ''
          || typeof b.kind !== 'string' || !kinds.includes(b.kind as PointsKind)
          || typeof b.points !== 'number') {
          throw apiError(400, {
            code: 'not_readable_as_a_points_movement',
            whatHappened: 'A points movement needs a movement id, a kind (earn, burn or reversal) and a whole number of points.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing changed. Send the movement id, the kind and the points, then try again.',
          });
        }

        const request = { movementId: b.movementId, customerId, kind: b.kind as PointsKind, points: b.points };
        const assessment = assessPointsMovement({ priorMovements: await deps.pointsMovements(ctx.tenantId, customerId), request });
        if (!assessment.ok) {
          throw apiError(422, {
            code: assessment.refusedBecause!,
            whatHappened: assessment.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'No points moved. A burn is capped at the balance the customer actually holds.',
          });
        }

        await deps.recordPointsMovement(ctx.tenantId, customerId, {
          movementId: request.movementId, customerId, delta: assessment.delta, reason: request.kind,
          sourceRef: typeof b.sourceRef === 'string' ? b.sourceRef : null, at: deps.now(),
        });
        return { status: 201, body: { movementId: request.movementId, delta: assessment.delta, reason: request.kind, balance: assessment.balanceAfter } };
      },
    },
  ];
}
