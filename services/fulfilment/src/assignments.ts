// API-08 — head office ASSIGNS the handhelds their work: a pick WAVE to a picker, a ROUTE to a driver, per store
// (M19-FR-01 · M19-FR-03 · §31 · P-08 · hard rules #4/#6 — HA-1, 3 Oct 2026).
//
// Until this, the handhelds' work came from the box's pack FILE (`wave` / `route` sections written by hand). Those sections
// stay — as the dispatcher's hand-written OVERRIDE, which the box says it is holding — but the normal source is now head
// office: a person with the authority assigns HERE, the box PULLS the open assignments under its own credential
// (`GET /v1/fulfilment/assignments?storeId=`), and the picker and the driver see them on their phones with "head office" named.
//
//   • an assignment is APPEND-ONLY and idempotent on its content: the same wave posted again with the same lines is ONE
//     record (200, alreadyAssigned); changed lines are a NEW record that replaces it (201, replaced) — the history is kept (#6);
//   • the person assigned is RE-VERIFIED from THEIR grants and REFUSED when they may not do the work (422) — head office does
//     not hand a wave to somebody who cannot pick it. The relay routes FLAG; this one REFUSES, because this is a person's act;
//   • finished work cannot be reassigned: a wave the wave register already holds a pack for, or a route the route register
//     holds a settlement for, is 409 — and the pull returns only OPEN assignments, so done work leaves the phone by itself;
//   • nothing here moves stock or money; the customer never travels (an order REFERENCE and an area, §31).

import { createHash } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';

/** One line of a wave as head office hands it to the picker — the same shape the box's pack file carried. */
export interface AssignedWaveLine {
  readonly lineId: string;
  readonly orderRef: string;
  readonly productId: string;
  readonly description: string;
  readonly bin: string;
  readonly requiredQty: number;
  readonly uom: string;
  readonly unitPriceMinor: number;
}

export interface WaveAssignment {
  readonly waveId: string;
  readonly storeId: string;
  readonly pickerId: string;
  readonly lines: readonly AssignedWaveLine[];
  readonly assignedBy: string;
  readonly at: string;
  /** What makes two assignments the same assignment — the picker and the lines, nothing else. */
  readonly digest: string;
}

/** One stop of a route as head office hands it to the driver — the same shape the box's pack file carried. */
export interface AssignedRouteStop {
  readonly stopId: string;
  readonly orderRef: string;
  /** A coarse area label. Never an address record on a driver's phone (§31). */
  readonly area: string;
  readonly codMinor: number;
  readonly costMinor?: number;
  readonly orderValueMinor?: number;
}

export interface RouteAssignment {
  readonly routeId: string;
  readonly storeId: string;
  readonly driverId: string;
  readonly stops: readonly AssignedRouteStop[];
  readonly contributionRule?: { readonly maxCostShareBps: number };
  readonly assignedBy: string;
  readonly at: string;
  readonly digest: string;
}

