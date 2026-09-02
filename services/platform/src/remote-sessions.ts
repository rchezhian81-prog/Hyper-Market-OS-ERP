// Control of remote sessions (M33-FR-02 — "control remote sessions") — the register of live remote/terminal
// sessions on the fleet, and an administrator's power to END one. A remote session is a connection into a
// device or terminal (a support engineer's remote desktop, a still-signed-in till, an admin console): the
// danger is one that stays open, unseen, after the work is done. So this keeps them VISIBLE and TERMINABLE:
//
//   • OPEN — a device/terminal reports a session started (who, on which device, of what kind). A second open
//     of the same id while it is still active is refused (409) — one id, one live session.
//   • HEARTBEAT — the session reports it is still alive (updates last-seen; silence is then itself a signal).
//   • TERMINATE — an administrator ends it now, with a reason (append-only history). Ending an already-ended
//     session is refused (409); ending one nobody opened is refused (404). This is the "cut off a remote
//     session" control — no session is perpetual, and none ends without a named reason (P-04/P-05).
//   • LIST / READ — who is connected right now (active first), so a person can actually see and act.
//
// Terminate/open/heartbeat are device control → gated `platform.device.manage`; reads `platform.health.read`.
// Append-only (hard rule #2/#6); no AI ends a session (hard rule #5); no business transaction here (§28).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export type RemoteSessionStatus = 'active' | 'terminated';

/** A remote session folded to now. */
export interface RemoteSession {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly kind: string;
  readonly status: RemoteSessionStatus;
  readonly openedAt: string;
  readonly lastSeenAt: string;
  readonly terminatedBy?: string;
  readonly terminatedReason?: string;
  readonly terminatedAt?: string;
  /** Live right now — surfaced first. */
  readonly active: boolean;
}

/** One append-only fact about a remote session. */
export interface RemoteSessionEvent {
  readonly sessionId: string;
  readonly change: 'opened' | 'seen' | 'terminated';
  readonly by: string;
  readonly at: string;
  readonly deviceId?: string;
  readonly userId?: string;
  readonly kind?: string;
  readonly reason?: string;
}

interface MutableSession {
  sessionId: string; deviceId: string; userId: string; kind: string; status: RemoteSessionStatus;
  openedAt: string; lastSeenAt: string; terminatedBy?: string; terminatedReason?: string; terminatedAt?: string;
}

/** Fold the append-only log to the current sessions. A heartbeat/terminate for one nobody opened is ignored. */
export function projectRemoteSessions(events: readonly RemoteSessionEvent[]): readonly RemoteSession[] {
  const byId = new Map<string, MutableSession>();
  for (const e of events) {
    if (e.change === 'opened') {
      byId.set(e.sessionId, {
        sessionId: e.sessionId, deviceId: e.deviceId ?? '', userId: e.userId ?? '', kind: e.kind ?? 'remote',
        status: 'active', openedAt: e.at, lastSeenAt: e.at,
      });
      continue;
    }
    const s = byId.get(e.sessionId);
    if (s === undefined) continue; // no phantom
    if (e.change === 'seen') {
      s.lastSeenAt = e.at;
    } else { // terminated
      s.status = 'terminated';
      s.terminatedBy = e.by;
      s.terminatedAt = e.at;
      if (e.reason !== undefined) s.terminatedReason = e.reason;
    }
  }
  return [...byId.values()].map((s) => ({
    sessionId: s.sessionId, deviceId: s.deviceId, userId: s.userId, kind: s.kind, status: s.status,
    openedAt: s.openedAt, lastSeenAt: s.lastSeenAt,
    ...(s.terminatedBy !== undefined ? { terminatedBy: s.terminatedBy } : {}),
    ...(s.terminatedReason !== undefined ? { terminatedReason: s.terminatedReason } : {}),
    ...(s.terminatedAt !== undefined ? { terminatedAt: s.terminatedAt } : {}),
    active: s.status === 'active',
  }));
}

export interface RemoteSessionsDeps {
  readonly sessions: (tenantId: string) => Promise<readonly RemoteSession[]> | readonly RemoteSession[];
  readonly recordEvent: (tenantId: string, event: RemoteSessionEvent, key: string) => Promise<void> | void;
  readonly now: () => string;
}

