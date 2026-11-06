// CERT-In reports and capacity (Round 4c · M35-FR-04 · roadmap §32 · §34 · P-03 · P-08) — a tested, DOM-free session over
// head office's two routes families that no screen reached: the overdue alert reached the owner, but he could not answer it.
//   • the CERT-In SIX-HOUR CLOCK — `GET /v1/platform/cert-in` (every classified incident: due by, minutes left, due /
//     OVERDUE / reported in time / reported LATE / not reportable) and the open incidents to classify (`GET
//     /v1/platform/incidents`). A named person decides whether an incident must be reported to CERT-In, with the reason
//     (`POST /v1/platform/incidents/:id/cert-in`, once — never overwritten), then records the report as made (`…/report`:
//     when, CERT-In's reference, how it was sent). The software never decides it. `platform.certin.manage` (the owner);
//   • CAPACITY — `GET /v1/platform/capacity-report`: each measure's peak from head office's own records (or NOT KNOWN), twice
//     the peak (§32), carried 12 months at the owner's growth, against what is provisioned — SHORT named. The plan — the
//     growth and what is provisioned — is a person's numbers (`PUT /v1/platform/capacity-plan`, `platform.service.manage`),
//     "not set" until entered, versioned.
// Reading needs `platform.health.read`; head office re-checks each write. Head office's sentences stay in English (OB-553).

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { instantOfTyped, servedShopZone } from '../../../packages/calendar/src/shop-day';

export type Lang = 'en' | 'ta';

export const CAPACITY_MEASURE_KEYS = ['bills_per_day', 'bills_per_peak_hour', 'online_orders_per_day', 'products', 'lanes', 'people_with_access'] as const;