type Permissions = (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;

export interface AssignmentsDeps {
  readonly permissionsOfUser: Permissions;
  /** Every wave assignment recorded for a store, oldest first (append-only — a wave may appear more than once). */
  readonly waveAssignments: (tenantId: string, storeId: string) => Promise<readonly WaveAssignment[]> | readonly WaveAssignment[];
  readonly recordWaveAssignment: (tenantId: string, a: WaveAssignment) => Promise<void> | void;
  readonly routeAssignments: (tenantId: string, storeId: string) => Promise<readonly RouteAssignment[]> | readonly RouteAssignment[];
  readonly recordRouteAssignment: (tenantId: string, a: RouteAssignment) => Promise<void> | void;
  /** True when the wave register already holds this wave's pack — the work is done. */
  readonly wavePacked: (tenantId: string, waveId: string) => Promise<boolean> | boolean;
  /** True when the route register already holds this route's settlement — the shift is done. */
  readonly routeSettled: (tenantId: string, routeId: string) => Promise<boolean> | boolean;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

/** The permission a person must hold to be handed a wave (the crate's recorder) / a route (the door's recorder). */
export const PICK_PERMISSION = 'fulfilment.pack.record';
export const DRIVE_PERMISSION = 'delivery.attempt.record';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** The content of an assignment with the clock and the author taken off — what "the same assignment" means. */
export function assignmentDigest(content: unknown): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
}

/** The latest assignment per wave, in first-seen order — the register folded to the store as it stands. */
export function latestWaves(history: readonly WaveAssignment[]): readonly WaveAssignment[] {
  const latest = new Map<string, WaveAssignment>();
  for (const a of history) latest.set(a.waveId, a);
  return [...latest.values()];
}
export function latestRoutes(history: readonly RouteAssignment[]): readonly RouteAssignment[] {
  const latest = new Map<string, RouteAssignment>();
  for (const a of history) latest.set(a.routeId, a);
  return [...latest.values()];
}

function readLines(v: unknown): readonly AssignedWaveLine[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out: AssignedWaveLine[] = [];
  const ids = new Set<string>();
  for (const l of v) {
    if (!isObj(l) || !isStr(l['lineId']) || !isStr(l['orderRef']) || !isStr(l['productId']) || !isStr(l['description']) || !isStr(l['bin'])
      || !isNonNegInt(l['requiredQty']) || l['requiredQty'] === 0 || !isStr(l['uom']) || !isNonNegInt(l['unitPriceMinor'])) return undefined;
    if (ids.has(l['lineId'])) return undefined;
    ids.add(l['lineId']);
    out.push({ lineId: l['lineId'], orderRef: l['orderRef'], productId: l['productId'], description: l['description'], bin: l['bin'], requiredQty: l['requiredQty'], uom: l['uom'], unitPriceMinor: l['unitPriceMinor'] });
  }
  return out;
}

function readStops(v: unknown): readonly AssignedRouteStop[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out: AssignedRouteStop[] = [];
  const ids = new Set<string>();
  for (const s of v) {
    if (!isObj(s) || !isStr(s['stopId']) || !isStr(s['orderRef']) || !isStr(s['area']) || !isNonNegInt(s['codMinor'])) return undefined;
    if (s['costMinor'] !== undefined && !isNonNegInt(s['costMinor'])) return undefined;
    if (s['orderValueMinor'] !== undefined && !isNonNegInt(s['orderValueMinor'])) return undefined;
    if (ids.has(s['stopId'])) return undefined;
    ids.add(s['stopId']);
    out.push({
      stopId: s['stopId'], orderRef: s['orderRef'], area: s['area'], codMinor: s['codMinor'],
      ...(isNonNegInt(s['costMinor']) ? { costMinor: s['costMinor'] } : {}),
      ...(isNonNegInt(s['orderValueMinor']) ? { orderValueMinor: s['orderValueMinor'] } : {}),
    });
  }
  return out;
}

/** Re-verify the person from THEIR grants: a 422 by name when head office is about to hand work to somebody who may not do it. */
async function requireAuthority(deps: AssignmentsDeps, tenantId: string, userId: string, permission: string, role: 'picker' | 'driver'): Promise<void> {
  const permissions = await deps.permissionsOfUser(tenantId, userId);
  if (permissions === undefined) {
    throw apiError(422, {
      code: `${role}_unknown`,
      whatHappened: `${userId} is not a person head office knows — a ${role} must exist here before work can be assigned to them.`,
      wasItSaved: 'not_saved',
      nextSafeAction: `Check the ${role}'s login id, or provision them first. Nothing was assigned.`,
    });
  }
  if (!permissions.includes(permission)) {
    throw apiError(422, {
      code: `${role}_lacks_authority`,
      whatHappened: `${userId} does not hold ${permission}, so they may not do this work — head office does not assign a ${role === 'picker' ? 'wave' : 'route'} to somebody who cannot ${role === 'picker' ? 'pick and pack it' : 'deliver it'}.`,
      wasItSaved: 'not_saved',
      nextSafeAction: `Assign it to a person with the ${role}'s role, or grant the role first. Nothing was assigned.`,
    });
  }
}

/** The open assignments for a store as the box pulls them — the pack file's `wave` / `route` shapes, with who assigned them and when. */
export async function openAssignments(deps: AssignmentsDeps, tenantId: string, storeId: string): Promise<{
  readonly waves: readonly (Omit<WaveAssignment, 'storeId' | 'digest' | 'at'> & { readonly assignedAt: string })[];
  readonly routes: readonly (Omit<RouteAssignment, 'storeId' | 'digest' | 'at'> & { readonly assignedAt: string })[];
}> {
  const waves: (Omit<WaveAssignment, 'storeId' | 'digest' | 'at'> & { readonly assignedAt: string })[] = [];
  for (const a of latestWaves(await deps.waveAssignments(tenantId, storeId))) {
    if (await deps.wavePacked(tenantId, a.waveId)) continue; // done: the crate is sealed and head office holds it
    waves.push({ waveId: a.waveId, pickerId: a.pickerId, lines: a.lines, assignedBy: a.assignedBy, assignedAt: a.at });
  }
  const routes: (Omit<RouteAssignment, 'storeId' | 'digest' | 'at'> & { readonly assignedAt: string })[] = [];
  for (const a of latestRoutes(await deps.routeAssignments(tenantId, storeId))) {
    if (await deps.routeSettled(tenantId, a.routeId)) continue; // done: the shift settled
    routes.push({ routeId: a.routeId, driverId: a.driverId, stops: a.stops, ...(a.contributionRule === undefined ? {} : { contributionRule: a.contributionRule }), assignedBy: a.assignedBy, assignedAt: a.at });
  }
  return { waves, routes };
}

export function assignmentRoutes(deps: AssignmentsDeps): readonly Route[] {
  return [
    {
      // Hand a wave to a picker. Body: { storeId, pickerId, lines: [{ lineId, orderRef, productId, description, bin, requiredQty, uom, unitPriceMinor }] }.
      api: 'API-08', method: 'POST', path: '/v1/fulfilment/waves/:waveId/assignment',
      permission: 'fulfilment.wave.assign', idempotent: true,
      handler: async (ctx) => {
        const waveId = (ctx.params['waveId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const lines = readLines(b['lines']);
        if (waveId === '' || !isStr(b['storeId']) || !isStr(b['pickerId']) || lines === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_wave_assignment',
            whatHappened: 'Assigning a wave needs the wave id in the path and { storeId, pickerId, lines: [{ lineId, orderRef, productId, description, bin, requiredQty (whole, > 0), uom, unitPriceMinor }] } — at least one line, line ids unique.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the store, the picker and the lines to pick. Nothing was assigned.',
          });
        }
        const storeId = b['storeId'];
        const pickerId = b['pickerId'];
        await requireAuthority(deps, ctx.tenantId, pickerId, PICK_PERMISSION, 'picker');
        if (await deps.wavePacked(ctx.tenantId, waveId)) {
          throw apiError(409, {
            code: 'wave_already_packed',
            whatHappened: `Wave ${waveId} has already been packed — head office holds its crate — so it cannot be assigned again.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Assign the work under a new wave id. Nothing was changed.',
          });
        }
        const digest = assignmentDigest({ pickerId, lines });
        const history = await deps.waveAssignments(ctx.tenantId, storeId);
        const current = latestWaves(history).find((a) => a.waveId === waveId);
        if (current !== undefined && current.digest === digest) {
          return { status: 200, body: { waveId, storeId, pickerId, lineCount: lines.length, assigned: true, alreadyAssigned: true } };
        }
        const now = deps.now();
        const record: WaveAssignment = { waveId, storeId, pickerId, lines, assignedBy: ctx.userId, at: now, digest };
        await deps.recordWaveAssignment(ctx.tenantId, record);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'fulfilment.wave.assign', objectType: 'pick_wave', objectId: waveId,
          at: now, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: current === undefined ? null : { pickerId: current.pickerId, lineCount: String(current.lines.length) },
          after: { storeId, pickerId, lineCount: String(lines.length), orderRefs: [...new Set(lines.map((l) => l.orderRef))].join(','), replaced: String(current !== undefined) },
          correlationId: waveId,
        });
        return { status: 201, body: { waveId, storeId, pickerId, lineCount: lines.length, assigned: true, replaced: current !== undefined } };
      },
    },
    {
      // Hand a route to a driver. Body: { storeId, driverId, stops: [{ stopId, orderRef, area, codMinor, costMinor?, orderValueMinor? }], contributionRule? }.
      api: 'API-08', method: 'POST', path: '/v1/delivery/routes/:routeId/assignment',
      permission: 'delivery.dispatch.manage', entitlement: 'delivery', idempotent: true,
      handler: async (ctx) => {
        const routeId = (ctx.params['routeId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const stops = readStops(b['stops']);
        const rule = b['contributionRule'];
        const ruleOk = rule === undefined || (isObj(rule) && isNonNegInt(rule['maxCostShareBps']));
        if (routeId === '' || !isStr(b['storeId']) || !isStr(b['driverId']) || stops === undefined || !ruleOk) {
          throw apiError(400, {
            code: 'not_readable_as_a_route_assignment',
            whatHappened: 'Assigning a route needs the route id in the path and { storeId, driverId, stops: [{ stopId, orderRef, area, codMinor, costMinor?, orderValueMinor? }], contributionRule?: { maxCostShareBps } } — at least one stop, stop ids unique.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the store, the driver and the stops in the order to drive them. Nothing was assigned.',
          });
        }
        const storeId = b['storeId'];
        const driverId = b['driverId'];
        await requireAuthority(deps, ctx.tenantId, driverId, DRIVE_PERMISSION, 'driver');
        if (await deps.routeSettled(ctx.tenantId, routeId)) {
          throw apiError(409, {
            code: 'route_already_settled',
            whatHappened: `Route ${routeId} has already been settled at the end of a shift, so it cannot be assigned again.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Assign the stops under a new route id. Nothing was changed.',
          });
        }
        const contributionRule = isObj(rule) ? { maxCostShareBps: rule['maxCostShareBps'] as number } : undefined;
        const digest = assignmentDigest({ driverId, stops, contributionRule: contributionRule ?? null });
        const current = latestRoutes(await deps.routeAssignments(ctx.tenantId, storeId)).find((a) => a.routeId === routeId);
        if (current !== undefined && current.digest === digest) {
          return { status: 200, body: { routeId, storeId, driverId, stopCount: stops.length, assigned: true, alreadyAssigned: true } };
        }
        const now = deps.now();
        const record: RouteAssignment = { routeId, storeId, driverId, stops, ...(contributionRule === undefined ? {} : { contributionRule }), assignedBy: ctx.userId, at: now, digest };
        await deps.recordRouteAssignment(ctx.tenantId, record);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'delivery.route.assign', objectType: 'delivery_route', objectId: routeId,
          at: now, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: current === undefined ? null : { driverId: current.driverId, stopCount: String(current.stops.length) },
          after: { storeId, driverId, stopCount: String(stops.length), codMinor: String(stops.reduce((n, s) => n + s.codMinor, 0)), replaced: String(current !== undefined) },
          correlationId: routeId,
        });
        return { status: 201, body: { routeId, storeId, driverId, stopCount: stops.length, assigned: true, replaced: current !== undefined } };
      },
    },
    {
      // The OPEN assignments for a store — what the box pulls for its picker and driver phones. Done work is not listed.
      api: 'API-08', method: 'GET', path: '/v1/fulfilment/assignments',
      permission: 'fulfilment.assignment.read',
      handler: async (ctx) => {
        const storeId = (ctx.query['storeId'] ?? '').trim();
        if (storeId === '') {
          throw apiError(400, {
            code: 'not_readable_as_an_assignments_query',
            whatHappened: 'Reading a store\'s assignments needs ?storeId=.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send /v1/fulfilment/assignments?storeId=<the store>. Nothing was changed.',
          });
        }
        const open = await openAssignments(deps, ctx.tenantId, storeId);
        return { status: 200, body: { asAt: deps.now(), storeId, waves: open.waves, routes: open.routes } };
      },
    },
  ];
}
