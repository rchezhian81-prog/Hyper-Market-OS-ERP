// W5 (R2 addendum C18 · Tamil Nadu Shops and Establishments Act · OB-152 · OB-155 · OB-156 · OB-166 · OB-181 · OB-142 ·
// M25-FR-01) — the working-time pack on the pages people already use, over head office's own routes that no screen reached:
//
//   Settings page (the owner):
//     • `GET  /v1/hr/compliance/working-time/settings` — every limit, leave type and the public-holiday list, each "in force"
//       or "pending" with what it still needs. A pending limit is shown as NOT SET — never an invented default (OB-155).
//     • `POST /v1/hr/compliance/working-time/settings/:key` — fill one limit, one leave type or the holiday list, with the
//       provision of the Act and who confirmed it. Append-only on head office; audited. `hr.compliance.configure`.
//   Staff list page (the store manager, the owner):
//     • `POST /v1/hr/compliance/leave/:employeeId/:date` — record a day of leave, or cancel one (a new record, never an edit).
//     • the three statutory registers — attendance, leave and holidays (`GET /v1/hr/compliance/registers/*`).
//   Staff schedule page:
//     • `GET  /v1/hr/compliance/roster-check` — what publishing the week would find, in words; changes nothing.
//     • `POST /v1/hr/compliance/roster-publications/:publicationId` — publish the week. A roster that breaks a limit in force
//       is REFUSED by head office with every breach named (OB-152 "A"); pending limits are named as not checked (OB-155).
//     • `GET  /v1/hr/compliance/roster-publications` — each week published, or "needs publishing" after a later change (OB-166).
//     • the service standard per role (`GET`/`POST /v1/hr/workforce/labour-standards`, OB-142 "A") — the owner's number.
//     • labour cost as a share of the day's sales (`GET /v1/hr/workforce/labour-cost`) — REPORTED, never a cap (OB-142).
//
// Every rule is head office's: this session only refuses the cheap things before a request (a blank field, a date that is
// not a date, a role that may not act) and never writes on open. Each write carries its own idempotency key. Head office's
// own sentences stay in English (OB-553); every word this session adds has a Tamil twin.

