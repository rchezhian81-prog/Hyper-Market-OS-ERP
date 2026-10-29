// Incidents and recovery drills — the screen's tested, DOM-free session (M35-FR-02/04 · WF-20 · §32 · P-03 · P-08).
//
// When something goes wrong — a store stops syncing, a backup is missed, a release is rolled back — a person records an
// INCIDENT at head office (`POST /v1/platform/incidents/:id`), names who owns each follow-up ACTION and by when, writes
// the POST-MORTEM (cause, impact, what will change), and CLOSES it in their own name. Separately, each recovery DRILL's
// measured result (how much data was lost, how long until back) is recorded against the §32 targets
// (`POST /v1/platform/dr-drills`), and a miss stays on the register.
//
// Every rule is head office's (ops-incidents.ts, dr-readiness.ts): a close without a post-mortem, an action owner who
// works nowhere here, a fact re-sent with different words, a change to a closed incident — each is refused there, and
// this session hands the refusal back in head office's own words. The session only refuses the cheap things before a
// POST (nobody named, a blank field, a number that is not a number) and never writes on open. Each action carries its
// own idempotency key, made once per click, so a retried click is the same act. The author of every fact is the
// signed-in person — head office takes it from the session; the page never names anyone as the author.

import type { ViewerIdentity } from './browser-entry';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { servedShopZone } from '../../../packages/calendar/src/shop-day';

export type Lang = 'en' | 'ta';

export interface IncidentRow {
  readonly incidentId: string; readonly title: string; readonly severity: 'sev1' | 'sev2' | 'sev3'; readonly state: 'open' | 'closed';
  readonly openedBy: string; readonly openedAt: string; readonly closedBy: string | null; readonly alertIds: readonly string[];
  readonly openActions: number; readonly hasPostmortem: boolean;
}
export interface IncidentAction { readonly actionId: string; readonly description: string; readonly ownerUserId: string; readonly dueOn: string; readonly doneBy?: string; readonly doneAt?: string; readonly doneNote?: string }
export interface IncidentDetail extends Omit<IncidentRow, 'openActions' | 'hasPostmortem' | 'closedBy'> {
  readonly summary: string;
  readonly closedBy?: string; readonly closedAt?: string; readonly closingNote?: string;
  readonly timeline: readonly { readonly happenedAt: string; readonly note: string; readonly by: string; readonly source: 'person' | 'alert' }[];
  readonly actions: readonly IncidentAction[];
  readonly postmortem: { readonly version: number; readonly cause: string; readonly impact: string; readonly whatToChange: string; readonly whatWentWell?: string; readonly by: string; readonly at: string } | null;
}
export interface DrillRecord { readonly drillId: string; readonly drilledBy: string; readonly drilledAt: string; readonly result: { readonly service: string; readonly passed: boolean; readonly detail: string; readonly actualDataLossSeconds: number; readonly actualRecoverySeconds: number } }
export interface DrillRegister {
  readonly drills: readonly DrillRecord[];
  readonly posture: readonly { readonly service: string; readonly passed: boolean; readonly drillId: string; readonly drilledAt: string; readonly detail: string }[];
  readonly summary: { readonly recorded: number; readonly passed: number; readonly missed: number; readonly servicesCovered: number };
}
export interface RecoveryTarget { readonly service: string; readonly rpoSeconds: number; readonly rtoSeconds: number }

/** Head office answered (`ok`), refused in its own words, the page refused before sending, or nobody answered. */
export type Outcome<T> =
  | { readonly result: 'ok'; readonly value: T }
  | { readonly result: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string }
  | { readonly result: 'invalid'; readonly why: CopyKey }
  | { readonly result: 'lost_link' };

export type CopyKey = keyof typeof INCIDENTS_COPY.en;

