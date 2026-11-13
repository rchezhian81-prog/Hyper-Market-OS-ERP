// W4 · WF-05 "… PO-GRN-invoice match → discrepancy → approval → AP/Tally" (M07 · M23-FR-01/04 · §28 · P-04 · P-05 · P-08 ·
// hard rules #2 #10) — the after-match steps of a supplier bill, each on the page that already does that kind of work. Three
// tested, DOM-free THIN clients over head office's own routes; nothing is read on open; every call is a click; head office
// re-checks every permission and every figure.
//
//   • SUPPLIER BILLS — THE SECOND PERSON'S CHECK. A bill typed from the paper is checked by a different person before it goes
//     on the register: the typist asks (`POST /v1/approvals/requests`, kind `supplier_invoice_check`, the bill exactly as
//     typed), the checker approves it on THEIR Approvals page, and the typist then saves the bill NAMING that approval
//     (`POST /v1/purchase/invoices/:invoiceId/capture` with `approvalId`) — head office refuses a bill that differs from what
//     was approved. Nobody checks their own bill.
//   • SUPPLIER BILLS — DEBIT NOTES. Goods sent back to a supplier (a receipt line decided "return") are a debit note on the
//     supplier's account (`GET /v1/purchase/suppliers/:supplierId/account`); issuing it gives it its DN number from the
//     shop's series, once (`POST /v1/purchase/suppliers/:supplierId/debit-notes/:ref/issue`).
//   • DAY BOOK — SUPPLIER BILLS IN THE BOOKS. The accountant puts what the supplier accounts owe in the books through HIS
//     posting rules (`POST /v1/finance/payables/post` — nothing is sent; the figures are the registers'), and reads each
//     journal posted, each exception and, per supplier, what the register says beside what the books carry
//     (`GET /v1/finance/payables`).
//   • TALLY FILES — THE MONTH'S SUPPLIER-BILL FILE. The month's payables vouchers as one Tally import file, checked by the
//     stand-in for Tally's import before it is offered (`GET /v1/finance/tally/ap-vouchers?period=`); a journal touching an
//     account with no Tally ledger name is kept out and named.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';
type Viewer = { readonly userId?: string; readonly permissions: readonly string[] } | undefined;

