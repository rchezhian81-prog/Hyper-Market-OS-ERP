// Operational incidents and post-mortems (WF-20 "… monitor → rollback/incident/postmortem" · M35-FR-04 "alert ownership,
// escalation, incident/postmortem" · M33 · P-03 · P-04 · P-08 · hard rules #2, #6 and #10).
//
// The alert lifecycle (alert-lifecycle.ts) answers "is something wrong, and who owns it". This answers the next
// question: when something DID go wrong — a release rolled back, a store lost its sync, a backup missed — what happened,
// in what order, what are we changing so it does not happen again, and who said it is over. One incident is:
//
//   • OPENED by a named person (the caller), with a title, a severity and what is known, optionally naming the alerts
//     that raised it and the release it followed. An alert it names must be one head office raised (no phantom link).
//   • LINKED to further alerts as they come in;
//   • a TIMELINE of what happened when, each entry by its author (the linked alerts' own raise / acknowledgement /
//     escalation facts are read into the timeline, never retyped);
//   • ACTIONS — each with a named owner who holds a sign-in at this shop, and a due date; marked done by a person;
//   • a POST-MORTEM — cause, impact, what to change (and what went well), by its author; a re-statement is a new
//     version, the earlier one stays;
//   • CLOSED only by a named person (the caller — a body naming anybody else is refused), only once a post-mortem is
//     written. Nothing changes on a closed incident.
//
// Every fact is appended, never edited (hard rule #2); nothing is deleted (#6). The same fact sent again is the same
// one; a DIFFERENT fact under an id already used is a visible conflict (409), never a silent overwrite (#10). No AI
// writes here (#5): an AI may draft text for a person to send, but the route records the caller as the author.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, notFound, requireActorIsCaller } from '../../kernel/src/index';
import type { LiveAlert } from './alert-lifecycle';

export type IncidentSeverity = 'sev1' | 'sev2' | 'sev3';
const SEVERITIES: readonly IncidentSeverity[] = ['sev1', 'sev2', 'sev3'];

/** One append-only fact about an incident. `change` says which; the rest carries its detail. */
export type IncidentFact =
  | { readonly change: 'opened'; readonly incidentId: string; readonly title: string; readonly severity: IncidentSeverity; readonly summary: string; readonly alertIds: readonly string[]; readonly releaseSha?: string; readonly by: string; readonly at: string }
  | { readonly change: 'alert_linked'; readonly incidentId: string; readonly alertId: string; readonly by: string; readonly at: string }
  | { readonly change: 'timeline'; readonly incidentId: string; readonly entryId: string; readonly happenedAt: string; readonly note: string; readonly by: string; readonly at: string }
  | { readonly change: 'action_added'; readonly incidentId: string; readonly actionId: string; readonly description: string; readonly ownerUserId: string; readonly dueOn: string; readonly by: string; readonly at: string }
  | { readonly change: 'action_done'; readonly incidentId: string; readonly actionId: string; readonly note: string; readonly by: string; readonly at: string }
  | { readonly change: 'postmortem'; readonly incidentId: string; readonly version: number; readonly cause: string; readonly impact: string; readonly whatToChange: string; readonly whatWentWell?: string; readonly by: string; readonly at: string }
  | { readonly change: 'closed'; readonly incidentId: string; readonly note: string; readonly by: string; readonly at: string };

export interface IncidentAction {
  readonly actionId: string; readonly description: string; readonly ownerUserId: string; readonly dueOn: string;
  readonly addedBy: string; readonly addedAt: string; readonly doneBy?: string; readonly doneAt?: string; readonly doneNote?: string;
}
export interface Incident {
  readonly incidentId: string;
  readonly title: string;
  readonly severity: IncidentSeverity;
  readonly summary: string;
  readonly state: 'open' | 'closed';
  readonly openedBy: string;
  readonly openedAt: string;
  readonly releaseSha?: string;
  readonly alertIds: readonly string[];
  readonly timeline: readonly { readonly entryId: string; readonly happenedAt: string; readonly note: string; readonly by: string; readonly at: string }[];
  readonly actions: readonly IncidentAction[];
  /** Every version of the post-mortem, oldest first; the last is current. */
  readonly postmortems: readonly Extract<IncidentFact, { change: 'postmortem' }>[];
  readonly closedBy?: string;
  readonly closedAt?: string;
  readonly closingNote?: string;
}

