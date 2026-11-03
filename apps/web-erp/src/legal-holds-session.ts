// Audit log — legal holds, the keeping plan and the evidence pack (W5 · M34-FR-01 · M34-FR-02 · PRV-08 · hard rule #6) — a
// tested, DOM-free session for the three sections the Audit log page lacked. The page searched, checked and rebuilt the
// stored trail; head office could also freeze records, plan what may be reviewed for deletion and assemble an evidence pack
// for an auditor, but no screen reached those routes:
//   • LEGAL HOLDS — every hold, in force first, the lifted kept beside them (`GET /v1/audit/legal-holds`); place one with a
//     reason, narrowed to a kind of thing, one thing, one person or a span of shop days (`POST /v1/audit/legal-holds`); lift
//     one, which is recorded as a new fact — the hold itself is never erased (`POST /v1/audit/legal-holds/:holdId/lift`);
//   • WHAT MAY BE REVIEWED FOR DELETION — the keeping plan over the trail the system actually recorded, as of the shop's
//     today (`POST /v1/audit/retention/plan-produced`): what is held, what the law keeps, what has no rule, what is past its
//     keeping time. NOTHING is deleted — the plan is a proposal for an authorised person, and a held record is never on it;
//   • EVIDENCE PACK — the recorded trail for a span of shop days, named to the person who took it and saying whether the
//     chain checked whole at that moment (`POST /v1/audit/evidence-pack-produced`), saved as a file for the auditor.
// Placing and lifting need `audit.hold.manage`; the rest `audit.retention.read`. Head office re-checks each. A shop day is
// read on the shop's clock (from its midnight to the next), never the UTC date. Every word has a Tamil twin; head office's
// own sentences stay in English (OB-553).

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { steadyWriter } from './compliance-registers-session';
import { instantOfTyped, shopDateOf, servedShopZone } from '../../../packages/calendar/src/shop-day';

export type Lang = 'en' | 'ta';

