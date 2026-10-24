// The Training and adoption page (QG-09 · M25-FR-01/03 · D11-FR-04 · OB-317 · OB-320). A tested, DOM-free session.
//
//   • QG-09 — the adoption gate, read from head office's records: GO, HOLD (every missing name) or NOT PROVEN (a role's
//     curriculum not yet approved by the owner).
//   • THE ROLE CURRICULUM (OB-320) — proposed from the shop's own SOP sheets and the owner guide, one list per role; the
//     owner ticks the items and approves the list on screen; until he does, it does not count.
//   • TRAINING — assign a curriculum item; the trainer records it done; a SECOND person signs competency.
//   • FLOOR CHAMPIONS — one per department, named by the owner ("not set" until he does).
//   • ACCESS AGAINST ASSIGNMENT — every difference between the staff list and the sign-in grants, worst first.
//   • SALES PER LABOUR HOUR (OB-317) — from the roster and the banked bills; per department, the hours are "not
//     attributed" until the owner decides how an hour belongs to a department.
// Every act is a person's click in their own name; head office re-checks it.

import { makeCaller, newId, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const ADOPTION_COPY = {
  en: {
    title: 'Training and adoption', lead: 'The adoption gate (QG-09), the role curriculum the owner approves, training with a second person\'s sign-off, floor champions, access against the staff list, and sales per labour hour.',
    gateH: 'Adoption gate (QG-09)', GO: 'GO — every role ready', HOLD: 'HOLD — something is missing', NOT_PROVEN: 'Not proven — a role\'s curriculum is not approved', readGate: 'Read the gate', allClear: 'Nothing is missing.',
    role: 'Role', people: 'People', curriculum: 'Curriculum', approvedV: 'approved, version', notApproved: 'not approved', missing: 'Missing',
    notCompetent: 'not signed competent:', notAcknowledged: 'not acknowledged:',
    curriculumH: 'Role curriculum (the owner approves)', proposed: 'Proposed from the shop\'s sheets', approve: 'Approve this list', approvedBy: 'Approved by',
    trainingH: 'Training', employee: 'Staff id', item: 'Curriculum item', due: 'Due day', assign: 'Assign', done: 'Record done', competent: 'Sign competent', notYet: 'Not yet',
    s_assigned: 'Assigned', s_overdue: 'Overdue', s_completed: 'Done — waiting for a second person', s_competent: 'Competent', s_not_yet_competent: 'Not yet competent',
    trainingNone: 'No training is assigned.', championsH: 'Floor champions', champion: 'Champion (staff id)', name: 'Name it', notSet: 'not set', championLeft: 'has left the staff list',
    accessH: 'Access against the staff list', checkAccess: 'Check access', accessClear: 'Everyone\'s access matches their assignment.', critical: 'Critical', warning: 'Warning', info: 'Note',
    productivityH: 'Sales per labour hour', from: 'From', to: 'To', readProductivity: 'Work it out', store: 'Whole store', perHour: 'per labour hour', hours: 'rostered hours', notAttributed: 'hours not attributed to departments yet (an owner decision)',
    noRate: 'no rate —', unowned: 'Sales no department owns:',
    nobody: 'Nobody is signed in on this screen — you can read nothing.', cannotRead: 'Your role cannot open this page.', saved: 'Saved.', needFields: 'Fill in every field first.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    title: 'பயிற்சி மற்றும் ஏற்பு', lead: 'ஏற்பு வாயில் (QG-09), உரிமையாளர் ஒப்புதல் தரும் பணிப் பாடத்திட்டம், இரண்டாவது நபர் கையொப்பமிடும் பயிற்சி, தளச் சாம்பியன்கள், பணியாளர் பட்டியலுக்கு எதிரான அணுகல், உழைப்பு மணிக்கு விற்பனை.',
    gateH: 'ஏற்பு வாயில் (QG-09)', GO: 'GO — ஒவ்வொரு பணியும் தயார்', HOLD: 'HOLD — ஏதோ குறைவு', NOT_PROVEN: 'நிரூபிக்கப்படவில்லை — ஒரு பணியின் பாடத்திட்டத்துக்கு ஒப்புதல் இல்லை', readGate: 'வாயிலைப் படி', allClear: 'எதுவும் குறைவில்லை.',
    role: 'பணி', people: 'நபர்கள்', curriculum: 'பாடத்திட்டம்', approvedV: 'ஒப்புதல், பதிப்பு', notApproved: 'ஒப்புதல் இல்லை', missing: 'குறைவு',
    notCompetent: 'திறமை கையொப்பம் இல்லை:', notAcknowledged: 'ஏற்கவில்லை:',
    curriculumH: 'பணிப் பாடத்திட்டம் (உரிமையாளர் ஒப்புதல்)', proposed: 'கடையின் தாள்களிலிருந்து முன்மொழியப்பட்டது', approve: 'இந்தப் பட்டியலுக்கு ஒப்புதல்', approvedBy: 'ஒப்புதல் அளித்தவர்',
    trainingH: 'பயிற்சி', employee: 'பணியாளர் எண்', item: 'பாடத்திட்ட உருப்படி', due: 'கடைசி நாள்', assign: 'ஒதுக்கு', done: 'முடிந்தது எனப் பதிவு', competent: 'திறமை என கையொப்பம்', notYet: 'இன்னும் இல்லை',
    s_assigned: 'ஒதுக்கப்பட்டது', s_overdue: 'தாமதம்', s_completed: 'முடிந்தது — இரண்டாவது நபருக்காகக் காத்திருக்கிறது', s_competent: 'திறமையானவர்', s_not_yet_competent: 'இன்னும் திறமை இல்லை',
    trainingNone: 'எந்தப் பயிற்சியும் ஒதுக்கப்படவில்லை.', championsH: 'தளச் சாம்பியன்கள்', champion: 'சாம்பியன் (பணியாளர் எண்)', name: 'பெயரிடு', notSet: 'அமைக்கப்படவில்லை', championLeft: 'பணியாளர் பட்டியலில் இல்லை',
    accessH: 'பணியாளர் பட்டியலுக்கு எதிரான அணுகல்', checkAccess: 'அணுகலைச் சரிபார்', accessClear: 'அனைவரின் அணுகலும் அவர்களின் பணியுடன் பொருந்துகிறது.', critical: 'அவசரம்', warning: 'எச்சரிக்கை', info: 'குறிப்பு',
    productivityH: 'உழைப்பு மணிக்கு விற்பனை', from: 'முதல்', to: 'வரை', readProductivity: 'கணக்கிடு', store: 'முழுக் கடை', perHour: 'ஒரு உழைப்பு மணிக்கு', hours: 'பணி முறை மணிகள்', notAttributed: 'மணிகள் இன்னும் பிரிவுகளுக்கு ஒதுக்கப்படவில்லை (உரிமையாளர் முடிவு)',
    noRate: 'விகிதம் இல்லை —', unowned: 'எந்தப் பிரிவுக்கும் சொந்தமில்லாத விற்பனை:',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்க முடியாது.', cannotRead: 'உங்கள் பங்கு இந்தப் பக்கத்தைத் திறக்க முடியாது.', saved: 'சேமிக்கப்பட்டது.', needFields: 'முதலில் எல்லா இடங்களையும் நிரப்பவும்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const adoptionWords = (lang: Lang, key: string): string =>
  (ADOPTION_COPY[lang] as Record<string, string>)[key] ?? (ADOPTION_COPY.en as Record<string, string>)[key] ?? key;

export function adoptionOutcomeWords(lang: Lang, out: Outcome<unknown>): string {
  const w = (k: string) => adoptionWords(lang, k);
  if (out.result === 'refused') return `${w('refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return w(out.why);
  if (out.result === 'lost_link') return w('unreachable');
  return w('saved');
}

export const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const hoursOf = (minutes: number): string => `${Number((minutes / 60).toFixed(2))}`;

export interface CurriculumItem { readonly itemId: string; readonly title: string; readonly titleTa?: string; readonly source: string }
export interface GateRead {
  readonly verdict: 'GO' | 'HOLD' | 'NOT_PROVEN'; readonly why: readonly string[];
  readonly roles: readonly { readonly roleId: string; readonly verdict: string; readonly people: number; readonly curriculum: { readonly approved: boolean; readonly version?: number }; readonly gaps: readonly { readonly employeeId: string; readonly name: string; readonly notCompetent: readonly string[]; readonly notAcknowledged: readonly string[] }[] }[];
  readonly floorSupport: { readonly complete: boolean; readonly departments: readonly { readonly departmentId: string; readonly name: string; readonly champion: string | null; readonly championName: string | null; readonly state: string }[] };
}

export interface AdoptionSession {
  readonly may: { readonly named: boolean; readonly open: boolean; readonly gate: boolean; readonly approve: boolean; readonly train: boolean; readonly champion: boolean; readonly productivity: boolean };
  gate(): Promise<Outcome<GateRead>>;
  curriculum(): Promise<Outcome<{ readonly roles: readonly { readonly roleId: string; readonly proposed: readonly CurriculumItem[]; readonly approved: { readonly version: number; readonly items: readonly CurriculumItem[]; readonly approvedBy: string } | null }[] }>>;
  approve(roleId: string, items: readonly CurriculumItem[]): Promise<Outcome<unknown, 'needFields'>>;
  training(): Promise<Outcome<{ readonly rows: readonly { readonly assignmentId: string; readonly employeeId: string; readonly itemId: string; readonly title: string; readonly state: string; readonly dueOn?: string; readonly completion: { readonly recordedBy: string } | null }[] }>>;
  assign(input: { readonly employeeId: string; readonly itemId: string; readonly title: string; readonly dueOn: string }): Promise<Outcome<unknown, 'needFields'>>;
  complete(assignmentId: string): Promise<Outcome<unknown>>;
  sign(assignmentId: string, outcome: 'competent' | 'not_yet'): Promise<Outcome<unknown>>;
  champions(): Promise<Outcome<{ readonly departments: readonly { readonly departmentId: string; readonly name: string; readonly employeeId: string | null; readonly employeeName: string | null; readonly state: string }[] }>>;
  nameChampion(departmentId: string, employeeId: string): Promise<Outcome<unknown, 'needFields'>>;
  access(): Promise<Outcome<{ readonly mismatches: readonly { readonly kind: string; readonly severity: 'critical' | 'warning' | 'info'; readonly userId: string; readonly roleId: string; readonly detail: { readonly en: string; readonly ta: string } }[] }>>;
  productivity(from: string, to: string): Promise<Outcome<{ readonly store: { readonly salesMinor: number; readonly labourMinutes: number; readonly rate: { readonly kind: string; readonly minorPerHour?: number; readonly because?: string } }; readonly departments: readonly { readonly departmentId: string; readonly name: string; readonly salesMinor: number; readonly labourMinutes: number | null; readonly rate: { readonly kind: string; readonly minorPerHour?: number } }[]; readonly unownedSalesMinor: number; readonly hoursAttributed: boolean }>>;
}

export function createAdoptionSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): AdoptionSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = {
    named, open: named && held.has('workforce.roster.read'), gate: named && held.has('workforce.adoption.read'), approve: named && held.has('workforce.curriculum.approve'),
    train: named && held.has('workforce.training.manage'), champion: named && held.has('workforce.champion.name'), productivity: named && held.has('workforce.incentive.read'),
  };
  const call = makeCaller({ keyPrefix: 'adoption', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  return {
    may,
    gate: () => call('GET', '/v1/hr/workforce/adoption-gate'),
    curriculum: () => call('GET', '/v1/hr/workforce/curriculum'),
    approve: async (roleId, items) => (items.length === 0 ? { result: 'invalid', why: 'needFields' } : call('POST', `/v1/hr/workforce/curriculum/${encodeURIComponent(roleId)}`, { items })),
    training: () => call('GET', '/v1/hr/workforce/training'),
    assign: async (a) => {
      if (a.employeeId.trim() === '' || a.itemId.trim() === '') return { result: 'invalid', why: 'needFields' };
      return call('POST', `/v1/hr/workforce/training/${newId('T')}`, { employeeId: a.employeeId.trim(), itemId: a.itemId.trim(), title: a.title.trim() === '' ? a.itemId.trim() : a.title.trim(), ...(a.dueOn === '' ? {} : { dueOn: a.dueOn }) });
    },
    complete: (id) => call('POST', `/v1/hr/workforce/training/${encodeURIComponent(id)}/completion`, {}),
    sign: (id, outcome) => call('POST', `/v1/hr/workforce/training/${encodeURIComponent(id)}/competency`, { outcome }),
    champions: () => call('GET', '/v1/hr/workforce/floor-champions'),
    nameChampion: async (departmentId, employeeId) => (employeeId.trim() === '' ? { result: 'invalid', why: 'needFields' } : call('POST', `/v1/hr/workforce/floor-champions/${encodeURIComponent(departmentId)}`, { employeeId: employeeId.trim() })),
    access: () => call('GET', '/v1/hr/workforce/access-match'),
    productivity: (from, to) => call('GET', `/v1/hr/workforce/productivity?${new URLSearchParams({ ...(from === '' ? {} : { from }), ...(to === '' ? {} : { to }) }).toString()}`),
  };
}
