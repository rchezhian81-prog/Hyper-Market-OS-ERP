// M16 (R4, signed OB-227 · OB-74) — the Customers page's tested, DOM-free session. A thin client over head office's own
// routes: every customer with its segment (a customer without profiling consent is "not profiled", listed, never left
// out), the duplicate check over the records the desk compares (it suggests; it never merges), and the governed merge —
// proposed by one person, approved by ANOTHER, undone with a reason. Every rule is head office's; this session refuses
// only the cheap things before a request and never writes on open.

import type { ViewerIdentity } from './browser-entry';
import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export interface CustomerRow { readonly customerRef: string; readonly segment: string; readonly profiled: boolean; readonly orders: number; readonly lastOrderAt: string | null }
export interface MergeRow { readonly mergeId: string; readonly survivorRef: string; readonly mergedRef: string; readonly reason: string; readonly proposedBy: string; readonly approvedBy?: string; readonly reversedBy?: string; readonly reversalReason?: string }
export interface OverviewView {
  readonly customers: readonly CustomerRow[];
  readonly counts: Readonly<Record<string, number>>;
  readonly notProfiled: number;
  readonly merges: { readonly waitingForSecondPerson: readonly MergeRow[]; readonly inForce: readonly MergeRow[]; readonly reversed: readonly MergeRow[] };
}
export interface DuplicateView { readonly matches: readonly { readonly customerIds: readonly [string, string]; readonly matchedOn: string; readonly confidence: string; readonly disposition: 'merge_candidate' | 'review' }[] }

export const CUSTOMERS_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Customers',
    lead: 'Every customer the shop knows from its own bills, with their segment, the records that may be the same person, and the merges waiting for a second person. Nothing merges by itself.',
    segmentsH: 'Customers and segments', duplicatesH: 'Records that may be the same person', pendingH: 'Merges waiting for a second person', inForceH: 'Merges in force', reversedH: 'Merges undone',
    candidates: 'Records to compare — one per line: customer code, phone, phone checked (yes/no), name',
    check: 'Find possible duplicates', refresh: 'Show customers', reason: 'Why they are one person', propose: 'Propose this merge', approve: 'Approve this merge', undoReason: 'Why undo it', undo: 'Undo this merge',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.', cannotRead: 'Your role cannot read customers.', cannotPropose: 'Your role cannot propose a merge.', cannotApprove: 'Only another person who may approve merges can do this.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
    needCandidates: 'Give at least two records, each as: code, phone, yes/no, name. Nothing was sent.', needReason: 'Say why first. Nothing was sent.',
    none: 'None.', noDuplicates: 'No two of these records look like the same person.', notProfiled: 'not profiled', orders: 'bills', lastOrder: 'last bill', noOrder: 'no bill yet',
    merge_candidate: 'likely the same person (checked contact)', review: 'worth a look (unchecked contact or same name)',
    proposed: 'Proposed. It is not in force until a second person approves it.', approved: 'Approved — the records now count as one.', undone: 'Undone — the records are separate again; the merge is kept on record.',
    by: 'by', into: 'into', segment_new: 'new', segment_regular: 'regular', segment_loyal: 'loyal', segment_lapsing: 'lapsing', segment_lapsed: 'lapsed', segment_insufficient_history: 'too little history', segment_not_profiled: 'not profiled',
  },
  ta: {
    lang: 'English', title: 'வாடிக்கையாளர்கள்',
    lead: 'கடையின் சொந்த பில்களிலிருந்து தெரிந்த ஒவ்வொரு வாடிக்கையாளரும், அவர்களின் பிரிவு, ஒரே நபராக இருக்கக்கூடிய பதிவுகள், இரண்டாவது நபருக்காகக் காத்திருக்கும் இணைப்புகள். எதுவும் தானாக இணைவதில்லை.',
    segmentsH: 'வாடிக்கையாளர்களும் பிரிவுகளும்', duplicatesH: 'ஒரே நபராக இருக்கக்கூடிய பதிவுகள்', pendingH: 'இரண்டாவது நபருக்காகக் காத்திருக்கும் இணைப்புகள்', inForceH: 'நடைமுறையில் உள்ள இணைப்புகள்', reversedH: 'திரும்பப் பெற்ற இணைப்புகள்',
    candidates: 'ஒப்பிட வேண்டிய பதிவுகள் — ஒரு வரிக்கு ஒன்று: வாடிக்கையாளர் குறியீடு, தொலைபேசி, சரிபார்க்கப்பட்டதா (yes/no), பெயர்',
    check: 'இரட்டைப் பதிவுகளைக் கண்டறி', refresh: 'வாடிக்கையாளர்களைக் காட்டு', reason: 'அவர்கள் ஏன் ஒரே நபர்', propose: 'இந்த இணைப்பை முன்மொழி', approve: 'இந்த இணைப்பை ஒப்புக்கொள்', undoReason: 'ஏன் திரும்பப் பெறுவது', undo: 'இந்த இணைப்பைத் திரும்பப் பெறு',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', cannotRead: 'உங்கள் பங்கு வாடிக்கையாளர்களைப் படிக்க முடியாது.', cannotPropose: 'உங்கள் பங்கு இணைப்பை முன்மொழிய முடியாது.', cannotApprove: 'இணைப்புகளை ஒப்புக்கொள்ளக்கூடிய வேறொருவர் மட்டுமே இதைச் செய்ய முடியும்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
    needCandidates: 'குறைந்தது இரண்டு பதிவுகளைக் கொடுங்கள்: குறியீடு, தொலைபேசி, yes/no, பெயர். எதுவும் அனுப்பப்படவில்லை.', needReason: 'முதலில் காரணத்தைச் சொல்லுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    none: 'எதுவும் இல்லை.', noDuplicates: 'இந்தப் பதிவுகளில் எந்த இரண்டும் ஒரே நபராகத் தெரியவில்லை.', notProfiled: 'பகுப்பாய்வு செய்யப்படவில்லை', orders: 'பில்கள்', lastOrder: 'கடைசி பில்', noOrder: 'இன்னும் பில் இல்லை',
    merge_candidate: 'ஒரே நபராக இருக்கலாம் (சரிபார்த்த தொடர்பு)', review: 'பார்க்கத் தகுந்தது (சரிபார்க்காத தொடர்பு அல்லது ஒரே பெயர்)',
    proposed: 'முன்மொழியப்பட்டது. இரண்டாவது நபர் ஒப்புக்கொள்ளும் வரை இது நடைமுறைக்கு வராது.', approved: 'ஒப்புக்கொள்ளப்பட்டது — பதிவுகள் இப்போது ஒன்றாகக் கணக்கிடப்படும்.', undone: 'திரும்பப் பெறப்பட்டது — பதிவுகள் மீண்டும் தனித்தனி; இணைப்பு பதிவில் வைக்கப்பட்டுள்ளது.',
    by: 'செய்தவர்', into: 'இதில்', segment_new: 'புதியவர்', segment_regular: 'வழக்கமானவர்', segment_loyal: 'விசுவாசமானவர்', segment_lapsing: 'விலகிச் செல்பவர்', segment_lapsed: 'விலகியவர்', segment_insufficient_history: 'போதிய வரலாறு இல்லை', segment_not_profiled: 'பகுப்பாய்வு செய்யப்படவில்லை',
  },
} as const;
export type CustomersCopyKey = keyof typeof CUSTOMERS_COPY.en;

