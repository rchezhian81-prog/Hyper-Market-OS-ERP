// D-9 (R3, OB-142 "A", OB-181) — the Staff schedule page's tested, DOM-free session. A thin client over head office's
// own routes: the forecast of staff needed per role per hour of the Monday–Sunday week, the DRAFT roster that meets it
// within the working-time limits in force (every uncovered slot and every breach by name; limits not yet filled shown as
// not checked, never invented), the labour cost REPORTED (never capped), the manager's COMMIT, and actual attendance
// against the roster. Every rule is head office's; this session refuses only the cheap things before a request (no store,
// a week that is not a Monday) and never writes on open. A draft and a commit each carry their own idempotency key.

import type { ViewerIdentity } from './browser-entry';

export type Lang = 'en' | 'ta';
export type Outcome<T> =
  | { readonly result: 'ok'; readonly value: T }
  | { readonly result: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string }
  | { readonly result: 'invalid'; readonly why: ScheduleCopyKey }
  | { readonly result: 'lost_link' };

export interface DemandSlotView { readonly date: string; readonly hour: number; readonly role: string; readonly forecastBills: number; readonly staffNeeded: number }
export interface LimitView { readonly key: string; readonly label: string; readonly status: 'in_force' | 'pending'; readonly value: number | null; readonly missing?: string }
export interface DemandView {
  readonly weekStart: string; readonly weekEnd: string; readonly slots: readonly DemandSlotView[]; readonly staffHoursByRole: Readonly<Record<string, number>>;
  readonly rolesNotForecast: readonly { readonly role: string; readonly reason: string }[];
  readonly workingTime: { readonly law: string; readonly limits: readonly LimitView[]; readonly allPending: boolean };
}
export interface DraftView {
  readonly draftId: string; readonly branchId: string; readonly weekStart: string; readonly committedBy: string | null; readonly draftedBy: string;
  readonly draft: {
    readonly shifts: readonly { readonly shiftId: string; readonly date: string; readonly role: string; readonly startHour: number; readonly endHour: number }[];
    readonly assignments: readonly { readonly shiftId: string; readonly employeeId: string; readonly role: string }[];
    readonly uncovered: readonly { readonly shiftId: string; readonly date: string; readonly role: string; readonly from: string; readonly to: string; readonly reason: string; readonly detail: string }[];
    readonly breaches: readonly { readonly employeeId: string; readonly rule: string; readonly detail: string }[];
    readonly notChecked: readonly { readonly key: string; readonly label: string; readonly missing: string }[];
    readonly cost: { readonly lines: readonly { readonly employeeId: string; readonly name: string; readonly minutes: number; readonly costMinor: number | null }[]; readonly knownMinor: number; readonly notCostedPeople: readonly string[]; readonly capped: false };
    readonly staffHoursNeeded: number; readonly staffHoursRostered: number;
  };
}
export interface ActualsView {
  readonly rows: readonly { readonly employeeId: string; readonly date: string; readonly rosteredMinutes: number; readonly actualMinutes: number | null; readonly status: string; readonly source: string }[];
  readonly summary: Readonly<Record<string, number>>;
}

