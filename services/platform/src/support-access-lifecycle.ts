// Durable, audited support-access lifecycle (M33-FR-03 · SEC-11) — the "no perpetual back door" workflow.
//
// The engine (`packages/platform-admin/src/support-access.ts`) already refuses everything that matters:
// a vague reason, blanket scope, a money-moving scope, an approval that is not the owner's, a requester
// approving their own (§28), an approval that would LENGTHEN the window, anything past the policy ceiling —
// and it computes an expiry that is a fact about time, so access ends on its own. What was missing was the
// LIFECYCLE around it: a support engineer could not FILE a request and have the owner approve it as two
// separate, durable, audited steps; nobody could READ who has access now or REVIEW who had it and what they
// did; and there was no way to END a session early. This wires all of that, event-sourced and restart-safe:
//
//   • REQUEST  — a support engineer files what they need (pending). Durable; the owner acts on it later.
//   • DECIDE   — the OWNER approves (→ a time-boxed session, via the engine's full gate) or rejects. The
//                requester can never be the approver (§28, enforced in the engine).
//   • ACT      — the session records what it touched; an action after expiry is refused (the record can
//                never show work the grant did not cover — so "expired access is revoked automatically").
//   • READ     — who has access now (active computed from the clock, never a stored flag) …
//   • REVIEW   — … and who had it, why, for how long, and what they did — an unused grant flagged.
//   • END      — revoke early; the session ends now.
//
// Requests/actions are the support engineer's (`platform.support.request`); the decision and early-end are
// the owner's (`platform.support.grant`); reads are `platform.support.read`. Append-only (hard rule #2/#6);
// no AI writes anything (hard rule #5).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  grantSupportAccess, recordSupportAction, endSupportSession, supportAccessReview, supportSessionActive,
  SupportAccessRefusedError,
  type SupportAccessRequest, type OwnerApproval, type SupportSession, type SupportAction, type SupportPolicy,
} from '../../../packages/platform-admin/src/support-access';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const strArray = (v: unknown): readonly string[] | undefined =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim() !== '') ? (v as string[]) : undefined;

/** One append-only fact in a support request's life. `session` on an approval is the engine's own output. */
export type SupportAccessEvent =
  | { readonly kind: 'requested'; readonly request: SupportAccessRequest }
  | { readonly kind: 'decided'; readonly requestId: string; readonly decision: 'approved' | 'rejected'; readonly decidedBy: string; readonly at: string; readonly session?: SupportSession }
  | { readonly kind: 'action'; readonly sessionId: string; readonly action: SupportAction }
  | { readonly kind: 'ended'; readonly sessionId: string; readonly at: string };

export type SupportRequestStatus = 'pending' | 'approved' | 'rejected';

/** A support request folded to now — pending, rejected, or approved with its live session. */
export interface SupportAccessRecord {
  readonly requestId: string;
  readonly status: SupportRequestStatus;
  readonly request: SupportAccessRequest;
  readonly decidedBy?: string;
  readonly session?: SupportSession;
}

interface MutableRecord {
  requestId: string; status: SupportRequestStatus; request: SupportAccessRequest;
  decidedBy?: string; session?: SupportSession;
}

/**
 * Fold the append-only log to the current set of requests/sessions. A decision/action/end for a request
 * nobody filed is ignored (no phantom session). The session id equals the request id, so one id threads the
 * whole lifecycle.
 */
export function projectSupportAccess(events: readonly SupportAccessEvent[]): readonly SupportAccessRecord[] {
  const byId = new Map<string, MutableRecord>();
  for (const e of events) {
    if (e.kind === 'requested') {
      byId.set(e.request.requestId, { requestId: e.request.requestId, status: 'pending', request: e.request });
      continue;
    }
    const id = e.kind === 'decided' ? e.requestId : e.sessionId;
    const rec = byId.get(id);
    if (rec === undefined) continue; // no phantom
    if (e.kind === 'decided') {
      rec.status = e.decision === 'approved' ? 'approved' : 'rejected';
      rec.decidedBy = e.decidedBy;
      if (e.session !== undefined) rec.session = { ...e.session, actions: [...e.session.actions] };
    } else if (e.kind === 'action') {
      if (rec.session === undefined) continue;
      rec.session = { ...rec.session, actions: [...rec.session.actions, e.action] };
    } else { // ended
      if (rec.session === undefined) continue;
      rec.session = { ...rec.session, endedAt: e.at };
    }
  }
  return [...byId.values()].map((r) => ({
    requestId: r.requestId, status: r.status, request: r.request,
    ...(r.decidedBy !== undefined ? { decidedBy: r.decidedBy } : {}),
    ...(r.session !== undefined ? { session: r.session } : {}),
  }));
}

