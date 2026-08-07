// Versioned APIs, service identities, idempotency and signed webhooks
// (M32-FR-01 / §30 / §31.1 / §35 / hard rules #3, #4).
//
// This is the seam between us and everything outside. Stage 18 built the *authorisation*
// side of it — who may call, on whose behalf, at which version. This is the **request
// handling** side, and it exists because of one number: at-least-once delivery means every
// caller will, eventually, send the same request twice.
//
// A till on a flaky 4G connection retries a sale it already committed. A payment provider
// retries a webhook because our acknowledgement was lost. A partner's cron overlaps itself.
// None of these are bugs at the other end — they are the correct behaviour of a network. The
// bug is ours if the second copy has a second effect.
//
//   • **A REPLAY RETURNS THE FIRST ANSWER, NOT A SECOND EFFECT.** Idempotency is keyed on
//     (tenant, key) and stores the **response**, so the retry gets what the first call got.
//     Returning a fresh 200 with no body is not idempotency — the caller cannot tell whether
//     it worked, so it retries again.
//   • **THE SAME KEY WITH A DIFFERENT BODY IS A CONFLICT, NOT A REPLAY.** That is a caller
//     bug — a key reused across two genuinely different requests — and silently returning the
//     first answer would hide a bug that loses a real transaction.
//   • **A WEBHOOK IS SIGNED AND TIME-BOUND.** An unsigned webhook is an unauthenticated POST
//     from the internet that changes money. A signed one replayed six hours later is the same
//     thing with extra steps, so the timestamp is inside the signature and old ones are
//     refused.
//   • **AN UNSUPPORTED VERSION IS REFUSED CLEANLY**, naming what is supported. A vague 400 is
//     what has a partner developer guessing at midnight.
//
// Pure and deterministic: the clock is injected, the digest is injected, no I/O.

import type { Hasher } from '../../audit/src/audit-trail';

export type ApiVersionStatus = 'current' | 'supported' | 'deprecated' | 'retired';

export interface ApiContract {
  readonly api: string;
  readonly version: string;
  readonly status: ApiVersionStatus;
  readonly sunsetOn?: string;
}

export interface ServiceIdentity {
  readonly identityId: string;
  readonly tenantId: string;
  /** Branch claims. Empty means the whole tenant. */
  readonly branchIds: readonly string[];
  readonly scopes: readonly string[];
  readonly expiresAt: string;
}

export type RequestOutcome =
  | 'accepted'
  | 'replayed'
  | 'idempotency_conflict'
  | 'missing_idempotency_key'
  | 'unsupported_version'
  | 'retired_version'
  | 'scope_missing'
  | 'wrong_tenant'
  | 'branch_not_in_scope'
  | 'identity_expired';

export interface IdempotencyRecord {
  readonly tenantId: string;
  readonly key: string;
  /** Digest of the request body the key was first used with. */
  readonly bodyDigest: string;
  /** The response the first call produced, returned verbatim on a replay. */
  readonly response: unknown;
  readonly at: string;
}

export interface RequestDecision {
  readonly accepted: boolean;
  readonly outcome: RequestOutcome;
  /** Present on a replay: exactly what the first call returned. */
  readonly replayedResponse?: unknown;
  /** Ties the request, its audit rows and its events together (NFR-15). */
  readonly correlationId: string;
  readonly detail: string;
}

/** Deterministic digest of a request body, so a replay can be told from a conflict. */
export function bodyDigest(body: unknown, hasher: Hasher): string {
  return hasher(stableStringify(body));
}

/** JSON with keys sorted, so `{a,b}` and `{b,a}` are the same request. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * Admit or refuse an inbound API write.
 *
 * The whole point is the **replay** path: at-least-once delivery guarantees the same request
 * arrives twice, so the second copy must return the *first answer* rather than produce a
 * second effect. Returning a fresh empty 200 is not idempotency — the caller cannot tell
 * whether it worked and retries again, which is how a duplicate sale reaches a ledger.
 *
 * A **write with no idempotency key is refused** (§31.1). It is tempting to accept one and
 * hope; the shop that pays for that hope is the one whose till resent a ₹4,000 sale.
 */