export const LEGAL_HOLDS_COPY = {
  en: {
    holdsH: 'Legal holds', holdsLead: 'A hold keeps records exactly as they are while a dispute, an investigation or a case is open — whatever their age. Lifting a hold is recorded too; the hold itself is never erased.',
    noHolds: 'No legal hold has been placed.', inForce: 'In force', lifted: 'Lifted', placedBy: 'placed by', liftedBy: 'lifted by', covers: 'covers', everything: 'every record',
    kindOf: 'kind', oneThing: 'thing', person: 'person', fromDay: 'from', untilDay: 'until', reason: 'reason',
    placeH: 'Place a hold', holdReason: 'Why (the dispute, investigation or case)', holdType: 'Only this kind of thing (optional)', holdId: 'Only this one (id, optional)',
    holdActor: 'Only what this person did (sign-in id, optional)', holdFrom: 'From shop day (optional)', holdUntil: 'Until shop day (optional)', placeGo: 'Place the hold',
    liftWhy: 'Why it is lifted (optional)', liftGo: 'Lift this hold', placed: 'Hold placed.', liftedDone: 'Hold lifted. It stays on the record.',
    cannotHold: 'You can see the holds; placing or lifting one needs the owner\'s or the compliance lead\'s permission.',
    planH: 'What may be reviewed for deletion', planLead: 'Nothing is ever deleted from here. This reads the recorded trail as of today and says, for each record, whether a hold keeps it, the law keeps it, it has no rule, or it is past its keeping time and may be put to an authorised person.',
    planGo: 'Read the plan', assessed: 'records read', held: 'kept by a hold', statutory: 'kept by law', noPolicy: 'no keeping rule', eligible: 'past their keeping time — for a person to review',
    outcome_legal_hold: 'Kept by a hold', outcome_statutory: 'Kept by law', outcome_no_policy: 'No keeping rule', outcome_eligible_for_review: 'For review', outcome_within_retention: 'Within its keeping time',
    noneEligible: 'No record is past its keeping time.', asOfDay: 'as of shop day',
    packH: 'Evidence pack for an auditor', packLead: 'Every recorded change in a span of shop days, in one file, named to you and sealed to the trail. It says whether the whole chain checked whole when it was taken.',
    packFrom: 'From shop day', packUntil: 'Until shop day (included)', packGo: 'Make the evidence pack', packMade: 'Evidence pack made', records: 'records', sealOk: 'the chain checked whole', sealBroken: 'the chain did NOT check whole — tell the owner now',
    download: 'Save the file again',
    needReason: 'Write why the hold is placed.', needDays: 'Write both shop days as YYYY-MM-DD, the first not after the second.', badDate: 'Write dates as YYYY-MM-DD.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read the audit log.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.', reading: 'Asking head office…',
  },
  ta: {
    holdsH: 'சட்டப் பிடிப்புகள்', holdsLead: 'ஒரு தகராறு, விசாரணை அல்லது வழக்கு திறந்திருக்கும் வரை, பிடிப்பு பதிவுகளை அவை உள்ளபடியே வைத்திருக்கும் — அவை எவ்வளவு பழையதாக இருந்தாலும். பிடிப்பை நீக்குவதும் பதிவாகும்; பிடிப்பு ஒருபோதும் அழிக்கப்படாது.',
    noHolds: 'எந்தச் சட்டப் பிடிப்பும் வைக்கப்படவில்லை.', inForce: 'நடைமுறையில்', lifted: 'நீக்கப்பட்டது', placedBy: 'வைத்தவர்', liftedBy: 'நீக்கியவர்', covers: 'உள்ளடக்குவது', everything: 'ஒவ்வொரு பதிவும்',
    kindOf: 'வகை', oneThing: 'பொருள்', person: 'நபர்', fromDay: 'முதல்', untilDay: 'வரை', reason: 'காரணம்',
    placeH: 'பிடிப்பை வை', holdReason: 'ஏன் (தகராறு, விசாரணை அல்லது வழக்கு)', holdType: 'இந்த வகை மட்டும் (விருப்பம்)', holdId: 'இது மட்டும் (அடையாளம், விருப்பம்)',
    holdActor: 'இவர் செய்தவை மட்டும் (உள்நுழைவு அடையாளம், விருப்பம்)', holdFrom: 'கடை நாள் முதல் (விருப்பம்)', holdUntil: 'கடை நாள் வரை (விருப்பம்)', placeGo: 'பிடிப்பை வை',
    liftWhy: 'ஏன் நீக்கப்படுகிறது (விருப்பம்)', liftGo: 'இந்தப் பிடிப்பை நீக்கு', placed: 'பிடிப்பு வைக்கப்பட்டது.', liftedDone: 'பிடிப்பு நீக்கப்பட்டது. அது பதிவில் இருக்கும்.',
    cannotHold: 'பிடிப்புகளைப் பார்க்கலாம்; வைக்கவோ நீக்கவோ உரிமையாளர் அல்லது இணக்கப் பொறுப்பாளர் அனுமதி தேவை.',
    planH: 'நீக்குவதற்கு மதிப்பாய்வு செய்யக்கூடியவை', planLead: 'இங்கிருந்து எதுவும் ஒருபோதும் நீக்கப்படாது. இது இன்றைய நிலையில் பதிவான தடத்தைப் படித்து, ஒவ்வொரு பதிவையும் பிடிப்பு வைத்திருக்கிறதா, சட்டம் வைத்திருக்கிறதா, விதி இல்லையா, அல்லது காப்புக் காலம் கடந்து அனுமதி பெற்றவரின் முடிவுக்கு வைக்கலாமா என்று சொல்லும்.',
    planGo: 'திட்டத்தைப் படி', assessed: 'பதிவுகள் படிக்கப்பட்டன', held: 'பிடிப்பால் வைக்கப்பட்டவை', statutory: 'சட்டப்படி வைக்கப்பட்டவை', noPolicy: 'காப்பு விதி இல்லை', eligible: 'காப்புக் காலம் கடந்தவை — ஒருவர் மதிப்பாய்வு செய்ய',
    outcome_legal_hold: 'பிடிப்பால் வைக்கப்பட்டது', outcome_statutory: 'சட்டப்படி வைக்கப்பட்டது', outcome_no_policy: 'காப்பு விதி இல்லை', outcome_eligible_for_review: 'மதிப்பாய்வுக்கு', outcome_within_retention: 'காப்புக் காலத்திற்குள்',
    noneEligible: 'எந்தப் பதிவும் காப்புக் காலம் கடக்கவில்லை.', asOfDay: 'கடை நாள் நிலையில்',
    packH: 'தணிக்கையாளருக்கான சான்றுத் தொகுப்பு', packLead: 'கடை நாட்களின் இடைவெளியில் பதிவான ஒவ்வொரு மாற்றமும், ஒரே கோப்பில், உங்கள் பெயரில், தடத்துடன் முத்திரையிடப்பட்டு. எடுக்கப்பட்டபோது முழுச் சங்கிலியும் சரியாக இருந்ததா என்றும் சொல்லும்.',
    packFrom: 'கடை நாள் முதல்', packUntil: 'கடை நாள் வரை (சேர்த்து)', packGo: 'சான்றுத் தொகுப்பை உருவாக்கு', packMade: 'சான்றுத் தொகுப்பு உருவாக்கப்பட்டது', records: 'பதிவுகள்', sealOk: 'சங்கிலி முழுமையாகச் சரியாக உள்ளது', sealBroken: 'சங்கிலி சரியாக இல்லை — இப்போதே உரிமையாளரிடம் சொல்லுங்கள்',
    download: 'கோப்பை மீண்டும் சேமி',
    needReason: 'பிடிப்பு ஏன் வைக்கப்படுகிறது என்று எழுதுங்கள்.', needDays: 'இரண்டு கடை நாட்களையும் YYYY-MM-DD என எழுதுங்கள், முதலாவது இரண்டாவதற்குப் பின் அல்ல.', badDate: 'தேதிகளை YYYY-MM-DD என எழுதுங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு தணிக்கைப் பதிவைப் படிக்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, சேமிக்கப்படவில்லை.', reading: 'தலைமை அலுவலகத்திடம் கேட்கிறது…',
  },
} as const;

