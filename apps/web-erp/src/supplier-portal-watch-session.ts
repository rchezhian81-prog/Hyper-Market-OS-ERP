// Supplier submissions · "A supplier's papers and statement" and "Portal logins trying other suppliers' data" (W5 ·
// M24-FR-02 "statement/reconciliation viewable … a supplier statement ties to AP" · M24-FR-03 "documents tracked with
// expiry … an expired licence blocks the action" · M24-FR-04 / §35 "no cross-partner access" · P-03 · P-08) — a tested,
// DOM-free session over three head-office reads no screen reached:
//   • A SUPPLIER'S PAPERS (`GET /v1/supplier-portal/partners/:partnerId/compliance?asOf=`) — each document valid, expiring,
//     expired, missing or never verified, and which of them block the supplier's next action; the day is the shop's;
//   • ITS STATEMENT (`GET …/statement`) — opening, invoiced, debited, credited, paid, closing and disputed (shown apart, never
//     folded in), and whether it adds up a second way; a partner whose statement is not shared says so (not "owes nothing");
//   • PORTAL LOGINS TRYING DOORS (`GET /v1/supplier-portal/probing`) — the tenant-wide security view; the threshold is head
//     office's own (it says which it used).
// Reads only; nothing is written. (Statement lines and openings are not keyed here — see the W5 report.)

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const SUPPLIER_PORTAL_WATCH_COPY = {
  en: {
    spH: 'A supplier\'s papers and statement', spLede: 'For the supplier typed here: whether its papers (licences, insurance, registrations) are in date and verified on the day, and its statement as the portal shows it — a disputed line is shown apart, never folded into the balance.',
    partner: 'Supplier (portal partner)', asOf: 'Papers checked on', papers: 'Check the papers', statement: 'Read the statement',
    compliant: 'Every required paper is in date and verified.', notCompliant: 'Not every paper is in order — blocked by: {kinds}.', d_valid: 'valid', d_expiring: 'expiring soon', d_expired: 'expired', d_missing: 'missing', d_unverified: 'not verified',
    opening: 'Opening', invoiced: 'Invoiced', debited: 'Debit notes', credited: 'Credit notes', paid: 'Paid', closing: 'Closing balance', disputed: 'Disputed (kept apart)', addsUp: 'The statement adds up a second way.', doesNotAddUp: 'The statement does NOT add up — a line has no bucket. A person must look.',
    notShared: 'This supplier\'s statement is not shared on the portal — that is not a balance of zero.', noLines: 'No statement line yet.',
    probeH: 'Portal logins trying other suppliers\' data', probeShow: 'Show them', noProbing: 'No supplier login has reached the pattern head office watches for ({threshold} refusals).', probeRow: '{user} (supplier {partner}): {attempts} attempts', threshold: 'Counted from {threshold} refusals',
    needPartner: 'Type the supplier first.', needDate: 'Give the day as YYYY-MM-DD.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot review supplier portal records.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read.',
  },
  ta: {
    spH: 'ஒரு சப்ளையரின் ஆவணங்களும் அறிக்கையும்', spLede: 'இங்கே தட்டச்சு செய்த சப்ளையருக்கு: அதன் ஆவணங்கள் (உரிமங்கள், காப்பீடு, பதிவுகள்) அந்த நாளில் செல்லுபடியாகி சரிபார்க்கப்பட்டவையா, மற்றும் போர்டல் காட்டும் அதன் அறிக்கை — சர்ச்சையிலுள்ள வரி தனியாகக் காட்டப்படும், இருப்பில் சேர்க்கப்படாது.',
    partner: 'சப்ளையர் (போர்டல் கூட்டாளர்)', asOf: 'ஆவணங்கள் சரிபார்த்த நாள்', papers: 'ஆவணங்களைச் சரிபார்', statement: 'அறிக்கையைப் படி',
    compliant: 'தேவையான ஒவ்வொரு ஆவணமும் செல்லுபடியானது, சரிபார்க்கப்பட்டது.', notCompliant: 'எல்லா ஆவணங்களும் சரியாக இல்லை — தடுப்பவை: {kinds}.', d_valid: 'செல்லுபடி', d_expiring: 'விரைவில் காலாவதி', d_expired: 'காலாவதியானது', d_missing: 'இல்லை', d_unverified: 'சரிபார்க்கப்படவில்லை',
    opening: 'தொடக்கம்', invoiced: 'விலைப்பட்டியல்', debited: 'பற்று குறிப்புகள்', credited: 'வரவு குறிப்புகள்', paid: 'செலுத்தியது', closing: 'இறுதி இருப்பு', disputed: 'சர்ச்சையில் (தனியாக)', addsUp: 'அறிக்கை இரண்டாம் வழியிலும் பொருந்துகிறது.', doesNotAddUp: 'அறிக்கை பொருந்தவில்லை — ஒரு வரிக்கு வகை இல்லை. ஒருவர் பார்க்க வேண்டும்.',
    notShared: 'இந்தச் சப்ளையரின் அறிக்கை போர்டலில் பகிரப்படவில்லை — அது பூஜ்ஜிய இருப்பு அல்ல.', noLines: 'இன்னும் அறிக்கை வரி இல்லை.',
    probeH: 'மற்ற சப்ளையர் தரவைத் தேடும் போர்டல் உள்நுழைவுகள்', probeShow: 'அவற்றைக் காட்டு', noProbing: 'தலைமை அலுவலகம் கவனிக்கும் அளவை ({threshold} மறுப்புகள்) எந்தச் சப்ளையர் உள்நுழைவும் எட்டவில்லை.', probeRow: '{user} (சப்ளையர் {partner}): {attempts} முயற்சிகள்', threshold: '{threshold} மறுப்புகளிலிருந்து எண்ணப்பட்டது',
    needPartner: 'முதலில் சப்ளையரைத் தட்டச்சு செய்யவும்.', needDate: 'நாளை YYYY-MM-DD ஆகக் கொடுக்கவும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு சப்ளையர் போர்டல் பதிவுகளை மதிப்பாய்வு செய்ய முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை.',
  },
} as const;

