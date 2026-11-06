// Supplier advances on the Supplier bills page (D10-FR-01 "chart/ledger mapping, AP/AR and advances" · §17.1 · M23-FR-01 ·
// WF-18 · §28 · hard rules #2, #10). A tested, DOM-free THIN client over head office's own routes
// (services/finance/src/supplier-advances.ts):
//   • THE REGISTER (`GET /v1/finance/supplier-advances`) — every advance paid to a supplier before the bill: paid, used
//     against bills, left; each use; and the advances account in the ledger beside the register — two figures reached two
//     ways, with whether they agree ("not known" when the mapping names no account, never zero — P-08);
//   • PAY an advance — paying a supplier is a payment, so the person ASKS (kind `supplier_payment`, subject
//     `advance:<id>`, exactly the payment's details and amount); a DIFFERENT person with the paying authority approves on the
//     Approvals page; the asker then RECORDS it, naming that approval — the payment's details are taken from the approved
//     request itself, so what is recorded is exactly what was approved (never retyped);
//   • USE an advance against the same supplier's matched bill (one journal), or UNDO a use by a reversal (a compensating
//     journal — never a deletion).
// Head office re-checks every permission, the approval, the supplier, the bill and every amount. Nothing is read on open.

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';
import { paiseOf, rupees } from './blanket-orders-session';

export { rupees };
export type Lang = 'en' | 'ta';

