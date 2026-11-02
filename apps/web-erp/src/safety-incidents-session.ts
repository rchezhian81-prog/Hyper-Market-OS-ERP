// Safety incidents (W3 · D11-FR-06 · M26 · §28 · hard rule #6) — a tested, DOM-free session over head office's facility
// safety-incident routes (services/platform/src/facilities.ts), which no screen reached: the Facilities page only LISTED
// incidents, so a staff injury, a near miss or a small fire could not be recorded, nor closed, without a programmer.
//   • the LIST — the store's incidents, open first (`GET /v1/facilities/office?branchId=` — its `incidents` part);
//   • RAISE — `POST /v1/facilities/incidents/:incidentId` { branchId, kind, severity, occurredAt, reportedAt, reportedBy,
//     description, evidenceRefs?, assetId? }: who RECORDED it is the signed-in person (never typed); who REPORTED it may hold
//     no login and is typed;
//   • CLOSE — `POST …/:incidentId/close` { actionTaken, authorityNotifiedOn? }: head office refuses a close with no corrective
//     action, a serious one with no evidence or closed by the person who reported or recorded it (a second person, §28), and
//     a reportable one with no statutory notification on file. The incident stays open and the page says why.
// Writing needs `facilities.incident.record` (the owner, the store manager); reading the list `facilities.asset.read`. Head
// office re-checks each. Times typed are the SHOP's clock (OB-608). Every word this page adds has a Tamil twin.

import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';
import { instantOfTyped, servedShopZone } from '../../../packages/calendar/src/shop-day';

export type Lang = 'en' | 'ta';

export const INCIDENT_KINDS = ['injury', 'near_miss', 'fire', 'equipment_failure', 'food_safety', 'security'] as const;
export const INCIDENT_SEVERITIES = ['minor', 'serious', 'reportable'] as const;

