// API-06 Service desk — cases & SLA clocks (M21-FR-04). Control by exception (P-03): a case breaching its
// SLA is the one that must surface, loudly, not sit amber in a queue. Two clocks matter, and a single
// "SLA met" number hides the one customers actually feel:
//
//   • FIRST RESPONSE — how long before a human first replied. It does NOT pause for the customer (the shop
//     has said nothing for them to respond to yet). A desk that resolves everything on time while nobody
//     answers for two days is failing in the way people notice.
//   • RESOLUTION — how long to resolve, and this clock PAUSES while the shop is waiting on the customer,
//     so a customer who takes three days to send a photo is not recorded as the shop's breach (else the
//     report fills with breaches nobody caused and within a month nobody reads it).
//
// The rules are the tested `assessFirstResponse` / `assessSla` in `@sre/service-desk` (the
// services-run-on-their-tested-engine guardrail). Append-only and event-sourced. Gated `service.case.manage`
// to act, `service.case.read` to see the SLA and the breached queue.
//
// Held as a named follow-on: compensation as a §28 financial action (`grantCompensation`), AI-drafts a
// named human sends (`approveDraft`, P-05), CSAT reporting (`serviceReport`), the per-tenant SLA-policy
// store (this uses the engine's per-priority defaults), and the waiting-on-customer state machine (the
// paused minutes are supplied at resolution here rather than accrued across transitions).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  assessFirstResponse, assessSla,
  type ServiceCase, type CaseKind, type CasePriority,
} from '../../../packages/service-desk/src/index';

export type { ServiceCase } from '../../../packages/service-desk/src/index';

