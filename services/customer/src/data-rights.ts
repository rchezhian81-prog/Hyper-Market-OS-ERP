// API-06 Data-subject rights (M20-FR-04 / M16-FR-03 · PRV · DPDP) — the controller-side lifecycle on
// the cloud. The customer app's privacy centre RAISES a request (screen-side, no staff, QG-02); this is
// where the shop then works it: verify who asked, fulfil it, and — for an erasure — produce the honest
// plan that erases what it can, keeps what the law requires, and TELLS the customer exactly which and why.
//
// Two absolutes carried from the tested engine, not re-implemented here:
//   • A REQUEST IS VERIFIED BEFORE IT IS FULFILLED. An unverified erasure deletes someone else's account;
//     an unverified access request hands over their shopping history. The verification gate is first.
//   • AUDIT EVIDENCE IS NEVER DELETED (hard rule #6). An erasure produces a plan (erase / minimise /
//     retain), never a blind deletion — the retained categories are named with the law that keeps them.
//
// The rules are `planErasure` / `fulfilRequest` / `overdueRequests` in `@sre/customer` (the
// services-run-on-their-tested-engine guardrail). The request lifecycle is append-only and event-sourced,
// so an auditor later reads exactly what was asked, when it was verified, and what was done. Gated
// `privacy.request.manage`.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  planErasure, fulfilRequest, overdueRequests, mayNomineeAct, currentNominee, RIGHT_KINDS, PUBLISHED_RESPONSE_SLA_DAYS, ACTIVATION_BASES,
  type DataSubjectRequest, type RightKind, type RetentionBasis, type DataCategory, type FulfilmentRefusal,
  type NomineeRecord, type NomineeActivation, type ActivationBasis,
} from '../../../packages/customer/src/index';
import { shopDateIn, shopToday, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

export type { DataSubjectRequest } from '../../../packages/customer/src/index';

// R3 · C5: a grievance is a request kind of its own, with the same published answer-by time.
const KINDS: readonly RightKind[] = RIGHT_KINDS;
const BASES: readonly RetentionBasis[] = ['tax_invoice', 'gst_record', 'company_law', 'audit_evidence', 'legal_hold', 'fraud_investigation'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`));

// An access/export refusal from the engine maps to a status: an unverified request is a 422 (the caller
// must verify first), a request already closed is a 409 (a state conflict, nothing was done).
const FULFIL_STATUS: Readonly<Record<Exclude<FulfilmentRefusal, 'fulfilled' | 'nothing_held'>, number>> = {
  not_verified: 422,
  wrong_state: 409,
};

const isCategory = (v: unknown): v is DataCategory =>
  isObj(v) && isStr(v['category']) && isInt(v['recordCount']) && (v['recordCount'] as number) >= 0
  && (v['retentionBasis'] === undefined || BASES.includes(v['retentionBasis'] as RetentionBasis))
  && (v['retainUntil'] === undefined || isDate(v['retainUntil']))
  && (v['minimisable'] === undefined || typeof v['minimisable'] === 'boolean');

/** `now` + n days as a YYYY-MM-DD date — the SLA deadline the overdue read is measured against. */
function dueDate(nowIso: string, slaDays: number): string {
  // R1c: the SLA runs from the shop's own date of the request, never its UTC date (00:00–05:30 IST was a day early).
  const at = new Date(`${shopDateIn(nowIso)}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + slaDays);
  return at.toISOString().slice(0, 10);
}

export interface DataRightsDeps {
  /** R1c (M01-FR-02): the shop's calendar — "today" is the shop's date, never the UTC one. */
  readonly calendar?: ShopCalendarOf;
  readonly request: (tenantId: string, requestId: string) => Promise<DataSubjectRequest | undefined> | DataSubjectRequest | undefined;
  /** Every data-subject request for the tenant — what the overdue read is taken over. */
  readonly requests: (tenantId: string) => Promise<readonly DataSubjectRequest[]> | readonly DataSubjectRequest[];
  /** Append one state of a request (append-only: raised → verified → fulfilled is the audit trail). */
  readonly record: (tenantId: string, requestId: string, request: DataSubjectRequest, key: string) => Promise<void> | void;
  /** R3 · C5 (DPDP s.14): every nominee record and verified activation (absent on a bare stub — a nominee cannot act). */
  readonly nomineeRecords?: (tenantId: string) => Promise<readonly NomineeRecord[]> | readonly NomineeRecord[];
  readonly nomineeActivations?: (tenantId: string) => Promise<readonly NomineeActivation[]> | readonly NomineeActivation[];
  readonly recordActivation?: (tenantId: string, a: NomineeActivation) => Promise<NomineeActivation> | NomineeActivation;
  readonly now: () => string;
}