export const legalHoldsWords = (lang: Lang, key: string): string =>
  (LEGAL_HOLDS_COPY[lang] as Record<string, string>)[key] ?? (LEGAL_HOLDS_COPY.en as Record<string, string>)[key] ?? key;
export const legalHoldsOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => legalHoldsWords(lang, k), out);

export interface HoldRow {
  readonly holdId: string; readonly reason: string; readonly placedBy: string; readonly placedAt: string;
  readonly objectType?: string; readonly objectId?: string; readonly actorId?: string; readonly from?: string; readonly until?: string;
  readonly liftedBy?: string; readonly liftedAt?: string;
}
export interface PlanView {
  readonly asOf: string; readonly assessed: number; readonly held: number; readonly statutory: number; readonly noPolicy: number;
  readonly eligible: readonly { readonly sequence: number; readonly objectType: string; readonly objectId: string; readonly at: string; readonly explanation: string }[];
}
export interface PackView { readonly from: string; readonly until: string; readonly records: number; readonly sourceIntact: boolean; readonly exportedBy: string; readonly exportedAt: string; readonly file: string; readonly fileName: string }

type Why = 'nobody' | 'cannotRead' | 'cannotHold' | 'needReason' | 'needDays' | 'badDate';
type Done<T> = Promise<Outcome<T, Why>>;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const opt = (k: string, v: unknown): Record<string, string> => (typeof v === 'string' && v !== '' ? { [k]: v } : {});
const list = (v: unknown): readonly Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : []);
const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (v: string): boolean => DAY.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const nextDay = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * A span of SHOP days as the two instants head office compares records against: from the shop's midnight starting the first
 * day to the shop's midnight after the last ("until" is exclusive there), so "until 31 Oct" includes the whole of 31 Oct on
 * the shop's clock — never the UTC date.
 */
export function shopDaysSpan(fromDay: string, untilDay: string, timeZone: string = servedShopZone()): { readonly from: string; readonly until: string } | undefined {
  if (!realDay(fromDay) || !realDay(untilDay) || fromDay > untilDay) return undefined;
  const from = instantOfTyped(`${fromDay}T00:00`, timeZone);
  const until = instantOfTyped(`${nextDay(untilDay)}T00:00`, timeZone);
  return from === '' || until === '' ? undefined : { from, until };
}

export interface LegalHoldsSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly hold: boolean };
  holds(): Done<readonly HoldRow[]>;
  place(h: { readonly reason: string; readonly objectType?: string; readonly objectId?: string; readonly actorId?: string; readonly fromDay?: string; readonly untilDay?: string }): Done<{ readonly holdId: string }>;
  lift(holdId: string, reason?: string): Done<{ readonly holdId: string }>;
  plan(): Done<PlanView>;
  pack(fromDay: string, untilDay: string): Done<PackView>;
  /** The shop day of an instant (for a hold's span, said back as shop days). */
  dayOf(iso: string): string;
}

