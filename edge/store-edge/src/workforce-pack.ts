// Round 7 · R7-D — the store computer's own copy of the roster and the food-handling certificates, from the SIGNED store pack
// (OB-507 · OB-502 · M25-FR-01/03 · P-01 · P-08).
//
//   • "My rota" with the internet down: the box folds a person's own shifts from the committed roster head office put in the
//     pack, with the SAME fold head office's `GET /v1/hr/workforce/my-roster` runs (packages/workforce/src/my-roster.ts), and
//     says how old it is. Only published weeks are shown.
//   • An expired or missing food-handling certificate blocks recording food-handling work here too, offline: the box judges a
//     production / bakery / counter-food run in a person's name against the certificates in the pack, on the shop's own date,
//     with the same rule head office uses (packages/workforce/src/food-handling.ts). A pack that carried no certificates
//     cannot show any certificate is valid, so the work is refused and the reason said (fail closed, never a silent pass).
// Each section is read strictly: a malformed one is treated as not told, never half-trusted. Pure: no I/O, no clock.

import type { StorePack } from './store-pack';
import { packCalendarDate } from './shop-zone';
import { myRosterFrom, type MyRoster, type PublishedWeek } from '../../../packages/workforce/src/my-roster';
import { foodHandlingVerdict, type FoodHandlingTask, type FoodHandlingVerdict } from '../../../packages/workforce/src/food-handling';
import { rosterGaps, type Certification, type Employee, type RosterGap, type ShiftAssignment, type ShiftRequirement } from '../../../packages/workforce/src/workforce';