export const SAFETY_COPY = {
  en: {
    title: 'Safety incidents',
    lead: 'Record a staff injury, a near miss, a fire or any other safety incident the moment it happens, and close it once it is dealt with. A serious one needs evidence and a second person to close it; a reportable one needs the date the authority was told. Nothing is ever deleted.',
    store: 'Store', read: 'Show the store\'s incidents',
    raiseH: 'Record an incident', kind: 'What happened', severity: 'How serious', occurredAt: 'When it happened (shop time)', reportedBy: 'Who reported it', description: 'What happened, in words', evidence: 'Evidence (photo or document references, separated by commas)', asset: 'Equipment involved (optional)', raise: 'Record the incident',
    k_injury: 'Staff injury', k_near_miss: 'Near miss', k_fire: 'Fire', k_equipment_failure: 'Equipment failure', k_food_safety: 'Food safety', k_security: 'Security',
    s_minor: 'Minor', s_serious: 'Serious', s_reportable: 'Reportable to the authority',
    listH: 'Incidents at this store', none: 'No incident has been recorded at this store.', open: 'open', closed: 'closed', evidenceCount: 'evidence items', reportedByWord: 'reported by', action: 'action taken',
    closeH: 'Close it', actionTaken: 'What was done so it does not happen again', authorityOn: 'Date the authority was told (reportable only)', close: 'Close the incident',
    raised: 'Recorded. It stays open until someone closes it with what was done.', closedNow: 'Closed. It stays on the record.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see this store\'s incidents.', cannotRecord: 'You can see the incidents; recording or closing one needs the manager\'s permission.',
    needStore: 'Type the store first.', needWhen: 'Say when it happened.', needWho: 'Say who reported it.', needWhat: 'Describe what happened.', badDate: 'Type the date as YYYY-MM-DD.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or recorded.', reading: 'Asking head office…',
  },
  ta: {
    title: 'பாதுகாப்பு நிகழ்வுகள்',
    lead: 'பணியாளர் காயம், நூலிழையில் தவிர்ந்த விபத்து, தீ அல்லது வேறு எந்தப் பாதுகாப்பு நிகழ்வையும் நடந்த உடனே பதிவு செய்யுங்கள்; சரிசெய்த பின் மூடுங்கள். கடுமையான நிகழ்வை மூட சான்றும் இரண்டாவது நபரும் தேவை; அதிகாரிகளுக்குத் தெரிவிக்க வேண்டியதற்கு, தெரிவித்த தேதி தேவை. எதுவும் ஒருபோதும் நீக்கப்படாது.',
    store: 'கடை', read: 'கடையின் நிகழ்வுகளைக் காட்டு',
    raiseH: 'ஒரு நிகழ்வைப் பதிவு செய்', kind: 'என்ன நடந்தது', severity: 'எவ்வளவு கடுமை', occurredAt: 'எப்போது நடந்தது (கடை நேரம்)', reportedBy: 'யார் தெரிவித்தார்', description: 'நடந்ததைச் சொற்களில்', evidence: 'சான்று (புகைப்படம் அல்லது ஆவணக் குறிப்புகள், காற்புள்ளியால் பிரித்து)', asset: 'சம்பந்தப்பட்ட கருவி (விருப்பம்)', raise: 'நிகழ்வைப் பதிவு செய்',
    k_injury: 'பணியாளர் காயம்', k_near_miss: 'நூலிழையில் தவிர்ந்தது', k_fire: 'தீ', k_equipment_failure: 'கருவிப் பழுது', k_food_safety: 'உணவுப் பாதுகாப்பு', k_security: 'பாதுகாப்பு',
    s_minor: 'சிறியது', s_serious: 'கடுமையானது', s_reportable: 'அதிகாரிகளுக்குத் தெரிவிக்க வேண்டியது',
    listH: 'இந்தக் கடையின் நிகழ்வுகள்', none: 'இந்தக் கடையில் எந்த நிகழ்வும் பதிவு செய்யப்படவில்லை.', open: 'திறந்தது', closed: 'மூடப்பட்டது', evidenceCount: 'சான்றுகள்', reportedByWord: 'தெரிவித்தவர்', action: 'எடுத்த நடவடிக்கை',
    closeH: 'மூடு', actionTaken: 'மீண்டும் நடக்காமல் இருக்க என்ன செய்யப்பட்டது', authorityOn: 'அதிகாரிகளுக்குத் தெரிவித்த தேதி (தெரிவிக்க வேண்டியதற்கு மட்டும்)', close: 'நிகழ்வை மூடு',
    raised: 'பதிவு செய்யப்பட்டது. செய்ததுடன் யாராவது மூடும் வரை திறந்தே இருக்கும்.', closedNow: 'மூடப்பட்டது. இது பதிவில் இருக்கும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு இந்தக் கடையின் நிகழ்வுகளைப் பார்க்க முடியாது.', cannotRecord: 'நிகழ்வுகளைப் பார்க்கலாம்; பதிவு செய்ய அல்லது மூட மேலாளர் அனுமதி தேவை.',
    needStore: 'முதலில் கடையைத் தட்டச்சு செய்யுங்கள்.', needWhen: 'எப்போது நடந்தது என்று சொல்லுங்கள்.', needWho: 'யார் தெரிவித்தார் என்று சொல்லுங்கள்.', needWhat: 'நடந்ததை விவரியுங்கள்.', badDate: 'தேதியை YYYY-MM-DD என்று தட்டச்சு செய்யுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, பதிவு செய்யப்படவில்லை.', reading: 'தலைமை அலுவலகத்திடம் கேட்கிறது…',
  },
} as const;

export const safetyWords = (lang: Lang, key: string): string =>
  (SAFETY_COPY[lang] as Record<string, string>)[key] ?? (SAFETY_COPY.en as Record<string, string>)[key] ?? key;
export const safetyOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => safetyWords(lang, k), out);

export interface SafetyIncidentRow {
  readonly incidentId: string; readonly kind: string; readonly severity: string; readonly occurredAt: string; readonly reportedBy: string;
  readonly description: string; readonly evidence: number; readonly assetId: string | null; readonly open: boolean; readonly actionTaken: string | null; readonly closedAt: string | null;
}
export interface RaiseForm { readonly branchId: string; readonly kind: string; readonly severity: string; readonly occurredAt: string; readonly reportedBy: string; readonly description: string; readonly evidence: string; readonly assetId: string }