export interface SupportAccessDeps {
  /** The current set of requests/sessions, projected from the append-only log (survives restart). */
  readonly records: (tenantId: string) => Promise<readonly SupportAccessRecord[]> | readonly SupportAccessRecord[];
  /** Append one lifecycle fact. Idempotent on the key. */
  readonly recordEvent: (tenantId: string, event: SupportAccessEvent, key: string) => Promise<void> | void;
  readonly now: () => string;
  /** Per-tenant ceiling; the engine default is used when omitted. */
  readonly policy?: SupportPolicy;
}

/** Turn the engine's refusal into a 422 the caller can act on. */
function refused(e: unknown): never {
  if (e instanceof SupportAccessRefusedError) {
    throw apiError(422, { code: 'support_access_refused', whatHappened: e.why, wasItSaved: 'not_saved', nextSafeAction: 'No access was granted. State the scopes actually needed, give a real reason, and have the owner (not the requester) approve it for a window inside policy.' });
  }
  throw e;
}

export function supportAccessLifecycleRoutes(deps: SupportAccessDeps): readonly Route[] {
  const find = async (tenantId: string, id: string): Promise<SupportAccessRecord | undefined> =>
    (await deps.records(tenantId)).find((r) => r.requestId === id);

  return [
    {
      // FILE a request (pending). The caller is the requester (§28: they can never approve it). Basic shape is
      // checked here; the full policy gate (forbidden scopes, the owner's approval, shorten-never-extend, the
      // ceiling) is the engine's, applied at the decision.
      api: 'API-11', method: 'POST', path: '/v1/platform/support-access/requests',
      permission: 'platform.support.request', idempotent: true,
      handler: async (ctx) => {
        const b = ctx.body;
        const scopes = isObj(b) ? strArray(b['scopes']) : undefined;
        if (!isObj(b) || !isStr(b['requestId']) || !isStr(b['requesterName']) || !isStr(b['reason']) || scopes === undefined || typeof b['minutes'] !== 'number') {
          throw apiError(400, { code: 'not_readable_as_a_support_request', whatHappened: 'A support-access request needs { requestId, requesterName, reason, scopes[], minutes }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the specific scopes needed and a real reason.' });
        }
        const requestId = (b['requestId'] as string).trim();
        if ((await find(ctx.tenantId, requestId)) !== undefined) {
          throw apiError(409, { code: 'support_request_exists', whatHappened: `A support-access request '${requestId}' already exists.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new request id; a longer or different window is always a new request (SEC-11).' });
        }
        const at = deps.now();
        const request: SupportAccessRequest = {
          requestId, requesterId: ctx.userId, requesterName: (b['requesterName'] as string).trim(),
          reason: (b['reason'] as string).trim(), scopes, tenantId: ctx.tenantId, minutes: b['minutes'] as number, at,
        };
        await deps.recordEvent(ctx.tenantId, { kind: 'requested', request }, ctx.idempotencyKey ?? `req-${requestId}-${at}`);
        return { status: 201, body: { requestId, status: 'pending', at } };
      },
    },
    {
      // DECIDE — the OWNER approves (→ a time-boxed session via the engine's full gate) or rejects. The engine
      // refuses a self-approval, an over-long grant, a forbidden scope, etc.; a decision on an unknown or
      // already-decided request is refused here.
      api: 'API-11', method: 'POST', path: '/v1/platform/support-access/requests/:requestId/decision',
      permission: 'platform.support.grant', idempotent: true,
      handler: async (ctx) => {
        const requestId = ctx.params['requestId'] ?? '';
        const b = ctx.body;
        const decision = isObj(b) ? b['decision'] : undefined;
        if (decision !== 'approved' && decision !== 'rejected') {
          throw apiError(400, { code: 'decision_not_given', whatHappened: 'A decision must be "approved" or "rejected".', wasItSaved: 'not_saved', nextSafeAction: 'Send the decision.' });
        }
        const rec = await find(ctx.tenantId, requestId);
        if (rec === undefined) {
          throw apiError(404, { code: 'unknown_support_request', whatHappened: `There is no support-access request '${requestId}'.`, wasItSaved: 'not_saved', nextSafeAction: 'File the request first.' });
        }
        if (rec.status !== 'pending') {
          throw apiError(409, { code: 'support_request_already_decided', whatHappened: `Request '${requestId}' is already ${rec.status}.`, wasItSaved: 'not_saved', nextSafeAction: 'A new grant is a new request (SEC-11).' });
        }
        const at = deps.now();
        if (decision === 'rejected') {
          await deps.recordEvent(ctx.tenantId, { kind: 'decided', requestId, decision: 'rejected', decidedBy: ctx.userId, at }, ctx.idempotencyKey ?? `dec-${requestId}-${at}`);
          return { status: 200, body: { requestId, status: 'rejected', decidedBy: ctx.userId, at } };
        }
        const grantedMinutes = isObj(b) && typeof b['grantedMinutes'] === 'number' ? (b['grantedMinutes'] as number) : undefined;
        const approval: OwnerApproval = { subjectRef: requestId, status: 'approved', decidedBy: ctx.userId, ...(grantedMinutes !== undefined ? { grantedMinutes } : {}) };
        let session: SupportSession;
        try {
          // The request was filed at its own time; re-stamp it to the decision moment so the window runs from
          // when access is actually granted, not when it was asked for.
          session = grantSupportAccess({ ...rec.request, at }, approval, deps.policy);
        } catch (e) { refused(e); }
        await deps.recordEvent(ctx.tenantId, { kind: 'decided', requestId, decision: 'approved', decidedBy: ctx.userId, at, session }, ctx.idempotencyKey ?? `dec-${requestId}-${at}`);
        return { status: 200, body: { requestId, status: 'approved', session } };
      },
    },
    {
      // RECORD an action — the session says what it touched. Refused once the session has expired or ended:
      // the record can never show work the grant did not cover (SEC-11 "expired access is revoked").
      api: 'API-11', method: 'POST', path: '/v1/platform/support-access/sessions/:sessionId/actions',
      permission: 'platform.support.request', idempotent: true,
      handler: async (ctx) => {
        const sessionId = ctx.params['sessionId'] ?? '';
        const b = ctx.body;
        if (!isObj(b) || !isStr(b['action'])) {
          throw apiError(400, { code: 'action_not_given', whatHappened: 'A support action needs { action } (and an optional target).', wasItSaved: 'not_saved', nextSafeAction: 'Say what was done.' });
        }
        const rec = await find(ctx.tenantId, sessionId);
        if (rec?.session === undefined) {
          throw apiError(404, { code: 'unknown_support_session', whatHappened: `There is no granted support session '${sessionId}'.`, wasItSaved: 'not_saved', nextSafeAction: 'A session exists only after the owner approves a request.' });
        }
        const at = deps.now();
        const action: SupportAction = { at, action: (b['action'] as string).trim(), ...(isStr(b['target']) ? { target: (b['target'] as string).trim() } : {}) };
        try {
          recordSupportAction(rec.session, action); // validates the session is live at `at`
        } catch (e) { refused(e); }
        await deps.recordEvent(ctx.tenantId, { kind: 'action', sessionId, action }, ctx.idempotencyKey ?? `act-${sessionId}-${at}`);
        return { status: 200, body: { sessionId, recorded: action } };
      },
    },
    {
      // END a session early — revoke access now. A session already ended stays ended; an unknown one is refused.
      api: 'API-11', method: 'POST', path: '/v1/platform/support-access/sessions/:sessionId/end',
      permission: 'platform.support.grant', idempotent: true,
      handler: async (ctx) => {
        const sessionId = ctx.params['sessionId'] ?? '';
        const rec = await find(ctx.tenantId, sessionId);
        if (rec?.session === undefined) {
          throw apiError(404, { code: 'unknown_support_session', whatHappened: `There is no granted support session '${sessionId}'.`, wasItSaved: 'not_saved', nextSafeAction: 'A session exists only after the owner approves a request.' });
        }
        const at = deps.now();
        const ended = endSupportSession(rec.session, rec.session.endedAt ?? at); // idempotent: keep the first end time
        await deps.recordEvent(ctx.tenantId, { kind: 'ended', sessionId, at: ended.endedAt ?? at }, ctx.idempotencyKey ?? `end-${sessionId}-${at}`);
        return { status: 200, body: { sessionId, endedAt: ended.endedAt } };
      },
    },
    {
      // READ — who has access now (and pending/rejected requests). `active` is computed from the clock, never a
      // stored flag, so an expired session reads as inactive with nobody having to run anything (SEC-11).
      api: 'API-11', method: 'GET', path: '/v1/platform/support-access/sessions',
      permission: 'platform.support.read',
      handler: async (ctx) => {
        const now = deps.now();
        const records = await deps.records(ctx.tenantId);
        const sessions = records
          .filter((r) => r.session !== undefined)
          .map((r) => ({ ...r.session!, active: supportSessionActive(r.session!, now) }));
        const pending = records.filter((r) => r.status === 'pending').map((r) => r.request);
        return { status: 200, body: { sessions, pending, activeCount: sessions.filter((s) => s.active).length, asAt: now } };
      },
    },
    {
      // REVIEW — who had access, why, for how long and what they did; an approved-but-never-used grant flagged.
      api: 'API-11', method: 'GET', path: '/v1/platform/support-access/review',
      permission: 'platform.support.read',
      handler: async (ctx) => {
        const now = deps.now();
        const sessions = (await deps.records(ctx.tenantId)).filter((r) => r.session !== undefined).map((r) => r.session!);
        return { status: 200, body: { review: supportAccessReview(sessions, now), asAt: now } };
      },
    },
  ];
}