export const CERT_IN_COPY = {
  en: {
    title: 'CERT-In reports and capacity',
    lead: 'Two duties the owner answers here. A cyber security incident that CERT-In must be told about is reported within six hours of being noticed — a person decides which, with the reason. And the installation is sized for twice the busiest day, with a year of growth.',
    certH: 'The six-hour CERT-In clock', certLead: 'Each incident someone has decided about, the most urgent first.', noClocks: 'No incident has been classified for CERT-In.',
    state_due: 'report due', state_overdue: 'OVERDUE — report now', state_reported_in_time: 'reported in time', state_reported_late: 'reported LATE', state_not_reportable: 'not reportable',
    reportBy: 'report by', minutesLeft: 'minutes left', minutesOver: 'minutes overdue', decidedBy: 'decided by', why: 'why', reportedAt: 'reported at', reference: 'CERT-In reference', channel: 'sent by',
    classifyH: 'Decide about an open incident', incident: 'Incident', reportable: 'Must it be reported to CERT-In?', yes: 'Yes — it must be reported', no: 'No — it is not reportable',
    category: 'Kind of incident', noticedAt: 'Noticed at (shop time)', reason: 'Why', classify: 'Record the decision', noOpen: 'No incident is open.',
    reportH: 'Record the report as made', report: 'Record the report',
    classified: 'Recorded.', reported: 'Recorded.',
    capH: 'Capacity', capLead: 'The shop\'s own busiest figures from the last 90 days, twice that, a year ahead — against what the installation is provisioned for.',
    measure: 'Measure', peak: 'Busiest', twice: 'Twice', target: 'In 12 months', provisioned: 'Provisioned for', verdict: 'Verdict',
    ok: 'enough', short: 'SHORT', not_known: 'not known', notKnown: 'not known',
    planH: 'The plan (a person\'s numbers)', growth: 'Expected growth over 12 months (%)', savePlan: 'Save the plan', planSaved: 'Saved — the plan is now version {v}.', notSet: 'not set',
    m_bills_per_day: 'Bills on the busiest day', m_bills_per_peak_hour: 'Bills in the busiest hour', m_online_orders_per_day: 'Online orders on the busiest day',
    m_products: 'Products in the catalogue', m_lanes: 'Tills (lanes) trading', m_people_with_access: 'People with a sign-in',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see the health of the system.', cannotClassify: 'Only the owner decides about CERT-In.', cannotPlan: 'Only the owner or the IT administrator sets the capacity plan.',
    needAll: 'Fill in every box first.', badTime: 'Write the time as on the shop\'s clock.', badNumber: 'Write whole numbers (or leave a box empty for not set).',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or recorded.', reading: 'Reading from head office…',
  },
  ta: {
    title: 'CERT-In அறிக்கைகளும் திறனும்',
    lead: 'உரிமையாளர் இங்கே பதிலளிக்கும் இரண்டு கடமைகள். CERT-In-க்குத் தெரிவிக்க வேண்டிய இணையப் பாதுகாப்புச் சம்பவம், கவனிக்கப்பட்ட ஆறு மணி நேரத்துக்குள் தெரிவிக்கப்படுகிறது — எது என்பதை ஒருவர் காரணத்துடன் முடிவு செய்கிறார். நிறுவல், அதிக வேலை நாளின் இரு மடங்குக்கும் ஓராண்டு வளர்ச்சிக்கும் ஏற்ப அளவிடப்படுகிறது.',
    certH: 'ஆறு மணி நேர CERT-In கடிகாரம்', certLead: 'யாரோ முடிவு செய்த ஒவ்வொரு சம்பவமும், மிக அவசரமானது முதலில்.', noClocks: 'CERT-In-க்காக எந்தச் சம்பவமும் வகைப்படுத்தப்படவில்லை.',
    state_due: 'அறிக்கை நிலுவை', state_overdue: 'தாமதம் — இப்போதே தெரிவியுங்கள்', state_reported_in_time: 'உரிய நேரத்தில் தெரிவிக்கப்பட்டது', state_reported_late: 'தாமதமாகத் தெரிவிக்கப்பட்டது', state_not_reportable: 'தெரிவிக்க வேண்டியதில்லை',
    reportBy: 'தெரிவிக்க வேண்டிய நேரம்', minutesLeft: 'நிமிடங்கள் உள்ளன', minutesOver: 'நிமிடங்கள் தாமதம்', decidedBy: 'முடிவு செய்தவர்', why: 'ஏன்', reportedAt: 'தெரிவித்த நேரம்', reference: 'CERT-In குறிப்பு எண்', channel: 'அனுப்பிய வழி',
    classifyH: 'திறந்த சம்பவம் பற்றி முடிவு செய்', incident: 'சம்பவம்', reportable: 'CERT-In-க்குத் தெரிவிக்க வேண்டுமா?', yes: 'ஆம் — தெரிவிக்க வேண்டும்', no: 'இல்லை — தெரிவிக்க வேண்டியதில்லை',
    category: 'சம்பவத்தின் வகை', noticedAt: 'கவனித்த நேரம் (கடை நேரம்)', reason: 'ஏன்', classify: 'முடிவைப் பதிவு செய்', noOpen: 'எந்தச் சம்பவமும் திறந்து இல்லை.',
    reportH: 'செய்த அறிக்கையைப் பதிவு செய்', report: 'அறிக்கையைப் பதிவு செய்',
    classified: 'பதிவு செய்யப்பட்டது.', reported: 'பதிவு செய்யப்பட்டது.',
    capH: 'திறன்', capLead: 'கடந்த 90 நாட்களில் கடையின் சொந்த அதிகபட்ச எண்ணிக்கைகள், அதன் இரு மடங்கு, ஓராண்டு முன்னோக்கி — நிறுவல் எதற்கு அமைக்கப்பட்டுள்ளதோ அதனுடன் ஒப்பிட்டு.',
    measure: 'அளவு', peak: 'அதிகபட்சம்', twice: 'இரு மடங்கு', target: '12 மாதங்களில்', provisioned: 'அமைக்கப்பட்டது', verdict: 'முடிவு',
    ok: 'போதுமானது', short: 'குறைவு', not_known: 'தெரியவில்லை', notKnown: 'தெரியவில்லை',
    planH: 'திட்டம் (ஒருவரின் எண்கள்)', growth: '12 மாதங்களில் எதிர்பார்க்கும் வளர்ச்சி (%)', savePlan: 'திட்டத்தைச் சேமி', planSaved: 'சேமிக்கப்பட்டது — திட்டம் இப்போது பதிப்பு {v}.', notSet: 'அமைக்கப்படவில்லை',
    m_bills_per_day: 'அதிக வேலை நாளின் பில்கள்', m_bills_per_peak_hour: 'அதிக வேலை நேரத்தின் பில்கள்', m_online_orders_per_day: 'அதிக வேலை நாளின் இணைய ஆர்டர்கள்',
    m_products: 'பட்டியலில் உள்ள பொருட்கள்', m_lanes: 'விற்பனை செய்யும் கவுண்டர்கள்', m_people_with_access: 'உள்நுழைவு உள்ளவர்கள்',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு அமைப்பின் நிலையைப் பார்க்க முடியாது.', cannotClassify: 'CERT-In பற்றி உரிமையாளர் மட்டுமே முடிவு செய்வார்.', cannotPlan: 'உரிமையாளர் அல்லது IT நிர்வாகி மட்டுமே திறன் திட்டத்தை அமைப்பார்.',
    needAll: 'முதலில் எல்லாப் பெட்டிகளையும் நிரப்புங்கள்.', badTime: 'கடையின் கடிகாரப்படி நேரத்தை எழுதுங்கள்.', badNumber: 'முழு எண்களை எழுதுங்கள் (அமைக்கப்படவில்லை என்றால் பெட்டியைக் காலியாக விடுங்கள்).',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, பதிவு செய்யப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const certInWords = (lang: Lang, key: string): string =>
  (CERT_IN_COPY[lang] as Record<string, string>)[key] ?? (CERT_IN_COPY.en as Record<string, string>)[key] ?? key;
export const certInOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => certInWords(lang, k), out);

export interface CertClock {
  readonly incidentId: string; readonly reportable: boolean; readonly category: string; readonly reason: string; readonly classifiedBy: string;
  readonly noticedAt: string; readonly reportBy: string | null; readonly state: string; readonly minutesLeft: number | null;
  readonly report: { readonly reportedAt: string; readonly reference: string; readonly channel: string; readonly by: string } | null;
}
export interface OpenIncident { readonly incidentId: string; readonly title: string; readonly severity: string }
export interface CapacityLine { readonly measure: string; readonly measuredPeak: number | null; readonly twicePeak: number | null; readonly target12Months: number | null; readonly provisioned: number | null; readonly verdict: string; readonly why: string }
export interface Capacity { readonly rows: readonly CapacityLine[]; readonly growth: number | null; readonly version: number | null }

type Why = 'nobody' | 'cannotRead' | 'cannotClassify' | 'cannotPlan' | 'needAll' | 'badTime' | 'badNumber';
type Done<T> = Promise<Outcome<T, Why>>;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** '' → null (not set); a whole number ≥ 0 → it; anything else → undefined (refused). */
export const wholeOrNotSet = (raw: string): number | null | undefined => { const t = raw.trim(); if (t === '') return null; return /^\d+$/.test(t) ? Number(t) : undefined; };

export interface CertInCapacitySession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly classify: boolean; readonly plan: boolean };
  clocks(): Done<readonly CertClock[]>;
  openIncidents(): Done<readonly OpenIncident[]>;
  classify(input: { readonly incidentId: string; readonly reportable: boolean; readonly category: string; readonly reason: string; readonly noticedAt: string }): Done<{ readonly clock: CertClock | null }>;
  report(input: { readonly incidentId: string; readonly reportedAt: string; readonly reference: string; readonly channel: string }): Done<{ readonly clock: CertClock | null }>;
  capacity(): Done<Capacity>;
  savePlan(growth: string, provisioned: Readonly<Record<string, string>>): Done<{ readonly version: number }>;
}