export function createLegalHoldsSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeZone?: string;
  readonly now?: () => string;
}): LegalHoldsSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = Object.freeze({ named, read: named && held.has('audit.retention.read'), hold: named && held.has('audit.hold.manage') });
  const zone = input.timeZone ?? servedShopZone();
  const now = input.now ?? (() => new Date().toISOString());
  const call = makeCaller({ keyPrefix: 'audit', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const write = steadyWriter({ keyPrefix: 'audit', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const need = (what: 'read' | 'hold') => (!named ? no('nobody') : !may[what] ? no(what === 'read' ? 'cannotRead' : 'cannotHold') : undefined);

  return {
    may,
    dayOf: (iso) => shopDateOf(iso, zone),

    holds: async () => {
      const g = need('read'); if (g) return g;
      const out = await call<{ holds?: unknown }>('GET', '/v1/audit/legal-holds');
      if (out.result !== 'ok') return out;
      return {
        result: 'ok',
        value: list(out.value.holds).filter((h) => filled(h['holdId'])).map((h) => ({
          holdId: str(h['holdId']), reason: str(h['reason']), placedBy: str(h['placedBy']), placedAt: str(h['placedAt']),
          ...opt('objectType', h['objectType']), ...opt('objectId', h['objectId']), ...opt('actorId', h['actorId']), ...opt('from', h['from']), ...opt('until', h['until']),
          ...opt('liftedBy', h['liftedBy']), ...opt('liftedAt', h['liftedAt']),
        })),
      };
    },

    place: async (h) => {
      const g = need('hold'); if (g) return g;
      if (!filled(h.reason)) return no('needReason');
      const fromDay = h.fromDay?.trim() ?? ''; const untilDay = h.untilDay?.trim() ?? '';
      if ((fromDay !== '' && !realDay(fromDay)) || (untilDay !== '' && !realDay(untilDay))) return no('badDate');
      if (fromDay !== '' && untilDay !== '' && fromDay > untilDay) return no('needDays');
      const from = fromDay === '' ? '' : instantOfTyped(`${fromDay}T00:00`, zone);
      const until = untilDay === '' ? '' : instantOfTyped(`${nextDay(untilDay)}T00:00`, zone);
      const body = {
        reason: h.reason.trim(), ...(filled(h.objectType) ? { objectType: h.objectType.trim() } : {}), ...(filled(h.objectId) ? { objectId: h.objectId.trim() } : {}),
        ...(filled(h.actorId) ? { actorId: h.actorId.trim() } : {}), ...(from === '' ? {} : { from }), ...(until === '' ? {} : { until }),
      };
      // The hold's id travels in the body; a lost answer resends the same id and key, so the hold is placed once.
      const out = await write<{ holdId?: unknown }>('place', 'hold', () => '/v1/audit/legal-holds', body, 'POST', undefined, (holdId) => ({ holdId, ...body }));
      return out.result === 'ok' ? { result: 'ok', value: { holdId: str(out.value.holdId) } } : out;
    },

    lift: async (holdId, reason) => {
      const g = need('hold'); if (g) return g;
      const out = await write<{ holdId?: unknown }>(`lift:${holdId}`, 'lift', () => `/v1/audit/legal-holds/${encodeURIComponent(holdId)}/lift`, filled(reason) ? { reason: reason.trim() } : {});
      return out.result === 'ok' ? { result: 'ok', value: { holdId: str(out.value.holdId) } } : out;
    },

    plan: async () => {
      const g = need('read'); if (g) return g;
      // No policies are sent: head office keeps to the owner-approved schedule. As of the SHOP's today.
      const asOf = shopDateOf(now(), zone);
      const out = await call<Record<string, unknown>>('POST', '/v1/audit/retention/plan-produced', { asOf });
      if (out.result !== 'ok') return out;
      const v = out.value;
      return {
        result: 'ok',
        value: {
          asOf: str(v['asOf']) || asOf, assessed: num(v['recordsAssessed']), held: num(v['heldCount']), statutory: num(v['statutoryCount']), noPolicy: num(v['noPolicyCount']),
          eligible: list(v['eligibleForReview']).map((d) => ({ sequence: num(d['sequence']), objectType: str(d['objectType']), objectId: str(d['objectId']), at: str(d['at']), explanation: str(d['explanation']) })),
        },
      };
    },

    pack: async (fromDay, untilDay) => {
      const g = need('read'); if (g) return g;
      const span = shopDaysSpan(fromDay.trim(), untilDay.trim(), zone);
      if (span === undefined) return no('needDays');
      const out = await call<Record<string, unknown>>('POST', '/v1/audit/evidence-pack-produced', span);
      if (out.result !== 'ok') return out;
      const v = out.value;
      return {
        result: 'ok',
        value: {
          from: fromDay.trim(), until: untilDay.trim(), records: Array.isArray(v['records']) ? v['records'].length : 0, sourceIntact: v['sourceIntact'] === true,
          exportedBy: str(v['exportedBy']), exportedAt: str(v['exportedAt']), file: JSON.stringify(v, null, 2), fileName: `evidence-pack-${fromDay.trim()}-to-${untilDay.trim()}.json`,
        },
      };
    },
  };
}