/** Fold the facts to the incidents, one per id, in the order they were opened. */
export function projectIncidents(facts: readonly IncidentFact[]): readonly Incident[] {
  type M = { -readonly [K in keyof Incident]: Incident[K] } & { timeline: Incident['timeline'][number][]; actions: IncidentAction[]; alertIds: string[]; postmortems: Incident['postmortems'][number][] };
  const byId = new Map<string, M>();
  for (const f of facts) {
    if (f.change === 'opened') {
      if (byId.has(f.incidentId)) continue;
      byId.set(f.incidentId, {
        incidentId: f.incidentId, title: f.title, severity: f.severity, summary: f.summary, state: 'open', openedBy: f.by, openedAt: f.at,
        ...(f.releaseSha === undefined ? {} : { releaseSha: f.releaseSha }), alertIds: [...f.alertIds], timeline: [], actions: [], postmortems: [],
      });
      continue;
    }
    const i = byId.get(f.incidentId);
    if (i === undefined) continue; // no phantom incident
    if (f.change === 'alert_linked') { if (!i.alertIds.includes(f.alertId)) i.alertIds.push(f.alertId); }
    else if (f.change === 'timeline') { if (!i.timeline.some((t) => t.entryId === f.entryId)) i.timeline.push({ entryId: f.entryId, happenedAt: f.happenedAt, note: f.note, by: f.by, at: f.at }); }
    else if (f.change === 'action_added') { if (!i.actions.some((a) => a.actionId === f.actionId)) i.actions.push({ actionId: f.actionId, description: f.description, ownerUserId: f.ownerUserId, dueOn: f.dueOn, addedBy: f.by, addedAt: f.at }); }
    else if (f.change === 'action_done') {
      const k = i.actions.findIndex((a) => a.actionId === f.actionId);
      if (k >= 0 && i.actions[k]!.doneAt === undefined) i.actions[k] = { ...i.actions[k]!, doneBy: f.by, doneAt: f.at, doneNote: f.note };
    } else if (f.change === 'postmortem') i.postmortems.push(f);
    else if (f.change === 'closed') { if (i.state === 'open') { i.state = 'closed'; i.closedBy = f.by; i.closedAt = f.at; i.closingNote = f.note; } }
  }
  for (const i of byId.values()) i.timeline.sort((a, b) => a.happenedAt.localeCompare(b.happenedAt) || a.at.localeCompare(b.at));
  return [...byId.values()];
}