export interface PackRoster {
  readonly storeId: string;
  readonly asAt: string;
  readonly employees: readonly Employee[];
  readonly shifts: readonly ShiftRequirement[];
  readonly assignments: readonly ShiftAssignment[];
  readonly published: ReadonlyMap<string, PublishedWeek>;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** The roster section, read strictly — or undefined when the pack did not carry one it could be read as. */
export function packRoster(pack: Pick<StorePack, 'roster'>): PackRoster | undefined {
  const reg = pack.roster;
  if (reg === undefined || !reg.known || !isObj(reg.value)) return undefined;
  const r = reg.value;
  if (!isStr(r['storeId']) || !isTime(r['asAt']) || !Array.isArray(r['employees']) || !Array.isArray(r['shifts']) || !Array.isArray(r['assignments']) || !Array.isArray(r['published'])) return undefined;
  const employees: Employee[] = [];
  for (const e of r['employees'] as unknown[]) {
    if (!isObj(e) || !isStr(e['employeeId']) || typeof e['name'] !== 'string' || !strs(e['roles']) || typeof e['active'] !== 'boolean') return undefined;
    employees.push({ employeeId: e['employeeId'], name: e['name'], branchId: r['storeId'], roles: e['roles'], active: e['active'] });
  }
  const shifts: ShiftRequirement[] = [];
  for (const s of r['shifts'] as unknown[]) {
    if (!isObj(s) || !isStr(s['shiftId']) || !isStr(s['branchId']) || !isTime(s['startsAt']) || !isTime(s['endsAt']) || !Array.isArray(s['requiredRoles'])) return undefined;
    const requiredRoles = (s['requiredRoles'] as unknown[]).filter((x): x is { role: string; count: number } => isObj(x) && isStr(x['role']) && Number.isInteger(x['count']));
    shifts.push({ shiftId: s['shiftId'], branchId: s['branchId'], startsAt: s['startsAt'], endsAt: s['endsAt'], requiredRoles });
  }
  const assignments: ShiftAssignment[] = [];
  for (const a of r['assignments'] as unknown[]) {
    if (!isObj(a) || !isStr(a['shiftId']) || !isStr(a['employeeId']) || !isStr(a['role'])) return undefined;
    assignments.push({ shiftId: a['shiftId'], employeeId: a['employeeId'], role: a['role'] });
  }
  const published = new Map<string, PublishedWeek>();
  for (const p of r['published'] as unknown[]) {
    if (!isObj(p) || !isStr(p['shiftId']) || !isStr(p['branchId']) || !isDay(p['weekStart']) || !isDay(p['weekEnd']) || !strs(p['limitsNotChecked'])) return undefined;
    published.set(p['shiftId'], { branchId: p['branchId'], weekStart: p['weekStart'], weekEnd: p['weekEnd'], limitsNotChecked: p['limitsNotChecked'] });
  }
  return { storeId: r['storeId'], asAt: r['asAt'], employees, shifts, assignments, published };
}

/** One person's own rota as the box holds it, with when head office last said so — or null when the box was not told. */
export function myRosterOnBox(pack: Pick<StorePack, 'roster'>, userId: string): (MyRoster & { readonly asAt: string }) | null {
  const roster = packRoster(pack);
  if (roster === undefined) return null;
  return { ...myRosterFrom({ employeeId: userId, employees: roster.employees, shifts: roster.shifts, assignments: roster.assignments, visible: roster.published }), asAt: roster.asAt };
}

/**
 * Round 8 · OB-531 (M25-FR-01 · P-01 · P-08): the manager's rostering screen, when head office cannot be reached, shows THIS —
 * the store computer's copy of the roster from the signed pack, READ-ONLY, with when head office last sent it. The gaps are
 * folded with the same engine head office's `/roster-gaps` uses (`rosterGaps`). No pay rate travels (the pack carries none).
 * Null when the pack carried no roster the box could read (said, never an empty rota). Editing still needs head office.
 */
export interface RosterCopyOnBox {
  readonly storeId: string;
  readonly asAt: string;
  readonly employees: readonly Employee[];
  readonly shifts: readonly ShiftRequirement[];
  readonly assignments: readonly ShiftAssignment[];
  readonly gaps: readonly RosterGap[];
}
export function rosterCopyOnBox(pack: Pick<StorePack, 'roster'>): RosterCopyOnBox | null {
  const roster = packRoster(pack);
  if (roster === undefined) return null;
  const gaps = rosterGaps({ shifts: roster.shifts, assignments: roster.assignments, employees: roster.employees });
  return { storeId: roster.storeId, asAt: roster.asAt, employees: roster.employees, shifts: roster.shifts, assignments: roster.assignments, gaps };
}

/** The certificates section, read strictly — or undefined when the pack carried none it could be read as. */
export function packCertifications(pack: Pick<StorePack, 'certifications'>): { readonly asAt: string; readonly certifications: readonly Certification[] } | undefined {
  const reg = pack.certifications;
  if (reg === undefined || !reg.known || !isObj(reg.value)) return undefined;
  const c = reg.value;
  if (!isTime(c['asAt']) || !Array.isArray(c['certifications'])) return undefined;
  const out: Certification[] = [];
  for (const x of c['certifications'] as unknown[]) {
    if (!isObj(x) || !isStr(x['certificationId']) || !isStr(x['employeeId']) || !isStr(x['kind']) || !isDay(x['issuedOn']) || !isDay(x['validUntil'])) return undefined;
    out.push({ certificationId: x['certificationId'], employeeId: x['employeeId'], kind: x['kind'], issuedOn: x['issuedOn'], validUntil: x['validUntil'], ...(isStr(x['verifiedBy']) ? { verifiedBy: x['verifiedBy'] } : {}) });
  }
  return { asAt: c['asAt'], certifications: out };
}

/** Why the box cannot judge a certificate at all: the pack carried no certificates (or no roster) it could read. */
export const NOT_TOLD_CERTIFICATES = {
  code: 'food_handling_certificates_not_known_here',
  en: 'This store computer has not been told the food-handling certificates yet, so it cannot show this person\'s certificate is valid. Food-handling work cannot be recorded here until head office sends them (connect the store computer, or record the run at head office). Nothing was saved.',
  ta: 'உணவு கையாளும் சான்றிதழ்கள் இன்னும் இந்தக் கடைக் கணினிக்குச் சொல்லப்படவில்லை; இவரின் சான்றிதழ் செல்லுபடியானது எனக் காட்ட முடியாது. தலைமை அலுவலகம் அவற்றை அனுப்பும் வரை இங்கு உணவு கையாளும் பதிவு செய்ய முடியாது. எதுவும் சேமிக்கப்படவில்லை.',
} as const;

export type BoxFoodHandlingVerdict = FoodHandlingVerdict | { readonly allowed: false; readonly code: typeof NOT_TOLD_CERTIFICATES.code; readonly words: { readonly en: string; readonly ta: string } };

/** OB-502 on the box: may food-handling work be recorded in this person's name on `today` (the shop's own date)? */
export function foodHandlingOnBox(pack: Pick<StorePack, 'roster' | 'certifications'>, personId: string, task: FoodHandlingTask, today: string): BoxFoodHandlingVerdict {
  const roster = packRoster(pack);
  const certs = packCertifications(pack);
  if (roster === undefined || certs === undefined) return { allowed: false, code: NOT_TOLD_CERTIFICATES.code, words: { en: NOT_TOLD_CERTIFICATES.en, ta: NOT_TOLD_CERTIFICATES.ta } };
  return foodHandlingVerdict({ personId, employee: roster.employees.find((e) => e.employeeId === personId), certifications: certs.certifications, today, task });
}

/**
 * OB-502 at the box's door (`/lane/outbox`): a production run or a weighed (counter-food) run handed over by a served screen
 * is judged BEFORE the disk against the person it names. Returns the refusal in words, or undefined when it may be kept.
 * `departmentOfRecipe` reads the recipes head office last sent (an unknown recipe is treated as food — fail closed);
 * `dateOf` gives the shop's own date for an instant.
 */
export function foodHandlingRefusalAtTheDoor(input: {
  readonly pack: Pick<StorePack, 'roster' | 'certifications'>;
  readonly event: { readonly type: string; readonly payload: unknown };
  readonly departmentOfRecipe: (recipeId: string) => string | undefined;
  readonly handlesFood: (departmentId: string) => boolean;
  readonly dateOf: (isoInstant: string) => string;
  readonly now: string;
}): string | undefined {
  const p = isObj(input.event.payload) ? input.event.payload : {};
  let person: unknown;
  let department: string | undefined;
  let task: FoodHandlingTask;
  if (input.event.type === 'ProductionRunCaptured') {
    person = p['producedBy']; task = 'production_run';
    department = isStr(p['recipeId']) ? input.departmentOfRecipe(p['recipeId']) : undefined;
  } else if (input.event.type === 'WeighedRunCaptured') {
    person = p['weighedBy']; task = 'weighed_run';
    department = isStr(p['departmentId']) ? p['departmentId'] : undefined;
  } else {
    return undefined;
  }
  if (department !== undefined && !input.handlesFood(department)) return undefined;
  if (!isStr(person)) return 'The run does not say who made it, so the food-handling certificate cannot be checked. Nothing was saved.';
  const at = isTime(p['at']) ? (p['at'] as string) : input.now;
  const verdict = foodHandlingOnBox(input.pack, person, task, input.dateOf(at));
  return verdict.allowed ? undefined : `${verdict.code}: ${verdict.words.en} / ${verdict.words.ta}`;
}

/** What a served screen is told about its viewer's food-handling certificate (OB-502) — judged on the shop's date of `now`. */
export function foodHandlingForViewer(pack: Pick<StorePack, 'roster' | 'certifications' | 'policies'>, userId: string, now: string): Record<string, unknown> {
  const verdict = foodHandlingOnBox(pack, userId, 'production_run', packCalendarDate(pack, now));
  return verdict.allowed
    ? { allowed: true, validUntil: verdict.validUntil }
    : { allowed: false, code: verdict.code, words: verdict.words, ...('expiredOn' in verdict && verdict.expiredOn !== undefined ? { expiredOn: verdict.expiredOn } : {}) };
}