import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const WORKING_TIME_COPY = {
  en: {
    wtH: 'Working-time limits and leave (Shops Act)', wtLead: 'Each limit is the owner\'s or the CA\'s to fill, with the part of the Act it comes from and who confirmed it. Until then it shows "not set" and the roster check says it was not checked.',
    inForce: 'in force', pending: 'not set', limit: 'Limit', value: 'Value', source: 'Part of the Act / rule', confirmation: 'Confirmed by (owner or CA, with reference)',
    save: 'Save', saved: 'Saved on head office.', leaveTypesH: 'Leave types', daysPerYear: 'Days a year', carryOver: 'Most days carried to next year',
    needsLimit: 'needs the value, the provision of the Act it comes from, and who confirmed it (the owner or the CA)', needsLeave: 'needs the days a year, the carry-over rule, the provision of the Act it comes from, and who confirmed it', holidaysH: 'Declared public holidays', holidaysHelp: 'One per line: YYYY-MM-DD and the name, e.g. 2027-01-15 Pongal', rosterWeek: 'Roster week',
    leaveH: 'Record leave', employee: 'Staff number', date: 'Date', leaveType: 'Kind of leave', kind: 'Record', taken: 'Leave taken', cancelled: 'Cancel leave on that day',
    annual: 'Annual leave', casual: 'Casual leave', sick: 'Sick leave', festival: 'Festival leave', unpaid: 'Unpaid leave', note: 'Note (optional)', recordLeave: 'Record',
    checked: 'checked against the balance', notChecked: 'recorded — NOT CHECKED (the leave rule is not set yet)', balanceAfter: 'days left',
    registersH: 'Statutory registers', register: 'Register', attendance: 'Attendance register', leave: 'Leave register', holidays: 'Holiday register',
    from: 'From', to: 'To', asOf: 'As of', store: 'Store (optional)', show: 'Show',
    present: 'days present', hours: 'hours', notRecorded: 'rostered days with no attendance recorded', earned: 'earned', takenDays: 'taken', balance: 'balance',
    weeklyHoliday: 'Weekly holiday', given: 'given', notGiven: 'NOT given', notJudged: 'not judged (limit not set)', daysOff: 'days off', workedBy: 'worked by', nobodyWorked: 'nobody',
    rosterH: 'Check and publish the week\'s roster', branch: 'Store', weekStart: 'Week starting (Monday)', check: 'Check the roster', publish: 'Publish the roster',
    publishable: 'Can be published.', breaches: 'Breaks the limits:', notCheckedList: 'Not checked (not set yet):', allChecked: 'Every limit was checked.',
    published: 'Published.', needs_publishing: 'needs publishing', stands: 'published', roster_changed_since: 'roster changed since — publish again', publicationsH: 'Weeks published', noPublications: 'No week is published for this store yet.',
    standardsH: 'Service standard per role (owner\'s number)', role: 'Role', billsPerHour: 'Bills one person serves an hour', noStandards: 'No service standard is set yet — the forecast cannot work out staff for a role without one.', setBy: 'set by',
    costH: 'Labour cost against the day\'s sales (reported, never a cap)', sales: 'The day\'s sales (₹)', guide: 'Owner\'s guide (basis points, optional)', showCost: 'Show the labour cost',
    costIs: 'Labour cost', shareOfSales: 'of sales', aboveGuide: 'above the owner\'s guide', guideNotSet: 'guide not set by the owner — nothing compared', guideOwnerH: 'The owner\'s labour-cost guide', guideOwnerNotSet: 'Not set by the owner — the cost and its share are shown, and nothing is compared.', guideOwnerSet: '{percent}% of sales (set by {who})', guidePercent: 'Guide (% of sales)', guideSave: 'Save the guide', badGuide: 'Write the guide as a percentage of sales, more than 0 and at most 100, e.g. 10 or 9.5.', fromOwner: 'against the owner\'s guide', withinGuide: 'within the guide', notMeaningful: 'not meaningful (no sales)',
    needFields: 'Fill in every field first.', badDate: 'Write the date as YYYY-MM-DD.', badNumber: 'Write a whole number.', badHolidays: 'Write each holiday as YYYY-MM-DD and its name.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read this.', cannotSet: 'Only the owner sets these.', cannotManage: 'Your role cannot record this.', cannotRegister: 'Your role cannot read the registers.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.', reading: 'Reading from head office…',
  },
  ta: {
    wtH: 'பணி நேர வரம்புகளும் விடுப்பும் (கடைகள் சட்டம்)', wtLead: 'ஒவ்வொரு வரம்பையும் உரிமையாளர் அல்லது தணிக்கையாளர் நிரப்ப வேண்டும் — சட்டத்தின் எந்தப் பகுதி, யார் உறுதி செய்தார் என்பதுடன். அதுவரை "அமைக்கப்படவில்லை" எனக் காட்டும்; பணிமுறை சரிபார்ப்பு அதைச் சரிபார்க்கவில்லை எனச் சொல்லும்.',
    inForce: 'நடைமுறையில்', pending: 'அமைக்கப்படவில்லை', limit: 'வரம்பு', value: 'மதிப்பு', source: 'சட்டப் பகுதி / விதி', confirmation: 'உறுதி செய்தவர் (உரிமையாளர் அல்லது தணிக்கையாளர், குறிப்புடன்)',
    save: 'சேமி', saved: 'தலைமை அலுவலகத்தில் சேமிக்கப்பட்டது.', leaveTypesH: 'விடுப்பு வகைகள்', daysPerYear: 'ஆண்டுக்கு நாட்கள்', carryOver: 'அடுத்த ஆண்டுக்குக் கொண்டுசெல்லும் அதிக நாட்கள்',
    needsLimit: 'மதிப்பு, அது வரும் சட்டப் பிரிவு, யார் உறுதிப்படுத்தினார் (உரிமையாளர் அல்லது CA) ஆகியவை தேவை', needsLeave: 'ஆண்டுக்கான நாட்கள், அடுத்த ஆண்டுக்குக் கொண்டு செல்லும் விதி, அது வரும் சட்டப் பிரிவு, யார் உறுதிப்படுத்தினார் ஆகியவை தேவை', holidaysH: 'அறிவிக்கப்பட்ட பொது விடுமுறைகள்', holidaysHelp: 'ஒரு வரிக்கு ஒன்று: YYYY-MM-DD மற்றும் பெயர், உ-ம் 2027-01-15 பொங்கல்', rosterWeek: 'பணிமுறை வாரம்',
    leaveH: 'விடுப்பைப் பதிவு செய்', employee: 'பணியாளர் எண்', date: 'நாள்', leaveType: 'விடுப்பு வகை', kind: 'பதிவு', taken: 'எடுத்த விடுப்பு', cancelled: 'அந்த நாளின் விடுப்பை ரத்து செய்',
    annual: 'ஆண்டு விடுப்பு', casual: 'தற்செயல் விடுப்பு', sick: 'மருத்துவ விடுப்பு', festival: 'பண்டிகை விடுப்பு', unpaid: 'சம்பளமில்லா விடுப்பு', note: 'குறிப்பு (விருப்பம்)', recordLeave: 'பதிவு செய்',
    checked: 'இருப்புடன் சரிபார்க்கப்பட்டது', notChecked: 'பதிவாகியது — சரிபார்க்கப்படவில்லை (விடுப்பு விதி இன்னும் அமைக்கப்படவில்லை)', balanceAfter: 'நாட்கள் மீதம்',
    registersH: 'சட்டப் பதிவேடுகள்', register: 'பதிவேடு', attendance: 'வருகைப் பதிவேடு', leave: 'விடுப்புப் பதிவேடு', holidays: 'விடுமுறைப் பதிவேடு',
    from: 'முதல்', to: 'வரை', asOf: 'இந்த நாள் வரை', store: 'கடை (விருப்பம்)', show: 'காட்டு',
    present: 'வந்த நாட்கள்', hours: 'மணிநேரம்', notRecorded: 'வருகை பதிவாகாத பணிமுறை நாட்கள்', earned: 'ஈட்டியது', takenDays: 'எடுத்தது', balance: 'இருப்பு',
    weeklyHoliday: 'வார விடுமுறை', given: 'கொடுக்கப்பட்டது', notGiven: 'கொடுக்கப்படவில்லை', notJudged: 'மதிப்பிடப்படவில்லை (வரம்பு அமைக்கப்படவில்லை)', daysOff: 'விடுமுறை நாட்கள்', workedBy: 'வேலை செய்தவர்', nobodyWorked: 'யாருமில்லை',
    rosterH: 'வாரப் பணிமுறையைச் சரிபார்த்து வெளியிடு', branch: 'கடை', weekStart: 'வாரத் தொடக்கம் (திங்கள்)', check: 'பணிமுறையைச் சரிபார்', publish: 'பணிமுறையை வெளியிடு',
    publishable: 'வெளியிடலாம்.', breaches: 'வரம்புகளை மீறுகிறது:', notCheckedList: 'சரிபார்க்கப்படவில்லை (இன்னும் அமைக்கப்படவில்லை):', allChecked: 'எல்லா வரம்புகளும் சரிபார்க்கப்பட்டன.',
    published: 'வெளியிடப்பட்டது.', needs_publishing: 'வெளியிட வேண்டும்', stands: 'வெளியிடப்பட்டது', roster_changed_since: 'பின்னர் பணிமுறை மாறியது — மீண்டும் வெளியிடு', publicationsH: 'வெளியிட்ட வாரங்கள்', noPublications: 'இந்தக் கடைக்கு இன்னும் எந்த வாரமும் வெளியிடப்படவில்லை.',
    standardsH: 'பங்குக்கான சேவைத் தரம் (உரிமையாளரின் எண்)', role: 'பங்கு', billsPerHour: 'ஒருவர் ஒரு மணிநேரத்தில் கவனிக்கும் பில்கள்', noStandards: 'இன்னும் சேவைத் தரம் அமைக்கப்படவில்லை — அது இல்லாமல் ஒரு பங்குக்கு எத்தனை பேர் தேவை எனக் கணிக்க முடியாது.', setBy: 'அமைத்தவர்',
    costH: 'நாளின் விற்பனைக்கு எதிரான பணியாளர் செலவு (அறிவிப்பு மட்டும், வரம்பு அல்ல)', sales: 'நாளின் விற்பனை (₹)', guide: 'உரிமையாளரின் வழிகாட்டி (அடிப்படைப் புள்ளிகள், விருப்பம்)', showCost: 'பணியாளர் செலவைக் காட்டு',
    costIs: 'பணியாளர் செலவு', shareOfSales: 'விற்பனையில்', aboveGuide: 'உரிமையாளரின் வழிகாட்டிக்கு மேல்', guideNotSet: 'உரிமையாளர் வழிகாட்டி அமைக்கவில்லை — எதுவும் ஒப்பிடப்படவில்லை', guideOwnerH: 'உரிமையாளரின் பணியாளர் செலவு வழிகாட்டி', guideOwnerNotSet: 'உரிமையாளர் அமைக்கவில்லை — செலவும் அதன் பங்கும் காட்டப்படும், எதுவும் ஒப்பிடப்படாது.', guideOwnerSet: 'விற்பனையில் {percent}% ({who} அமைத்தார்)', guidePercent: 'வழிகாட்டி (விற்பனையில் %)', guideSave: 'வழிகாட்டியைச் சேமி', badGuide: 'வழிகாட்டியை விற்பனையின் சதவீதமாக எழுதுங்கள் — 0க்கு மேல், 100 வரை, எ.கா. 10 அல்லது 9.5.', fromOwner: 'உரிமையாளரின் வழிகாட்டியுடன் ஒப்பிட்டு', withinGuide: 'வழிகாட்டிக்குள்', notMeaningful: 'பொருளற்றது (விற்பனை இல்லை)',
    needFields: 'முதலில் எல்லாப் புலங்களையும் நிரப்புங்கள்.', badDate: 'நாளை YYYY-MM-DD என எழுதுங்கள்.', badNumber: 'முழு எண்ணை எழுதுங்கள்.', badHolidays: 'ஒவ்வொரு விடுமுறையையும் YYYY-MM-DD மற்றும் அதன் பெயருடன் எழுதுங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு இதைப் படிக்க முடியாது.', cannotSet: 'உரிமையாளர் மட்டுமே இவற்றை அமைக்கிறார்.', cannotManage: 'உங்கள் பங்கு இதைப் பதிவு செய்ய முடியாது.', cannotRegister: 'உங்கள் பங்கு பதிவேடுகளைப் படிக்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, சேமிக்கப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const workingTimeWords = (lang: Lang, key: string): string =>
  (WORKING_TIME_COPY[lang] as Record<string, string>)[key] ?? (WORKING_TIME_COPY.en as Record<string, string>)[key] ?? key;
export const workingTimeOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => workingTimeWords(lang, k), out);

export const WT_LIMIT_KEYS = ['weeklyHolidayMinDays', 'maxDailyWorkMinutes', 'maxWeeklyWorkMinutes', 'maxSpreadOverMinutes', 'maxContinuousWorkMinutes', 'minRestIntervalMinutes', 'annualLeaveDaysWorkedPerDayEarned'] as const;
export const WT_LEAVE_TYPES = ['casual', 'sick', 'festival', 'unpaid'] as const;
export const WT_LEAVE_KINDS = ['annual', ...WT_LEAVE_TYPES] as const;

type Why = 'nobody' | 'cannotRead' | 'cannotSet' | 'cannotManage' | 'cannotRegister' | 'needFields' | 'badDate' | 'badNumber' | 'badHolidays' | 'badGuide';
type Done<T> = Promise<Outcome<T, Why>>;
const isDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const whole = (v: string): number | undefined => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined);
const enc = encodeURIComponent;
const qs = (o: Record<string, string | undefined>): string => Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${enc(v!)}`).join('&');

/** Rupees typed by a person ("1,23,456.50") into paise, or undefined when it is not an amount. */
export function paiseOf(text: string): number | undefined {
  const t = text.replace(/[,\s₹]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  const [r, p = ''] = t.split('.');
  return Number(r) * 100 + Number(p.padEnd(2, '0'));
}

/** The holiday list as typed, one "YYYY-MM-DD Name" per line; undefined when a line is not readable. */
export function holidayLines(text: string): readonly { readonly date: string; readonly name: string }[] | undefined {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const out = lines.map((l) => { const m = /^(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(l); return m !== null && isDate(m[1]!) ? { date: m[1]!, name: m[2]!.trim() } : undefined; });
  return out.every((x) => x !== undefined) ? (out as { date: string; name: string }[]) : undefined;
}

export interface WorkingTimeSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly configure: boolean; readonly rosterRead: boolean; readonly rosterManage: boolean; readonly registers: boolean; readonly setStandard: boolean; readonly setGuide: boolean };
  settings(): Done<Record<string, unknown>>;
  setLimit(key: string, f: { readonly value: string; readonly source: string; readonly confirmation: string }): Done<Record<string, unknown>>;
  setLeaveType(type: string, f: { readonly daysPerYear: string; readonly carryOverMaxDays: string; readonly source: string; readonly confirmation: string }): Done<Record<string, unknown>>;
  setHolidays(f: { readonly lines: string; readonly source: string; readonly confirmation: string }): Done<Record<string, unknown>>;
  recordLeave(employeeId: string, date: string, f: { readonly kind: 'taken' | 'cancelled'; readonly leaveType: string; readonly note: string }): Done<Record<string, unknown>>;
  register(which: 'attendance' | 'leave' | 'holidays', f: { readonly from: string; readonly to: string; readonly asOf: string; readonly branchId: string }): Done<Record<string, unknown>>;
  rosterCheck(branchId: string, weekStart: string): Done<Record<string, unknown>>;
  publish(branchId: string, weekStart: string): Done<Record<string, unknown>>;
  publications(branchId: string): Done<Record<string, unknown>>;
  standards(): Done<{ readonly standards: readonly { readonly role: string; readonly billsPerStaffHour: number; readonly setBy: string; readonly setAt: string }[] }>;
  setStandard(role: string, billsPerStaffHour: string): Done<Record<string, unknown>>;
  labourCost(branchId: string, date: string, salesRupees: string, guideBps: string): Done<Record<string, unknown>>;
  /** OB-686: the owner's labour-cost guide ({ state: 'not_set' } until he sets it — no built-in 12%). */
  labourGuide(): Done<Record<string, unknown>>;
  /** OB-686: the owner sets it, as a percentage of sales ("10" or "9.5"). */
  setLabourGuide(percent: string): Done<Record<string, unknown>>;
}

export function createWorkingTimeSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newPublicationId?: () => string }): WorkingTimeSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const has = (p: string): boolean => named && held.has(p);
  const may = {
    named, read: has('hr.compliance.read'), configure: has('hr.compliance.configure'), rosterRead: has('workforce.roster.read'),
    rosterManage: has('workforce.roster.manage'), registers: has('hr.register.read'), setStandard: has('workforce.standard.set'), setGuide: has('workforce.labour.guide.set'),
  };
  const call = makeCaller({ keyPrefix: 'wt', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const newPublicationId = input.newPublicationId ?? (() => newId('RP'));
  const gate = (ok: boolean, why: Why): { result: 'invalid'; why: Why } | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !ok ? { result: 'invalid', why } : undefined);
  const bad = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const week = (b: string, w: string): { result: 'invalid'; why: Why } | undefined => (b.trim() === '' ? bad('needFields') : !isDate(w.trim()) ? bad('badDate') : undefined);
  return {
    may,
    settings: async () => gate(may.read, 'cannotRead') ?? call('GET', '/v1/hr/compliance/working-time/settings'),
    setLimit: async (key, f) => {
      const g = gate(may.configure, 'cannotSet'); if (g) return g;
      if (!(WT_LIMIT_KEYS as readonly string[]).includes(key) || f.source.trim() === '' || f.confirmation.trim() === '') return bad('needFields');
      const value = whole(f.value); if (value === undefined) return bad('badNumber');
      return call('POST', `/v1/hr/compliance/working-time/settings/${enc(key)}`, { value, source: f.source.trim(), confirmation: f.confirmation.trim() });
    },
    setLeaveType: async (type, f) => {
      const g = gate(may.configure, 'cannotSet'); if (g) return g;
      if (!(WT_LEAVE_TYPES as readonly string[]).includes(type) || f.source.trim() === '' || f.confirmation.trim() === '') return bad('needFields');
      const daysPerYear = whole(f.daysPerYear); const carryOverMaxDays = whole(f.carryOverMaxDays);
      if (daysPerYear === undefined || carryOverMaxDays === undefined) return bad('badNumber');
      return call('POST', `/v1/hr/compliance/working-time/settings/leave-${enc(type)}`, { daysPerYear, carryOverMaxDays, source: f.source.trim(), confirmation: f.confirmation.trim() });
    },
    setHolidays: async (f) => {
      const g = gate(may.configure, 'cannotSet'); if (g) return g;
      if (f.source.trim() === '' || f.confirmation.trim() === '') return bad('needFields');
      const dates = holidayLines(f.lines); if (dates === undefined || dates.length === 0) return bad('badHolidays');
      return call('POST', '/v1/hr/compliance/working-time/settings/public-holidays', { dates, source: f.source.trim(), confirmation: f.confirmation.trim() });
    },
    recordLeave: async (employeeId, date, f) => {
      const g = gate(may.rosterManage, 'cannotManage'); if (g) return g;
      if (employeeId.trim() === '' || !(WT_LEAVE_KINDS as readonly string[]).includes(f.leaveType)) return bad('needFields');
      if (!isDate(date.trim())) return bad('badDate');
      const note = f.note.trim();
      return call('POST', `/v1/hr/compliance/leave/${enc(employeeId.trim())}/${enc(date.trim())}`, { kind: f.kind, leaveType: f.leaveType, ...(note === '' ? {} : { note }) });
    },
    register: async (which, f) => {
      const g = gate(may.registers, 'cannotRegister'); if (g) return g;
      const branchId = f.branchId.trim() === '' ? undefined : f.branchId.trim();
      if (which === 'leave') return isDate(f.asOf.trim()) ? call('GET', `/v1/hr/compliance/registers/leave?${qs({ asOf: f.asOf.trim(), branchId })}`) : bad('badDate');
      if (!isDate(f.from.trim()) || !isDate(f.to.trim())) return bad('badDate');
      return call('GET', `/v1/hr/compliance/registers/${which}?${qs({ from: f.from.trim(), to: f.to.trim(), branchId })}`);
    },
    rosterCheck: async (b, w) => gate(may.rosterRead, 'cannotRead') ?? week(b, w) ?? call('GET', `/v1/hr/compliance/roster-check?${qs({ branchId: b.trim(), weekStart: w.trim() })}`),
    publish: async (b, w) => gate(may.rosterManage, 'cannotManage') ?? week(b, w) ?? call('POST', `/v1/hr/compliance/roster-publications/${enc(newPublicationId())}`, { branchId: b.trim(), weekStart: w.trim() }),
    publications: async (b) => gate(may.rosterRead, 'cannotRead') ?? (b.trim() === '' ? bad('needFields') : call('GET', `/v1/hr/compliance/roster-publications?${qs({ branchId: b.trim() })}`)),
    standards: async () => gate(may.rosterRead, 'cannotRead') ?? call('GET', '/v1/hr/workforce/labour-standards'),
    setStandard: async (role, n) => {
      const g = gate(may.setStandard, 'cannotSet'); if (g) return g;
      if (role.trim() === '') return bad('needFields');
      const billsPerStaffHour = whole(n); if (billsPerStaffHour === undefined || billsPerStaffHour < 1) return bad('badNumber');
      return call('POST', `/v1/hr/workforce/labour-standards/${enc(role.trim())}`, { billsPerStaffHour });
    },
    labourCost: async (b, date, sales, guide) => {
      const g = gate(may.rosterRead, 'cannotRead'); if (g) return g;
      if (b.trim() === '') return bad('needFields');
      if (!isDate(date.trim())) return bad('badDate');
      const salesMinor = paiseOf(sales); if (salesMinor === undefined) return bad('badNumber');
      // The guide is the owner's number: sent only when he typed one, never a default.
      const guideBps = guide.trim() === '' ? undefined : whole(guide);
      if (guide.trim() !== '' && (guideBps === undefined || guideBps < 1)) return bad('badNumber');
      return call('GET', `/v1/hr/workforce/labour-cost?${qs({ branchId: b.trim(), date: date.trim(), salesMinor: String(salesMinor), guideBps: guideBps === undefined ? undefined : String(guideBps) })}`);
    },
    labourGuide: async () => gate(may.rosterRead, 'cannotRead') ?? call('GET', '/v1/hr/workforce/labour-cost-guide'),
    setLabourGuide: async (percent) => {
      const g = gate(may.setGuide, 'cannotSet'); if (g) return g;
      const t = percent.trim().replace(/%$/, '').trim();
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return bad('badGuide');
      const guideBps = Math.round(Number(t) * 100);
      if (guideBps < 1 || guideBps > 10_000) return bad('badGuide');
      return call('POST', '/v1/hr/workforce/labour-cost-guide', { guideBps });
    },
  };
}
