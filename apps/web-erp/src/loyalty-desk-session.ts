// The Loyalty page — the service desk's enrolment, the member look-up, the app tie, and the owner's programme settings
// (OB-329 · OB-295 · OB-29 · M16-FR-01/02 · M17-FR-01 · P-04 · P-07 · P-08). A tested, DOM-free session.
//
//   • ENROL (OB-329): the desk reads the enrolment notice out (shown in English and Tamil, marked a DRAFT until the owner
//     signs it), keys the number the customer shows on their own phone, asks for a name — which the customer may skip —
//     and enrols only on the customer's yes. The number travels in a POST body, never a URL, and head office keeps a
//     member code and the last four digits, never the number.
//   • FIND A MEMBER: points, the tier their own 12-month spend reaches (or "tiers not set"), what more spend reaches the
//     next tier, and when their next points expire (or "expiry not set").
//   • TIE THE APP: the app reference the customer shows, to their membership — after seeing the number on their phone.
//   • THE PROGRAMME (OB-295): tiers by 12-month spend with a multiplier, and points expiry after N months — both "not set"
//     until the owner enters them, the CA's accounting note beside expiry. Only the owner may save; others read.
// Nothing is read or written on open except the notice and the programme, which are reads.

import type { ViewerIdentity } from './browser-entry';
import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { normaliseMobile } from '../../../packages/loyalty/src/mobile';

export type Lang = 'en' | 'ta';

export interface EnrolmentNotice { readonly version: string; readonly status: string; readonly en: string; readonly ta: string }
export interface Tier { readonly tierId: string; readonly name: string; readonly nameTa?: string; readonly minSpend12mMinor: number; readonly multiplierBps: number }
export interface Programme {
  readonly tiers: { readonly state: 'set' | 'not_set'; readonly tiers: readonly Tier[]; readonly say: { readonly en: string; readonly ta: string }; readonly last: { readonly setBy: string; readonly setAt: string; readonly reason: string } | null };
  readonly expiry: { readonly state: 'set' | 'not_set'; readonly months: number | null; readonly say: { readonly en: string; readonly ta: string }; readonly last: { readonly setBy: string; readonly setAt: string; readonly reason: string } | null };
  readonly accountingNote: { readonly en: string; readonly ta: string };
}
export interface Standing {
  readonly memberRef: string; readonly mobileLast4: string; readonly pointsBalance: number; readonly spend12mMinor: number;
  readonly tiers: { readonly state: string }; readonly tier: Tier | null; readonly multiplierBps: number;
  readonly nextTier?: { readonly tierId: string; readonly name: string; readonly moreSpendMinor: number };
  readonly expiry: { readonly state: string; readonly months?: number; readonly next?: { readonly expiresAt: string; readonly points: number } | null; readonly dueNow?: number };
}
export type LookupView = { readonly member: false } | { readonly member: true; readonly standing: Standing };

