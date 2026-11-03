// Business customers · "Chasing, the books and the order chain" (W5 · M22-FR-01/04 "outstanding and collection tracking" ·
// M22-FR-02 "quote → order → challan → invoice" · M23-FR-01 "AP/AR reconciles to purchase/sales" · M22-FR-04 portal access ·
// §35 · P-03 · P-05 · P-08) — a tested, DOM-free session over four head-office reads no screen reached:
//   • THE NEXT STEP IN CHASING (`GET /v1/b2b/collections/:customerId/dunning?asOf=`) — statement, reminder, final notice or
//     stop supply, as head office decides it on the day. Stopping supply is only ever RECOMMENDED: head office marks it as
//     needing a person, and nothing here sends or stops anything;
//   • WHAT THE CUSTOMER SEES AGAINST THE BOOKS (`GET …/reconciliation?asOf=`) — the collections ageing total against the AR
//     balance finance holds, the difference exact and with its sign (finance's own permission, a rung above chasing);
//   • THE ORDER'S CHAIN (`GET /v1/b2b/documents/:customerId/orders/:orderId/chain`) — ordered, delivered and billed, and
//     what left the building with no bill;
//   • PORTAL LOGINS TRYING OTHER CUSTOMERS' DATA (`GET /v1/b2b-portal/probing`) — the tenant-wide security view; the
//     threshold is head office's (it says which it used).
// The day is the shop's own date (never the device's). Every read is a click; nothing is written.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const B2B_BOOKS_COPY = {
  en: {
    bkH: 'Chasing, the books and the order chain', bkLede: 'For the customer typed here: the next step in chasing what is overdue, what the customer is shown against what the books hold, and one order from what was ordered to what was billed. Nothing is sent or stopped from here — a person decides.',
    customer: 'Customer', asOf: 'As on', order: 'Order number', dunning: 'Next step in chasing', reconcile: 'Customer\'s balance against the books', chain: 'Check this order\'s chain', probing: 'Portal logins trying other customers\' data',
    step_none: 'Nothing to chase', step_statement: 'Put it on the next statement', step_reminder: 'Send a reminder', step_final_notice: 'Draft a final notice for a person to send', step_stop_supply: 'Stopping supply is RECOMMENDED — a person decides',
    chaseable: 'Overdue and not queried', worst: 'Oldest overdue (days)', needsPerson: 'A person must decide before anything is sent.',
    portal: 'What the customer is shown', books: 'What the books hold', difference: 'Difference', agrees: 'agrees exactly', differs: 'does not agree',
    ordered: 'Ordered', delivered: 'Delivered', billed: 'Billed', undelivered: 'Still to deliver', unbilled: 'Delivered, not billed', complete: 'ordered, delivered and billed agree',
    noProbing: 'No portal login has reached the pattern head office watches for ({threshold} refusals).', probingRow: '{user} (customer {customer}): {attempts} attempts, {targets} other customer(s)', threshold: 'Counted from {threshold} refusals',
    needCustomer: 'Type the customer first.', needOrder: 'Type the order number.', needDate: 'Give the day as YYYY-MM-DD.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see business customer accounts.', cannotReconcile: 'Comparing with the books needs finance\'s permission.', cannotDocs: 'Your role cannot see business documents.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read.',
  },
  ta: {
    bkH: 'வசூல் பின்தொடர்வு, கணக்குப் புத்தகம், ஆர்டர் சங்கிலி', bkLede: 'இங்கே தட்டச்சு செய்த வாடிக்கையாளருக்கு: தாமதமானதை வசூலிக்க அடுத்த படி, வாடிக்கையாளருக்குக் காட்டப்படுவதும் புத்தகம் வைத்திருப்பதும், ஒரு ஆர்டர் — ஆர்டர் செய்ததிலிருந்து பில் போட்டது வரை. இங்கிருந்து எதுவும் அனுப்பப்படாது, நிறுத்தப்படாது — ஒருவர் முடிவு செய்கிறார்.',
    customer: 'வாடிக்கையாளர்', asOf: 'தேதியில்', order: 'ஆர்டர் எண்', dunning: 'வசூலில் அடுத்த படி', reconcile: 'வாடிக்கையாளர் இருப்பும் புத்தகமும்', chain: 'இந்த ஆர்டரின் சங்கிலியைச் சரிபார்', probing: 'மற்ற வாடிக்கையாளர் தரவைத் தேடும் போர்டல் உள்நுழைவுகள்',
    step_none: 'வசூலிக்க எதுவும் இல்லை', step_statement: 'அடுத்த அறிக்கையில் சேர்', step_reminder: 'நினைவூட்டல் அனுப்பு', step_final_notice: 'ஒருவர் அனுப்ப இறுதி அறிவிப்பை வரைவு செய்', step_stop_supply: 'விநியோகத்தை நிறுத்தப் பரிந்துரைக்கப்படுகிறது — ஒருவர் முடிவு செய்கிறார்',
    chaseable: 'தாமதமானது, கேள்வி எழுப்பப்படாதது', worst: 'மிகப் பழைய தாமதம் (நாட்கள்)', needsPerson: 'எதுவும் அனுப்பும் முன் ஒருவர் முடிவு செய்ய வேண்டும்.',
    portal: 'வாடிக்கையாளருக்குக் காட்டப்படுவது', books: 'புத்தகம் வைத்திருப்பது', difference: 'வேறுபாடு', agrees: 'சரியாகப் பொருந்துகிறது', differs: 'பொருந்தவில்லை',
    ordered: 'ஆர்டர் செய்தது', delivered: 'விநியோகித்தது', billed: 'பில் போட்டது', undelivered: 'இன்னும் விநியோகிக்க வேண்டியது', unbilled: 'விநியோகித்தது, பில் இல்லை', complete: 'ஆர்டர், விநியோகம், பில் பொருந்துகின்றன',
    noProbing: 'தலைமை அலுவலகம் கவனிக்கும் அளவை ({threshold} மறுப்புகள்) எந்தப் போர்டல் உள்நுழைவும் எட்டவில்லை.', probingRow: '{user} (வாடிக்கையாளர் {customer}): {attempts} முயற்சிகள், {targets} மற்ற வாடிக்கையாளர்கள்', threshold: '{threshold} மறுப்புகளிலிருந்து எண்ணப்பட்டது',
    needCustomer: 'முதலில் வாடிக்கையாளரைத் தட்டச்சு செய்யவும்.', needOrder: 'ஆர்டர் எண்ணைத் தட்டச்சு செய்யவும்.', needDate: 'நாளை YYYY-MM-DD ஆகக் கொடுக்கவும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு வணிக வாடிக்கையாளர் கணக்குகளைப் பார்க்க முடியாது.', cannotReconcile: 'புத்தகத்துடன் ஒப்பிட நிதித்துறையின் அனுமதி தேவை.', cannotDocs: 'உங்கள் பங்கு வணிக ஆவணங்களைப் பார்க்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை.',
  },
} as const;

