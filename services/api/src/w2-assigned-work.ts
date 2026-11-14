// The Picker and the Delivery driver work only the orders assigned to them — OB-571 (owner, 31 Oct 2026, in writing — "A":
// "each with exactly the roadmap's scope and limits") · roadmap §28 "Picker/Delivery — SCOPE: Assigned orders" · M19-FR-01
// · M19-FR-03 · P-04 · hard rule #10.
//
// The two roles hold their phone's ONE job word (`fulfilment.pack.record`, `delivery.attempt.record`) — the same word the
// store manager holds for the whole store. §28 scopes the roles to ASSIGNED orders, so head office judges every route
// that word opens, and every relayed record naming the picker or driver, against its own assignment register (HA-1:
// `WaveAssigned` / `RouteAssigned`, per store, the latest per wave or route, a withdrawn route assigned to nobody):
//
//   • a person who holds the word through any OTHER role (the owner, the store manager) keeps exactly what they had;
//   • a person who holds it ONLY as a Picker may record a pick or a pack only for a wave assigned to them (or, on the
//     order routes, an order on such a wave); ONLY as a Delivery driver, a stop, a proof, a settlement, a cash handover or
//     an attempt only on a route assigned to them (or an order on such a route).
//
// Anything else is refused by name before anything is written; a relayed record so refused stays at the store as a visible
// dead letter for a person. With no store named on the request, the register cannot be read, so it is refused (fails closed).

import type { Route, RequestContext, HandlerResult } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { InMemoryEventStore, type EventStore } from '../../../packages/persistence/src/event-store';
import { latestRoutes, latestWaves } from '../../fulfilment/src/assignments';
import { assignmentsAdapter, effectiveGrants } from './adapters';
import { ROLE_CATALOGUE, PICKER_ROLE_ID, DELIVERY_ROLE_ID } from './roles';

export const PICK_WORD = 'fulfilment.pack.record';
export const DRIVE_WORD = 'delivery.attempt.record';

/** The roles held to assigned work, and the word each is held on. */
export const ASSIGNED_WORK_ROLES: Readonly<Record<string, string>> = Object.freeze({ [PICKER_ROLE_ID]: PICK_WORD, [DELIVERY_ROLE_ID]: DRIVE_WORD });

/** What a request is about: a wave, a route or an order, and who it names (absent = the signed-in caller). */
interface Subject {
  readonly word: string;
  readonly person?: string;
  readonly what: 'wave' | 'route' | 'order';
  readonly id: string | undefined;
}
type Read = (ctx: RequestContext) => Subject;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const bodyOf = (ctx: RequestContext): Record<string, unknown> =>
  (ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body as Record<string, unknown> : {});
const param = (name: string) => (ctx: RequestContext): string | undefined => str(ctx.params[name]);

/** Every route either word opens, and every relayed record naming a picker or driver — the whole list. */
export const ASSIGNED_WORK_ROUTES: Readonly<Record<string, Read>> = Object.freeze({
  // The picker's word.
  'POST /v1/fulfilment/orders/:orderId/pack': (ctx) => ({ word: PICK_WORD, what: 'order', id: param('orderId')(ctx) }),
  'POST /v1/fulfilment/orders/:orderId/dispatch': (ctx) => ({ word: PICK_WORD, what: 'order', id: param('orderId')(ctx) }),
  'POST /v1/fulfilment/waves/:waveId/lines/:lineId/synced': (ctx) => ({ word: PICK_WORD, person: str(bodyOf(ctx)['pickedBy']), what: 'wave', id: param('waveId')(ctx) }),
  'POST /v1/fulfilment/waves/:waveId/packed/synced': (ctx) => ({ word: PICK_WORD, person: str(bodyOf(ctx)['packedBy']), what: 'wave', id: param('waveId')(ctx) }),
  // OB-687: a swap put to the customer — only by the picker the wave was handed to.
  'POST /v1/fulfilment/waves/:waveId/lines/:lineId/substitution-proposal/synced': (ctx) => ({ word: PICK_WORD, person: str(bodyOf(ctx)['proposedBy']), what: 'wave', id: param('waveId')(ctx) }),
  // The driver's word.
  'POST /v1/delivery/attempts': (ctx) => ({ word: DRIVE_WORD, what: 'order', id: str(bodyOf(ctx)['orderId']) }),
  'POST /v1/delivery/orders/:orderId/transition': (ctx) => ({ word: DRIVE_WORD, what: 'order', id: param('orderId')(ctx) }),
  'POST /v1/delivery/routes/:routeId/stops/:stopId/synced': (ctx) => ({ word: DRIVE_WORD, person: str(bodyOf(ctx)['driverId']), what: 'route', id: param('routeId')(ctx) }),
  'POST /v1/delivery/routes/:routeId/stops/:stopId/proof/synced': (ctx) => ({ word: DRIVE_WORD, person: str(bodyOf(ctx)['driverId']), what: 'route', id: param('routeId')(ctx) }),
  // U6 · OB-700: the driver's request that the store call a stop's customer is driver work on the route it was assigned.
  'POST /v1/delivery/routes/:routeId/stops/:stopId/call-request/synced': (ctx) => ({ word: DRIVE_WORD, person: str(bodyOf(ctx)['driverId']), what: 'route', id: param('routeId')(ctx) }),
  'POST /v1/delivery/routes/:routeId/settled/synced': (ctx) => ({ word: DRIVE_WORD, person: str(bodyOf(ctx)['driverId']), what: 'route', id: param('routeId')(ctx) }),
  'POST /v1/delivery/routes/:routeId/handover/synced': (ctx) => ({ word: DRIVE_WORD, person: str(bodyOf(ctx)['driverId']), what: 'route', id: param('routeId')(ctx) }),
});

