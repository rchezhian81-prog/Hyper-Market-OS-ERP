// Payables and receivables (U6 · M23-FR-01 "manage payable/receivable" · acceptance "AP/AR reconciles to purchase/sales" ·
// QG-07 · P-08; finance.md SP-9 "no screen shows the account or the journals") — a tested, DOM-free session over:
//   • `GET /v1/finance/payables` (`finance.period.read`): every supplier's account — what the purchase register says is
//     owed beside what the ledger holds on the control account, the difference always visible, the unposted entries, the
//     exceptions with their state, every posted voucher;
//   • `POST /v1/finance/payables/post` (`finance.journal.post`): post what the ledger does not yet hold — through the
//     accountant's mapping, once; a kind the mapping does not name is a visible exception;
//   • `GET /v1/finance/receivables` (`finance.period.read`): every credit customer's receivables beside the ledger's figure,
//     aged from the due date, the difference always visible.
// Head office re-checks every permission; `may` only shapes what is offered. Every word here has a Tamil twin (OB-699);
// head office's own sentences (an exception's detail, a refusal) stay English.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import type { RefusalLang } from './refusal-words';

export type Lang = 'en' | 'ta';

export const PAYABLES_RECEIVABLES_COPY = {
  en: {
    title: 'Payables and receivables',
    lead: 'The supplier accounts and the credit-customer accounts, each as two figures reached two different ways — the register beside the ledger — with the difference always shown. Posting goes through the accountant\'s mapping, once; nothing here edits a balance.',
    apH: 'Payables — what the shop owes suppliers', apLead: 'The purchase register (matched bills, debit notes, payments, signed opening balances) beside the finance ledger\'s control account.',
    arH: 'Receivables — what credit customers owe the shop', arLead: 'The collections register (open invoices aged from their due date) beside the finance ledger\'s receivables account for each customer.',
    cRegisterOwed: 'Register says owed', cLedgerOwed: 'Ledger holds', cDifference: 'Difference', cSuppliers: 'Suppliers', cUnposted: 'Entries not yet posted', cOpenExceptions: 'Open exceptions', cControl: 'Control account',
    cCustomers: 'Credit customers', cOutstanding: 'Register says outstanding', cInBooks: 'Ledger holds', cOverdue: 'Overdue', cDisputed: 'Disputed', cChaseable: 'Chaseable', cDiffering: 'Customers that differ',
    supplier: 'Supplier', customer: 'Customer', registerOwed: 'Register', ledgerOwed: 'Ledger', difference: 'Difference', state: 'State', unposted: 'Not posted', agrees: 'Agrees', differs: 'Differs', noControl: 'No control account in the mapping',
    suppliersH: 'By supplier', exceptionsH: 'Exceptions', journalsH: 'Posted vouchers', customersH: 'By customer',
    kind: 'Kind', reason: 'Reason', detail: 'What head office said', raisedAt: 'Raised', open: 'open', resolved: 'resolved',
    period: 'Month', documentDate: 'Document date', amount: 'Amount', postedBy: 'Posted by', entry: 'Voucher',
    outstanding: 'Outstanding', inBooks: 'In the books', overdue: 'Overdue', disputed: 'Disputed', chaseable: 'Chaseable', invoices: 'Invoices',
    post: 'Post the payables to the books', posting: 'Posting…', posted: 'Posted: {n} voucher(s); {x} exception(s).', nothingToPost: 'Nothing to post: the ledger already holds every entry.',
    confirmPostTitle: 'Post the payables now?', confirmPostDetail: '{n} entries across {s} supplier(s) that the ledger does not yet hold will be posted as balanced journals through the mapping, in your name. A re-run posts nothing twice. A kind the mapping does not name becomes a visible exception.',
    confirmPostAuthority: 'The accountant or the owner posts; the mapping decides the accounts.', confirmUnavailable: 'The confirm step could not open, so nothing was sent.',
    reload: 'Read again from head office', asAt: 'as at', readAt: 'read at',
    apNone: 'No supplier account yet.', apNoneDetail: 'No matched bill, debit note, payment or signed opening balance is on the purchase register, so there is nothing to post or to reconcile.',
    arNone: 'No credit customer yet.', arNoneDetail: 'No credit customer has an invoice, a collection or a movement on their receivables account.',
    exceptionsNone: 'No exception.', exceptionsNoneDetail: 'Every posting found its account in the mapping.', journalsNone: 'Nothing posted yet.', journalsNoneDetail: 'No payables voucher has been posted to the books.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read the accounts.', cannotPost: 'Your role can read the accounts but cannot post.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read.', reading: 'Reading from head office…', notReadDetail: 'Head office has not answered, so nothing here is known.',
    headOfficeEnglish: 'Head office\'s own sentences are in English.', leftRight: 'Left: {left}. Right: {right}.',
  },
  ta: {
    title: 'கொடுக்க வேண்டியவை, பெற வேண்டியவை',
    lead: 'சப்ளையர் கணக்குகளும் கடன் வாடிக்கையாளர் கணக்குகளும், ஒவ்வொன்றும் இரு வழிகளில் அடைந்த இரு எண்களாக — பதிவேட்டின் அருகில் பேரேடு — வேறுபாடு எப்போதும் காட்டப்படும். பதிவு கணக்காளரின் வரைபடம் வழியாக, ஒருமுறை மட்டும்; இங்கே இருப்பு திருத்தப்படாது.',
    apH: 'கொடுக்க வேண்டியவை — சப்ளையர்களுக்குக் கடை கொடுக்க வேண்டியது', apLead: 'கொள்முதல் பதிவேடு (பொருந்திய பில்கள், பற்றுக் குறிப்புகள், செலுத்தல்கள், கையெழுத்திட்ட தொடக்க இருப்புகள்) நிதிப் பேரேட்டின் கட்டுப்பாட்டுக் கணக்கின் அருகில்.',
    arH: 'பெற வேண்டியவை — கடன் வாடிக்கையாளர்கள் கடைக்குக் கொடுக்க வேண்டியது', arLead: 'வசூல் பதிவேடு (நிலுவைத் தேதியிலிருந்து கணக்கிட்ட திறந்த இன்வாய்ஸ்கள்) ஒவ்வொரு வாடிக்கையாளரின் நிதிப் பேரேட்டுக் கணக்கின் அருகில்.',
    cRegisterOwed: 'பதிவேடு சொல்வது', cLedgerOwed: 'பேரேட்டில் உள்ளது', cDifference: 'வேறுபாடு', cSuppliers: 'சப்ளையர்கள்', cUnposted: 'இன்னும் பதிவாகாதவை', cOpenExceptions: 'திறந்த விதிவிலக்குகள்', cControl: 'கட்டுப்பாட்டுக் கணக்கு',
    cCustomers: 'கடன் வாடிக்கையாளர்கள்', cOutstanding: 'பதிவேடு சொல்லும் நிலுவை', cInBooks: 'பேரேட்டில் உள்ளது', cOverdue: 'காலம் கடந்தது', cDisputed: 'தகராறில்', cChaseable: 'வசூலிக்கக்கூடியது', cDiffering: 'வேறுபடும் வாடிக்கையாளர்கள்',
    supplier: 'சப்ளையர்', customer: 'வாடிக்கையாளர்', registerOwed: 'பதிவேடு', ledgerOwed: 'பேரேடு', difference: 'வேறுபாடு', state: 'நிலை', unposted: 'பதிவாகாதவை', agrees: 'ஒத்துப்போகிறது', differs: 'வேறுபடுகிறது', noControl: 'வரைபடத்தில் கட்டுப்பாட்டுக் கணக்கு இல்லை',
    suppliersH: 'சப்ளையர் வாரியாக', exceptionsH: 'விதிவிலக்குகள்', journalsH: 'பதிவான வவுச்சர்கள்', customersH: 'வாடிக்கையாளர் வாரியாக',
    kind: 'வகை', reason: 'காரணம்', detail: 'தலைமை அலுவலகம் சொன்னது', raisedAt: 'எழுப்பியது', open: 'திறந்தது', resolved: 'தீர்க்கப்பட்டது',
    period: 'மாதம்', documentDate: 'ஆவணத் தேதி', amount: 'தொகை', postedBy: 'பதிவு செய்தவர்', entry: 'வவுச்சர்',
    outstanding: 'நிலுவை', inBooks: 'கணக்குகளில்', overdue: 'காலம் கடந்தது', disputed: 'தகராறில்', chaseable: 'வசூலிக்கக்கூடியது', invoices: 'இன்வாய்ஸ்கள்',
    post: 'கொடுக்க வேண்டியவற்றைக் கணக்குகளில் பதிவு செய்', posting: 'பதிவு செய்கிறது…', posted: 'பதிவானது: {n} வவுச்சர்(கள்); {x} விதிவிலக்கு(கள்).', nothingToPost: 'பதிவு செய்ய எதுவுமில்லை: பேரேட்டில் ஏற்கனவே ஒவ்வொரு பதிவும் உள்ளது.',
    confirmPostTitle: 'கொடுக்க வேண்டியவற்றை இப்போது பதிவு செய்யவா?', confirmPostDetail: 'பேரேட்டில் இன்னும் இல்லாத {s} சப்ளையர்(களின்) {n} பதிவுகள், வரைபடம் வழியாக சமநிலை ஜர்னல்களாக உங்கள் பெயரில் பதிவாகும். மீண்டும் இயக்கினால் இருமுறை பதிவாகாது. வரைபடம் பெயரிடாத வகை, தெரியும் விதிவிலக்காகும்.',
    confirmPostAuthority: 'கணக்காளர் அல்லது உரிமையாளர் பதிவு செய்வார்; கணக்குகளை வரைபடம் முடிவு செய்யும்.', confirmUnavailable: 'உறுதிப்படுத்தும் படி திறக்கவில்லை, எனவே எதுவும் அனுப்பப்படவில்லை.',
    reload: 'தலைமை அலுவலகத்திலிருந்து மீண்டும் படி', asAt: 'நிலவரப்படி', readAt: 'படித்த நேரம்',
    apNone: 'சப்ளையர் கணக்கு இன்னும் இல்லை.', apNoneDetail: 'பொருந்திய பில், பற்றுக் குறிப்பு, செலுத்தல் அல்லது கையெழுத்திட்ட தொடக்க இருப்பு கொள்முதல் பதிவேட்டில் இல்லை; எனவே பதிவு செய்யவோ சரிக்கட்டவோ எதுவுமில்லை.',
    arNone: 'கடன் வாடிக்கையாளர் இன்னும் இல்லை.', arNoneDetail: 'எந்தக் கடன் வாடிக்கையாளருக்கும் இன்வாய்ஸ், வசூல் அல்லது பெற வேண்டிய கணக்கில் நகர்வு இல்லை.',
    exceptionsNone: 'விதிவிலக்கு இல்லை.', exceptionsNoneDetail: 'ஒவ்வொரு பதிவும் வரைபடத்தில் அதன் கணக்கைக் கண்டது.', journalsNone: 'இன்னும் எதுவும் பதிவாகவில்லை.', journalsNoneDetail: 'கொடுக்க வேண்டியவற்றின் வவுச்சர் எதுவும் கணக்குகளில் பதிவாகவில்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி கணக்குகளைப் படிக்க முடியாது.', cannotPost: 'உங்கள் பணி கணக்குகளைப் படிக்கலாம், ஆனால் பதிவு செய்ய முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…', notReadDetail: 'தலைமை அலுவலகம் பதிலளிக்கவில்லை, எனவே இங்கே எதுவும் தெரியவில்லை.',
    headOfficeEnglish: 'தலைமை அலுவலகத்தின் சொந்த வாக்கியங்கள் ஆங்கிலத்தில் உள்ளன.', leftRight: 'இடது: {left}. வலது: {right}.',
  },
} as const;

