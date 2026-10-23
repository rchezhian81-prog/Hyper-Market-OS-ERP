// The AI-incident register (OB-288 lane 4 · P1 · roadmap §27 "incidents", §29 `AI_incident`, §30.2 `AIToolCallBlocked`).
//
// An AI incident is a moment the AI's controls had to act, or a person thinks they should have. It is raised:
//   • AUTOMATICALLY by the governed call when the gateway DROPS a tool a model asked for that the agent was never granted
//     (`tool_call_blocked`) — the defence worked, and the owner should still hear that a model reached for it;
//   • AUTOMATICALLY by an evaluation run that finds an UNSAFE case or an unsafe regression (`unsafe_evaluation`);
//   • by a PERSON who saw an assistant say or suggest something wrong (`raised_by_person`).
// Each is owned by a named person and closed by a person with a reason. Raising, owning and closing are three separate
// append-only facts — an incident is never edited and never deleted (hard rules #2, #6). Nothing here stops or starts an
// agent: that is the kill switch's job, and it stays one act away for whoever owns the incident.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { AGENTS, type AgentId } from '../../../packages/ai/src/index';

export type AiIncidentKind = 'tool_call_blocked' | 'unsafe_evaluation' | 'raised_by_person';

export interface AiIncidentRaised {
  readonly incidentId: string;
  readonly kind: AiIncidentKind;
  readonly agent?: AgentId;
  readonly summary: string;
  /** 'gateway' / 'evaluation' for an automatic one; otherwise the person's user id. */
  readonly raisedBy: string;
  readonly raisedAt: string;
  /** What it rests on: the audited call, the evaluation run, the tools that were dropped. */
  readonly evidence: { readonly callId?: string; readonly runId?: string; readonly tools?: readonly string[]; readonly cases?: readonly string[] };
}
export interface AiIncidentOwned { readonly incidentId: string; readonly owner: string; readonly by: string; readonly at: string }
export interface AiIncidentClosed { readonly incidentId: string; readonly reason: string; readonly by: string; readonly at: string }

export interface AiIncident extends AiIncidentRaised {
  readonly state: 'open' | 'owned' | 'closed';
  readonly owner?: string;
  readonly ownedAt?: string;
  readonly closedBy?: string;
  readonly closedAt?: string;
  readonly closeReason?: string;
}

/** One blocked tool call (§30.2 `AIToolCallBlocked`) — recorded for every tool the gateway dropped. */
export interface AiToolCallBlocked {
  readonly callId: string;
  readonly agent: AgentId;
  readonly tool: string;
  readonly forbidden: boolean;
  readonly at: string;
}

export interface AiIncidentStore {
  readonly raised: (tenantId: string) => Promise<readonly AiIncidentRaised[]> | readonly AiIncidentRaised[];
  readonly owned: (tenantId: string) => Promise<readonly AiIncidentOwned[]> | readonly AiIncidentOwned[];
  readonly closed: (tenantId: string) => Promise<readonly AiIncidentClosed[]> | readonly AiIncidentClosed[];
  /** Idempotent on the incident id — an automatic incident raised twice for the same call is one incident. */
  readonly raise: (tenantId: string, incident: AiIncidentRaised) => Promise<void> | void;
  readonly own: (tenantId: string, owned: AiIncidentOwned) => Promise<void> | void;
  readonly close: (tenantId: string, closed: AiIncidentClosed) => Promise<void> | void;
}

/** Fold the three facts into the register, newest first; the first owner/close per incident stands. */
export function foldIncidents(raised: readonly AiIncidentRaised[], owned: readonly AiIncidentOwned[], closed: readonly AiIncidentClosed[]): readonly AiIncident[] {
  const seen = new Set<string>();
  const out: AiIncident[] = [];
  for (const r of raised) {
    if (seen.has(r.incidentId)) continue;
    seen.add(r.incidentId);
    const o = owned.find((x) => x.incidentId === r.incidentId);
    const c = closed.find((x) => x.incidentId === r.incidentId);
    out.push({
      ...r,
      state: c !== undefined ? 'closed' : o !== undefined ? 'owned' : 'open',
      ...(o === undefined ? {} : { owner: o.owner, ownedAt: o.at }),
      ...(c === undefined ? {} : { closedBy: c.by, closedAt: c.at, closeReason: c.reason }),
    });
  }
  return out.sort((a, b) => (a.raisedAt < b.raisedAt ? 1 : a.raisedAt > b.raisedAt ? -1 : a.incidentId.localeCompare(b.incidentId)));
}

