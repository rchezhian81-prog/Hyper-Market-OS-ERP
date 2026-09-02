// Platform service management (M33-FR-04 "service management" / "track service requests") — an internal
// service-request tracker for the PLATFORM itself. This is deliberately NOT the M21 customer service desk
// (complaints, SLA clocks, goodwill compensation, AI replies): those are a shopper's aftersales case. A
// platform service request is an operational ticket about the system — "till 3 won't register", "we need a
// new admin account", "the nightly export is slow" — raised, assigned to a person, worked, and resolved.
//
//   • RAISE a request (title, detail, category, priority) — a duplicate id is refused (409).
//   • ASSIGN it to a person — so it has an owner, not a queue nobody watches.
//   • CHANGE its STATUS — open → in_progress → resolved (a resolution note is required) → closed; a closed one
//     can be re-opened. An unknown status, or resolving with no note, is refused.
//   • LIST — the requests, the ones that still need work FIRST (control by exception, P-03) with a count.
//   • READ one.
//
// Writes gated platform.service.manage; reads platform.service.read. Append-only (hard rule #2/#6); no AI
// writes anything (hard rule #5). No business transaction is posted here (§28).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export type ServiceRequestPriority = 'low' | 'normal' | 'high' | 'urgent';
export type ServiceRequestStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
const PRIORITIES: readonly ServiceRequestPriority[] = ['low', 'normal', 'high', 'urgent'];
const STATUSES: readonly ServiceRequestStatus[] = ['open', 'in_progress', 'resolved', 'closed'];

/** A platform service request, folded to now. */
export interface PlatformServiceRequest {
  readonly requestId: string;
  readonly title: string;
  readonly detail: string;
  readonly category: string;
  readonly priority: ServiceRequestPriority;
  readonly status: ServiceRequestStatus;
  readonly raisedBy: string;
  readonly assignedTo?: string;
  readonly resolution?: string;
  readonly raisedAt: string;
  readonly updatedAt: string;
  /** Still needs work — anything not resolved or closed (P-03, surfaced first). */
  readonly needsAttention: boolean;
}

/** One append-only fact about a service request. */
export interface ServiceRequestEvent {
  readonly requestId: string;
  readonly change: 'raised' | 'assigned' | 'statusChanged';
  readonly by: string;
  readonly at: string;
  readonly title?: string;
  readonly detail?: string;
  readonly category?: string;
  readonly priority?: ServiceRequestPriority;
  readonly assignedTo?: string;
  readonly status?: ServiceRequestStatus;
  readonly note?: string;
}

interface MutableRequest {
  requestId: string; title: string; detail: string; category: string; priority: ServiceRequestPriority;
  status: ServiceRequestStatus; raisedBy: string; assignedTo?: string; resolution?: string;
  raisedAt: string; updatedAt: string;
}

/** Fold the append-only log to the current set of requests. A change for a request nobody raised is ignored. */
export function projectServiceRequests(events: readonly ServiceRequestEvent[]): readonly PlatformServiceRequest[] {
  const byId = new Map<string, MutableRequest>();
  for (const e of events) {
    if (e.change === 'raised') {
      byId.set(e.requestId, {
        requestId: e.requestId, title: e.title ?? '', detail: e.detail ?? '', category: e.category ?? 'other',
        priority: e.priority ?? 'normal', status: 'open', raisedBy: e.by, raisedAt: e.at, updatedAt: e.at,
      });
      continue;
    }
    const r = byId.get(e.requestId);
    if (r === undefined) continue; // no phantom
    r.updatedAt = e.at;
    if (e.change === 'assigned') {
      r.assignedTo = e.assignedTo;
      if (r.status === 'open') r.status = 'in_progress';
    } else { // statusChanged
      if (e.status !== undefined) r.status = e.status;
      if (e.status === 'resolved' && e.note !== undefined) r.resolution = e.note;
      if (e.status === 'open') delete r.resolution; // a re-open clears the stale resolution
    }
  }
  return [...byId.values()].map((r) => ({
    requestId: r.requestId, title: r.title, detail: r.detail, category: r.category, priority: r.priority,
    status: r.status, raisedBy: r.raisedBy, ...(r.assignedTo !== undefined ? { assignedTo: r.assignedTo } : {}),
    ...(r.resolution !== undefined ? { resolution: r.resolution } : {}),
    raisedAt: r.raisedAt, updatedAt: r.updatedAt,
    needsAttention: r.status !== 'resolved' && r.status !== 'closed',
  }));
}

export interface ServiceRequestsDeps {
  readonly requests: (tenantId: string) => Promise<readonly PlatformServiceRequest[]> | readonly PlatformServiceRequest[];
  readonly recordEvent: (tenantId: string, event: ServiceRequestEvent, key: string) => Promise<void> | void;
  readonly now: () => string;
}