export const payablesReceivablesWords = (lang: Lang, key: string): string =>
  (PAYABLES_RECEIVABLES_COPY[lang] as Record<string, string>)[key] ?? (PAYABLES_RECEIVABLES_COPY.en as Record<string, string>)[key] ?? key;

export interface SupplierRow { readonly supplierId: string; readonly registerOwedMinor: number; readonly ledgerOwedMinor: number; readonly differenceMinor: number; readonly agrees: boolean; readonly unposted: readonly unknown[] }
export interface PayablesException { readonly exceptionId: string; readonly kind: string; readonly reason: string; readonly detail?: string; readonly supplierId?: string; readonly sourceIds?: readonly string[]; readonly state: 'open' | 'resolved'; readonly raisedAt?: string }
export interface PayablesJournal { readonly entryId: string; readonly kind: string; readonly sourceId: string; readonly supplierId: string; readonly period: string; readonly documentDate: string; readonly postedBy: string; readonly lines: readonly { readonly accountCode: string; readonly debitMinor: number; readonly creditMinor: number }[] }
export interface Payables {
  readonly journals: readonly PayablesJournal[];
  readonly exceptions: readonly PayablesException[];
  readonly open: number;
  readonly reconciliation: { readonly controlAccount: string | null; readonly suppliers: readonly SupplierRow[]; readonly registerOwedMinor: number; readonly ledgerOwedMinor: number; readonly differenceMinor: number; readonly agrees: boolean; readonly leftDerivation?: string; readonly rightDerivation?: string };
  readonly asAt: string;
}
export interface CustomerRow { readonly customerId: string; readonly outstandingMinor: number; readonly financeOutstandingMinor: number; readonly differenceMinor: number; readonly agrees: boolean; readonly overdueMinor: number; readonly disputedMinor: number; readonly chaseableMinor: number; readonly invoices: number; readonly detail: string }
export interface Receivables {
  readonly asAt: string;
  readonly customers: readonly CustomerRow[];
  readonly totals: { readonly customers: number; readonly differing: number; readonly outstandingMinor: number; readonly financeOutstandingMinor: number; readonly differenceMinor: number; readonly overdueMinor: number; readonly disputedMinor: number; readonly chaseableMinor: number };
  readonly agrees: boolean | null;
  readonly leftDerivation: string;
  readonly rightDerivation: string;
}