export const SCHEDULE_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Staff schedule',
    lead: 'Staff needed each hour of the week from the shop\'s own sales, a draft roster within the Shops Act limits, and what was actually worked. The draft changes nothing until a manager commits it.',
    branch: 'Store', week: 'Week starting (Monday)', show: 'Show the forecast', draft: 'Draft the roster', commit: 'Commit this roster', actuals: 'Show actual against roster',
    demandH: 'Staff needed', draftH: 'Draft roster', uncoveredH: 'Not covered', breachesH: 'Rule breaches', limitsH: 'Shops Act limits', costH: 'Labour cost (reported, not capped)', actualsH: 'Actual against roster',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.', cannotRead: 'Your role cannot read this.',
    needAll: 'Fill in the store and the week first. Nothing was sent.', notMonday: 'The roster week runs Monday to Sunday — pick a Monday. Nothing was sent.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
    staffHours: 'staff hours', noneUncovered: 'Every hour is covered.', noneBreaches: 'No rule is broken.', notSet: 'Service standard not set by the owner for',
    inForce: 'in force', pending: 'not filled in yet — not checked', allPending: 'The CA has not filled in the Shops Act limits yet, so none is checked. Each is named below.',
    notCosted: 'no hourly rate on file — not costed', drafted: 'Drafted. Nothing is rostered until a manager commits it.', committed: 'Committed to the roster by',
    cannotCommit: 'Only a manager can commit the roster.', needDraft: 'Draft the week first.',
    as_rostered: 'as rostered', short: 'short', over: 'over', absent: 'absent', not_recorded: 'not recorded', worked_unrostered: 'worked, not rostered',
    minutes: 'min', rostered: 'rostered', actual: 'actual',
  },
  ta: {
    lang: 'English', title: 'பணியாளர் அட்டவணை',
    lead: 'கடையின் சொந்த விற்பனையிலிருந்து வாரத்தின் ஒவ்வொரு மணிநேரத்திற்கும் தேவையான பணியாளர்கள், கடைகள் சட்ட வரம்புகளுக்குள் வரைவு அட்டவணை, உண்மையில் வேலை செய்தது. மேலாளர் உறுதிசெய்யும் வரை வரைவு எதையும் மாற்றாது.',
    branch: 'கடை', week: 'வாரம் தொடங்கும் நாள் (திங்கள்)', show: 'முன்கணிப்பைக் காட்டு', draft: 'அட்டவணையை வரைவு செய்', commit: 'இந்த அட்டவணையை உறுதிசெய்', actuals: 'அட்டவணைக்கு எதிராக உண்மையைக் காட்டு',
    demandH: 'தேவையான பணியாளர்கள்', draftH: 'வரைவு அட்டவணை', uncoveredH: 'நிரப்பப்படாதவை', breachesH: 'விதி மீறல்கள்', limitsH: 'கடைகள் சட்ட வரம்புகள்', costH: 'ஊழியர் செலவு (அறிவிக்கப்படுகிறது, வரம்பிடப்படவில்லை)', actualsH: 'அட்டவணைக்கு எதிராக உண்மை',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', cannotRead: 'உங்கள் பங்கு இதைப் படிக்க முடியாது.',
    needAll: 'முதலில் கடையையும் வாரத்தையும் நிரப்பவும். எதுவும் அனுப்பப்படவில்லை.', notMonday: 'அட்டவணை வாரம் திங்கள் முதல் ஞாயிறு வரை — ஒரு திங்களைத் தேர்ந்தெடுக்கவும். எதுவும் அனுப்பப்படவில்லை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
    staffHours: 'பணியாளர் மணிநேரம்', noneUncovered: 'ஒவ்வொரு மணிநேரமும் நிரப்பப்பட்டது.', noneBreaches: 'எந்த விதியும் மீறப்படவில்லை.', notSet: 'உரிமையாளர் சேவைத் தரத்தை அமைக்கவில்லை:',
    inForce: 'நடைமுறையில்', pending: 'இன்னும் நிரப்பப்படவில்லை — சரிபார்க்கப்படவில்லை', allPending: 'கணக்காளர் இன்னும் கடைகள் சட்ட வரம்புகளை நிரப்பவில்லை, எனவே எதுவும் சரிபார்க்கப்படவில்லை. ஒவ்வொன்றும் கீழே பெயரிடப்பட்டுள்ளது.',
    notCosted: 'மணிநேர ஊதியம் பதிவில் இல்லை — செலவிடப்படவில்லை', drafted: 'வரைவு செய்யப்பட்டது. மேலாளர் உறுதிசெய்யும் வரை யாரும் அட்டவணையில் இல்லை.', committed: 'அட்டவணையில் உறுதிசெய்தவர்',
    cannotCommit: 'மேலாளர் மட்டுமே அட்டவணையை உறுதிசெய்ய முடியும்.', needDraft: 'முதலில் வாரத்தை வரைவு செய்யவும்.',
    as_rostered: 'அட்டவணைப்படி', short: 'குறைவு', over: 'அதிகம்', absent: 'வரவில்லை', not_recorded: 'பதிவு இல்லை', worked_unrostered: 'அட்டவணையில்லாமல் வேலை',
    minutes: 'நிமி', rostered: 'அட்டவணை', actual: 'உண்மை',
  },
} as const;
export type ScheduleCopyKey = keyof typeof SCHEDULE_COPY.en;

