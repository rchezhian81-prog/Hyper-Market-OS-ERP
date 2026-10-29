// Round 7 · R7-D — head office's wiring for OB-507 (rosters and attendance work offline) and OB-502 (an expired food-handling
// certificate blocks food-handling work), M25-FR-01 / M25-FR-03.
//
//   • `rosterPackSection` — the COMMITTED roster of one store for the signed store pack: its people (name, roles, still
//     employed — never a pay rate), its shifts from a week ago onwards, who is assigned to each, and which shifts belong to a
//     PUBLISHED week (OB-166 "A"; the limits not checked, OB-155). The store computer folds "my rota" from it with the same
//     function head office's own route uses (packages/workforce/src/my-roster.ts), so a member of staff sees their shift with
//     the internet down.
//   • `certificationsPackSection` — the food-handling certificates of that store's people (kind, dates, verified or not), so
//     the store computer refuses food-handling work in the name of someone whose certificate expired, offline (OB-502).
//   • `foodHandlingGateOf` — the same judgement at head office, on its own certificate register and the shop's own date.
//   • `r7dWorkforceRoutes` — the synced attendance-mark route (services/finance/src/attendance-marks-synced.ts).
// Every register stays append-only; nothing here writes anything except the relayed attendance mark (hard rule #2).

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { InMemoryEventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { certStoreAdapter, rosterStoreAdapter, permissionsHeldBy } from './adapters';
import { staffRosterVisibilityAdapter } from './r2-hr-adapters';
import { biometricConsentAdapter } from './r3-ops-adapters';
import { syncedAttendanceRoutes } from '../../finance/src/attendance-marks-synced';
import { foodHandlingVerdict, isFoodHandlingKind, FOOD_HANDLING_CERTIFICATE, type FoodHandlingTask, type FoodHandlingVerdict } from '../../../packages/workforce/src/food-handling';
import { shopClock, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;

/** How far back the pack carries a store's shifts: a week (staff look at this week and next, never last year's grid). */
export const ROSTER_PACK_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** The roster section of the store pack (read on the box by `edge/store-edge/src/workforce-pack.ts`). */
export interface RosterPackSection {
  readonly storeId: string;
  readonly asAt: string;
  readonly employees: readonly { readonly employeeId: string; readonly name: string; readonly roles: readonly string[]; readonly active: boolean }[];
  readonly shifts: readonly { readonly shiftId: string; readonly branchId: string; readonly startsAt: string; readonly endsAt: string; readonly requiredRoles: readonly { readonly role: string; readonly count: number }[] }[];
  readonly assignments: readonly { readonly shiftId: string; readonly employeeId: string; readonly role: string }[];
  /** Each shift of a week that is published now, with that week and the limits not checked when it was published. */
  readonly published: readonly { readonly shiftId: string; readonly branchId: string; readonly weekStart: string; readonly weekEnd: string; readonly limitsNotChecked: readonly string[] }[];
}

/** One store's committed roster for the pack — or undefined when head office holds no roster for it at all. */
export async function rosterPackSection(store: EventStore, now: () => string, tenantId: string, storeId: string): Promise<RosterPackSection | undefined> {
  const roster = await rosterStoreAdapter({ store, now }).roster(tenantId);
  const employees = roster.employees.filter((e) => e.branchId === storeId);
  const since = Date.parse(now()) - ROSTER_PACK_LOOKBACK_MS;
  const shifts = roster.shifts.filter((s) => s.branchId === storeId && !(Date.parse(s.endsAt) < since));
  if (employees.length === 0 && shifts.length === 0) return undefined;
  const shiftIds = new Set(shifts.map((s) => s.shiftId));
  const visibility = await staffRosterVisibilityAdapter({ store, now })(tenantId, roster);
  return {
    storeId, asAt: now(),
    employees: employees.map((e) => ({ employeeId: e.employeeId, name: e.name, roles: [...e.roles], active: e.active })),
    shifts: shifts.map((s) => ({ shiftId: s.shiftId, branchId: s.branchId, startsAt: s.startsAt, endsAt: s.endsAt, requiredRoles: s.requiredRoles.map((r) => ({ role: r.role, count: r.count })) })),
    assignments: roster.assignments.filter((a) => shiftIds.has(a.shiftId)).map((a) => ({ shiftId: a.shiftId, employeeId: a.employeeId, role: a.role })),
    published: [...visibility.visible].filter(([shiftId]) => shiftIds.has(shiftId))
      .map(([shiftId, w]) => ({ shiftId, branchId: w.branchId, weekStart: w.weekStart, weekEnd: w.weekEnd, limitsNotChecked: w.limitsNotChecked.map((l) => l.label) }))
      .sort((a, b) => a.shiftId.localeCompare(b.shiftId)),
  };
}

/** The certificates section of the store pack: the food-handling certificates of one store's people. */
export interface CertificationsPackSection {
  readonly asAt: string;
  /** The kind food-handling work needs (OB-502). */
  readonly foodHandlingKind: string;
  readonly certifications: readonly { readonly certificationId: string; readonly employeeId: string; readonly kind: string; readonly issuedOn: string; readonly validUntil: string; readonly verifiedBy?: string }[];
}

/** Always sent once the store has people on the roster — "nobody holds a certificate" is a fact, and it blocks. */
export async function certificationsPackSection(store: EventStore, now: () => string, tenantId: string, storeId: string): Promise<CertificationsPackSection | undefined> {
  const people = new Set((await rosterStoreAdapter({ store, now }).roster(tenantId)).employees.filter((e) => e.branchId === storeId).map((e) => e.employeeId));
  if (people.size === 0) return undefined;
  const certs = (await certStoreAdapter({ store, now }).certifications(tenantId))
    .filter((c) => people.has(c.employeeId) && isFoodHandlingKind(c.kind)) // OB-522: FoSTaC counts as food handling
    .sort((a, b) => a.certificationId.localeCompare(b.certificationId));
  return {
    asAt: now(), foodHandlingKind: FOOD_HANDLING_CERTIFICATE,
    certifications: certs.map((c) => ({ certificationId: c.certificationId, employeeId: c.employeeId, kind: c.kind, issuedOn: c.issuedOn, validUntil: c.validUntil, ...(c.verifiedBy === undefined ? {} : { verifiedBy: c.verifiedBy }) })),
  };
}

/** OB-502 at head office: the person's staff record and food-handling certificates, judged on the shop's date of `at`. */
export function foodHandlingGateOf(input: { readonly store: EventStore; readonly now: () => string; readonly calendar?: ShopCalendarOf }):
  (tenantId: string, personId: string, task: FoodHandlingTask, at: string) => Promise<FoodHandlingVerdict> {
  const certs = certStoreAdapter({ store: input.store, now: input.now });
  const clock = shopClock(input.calendar);
  return async (tenantId, personId, task, at) => foodHandlingVerdict({
    personId, employee: await certs.employee(tenantId, personId), certifications: await certs.certifications(tenantId, personId),
    today: await clock.dateOf(tenantId, at), task,
  });
}

/** Wrap a production (or weighed-run) deps object with the OB-502 gate — one call where main.ts composes the routes. */
export function withFoodHandlingGate<D extends object>(deps: D, store: EventStore | undefined, now: () => string, calendar?: ShopCalendarOf): D {
  return store === undefined ? deps : { ...deps, foodHandling: foodHandlingGateOf({ store, now, ...(calendar === undefined ? {} : { calendar }) }) };
}

/** The routes this package adds to head office — one registration line in main.ts. */
export function r7dWorkforceRoutes(input: { readonly store: EventStore | undefined; readonly now: () => string; readonly recordAudit?: Recorder; readonly calendar?: ShopCalendarOf }): readonly Route[] {
  const store = input.store ?? new InMemoryEventStore();
  const marks = biometricConsentAdapter({ store, now: input.now });
  return [
    ...syncedAttendanceRoutes({
      now: input.now, marks: marks.marks, recordMark: marks.recordMark, employees: marks.employees,
      ...(marks.rosteredShifts === undefined ? {} : { rosteredShifts: marks.rosteredShifts }),
      permissionsOf: (tenantId, userId) => permissionsHeldBy(store, tenantId, userId),
      ...(input.calendar === undefined ? {} : { calendar: input.calendar }),
      ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
    }),
  ];
}