type Why = 'nobody' | 'cannotRead' | 'cannotPost';
type Done<T> = Promise<Outcome<T, Why>>;

export interface PayablesReceivablesSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly post: boolean };
  payables(): Done<Payables>;
  receivables(): Done<Receivables>;
  post(): Done<{ journals: number; exceptions: number; planned: number }>;
}

export const payablesReceivablesOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => payablesReceivablesWords(lang, k), out, lang as RefusalLang);

/** The voucher's amount: the sum of its debit legs (a balanced journal's credits equal it). */
export const journalAmountMinor = (j: PayablesJournal): number => j.lines.reduce((n, l) => n + l.debitMinor, 0);

export function createPayablesReceivablesSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch;
}): PayablesReceivablesSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('finance.period.read'), post: named && held.has('finance.journal.post') };
  const call = makeCaller({ keyPrefix: 'ap-ar', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const gate = (need: 'read' | 'post'): { result: 'invalid'; why: Why } | undefined =>
    !named ? { result: 'invalid', why: 'nobody' } : !may.read ? { result: 'invalid', why: 'cannotRead' } : need === 'post' && !may.post ? { result: 'invalid', why: 'cannotPost' } : undefined;
  return {
    may,
    payables: async () => {
      const no = gate('read'); if (no !== undefined) return no;
      const out = await call<Record<string, unknown>>('GET', '/v1/finance/payables');
      if (out.result !== 'ok') return out;
      const v = out.value;
      const rec = (v['reconciliation'] ?? {}) as Payables['reconciliation'];
      return { result: 'ok', value: {
        journals: (Array.isArray(v['journals']) ? v['journals'] : []) as PayablesJournal[],
        exceptions: (Array.isArray(v['exceptions']) ? v['exceptions'] : []) as PayablesException[],
        open: typeof v['open'] === 'number' ? v['open'] : 0,
        reconciliation: { controlAccount: rec.controlAccount ?? null, suppliers: Array.isArray(rec.suppliers) ? rec.suppliers : [], registerOwedMinor: rec.registerOwedMinor ?? 0, ledgerOwedMinor: rec.ledgerOwedMinor ?? 0, differenceMinor: rec.differenceMinor ?? 0, agrees: rec.agrees === true, ...(rec.leftDerivation === undefined ? {} : { leftDerivation: rec.leftDerivation }), ...(rec.rightDerivation === undefined ? {} : { rightDerivation: rec.rightDerivation }) },
        asAt: String(v['asAt'] ?? ''),
      } };
    },
    receivables: async () => {
      const no = gate('read'); if (no !== undefined) return no;
      const out = await call<Record<string, unknown>>('GET', '/v1/finance/receivables');
      if (out.result !== 'ok') return out;
      const v = out.value;
      const totals = (v['totals'] ?? {}) as Receivables['totals'];
      return { result: 'ok', value: {
        asAt: String(v['asAt'] ?? ''), customers: (Array.isArray(v['customers']) ? v['customers'] : []) as CustomerRow[],
        totals: { customers: totals.customers ?? 0, differing: totals.differing ?? 0, outstandingMinor: totals.outstandingMinor ?? 0, financeOutstandingMinor: totals.financeOutstandingMinor ?? 0, differenceMinor: totals.differenceMinor ?? 0, overdueMinor: totals.overdueMinor ?? 0, disputedMinor: totals.disputedMinor ?? 0, chaseableMinor: totals.chaseableMinor ?? 0 },
        agrees: typeof v['agrees'] === 'boolean' ? v['agrees'] : null, leftDerivation: String(v['leftDerivation'] ?? ''), rightDerivation: String(v['rightDerivation'] ?? ''),
      } };
    },
    post: async () => {
      const no = gate('post'); if (no !== undefined) return no;
      const out = await call<{ journals?: unknown[]; exceptions?: unknown[]; planned?: number }>('POST', '/v1/finance/payables/post', {});
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: { journals: Array.isArray(out.value.journals) ? out.value.journals.length : 0, exceptions: Array.isArray(out.value.exceptions) ? out.value.exceptions.length : 0, planned: typeof out.value.planned === 'number' ? out.value.planned : 0 } };
    },
  };
}
