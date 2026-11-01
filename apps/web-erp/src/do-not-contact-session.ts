// The do-not-contact list (Round 4c · M31-FR-04 · DPDP · P-08) — a tested, DOM-free session over head office's suppression
// register (services/customer/src/suppression-register.ts), which no screen reached: a customer who says "never contact
// me" at the desk could not be recorded without a programmer.
//   • the LIST — `GET /v1/notifications/suppressions`: who is not to be contacted, on which channel, and every entry and lift
//     with who recorded it, when and why (append-only: a lift is a new fact; the earlier entry stays on the record);
//   • ADD — `POST /v1/notifications/suppressions/:customerId` { channel, reason, source }: nothing more is sent on that
//     channel; a message already waiting is withheld by the sender, kept and visible;
//   • LIFT — `POST …/:customerId/lift` { channel, reason }: consent is still checked before every message.
// Reading needs `notification.send.check`, writing `notification.suppression.manage` (the owner, the store manager); head
// office re-checks each. Head office's own sentences stay in English (OB-553); every word this page adds has a Tamil twin.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const DNC_CHANNELS = ['all', 'sms', 'whatsapp', 'email', 'push'] as const;
export const DNC_SOURCES = ['customer_request', 'staff', 'complaint', 'provider_bounce'] as const;

export const DNC_COPY = {
  en: {
    title: 'Do not contact',
    lead: 'Customers who must not be sent messages, and on which channel. Record it the moment a customer asks; nothing more is sent on that channel, and a message already waiting is held back. Lifting it keeps the earlier entry on record, and consent is still checked before every message.',
    listH: 'Not to be contacted', none: 'Nobody is on the do-not-contact list.', historyH: 'Every entry and lift',
    addH: 'Add a customer', customer: 'Customer id', channel: 'Channel', source: 'Who asked', reason: 'Why', add: 'Add to the list', lift: 'Lift for this channel',
    ch_all: 'every channel', ch_sms: 'SMS', ch_whatsapp: 'WhatsApp', ch_email: 'email', ch_push: 'app notifications',
    src_customer_request: 'the customer asked', src_staff: 'staff decided', src_complaint: 'after a complaint', src_provider_bounce: 'the provider could not deliver',
    suppressed: 'not to be contacted', lifted: 'lifted', by: 'by', at: 'on',
    added: 'Added. Nothing more is sent on that channel.', liftedNow: 'Lifted. The earlier entry stays on the record.', already: 'Already on the list for that channel.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see the do-not-contact list.', cannotManage: 'You can see the list; changing it needs the manager\'s permission.',
    needCustomer: 'Type the customer id.', needReason: 'Say why.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or recorded.', reading: 'Reading from head office…',
  },
  ta: {
    title: 'தொடர்பு கொள்ள வேண்டாம்',
    lead: 'செய்தி அனுப்பக்கூடாத வாடிக்கையாளர்களும், எந்த வழியில் என்பதும். வாடிக்கையாளர் கேட்ட உடனே பதிவு செய்யுங்கள்; அந்த வழியில் இனி எதுவும் அனுப்பப்படாது, ஏற்கனவே காத்திருக்கும் செய்தி நிறுத்தப்படும். நீக்கினாலும் முந்தைய பதிவு வைக்கப்படும்; ஒவ்வொரு செய்திக்கு முன்பும் ஒப்புதல் இன்னும் சரிபார்க்கப்படும்.',
    listH: 'தொடர்பு கொள்ளக்கூடாதவர்கள்', none: 'தொடர்பு கொள்ள வேண்டாம் பட்டியலில் யாரும் இல்லை.', historyH: 'ஒவ்வொரு பதிவும் நீக்கமும்',
    addH: 'ஒரு வாடிக்கையாளரைச் சேர்', customer: 'வாடிக்கையாளர் அடையாளம்', channel: 'வழி', source: 'யார் கேட்டது', reason: 'ஏன்', add: 'பட்டியலில் சேர்', lift: 'இந்த வழிக்கு நீக்கு',
    ch_all: 'எல்லா வழிகளும்', ch_sms: 'எஸ்எம்எஸ்', ch_whatsapp: 'வாட்ஸ்அப்', ch_email: 'மின்னஞ்சல்', ch_push: 'செயலி அறிவிப்புகள்',
    src_customer_request: 'வாடிக்கையாளர் கேட்டார்', src_staff: 'பணியாளர் முடிவு', src_complaint: 'புகாருக்குப் பின்', src_provider_bounce: 'சேவை வழங்குநரால் அனுப்ப முடியவில்லை',
    suppressed: 'தொடர்பு கொள்ளக்கூடாது', lifted: 'நீக்கப்பட்டது', by: 'செய்தவர்', at: 'அன்று',
    added: 'சேர்க்கப்பட்டது. அந்த வழியில் இனி எதுவும் அனுப்பப்படாது.', liftedNow: 'நீக்கப்பட்டது. முந்தைய பதிவு வைக்கப்பட்டுள்ளது.', already: 'அந்த வழிக்கு ஏற்கனவே பட்டியலில் உள்ளார்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு தொடர்பு கொள்ள வேண்டாம் பட்டியலைப் பார்க்க முடியாது.', cannotManage: 'பட்டியலைப் பார்க்கலாம்; மாற்ற மேலாளர் அனுமதி தேவை.',
    needCustomer: 'வாடிக்கையாளர் அடையாளத்தைத் தட்டச்சு செய்யுங்கள்.', needReason: 'ஏன் என்று சொல்லுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, பதிவு செய்யப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export const dncWords = (lang: Lang, key: string): string =>
  (DNC_COPY[lang] as Record<string, string>)[key] ?? (DNC_COPY.en as Record<string, string>)[key] ?? key;
export const dncOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => dncWords(lang, k), out);

export interface DncEntry { readonly customerId: string; readonly channels: readonly string[] }
export interface DncFact { readonly change: 'suppressed' | 'lifted'; readonly customerId: string; readonly channel: string; readonly reason: string; readonly source?: string; readonly by: string; readonly at: string }
export interface DncList { readonly entries: readonly DncEntry[]; readonly facts: readonly DncFact[] }

type Why = 'nobody' | 'cannotRead' | 'cannotManage' | 'needCustomer' | 'needReason';
type Done<T> = Promise<Outcome<T, Why>>;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface DncSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly manage: boolean };
  list(): Done<DncList>;
  add(input: { readonly customerId: string; readonly channel: string; readonly source: string; readonly reason: string }): Done<{ readonly already: boolean }>;
  lift(customerId: string, channel: string, reason: string): Done<{ readonly lifted: true }>;
}