export const INCIDENTS_COPY = {
  en: {
    title: 'Incidents and recovery drills', lang: 'தமிழ்',
    lead: 'When something goes wrong, record it here with a named owner for each follow-up, write down what happened and what will change, and close it in your own name. Record every recovery drill — a missed one stays on the record.',
    newIncident: 'Record an incident',
    sumOpen: 'Open incidents', sumActions: 'Follow-ups still to do', sumDrills: 'Recovery drills', sumPosture: 'Ready to recover?',
    drillsLine: '{passed} passed · {missed} missed', postureNone: 'No drill recorded yet — readiness is not known.',
    passed: 'Passed', missed: 'MISSED',
    tabIncidents: 'Incidents', tabDrills: 'Recovery drills',
    incidentsLead: 'Open incidents first, the most serious at the top. Open one to see its timeline, follow-ups and post-mortem.',
    drillsLead: 'Each drill measured against the recovery targets: how much data may be lost, and how soon the shop must be back.',
    colIncident: 'Incident', colSeverity: 'Severity', colState: 'State', colOpened: 'Opened', colFollowUps: 'Follow-ups open', colPostmortem: 'Post-mortem',
    colDrill: 'Drill', colService: 'Service', colResult: 'Result', colWhen: 'When', colBy: 'By',
    sev1: 'Severe — the shop is affected', sev2: 'Serious', sev3: 'Minor',
    stateOpen: 'Open', stateClosed: 'Closed', yes: 'Written', no: 'Not yet',
    noIncidents: 'No incident has been recorded.', noDrills: 'No recovery drill has been recorded.',
    fTitle: 'What went wrong (short)', fSeverity: 'How serious', fSummary: 'What is known so far', save: 'Record it', cancel: 'Close',
    opened: 'Recorded — head office keeps it in your name.',
    timeline: 'What happened, when', tlWhen: 'When it happened', tlNote: 'What happened', addTimeline: 'Add to the timeline', timelineAdded: 'Added to the timeline.',
    actions: 'Follow-ups', aDesc: 'What will be done', aOwner: 'Who owns it (their sign-in id)', aDue: 'Done by', addAction: 'Add this follow-up', actionAdded: 'Follow-up added with its named owner.',
    markDone: 'Mark done', doneNote: 'What was done', actionDone: 'Marked done in your name.', owner: 'owner', due: 'due', doneBy: 'done by',
    postmortem: 'Post-mortem', pmCause: 'Cause', pmImpact: 'Impact', pmChange: 'What will change', pmWell: 'What went well (optional)', savePm: 'Save the post-mortem', pmSaved: 'Post-mortem saved — version {v}.',
    close: 'Close the incident', closeNote: 'Why it is over', closed: 'Closed in your name.', closedLine: 'Closed by {by} at {at}: {note}',
    openedLine: 'Opened by {by} at {at}', noTimeline: 'Nothing on the timeline yet.', noActions: 'No follow-ups yet.', noPm: 'No post-mortem yet — the incident cannot close without one.',
    recordDrill: 'Record a drill result', dId: 'Drill name (for example 2026-Q4 store computer)', dService: 'What was recovered', dLoss: 'Data lost (seconds; 0 if none)', dBack: 'Time until back (minutes)', saveDrill: 'Record the drill', drillSaved: 'Drill recorded: {detail}',
    needAll: 'Fill in every field first. Nothing was sent.', badNumber: 'Write the numbers as whole numbers, 0 or more. Nothing was sent.', badDate: 'Pick the date. Nothing was sent.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
    reading: 'Reading from head office…', cannotRead: 'Your role cannot read incidents or drills.', readOnly: 'You can read this; recording incidents and drills needs operations rights.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.',
  },
  ta: {
    title: 'சம்பவங்களும் மீட்பு ஒத்திகைகளும்', lang: 'English',
    lead: 'ஏதாவது தவறு நடந்தால், ஒவ்வொரு தொடர் நடவடிக்கைக்கும் பெயரிடப்பட்ட பொறுப்பாளருடன் இங்கே பதிவு செய்யுங்கள்; என்ன நடந்தது, என்ன மாறும் என்று எழுதி, உங்கள் பெயரில் மூடுங்கள். ஒவ்வொரு மீட்பு ஒத்திகையையும் பதிவு செய்யுங்கள் — தவறியதும் பதிவில் இருக்கும்.',
    newIncident: 'ஒரு சம்பவத்தைப் பதிவு செய்',
    sumOpen: 'திறந்த சம்பவங்கள்', sumActions: 'செய்ய வேண்டிய தொடர் நடவடிக்கைகள்', sumDrills: 'மீட்பு ஒத்திகைகள்', sumPosture: 'மீள்வதற்குத் தயாரா?',
    drillsLine: '{passed} வெற்றி · {missed} தவறியது', postureNone: 'இன்னும் ஒத்திகை பதிவு இல்லை — தயார்நிலை தெரியாது.',
    passed: 'வெற்றி', missed: 'தவறியது',
    tabIncidents: 'சம்பவங்கள்', tabDrills: 'மீட்பு ஒத்திகைகள்',
    incidentsLead: 'திறந்த சம்பவங்கள் முதலில், மிகக் கடுமையானது மேலே. காலவரிசை, தொடர் நடவடிக்கைகள், பின்னாய்வைக் காண ஒன்றைத் திறக்கவும்.',
    drillsLead: 'ஒவ்வொரு ஒத்திகையும் மீட்பு இலக்குகளுடன் அளக்கப்படுகிறது: எவ்வளவு தரவு இழக்கலாம், கடை எவ்வளவு விரைவில் திரும்ப வேண்டும்.',
    colIncident: 'சம்பவம்', colSeverity: 'தீவிரம்', colState: 'நிலை', colOpened: 'திறக்கப்பட்டது', colFollowUps: 'திறந்த தொடர் நடவடிக்கைகள்', colPostmortem: 'பின்னாய்வு',
    colDrill: 'ஒத்திகை', colService: 'சேவை', colResult: 'முடிவு', colWhen: 'எப்போது', colBy: 'யார்',
    sev1: 'கடுமையானது — கடை பாதிக்கப்பட்டுள்ளது', sev2: 'தீவிரமானது', sev3: 'சிறியது',
    stateOpen: 'திறந்துள்ளது', stateClosed: 'மூடப்பட்டது', yes: 'எழுதப்பட்டது', no: 'இன்னும் இல்லை',
    noIncidents: 'எந்தச் சம்பவமும் பதிவு செய்யப்படவில்லை.', noDrills: 'எந்த மீட்பு ஒத்திகையும் பதிவு செய்யப்படவில்லை.',
    fTitle: 'என்ன தவறு நடந்தது (சுருக்கமாக)', fSeverity: 'எவ்வளவு தீவிரம்', fSummary: 'இதுவரை தெரிந்தது', save: 'பதிவு செய்', cancel: 'மூடு',
    opened: 'பதிவு செய்யப்பட்டது — தலைமை அலுவலகம் உங்கள் பெயரில் வைத்துள்ளது.',
    timeline: 'என்ன, எப்போது நடந்தது', tlWhen: 'நடந்த நேரம்', tlNote: 'என்ன நடந்தது', addTimeline: 'காலவரிசையில் சேர்', timelineAdded: 'காலவரிசையில் சேர்க்கப்பட்டது.',
    actions: 'தொடர் நடவடிக்கைகள்', aDesc: 'என்ன செய்யப்படும்', aOwner: 'பொறுப்பாளர் (அவரது உள்நுழைவு அடையாளம்)', aDue: 'முடிக்க வேண்டிய நாள்', addAction: 'இந்தத் தொடர் நடவடிக்கையைச் சேர்', actionAdded: 'பெயரிடப்பட்ட பொறுப்பாளருடன் சேர்க்கப்பட்டது.',
    markDone: 'முடிந்தது எனக் குறி', doneNote: 'என்ன செய்யப்பட்டது', actionDone: 'உங்கள் பெயரில் முடிந்தது எனக் குறிக்கப்பட்டது.', owner: 'பொறுப்பாளர்', due: 'கெடு', doneBy: 'முடித்தவர்',
    postmortem: 'பின்னாய்வு', pmCause: 'காரணம்', pmImpact: 'பாதிப்பு', pmChange: 'என்ன மாறும்', pmWell: 'எது நன்றாக நடந்தது (விருப்பம்)', savePm: 'பின்னாய்வைச் சேமி', pmSaved: 'பின்னாய்வு சேமிக்கப்பட்டது — பதிப்பு {v}.',
    close: 'சம்பவத்தை மூடு', closeNote: 'ஏன் முடிந்தது', closed: 'உங்கள் பெயரில் மூடப்பட்டது.', closedLine: '{by} {at} அன்று மூடினார்: {note}',
    openedLine: '{by} {at} அன்று திறந்தார்', noTimeline: 'காலவரிசையில் இன்னும் எதுவும் இல்லை.', noActions: 'இன்னும் தொடர் நடவடிக்கைகள் இல்லை.', noPm: 'இன்னும் பின்னாய்வு இல்லை — அது இல்லாமல் சம்பவத்தை மூட முடியாது.',
    recordDrill: 'ஒத்திகை முடிவைப் பதிவு செய்', dId: 'ஒத்திகையின் பெயர் (உதா. 2026-Q4 கடைக் கணினி)', dService: 'எது மீட்கப்பட்டது', dLoss: 'இழந்த தரவு (வினாடிகள்; இல்லையெனில் 0)', dBack: 'திரும்ப வர ஆன நேரம் (நிமிடங்கள்)', saveDrill: 'ஒத்திகையைப் பதிவு செய்', drillSaved: 'ஒத்திகை பதிவு செய்யப்பட்டது: {detail}',
    needAll: 'முதலில் எல்லாப் புலங்களையும் நிரப்புங்கள். எதுவும் அனுப்பப்படவில்லை.', badNumber: 'எண்களை 0 அல்லது அதற்கு மேற்பட்ட முழு எண்களாக எழுதுங்கள். எதுவும் அனுப்பப்படவில்லை.', badDate: 'தேதியைத் தேர்ந்தெடுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
    reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…', cannotRead: 'உங்கள் பங்கால் சம்பவங்களையோ ஒத்திகைகளையோ படிக்க முடியாது.', readOnly: 'நீங்கள் படிக்கலாம்; சம்பவங்களையும் ஒத்திகைகளையும் பதிவு செய்ய செயல்பாட்டு உரிமை தேவை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.',
  },
} as const;