export const LOYALTY_DESK_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Loyalty',
    lead: 'Enrol a customer at the service desk, find a member, tie the app to their membership, and — for the owner — the programme\'s tiers and points expiry. Head office keeps a member code and the last four digits, never the phone number.',
    enrolH: 'Enrol a customer', noticeH: 'Read this to the customer first', draft: 'DRAFT — waiting for the owner\'s signature', noticeVersion: 'Notice version',
    mobile: 'Mobile number (as shown on their phone)', name: 'Name (optional — the customer may skip it)', saidYes: 'The customer said yes to joining', seen: 'I saw this number on the customer\'s own phone', enrol: 'Enrol',
    enrolled: 'Enrolled — member ending', nameKept: 'Name kept with the membership.', nameSkipped: 'Name not on record — the customer chose not to give one.', alreadyMember: 'Already a member — ending',
    needMobile: 'Key the 10-digit mobile number first. Nothing was sent.', needYes: 'Enrol only on the customer\'s yes. Tick it once they have said yes. Nothing was sent.', needSeen: 'Look at the number on the customer\'s own phone and tick the box. Nothing was sent.', badName: 'Write the name as the customer gives it (letters and spaces), or leave it empty. Nothing was sent.',
    findH: 'Find a member', find: 'Find', notMember: 'This number is not a loyalty member. They can join here.', member: 'Member ending', points: 'points', spend: '12-month spend', tier: 'Tier', noTier: 'No tier yet — base points',
    tiersNotSet: 'Tiers: not set', nextTier: 'to reach', more: 'more', expiryNotSet: 'Expiry: not set', nextExpiry: 'Next to expire', on: 'on', nothingToExpire: 'Nothing waiting to expire', multiplier: 'points ×',
    linkH: 'Tie the customer\'s app to their membership', appRef: 'App reference (shown in the customer\'s app)', link: 'Tie the app', linked: 'Tied — the app now shows this member\'s bills.', needAppRef: 'Key the app reference the customer shows you. Nothing was sent.',
    programmeH: 'The loyalty programme', tiersH: 'Tiers by 12-month spend', expiryH: 'Points expiry', caH: 'For the Chartered Accountant',
    tierName: 'Tier name', tierNameTa: 'Tier name in Tamil', tierSpend: '12-month spend from (₹)', tierMultiplier: 'Points multiplier (e.g. 1.5)', addTier: 'Add a tier', removeTier: 'Remove', months: 'Months after earning (empty switches expiry off)',
    reason: 'Why (kept with the change)', saveTiers: 'Save the tiers', saveExpiry: 'Save expiry', runExpiry: 'Run expiry now', saved: 'Saved.', unchanged: 'Nothing changed — that is already the setting.',
    lastSet: 'Last set by', badTier: 'Each tier needs a name, a spend in rupees and a multiplier from 1 to 10. Nothing was sent.', needReasonFirst: 'Say why first. Nothing was sent.', badMonths: 'Months is a whole number from 1 to 120, or empty to switch expiry off. Nothing was sent.',
    expiredSay: 'Expiry run:', ownerOnly: 'Only the owner can change these numbers.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.', cannotEnrol: 'Your role cannot enrol customers.', cannotRead: 'Your role cannot read loyalty members.', cannotConfigure: 'Only the owner can change the programme.', cannotRun: 'Your role cannot run the expiry.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
  },
  ta: {
    lang: 'English', title: 'லாயல்டி',
    lead: 'சேவை மையத்தில் வாடிக்கையாளரைச் சேர்க்கவும், உறுப்பினரைக் கண்டறியவும், செயலியை உறுப்பினர் கணக்குடன் இணைக்கவும், உரிமையாளருக்கு — திட்டத்தின் நிலைகளும் புள்ளிகள் காலாவதியும். தலைமை அலுவலகம் உறுப்பினர் குறியீட்டையும் கடைசி நான்கு இலக்கங்களையும் மட்டுமே வைத்திருக்கும், கைபேசி எண்ணை அல்ல.',
    enrolH: 'வாடிக்கையாளரைச் சேர்', noticeH: 'முதலில் இதை வாடிக்கையாளருக்குப் படித்துக் காட்டுங்கள்', draft: 'வரைவு — உரிமையாளரின் கையொப்பத்திற்காகக் காத்திருக்கிறது', noticeVersion: 'அறிவிப்புப் பதிப்பு',
    mobile: 'கைபேசி எண் (அவர்களின் தொலைபேசியில் காட்டியபடி)', name: 'பெயர் (விருப்பம் — வாடிக்கையாளர் தவிர்க்கலாம்)', saidYes: 'வாடிக்கையாளர் சேர ஒப்புக்கொண்டார்', seen: 'இந்த எண்ணை வாடிக்கையாளரின் சொந்தத் தொலைபேசியில் பார்த்தேன்', enrol: 'சேர்',
    enrolled: 'சேர்க்கப்பட்டார் — உறுப்பினர் எண் கடைசி', nameKept: 'பெயர் உறுப்பினர் கணக்குடன் வைக்கப்பட்டது.', nameSkipped: 'பெயர் பதிவில் இல்லை — வாடிக்கையாளர் தர விரும்பவில்லை.', alreadyMember: 'ஏற்கனவே உறுப்பினர் — கடைசி',
    needMobile: 'முதலில் 10 இலக்க கைபேசி எண்ணை உள்ளிடுங்கள். எதுவும் அனுப்பப்படவில்லை.', needYes: 'வாடிக்கையாளர் ஒப்புக்கொண்டால் மட்டுமே சேர்க்கவும். ஒப்புக்கொண்டதும் குறியிடுங்கள். எதுவும் அனுப்பப்படவில்லை.', needSeen: 'வாடிக்கையாளரின் சொந்தத் தொலைபேசியில் எண்ணைப் பார்த்து குறியிடுங்கள். எதுவும் அனுப்பப்படவில்லை.', badName: 'வாடிக்கையாளர் சொல்லும்படி பெயரை எழுதுங்கள் (எழுத்துகளும் இடைவெளிகளும்), அல்லது காலியாக விடுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    findH: 'உறுப்பினரைக் கண்டறி', find: 'கண்டறி', notMember: 'இந்த எண் லாயல்டி உறுப்பினர் அல்ல. இங்கே சேரலாம்.', member: 'உறுப்பினர் எண் கடைசி', points: 'புள்ளிகள்', spend: '12 மாதச் செலவு', tier: 'நிலை', noTier: 'இன்னும் நிலை இல்லை — அடிப்படைப் புள்ளிகள்',
    tiersNotSet: 'நிலைகள்: அமைக்கப்படவில்லை', nextTier: 'அடைய', more: 'மேலும்', expiryNotSet: 'காலாவதி: அமைக்கப்படவில்லை', nextExpiry: 'அடுத்து காலாவதியாகும்', on: 'அன்று', nothingToExpire: 'காலாவதியாகக் காத்திருப்பது எதுவும் இல்லை', multiplier: 'புள்ளிகள் ×',
    linkH: 'வாடிக்கையாளரின் செயலியை உறுப்பினர் கணக்குடன் இணை', appRef: 'செயலிக் குறிப்பு (வாடிக்கையாளரின் செயலியில் காட்டப்படும்)', link: 'செயலியை இணை', linked: 'இணைக்கப்பட்டது — செயலி இப்போது இந்த உறுப்பினரின் பில்களைக் காட்டும்.', needAppRef: 'வாடிக்கையாளர் காட்டும் செயலிக் குறிப்பை உள்ளிடுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    programmeH: 'லாயல்டி திட்டம்', tiersH: '12 மாதச் செலவின்படி நிலைகள்', expiryH: 'புள்ளிகள் காலாவதி', caH: 'பட்டயக் கணக்காளருக்கு',
    tierName: 'நிலையின் பெயர்', tierNameTa: 'தமிழில் நிலையின் பெயர்', tierSpend: '12 மாதச் செலவு இதிலிருந்து (₹)', tierMultiplier: 'புள்ளிப் பெருக்கி (எ.கா. 1.5)', addTier: 'ஒரு நிலையைச் சேர்', removeTier: 'நீக்கு', months: 'பெற்ற பிறகு மாதங்கள் (காலியாக விட்டால் காலாவதி நிறுத்தப்படும்)',
    reason: 'ஏன் (மாற்றத்துடன் வைக்கப்படும்)', saveTiers: 'நிலைகளைச் சேமி', saveExpiry: 'காலாவதியைச் சேமி', runExpiry: 'இப்போதே காலாவதியை இயக்கு', saved: 'சேமிக்கப்பட்டது.', unchanged: 'எதுவும் மாறவில்லை — அதுவே ஏற்கனவே அமைப்பு.',
    lastSet: 'கடைசியாக அமைத்தவர்', badTier: 'ஒவ்வொரு நிலைக்கும் பெயர், ரூபாயில் செலவு, 1 முதல் 10 வரை பெருக்கி தேவை. எதுவும் அனுப்பப்படவில்லை.', needReasonFirst: 'முதலில் காரணத்தைச் சொல்லுங்கள். எதுவும் அனுப்பப்படவில்லை.', badMonths: 'மாதங்கள் 1 முதல் 120 வரையிலான முழு எண், அல்லது காலாவதியை நிறுத்தக் காலியாக விடுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    expiredSay: 'காலாவதி இயக்கம்:', ownerOnly: 'உரிமையாளர் மட்டுமே இந்த எண்களை மாற்ற முடியும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', cannotEnrol: 'உங்கள் பங்கு வாடிக்கையாளர்களைச் சேர்க்க முடியாது.', cannotRead: 'உங்கள் பங்கு லாயல்டி உறுப்பினர்களைப் படிக்க முடியாது.', cannotConfigure: 'உரிமையாளர் மட்டுமே திட்டத்தை மாற்ற முடியும்.', cannotRun: 'உங்கள் பங்கு காலாவதியை இயக்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
  },
} as const;
export type LoyaltyDeskKey = keyof typeof LOYALTY_DESK_COPY.en;
export const loyaltyDeskWords = (lang: Lang, key: LoyaltyDeskKey | string): string => (LOYALTY_DESK_COPY[lang] as Record<string, string>)[key] ?? (LOYALTY_DESK_COPY.en as Record<string, string>)[key] ?? key;
export const loyaltyDeskOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => loyaltyDeskWords(lang, k), out);

