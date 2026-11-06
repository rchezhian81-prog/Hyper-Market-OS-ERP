// The Staff list and shifts page (Round 4c · M25-FR-01 · §28 · P-04 · hard rule #2) — a tested, DOM-free session over head
// office's durable roster store (services/finance/src/roster-store.ts), whose two writes had no screen:
//   • the STAFF LIST — `GET /v1/hr/workforce/roster`; add a person or change their record (`POST …/employees/:employeeId`:
//     name, store, the roles they work as, active). A person who leaves is marked LEFT — kept, never deleted (hard rule #2) —
//     and stops being cover on the rota;
//   • SHIFTS — create a shift (`POST …/shifts/:shiftId`: store, start and end on the shop's clock, and the roles it cannot run
//     without, each with how many). Putting a person on a short shift stays the Rota page's job.
// Rota, Staff certificates, Appointment letters and the Staff schedule all read this list. Writes need
// `workforce.roster.manage` (the owner, the store manager) and head office keeps each to the stores the person holds; every
// change is recorded in the audit trail. The pay rate is not on this page (payroll's). Head office's own sentences stay in
// English (OB-553); every word this page adds has a Tamil twin.

import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';
import { instantOfTyped, shopDateTimeOf, servedShopZone } from '../../../packages/calendar/src/shop-day';

export type Lang = 'en' | 'ta';

