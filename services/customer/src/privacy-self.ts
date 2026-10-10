// API-06 The customer's OWN privacy centre on the cloud (audit FUL-06 · M16-FR-02 / M16-FR-03 · M20-FR-04 · DPDP).
//
// The audit booted the customer app, switched a consent and raised a data request: both answered "done", and a fresh
// boot showed the old consent and no request anywhere — nothing had left the phone. This is the cloud half of that
// hop, scoped to the SIGNED-IN CUSTOMER, never to an id in the request:
//
//   • CONSENT. `POST /v1/me/privacy/consent` appends a grant or a withdrawal to the SAME per-customer consent ledger the
//     campaign send-gate, the notification queue and segmentation read (P-02) — so a withdrawal here excludes the next
//     campaign immediately (M16-FR-02 acceptance). The answer is the ledger READ BACK after the write, never an echo of
//     the request: what the screen then shows is what the shop holds. Both directions cost the same (DPDP s.6(6)).
//   • RIGHTS. `POST /v1/me/privacy/requests/:requestId` raises an access / correction / export / erasure request for
//     the caller, on the SAME append-only request stream the DPO works (`/v1/privacy/data-requests…`), so it appears
//     in the DPO queue at once (M16-FR-03 "requests are self-service"). It is RAISED, not done: verification and
//     fulfilment stay with an authorised officer (the request could be anyone until verified).
//   • READ. `GET /v1/me/privacy` — the caller's own consent position and own requests, nothing else.
//
// Who the customer is comes from the authenticated session (`ctx.userId`, the storefront sign-in, B1); a body that
// names another customer is ignored. A request id that already belongs to someone else is refused without saying
// whose. Every write and refusal is in the kernel's sealed audit trail; the consent ledger and the request stream are
// themselves append-only (hard rule #2). Gated `customer.privacy.self` — held by the `customer` role only.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { DataSubjectRequest, RightKind } from '../../../packages/customer/src/index';
import { mayWeSend, type ConsentRecord, type ConsentPurpose, type Channel } from './index';

const PURPOSES: readonly ConsentPurpose[] = ['transactional', 'marketing', 'profiling', 'third_party'];
const CHANNELS: readonly Channel[] = ['whatsapp', 'sms', 'email', 'push', 'post'];
const KINDS: readonly RightKind[] = ['access', 'correction', 'export', 'erasure'];

export interface PrivacySelfDeps {
  /** The customer's consent ledger — the same record every sender reads (P-02). */
  readonly consentRecords: (tenantId: string, customerId: string) => Promise<readonly ConsentRecord[]> | readonly ConsentRecord[];
  readonly appendConsent: (tenantId: string, r: ConsentRecord) => Promise<void> | void;
  /** Every data-subject request for the tenant (latest state per id) — the DPO's own stream. */
  readonly requests: (tenantId: string) => Promise<readonly DataSubjectRequest[]> | readonly DataSubjectRequest[];
  readonly recordRequest: (tenantId: string, requestId: string, request: DataSubjectRequest, key: string) => Promise<void> | void;
  /** The tenant's answer-by SLA in days (per-tenant policy); 30 when the tenant has set none. */
  readonly slaDays?: (tenantId: string) => Promise<number | undefined> | number | undefined;
  readonly now: () => string;
}

/** One purpose/channel as the ledger holds it NOW — the latest record wins, whichever way it points. */
export interface ConsentPosition {
  readonly purpose: ConsentPurpose;
  readonly channel: Channel;
  readonly granted: boolean;
  readonly recordedAt: string;
}