const KINDS: readonly CaseKind[] = ['complaint', 'enquiry', 'warranty', 'lost_and_found'];
const PRIORITIES: readonly CasePriority[] = ['low', 'normal', 'high', 'urgent'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

export interface ServiceCaseDeps {
  readonly serviceCase: (tenantId: string, caseId: string) => Promise<ServiceCase | undefined> | ServiceCase | undefined;
  /** Every case for the tenant — the breached-queue read folds over these. */
  readonly serviceCases: (tenantId: string) => Promise<readonly ServiceCase[]> | readonly ServiceCase[];
  /** Append one state of a case — append-only (open → first reply → resolved is the trail). */
  readonly recordCase: (tenantId: string, caseId: string, c: ServiceCase, key: string) => Promise<void> | void;
  readonly now: () => string;
}

const digestOf = (c: ServiceCase): string =>
  [c.state, c.firstRespondedAt ?? '', c.resolvedAt ?? '', c.priority, c.assignedTo, String(c.waitingOnCustomerMinutes ?? 0)].join('|');

const slaOf = (c: ServiceCase, now: string) => ({
  firstResponse: assessFirstResponse({ serviceCase: c, now }),
  resolution: assessSla({ serviceCase: c, now }),
});

export function serviceCaseRoutes(deps: ServiceCaseDeps): readonly Route[] {
  return [
    {
      // Open a case. Body: { kind, customerRef, priority, summary, assignedTo, orderRef? }.
      api: 'API-06', method: 'POST', path: '/v1/service/cases/:caseId',
      permission: 'service.case.manage', idempotent: true,
      handler: async (ctx) => {
        const caseId = (ctx.params['caseId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (caseId === '' || !KINDS.includes(b['kind'] as CaseKind) || !isStr(b['customerRef'])
          || !PRIORITIES.includes(b['priority'] as CasePriority) || !isStr(b['summary']) || !isStr(b['assignedTo'])
          || (b['orderRef'] !== undefined && !isStr(b['orderRef']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_case',
            whatHappened: 'A case needs a caseId in the path and { kind (complaint/enquiry/warranty/lost_and_found), customerRef, priority (low/normal/high/urgent), summary, assignedTo, orderRef? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send who it is for, what it is about, and who owns it.',
          });
        }
        if (await deps.serviceCase(ctx.tenantId, caseId) !== undefined) {
          throw apiError(409, { code: 'case_already_open', whatHappened: `A case "${caseId}" already exists.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new case id, or act on the existing one.' });
        }
        const c: ServiceCase = {
          caseId, tenantId: ctx.tenantId, kind: b['kind'] as CaseKind, customerRef: b['customerRef'] as string,
          openedAt: deps.now(), assignedTo: b['assignedTo'] as string, priority: b['priority'] as CasePriority,
          state: 'open', summary: b['summary'] as string, ...(isStr(b['orderRef']) ? { orderRef: b['orderRef'] } : {}),
        };
        await deps.recordCase(ctx.tenantId, caseId, c, digestOf(c));
        return { status: 201, body: { caseId, state: c.state, priority: c.priority, openedAt: c.openedAt } };
      },
    },
    {
      // Record the FIRST human reply — the clock the customer feels. Once only.
      api: 'API-06', method: 'POST', path: '/v1/service/cases/:caseId/first-response',
      permission: 'service.case.manage', idempotent: true,
      handler: async (ctx) => {
        const caseId = ctx.params['caseId'] ?? '';
        const existing = await deps.serviceCase(ctx.tenantId, caseId);
        if (existing === undefined) throw notFound(`service case ${caseId}`);
        if (existing.firstRespondedAt !== undefined) throw apiError(409, { code: 'already_responded', whatHappened: 'A first response is already recorded for this case.', wasItSaved: 'not_saved', nextSafeAction: 'The first-response clock is stamped once.' });
        const updated: ServiceCase = { ...existing, firstRespondedAt: deps.now() };
        await deps.recordCase(ctx.tenantId, caseId, updated, digestOf(updated));
        return { status: 200, body: { caseId, firstRespondedAt: updated.firstRespondedAt, sla: slaOf(updated, deps.now()) } };
      },
    },
    {
      // Resolve the case. Body: { resolution, waitingOnCustomerMinutes? } — the paused minutes the
      // resolution clock does not count against the shop.
      api: 'API-06', method: 'POST', path: '/v1/service/cases/:caseId/resolution',
      permission: 'service.case.manage', idempotent: true,
      handler: async (ctx) => {
        const caseId = ctx.params['caseId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const waiting = b['waitingOnCustomerMinutes'];
        if (!isStr(b['resolution']) || (waiting !== undefined && (!isInt(waiting) || (waiting as number) < 0))) {
          throw apiError(400, { code: 'not_readable_as_a_resolution', whatHappened: 'Resolving a case needs { resolution } and an optional { waitingOnCustomerMinutes } (a whole number ≥ 0).', wasItSaved: 'not_saved', nextSafeAction: 'Say how it was resolved.' });
        }
        const existing = await deps.serviceCase(ctx.tenantId, caseId);
        if (existing === undefined) throw notFound(`service case ${caseId}`);
        if (existing.state === 'resolved' || existing.state === 'closed') throw apiError(409, { code: 'already_resolved', whatHappened: `This case is already ${existing.state}.`, wasItSaved: 'not_saved', nextSafeAction: 'A resolved case is not resolved again.' });
        const updated: ServiceCase = {
          ...existing, state: 'resolved', resolvedAt: deps.now(), resolution: b['resolution'] as string,
          ...(isInt(waiting) ? { waitingOnCustomerMinutes: waiting } : {}),
        };
        await deps.recordCase(ctx.tenantId, caseId, updated, digestOf(updated));
        return { status: 200, body: { caseId, state: updated.state, resolvedAt: updated.resolvedAt, sla: slaOf(updated, deps.now()) } };
      },
    },
    {
      // Both SLA clocks for one case, right now.
      api: 'API-06', method: 'GET', path: '/v1/service/cases/:caseId/sla',
      permission: 'service.case.read',
      handler: async (ctx) => {
        const existing = await deps.serviceCase(ctx.tenantId, ctx.params['caseId'] ?? '');
        if (existing === undefined) throw notFound(`service case ${ctx.params['caseId']}`);
        return { status: 200, body: { caseId: existing.caseId, state: existing.state, ...slaOf(existing, deps.now()) } };
      },
    },
    {
      // The cases, and — with `?breached=true` — only the ones breaching a clock right now: the exceptions
      // that must be escalated rather than left to age in a queue (P-03/P-08).
      api: 'API-06', method: 'GET', path: '/v1/service/cases',
      permission: 'service.case.read',
      handler: async (ctx) => {
        const now = deps.now();
        const all = await deps.serviceCases(ctx.tenantId);
        const withSla = all.map((c) => ({ caseId: c.caseId, kind: c.kind, priority: c.priority, state: c.state, assignedTo: c.assignedTo, ...slaOf(c, now) }));
        const rows = ctx.query['breached'] === 'true'
          ? withSla.filter((r) => r.firstResponse.status === 'breached' || r.resolution.status === 'breached')
          : withSla;
        return { status: 200, body: { cases: rows, count: rows.length, asAt: now } };
      },
    },
  ];
}