export function dataRightsRoutes(deps: DataRightsDeps): readonly Route[] {
  // R3 · C5 · OB-146 "B": the shop's published answer-by time — 15 days — for every request and complaint.
  const DEFAULT_SLA_DAYS = PUBLISHED_RESPONSE_SLA_DAYS;
  return [
    {
      // Record a data-subject request (access / correction / export / erasure). Raised, not yet verified.
      // Body: { customerRef, kind, slaDays? }. The request id is in the path.
      api: 'API-06', method: 'POST', path: '/v1/privacy/data-requests/:requestId',
      permission: 'privacy.request.manage', idempotent: true,
      handler: async (ctx) => {
        const requestId = (ctx.params['requestId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (requestId === '' || !isStr(b['customerRef']) || !KINDS.includes(b['kind'] as RightKind)
          || (b['slaDays'] !== undefined && (!isInt(b['slaDays']) || (b['slaDays'] as number) <= 0))) {
          throw apiError(400, {
            code: 'not_readable_as_a_data_request',
            whatHappened: 'A data-subject request needs a requestId in the path and { customerRef, kind (access/correction/export/erasure/grievance), slaDays?, onBehalfOf? { nomineeRef } } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send who the request is for and which right is being exercised.',
          });
        }
        if (await deps.request(ctx.tenantId, requestId) !== undefined) {
          throw apiError(409, { code: 'request_already_raised', whatHappened: `A data-subject request "${requestId}" already exists.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new request id, or verify/fulfil the existing one.' });
        }
        const now = deps.now();
        const slaDays = isInt(b['slaDays']) ? b['slaDays'] as number : DEFAULT_SLA_DAYS;
        // R3 · C5: the published time is a promise to the customer — a request may be given less time, never more.
        if (slaDays > PUBLISHED_RESPONSE_SLA_DAYS) {
          throw apiError(422, { code: 'sla_longer_than_published', whatHappened: `The shop publishes that every request and complaint is answered within ${PUBLISHED_RESPONSE_SLA_DAYS} days (OB-146); ${slaDays} days would break that promise.`, wasItSaved: 'not_saved', nextSafeAction: `Leave slaDays out (${PUBLISHED_RESPONSE_SLA_DAYS} days) or give fewer. Nothing was raised.` });
        }
        // R3 · C5 (DPDP s.14): raised by the customer's NOMINEE — only the nominee the customer named, and only after a
        // death or incapacity a named person verified.
        const behalf = b['onBehalfOf'];
        let actingAs: DataSubjectRequest['actingAs'];
        if (behalf !== undefined) {
          const nomineeRef = isObj(behalf) && isStr(behalf['nomineeRef']) ? behalf['nomineeRef'].trim() : undefined;
          if (nomineeRef === undefined) throw apiError(400, { code: 'not_readable_as_a_data_request', whatHappened: 'onBehalfOf is { nomineeRef } — the nominee the customer recorded.', wasItSaved: 'not_saved', nextSafeAction: 'Send the nominee\'s reference. Nothing was raised.' });
          const may = mayNomineeAct({
            records: (await deps.nomineeRecords?.(ctx.tenantId)) ?? [], activations: (await deps.nomineeActivations?.(ctx.tenantId)) ?? [],
            customerRef: b['customerRef'] as string, nomineeRef,
          });
          if (!may.ok) {
            throw apiError(422, { code: `nominee_${may.reason}`, whatHappened: `The nominee cannot exercise this customer's rights: ${may.detail}.`, wasItSaved: 'not_saved', nextSafeAction: may.reason === 'not_verified' ? 'Verify the death or incapacity against the certificate first (POST /v1/privacy/nominees/:customerRef/activation). Nothing was raised.' : 'Check who the customer named. Nothing was raised.' });
          }
          actingAs = { role: 'nominee', nomineeRef, activationRef: may.activation.activationId };
        }
        const request: DataSubjectRequest = {
          requestId, tenantId: ctx.tenantId, customerRef: b['customerRef'] as string, kind: b['kind'] as RightKind,
          raisedAt: now, state: 'raised', dueBy: dueDate(now, slaDays), ...(actingAs === undefined ? {} : { actingAs }),
        };
        await deps.record(ctx.tenantId, requestId, request, `${requestId}-raised`);
        return { status: 201, body: { requestId, kind: request.kind, state: request.state, dueBy: request.dueBy, ...(actingAs === undefined ? {} : { actingAs }) } };
      },
    },
    {
      // Verify who asked. The verification gate the whole module turns on — nothing is fulfilled before it.
      // Body: { verifiedBy } (HOW they proved they are the data subject).
      api: 'API-06', method: 'POST', path: '/v1/privacy/data-requests/:requestId/verification',
      permission: 'privacy.request.manage', idempotent: true,
      handler: async (ctx) => {
        const requestId = ctx.params['requestId'] ?? '';
        const verifiedBy = (ctx.body as { verifiedBy?: unknown } | null)?.verifiedBy;
        if (!isStr(verifiedBy)) throw apiError(400, { code: 'verification_needs_a_method', whatHappened: 'Verification needs { verifiedBy } — how the requester proved they are the data subject.', wasItSaved: 'not_saved', nextSafeAction: 'Record how identity was confirmed.' });
        const existing = await deps.request(ctx.tenantId, requestId);
        if (existing === undefined) throw notFound(`data-subject request ${requestId}`);
        if (existing.state !== 'raised') throw apiError(409, { code: 'not_awaiting_verification', whatHappened: `This request is ${existing.state}, not awaiting verification.`, wasItSaved: 'not_saved', nextSafeAction: 'A request is verified once, while it is still raised.' });
        const now = deps.now();
        const updated: DataSubjectRequest = { ...existing, verifiedBy, verifiedAt: now, state: 'verified' };
        await deps.record(ctx.tenantId, requestId, updated, `${requestId}-verified`);
        return { status: 200, body: { requestId, state: updated.state, verifiedAt: now } };
      },
    },
    {
      // Fulfil an access, correction or export request — hand back what is held. Refused if not verified
      // (the request could be anyone), or if already closed. Erasure does NOT come here — it needs a plan.
      // Body: { held } — the data to return, keyed by category ({} is a valid, complete "we hold nothing").
      api: 'API-06', method: 'POST', path: '/v1/privacy/data-requests/:requestId/fulfilment',
      permission: 'privacy.request.manage', idempotent: true,
      handler: async (ctx) => {
        const requestId = ctx.params['requestId'] ?? '';
        const held = (ctx.body as { held?: unknown } | null)?.held;
        if (held !== undefined && !isObj(held)) throw apiError(400, { code: 'held_data_must_be_an_object', whatHappened: 'Fulfilment takes { held } — the data to return, keyed by category.', wasItSaved: 'not_saved', nextSafeAction: 'Send the held data, or {} for nothing held.' });
        const existing = await deps.request(ctx.tenantId, requestId);
        if (existing === undefined) throw notFound(`data-subject request ${requestId}`);
        if (existing.kind === 'erasure') throw apiError(409, { code: 'erasure_needs_a_plan', whatHappened: 'An erasure is not fulfilled by handing data back — it needs an erasure plan.', wasItSaved: 'not_saved', nextSafeAction: 'Use POST …/erasure-plan for an erasure request.' });

        const result = fulfilRequest({ request: existing, held: (held as Record<string, unknown>) ?? {}, fulfilledBy: ctx.userId, at: deps.now() });
        if (!result.fulfilled) {
          throw apiError(FULFIL_STATUS[result.outcome as Exclude<FulfilmentRefusal, 'fulfilled' | 'nothing_held'>], {
            code: result.outcome, whatHappened: result.detail, wasItSaved: 'not_saved',
            nextSafeAction: result.outcome === 'not_verified' ? 'Verify the request first — nothing is fulfilled unverified.' : 'This request is already closed.',
          });
        }
        await deps.record(ctx.tenantId, requestId, result.request, `${requestId}-fulfilled`);
        return { status: 200, body: { requestId, outcome: result.outcome, detail: result.detail, state: result.request.state, payload: result.payload ?? {} } };
      },
    },
    {
      // Plan an erasure. Produces the honest, category-by-category answer — erase what can go, minimise
      // (strip the person from) what must survive, retain what the law requires — and the customer message
      // that names each retained category with the statute and the date it can finally go. VERIFIED FIRST:
      // an unverified erasure is how one person deletes another's account. Body: { categories[] }.
      api: 'API-06', method: 'POST', path: '/v1/privacy/data-requests/:requestId/erasure-plan',
      permission: 'privacy.request.manage', idempotent: true,
      handler: async (ctx) => {
        const requestId = ctx.params['requestId'] ?? '';
        const categories = (ctx.body as { categories?: unknown } | null)?.categories;
        if (!Array.isArray(categories) || !categories.every(isCategory)) {
          throw apiError(400, { code: 'not_readable_as_categories', whatHappened: 'An erasure plan needs { categories[] } — each { category, recordCount, retentionBasis?, retainUntil?, minimisable? }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the categories of data held for this person.' });
        }
        const existing = await deps.request(ctx.tenantId, requestId);
        if (existing === undefined) throw notFound(`data-subject request ${requestId}`);
        if (existing.kind !== 'erasure') throw apiError(409, { code: 'not_an_erasure_request', whatHappened: `This is a ${existing.kind} request, not an erasure.`, wasItSaved: 'not_saved', nextSafeAction: 'Use POST …/fulfilment for access/correction/export.' });
        if (existing.state === 'fulfilled' || existing.state === 'refused') throw apiError(409, { code: 'request_already_closed', whatHappened: `This request is already ${existing.state}.`, wasItSaved: 'not_saved', nextSafeAction: 'A closed request is not planned again.' });
        // The verification gate — an unverified erasure deletes someone else's account.
        if (existing.verifiedBy === undefined) throw apiError(422, { code: 'not_verified', whatHappened: 'An erasure cannot be planned before the request is verified as coming from the data subject.', wasItSaved: 'not_saved', nextSafeAction: 'Verify the request first. Nothing was planned or erased.' });

        const plan = planErasure({ request: existing, categories: categories as DataCategory[], at: deps.now() });
        // Partial when at least one category must be kept (almost always true) — recorded honestly as
        // partially_fulfilled, not fulfilled, so the trail never claims a total erasure that did not happen.
        const updated: DataSubjectRequest = { ...existing, state: plan.partial ? 'partially_fulfilled' : 'fulfilled' };
        await deps.record(ctx.tenantId, requestId, updated, `${requestId}-${updated.state}`);
        return { status: 200, body: { ...plan, state: updated.state } };
      },
    },
    {
      // The privacy requests past their SLA, worst first — an unverified-and-overdue one called out
      // separately, because that queue is entirely the shop's and has simply not been worked. `?asOf=`
      // defaults to today. Registered BEFORE `/:requestId` so this static path wins the router.
      api: 'API-06', method: 'GET', path: '/v1/privacy/data-requests/overdue',
      permission: 'privacy.request.manage',
      handler: async (ctx) => {
        const asOf = ctx.query['asOf'];
        if (asOf !== undefined && !isDate(asOf)) throw apiError(400, { code: 'overdue_needs_a_valid_date', whatHappened: 'The overdue read takes ?asOf=YYYY-MM-DD, or none for today.', wasItSaved: 'not_saved', nextSafeAction: 'Send a valid date or omit it. A read never writes.' });
        const today = isDate(asOf) ? asOf : await shopToday(deps, ctx.tenantId);
        const overdue = overdueRequests(await deps.requests(ctx.tenantId), today);
        return { status: 200, body: { overdue, count: overdue.length, asOf: today } };
      },
    },
    {
      // The DPO's queue (audit FUL-06): every request still to be worked — raised by a customer in the app or recorded
      // here — oldest due first, so a customer's self-service request is visible to the officer the moment it lands.
      // `?state=all` includes closed ones. A read never writes.
      api: 'API-06', method: 'GET', path: '/v1/privacy/data-requests',
      permission: 'privacy.request.manage',
      handler: async (ctx) => {
        const all = await deps.requests(ctx.tenantId);
        const open = ctx.query['state'] === 'all' ? [...all] : all.filter((r) => r.state === 'raised' || r.state === 'verified');
        const queue = open.sort((a, b) => a.dueBy.localeCompare(b.dueBy) || a.raisedAt.localeCompare(b.raisedAt));
        return { status: 200, body: { queue, count: queue.length, asAt: deps.now() } };
      },
    },
    {
      // R3 · C5 (DPDP s.14): a named staff member VERIFIES a customer's death or incapacity against evidence, so their
      // nominee may act. Only for the nominee the customer named; the certificate's reference is kept, never its contents.
      // Body: { activationId, nomineeRef, basis (death / incapacity), evidenceRef }.
      api: 'API-06', method: 'POST', path: '/v1/privacy/nominees/:customerRef/activation',
      permission: 'privacy.request.manage', idempotent: true,
      handler: async (ctx) => {
        const customerRef = (ctx.params['customerRef'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (customerRef === '' || !isStr(b['activationId']) || !isStr(b['nomineeRef']) || !ACTIVATION_BASES.includes(b['basis'] as ActivationBasis) || !isStr(b['evidenceRef'])) {
          throw apiError(400, { code: 'not_readable_as_a_nominee_activation', whatHappened: 'A verification is { activationId, nomineeRef, basis (death / incapacity), evidenceRef (the certificate\'s reference) }.', wasItSaved: 'not_saved', nextSafeAction: 'Send what was verified. Nothing was recorded.' });
        }
        if (deps.recordActivation === undefined || deps.nomineeRecords === undefined) {
          throw apiError(503, { code: 'nominee_register_not_wired', whatHappened: 'Head office cannot keep nominee records here.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was recorded.' });
        }
        const current = currentNominee(await deps.nomineeRecords(ctx.tenantId), customerRef);
        if (current === null || current.nomineeRef !== b['nomineeRef'].trim()) {
          throw apiError(422, { code: current === null ? 'nominee_no_nominee' : 'nominee_not_the_nominee', whatHappened: current === null ? `${customerRef} has no nominee on record.` : `${b['nomineeRef']} is not the nominee ${customerRef} named.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the nomination on record. Nothing was recorded.' });
        }
        const activation: NomineeActivation = {
          activationId: b['activationId'].trim(), customerRef, nomineeRef: current.nomineeRef, basis: b['basis'] as ActivationBasis,
          evidenceRef: b['evidenceRef'].trim().slice(0, 120), verifiedBy: ctx.userId, verifiedAt: deps.now(),
        };
        const standing = await deps.recordActivation(ctx.tenantId, activation);
        return { status: 201, body: { activation: standing } };
      },
    },
    {
      // R3 · C5: the customer's nomination as the officer reads it — every record (append-only) and every verification.
      api: 'API-06', method: 'GET', path: '/v1/privacy/nominees/:customerRef',
      permission: 'privacy.request.manage',
      handler: async (ctx) => {
        const customerRef = (ctx.params['customerRef'] ?? '').trim();
        const records = ((await deps.nomineeRecords?.(ctx.tenantId)) ?? []).filter((r) => r.customerRef === customerRef);
        const activations = ((await deps.nomineeActivations?.(ctx.tenantId)) ?? []).filter((a) => a.customerRef === customerRef);
        return { status: 200, body: { customerRef, current: currentNominee(records, customerRef), history: records, activations } };
      },
    },
    {
      // Read one request's current state — where it is in the lifecycle and when it is due.
      api: 'API-06', method: 'GET', path: '/v1/privacy/data-requests/:requestId',
      permission: 'privacy.request.manage',
      handler: async (ctx) => {
        const existing = await deps.request(ctx.tenantId, ctx.params['requestId'] ?? '');
        if (existing === undefined) throw notFound(`data-subject request ${ctx.params['requestId']}`);
        return { status: 200, body: existing };
      },
    },
  ];
}