/** Does this person hold the word ONLY through the role held to assigned work? (The branch's grants when one is named.) */
export function heldOnlyAsAssignedWork(
  grants: readonly { readonly userId: string; readonly roleId: string; readonly branchScope: readonly string[] | 'all' }[],
  userId: string, word: string, branchId: string | null,
): string | undefined {
  const roles = new Set<string>();
  for (const g of grants) {
    if (g.userId !== userId) continue;
    if (branchId !== null && g.branchScope !== 'all' && !g.branchScope.includes(branchId)) continue;
    if ((ROLE_CATALOGUE.find((r) => r.id === g.roleId)?.permissions ?? []).includes(word)) roles.add(g.roleId);
  }
  if (roles.size === 0) return undefined;
  const narrowed = [...roles].filter((r) => ASSIGNED_WORK_ROLES[r] === word);
  return narrowed.length === roles.size ? narrowed[0] : undefined;
}

const notAssigned = (userId: string, roleId: string, s: Subject, store: string | null, relayed: boolean): Error => {
  const role = ROLE_CATALOGUE.find((r) => r.id === roleId)?.name ?? roleId;
  const work = s.word === PICK_WORD ? 'a wave' : 'a route';
  return apiError(403, {
    code: 'not_assigned_to_you',
    whatHappened: store === null
      ? `${userId} works as a ${role} only on ${work} assigned to them, and this request names no store, so head office cannot see what is assigned (§28 "assigned orders", owner decision OB-571).`
      : `${userId} works as a ${role} only on ${work} assigned to them; ${s.what} ${s.id ?? '(none named)'} at ${store} is not (§28 "assigned orders", owner decision OB-571).`,
    wasItSaved: 'not_saved',
    nextSafeAction: relayed
      ? 'Do not discard it at the store: it stays in the queue for a person. The store manager assigns the work to them, or records it. Nothing was changed.'
      : 'Ask the store manager to assign it to you, or to record it. Nothing was changed.',
  });
};

/** Wrap every route the two words open, and every relayed record naming a picker or driver, with the §28 scope. */
export function assignedWorkSurface(surface: Route[], input: { readonly store?: EventStore; readonly now?: () => string }): void {
  const store = input.store ?? new InMemoryEventStore();
  const register = assignmentsAdapter({ store, now: input.now ?? (() => new Date().toISOString()) });
  const isAssigned = async (tenantId: string, storeId: string, userId: string, s: Subject): Promise<boolean> => {
    if (s.id === undefined) return false;
    if (s.word === PICK_WORD) {
      const waves = latestWaves(await register.waveAssignments(tenantId, storeId)).filter((w) => w.pickerId === userId);
      return s.what === 'wave' ? waves.some((w) => w.waveId === s.id) : waves.some((w) => w.lines.some((l) => l.orderRef === s.id));
    }
    const routes = latestRoutes(await register.routeAssignments(tenantId, storeId)).filter((r) => r.driverId === userId && r.withdrawn === undefined);
    return s.what === 'route' ? routes.some((r) => r.routeId === s.id) : routes.some((r) => r.stops.some((x) => x.orderRef === s.id));
  };
  for (let i = 0; i < surface.length; i += 1) {
    const route = surface[i]!;
    const read = ASSIGNED_WORK_ROUTES[`${route.method} ${route.path}`];
    if (read === undefined) continue;
    const inner = route.handler;
    surface[i] = {
      ...route,
      handler: async (ctx): Promise<HandlerResult> => {
        const s = read(ctx);
        const relayed = s.person !== undefined || route.path.endsWith('/synced');
        const who = relayed ? s.person : ctx.userId;
        if (who !== undefined) {
          const branchId = ctx.branchId ?? null;
          const roleId = heldOnlyAsAssignedWork(await effectiveGrants(store, ctx.tenantId), who, s.word, branchId);
          if (roleId !== undefined && (branchId === null || !(await isAssigned(ctx.tenantId, branchId, who, s)))) {
            throw notAssigned(who, roleId, s, branchId, relayed);
          }
        }
        return inner(ctx);
      },
    };
  }
}