export const customersWords = (lang: Lang, key: CustomersCopyKey | string): string => (CUSTOMERS_COPY[lang] as Record<string, string>)[key] ?? (CUSTOMERS_COPY.en as Record<string, string>)[key] ?? key;
export const customersOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => customersWords(lang, k), out);

/** Read the desk's records: one per line, "code, phone, yes/no, name". Undefined when fewer than two are readable. */
export function readCandidates(text: string): { customerId: string; phone?: string; phoneVerified?: boolean; name?: string }[] | undefined {
  const rows = text.split('\n').map((l) => l.trim()).filter((l) => l !== '').map((l) => l.split(',').map((x) => x.trim()));
  const out: { customerId: string; phone?: string; phoneVerified?: boolean; name?: string }[] = [];
  for (const [code, phone, checked, ...name] of rows) {
    if (code === undefined || code === '') return undefined;
    out.push({ customerId: code, ...(phone ? { phone } : {}), ...(checked ? { phoneVerified: /^(yes|y|true|ஆம்)$/i.test(checked) } : {}), ...(name.join(',').trim() !== '' ? { name: name.join(',').trim() } : {}) });
  }
  return out.length >= 2 ? out : undefined;
}

export interface CustomersSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly propose: boolean; readonly approve: boolean };
  overview(): Promise<Outcome<OverviewView>>;
  duplicates(text: string): Promise<Outcome<DuplicateView>>;
  propose(survivorRef: string, mergedRef: string, reason: string): Promise<Outcome<MergeRow>>;
  approve(mergeId: string): Promise<Outcome<MergeRow>>;
  undo(mergeId: string, reason: string): Promise<Outcome<MergeRow>>;
}

export function createCustomersSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): CustomersSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && perms.has('customer.segment.read'), propose: named && perms.has('customer.identity.manage'), approve: named && perms.has('customer.identity.approve') };
  const call = makeCaller({ keyPrefix: 'customers', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const enc = encodeURIComponent;
  const guard = (need: boolean, why: CustomersCopyKey): Outcome<never, CustomersCopyKey> | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !need ? { result: 'invalid', why } : undefined);
  return {
    may,
    overview: async () => guard(may.read, 'cannotRead') ?? call('GET', '/v1/customer/overview'),
    duplicates: async (text) => {
      const g = guard(may.read, 'cannotRead'); if (g) return g;
      const customers = readCandidates(text);
      return customers === undefined ? { result: 'invalid', why: 'needCandidates' } : call('POST', '/v1/customer/duplicates', { customers });
    },
    propose: async (survivorRef, mergedRef, reason) => {
      const g = guard(may.propose, 'cannotPropose'); if (g) return g;
      if (reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      return call('POST', `/v1/customers/${enc(survivorRef)}/merges/${enc(newId('mg'))}`, { mergedRef, reason: reason.trim() });
    },
    approve: async (mergeId) => guard(may.approve, 'cannotApprove') ?? call('POST', `/v1/customers/merges/${enc(mergeId)}/approve`, {}),
    undo: async (mergeId, reason) => {
      const g = guard(may.approve, 'cannotApprove'); if (g) return g;
      return reason.trim() === '' ? { result: 'invalid', why: 'needReason' } : call('POST', `/v1/customers/merges/${enc(mergeId)}/reverse`, { reason: reason.trim() });
    },
  };
}