export const SUPPLIER_BOOKS_COPY = {
  en: {
    // Supplier bills — the second person's check
    checkH: 'A second person checks the typed bill', checkLead: 'Before a typed bill goes on the register, a different person checks it against the paper on their Approvals page. Once they approve it, save it here — exactly as it was checked.',
    askCheck: 'Ask a second person to check it', askedCheck: 'Asked. A second person checks it on their Approvals page; then save it here.',
    checksH: 'Bills waiting for their check', checksNone: 'No typed bill is waiting for a check.', waiting: 'waiting for the check', approved: 'checked — ready to save', rejected: 'not accepted', used: 'saved', expired: 'check expired',
    saveChecked: 'Save the checked bill', savedChecked: 'Saved on the register, checked by', checkedBy: 'checked by',
    needBill: 'Type the bill number, the supplier, the total and every line first.', notMoney: 'A figure is not money in rupees — check the lines.',
    // Supplier bills — debit notes
    dnH: 'Debit notes to a supplier', dnLead: 'Goods sent back to the supplier are taken off what the shop owes them as a debit note. Issue it to give it its number.',
    dnSupplierL: 'Supplier code', dnShow: 'Show the debit notes', dnNone: 'This supplier has no debit note.', dnIssue: 'Issue this debit note', dnIssued: 'Issued as',
    dnNotIssued: 'not issued yet', dnOwed: 'The shop owes this supplier', needSupplier: 'Type the supplier code first.',
    // Day book — supplier bills in the books
    apH: 'Supplier bills in the books', apLead: 'What the shop owes suppliers — matched bills, debit notes, payments — put in the books through the accountant\'s own rules. Nothing is typed: the figures are the bills\'. A bill not matched yet posts nothing.',
    apPost: 'Put supplier bills in the books', apShow: 'Show supplier bills in the books', apPosted: 'Put in the books:', apNothing: 'Nothing new to put in the books.',
    apJournalsNone: 'No supplier bill is in the books yet.', apRegister: 'register', apBooks: 'books', apAgrees: 'agrees', apDiffers: 'does not agree',
    dr: 'Debit', cr: 'Credit', apExceptions: 'Not in the books', kind_supplier_invoice: 'Bill', kind_supplier_invoice_reversal: 'Bill reduced', kind_supplier_debit_note: 'Debit note', kind_supplier_payment: 'Payment',
    kind_supplier_opening_balance: 'Opening balance', kind_supplier_opening_reversal: 'Opening reversed', kind_supplier_claim_credit: 'Supplier claim credited',
    // Tally files — the month's supplier-bill file
    tapH: 'Supplier bills for Tally, for a month', tapLead: 'The month\'s supplier-bill vouchers as one Tally import file, checked before it is offered. A voucher whose account has no Tally ledger name is kept out and named.',
    tapPeriodL: 'Month', tapShow: 'Make the month\'s supplier-bill file', tapEmpty: 'No supplier bill is in the books for this month — there is no file to make.',
    tapReady: 'Ready to import:', tapVouchers: 'voucher(s)', tapIncomplete: 'Not complete — these are kept out:', tapDownload: 'Download for Tally', tapChecked: 'Tally\'s import check accepts it.',
    tapNotChecked: 'Tally\'s import check found problems:', needPeriod: 'Choose the month first.',
    nobody: 'Nobody is signed in on this screen.', cannotCapture: 'Your role cannot type supplier bills.', cannotMatch: 'Your role cannot check supplier bills or issue debit notes.',
    cannotRead: 'Your role cannot see the books.', cannotPost: 'Your role cannot put anything in the books.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    checkH: 'தட்டச்சு செய்த பில்லை இரண்டாவது நபர் சரிபார்க்கிறார்', checkLead: 'தட்டச்சு செய்த பில் பதிவேட்டில் சேரும் முன், வேறொருவர் தம் அனுமதிப் பக்கத்தில் அதைக் காகிதத்துடன் சரிபார்க்கிறார். அவர் அனுமதித்ததும், சரிபார்த்தபடியே இங்கே சேமிக்கவும்.',
    askCheck: 'இரண்டாவது நபரைச் சரிபார்க்கக் கேள்', askedCheck: 'கேட்கப்பட்டது. இரண்டாவது நபர் தம் அனுமதிப் பக்கத்தில் சரிபார்ப்பார்; பிறகு இங்கே சேமிக்கவும்.',
    checksH: 'சரிபார்ப்புக்குக் காத்திருக்கும் பில்கள்', checksNone: 'எந்தத் தட்டச்சு பில்லும் சரிபார்ப்புக்குக் காத்திருக்கவில்லை.', waiting: 'சரிபார்ப்புக்குக் காத்திருக்கிறது', approved: 'சரிபார்க்கப்பட்டது — சேமிக்கத் தயார்', rejected: 'ஏற்கப்படவில்லை', used: 'சேமிக்கப்பட்டது', expired: 'சரிபார்ப்பு காலாவதியானது',
    saveChecked: 'சரிபார்த்த பில்லைச் சேமி', savedChecked: 'பதிவேட்டில் சேமிக்கப்பட்டது, சரிபார்த்தவர்', checkedBy: 'சரிபார்த்தவர்',
    needBill: 'முதலில் பில் எண், சப்ளையர், மொத்தம், ஒவ்வொரு வரியையும் தட்டச்சு செய்யவும்.', notMoney: 'ஒரு எண் ரூபாய்த் தொகை அல்ல — வரிகளைச் சரிபார்க்கவும்.',
    dnH: 'சப்ளையருக்கான பற்றுக் குறிப்புகள்', dnLead: 'சப்ளையருக்குத் திருப்பி அனுப்பிய பொருட்கள், கடை அவருக்குச் செலுத்த வேண்டியதிலிருந்து பற்றுக் குறிப்பாகக் கழிக்கப்படும். எண் தர அதை வெளியிடவும்.',
    dnSupplierL: 'சப்ளையர் குறியீடு', dnShow: 'பற்றுக் குறிப்புகளைக் காட்டு', dnNone: 'இந்தச் சப்ளையருக்குப் பற்றுக் குறிப்பு இல்லை.', dnIssue: 'இந்தப் பற்றுக் குறிப்பை வெளியிடு', dnIssued: 'வெளியிட்ட எண்',
    dnNotIssued: 'இன்னும் வெளியிடவில்லை', dnOwed: 'கடை இந்தச் சப்ளையருக்குச் செலுத்த வேண்டியது', needSupplier: 'முதலில் சப்ளையர் குறியீட்டைத் தட்டச்சு செய்யவும்.',
    apH: 'கணக்குப் புத்தகத்தில் சப்ளையர் பில்கள்', apLead: 'கடை சப்ளையர்களுக்குச் செலுத்த வேண்டியது — பொருத்திய பில்கள், பற்றுக் குறிப்புகள், செலுத்தியவை — கணக்காளரின் சொந்த விதிகளின்படி புத்தகத்தில் சேர்க்கப்படுகிறது. எதுவும் தட்டச்சு செய்யப்படவில்லை: எண்கள் பில்களுடையவை. இன்னும் பொருத்தாத பில் எதையும் பதியாது.',
    apPost: 'சப்ளையர் பில்களைப் புத்தகத்தில் சேர்', apShow: 'புத்தகத்தில் உள்ள சப்ளையர் பில்களைக் காட்டு', apPosted: 'புத்தகத்தில் சேர்க்கப்பட்டது:', apNothing: 'புத்தகத்தில் சேர்க்கப் புதிதாக எதுவும் இல்லை.',
    apJournalsNone: 'இன்னும் எந்தச் சப்ளையர் பில்லும் புத்தகத்தில் இல்லை.', apRegister: 'பதிவேடு', apBooks: 'புத்தகம்', apAgrees: 'பொருந்துகிறது', apDiffers: 'பொருந்தவில்லை',
    dr: 'பற்று', cr: 'வரவு', apExceptions: 'புத்தகத்தில் இல்லாதவை', kind_supplier_invoice: 'பில்', kind_supplier_invoice_reversal: 'பில் குறைப்பு', kind_supplier_debit_note: 'பற்றுக் குறிப்பு', kind_supplier_payment: 'செலுத்தியது',
    kind_supplier_opening_balance: 'தொடக்க இருப்பு', kind_supplier_opening_reversal: 'தொடக்க இருப்பு திரும்பப் பெறப்பட்டது', kind_supplier_claim_credit: 'சப்ளையர் கோரிக்கை வரவு வைக்கப்பட்டது',
    tapH: 'ஒரு மாதத்தின் சப்ளையர் பில்கள் டேலிக்கு', tapLead: 'மாதத்தின் சப்ளையர்-பில் வவுச்சர்கள் ஒரே டேலி இறக்குமதிக் கோப்பாக, தருவதற்கு முன் சரிபார்க்கப்படுகின்றன. டேலி லெட்ஜர் பெயர் இல்லாத கணக்கின் வவுச்சர் வெளியே வைக்கப்பட்டுப் பெயரிடப்படுகிறது.',
    tapPeriodL: 'மாதம்', tapShow: 'மாதத்தின் சப்ளையர்-பில் கோப்பை உருவாக்கு', tapEmpty: 'இந்த மாதத்துக்குப் புத்தகத்தில் எந்தச் சப்ளையர் பில்லும் இல்லை — உருவாக்கக் கோப்பு இல்லை.',
    tapReady: 'இறக்குமதிக்குத் தயார்:', tapVouchers: 'வவுச்சர்கள்', tapIncomplete: 'முழுமையில்லை — இவை வெளியே வைக்கப்பட்டன:', tapDownload: 'டேலிக்குப் பதிவிறக்கு', tapChecked: 'டேலியின் இறக்குமதிச் சரிபார்ப்பு இதை ஏற்கிறது.',
    tapNotChecked: 'டேலியின் இறக்குமதிச் சரிபார்ப்பு சிக்கல்களைக் கண்டது:', needPeriod: 'முதலில் மாதத்தைத் தேர்ந்தெடுக்கவும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotCapture: 'உங்கள் பணி சப்ளையர் பில்களைத் தட்டச்சு செய்ய முடியாது.', cannotMatch: 'உங்கள் பணி சப்ளையர் பில்களைச் சரிபார்க்கவோ பற்றுக் குறிப்புகளை வெளியிடவோ முடியாது.',
    cannotRead: 'உங்கள் பணி கணக்குப் புத்தகத்தைப் பார்க்க முடியாது.', cannotPost: 'உங்கள் பணி புத்தகத்தில் எதையும் சேர்க்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const supplierBooksWords = (lang: Lang, key: string): string =>
  (SUPPLIER_BOOKS_COPY[lang] as Record<string, string>)[key] ?? (SUPPLIER_BOOKS_COPY.en as Record<string, string>)[key] ?? key;
export const supplierBooksOutcomeWords = (lang: Lang, out: Outcome<unknown>, good: string): string =>
  out.result === 'ok' ? supplierBooksWords(lang, good) : outcomeIn((k) => supplierBooksWords(lang, k), out);
export const rupees = (minor: number): string => `${minor < 0 ? '−' : ''}₹${(Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Why = 'nobody' | 'cannotCapture' | 'cannotMatch' | 'cannotRead' | 'cannotPost' | 'needBill' | 'notMoney' | 'needSupplier' | 'needPeriod';
type Done<T> = Promise<Outcome<T, Why>>;
const gateOf = (viewer: Viewer) => {
  const named = viewer?.userId !== undefined;
  const held = new Set(viewer?.permissions ?? []);
  return (permission: string, why: Why): { result: 'invalid'; why: Why } | undefined =>
    (!named ? { result: 'invalid', why: 'nobody' } : !held.has(permission) ? { result: 'invalid', why } : undefined);
};
const enc = encodeURIComponent;

// ── Supplier bills: the second person's check, and debit notes ─────────────────────────────────────────────────────────

/** The typed bill exactly as head office will check it — the capture body (`typedCaptureBody`'s) and its invoice id. */
export interface TypedBill { readonly invoiceId: string; readonly body: Readonly<Record<string, unknown>> }
export interface AskedCheck {
  readonly requestId: string; readonly kind: string; readonly subjectRef: string; readonly status: 'waiting' | 'approved' | 'rejected' | 'expired' | 'used';
  readonly valueMinor: number | null; readonly summary: string; readonly details: Readonly<Record<string, unknown>>;
  readonly decidedBy?: string; readonly decisionReason?: string;
}
export interface SupplierDebitNote {
  readonly debitNoteRef: string; readonly grnId: string; readonly lineId: string; readonly productId: string; readonly quantityMinor: number;
  readonly taxableMinor: number; readonly valueMinor: number; readonly number: string | null; readonly issuedBy: string | null; readonly reason?: string;
}
export interface SupplierAccountView { readonly supplierId: string; readonly debitNotes: readonly SupplierDebitNote[]; readonly totals?: { readonly owedMinor: number } }

export const SUPPLIER_INVOICE_CHECK = 'supplier_invoice_check';

export interface BillCheckSession {
  readonly may: { readonly capture: boolean; readonly match: boolean };
  /** Ask a different person to check exactly this typed bill (the approval carries the bill as it will be saved). */
  askCheck(bill: TypedBill): Done<{ readonly requestId: string }>;
  /** The bill checks this person asked for (head office's own list of their requests). */
  asked(): Done<readonly AskedCheck[]>;
  /** Save the bill an approved check is for — exactly what was checked, naming the approval. */
  saveChecked(request: AskedCheck): Done<{ readonly invoiceId: string; readonly approvedBy: string | null }>;
  /** A supplier's account: its debit notes (goods sent back) and what the shop owes. */
  account(supplierId: string): Done<SupplierAccountView>;
  /** Issue a debit note — its DN number from the shop's series, once. */
  issueDebitNote(supplierId: string, debitNoteRef: string): Done<{ readonly number: string; readonly alreadyIssued: boolean }>;
}

export function createBillCheckSession(input: { readonly viewer: Viewer; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): BillCheckSession {
  const gate = gateOf(input.viewer);
  const held = new Set(input.viewer?.permissions ?? []);
  const call = makeCaller({ keyPrefix: 'bill-check', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  return {
    may: { capture: input.viewer?.userId !== undefined && held.has('purchase.invoice.capture'), match: input.viewer?.userId !== undefined && held.has('purchase.invoice.match') },
    askCheck: async (bill) => {
      const no = gate('purchase.invoice.capture', 'cannotCapture'); if (no !== undefined) return no;
      const total = bill.body['declaredTotalMinor'];
      if (bill.invoiceId.trim() === '' || typeof total !== 'number') return { result: 'invalid', why: 'needBill' };
      const supplier = String(bill.body['supplierId'] ?? '');
      return call('POST', '/v1/approvals/requests', {
        kind: SUPPLIER_INVOICE_CHECK, subjectRef: bill.invoiceId, valueMinor: total,
        // Exactly the bill as it will be saved (head office compares the saved bill with this, field by field).
        details: { ...bill.body, invoiceId: bill.invoiceId },
        summary: `Supplier bill ${bill.invoiceId} from ${supplier}: ₹${(total / 100).toFixed(2)}`,
        reason: 'Check the typed bill against the paper',
      });
    },
    asked: async () => {
      const no = gate('purchase.invoice.capture', 'cannotCapture'); if (no !== undefined) return no;
      const r = await call<{ mine?: AskedCheck[] }>('GET', '/v1/approvals/requests');
      if (r.result !== 'ok') return r;
      return { result: 'ok', value: (r.value.mine ?? []).filter((q) => q.kind === SUPPLIER_INVOICE_CHECK) };
    },
    saveChecked: async (request) => {
      const no = gate('purchase.invoice.capture', 'cannotCapture'); if (no !== undefined) return no;
      const { invoiceId, ...body } = request.details as Record<string, unknown>;
      const id = typeof invoiceId === 'string' ? invoiceId : request.subjectRef;
      const r = await call<{ invoice?: { approvedBy?: string | null } }>('POST', `/v1/purchase/invoices/${enc(id)}/capture`, { ...body, approvalId: request.requestId });
      return r.result === 'ok' ? { result: 'ok', value: { invoiceId: id, approvedBy: r.value.invoice?.approvedBy ?? null } } : r;
    },
    account: async (supplierId) => {
      const no = gate('purchase.invoice.match', 'cannotMatch'); if (no !== undefined) return no;
      if (supplierId.trim() === '') return { result: 'invalid', why: 'needSupplier' };
      return call('GET', `/v1/purchase/suppliers/${enc(supplierId.trim())}/account`);
    },
    issueDebitNote: async (supplierId, debitNoteRef) => {
      const no = gate('purchase.invoice.match', 'cannotMatch'); if (no !== undefined) return no;
      if (supplierId.trim() === '') return { result: 'invalid', why: 'needSupplier' };
      return call('POST', `/v1/purchase/suppliers/${enc(supplierId.trim())}/debit-notes/${enc(debitNoteRef)}/issue`, {});
    },
  };
}

// ── Day book: supplier bills in the books ──────────────────────────────────────────────────────────────────────────────

export interface PayablesJournalView {
  readonly entryId: string; readonly kind: string; readonly sourceId: string; readonly supplierId: string; readonly period: string; readonly documentDate: string;
  readonly lines: readonly { readonly accountCode: string; readonly debitMinor: number; readonly creditMinor: number }[]; readonly postedBy: string;
}
export interface PayablesRead {
  readonly journals: readonly PayablesJournalView[];
  readonly exceptions: readonly { readonly exceptionId: string; readonly kind: string; readonly reason: string; readonly detail?: string; readonly state: string; readonly supplierId?: string }[];
  readonly open: number;
  readonly reconciliation: { readonly suppliers?: readonly { readonly supplierId: string; readonly registerOwedMinor: number; readonly ledgerOwedMinor: number; readonly differenceMinor: number; readonly agrees: boolean }[] } & Record<string, unknown>;
}
export interface PayablesPosted { readonly planned: number; readonly journals: readonly PayablesJournalView[]; readonly exceptions: readonly { readonly kind: string; readonly reason: string; readonly detail?: string }[] }

export interface PayablesBooksSession {
  readonly may: { readonly read: boolean; readonly post: boolean };
  read(): Done<PayablesRead>;
  /** Put what the supplier accounts owe in the books — nothing is sent; head office posts from its own registers. */
  post(): Done<PayablesPosted>;
}

export function createPayablesBooksSession(input: { readonly viewer: Viewer; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): PayablesBooksSession {
  const gate = gateOf(input.viewer);
  const held = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const call = makeCaller({ keyPrefix: 'payables', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  return {
    may: { read: named && held.has('finance.period.read'), post: named && held.has('finance.journal.post') },
    read: async () => gate('finance.period.read', 'cannotRead') ?? call('GET', '/v1/finance/payables'),
    post: async () => gate('finance.journal.post', 'cannotPost') ?? call('POST', '/v1/finance/payables/post', {}),
  };
}

// ── Tally files: the month's supplier-bill file ──────────────────────────────────────────────────────────────────────

export interface ApVouchersRead {
  readonly period: string; readonly empty: boolean; readonly detail?: string; readonly fileName?: string; readonly xml?: string;
  readonly vouchers: readonly { readonly entryId: string }[]; readonly exceptions: readonly { readonly entryId: string; readonly reason: string; readonly accountCodes?: readonly string[] }[];
  readonly complete?: boolean; readonly controlTotals?: { readonly voucherCount: number; readonly debitMinor: number; readonly creditMinor: number };
  readonly check?: { readonly ok: boolean; readonly problems: readonly string[] };
}
export interface ApTallySession {
  readonly may: { readonly read: boolean };
  vouchers(period: string): Done<ApVouchersRead>;
}
export function createApTallySession(input: { readonly viewer: Viewer; readonly fetch?: typeof globalThis.fetch }): ApTallySession {
  const gate = gateOf(input.viewer);
  const call = makeCaller({ keyPrefix: 'ap-tally', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  return {
    may: { read: input.viewer?.userId !== undefined && (input.viewer?.permissions ?? []).includes('finance.period.read') },
    vouchers: async (period) => {
      const no = gate('finance.period.read', 'cannotRead'); if (no !== undefined) return no;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period.trim())) return { result: 'invalid', why: 'needPeriod' };
      return call('GET', `/v1/finance/tally/ap-vouchers?period=${enc(period.trim())}`);
    },
  };
}