type Why = 'nobody' | 'cannotRead' | 'cannotRecord' | 'needStore' | 'needWhen' | 'needWho' | 'needWhat' | 'badDate';
type Done<T> = Promise<Outcome<T, Why>>;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface SafetyIncidentsSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly record: boolean };
  list(branchId: string): Done<readonly SafetyIncidentRow[]>;
  raise(form: RaiseForm): Done<{ readonly incidentId: string }>;
  close(incidentId: string, actionTaken: string, authorityNotifiedOn: string): Done<{ readonly closed: true }>;
}

export function createSafetyIncidentsSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch;
  readonly newIncidentId?: () => string; readonly now?: () => string; readonly timeZone?: string;
}): SafetyIncidentsSession {
  const zone = input.timeZone ?? servedShopZone();
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('facilities.asset.read'), record: named && held.has('facilities.incident.record') };
  const call = makeCaller({ keyPrefix: 'safety', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const incidentIdOf = input.newIncidentId ?? (() => newId('inc'));
  const now = input.now ?? (() => new Date().toISOString());
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (need: 'read' | 'record') => (!named ? no('nobody') : !may[need] ? no(need === 'read' ? 'cannotRead' : 'cannotRecord') : undefined);
  return {
    may,
    list: async (branchId) => {
      const g = gate('read'); if (g) return g;
      if (branchId.trim() === '') return no('needStore');
      const out = await call<{ incidents?: unknown[] }>('GET', `/v1/facilities/office?${new URLSearchParams({ branchId: branchId.trim() }).toString()}`);
      if (out.result !== 'ok') return out;
      return {
        result: 'ok',
        value: (out.value.incidents ?? []).flatMap((i): SafetyIncidentRow[] => (isObj(i) && typeof i['incidentId'] === 'string' ? [{
          incidentId: i['incidentId'], kind: str(i['kind']), severity: str(i['severity']), occurredAt: str(i['occurredAt']), reportedBy: str(i['reportedBy']),
          description: str(i['description']), evidence: typeof i['evidence'] === 'number' ? i['evidence'] : 0, assetId: typeof i['assetId'] === 'string' ? i['assetId'] : null,
          open: i['open'] === true, actionTaken: typeof i['actionTaken'] === 'string' ? i['actionTaken'] : null, closedAt: typeof i['closedAt'] === 'string' ? i['closedAt'] : null,
        }] : [])),
      };
    },
    raise: async (f) => {
      const g = gate('record'); if (g) return g;
      if (f.branchId.trim() === '') return no('needStore');
      const occurredAt = instantOfTyped(f.occurredAt, zone);
      if (occurredAt === '') return no('needWhen');
      if (f.reportedBy.trim() === '') return no('needWho');
      if (f.description.trim() === '') return no('needWhat');
      const evidenceRefs = [...new Set(f.evidence.split(',').map((x) => x.trim()).filter((x) => x !== ''))];
      const incidentId = incidentIdOf();
      const out = await call('POST', `/v1/facilities/incidents/${encodeURIComponent(incidentId)}`, {
        branchId: f.branchId.trim(), kind: f.kind, severity: f.severity, occurredAt, reportedAt: now(), reportedBy: f.reportedBy.trim(), description: f.description.trim(),
        ...(evidenceRefs.length === 0 ? {} : { evidenceRefs }), ...(f.assetId.trim() === '' ? {} : { assetId: f.assetId.trim() }),
      });
      return out.result === 'ok' ? { result: 'ok', value: { incidentId } } : out;
    },
    close: async (incidentId, actionTaken, authorityNotifiedOn) => {
      const g = gate('record'); if (g) return g;
      const on = authorityNotifiedOn.trim();
      if (on !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(on)) return no('badDate');
      // A blank action is SENT: head office refuses it as the business outcome (no corrective action), in its own words.
      const out = await call('POST', `/v1/facilities/incidents/${encodeURIComponent(incidentId)}/close`, { actionTaken: actionTaken.trim(), ...(on === '' ? {} : { authorityNotifiedOn: on }) });
      return out.result === 'ok' ? { result: 'ok', value: { closed: true } } : out;
    },
  };
}