export function remoteSessionRoutes(deps: RemoteSessionsDeps): readonly Route[] {
  const find = async (tenantId: string, id: string): Promise<RemoteSession | undefined> =>
    (await deps.sessions(tenantId)).find((s) => s.sessionId === id);

  return [
    {
      // OPEN — a device/terminal reports a live remote session. A second open of a still-active id is refused.
      api: 'API-11', method: 'POST', path: '/v1/platform/remote-sessions',
      permission: 'platform.device.manage', idempotent: true,
      handler: async (ctx) => {
        const b = ctx.body;
        if (!isObj(b) || !isStr(b['sessionId']) || !isStr(b['deviceId']) || !isStr(b['userId'])) {
          throw apiError(400, { code: 'not_readable_as_a_remote_session', whatHappened: 'A remote session needs { sessionId, deviceId, userId } (and an optional kind).', wasItSaved: 'not_saved', nextSafeAction: 'Send who is connected, and where.' });
        }
        const sessionId = (b['sessionId'] as string).trim();
        const existing = await find(ctx.tenantId, sessionId);
        if (existing !== undefined && existing.active) {
          throw apiError(409, { code: 'remote_session_already_open', whatHappened: `A remote session '${sessionId}' is already open.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new session id; a re-connection is a new session.' });
        }
        const at = deps.now();
        const event: RemoteSessionEvent = {
          sessionId, change: 'opened', by: ctx.userId, at,
          deviceId: (b['deviceId'] as string).trim(), userId: (b['userId'] as string).trim(),
          kind: isStr(b['kind']) ? (b['kind'] as string).trim() : 'remote',
        };
        await deps.recordEvent(ctx.tenantId, event, ctx.idempotencyKey ?? `open-${sessionId}-${at}`);
        return { status: 201, body: { sessionId, status: 'active', at } };
      },
    },
    {
      // HEARTBEAT — the session reports it is still alive (updates last-seen). Unknown session refused.
      api: 'API-11', method: 'POST', path: '/v1/platform/remote-sessions/:sessionId/heartbeat',
      permission: 'platform.device.manage', idempotent: true,
      handler: async (ctx) => {
        const sessionId = ctx.params['sessionId'] ?? '';
        const s = await find(ctx.tenantId, sessionId);
        if (s === undefined) {
          throw apiError(404, { code: 'unknown_remote_session', whatHappened: `There is no remote session '${sessionId}'.`, wasItSaved: 'not_saved', nextSafeAction: 'Open the session first.' });
        }
        const at = deps.now();
        await deps.recordEvent(ctx.tenantId, { sessionId, change: 'seen', by: ctx.userId, at }, ctx.idempotencyKey ?? `seen-${sessionId}-${at}`);
        return { status: 200, body: { sessionId, lastSeenAt: at } };
      },
    },
    {
      // TERMINATE — an administrator ends a live session, with a reason. Ending an already-ended one is refused.
      api: 'API-11', method: 'POST', path: '/v1/platform/remote-sessions/:sessionId/terminate',
      permission: 'platform.device.manage', idempotent: true,
      handler: async (ctx) => {
        const sessionId = ctx.params['sessionId'] ?? '';
        const b = ctx.body;
        if (!isObj(b) || !isStr(b['reason'])) {
          throw apiError(400, { code: 'termination_reason_required', whatHappened: 'Ending a remote session needs a { reason } — no session ends without a named why.', wasItSaved: 'not_saved', nextSafeAction: 'Say why the session is being cut off.' });
        }
        const s = await find(ctx.tenantId, sessionId);
        if (s === undefined) {
          throw apiError(404, { code: 'unknown_remote_session', whatHappened: `There is no remote session '${sessionId}'.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the id against GET /v1/platform/remote-sessions.' });
        }
        if (!s.active) {
          throw apiError(409, { code: 'remote_session_already_ended', whatHappened: `Remote session '${sessionId}' is already ended.`, wasItSaved: 'not_saved', nextSafeAction: 'It is already closed; nothing to cut off.' });
        }
        const at = deps.now();
        await deps.recordEvent(ctx.tenantId, { sessionId, change: 'terminated', by: ctx.userId, at, reason: (b['reason'] as string).trim() }, ctx.idempotencyKey ?? `end-${sessionId}-${at}`);
        return { status: 200, body: { sessionId, status: 'terminated', at } };
      },
    },
    {
      // LIST — who is connected right now (active first), with a count.
      api: 'API-11', method: 'GET', path: '/v1/platform/remote-sessions',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const all = await deps.sessions(ctx.tenantId);
        const ordered = [...all].sort((a, b) => Number(b.active) - Number(a.active));
        return { status: 200, body: { sessions: ordered, active: all.filter((s) => s.active).length, asAt: deps.now() } };
      },
    },
    {
      // READ one.
      api: 'API-11', method: 'GET', path: '/v1/platform/remote-sessions/:sessionId',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const session = await find(ctx.tenantId, ctx.params['sessionId'] ?? '');
        if (session === undefined) {
          throw apiError(404, { code: 'unknown_remote_session', whatHappened: `There is no remote session '${ctx.params['sessionId'] ?? ''}'.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the id against GET /v1/platform/remote-sessions.' });
        }
        return { status: 200, body: { session } };
      },
    },
  ];
}