export function b2bBooksWords(lang: Lang, key: string, fill?: Readonly<Record<string, string | number>>): string {
  const raw = (B2B_BOOKS_COPY[lang] as Record<string, string>)[key] ?? (B2B_BOOKS_COPY.en as Record<string, string>)[key] ?? key;
  return fill === undefined ? raw : raw.replace(/\{(\w+)\}/g, (_, k: string) => String(fill[k] ?? `{${k}}`));
}
export const b2bBooksOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => b2bBooksWords(lang, k), out);

export interface Dunning { readonly customerId: string; readonly step: 'none' | 'statement' | 'reminder' | 'final_notice' | 'stop_supply'; readonly chaseableMinor: number; readonly worstDaysOverdue: number; readonly needsHuman: boolean; readonly detail: string }
export interface ArReconciliation { readonly customerId: string; readonly portalOutstandingMinor: number; readonly financeOutstandingMinor: number; readonly differenceMinor: number; readonly agrees: boolean; readonly detail: string }
export interface Chain { readonly orderId: string; readonly complete: boolean; readonly orderedMinor: number; readonly deliveredMinor: number; readonly invoicedMinor: number; readonly undeliveredMinor: number; readonly uninvoicedMinor: number; readonly detail: string }
export interface Probing { readonly probing: readonly { readonly customerId: string; readonly userId: string; readonly attempts: number; readonly distinctTargets: number; readonly detail: string }[]; readonly threshold: number; readonly count: number }

type Why = 'nobody' | 'cannotRead' | 'cannotReconcile' | 'cannotDocs' | 'needCustomer' | 'needOrder' | 'needDate';
type Done<T> = Promise<Outcome<T, Why>>;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface B2BBooksSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly reconcile: boolean; readonly documents: boolean };
  dunning(customerId: string, asOf: string): Done<Dunning>;
  reconciliation(customerId: string, asOf: string): Done<ArReconciliation>;
  chain(customerId: string, orderId: string): Done<Chain>;
  probing(): Done<Probing>;
}

export function createB2BBooksSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): B2BBooksSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('b2b.account.read'), reconcile: named && held.has('b2b.receivable.record'), documents: named && held.has('b2b.document.read') };
  const call = makeCaller({ keyPrefix: 'b2b-books', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const enc = (s: string): string => encodeURIComponent(s.trim());
  const check = (need: 'read' | 'reconcile' | 'documents', customerId: string, asOf?: string) => {
    if (!named) return no('nobody');
    if (!may[need]) return no(need === 'read' ? 'cannotRead' : need === 'reconcile' ? 'cannotReconcile' : 'cannotDocs');
    if (customerId.trim() === '') return no('needCustomer');
    if (asOf !== undefined && !DAY.test(asOf.trim())) return no('needDate');
    return undefined;
  };
  return {
    may,
    dunning: async (c, asOf) => check('read', c, asOf) ?? call<Dunning>('GET', `/v1/b2b/collections/${enc(c)}/dunning?asOf=${enc(asOf)}`),
    reconciliation: async (c, asOf) => check('reconcile', c, asOf) ?? call<ArReconciliation>('GET', `/v1/b2b/collections/${enc(c)}/reconciliation?asOf=${enc(asOf)}`),
    chain: async (c, o) => check('documents', c) ?? (o.trim() === '' ? no('needOrder') : call<Chain>('GET', `/v1/b2b/documents/${enc(c)}/orders/${enc(o)}/chain`)),
    probing: async () => (!named ? no('nobody') : !may.read ? no('cannotRead') : call<Probing>('GET', '/v1/b2b-portal/probing')),
  };
}