export function createDncSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): DncSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('notification.send.check'), manage: named && held.has('notification.suppression.manage') };
  const call = makeCaller({ keyPrefix: 'dnc', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (need: 'read' | 'manage') => (!named ? no('nobody') : !may[need] ? no(need === 'read' ? 'cannotRead' : 'cannotManage') : undefined);
  return {
    may,
    list: async () => {
      const g = gate('read'); if (g) return g;
      const out = await call<{ suppressed?: unknown[]; facts?: unknown[] }>('GET', '/v1/notifications/suppressions');
      if (out.result !== 'ok') return out;
      const entries = (out.value.suppressed ?? []).flatMap((e): DncEntry[] => (isObj(e) && typeof e['customerId'] === 'string' && Array.isArray(e['channels'])
        ? [{ customerId: e['customerId'], channels: (e['channels'] as unknown[]).filter((c): c is string => typeof c === 'string') }] : []));
      const facts = (out.value.facts ?? []).flatMap((f): DncFact[] => (isObj(f) && (f['change'] === 'suppressed' || f['change'] === 'lifted')
        ? [{ change: f['change'], customerId: str(f['customerId']), channel: str(f['channel']), reason: str(f['reason']), by: str(f['by']), at: str(f['at']), ...(typeof f['source'] === 'string' ? { source: f['source'] } : {}) }] : [])).reverse();
      return { result: 'ok', value: { entries, facts } };
    },
    add: async (a) => {
      const g = gate('manage'); if (g) return g;
      if (a.customerId.trim() === '') return no('needCustomer');
      if (a.reason.trim() === '') return no('needReason');
      const out = await call<{ alreadySuppressed?: unknown }>('POST', `/v1/notifications/suppressions/${encodeURIComponent(a.customerId.trim())}`, { channel: a.channel, reason: a.reason.trim(), source: a.source });
      return out.result === 'ok' ? { result: 'ok', value: { already: out.value.alreadySuppressed === true } } : out;
    },
    lift: async (customerId, channel, reason) => {
      const g = gate('manage'); if (g) return g;
      if (reason.trim() === '') return no('needReason');
      const out = await call('POST', `/v1/notifications/suppressions/${encodeURIComponent(customerId)}/lift`, { channel, reason: reason.trim() });
      return out.result === 'ok' ? { result: 'ok', value: { lifted: true } } : out;
    },
  };
}