export const SUPPLIER_ADVANCES_COPY = {
  en: {
    h: 'Supplier advances', lead: 'Money paid to a supplier before the bill. It stays the shop\'s until a bill of the same supplier uses it up. Paying one needs a second person\'s approval.',
    show: 'Show the advances', none: 'No advance has been paid.', advance: 'Advance', supplier: 'Supplier', order: 'order', paid: 'Paid', used: 'Used against bills', left: 'Left',
    paidOn: 'paid on', approvedBy: 'approved by', uses: 'Uses', bill: 'bill', undoOf: 'undo of', noUses: 'Not used against any bill yet.',
    ledgerAgrees: 'The advances left on the register equal the advances account in the ledger.', ledgerDisagrees: 'The advances left on the register do NOT equal the advances account in the ledger — a person must look.',
    ledgerNotKnown: 'The ledger side is not known: the accountant\'s mapping names no account for supplier advances.', register: 'On the register', ledger: 'In the ledger',
    askH: 'Pay an advance', amountRs: 'Amount (₹)', paidOnL: 'Paid on', method: 'How', m_bank_transfer: 'Bank transfer', m_cheque: 'Cheque', m_upi: 'UPI', m_cash: 'Cash',
    reference: 'Bank or cheque reference', poId: 'Against order (optional)', ask: 'Ask for approval to pay',
    askedNow: 'Asked. A different person who pays suppliers approves exactly this payment on the Approvals page; then record it below.',
    approvedH: 'Payments you asked for', st_waiting: 'Waiting for a second person', st_approved: 'Approved — record it once paid', st_rejected: 'Rejected', st_expired: 'Approval ran out — ask again', st_used: 'Recorded',
    record: 'Record this payment', recordedNow: 'Recorded — one journal in the books, with who approved it.', already: 'Already recorded — nothing changed.',
    // U1 · OB-691: the consequence-and-confirm sheet before an advance payment is recorded
    confirmTitle: 'Record {amount} paid to supplier {supplier} as an advance ({method} {reference})',
    confirmDetail: 'The money is in the books from now and is set against this supplier\'s next bills. An advance already used is undone only line by line, with a reason.',
    confirmAuthority: 'In your name; a second person approved this payment. Head office refuses it if the approval does not match these figures.',
    confirmLabel: 'Record the payment', confirmUnavailable: 'The confirm step could not open, so nothing was sent. Reload the page and try again.',
    useH: 'Use against a bill', invoiceId: 'The supplier\'s matched bill number', usedOn: 'On (YYYY-MM-DD)', use: 'Use it', usedNow: 'Used against the bill — one journal in the books.',
    undo: 'Undo this use', undoneNow: 'Undone by a compensating journal — the bill is owed again and the advance is open again.',
    needAsk: 'Fill in the supplier, an amount in rupees, the day (YYYY-MM-DD), how it was paid and the reference.', needUse: 'Write the bill number, an amount in rupees and the day (YYYY-MM-DD).', needUndo: 'Write the day (YYYY-MM-DD) for the undo.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read the supplier advances.', cannotPay: 'Your role cannot pay suppliers.', cannotUse: 'Your role cannot post journals.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    h: 'விநியோகஸ்தர் முன்பணங்கள்', lead: 'பில் வருவதற்கு முன் விநியோகஸ்தருக்குச் செலுத்திய பணம். அதே விநியோகஸ்தரின் பில் அதைப் பயன்படுத்தும் வரை அது கடையுடையது. செலுத்த இரண்டாமவர் அனுமதி தேவை.',
    show: 'முன்பணங்களைக் காட்டு', none: 'எந்த முன்பணமும் செலுத்தப்படவில்லை.', advance: 'முன்பணம்', supplier: 'விநியோகஸ்தர்', order: 'ஆணை', paid: 'செலுத்தியது', used: 'பில்களுக்குப் பயன்படுத்தியது', left: 'மீதம்',
    paidOn: 'செலுத்திய நாள்', approvedBy: 'அனுமதித்தவர்', uses: 'பயன்பாடுகள்', bill: 'பில்', undoOf: 'இதை ரத்து செய்தது', noUses: 'இன்னும் எந்தப் பில்லுக்கும் பயன்படுத்தவில்லை.',
    ledgerAgrees: 'பதிவேட்டில் மீதமுள்ள முன்பணங்கள் பேரேட்டின் முன்பணக் கணக்குக்குச் சமம்.', ledgerDisagrees: 'பதிவேட்டில் மீதமுள்ள முன்பணங்கள் பேரேட்டின் முன்பணக் கணக்குக்குச் சமமில்லை — ஒருவர் பார்க்க வேண்டும்.',
    ledgerNotKnown: 'பேரேட்டுப் பக்கம் தெரியவில்லை: கணக்காளரின் வரைபடத்தில் விநியோகஸ்தர் முன்பணத்துக்குக் கணக்கு இல்லை.', register: 'பதிவேட்டில்', ledger: 'பேரேட்டில்',
    askH: 'முன்பணம் செலுத்து', amountRs: 'தொகை (₹)', paidOnL: 'செலுத்திய நாள்', method: 'எப்படி', m_bank_transfer: 'வங்கிப் பரிமாற்றம்', m_cheque: 'காசோலை', m_upi: 'யுபிஐ', m_cash: 'ரொக்கம்',
    reference: 'வங்கி அல்லது காசோலைக் குறிப்பு', poId: 'ஆணைக்கு எதிராக (விருப்பம்)', ask: 'செலுத்த அனுமதி கேள்',
    askedNow: 'கேட்கப்பட்டது. விநியோகஸ்தர்களுக்குச் செலுத்தும் வேறொருவர் இதே செலுத்துதலை அனுமதிகள் பக்கத்தில் அனுமதிப்பார்; பின்னர் கீழே பதிவு செய்யுங்கள்.',
    approvedH: 'நீங்கள் கேட்ட செலுத்துதல்கள்', st_waiting: 'இரண்டாமவருக்காகக் காத்திருக்கிறது', st_approved: 'அனுமதிக்கப்பட்டது — செலுத்தியதும் பதிவு செய்யுங்கள்', st_rejected: 'நிராகரிக்கப்பட்டது', st_expired: 'அனுமதி காலாவதியானது — மீண்டும் கேளுங்கள்', st_used: 'பதிவானது',
    record: 'இந்தச் செலுத்துதலைப் பதிவு செய்', recordedNow: 'பதிவானது — கணக்கில் ஒரு பதிவு, அனுமதித்தவருடன்.', already: 'ஏற்கனவே பதிவானது — எதுவும் மாறவில்லை.',
    confirmTitle: 'விநியோகஸ்தர் {supplier}க்கு முன்பணமாகச் செலுத்திய {amount} பதியப்படும் ({method} {reference})',
    confirmDetail: 'இனி அந்தப் பணம் கணக்கில் இருக்கும்; இந்த விநியோகஸ்தரின் அடுத்த பில்களுக்கு எதிராக வைக்கப்படும். பயன்படுத்திய முன்பணம் வரிவாரியாக, காரணத்துடன் மட்டுமே திரும்பப் பெறப்படும்.',
    confirmAuthority: 'உங்கள் பெயரில்; இரண்டாம் நபர் இந்தச் செலுத்துதலை ஒப்புதல் செய்தார். ஒப்புதல் இந்த எண்களுடன் பொருந்தவில்லையெனில் தலைமை அலுவலகம் மறுக்கும்.',
    confirmLabel: 'செலுத்துதலைப் பதிவு செய்', confirmUnavailable: 'உறுதிப்படுத்தும் திரையைத் திறக்க முடியவில்லை, எனவே எதுவும் அனுப்பப்படவில்லை. பக்கத்தைப் புதுப்பித்து மீண்டும் முயற்சிக்கவும்.',
    useH: 'பில்லுக்கு எதிராகப் பயன்படுத்து', invoiceId: 'விநியோகஸ்தரின் பொருந்திய பில் எண்', usedOn: 'நாள் (YYYY-MM-DD)', use: 'பயன்படுத்து', usedNow: 'பில்லுக்கு எதிராகப் பயன்படுத்தப்பட்டது — கணக்கில் ஒரு பதிவு.',
    undo: 'இந்தப் பயன்பாட்டை ரத்து செய்', undoneNow: 'ஈடுசெய்யும் பதிவால் ரத்தானது — பில் மீண்டும் நிலுவை, முன்பணம் மீண்டும் திறந்தது.',
    needAsk: 'விநியோகஸ்தர், ரூபாயில் தொகை, நாள் (YYYY-MM-DD), எப்படிச் செலுத்தியது, குறிப்பு — நிரப்புங்கள்.', needUse: 'பில் எண், ரூபாயில் தொகை, நாள் (YYYY-MM-DD) — எழுதுங்கள்.', needUndo: 'ரத்து செய்யும் நாளை எழுதுங்கள் (YYYY-MM-DD).',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி விநியோகஸ்தர் முன்பணங்களைப் படிக்க முடியாது.', cannotPay: 'உங்கள் பணி விநியோகஸ்தர்களுக்குச் செலுத்த முடியாது.', cannotUse: 'உங்கள் பணி கணக்குப் பதிவுகள் இட முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const advancesWords = (lang: Lang, key: string): string =>
  (SUPPLIER_ADVANCES_COPY[lang] as Record<string, string>)[key] ?? (SUPPLIER_ADVANCES_COPY.en as Record<string, string>)[key] ?? key;

export interface AdvancePosition {
  readonly advanceId: string; readonly supplierId: string; readonly poId: string | null; readonly paidMinor: number; readonly appliedMinor: number; readonly leftMinor: number;
  readonly paidOn: string; readonly approvedBy: string | null;
  readonly applications: readonly { readonly applicationId: string; readonly invoiceId: string | null; readonly amountMinor: number; readonly on: string; readonly reverses: string | null }[];
}
export interface AdvancesRegister { readonly advances: readonly AdvancePosition[]; readonly registerLeftMinor: number; readonly advancesAccount: string | null; readonly ledgerMinor: number | null; readonly agrees: boolean; readonly asAt: string }
export interface PaymentAsk { readonly requestId: string; readonly subjectRef: string; readonly status: string; readonly details: Record<string, unknown>; readonly valueMinor: number | null }
export interface AskForm { readonly supplierId: string; readonly amountRupees: string; readonly paidOn: string; readonly method: string; readonly reference: string; readonly poId: string }
export interface UseForm { readonly invoiceId: string; readonly amountRupees: string; readonly on: string }

type Why = 'nobody' | 'cannotRead' | 'cannotPay' | 'cannotUse' | 'needAsk' | 'needUse' | 'needUndo';
type Done<T = Record<string, unknown>> = Promise<Outcome<T, Why>>;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const METHODS = ['bank_transfer', 'cheque', 'upi', 'cash'] as const;
const seg = (s: string): string => encodeURIComponent(s.trim());
const ADVANCE_PREFIX = 'advance:';

/** The payment as head office's pay route reads it (the same details are asked for), or null when the form is not complete. */
export function advanceBody(f: AskForm): Record<string, unknown> | null {
  const amountMinor = paiseOf(f.amountRupees);
  if (f.supplierId.trim() === '' || amountMinor === null || amountMinor <= 0 || !DAY.test(f.paidOn.trim()) || !(METHODS as readonly string[]).includes(f.method) || f.reference.trim() === '') return null;
  return { supplierId: f.supplierId.trim(), amountMinor, paidOn: f.paidOn.trim(), method: f.method, reference: f.reference.trim(), ...(f.poId.trim() === '' ? {} : { poId: f.poId.trim() }) };
}

export const advancesOutcomeWords = (lang: Lang, out: Outcome<unknown>, good: string): string => {
  if (out.result !== 'ok') return outcomeIn((k) => advancesWords(lang, k), out);
  return advancesWords(lang, (out.value as { alreadyRecorded?: boolean } | undefined)?.alreadyRecorded === true ? 'already' : good);
};

export interface SupplierAdvancesSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly pay: boolean; readonly use: boolean };
  register(): Done<AdvancesRegister>;
  askToPay(f: AskForm): Done<{ readonly requestId: string; readonly advanceId: string }>;
  /** The advance payments this person asked for, newest last — each with where its approval stands. */
  myAsks(): Done<readonly PaymentAsk[]>;
  record(ask: PaymentAsk): Done<{ readonly alreadyRecorded: boolean }>;
  use(advanceId: string, f: UseForm): Done<{ readonly alreadyRecorded: boolean }>;
  undo(advanceId: string, application: { readonly applicationId: string; readonly amountMinor: number }, on: string): Done<{ readonly alreadyRecorded: boolean }>;
}