/** Rupees with paise, Indian grouping — from whole paise. */
export function rupees(minor: number): string {
  return `₹${Math.floor(Math.abs(minor) / 100).toLocaleString('en-IN')}.${String(Math.abs(minor) % 100).padStart(2, '0')}`;
}

/** A multiplier said as the desk says it: 15000 → "1.5". */
export const multiplierWords = (bps: number): string => (bps / 10_000).toFixed(2).replace(/\.?0+$/, '');

/** A 10-digit Indian mobile number, as keyed — the loyalty package's own rule, the one head office applies. */
export const readMobile = (raw: string): string | undefined => normaliseMobile(raw);

/** One tier as the owner typed it — rupees and a "1.5"-style multiplier — read into the server's whole numbers. */
export function readTierRow(row: { readonly name: string; readonly nameTa?: string; readonly spendRupees: string; readonly multiplier: string }): Tier | undefined {
  const name = row.name.trim();
  const spend = Number(row.spendRupees.replace(/[,\s₹]/g, ''));
  const mult = Number(row.multiplier.trim().replace(/^×/, ''));
  if (name === '' || name.length > 40 || !Number.isFinite(spend) || spend < 0 || !Number.isFinite(mult) || mult < 1 || mult > 10) return undefined;
  const tierId = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || `tier-${Math.round(spend)}`;
  const nameTa = (row.nameTa ?? '').trim();
  return { tierId, name, ...(nameTa === '' ? {} : { nameTa }), minSpend12mMinor: Math.round(spend * 100), multiplierBps: Math.round(mult * 10_000) };
}