export const STAFF_COPY = {
  en: {
    title: 'Staff list and shifts',
    lead: 'Everyone who works in the shop, the roles they work as, and the shifts the rota is built on. A person who leaves is marked as left — kept on record, never deleted — and is no longer cover. Every change is recorded with your name.',
    listH: 'Staff list', listLead: 'Who works here now, and who has left.',
    addH: 'Add a person, or change one', addLead: 'Their staff id is the one they sign in with. Roles: the jobs they work as on a shift (for example cashier, picker), comma between.',
    shiftsH: 'Shifts', shiftsLead: 'Each shift and the roles it cannot run without. Put people on a short shift from the Rota page.',
    newShiftH: 'Create a shift', newShiftLead: 'Times are the shop\'s clock. Needs: role and how many, for example "cashier 2, picker 1".',
    id: 'Staff id', name: 'Full name', store: 'Store', roles: 'Roles', save: 'Save this person', left: 'Mark as left', back: 'Back at work', change: 'Change',
    starts: 'Starts', ends: 'Ends', needs: 'Needs', createShift: 'Create the shift',
    working: 'working', hasLeft: 'left — kept on record, not cover', roleWords: 'works as', at: 'at', none: 'Nobody is on the staff list yet.', noShifts: 'No shift is set yet.',
    saved: 'Saved.', shiftSaved: 'Shift created.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see the staff list.', cannotManage: 'You can see the list; changing it needs the manager\'s permission.',
    needId: 'Type the person\'s staff id.', needName: 'Type the person\'s full name.', needStore: 'Name the store.', needRoles: 'Name at least one role they work as.',
    needTimes: 'Give the start and the end, on the shop\'s clock.', endsFirst: 'The shift must end after it starts.', needNeeds: 'Say which roles the shift needs and how many, e.g. "cashier 2".',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.', reading: 'Reading from head office…',
  },
  ta: {
    title: 'பணியாளர் பட்டியலும் ஷிப்டுகளும்',
    lead: 'கடையில் பணிபுரியும் அனைவரும், அவர்கள் செய்யும் பணிகள், பணி முறை அமைக்கப்படும் ஷிப்டுகள். வெளியேறியவர் "வெளியேறினார்" எனக் குறிக்கப்படுவார் — பதிவில் வைக்கப்படும், நீக்கப்படாது — இனி அவர் ஆள் அல்ல. ஒவ்வொரு மாற்றமும் உங்கள் பெயருடன் பதிவாகும்.',
    listH: 'பணியாளர் பட்டியல்', listLead: 'இப்போது இங்கே பணிபுரிபவர்களும், வெளியேறியவர்களும்.',
    addH: 'ஒருவரைச் சேர், அல்லது மாற்று', addLead: 'அவர் உள்நுழையும் அடையாளமே அவரது பணியாளர் அடையாளம். பணிகள்: ஷிப்டில் அவர் செய்யும் வேலைகள் (உதாரணமாக cashier, picker), காற்புள்ளியுடன்.',
    shiftsH: 'ஷிப்டுகள்', shiftsLead: 'ஒவ்வொரு ஷிப்டும், அது இல்லாமல் நடக்க முடியாத பணிகளும். குறைவான ஷிப்டில் ஆட்களைப் பணி முறை பக்கத்திலிருந்து வையுங்கள்.',
    newShiftH: 'ஒரு ஷிப்டை உருவாக்கு', newShiftLead: 'நேரங்கள் கடையின் கடிகாரப்படி. தேவைகள்: பணியும் எத்தனை பேர் என்றும், உதாரணமாக "cashier 2, picker 1".',
    id: 'பணியாளர் அடையாளம்', name: 'முழுப் பெயர்', store: 'கடை', roles: 'பணிகள்', save: 'இவரைச் சேமி', left: 'வெளியேறினார் எனக் குறி', back: 'மீண்டும் பணியில்', change: 'மாற்று',
    starts: 'தொடக்கம்', ends: 'முடிவு', needs: 'தேவைகள்', createShift: 'ஷிப்டை உருவாக்கு',
    working: 'பணியில்', hasLeft: 'வெளியேறினார் — பதிவில் உள்ளார், ஆள் அல்ல', roleWords: 'பணி', at: 'கடை', none: 'பணியாளர் பட்டியலில் இன்னும் யாரும் இல்லை.', noShifts: 'இன்னும் ஷிப்ட் அமைக்கப்படவில்லை.',
    saved: 'சேமிக்கப்பட்டது.', shiftSaved: 'ஷிப்ட் உருவாக்கப்பட்டது.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு பணியாளர் பட்டியலைப் பார்க்க முடியாது.', cannotManage: 'பட்டியலைப் பார்க்கலாம்; மாற்ற மேலாளர் அனுமதி தேவை.',
    needId: 'நபரின் பணியாளர் அடையாளத்தைத் தட்டச்சு செய்யுங்கள்.', needName: 'நபரின் முழுப் பெயரைத் தட்டச்சு செய்யுங்கள்.', needStore: 'கடையைக் குறிப்பிடுங்கள்.', needRoles: 'அவர் செய்யும் குறைந்தது ஒரு பணியைக் குறிப்பிடுங்கள்.',
    needTimes: 'கடையின் கடிகாரப்படி தொடக்கத்தையும் முடிவையும் தாருங்கள்.', endsFirst: 'ஷிப்ட் தொடங்கிய பின்னரே முடிய வேண்டும்.', needNeeds: 'ஷிப்டுக்கு எந்தப் பணிகள், எத்தனை பேர் தேவை என்று சொல்லுங்கள், உ-ம் "cashier 2".',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, சேமிக்கப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const staffWords = (lang: Lang, key: string): string =>
  (STAFF_COPY[lang] as Record<string, string>)[key] ?? (STAFF_COPY.en as Record<string, string>)[key] ?? key;
export const staffOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => staffWords(lang, k), out);

export interface StaffMember { readonly employeeId: string; readonly name: string; readonly branchId: string; readonly roles: readonly string[]; readonly active: boolean }
export interface Shift { readonly shiftId: string; readonly branchId: string; readonly startsAt: string; readonly endsAt: string; readonly requiredRoles: readonly { readonly role: string; readonly count: number }[]; readonly shown: string }
export interface Roster { readonly staff: readonly StaffMember[]; readonly shifts: readonly Shift[] }

type Why = 'nobody' | 'cannotRead' | 'cannotManage' | 'needId' | 'needName' | 'needStore' | 'needRoles' | 'needTimes' | 'endsFirst' | 'needNeeds';
type Done<T> = Promise<Outcome<T, Why>>;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** "cashier, picker" → ['cashier', 'picker'] (trimmed, lower case, no repeats). */
export const readRoles = (raw: string): string[] => [...new Set(raw.split(',').map((x) => x.trim().toLowerCase()).filter((x) => x !== ''))];
/** "cashier 2, picker 1" → [{ role, count }]; undefined when any piece is unreadable or a count is not a whole number above 0. */
export function readNeeds(raw: string): { role: string; count: number }[] | undefined {
  const parts = raw.split(',').map((x) => x.trim()).filter((x) => x !== '');
  if (parts.length === 0) return undefined;
  const out: { role: string; count: number }[] = [];
  for (const p of parts) {
    const m = /^([A-Za-z][A-Za-z0-9_ -]*?)\s*[x×:]?\s*(\d+)$/.exec(p);
    if (m === null || Number(m[2]) < 1) return undefined;
    out.push({ role: m[1]!.trim().toLowerCase(), count: Number(m[2]) });
  }
  return out;
}

export interface StaffSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly manage: boolean };
  roster(): Done<Roster>;
  save(input: { readonly employeeId: string; readonly name: string; readonly branchId: string; readonly roles: string; readonly active: boolean }): Done<{ readonly employee: StaffMember }>;
  /** Mark a person as left (or back at work), keeping everything else on their record as it is. */
  setActive(member: StaffMember, active: boolean): Done<{ readonly employee: StaffMember }>;
  createShift(input: { readonly branchId: string; readonly startsAt: string; readonly endsAt: string; readonly needs: string }): Done<{ readonly shiftId: string }>;
}

