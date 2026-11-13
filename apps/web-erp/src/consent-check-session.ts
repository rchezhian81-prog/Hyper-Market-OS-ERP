// Check consent (U6 · UI/UX gap audit §27 "CRM · consent" · M16-FR-02 · crm-service.md "check a customer's consent state
// (≤2)") — the page that answers, by a customer's NAME, whether the shop may message them: a few letters find the person
// (head office's customer directory, `GET /v1/customer/overview`, which carries each name beside the ref since U5), and
// their consent ledger (`GET /v1/customers/:ref/consent`) is read into one state per purpose and channel. The state is the
// SAME rule head office applies at send time (`mayWeSend`: the latest record for a purpose and channel wins, a withdrawal
// after a grant is a withdrawal; the unit test pins this file's copy of the rule against head office's own) — a read only,
// nothing is written here; a consent is recorded or withdrawn where it is captured. Every word this page adds has a Tamil
// twin; head office's own sentences (the evidence as it was typed) stay in English (OB-553, OB-699).

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

/** The purposes a desk checks before a message or a profile; `transactional` needs no consent and is not asked. */
export const CHECKED_PURPOSES = ['marketing', 'profiling', 'third_party', 'ai_personalisation'] as const;
export type CheckedPurpose = (typeof CHECKED_PURPOSES)[number];
export const CHECKED_CHANNELS = ['whatsapp', 'sms', 'email', 'push', 'post'] as const;
export type CheckedChannel = (typeof CHECKED_CHANNELS)[number];
export type Verdict = 'may_send' | 'must_not_send' | 'no_consent_on_record';