export function supplierPortalWatchWords(lang: Lang, key: string, fill?: Readonly<Record<string, string | number>>): string {
  const raw = (SUPPLIER_PORTAL_WATCH_COPY[lang] as Record<string, string>)[key] ?? (SUPPLIER_PORTAL_WATCH_COPY.en as Record<string, string>)[key] ?? key;
  return fill === undefined ? raw : raw.replace(/\{(\w+)\}/g, (_, k: string) => String(fill[k] ?? `{${k}}`));
}
export const supplierPortalWatchOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => supplierPortalWatchWords(lang, k), out);

export interface Compliance { readonly partnerId: string; readonly compliant: boolean; readonly documents: readonly { readonly kind: string; readonly reference?: string; readonly validUntil?: string; readonly state: string; readonly detail: string }[]; readonly blocking: readonly string[]; readonly detail: string }
export interface Statement {
  readonly partnerId: string; readonly accessible: boolean; readonly openingMinor: number; readonly invoicedMinor: number; readonly debitedMinor: number; readonly creditedMinor: number;
  readonly paidMinor: number; readonly closingMinor: number; readonly disputedMinor: number; readonly lines: readonly { readonly documentRef: string; readonly kind: string; readonly date: string; readonly amountMinor: number; readonly status: string }[];
  readonly reconciles: boolean; readonly detail: string;
}
export interface Probing { readonly probing: readonly { readonly partnerId: string; readonly userId: string; readonly attempts: number; readonly detail: string }[]; readonly threshold: number; readonly count: number }

type Why = 'nobody' | 'cannotRead' | 'needPartner' | 'needDate';
type Done<T> = Promise<Outcome<T, Why>>;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface SupplierPortalWatchSession {
  readonly may: { readonly named: boolean; readonly read: boolean };
  compliance(partnerId: string, asOf: string): Done<Compliance>;
  statement(partnerId: string): Done<Statement>;
  probing(): Done<Probing>;
}

export function createSupplierPortalWatchSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): SupplierPortalWatchSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('supplier.portal.review') };
  const call = makeCaller({ keyPrefix: 'supplier-portal-watch', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = () => (!named ? no('nobody') : !may.read ? no('cannotRead') : undefined);
  const enc = (s: string): string => encodeURIComponent(s.trim());
  return {
    may,
    compliance: async (p, asOf) => gate() ?? (p.trim() === '' ? no('needPartner') : !DAY.test(asOf.trim()) ? no('needDate') : call<Compliance>('GET', `/v1/supplier-portal/partners/${enc(p)}/compliance?asOf=${enc(asOf)}`)),
    statement: async (p) => gate() ?? (p.trim() === '' ? no('needPartner') : call<Statement>('GET', `/v1/supplier-portal/partners/${enc(p)}/statement`)),
    probing: async () => gate() ?? call<Probing>('GET', '/v1/supplier-portal/probing'),
  };
}