export function admitRequest(input: {
  readonly api: string;
  readonly requestedVersion: string;
  readonly contracts: readonly ApiContract[];
  readonly identity: ServiceIdentity;
  readonly requiredScope: string;
  readonly tenantId: string;
  readonly branchId?: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly idempotencyKey?: string;
  readonly body?: unknown;
  readonly seen: readonly IdempotencyRecord[];
  readonly hasher: Hasher;
  readonly correlationId: string;
  readonly at: string;
}): RequestDecision {
  const base = { correlationId: input.correlationId };

  if (input.identity.expiresAt < input.at) {
    return { ...base, accepted: false, outcome: 'identity_expired', detail: `this service identity expired at ${input.identity.expiresAt}` };
  }
  if (input.identity.tenantId !== input.tenantId) {
    return {
      ...base,
      accepted: false,
      outcome: 'wrong_tenant',
      detail: `this identity belongs to ${input.identity.tenantId} and the request named ${input.tenantId}`,
    };
  }
  if (
    input.branchId !== undefined &&
    input.identity.branchIds.length > 0 &&
    !input.identity.branchIds.includes(input.branchId)
  ) {
    return {
      ...base,
      accepted: false,
      outcome: 'branch_not_in_scope',
      detail: `this identity carries ${input.identity.branchIds.length} branch claim(s) and ${input.branchId} is not among them`,
    };
  }
  if (!input.identity.scopes.includes(input.requiredScope)) {
    return { ...base, accepted: false, outcome: 'scope_missing', detail: `this identity does not carry "${input.requiredScope}"` };
  }

  const contract = input.contracts.find((c) => c.api === input.api && c.version === input.requestedVersion);
  const live = input.contracts
    .filter((c) => c.api === input.api && c.status !== 'retired')
    .map((c) => c.version)
    .sort();

  if (contract === undefined) {
    return {
      ...base,
      accepted: false,
      outcome: 'unsupported_version',
      detail: `${input.api} has no version ${input.requestedVersion}; supported: ${live.join(', ') || 'none'}`,
    };
  }
  if (contract.status === 'retired') {
    return {
      ...base,
      accepted: false,
      outcome: 'retired_version',
      detail: `${input.api} ${input.requestedVersion} was retired${contract.sunsetOn === undefined ? '' : ` on ${contract.sunsetOn}`}; move to ${live.join(' or ') || 'a supported version'}`,
    };
  }

  const isWrite = input.method !== 'GET';
  if (isWrite && (input.idempotencyKey === undefined || input.idempotencyKey.trim() === '')) {
    return {
      ...base,
      accepted: false,
      outcome: 'missing_idempotency_key',
      detail: 'a write with no Idempotency-Key is refused — accepting one and hoping is how a till that resent a sale puts it in the ledger twice (§31.1)',
    };
  }

  if (isWrite) {
    const digest = bodyDigest(input.body, input.hasher);
    const prior = input.seen.find((r) => r.tenantId === input.tenantId && r.key === input.idempotencyKey);

    if (prior !== undefined) {
      if (prior.bodyDigest !== digest) {
        return {
          ...base,
          accepted: false,
          outcome: 'idempotency_conflict',
          detail: `Idempotency-Key "${input.idempotencyKey}" was already used with a DIFFERENT body — that is a caller bug, and returning the first answer would hide a lost transaction`,
        };
      }
      return {
        ...base,
        accepted: false,
        outcome: 'replayed',
        replayedResponse: prior.response,
        detail: `replay of "${input.idempotencyKey}" — the FIRST answer is returned, with no second effect`,
      };
    }
  }

  return {
    ...base,
    accepted: true,
    outcome: 'accepted',
    detail:
      contract.status === 'deprecated'
        ? `accepted on ${input.api} ${input.requestedVersion}, which is deprecated${contract.sunsetOn === undefined ? '' : ` and sunsets on ${contract.sunsetOn}`}`
        : `accepted on ${input.api} ${input.requestedVersion}`,
  };
}

/** ASCII unit separator. An escape, never a raw byte — see the guardrail in
 *  `tests/guardrails/plain-text-source.test.ts`. */
const FIELD_SEPARATOR = '\u001f';

export interface WebhookEnvelope {
  readonly deliveryId: string;
  readonly event: string;
  readonly tenantId: string;
  readonly payload: unknown;
  readonly sentAt: string;
  readonly signature: string;
}

/**
 * Sign a webhook. The **timestamp is inside the signature**, which is what makes a replay
 * detectable — a signature over the body alone is valid forever, and a captured "payment
 * succeeded" can then be posted back at will.
 */
export function signWebhook(input: {
  readonly deliveryId: string;
  readonly event: string;
  readonly tenantId: string;
  readonly payload: unknown;
  readonly sentAt: string;
  /** Vault REFERENCE to the signing key. Never the key itself (hard rule #4). */
  readonly signingKeyRef: string;
  readonly hasher: Hasher;
}): WebhookEnvelope {
  // Fields are joined with a separator that cannot occur in any of them, written as an ESCAPE
  // rather than a raw byte so the diff stays reviewable (hard rule #8). Concatenating them
  // directly would make the signature AMBIGUOUS: deliveryId "ab" + event "c" and deliveryId
  // "a" + event "bc" would produce identical material and therefore an identical signature,
  // which is a forgery anybody could construct without the key.
  const material = [
    input.deliveryId,
    input.event,
    input.tenantId,
    input.sentAt,
    stableStringify(input.payload),
    input.signingKeyRef,
  ].join(FIELD_SEPARATOR);

  return {
    deliveryId: input.deliveryId,
    event: input.event,
    tenantId: input.tenantId,
    payload: input.payload,
    sentAt: input.sentAt,
    signature: input.hasher(material),
  };
}

export type WebhookVerdict = 'valid' | 'bad_signature' | 'too_old' | 'replayed' | 'wrong_tenant';