export interface LoyaltyDeskSession {
  readonly may: { readonly named: boolean; readonly enrol: boolean; readonly read: boolean; readonly configure: boolean; readonly runExpiry: boolean };
  notice(): Promise<Outcome<EnrolmentNotice>>;
  enrol(input: { readonly mobile: string; readonly name: string; readonly saidYes: boolean; readonly seenOnPhone: boolean }): Promise<Outcome<{ readonly mobileLast4: string; readonly enrolled?: boolean; readonly alreadyMember?: boolean; readonly name?: string | null }>>;
  find(mobile: string): Promise<Outcome<LookupView>>;
  link(mobile: string, appRef: string, seenOnPhone: boolean): Promise<Outcome<{ readonly mobileLast4: string; readonly linked: boolean }>>;
  programme(): Promise<Outcome<Programme>>;
  saveTiers(rows: readonly { readonly name: string; readonly nameTa?: string; readonly spendRupees: string; readonly multiplier: string }[], reason: string): Promise<Outcome<Programme & { readonly unchanged?: boolean }>>;
  saveExpiry(months: string, reason: string): Promise<Outcome<Programme & { readonly unchanged?: boolean }>>;
  runExpiry(): Promise<Outcome<{ readonly on: boolean; readonly pointsExpired: number; readonly detail: string }>>;
}