export function serviceRequestRoutes(deps: ServiceRequestsDeps): readonly Route[] {
  const find = async (tenantId: string, id: string): Promise<PlatformServiceRequest | undefined> =>
    (await deps.requests(tenantId)).find((r) => r.requestId === id);

  return [
    {
      // RAISE a request. A duplicate id is refused (re-raising is not how you re-open — that is a status change).
      api: 'API-11', method: 'POST', path: '/v1/platform/service-requests',
      permission: 'platform.service.manage', idempotent: true,
      handler: async (ctx) => {
        const b = ctx.body;
        if (!isObj(b) || !isStr(b['requestId']) || !isStr(b['title']) || !isStr(b['detail'])) {
          throw apiError(400, { code: 'not_readable_as_a_service_request', whatHappened: 'A service request needs { requestId, title, detail } (and optional category, priority).', wasItSaved: 'not_saved', nextSafeAction: 'Send what needs doing and why.' });
        }
        if (b['priority'] !== undefined && !PRIORITIES.includes(b['priority'] as ServiceRequestPriority)) {
          throw apiError(400, { code: 'unknown_priority', whatHappened: `priority must be one of ${PRIORITIES.join(', ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Send a valid priority, or leave it out for normal.' });
        }
        const requestId = (b['requestId'] as string).trim();
        if ((await find(ctx.tenantId, requestId)) !== undefined) {
          throw apiError(409, { code: 'service_request_exists', whatHappened: `A service request '${requestId}' already exists.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new id; to re-open one, change its status.' });
        }
        const at = deps.now();
        const event: ServiceRequestEvent = {
          requestId, change: 'raised', by: ctx.userId, at,
          title: (b['title'] as string).trim(), detail: (b['detail'] as string).trim(),
          category: isStr(b['category']) ? (b['category'] as string).trim() : 'other',
          priority: (b['priority'] as ServiceRequestPriority) ?? 'normal',
        };
        await deps.recordEvent(ctx.tenantId, event, ctx.idempotencyKey ?? `raise-${requestId}-${at}`);
        return { status: 201, body: { requestId, status: 'open', at } };
      },
    },
    {
      // ASSIGN it to a person — it gets an owner and, if it was still open, moves to in_progress.
      api: 'API-11', method: 'POST', path: '/v1/platform/service-requests/:requestId/assign',
      permission: 'platform.service.manage', idempotent: true,
      handler: async (ctx) => {
        const requestId = ctx.params['requestId'] ?? '';
        const b = ctx.body;
        if (!isObj(b) || !isStr(b['assignedTo'])) {
          throw apiError(400, { code: 'assignee_not_given', whatHappened: 'An assignment needs { assignedTo }.', wasItSaved: 'not_saved', nextSafeAction: 'Name who will work it.' });
        }
        if ((await find(ctx.tenantId, requestId)) === undefined) {
          throw apiError(404, { code: 'unknown_service_request', whatHappened: `There is no service request '${requestId}'.`, wasItSaved: 'not_saved', nextSafeAction: 'Raise it first.' });
        }
        const at = deps.now();
        await deps.recordEvent(ctx.tenantId, { requestId, change: 'assigned', assignedTo: (b['assignedTo'] as string).trim(), by: ctx.userId, at }, ctx.idempotencyKey ?? `assign-${requestId}-${at}`);
        return { status: 200, body: { requestId, assignedTo: (b['assignedTo'] as string).trim(), at } };
      },
    },
    {
      // CHANGE its status. Resolving requires a resolution note (a resolution nobody can read is not one).
      api: 'API-11', method: 'POST', path: '/v1/platform/service-requests/:requestId/status',
      permission: 'platform.service.manage', idempotent: true,
      handler: async (ctx) => {
        const requestId = ctx.params['requestId'] ?? '';
        const b = ctx.body;
        const status = isObj(b) ? b['status'] : undefined;
        if (!STATUSES.includes(status as ServiceRequestStatus)) {
          throw apiError(400, { code: 'unknown_status', whatHappened: `status must be one of ${STATUSES.join(', ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Send a valid status.' });
        }
        if (status === 'resolved' && !(isObj(b) && isStr(b['note']))) {
          throw apiError(400, { code: 'resolution_note_required', whatHappened: 'Resolving a request needs a { note } saying how it was resolved.', wasItSaved: 'not_saved', nextSafeAction: 'Say what was done.' });
        }
        if ((await find(ctx.tenantId, requestId)) === undefined) {
          throw apiError(404, { code: 'unknown_service_request', whatHappened: `There is no service request '${requestId}'.`, wasItSaved: 'not_saved', nextSafeAction: 'Raise it first.' });
        }
        const at = deps.now();
        const note = isObj(b) && isStr(b['note']) ? (b['note'] as string).trim() : undefined;
        await deps.recordEvent(ctx.tenantId, { requestId, change: 'statusChanged', status: status as ServiceRequestStatus, by: ctx.userId, at, ...(note !== undefined ? { note } : {}) }, ctx.idempotencyKey ?? `status-${requestId}-${status as string}-${at}`);
        return { status: 200, body: { requestId, status, at } };
      },
    },
    {
      // LIST — the requests that still need work FIRST, with a count of the open ones (P-03).
      api: 'API-11', method: 'GET', path: '/v1/platform/service-requests',
      permission: 'platform.service.read',
      handler: async (ctx) => {
        const all = await deps.requests(ctx.tenantId);
        const ordered = [...all].sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention));
        return { status: 200, body: { requests: ordered, open: all.filter((r) => r.needsAttention).length, asAt: deps.now() } };
      },
    },
    {
      // READ one.
      api: 'API-11', method: 'GET', path: '/v1/platform/service-requests/:requestId',
      permission: 'platform.service.read',
      handler: async (ctx) => {
        const request = await find(ctx.tenantId, ctx.params['requestId'] ?? '');
        if (request === undefined) {
          throw apiError(404, { code: 'unknown_service_request', whatHappened: `There is no service request '${ctx.params['requestId'] ?? ''}'.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the id against GET /v1/platform/service-requests.' });
        }
        return { status: 200, body: { request } };
      },
    },
  ];
}