export interface WebhookCheck {
  readonly deliveryId: string;
  readonly verdict: WebhookVerdict;
  readonly accepted: boolean;
  /** True when this looks like an attack rather than a late retry. */
  readonly securityEvent: boolean;
  readonly detail: string;
}

/**
 * Verify an inbound webhook.
 *
 * **An unsigned webhook is an unauthenticated POST from the internet that changes money.** A
 * correctly signed one replayed six hours later is the same thing with extra steps, so the
 * age is checked as well as the signature.
 *
 * A **duplicate delivery id is accepted as a replay and not treated as an attack** — providers
 * genuinely retry when our acknowledgement is lost, and calling every retry an attack trains
 * people to ignore the alerts. A *bad signature* is the security event.
 */
export function verifyWebhook(input: {
  readonly envelope: WebhookEnvelope;
  readonly tenantId: string;
  readonly signingKeyRef: string;
  readonly seenDeliveryIds: readonly string[];
  readonly hasher: Hasher;
  /** How old a delivery may be before it is refused. Default 300 (5 minutes). */
  readonly maxAgeSeconds?: number;
  readonly at: string;
}): WebhookCheck {
  const e = input.envelope;
  const base = { deliveryId: e.deliveryId };

  if (e.tenantId !== input.tenantId) {
    return {
      ...base,
      verdict: 'wrong_tenant',
      accepted: false,
      securityEvent: true,
      detail: `this delivery names ${e.tenantId} and arrived on ${input.tenantId}'s endpoint`,
    };
  }

  const expected = signWebhook({
    deliveryId: e.deliveryId, event: e.event, tenantId: e.tenantId,
    payload: e.payload, sentAt: e.sentAt, signingKeyRef: input.signingKeyRef, hasher: input.hasher,
  }).signature;

  if (expected !== e.signature) {
    return {
      ...base,
      verdict: 'bad_signature',
      accepted: false,
      securityEvent: true,
      detail: 'the signature does not match — an unsigned or forged webhook is an unauthenticated POST from the internet that changes money',
    };
  }

  const ageSeconds = Math.round((Date.parse(input.at) - Date.parse(e.sentAt)) / 1_000);
  if (ageSeconds > (input.maxAgeSeconds ?? 300)) {
    return {
      ...base,
      verdict: 'too_old',
      accepted: false,
      // Correctly signed but stale: a captured delivery posted back later.
      securityEvent: true,
      detail: `signed correctly but ${ageSeconds} seconds old — a valid signature replayed hours later is a captured delivery being posted back`,
    };
  }

  if (input.seenDeliveryIds.includes(e.deliveryId)) {
    return {
      ...base,
      verdict: 'replayed',
      accepted: false,
      // Providers genuinely retry when our ack is lost. Not an attack.
      securityEvent: false,
      detail: `${e.deliveryId} has already been processed — the provider retried because our acknowledgement was lost, which is correct behaviour`,
    };
  }

  return { ...base, verdict: 'valid', accepted: true, securityEvent: false, detail: `${e.event} accepted` };
}

export interface DeprecationNotice {
  readonly api: string;
  readonly version: string;
  readonly status: ApiVersionStatus;
  readonly sunsetOn?: string;
  readonly daysRemaining?: number;
  /** Callers still on this version, named. */
  readonly callers: readonly string[];
  readonly detail: string;
}

/**
 * Who is still on a version that is going away.
 *
 * **Named, not counted** — the same rule as `assessCompatibility` in `packages/platform`,
 * for the same reason: a number gets shipped on a Friday and a list of names gets a phone
 * call first.
 */
export function deprecationNotices(input: {
  readonly contracts: readonly ApiContract[];
  /** Which identities called which api/version in the window. */
  readonly usage: readonly { readonly identityId: string; readonly api: string; readonly version: string }[];
  readonly today: string;
}): readonly DeprecationNotice[] {
  return input.contracts
    .filter((c) => c.status === 'deprecated' || c.status === 'retired')
    .map((c): DeprecationNotice => {
      const callers = [
        ...new Set(
          input.usage.filter((u) => u.api === c.api && u.version === c.version).map((u) => u.identityId),
        ),
      ].sort();
      const daysRemaining =
        c.sunsetOn === undefined
          ? undefined
          : Math.floor((Date.parse(`${c.sunsetOn}T00:00:00Z`) - Date.parse(`${input.today}T00:00:00Z`)) / 86_400_000);

      return {
        api: c.api,
        version: c.version,
        status: c.status,
        sunsetOn: c.sunsetOn,
        daysRemaining,
        callers,
        detail:
          callers.length === 0
            ? `${c.api} ${c.version} is ${c.status} and nobody is calling it — safe to remove`
            : `${c.api} ${c.version} is ${c.status}${daysRemaining === undefined ? '' : ` with ${daysRemaining} day(s) left`} and ${callers.join(', ')} still call it — telephone them, do not count them`,
      };
    })
    .sort((a, b) => (a.daysRemaining ?? 9_999) - (b.daysRemaining ?? 9_999) || a.api.localeCompare(b.api));
}