/** One word in the reader's language, with `{name}` slots filled. */
export function wordsFor(lang: Lang, key: CopyKey, slots: Readonly<Record<string, string | number>> = {}): string {
  let text: string = INCIDENTS_COPY[lang][key] ?? INCIDENTS_COPY.en[key];
  for (const [k, v] of Object.entries(slots)) text = text.replace(`{${k}}`, String(v));
  return text;
}

/** How a refusal or a lost link reads to a person (a success reads its own word). */
export function outcomeWords(lang: Lang, out: Outcome<unknown>): string {
  if (out.result === 'refused') return `${wordsFor(lang, 'refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return wordsFor(lang, out.why);
  if (out.result === 'lost_link') return wordsFor(lang, 'unreachable');
  return '';
}

export interface IncidentsSession {
  /** What this person may do — shapes what the screen OFFERS; head office re-checks every act. */
  readonly may: { readonly named: boolean; readonly readIncidents: boolean; readonly manageIncidents: boolean; readonly readDrills: boolean; readonly recordDrills: boolean };
  board(): Promise<Outcome<{ readonly incidents: readonly IncidentRow[]; readonly open: number }>>;
  incident(incidentId: string): Promise<Outcome<IncidentDetail>>;
  drills(): Promise<Outcome<DrillRegister>>;
  targets(): Promise<Outcome<readonly RecoveryTarget[]>>;
  openIncident(form: { readonly title: string; readonly severity: string; readonly summary: string }): Promise<Outcome<{ readonly incidentId: string }>>;
  addTimeline(incidentId: string, form: { readonly happenedAt: string; readonly note: string }): Promise<Outcome<unknown>>;
  addAction(incidentId: string, form: { readonly description: string; readonly ownerUserId: string; readonly dueOn: string }): Promise<Outcome<unknown>>;
  markActionDone(incidentId: string, actionId: string, note: string): Promise<Outcome<unknown>>;
  writePostmortem(incidentId: string, form: { readonly cause: string; readonly impact: string; readonly whatToChange: string; readonly whatWentWell: string }): Promise<Outcome<{ readonly version: number }>>;
  close(incidentId: string, note: string): Promise<Outcome<unknown>>;
  recordDrill(form: { readonly drillId: string; readonly service: string; readonly dataLossSeconds: string; readonly recoveryMinutes: string }): Promise<Outcome<{ readonly detail: string; readonly passed: boolean }>>;
}

/** The summary panels: what is open, what is still to do, how the drills stand and the latest posture per service. */
export function summarise(incidents: readonly IncidentRow[] | null, register: DrillRegister | null): {
  readonly openIncidents: number | null; readonly openActions: number | null;
  readonly drills: { readonly passed: number; readonly missed: number } | null;
  readonly posture: DrillRegister['posture'] | null;
} {
  return {
    openIncidents: incidents === null ? null : incidents.filter((i) => i.state === 'open').length,
    openActions: incidents === null ? null : incidents.reduce((n, i) => n + i.openActions, 0),
    drills: register === null ? null : { passed: register.summary.passed, missed: register.summary.missed },
    posture: register === null ? null : register.posture,
  };
}

const blank = (s: string | undefined): boolean => s === undefined || s.trim() === '';
const wholeNumber = (s: string): number | undefined => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : undefined);

export function createIncidentsSession(input: {
  readonly viewer: ViewerIdentity | undefined;
  readonly fetch?: typeof globalThis.fetch;
  /** A fresh idempotency key for one click. */
  readonly newKey?: () => string;
  /** A fresh incident id (the record's own name at head office). */
  readonly newIncidentId?: () => string;
  readonly newActionId?: () => string;
}): IncidentsSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = {
    named,
    readIncidents: named && perms.has('platform.health.read'),
    manageIncidents: named && perms.has('platform.alert.manage'),
    readDrills: named && perms.has('backup.verify.read'),
    recordDrills: named && perms.has('backup.drill.record'),
  };
  const rand = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const newKey = input.newKey ?? (() => `inc-${rand()}`);
  const newIncidentId = input.newIncidentId ?? (() => `inc-${shopDateIn(new Date().toISOString(), servedShopZone()).replace(/-/g, '')}-${rand().slice(0, 8)}`);
  const newActionId = input.newActionId ?? (() => `act-${rand().slice(0, 8)}`);
  const http = input.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Outcome<T>> {
    try {
      const res = await http(path, {
        method, credentials: 'same-origin',
        headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': newKey() } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const err = (json['error'] ?? {}) as { code?: string; whatHappened?: string };
        return { result: 'refused', status: res.status, code: err.code ?? String(res.status), whatHappened: err.whatHappened ?? `status ${res.status}` };
      }
      return { result: 'ok', value: json as T };
    } catch {
      return { result: 'lost_link' };
    }
  }
  const enc = encodeURIComponent;
  const nobody = { result: 'invalid', why: 'nobody' } as const;

  return {
    may,
    board: () => (named ? call('GET', '/v1/platform/incidents') : Promise.resolve(nobody)),
    incident: async (id) => {
      if (!named) return nobody;
      const out = await call<{ incident: IncidentDetail }>('GET', `/v1/platform/incidents/${enc(id)}`);
      return out.result === 'ok' ? { result: 'ok', value: out.value.incident } : out;
    },
    drills: () => (named ? call('GET', '/v1/platform/dr-drills') : Promise.resolve(nobody)),
    targets: async () => {
      if (!named) return nobody;
      const out = await call<{ targets: RecoveryTarget[] }>('GET', '/v1/platform/recovery-targets');
      return out.result === 'ok' ? { result: 'ok', value: out.value.targets } : out;
    },
    openIncident: async (f) => {
      if (!named) return nobody;
      if (blank(f.title) || blank(f.summary) || !['sev1', 'sev2', 'sev3'].includes(f.severity)) return { result: 'invalid', why: 'needAll' };
      const incidentId = newIncidentId();
      const out = await call('POST', `/v1/platform/incidents/${enc(incidentId)}`, { title: f.title.trim(), severity: f.severity, summary: f.summary.trim() });
      return out.result === 'ok' ? { result: 'ok', value: { incidentId } } : out;
    },
    addTimeline: async (id, f) => {
      if (!named) return nobody;
      if (blank(f.note) || blank(f.happenedAt) || Number.isNaN(Date.parse(f.happenedAt))) return { result: 'invalid', why: 'needAll' };
      return call('POST', `/v1/platform/incidents/${enc(id)}/timeline`, { entryId: `tl-${rand().slice(0, 8)}`, happenedAt: new Date(f.happenedAt).toISOString(), note: f.note.trim() });
    },
    addAction: async (id, f) => {
      if (!named) return nobody;
      if (blank(f.description) || blank(f.ownerUserId)) return { result: 'invalid', why: 'needAll' };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.dueOn)) return { result: 'invalid', why: 'badDate' };
      return call('POST', `/v1/platform/incidents/${enc(id)}/actions/${enc(newActionId())}`, { description: f.description.trim(), ownerUserId: f.ownerUserId.trim(), dueOn: f.dueOn });
    },
    markActionDone: async (id, actionId, note) => {
      if (!named) return nobody;
      if (blank(note)) return { result: 'invalid', why: 'needAll' };
      return call('POST', `/v1/platform/incidents/${enc(id)}/actions/${enc(actionId)}/done`, { note: note.trim() });
    },
    writePostmortem: async (id, f) => {
      if (!named) return nobody;
      if (blank(f.cause) || blank(f.impact) || blank(f.whatToChange)) return { result: 'invalid', why: 'needAll' };
      return call('POST', `/v1/platform/incidents/${enc(id)}/postmortem`, {
        cause: f.cause.trim(), impact: f.impact.trim(), whatToChange: f.whatToChange.trim(), ...(blank(f.whatWentWell) ? {} : { whatWentWell: f.whatWentWell.trim() }),
      });
    },
    close: async (id, note) => {
      if (!named) return nobody;
      if (blank(note)) return { result: 'invalid', why: 'needAll' };
      return call('POST', `/v1/platform/incidents/${enc(id)}/close`, { note: note.trim() });
    },
    recordDrill: async (f) => {
      if (!named) return nobody;
      if (blank(f.drillId) || blank(f.service) || blank(f.dataLossSeconds) || blank(f.recoveryMinutes)) return { result: 'invalid', why: 'needAll' };
      const loss = wholeNumber(f.dataLossSeconds);
      const minutes = wholeNumber(f.recoveryMinutes);
      if (loss === undefined || minutes === undefined) return { result: 'invalid', why: 'badNumber' };
      const out = await call<{ recorded: DrillRecord }>('POST', '/v1/platform/dr-drills', { drillId: f.drillId.trim(), service: f.service, dataLossSeconds: loss, recoverySeconds: minutes * 60 });
      return out.result === 'ok' ? { result: 'ok', value: { detail: out.value.recorded.result.detail, passed: out.value.recorded.result.passed } } : out;
    },
  };
}