export function createSupplierAdvancesSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newId?: (prefix: string) => string;
}): SupplierAdvancesSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('finance.period.read'), pay: named && held.has('purchase.supplier.pay'), use: named && held.has('finance.journal.post') };
  const call = makeCaller({ keyPrefix: 'supplier-advances', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const idOf = input.newId ?? newId;
  const gate = (need: 'read' | 'pay' | 'use'): { result: 'invalid'; why: Why } | undefined =>
    !named ? { result: 'invalid', why: 'nobody' } : !may[need] ? { result: 'invalid', why: need === 'read' ? 'cannotRead' : need === 'pay' ? 'cannotPay' : 'cannotUse' } : undefined;
  return {
    may,
    register: async () => gate('read') ?? call('GET', '/v1/finance/supplier-advances'),
    askToPay: async (f) => {
      const no = gate('pay'); if (no !== undefined) return no;
      const body = advanceBody(f); if (body === null) return { result: 'invalid', why: 'needAsk' };
      const advanceId = idOf('adv');
      // The engine fingerprints the pay route's details: its body plus the path id (`actionDetails`).
      const out = await call<{ requestId: string }>('POST', '/v1/approvals/requests', {
        kind: 'supplier_payment', subjectRef: `${ADVANCE_PREFIX}${advanceId}`, details: { ...body, advanceId }, valueMinor: body['amountMinor'],
        summary: `Advance to supplier ${String(body['supplierId'])}: ${rupees(body['amountMinor'] as number)} by ${String(body['method'])}, ref ${String(body['reference'])}`, reason: `Advance before the bill${body['poId'] === undefined ? '' : ` for order ${String(body['poId'])}`}`,
      });
      return out.result === 'ok' ? { result: 'ok', value: { requestId: out.value.requestId, advanceId } } : out;
    },
    myAsks: async () => {
      const no = gate('pay'); if (no !== undefined) return no;
      const mine = await call<{ mine?: readonly (PaymentAsk & { readonly kind: string })[] }>('GET', '/v1/approvals/requests');
      if (mine.result !== 'ok') return mine;
      return { result: 'ok', value: (mine.value.mine ?? []).filter((q) => q.kind === 'supplier_payment' && q.subjectRef.startsWith(ADVANCE_PREFIX)) };
    },
    // Exactly what was approved is recorded: the details come from the approved request, never from a form typed again.
    record: async (ask) => {
      const no = gate('pay'); if (no !== undefined) return no;
      const advanceId = ask.subjectRef.slice(ADVANCE_PREFIX.length);
      const body = Object.fromEntries(Object.entries(ask.details).filter(([k]) => k !== 'advanceId'));
      return call('POST', `/v1/finance/supplier-advances/${seg(advanceId)}`, { ...body, approvalId: ask.requestId });
    },
    use: async (advanceId, f) => {
      const no = gate('use'); if (no !== undefined) return no;
      const amountMinor = paiseOf(f.amountRupees);
      if (f.invoiceId.trim() === '' || amountMinor === null || amountMinor <= 0 || !DAY.test(f.on.trim())) return { result: 'invalid', why: 'needUse' };
      return call('POST', `/v1/finance/supplier-advances/${seg(advanceId)}/applications/${encodeURIComponent(idOf('use'))}`, { amountMinor, invoiceId: f.invoiceId.trim(), appliedOn: f.on.trim() });
    },
    undo: async (advanceId, application, on) => {
      const no = gate('use'); if (no !== undefined) return no;
      if (!DAY.test(on.trim())) return { result: 'invalid', why: 'needUndo' };
      return call('POST', `/v1/finance/supplier-advances/${seg(advanceId)}/applications/${encodeURIComponent(idOf('undo'))}`, { reverses: application.applicationId, amountMinor: application.amountMinor, appliedOn: on.trim() });
    },
  };
}