export const scheduleWords = (lang: Lang, key: ScheduleCopyKey | string): string => (SCHEDULE_COPY[lang] as Record<string, string>)[key] ?? (SCHEDULE_COPY.en as Record<string, string>)[key] ?? key;
export function scheduleOutcomeWords(lang: Lang, out: Outcome<unknown>): string {
  if (out.result === 'refused') return `${scheduleWords(lang, 'refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return scheduleWords(lang, out.why);
  if (out.result === 'lost_link') return scheduleWords(lang, 'unreachable');
  return '';
}
export const scheduleRupees = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;
const isMonday = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(Date.parse(`${d}T00:00:00Z`)).getUTCDay() === 1;

export interface ScheduleSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly draft: boolean; readonly commit: boolean };
  demand(branchId: string, weekStart: string): Promise<Outcome<DemandView>>;
  draft(branchId: string, weekStart: string): Promise<Outcome<{ readonly draft: DraftView }>>;
  commit(draftId: string): Promise<Outcome<{ readonly draft: DraftView }>>;
  actuals(branchId: string, weekStart: string): Promise<Outcome<ActualsView>>;
}

export function createScheduleSession(input: {
  readonly viewer: ViewerIdentity | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly newKey?: () => string;
  readonly newId?: () => string;
}): ScheduleSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && perms.has('workforce.roster.read'), draft: named && perms.has('workforce.schedule.draft'), commit: named && perms.has('workforce.roster.manage') };
  const rand = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const newKey = input.newKey ?? (() => `sched-${rand()}`);
  const newId = input.newId ?? (() => `draft-${rand().slice(0, 12)}`);
  const http = input.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Outcome<T>> {
    try {
      const res = await http(path, { method, credentials: 'same-origin', headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': newKey() } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) { const err = (json['error'] ?? {}) as { code?: string; whatHappened?: string }; return { result: 'refused', status: res.status, code: err.code ?? String(res.status), whatHappened: err.whatHappened ?? `status ${res.status}` }; }
      return { result: 'ok', value: json as T };
    } catch { return { result: 'lost_link' }; }
  }
  const enc = encodeURIComponent;
  const guard = (branchId: string, weekStart: string, need: boolean): Outcome<never> | undefined => {
    if (!named) return { result: 'invalid', why: 'nobody' };
    if (!need) return { result: 'invalid', why: 'cannotRead' };
    if (branchId.trim() === '' || weekStart.trim() === '') return { result: 'invalid', why: 'needAll' };
    if (!isMonday(weekStart.trim())) return { result: 'invalid', why: 'notMonday' };
    return undefined;
  };
  const q = (b: string, w: string) => `branchId=${enc(b.trim())}&weekStart=${enc(w.trim())}`;
  return {
    may,
    demand: async (b, w) => guard(b, w, may.read) ?? call('GET', `/v1/hr/workforce/labour-demand?${q(b, w)}`),
    draft: async (b, w) => guard(b, w, may.draft) ?? call('POST', `/v1/hr/workforce/schedule-drafts/${enc(newId())}`, { branchId: b.trim(), weekStart: w.trim() }),
    commit: async (draftId) => (!named ? { result: 'invalid', why: 'nobody' } : !may.commit ? { result: 'invalid', why: 'cannotCommit' } : draftId === '' ? { result: 'invalid', why: 'needDraft' } : call('POST', `/v1/hr/workforce/schedule-drafts/${enc(draftId)}/commit`, {})),
    actuals: async (b, w) => guard(b, w, may.read) ?? call('GET', `/v1/hr/workforce/schedule/actuals?${q(b, w)}`),
  };
}