export function createLoyaltyDeskSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): LoyaltyDeskSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = {
    named, enrol: named && perms.has('loyalty.member.enrol'), read: named && perms.has('loyalty.points.read'),
    configure: named && perms.has('loyalty.programme.configure'), runExpiry: named && perms.has('loyalty.points.write'),
  };
  const call = makeCaller({ keyPrefix: 'loyalty-desk', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const guard = (need: boolean, why: LoyaltyDeskKey): Outcome<never, LoyaltyDeskKey> | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !need ? { result: 'invalid', why } : undefined);
  const NAME = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;
  return {
    may,
    notice: async () => guard(may.enrol, 'cannotEnrol') ?? call('GET', '/v1/loyalty/enrolment-notice'),
    enrol: async ({ mobile, name, saidYes, seenOnPhone }) => {
      const g = guard(may.enrol, 'cannotEnrol'); if (g) return g;
      const m = readMobile(mobile);
      if (m === undefined) return { result: 'invalid', why: 'needMobile' };
      const n = name.trim().replace(/\s+/g, ' ');
      if (n !== '' && (n.length < 2 || n.length > 80 || !NAME.test(n))) return { result: 'invalid', why: 'badName' };
      if (!saidYes) return { result: 'invalid', why: 'needYes' };
      if (!seenOnPhone) return { result: 'invalid', why: 'needSeen' };
      return call('POST', '/v1/loyalty/members', { mobile: m, consent: true, verifiedHow: 'seen_on_phone', ...(n === '' ? {} : { name: n }) });
    },
    find: async (mobile) => {
      const g = guard(may.read, 'cannotRead'); if (g) return g;
      const m = readMobile(mobile);
      if (m === undefined) return { result: 'invalid', why: 'needMobile' };
      const found = await call<{ readonly member: boolean; readonly memberRef?: string }>('POST', '/v1/loyalty/members/lookup', { mobile: m });
      if (found.result !== 'ok') return found;
      if (!found.value.member || found.value.memberRef === undefined) return { result: 'ok', value: { member: false } };
      const standing = await call<Standing>('GET', `/v1/loyalty/members/${encodeURIComponent(found.value.memberRef)}/standing`);
      return standing.result === 'ok' ? { result: 'ok', value: { member: true, standing: standing.value } } : standing;
    },
    link: async (mobile, appRef, seenOnPhone) => {
      const g = guard(may.enrol, 'cannotEnrol'); if (g) return g;
      const m = readMobile(mobile);
      if (m === undefined) return { result: 'invalid', why: 'needMobile' };
      if (appRef.trim() === '') return { result: 'invalid', why: 'needAppRef' };
      if (!seenOnPhone) return { result: 'invalid', why: 'needSeen' };
      return call('POST', '/v1/loyalty/members/app-link', { mobile: m, appCustomerRef: appRef.trim(), verifiedHow: 'seen_on_phone' });
    },
    programme: async () => guard(may.read, 'cannotRead') ?? call('GET', '/v1/loyalty/programme'),
    saveTiers: async (rows, reason) => {
      const g = guard(may.configure, 'cannotConfigure'); if (g) return g;
      const tiers: Tier[] = [];
      for (const r of rows.filter((x) => x.name.trim() !== '' || x.spendRupees.trim() !== '' || x.multiplier.trim() !== '')) {
        const t = readTierRow(r);
        if (t === undefined) return { result: 'invalid', why: 'badTier' };
        tiers.push(t);
      }
      if (reason.trim() === '') return { result: 'invalid', why: 'needReasonFirst' };
      return call('PUT', '/v1/loyalty/programme/tiers', { tiers, reason: reason.trim() });
    },
    saveExpiry: async (months, reason) => {
      const g = guard(may.configure, 'cannotConfigure'); if (g) return g;
      const text = months.trim();
      const n = text === '' ? null : Number(text);
      if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= 120)) return { result: 'invalid', why: 'badMonths' };
      if (reason.trim() === '') return { result: 'invalid', why: 'needReasonFirst' };
      return call('PUT', '/v1/loyalty/programme/expiry', { months: n, reason: reason.trim() });
    },
    runExpiry: async () => guard(may.runExpiry, 'cannotRun') ?? call('POST', '/v1/loyalty/points-expiry/run', {}),
  };
}