export interface OpsIncidentDeps {
  readonly facts: (tenantId: string) => Promise<readonly IncidentFact[]>;
  /** Append one fact; idempotent on `key` (the same fact again is the same one). */
  readonly record: (tenantId: string, fact: IncidentFact, key: string) => Promise<void>;
  /** The alerts head office raised (the alert lifecycle's fold) — an incident links only to these. */
  readonly alerts: (tenantId: string) => Promise<readonly LiveAlert[]> | readonly LiveAlert[];
  /** Whether a user holds any sign-in at this shop — an action's owner must be a real, named person here. */
  readonly isKnownPerson: (tenantId: string, userId: string) => Promise<boolean>;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SHA = /^[0-9a-f]{40}$/;
const unreadable = (what: string, needs: string) => apiError(400, { code: `not_readable_as_${what}`, whatHappened: `This could not be read as ${what.replace(/_/g, ' ')}: it needs ${needs}.`, wasItSaved: 'not_saved', nextSafeAction: 'Send it again with those fields. Nothing was recorded.' });
const conflict = (what: string) => apiError(409, { code: 'incident_fact_conflict', whatHappened: `${what} is already on the record with different content. A record is never overwritten.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new id for a new entry, or read the incident to see what is recorded. Nothing changed.' });
const closedAlready = (i: Incident) => apiError(409, { code: 'incident_closed', whatHappened: `Incident ${i.incidentId} was closed by ${i.closedBy ?? 'a person'} at ${i.closedAt ?? ''}; nothing changes on a closed incident.`, wasItSaved: 'not_saved', nextSafeAction: 'Open a new incident and say in its summary which closed one it follows. Nothing changed.' });

export function opsIncidentRoutes(deps: OpsIncidentDeps): readonly Route[] {
  const load = async (ctx: RequestContext): Promise<{ incident: Incident; all: readonly Incident[] }> => {
    const id = (ctx.params['incidentId'] ?? '').trim();
    const all = projectIncidents(await deps.facts(ctx.tenantId));
    const incident = all.find((i) => i.incidentId === id);
    if (incident === undefined) throw notFound(`incident ${id}`);
    return { incident, all };
  };
  const unknownAlerts = async (tenantId: string, ids: readonly string[]): Promise<readonly string[]> => {
    const known = new Set((await deps.alerts(tenantId)).map((a) => a.alert.alertId));
    return ids.filter((id) => !known.has(id));
  };
  const refuseUnknownAlerts = (missing: readonly string[]) => apiError(422, { code: 'unknown_alert', whatHappened: `Head office raised no alert called ${missing.join(', ')}. An incident links only to alerts that were really raised.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the ids against GET /v1/platform/alerts. Nothing was recorded.' });
  /** The read: the incident with the linked alerts' own facts read into its timeline (never retyped). */
  const view = async (tenantId: string, i: Incident) => {
    const alerts = (await deps.alerts(tenantId)).filter((a) => i.alertIds.includes(a.alert.alertId));
    const fromAlerts = alerts.flatMap((a) => [
      { happenedAt: a.alert.raisedAt, note: `alert ${a.alert.alertId} raised (${a.alert.component} ${a.alert.status}): ${a.alert.detail}`, by: 'alert', source: 'alert' as const },
      ...(a.acknowledgedAt === undefined ? [] : [{ happenedAt: a.acknowledgedAt, note: `alert ${a.alert.alertId} acknowledged`, by: a.acknowledgedBy ?? '', source: 'alert' as const }]),
      ...(a.escalatedAt === undefined ? [] : [{ happenedAt: a.escalatedAt, note: `alert ${a.alert.alertId} escalated to ${a.escalatedTo ?? ''}`, by: 'escalation', source: 'alert' as const }]),
    ]);
    const timeline = [...i.timeline.map((t) => ({ ...t, source: 'person' as const })), ...fromAlerts].sort((a, b) => a.happenedAt.localeCompare(b.happenedAt));
    const openActions = i.actions.filter((a) => a.doneAt === undefined);
    return { ...i, timeline, alerts, openActions: openActions.length, postmortem: i.postmortems.at(-1) ?? null };
  };

  return [
    {
      // OPEN — by the caller. Body: { title, severity (sev1/2/3), summary, alertIds?: [], releaseSha?, openedBy? (must be the caller) }.
      api: 'API-11', method: 'POST', path: '/v1/platform/incidents/:incidentId',
      permission: 'platform.alert.manage', idempotent: true,
      handler: async (ctx) => {
        const incidentId = (ctx.params['incidentId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        requireActorIsCaller(ctx, b, 'openedBy');
        const alertIds = b['alertIds'] === undefined ? [] : Array.isArray(b['alertIds']) && (b['alertIds'] as unknown[]).every(isStr) ? [...new Set(b['alertIds'] as string[])] : undefined;
        if (incidentId === '' || !isStr(b['title']) || !SEVERITIES.includes(b['severity'] as IncidentSeverity) || !isStr(b['summary']) || alertIds === undefined
          || (b['releaseSha'] !== undefined && !(typeof b['releaseSha'] === 'string' && SHA.test(b['releaseSha'])))) {
          throw unreadable('an_incident', '{ title, severity (sev1, sev2 or sev3), summary, alertIds? (raised alert ids), releaseSha? (the 40-character commit) }');
        }
        const existing = projectIncidents(await deps.facts(ctx.tenantId)).find((i) => i.incidentId === incidentId);
        if (existing !== undefined) {
          const same = existing.title === b['title'] && existing.severity === b['severity'] && existing.summary === b['summary'];
          if (!same) throw conflict(`Incident ${incidentId}`);
          return { status: 200, body: { incidentId, state: existing.state, openedBy: existing.openedBy, alreadyOpen: true } };
        }
        const missing = await unknownAlerts(ctx.tenantId, alertIds);
        if (missing.length > 0) throw refuseUnknownAlerts(missing);
        const at = deps.now();
        await deps.record(ctx.tenantId, {
          change: 'opened', incidentId, title: b['title'] as string, severity: b['severity'] as IncidentSeverity, summary: b['summary'] as string,
          alertIds, ...(b['releaseSha'] === undefined ? {} : { releaseSha: b['releaseSha'] as string }), by: ctx.userId, at,
        }, `opened-${incidentId}`);
        return { status: 201, body: { incidentId, state: 'open', openedBy: ctx.userId, openedAt: at, alertIds } };
      },
    },
    {
      // LINK another alert that belongs to this incident. Body: { alertId }.
      api: 'API-11', method: 'POST', path: '/v1/platform/incidents/:incidentId/alerts',
      permission: 'platform.alert.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['alertId'])) throw unreadable('an_alert_link', '{ alertId }');
        const { incident } = await load(ctx);
        if (incident.state === 'closed') throw closedAlready(incident);
        const alertId = b['alertId'] as string;
        if (incident.alertIds.includes(alertId)) return { status: 200, body: { incidentId: incident.incidentId, alertIds: incident.alertIds, alreadyLinked: true } };
        const missing = await unknownAlerts(ctx.tenantId, [alertId]);
        if (missing.length > 0) throw refuseUnknownAlerts(missing);
        await deps.record(ctx.tenantId, { change: 'alert_linked', incidentId: incident.incidentId, alertId, by: ctx.userId, at: deps.now() }, `alert-${incident.incidentId}-${alertId}`);
        return { status: 201, body: { incidentId: incident.incidentId, alertIds: [...incident.alertIds, alertId] } };
      },
    },
    {
      // TIMELINE — what happened when, by its author. Body: { entryId, happenedAt (ISO time), note }.
      api: 'API-11', method: 'POST', path: '/v1/platform/incidents/:incidentId/timeline',
      permission: 'platform.alert.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['entryId']) || !isStr(b['happenedAt']) || Number.isNaN(Date.parse(b['happenedAt'] as string)) || !isStr(b['note'])) {
          throw unreadable('a_timeline_entry', '{ entryId, happenedAt (a time), note }');
        }
        const { incident } = await load(ctx);
        const prior = incident.timeline.find((t) => t.entryId === b['entryId']);
        if (prior !== undefined) {
          if (prior.note !== b['note'] || prior.happenedAt !== b['happenedAt']) throw conflict(`Timeline entry ${String(b['entryId'])}`);
          return { status: 200, body: { incidentId: incident.incidentId, entryId: prior.entryId, alreadyRecorded: true } };
        }
        if (incident.state === 'closed') throw closedAlready(incident);
        await deps.record(ctx.tenantId, { change: 'timeline', incidentId: incident.incidentId, entryId: b['entryId'] as string, happenedAt: b['happenedAt'] as string, note: b['note'] as string, by: ctx.userId, at: deps.now() }, `timeline-${incident.incidentId}-${String(b['entryId'])}`);
        return { status: 201, body: { incidentId: incident.incidentId, entryId: b['entryId'], by: ctx.userId } };
      },
    },
    {
      // ACTION — what will change, owned by a named person at this shop, by a date. Body: { description, ownerUserId, dueOn }.
      api: 'API-11', method: 'POST', path: '/v1/platform/incidents/:incidentId/actions/:actionId',
      permission: 'platform.alert.manage', idempotent: true,
      handler: async (ctx) => {
        const actionId = (ctx.params['actionId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (actionId === '' || !isStr(b['description']) || !isStr(b['ownerUserId']) || !(typeof b['dueOn'] === 'string' && DAY.test(b['dueOn']))) {
          throw unreadable('an_incident_action', '{ description, ownerUserId (a person at this shop), dueOn (YYYY-MM-DD) }');
        }
        const { incident } = await load(ctx);
        const prior = incident.actions.find((a) => a.actionId === actionId);
        if (prior !== undefined) {
          if (prior.description !== b['description'] || prior.ownerUserId !== b['ownerUserId'] || prior.dueOn !== b['dueOn']) throw conflict(`Action ${actionId}`);
          return { status: 200, body: { incidentId: incident.incidentId, actionId, alreadyRecorded: true } };
        }
        if (incident.state === 'closed') throw closedAlready(incident);
        if (!(await deps.isKnownPerson(ctx.tenantId, b['ownerUserId'] as string))) {
          throw apiError(422, { code: 'action_owner_unknown', whatHappened: `${String(b['ownerUserId'])} holds no sign-in at this shop, so they cannot own an action. An action nobody owns is an action nobody does.`, wasItSaved: 'not_saved', nextSafeAction: 'Name a person who works here. Nothing was recorded.' });
        }
        await deps.record(ctx.tenantId, { change: 'action_added', incidentId: incident.incidentId, actionId, description: b['description'] as string, ownerUserId: b['ownerUserId'] as string, dueOn: b['dueOn'] as string, by: ctx.userId, at: deps.now() }, `action-${incident.incidentId}-${actionId}`);
        return { status: 201, body: { incidentId: incident.incidentId, actionId, ownerUserId: b['ownerUserId'], dueOn: b['dueOn'] } };
      },
    },
    {
      // ACTION DONE — by a person, with what was done. Body: { note }.
      api: 'API-11', method: 'POST', path: '/v1/platform/incidents/:incidentId/actions/:actionId/done',
      permission: 'platform.alert.manage', idempotent: true,
      handler: async (ctx) => {
        const actionId = (ctx.params['actionId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['note'])) throw unreadable('an_action_completion', '{ note } — what was done');
        const { incident } = await load(ctx);
        const action = incident.actions.find((a) => a.actionId === actionId);
        if (action === undefined) throw notFound(`action ${actionId} on incident ${incident.incidentId}`);
        if (action.doneAt !== undefined) return { status: 200, body: { incidentId: incident.incidentId, actionId, doneBy: action.doneBy, alreadyDone: true } };
        await deps.record(ctx.tenantId, { change: 'action_done', incidentId: incident.incidentId, actionId, note: b['note'] as string, by: ctx.userId, at: deps.now() }, `action-done-${incident.incidentId}-${actionId}`);
        return { status: 200, body: { incidentId: incident.incidentId, actionId, doneBy: ctx.userId } };
      },
    },
    {
      // POST-MORTEM — cause, impact, what to change (and what went well). A re-statement is a new version; the earlier stays.
      api: 'API-11', method: 'POST', path: '/v1/platform/incidents/:incidentId/postmortem',
      permission: 'platform.alert.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        requireActorIsCaller(ctx, b, 'writtenBy');
        if (!isStr(b['cause']) || !isStr(b['impact']) || !isStr(b['whatToChange']) || (b['whatWentWell'] !== undefined && typeof b['whatWentWell'] !== 'string')) {
          throw unreadable('a_postmortem', '{ cause, impact, whatToChange, whatWentWell? }');
        }
        const { incident } = await load(ctx);
        const current = incident.postmortems.at(-1);
        const same = current !== undefined && current.cause === b['cause'] && current.impact === b['impact'] && current.whatToChange === b['whatToChange'] && (current.whatWentWell ?? '') === (b['whatWentWell'] ?? '');
        if (same) return { status: 200, body: { incidentId: incident.incidentId, version: current.version, alreadyRecorded: true } };
        if (incident.state === 'closed') throw closedAlready(incident);
        const version = (current?.version ?? 0) + 1;
        await deps.record(ctx.tenantId, {
          change: 'postmortem', incidentId: incident.incidentId, version, cause: b['cause'] as string, impact: b['impact'] as string, whatToChange: b['whatToChange'] as string,
          ...(typeof b['whatWentWell'] === 'string' ? { whatWentWell: b['whatWentWell'] } : {}), by: ctx.userId, at: deps.now(),
        }, `postmortem-${incident.incidentId}-v${version}`);
        return { status: 201, body: { incidentId: incident.incidentId, version, writtenBy: ctx.userId } };
      },
    },
    {
      // CLOSE — only by a named person: the caller (a body naming anyone else is refused), only once a post-mortem is
      // written. Open actions stay listed on the closed incident with their owners. Body: { note, closedBy? (= caller) }.
      api: 'API-11', method: 'POST', path: '/v1/platform/incidents/:incidentId/close',
      permission: 'platform.alert.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        requireActorIsCaller(ctx, b, 'closedBy');
        if (!isStr(b['note'])) throw unreadable('an_incident_closure', '{ note } — why it is over');
        const { incident } = await load(ctx);
        if (incident.state === 'closed') return { status: 200, body: { incidentId: incident.incidentId, state: 'closed', closedBy: incident.closedBy, alreadyClosed: true } };
        if (incident.postmortems.length === 0) {
          throw apiError(422, { code: 'incident_needs_postmortem', whatHappened: `Incident ${incident.incidentId} has no post-mortem yet. An incident closes only once its cause, impact and what will change are written down.`, wasItSaved: 'not_saved', nextSafeAction: 'Write the post-mortem (POST …/postmortem), then close it. Nothing changed.' });
        }
        const at = deps.now();
        await deps.record(ctx.tenantId, { change: 'closed', incidentId: incident.incidentId, note: b['note'] as string, by: ctx.userId, at }, `closed-${incident.incidentId}`);
        return { status: 200, body: { incidentId: incident.incidentId, state: 'closed', closedBy: ctx.userId, closedAt: at, openActions: incident.actions.filter((a) => a.doneAt === undefined).map((a) => ({ actionId: a.actionId, ownerUserId: a.ownerUserId, dueOn: a.dueOn })) } };
      },
    },
    {
      // BOARD — open incidents first (worst severity first), then closed, newest first.
      api: 'API-11', method: 'GET', path: '/v1/platform/incidents',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const all = projectIncidents(await deps.facts(ctx.tenantId));
        const ordered = [...all].sort((a, b) => (a.state === b.state ? 0 : a.state === 'open' ? -1 : 1) || a.severity.localeCompare(b.severity) || b.openedAt.localeCompare(a.openedAt));
        return { status: 200, body: {
          incidents: ordered.map((i) => ({ incidentId: i.incidentId, title: i.title, severity: i.severity, state: i.state, openedBy: i.openedBy, openedAt: i.openedAt, closedBy: i.closedBy ?? null, alertIds: i.alertIds, openActions: i.actions.filter((a) => a.doneAt === undefined).length, hasPostmortem: i.postmortems.length > 0 })),
          open: all.filter((i) => i.state === 'open').length,
        } };
      },
    },
    {
      // ONE incident: its facts, the linked alerts and their own facts in the timeline, the current post-mortem.
      api: 'API-11', method: 'GET', path: '/v1/platform/incidents/:incidentId',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const { incident } = await load(ctx);
        return { status: 200, body: { incident: await view(ctx.tenantId, incident) } };
      },
    },
  ];
}