function clockOf(raw: unknown): CertClock | null {
  if (!isObj(raw) || typeof raw['incidentId'] !== 'string') return null;
  const r = raw['report'];
  return {
    incidentId: raw['incidentId'], reportable: raw['reportable'] === true, category: str(raw['category']), reason: str(raw['reason']), classifiedBy: str(raw['classifiedBy']),
    noticedAt: str(raw['noticedAt']), reportBy: typeof raw['reportBy'] === 'string' ? raw['reportBy'] : null, state: str(raw['state']), minutesLeft: numOrNull(raw['minutesLeft']),
    report: isObj(r) ? { reportedAt: str(r['reportedAt']), reference: str(r['reference']), channel: str(r['channel']), by: str(r['by']) } : null,
  };
}

export function createCertInCapacitySession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly timeZone?: string }): CertInCapacitySession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('platform.health.read'), classify: named && held.has('platform.certin.manage'), plan: named && held.has('platform.service.manage') };
  const call = makeCaller({ keyPrefix: 'certin', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const zone = input.timeZone ?? servedShopZone();
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (need: 'read' | 'classify' | 'plan') => (!named ? no('nobody') : !may[need] ? no(need === 'read' ? 'cannotRead' : need === 'classify' ? 'cannotClassify' : 'cannotPlan') : undefined);
  const enc = encodeURIComponent;
  return {
    may,
    clocks: async () => {
      const g = gate('read'); if (g) return g;
      const out = await call<{ clocks?: unknown[] }>('GET', '/v1/platform/cert-in');
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: (out.value.clocks ?? []).map(clockOf).filter((c): c is CertClock => c !== null) };
    },
    openIncidents: async () => {
      const g = gate('read'); if (g) return g;
      const out = await call<{ incidents?: unknown[] }>('GET', '/v1/platform/incidents');
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: (out.value.incidents ?? []).flatMap((i): OpenIncident[] => (isObj(i) && typeof i['incidentId'] === 'string' && i['state'] === 'open'
        ? [{ incidentId: i['incidentId'], title: str(i['title']), severity: str(i['severity']) }] : [])) };
    },
    classify: async (c) => {
      const g = gate('classify'); if (g) return g;
      if ([c.incidentId, c.category, c.reason, c.noticedAt].some((x) => x.trim() === '')) return no('needAll');
      const noticedAt = instantOfTyped(c.noticedAt, zone);
      if (noticedAt === '') return no('badTime');
      const out = await call<{ clock?: unknown }>('POST', `/v1/platform/incidents/${enc(c.incidentId.trim())}/cert-in`, { reportable: c.reportable, category: c.category.trim(), reason: c.reason.trim(), noticedAt });
      return out.result === 'ok' ? { result: 'ok', value: { clock: clockOf(out.value.clock) } } : out;
    },
    report: async (r) => {
      const g = gate('classify'); if (g) return g;
      if ([r.incidentId, r.reportedAt, r.reference, r.channel].some((x) => x.trim() === '')) return no('needAll');
      const reportedAt = instantOfTyped(r.reportedAt, zone);
      if (reportedAt === '') return no('badTime');
      const out = await call<{ clock?: unknown }>('POST', `/v1/platform/incidents/${enc(r.incidentId.trim())}/cert-in/report`, { reportedAt, reference: r.reference.trim(), channel: r.channel.trim() });
      return out.result === 'ok' ? { result: 'ok', value: { clock: clockOf(out.value.clock) } } : out;
    },
    capacity: async () => {
      const g = gate('read'); if (g) return g;
      const out = await call<{ rows?: unknown[]; plan?: unknown }>('GET', '/v1/platform/capacity-report');
      if (out.result !== 'ok') return out;
      const plan = isObj(out.value.plan) ? out.value.plan : null;
      return { result: 'ok', value: {
        rows: (out.value.rows ?? []).flatMap((r): CapacityLine[] => (isObj(r) && typeof r['measure'] === 'string'
          ? [{ measure: r['measure'], measuredPeak: numOrNull(r['measuredPeak']), twicePeak: numOrNull(r['twicePeak']), target12Months: numOrNull(r['target12Months']), provisioned: numOrNull(r['provisioned']), verdict: str(r['verdict']), why: str(r['why']) }] : [])),
        growth: plan === null ? null : numOrNull(plan['growthPercentPerYear']), version: plan === null ? null : numOrNull(plan['version']),
      } };
    },
    savePlan: async (growth, provisioned) => {
      const g = gate('plan'); if (g) return g;
      const gr = wholeOrNotSet(growth);
      if (gr === undefined) return no('badNumber');
      const prov: Record<string, number | null> = {};
      for (const k of CAPACITY_MEASURE_KEYS) { const v = wholeOrNotSet(provisioned[k] ?? ''); if (v === undefined) return no('badNumber'); prov[k] = v; }
      const out = await call<{ plan?: { version?: unknown } }>('PUT', '/v1/platform/capacity-plan', { growthPercentPerYear: gr, provisioned: prov });
      return out.result === 'ok' ? { result: 'ok', value: { version: numOrNull(out.value.plan?.version) ?? 0 } } : out;
    },
  };
}