export function createStaffSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newId?: (prefix: string) => string; readonly timeZone?: string;
}): StaffSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('workforce.roster.read'), manage: named && held.has('workforce.roster.manage') };
  const call = makeCaller({ keyPrefix: 'staff', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const id = input.newId ?? newId;
  const zone = input.timeZone ?? servedShopZone();
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (need: 'read' | 'manage') => (!named ? no('nobody') : !may[need] ? no(need === 'read' ? 'cannotRead' : 'cannotManage') : undefined);
  const member = (e: unknown): StaffMember | undefined => (isObj(e) && isStr(e['employeeId']) && isStr(e['name']) && isStr(e['branchId']) && Array.isArray(e['roles']) && typeof e['active'] === 'boolean'
    ? { employeeId: e['employeeId'], name: e['name'], branchId: e['branchId'], roles: (e['roles'] as unknown[]).filter(isStr), active: e['active'] } : undefined);
  const post = async (m: StaffMember): Done<{ readonly employee: StaffMember }> => {
    const out = await call<{ employee?: unknown }>('POST', `/v1/hr/workforce/employees/${encodeURIComponent(m.employeeId)}`, { name: m.name, branchId: m.branchId, roles: m.roles, active: m.active });
    if (out.result !== 'ok') return out;
    const e = member(out.value.employee);
    return e === undefined ? { result: 'lost_link' } : { result: 'ok', value: { employee: e } };
  };
  return {
    may,
    roster: async () => {
      const g = gate('read'); if (g) return g;
      const out = await call<{ employees?: unknown[]; shifts?: unknown[] }>('GET', '/v1/hr/workforce/roster');
      if (out.result !== 'ok') return out;
      const staff = (out.value.employees ?? []).map(member).filter((e): e is StaffMember => e !== undefined)
        .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
      const shifts = (out.value.shifts ?? []).flatMap((s): Shift[] => {
        if (!isObj(s) || !isStr(s['shiftId']) || !isStr(s['branchId']) || !isStr(s['startsAt']) || !isStr(s['endsAt']) || !Array.isArray(s['requiredRoles'])) return [];
        const req = (s['requiredRoles'] as unknown[]).flatMap((r) => (isObj(r) && isStr(r['role']) && typeof r['count'] === 'number' ? [{ role: r['role'], count: r['count'] }] : []));
        return [{ shiftId: s['shiftId'], branchId: s['branchId'], startsAt: s['startsAt'], endsAt: s['endsAt'], requiredRoles: req,
          shown: `${shopDateTimeOf(s['startsAt'], zone)} – ${shopDateTimeOf(s['endsAt'], zone).slice(11)}` }];
      }).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      return { result: 'ok', value: { staff, shifts } };
    },
    save: async (m) => {
      const g = gate('manage'); if (g) return g;
      const roles = readRoles(m.roles);
      if (m.employeeId.trim() === '') return no('needId');
      if (m.name.trim() === '') return no('needName');
      if (m.branchId.trim() === '') return no('needStore');
      if (roles.length === 0) return no('needRoles');
      return post({ employeeId: m.employeeId.trim(), name: m.name.trim(), branchId: m.branchId.trim(), roles, active: m.active });
    },
    setActive: async (m, active) => {
      const g = gate('manage'); if (g) return g;
      return post({ ...m, active });
    },
    createShift: async (s) => {
      const g = gate('manage'); if (g) return g;
      if (s.branchId.trim() === '') return no('needStore');
      const startsAt = instantOfTyped(s.startsAt, zone); const endsAt = instantOfTyped(s.endsAt, zone);
      if (startsAt === '' || endsAt === '') return no('needTimes');
      if (Date.parse(endsAt) <= Date.parse(startsAt)) return no('endsFirst');
      const needs = readNeeds(s.needs);
      if (needs === undefined) return no('needNeeds');
      const shiftId = id('shift');
      const out = await call('POST', `/v1/hr/workforce/shifts/${encodeURIComponent(shiftId)}`, { branchId: s.branchId.trim(), startsAt, endsAt, requiredRoles: needs });
      return out.result === 'ok' ? { result: 'ok', value: { shiftId } } : out;
    },
  };
}