/** Fold the ledger to the current position per purpose/channel (records arrive in recorded order). */
export function consentPositions(customerId: string, records: readonly ConsentRecord[], now: string): readonly ConsentPosition[] {
  const pairs = new Map<string, { purpose: ConsentPurpose; channel: Channel }>();
  for (const r of records) if (r.customerId === customerId) pairs.set(`${r.purpose}|${r.channel}`, { purpose: r.purpose, channel: r.channel });
  return [...pairs.values()].map(({ purpose, channel }) => {
    // The SAME decision the senders take (mayWeSend), so the screen and the send-gate cannot disagree. Transactional is
    // answered from the record itself (mayWeSend clears transactional for everyone, which is the send rule, not the record).
    const d = mayWeSend({ customerId, purpose, channel, records, now });
    const latest = d.basis ?? [...records].reverse().find((r) => r.customerId === customerId && r.purpose === purpose && r.channel === channel)!;
    return { purpose, channel, granted: purpose === 'transactional' ? latest.given : d.verdict === 'may_send', recordedAt: latest.recordedAt };
  }).sort((a, b) => `${a.purpose}|${a.channel}`.localeCompare(`${b.purpose}|${b.channel}`));
}

function dueDate(nowIso: string, slaDays: number): string {
  const at = new Date(`${nowIso.slice(0, 10)}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + slaDays);
  return at.toISOString().slice(0, 10);
}

/** What the customer is told about a raised request — received, never done; erasure's legal limits said up front. */
export function tellRaised(kind: RightKind, requestId: string, dueBy: string): string {
  return kind === 'erasure'
    ? `We have your request (reference ${requestId}). We must answer by ${dueBy}. We will delete everything we are allowed to delete, and we will tell you exactly what we have to keep and why — invoices and tax records have to be kept by law even when you ask us to delete them.`
    : `We have your request (reference ${requestId}). We must answer by ${dueBy}. Nobody needs to be contacted — this is already with us.`;
}

const mine = (r: DataSubjectRequest) => ({ requestId: r.requestId, kind: r.kind, state: r.state, raisedAt: r.raisedAt, dueBy: r.dueBy });

export function privacySelfRoutes(deps: PrivacySelfDeps): readonly Route[] {
  const readBack = async (tenantId: string, customerId: string) =>
    consentPositions(customerId, await deps.consentRecords(tenantId, customerId), deps.now());
  const myRequests = async (tenantId: string, customerId: string) =>
    (await deps.requests(tenantId)).filter((r) => r.customerRef === customerId).sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));

  return [
    {
      // My privacy position: my consents as the shop holds them, and my requests. Nobody else's.
      api: 'API-06', method: 'GET', path: '/v1/me/privacy',
      permission: 'customer.privacy.self',
      handler: async (ctx) => ({
        status: 200,
        body: {
          customerRef: ctx.userId,
          consent: await readBack(ctx.tenantId, ctx.userId),
          requests: (await myRequests(ctx.tenantId, ctx.userId)).map(mine),
          asAt: deps.now(),
        },
      }),
    },
    {
      // Grant or withdraw — one route, one shape, both directions cost the same. Body: { purpose, channel, given }.
      api: 'API-06', method: 'POST', path: '/v1/me/privacy/consent',
      permission: 'customer.privacy.self', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!PURPOSES.includes(b['purpose'] as ConsentPurpose) || !CHANNELS.includes(b['channel'] as Channel) || typeof b['given'] !== 'boolean') {
          throw apiError(400, {
            code: 'not_readable_as_a_consent_choice',
            whatHappened: `A consent choice needs { purpose (${PURPOSES.join('/')}), channel (${CHANNELS.join('/')}), given (true/false) }.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing changed. Your earlier choice stands.',
          });
        }
        const purpose = b['purpose'] as ConsentPurpose;
        const channel = b['channel'] as Channel;
        if (purpose === 'transactional' && b['given'] === false) {
          // Messages about an order the customer placed are part of the order, not a choice — explained, not hidden.
          throw apiError(409, {
            code: 'required_for_service',
            whatHappened: 'Messages about an order you placed are needed to deliver it, so they cannot be switched off here.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing changed. Marketing messages can be switched off at any time.',
          });
        }
        const record: ConsentRecord = {
          customerId: ctx.userId, purpose, channel, given: b['given'] as boolean, recordedAt: deps.now(),
          // The evidence a regulator asks for: the customer did this themselves, signed in, in the app.
          evidence: `customer self-service in the customer app, signed in as ${ctx.userId}`,
        };
        await deps.appendConsent(ctx.tenantId, record);
        const consent = await readBack(ctx.tenantId, ctx.userId);
        const now = consent.find((c) => c.purpose === purpose && c.channel === channel);
        return {
          status: 201,
          body: {
            saved: true, purpose, channel, granted: now?.granted ?? false, recordedAt: record.recordedAt, consent,
            tellTheCustomer: now?.granted === true
              ? `Saved: we may send you ${purpose} messages by ${channel}. You can switch this off at any time, the same way.`
              : `Saved: we will not send you ${purpose} messages by ${channel}. This took effect now.`,
          },
        };
      },
    },
    {
      // Raise a data-subject request for MYSELF. Body: { kind }. Raised, not verified, not done.
      api: 'API-06', method: 'POST', path: '/v1/me/privacy/requests/:requestId',
      permission: 'customer.privacy.self', idempotent: true,
      handler: async (ctx) => {
        const requestId = (ctx.params['requestId'] ?? '').trim();
        const kind = (ctx.body as { kind?: unknown } | null)?.kind;
        if (!/^[A-Za-z0-9-]{4,64}$/.test(requestId) || !KINDS.includes(kind as RightKind)) {
          throw apiError(400, {
            code: 'not_readable_as_a_data_request',
            whatHappened: 'A request needs a reference (4–64 letters, digits or dashes) in the path and { kind: access/correction/export/erasure }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was raised. Try again from the privacy screen.',
          });
        }
        const existing = (await deps.requests(ctx.tenantId)).find((r) => r.requestId === requestId);
        if (existing !== undefined) {
          if (existing.customerRef !== ctx.userId || existing.kind !== kind) {
            // Never say whose it is — a reference is not a way to learn about another customer.
            throw apiError(409, {
              code: 'request_reference_taken',
              whatHappened: 'That request reference is already in use.',
              wasItSaved: 'not_saved',
              nextSafeAction: 'Nothing was raised. Raise it again; the app picks a new reference.',
            });
          }
          // The same request sent again (a retry after a lost answer): what stands, nothing raised twice.
          return { status: 200, body: { ...mine(existing), alreadyRaised: true, tellTheCustomer: tellRaised(existing.kind, requestId, existing.dueBy) } };
        }
        const now = deps.now();
        const slaDays = (await deps.slaDays?.(ctx.tenantId)) ?? 30;
        const request: DataSubjectRequest = {
          requestId, tenantId: ctx.tenantId, customerRef: ctx.userId, kind: kind as RightKind,
          raisedAt: now, state: 'raised', dueBy: dueDate(now, slaDays),
        };
        await deps.recordRequest(ctx.tenantId, requestId, request, `${requestId}-raised`);
        const stored = (await deps.requests(ctx.tenantId)).find((r) => r.requestId === requestId);
        if (stored === undefined) {
          throw apiError(503, { code: 'request_not_kept', whatHappened: 'The request could not be read back after saving.', wasItSaved: 'unknown', nextSafeAction: 'Try again — the same reference is safe to resend.' });
        }
        return { status: 201, body: { ...mine(stored), tellTheCustomer: tellRaised(stored.kind, requestId, stored.dueBy) } };
      },
    },
  ];
}

/** No store wired (a bare surface): every call refuses honestly — a privacy choice is never answered "saved" unsaved. */
export function privacySelfUnwired(now: () => string): PrivacySelfDeps {
  const refuse = (): never => {
    throw apiError(503, {
      code: 'privacy_store_not_wired',
      whatHappened: 'Head office cannot keep privacy choices here, so nothing was saved.',
      wasItSaved: 'not_saved',
      nextSafeAction: 'Try again later. Your earlier choices stand.',
    });
  };
  return { consentRecords: refuse, appendConsent: refuse, requests: refuse, recordRequest: refuse, now };
}