export const CONSENT_CHECK_COPY = {
  en: {
    title: 'Check consent',
    lead: 'Type a few letters of the customer\'s name or their number: the people who match appear with whether the shop may message them. Choose one to read every record — the yes, the no, how it was captured and when.',
    find: 'Customer\'s name or number', findHint: 'Two letters are enough', show: 'Show', typeMore: 'Type at least two letters.',
    matchesH: 'Matches', noMatch: 'No customer matches those letters.', noMatchDetail: 'Try fewer letters, the number, or the way the name is spelt on the enrolment.',
    noDirectory: 'Head office answered no customer at all.', noDirectoryDetail: 'The directory lists customers with an order or a consent record; a customer with neither is not in it.',
    nameCol: 'Customer', number: 'Number', segment: 'Segment', marketing: 'Marketing', openRecords: 'Open the records', noName: 'no name on record',
    purpose_marketing: 'Marketing messages', purpose_profiling: 'Profiling (segments and suggestions)', purpose_third_party: 'Sharing with a third party', purpose_ai_personalisation: 'AI suggestions from what they bought',
    ch_whatsapp: 'WhatsApp', ch_sms: 'SMS', ch_email: 'Email', ch_push: 'App notification', ch_post: 'Post',
    may_send: 'yes', must_not_send: 'no', no_consent_on_record: 'not asked', verdictCol: 'May the shop?', evidence: 'How it was captured', when: 'When', channel: 'Channel',
    recordsH: 'Consent records', recordsLead: 'Every record head office holds for this customer, by purpose. The latest record for a purpose and channel is the one that counts — the same rule head office applies before any message is sent.',
    noRecords: 'No consent record at all for this customer.', noRecordsDetail: 'Without a record the shop may not message them for marketing. Consent is captured on the Customers page or the app.',
    directoryOff: 'Your role cannot read the customer directory, so names cannot be searched. Type the customer\'s number instead and press Show.', byNumber: 'Checked by number',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read consent.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read.', reading: 'Reading from head office…',
    headOfficeEnglish: 'Head office\'s own sentences are in English.', back: 'Check another customer', records: 'records',
  },
  ta: {
    title: 'ஒப்புதலைச் சரிபார்',
    lead: 'வாடிக்கையாளரின் பெயரின் சில எழுத்துகளையோ எண்ணையோ தட்டச்சு செய்யுங்கள்: பொருந்துபவர்கள் கடை அவர்களுக்குச் செய்தி அனுப்பலாமா என்பதுடன் தோன்றுவார்கள். ஒவ்வொரு பதிவையும் — ஆம், இல்லை, எப்படிப் பெறப்பட்டது, எப்போது — படிக்க ஒருவரைத் தேர்ந்தெடுங்கள்.',
    find: 'வாடிக்கையாளரின் பெயர் அல்லது எண்', findHint: 'இரண்டு எழுத்துகள் போதும்', show: 'காட்டு', typeMore: 'குறைந்தது இரண்டு எழுத்துகளைத் தட்டச்சு செய்யுங்கள்.',
    matchesH: 'பொருத்தங்கள்', noMatch: 'அந்த எழுத்துகளுக்கு எந்த வாடிக்கையாளரும் பொருந்தவில்லை.', noMatchDetail: 'குறைவான எழுத்துகள், எண், அல்லது பதிவில் உள்ள எழுத்துக்கூட்டலை முயலுங்கள்.',
    noDirectory: 'தலைமை அலுவலகம் எந்த வாடிக்கையாளரையும் பதிலளிக்கவில்லை.', noDirectoryDetail: 'கோப்பகம் ஆர்டர் அல்லது ஒப்புதல் பதிவு உள்ள வாடிக்கையாளர்களைப் பட்டியலிடுகிறது; இரண்டும் இல்லாதவர் அதில் இல்லை.',
    nameCol: 'வாடிக்கையாளர்', number: 'எண்', segment: 'பிரிவு', marketing: 'சந்தைப்படுத்தல்', openRecords: 'பதிவுகளைத் திற', noName: 'பதிவில் பெயர் இல்லை',
    purpose_marketing: 'சந்தைப்படுத்தல் செய்திகள்', purpose_profiling: 'சுயவிவரம் (பிரிவுகளும் பரிந்துரைகளும்)', purpose_third_party: 'மூன்றாம் தரப்புடன் பகிர்தல்', purpose_ai_personalisation: 'வாங்கியதிலிருந்து AI பரிந்துரைகள்',
    ch_whatsapp: 'வாட்ஸ்அப்', ch_sms: 'SMS', ch_email: 'மின்னஞ்சல்', ch_push: 'ஆப் அறிவிப்பு', ch_post: 'தபால்',
    may_send: 'ஆம்', must_not_send: 'இல்லை', no_consent_on_record: 'கேட்கப்படவில்லை', verdictCol: 'கடை அனுப்பலாமா?', evidence: 'எப்படிப் பெறப்பட்டது', when: 'எப்போது', channel: 'வழி',
    recordsH: 'ஒப்புதல் பதிவுகள்', recordsLead: 'இந்த வாடிக்கையாளருக்குத் தலைமை அலுவலகம் வைத்திருக்கும் ஒவ்வொரு பதிவும், நோக்கத்தின்படி. ஒரு நோக்கத்திற்கும் வழிக்கும் சமீபத்திய பதிவே கணக்கில் — எந்தச் செய்தியையும் அனுப்பும் முன் தலைமை அலுவலகம் பயன்படுத்தும் அதே விதி.',
    noRecords: 'இந்த வாடிக்கையாளருக்கு ஒப்புதல் பதிவே இல்லை.', noRecordsDetail: 'பதிவு இல்லாமல் கடை சந்தைப்படுத்தலுக்குச் செய்தி அனுப்பக் கூடாது. ஒப்புதல் வாடிக்கையாளர்கள் பக்கத்திலோ ஆப்பிலோ பெறப்படுகிறது.',
    directoryOff: 'உங்கள் பங்கு வாடிக்கையாளர் கோப்பகத்தைப் படிக்க முடியாது, எனவே பெயரால் தேட முடியாது. வாடிக்கையாளரின் எண்ணைத் தட்டச்சு செய்து காட்டு-ஐ அழுத்துங்கள்.', byNumber: 'எண்ணால் சரிபார்க்கப்பட்டது',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு ஒப்புதலைப் படிக்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
    headOfficeEnglish: 'தலைமை அலுவலகத்தின் சொந்த வாக்கியங்கள் ஆங்கிலத்தில் உள்ளன.', back: 'வேறு வாடிக்கையாளரைச் சரிபார்', records: 'பதிவுகள்',
  },
} as const;

export const consentCheckWords = (lang: Lang, key: string): string =>
  (CONSENT_CHECK_COPY[lang] as Record<string, string>)[key] ?? (CONSENT_CHECK_COPY.en as Record<string, string>)[key] ?? key;
export const consentCheckOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => consentCheckWords(lang, k), out, lang);