export async function incidentsOf(store: AiIncidentStore, tenantId: string): Promise<readonly AiIncident[]> {
  return foldIncidents(await store.raised(tenantId), await store.owned(tenantId), await store.closed(tenantId));
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
function refuse(status: number, code: string, whatHappened: string, nextSafeAction: string): never {
  throw apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });
}

export function aiIncidentRoutes(deps: { readonly incidents: AiIncidentStore; readonly now: () => string }): readonly Route[] {
  const find = async (tenantId: string, incidentId: string): Promise<AiIncident> => {
    const i = (await incidentsOf(deps.incidents, tenantId)).find((x) => x.incidentId === incidentId);
    if (i === undefined) refuse(404, 'no_such_ai_incident', `There is no AI incident "${incidentId}".`, 'Read GET /v1/ai/incidents and choose one. Nothing was changed.');
    return i;
  };
  return [
    {
      api: 'API-13', method: 'GET', path: '/v1/ai/incidents',
      permission: 'ai.proposal.read',
      handler: async (ctx) => {
        const all = await incidentsOf(deps.incidents, ctx.tenantId);
        return { status: 200, body: { incidents: all, open: all.filter((i) => i.state !== 'closed').length, asAt: deps.now() } };
      },
    },
    {
      // A person raises one. Body: { summary, agent? }.
      api: 'API-13', method: 'POST', path: '/v1/ai/incidents',
      permission: 'ai.incident.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['summary']) || (b['summary'] as string).length > 1_000 || (b['agent'] !== undefined && !(typeof b['agent'] === 'string' && b['agent'] in AGENTS))) {
          refuse(400, 'not_readable_as_an_ai_incident', 'An AI incident needs { summary (what the assistant said or did, ≤ 1,000 characters), agent? (A01…A10) }.', 'Nothing was raised.');
        }
        const at = deps.now();
        const incident: AiIncidentRaised = {
          incidentId: `aii-person-${ctx.idempotencyKey ?? at}`, kind: 'raised_by_person',
          ...(b['agent'] === undefined ? {} : { agent: b['agent'] as AgentId }),
          summary: (b['summary'] as string).trim(), raisedBy: ctx.userId, raisedAt: at, evidence: {},
        };
        await deps.incidents.raise(ctx.tenantId, incident);
        return { status: 201, body: { incident: { ...incident, state: 'open' } } };
      },
    },
    {
      // Name who owns it. Body: { owner }.
      api: 'API-13', method: 'POST', path: '/v1/ai/incidents/:incidentId/owner',
      permission: 'ai.incident.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['owner'])) refuse(400, 'owner_not_given', 'Owning an AI incident needs { owner: the person who will see it through }.', 'Nothing was changed.');
        const i = await find(ctx.tenantId, ctx.params['incidentId'] ?? '');
        if (i.state !== 'open') refuse(409, 'ai_incident_not_open', `${i.incidentId} is already ${i.state}${i.owner === undefined ? '' : ` (owner ${i.owner})`}.`, 'Nothing was changed.');
        const owned: AiIncidentOwned = { incidentId: i.incidentId, owner: (b['owner'] as string).trim(), by: ctx.userId, at: deps.now() };
        await deps.incidents.own(ctx.tenantId, owned);
        return { status: 200, body: { incidentId: i.incidentId, state: 'owned', owner: owned.owner, by: owned.by, at: owned.at } };
      },
    },
    {
      // Close it with a reason. Only an OWNED incident closes — somebody must have taken it on first.
      api: 'API-13', method: 'POST', path: '/v1/ai/incidents/:incidentId/close',
      permission: 'ai.incident.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['reason'])) refuse(400, 'close_needs_a_reason', 'Closing an AI incident needs a reason: what was found, and what was done.', 'Nothing was changed.');
        const i = await find(ctx.tenantId, ctx.params['incidentId'] ?? '');
        if (i.state === 'open') refuse(409, 'ai_incident_has_no_owner', `${i.incidentId} has no owner yet, so nobody has looked into it.`, 'Name an owner first (POST …/owner). Nothing was changed.');
        if (i.state === 'closed') refuse(409, 'ai_incident_already_closed', `${i.incidentId} was closed by ${i.closedBy ?? 'someone'} at ${i.closedAt ?? ''}.`, 'Nothing was changed.');
        const closed: AiIncidentClosed = { incidentId: i.incidentId, reason: (b['reason'] as string).trim(), by: ctx.userId, at: deps.now() };
        await deps.incidents.close(ctx.tenantId, closed);
        return { status: 200, body: { ...closed, state: 'closed' } };
      },
    },
  ];
}