export interface DirectoryRow { readonly customerRef: string; readonly name: string | null; readonly segment: string }
export interface ConsentLine { readonly customerId: string; readonly purpose: string; readonly channel: string; readonly given: boolean; readonly recordedAt: string; readonly evidence: string }
export interface ChannelState { readonly channel: CheckedChannel; readonly verdict: Verdict; readonly evidence?: string; readonly at?: string }
export interface ConsentState {
  readonly customerRef: string;
  readonly marketing: readonly ChannelState[]; readonly profiling: readonly ChannelState[]; readonly third_party: readonly ChannelState[]; readonly ai_personalisation: readonly ChannelState[];
  /** How many records head office holds for this customer (another person's records are never counted). */
  readonly records: number;
  readonly lines: readonly ConsentLine[];
}

/** Two letters or more of the name, or any part of the number — case does not matter. Fewer than two letters match nothing. */
export function matchCustomers(typed: string, customers: readonly DirectoryRow[]): readonly DirectoryRow[] {
  const q = typed.trim().toLowerCase();
  if (q.length < 2) return [];
  return customers.filter((c) => (c.name ?? '').toLowerCase().includes(q) || c.customerRef.toLowerCase().includes(q));
}

/**
 * Head office's send-time rule, per purpose and channel: the LATEST record wins, whichever way it points; on an equal
 * timestamp the later-recorded one wins (records arrive in the order they were recorded); none on record means the shop
 * may not send and nobody has asked. Mirrors `mayWeSend` in services/customer/src/index.ts — pinned by the unit test.
 */
export function consentStateOf(customerRef: string, records: readonly ConsentLine[]): ConsentState {
  const own = records.filter((r) => r.customerId === customerRef);
  const forPurpose = (purpose: CheckedPurpose): readonly ChannelState[] => CHECKED_CHANNELS.map((channel) => {
    let latest: ConsentLine | undefined;
    for (const r of own) {
      if (r.purpose !== purpose || r.channel !== channel) continue;
      if (latest === undefined || r.recordedAt >= latest.recordedAt) latest = r;
    }
    if (latest === undefined) return { channel, verdict: 'no_consent_on_record' };
    return { channel, verdict: latest.given ? 'may_send' : 'must_not_send', evidence: latest.evidence, at: latest.recordedAt };
  });
  return {
    customerRef, marketing: forPurpose('marketing'), profiling: forPurpose('profiling'), third_party: forPurpose('third_party'), ai_personalisation: forPurpose('ai_personalisation'),
    records: own.length, lines: own,
  };
}

type Why = 'nobody' | 'cannotRead' | 'typeMore';
type Done<T> = Promise<Outcome<T, Why>>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface ConsentCheckSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly names: boolean };
  /** The customer directory with names — needs the segment word; without it the page checks by number. */
  customers(): Done<readonly DirectoryRow[]>;
  consent(customerRef: string): Done<ConsentState>;
}

export function createConsentCheckSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string;
}): ConsentCheckSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('customer.consent.read'), names: named && held.has('customer.segment.read') };
  const call = makeCaller({ keyPrefix: 'consent', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (): { result: 'invalid'; why: Why } | undefined => (!named ? no('nobody') : !may.read ? no('cannotRead') : undefined);
  return {
    may,
    customers: async () => {
      const g = gate(); if (g !== undefined) return g;
      const out = await call<{ customers?: unknown }>('GET', '/v1/customer/overview');
      if (out.result !== 'ok') return out;
      const rows = Array.isArray(out.value.customers) ? out.value.customers as Record<string, unknown>[] : [];
      return { result: 'ok', value: rows.map((c) => ({ customerRef: str(c['customerRef']), name: typeof c['name'] === 'string' && c['name'].trim() !== '' ? c['name'] : null, segment: str(c['segment']) })) };
    },
    consent: async (customerRef) => {
      const g = gate(); if (g !== undefined) return g;
      const ref = customerRef.trim();
      if (ref.length < 2) return no('typeMore');
      const out = await call<{ records?: unknown }>('GET', `/v1/customers/${encodeURIComponent(ref)}/consent`);
      if (out.result !== 'ok') return out;
      const lines = (Array.isArray(out.value.records) ? out.value.records as Record<string, unknown>[] : []).map((r) => ({
        customerId: str(r['customerId']), purpose: str(r['purpose']), channel: str(r['channel']), given: r['given'] === true, recordedAt: str(r['recordedAt']), evidence: str(r['evidence']),
      }));
      return { result: 'ok', value: consentStateOf(ref, lines) };
    },
  };
}
