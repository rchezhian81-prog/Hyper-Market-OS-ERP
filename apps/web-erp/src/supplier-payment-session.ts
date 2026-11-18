// Suppliers · "Record a payment to a supplier" (W5 · M23-FR-01 "manage payable" · M06-FR-01 · M15-FR-03 · §28 · ADR-0024 ·
// hard rule #3: no card data · no money moves from here) — a tested, DOM-free session over the head-office route no screen
// reached, `POST /v1/purchase/suppliers/:supplierId/payments/:paymentId`. It RECORDS that money went to a supplier (by
// bank transfer, cheque, UPI or cash, with its reference); it never sends money to a bank.
//
// Paying a supplier is a payment, so it takes two people:
//   1. ASK — the person asks for approval of exactly this payment (`POST /v1/approvals/requests`, kind `supplier_payment`,
//      subject `<supplierId>/<paymentId>`, the payment's own details and amount);
//   2. a DIFFERENT person who may pay suppliers approves it on their own Approvals page (never the asker);
//   3. RECORD — the asker records the payment naming that approval; the details recorded are the APPROVED ones, never a form
//      typed again — plus, OB-807 A (owner, 16 Nov 2026, in writing), the day it was paid and its reference (UTR, cheque or
//      UPI number), which exist only once the money has gone, so they are typed when it is recorded, not when it is asked. Head office refuses — nothing recorded — a held supplier, a bank payment with no verified account, a
//      shared account, a payment above the balance owed, or a person who raised, received or matched the order it pays.
// Nothing is read on open.
//
// U7 · OB-724 (owner, in writing: B): the same section sits on the SUPPLIER BILLS page, and a payment may name the BILLS it
// settles (each this supplier's own; head office refuses another's by name). Recording is money, so the page asks the
// confirm sheet first. The bank reference recorded here is what Bank reconciliation matches the statement's debit line by.

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';
import { signedPaiseOf, rupees } from './settlement-bank-session';

export type Lang = 'en' | 'ta';
export const PAY_METHODS = ['bank_transfer', 'cheque', 'upi', 'cash'] as const;

export const SUPPLIER_PAYMENT_COPY = {
  en: {
    payH: 'Record a payment to a supplier', payLede: 'This records that money was paid to a supplier — it does not send any money. A payment needs a second person: ask here with the amount and the bills, someone else who may pay suppliers approves it on their Approvals page, then pay it and record it here with the day and the bank reference. What is recorded is exactly what was approved.',
    supplier: 'Supplier', amount: 'Amount to pay (₹)', paidOn: 'Paid on', method: 'How it was paid', reference: 'Reference (UTR, cheque or receipt number)',
    m_bank_transfer: 'Bank transfer', m_cheque: 'Cheque', m_upi: 'UPI', m_cash: 'Cash',
    ask: 'Ask for approval', asked: 'Asked. Someone else who may pay suppliers approves it on their Approvals page; then record it below.',
    myAsksH: 'Payments you asked to record', showAsks: 'Show them', noAsks: 'You have not asked to record any supplier payment.', st_waiting: 'waiting for approval', st_approved: 'Approved — record it when paid', st_rejected: 'rejected', st_expired: 'expired', st_used: 'recorded',
    record: 'Record this payment', recorded: 'Recorded. Still owed to the supplier: {owed}.', already: 'Already recorded — nothing was written twice.',
    needPayment: 'Type the supplier, the amount in rupees and how it will be paid.',
    // OB-807 A: the day and the reference are typed when the approved payment is recorded.
    recordH: 'Approved — record it when paid', recordLede: 'Once the money has gone, type the day it was paid and its reference (UTR, cheque or UPI number), then press "Record this payment" on the approved line.',
    needPaid: 'Type the day it was paid and its reference (UTR, cheque or UPI number) before recording it.', paidInFuture: 'The day it was paid cannot be a day still to come.',
    notYetPaid: 'not paid yet',
    nobody: 'Nobody is signed in on this screen.', cannotPay: 'Recording a supplier payment needs the permission to pay suppliers.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was asked or recorded.',
    settles: 'Bills it settles — tick the supplier\'s matched bills not yet paid (optional)', settlesShown: 'settles {bills}',
    // D-047 (fix batch 3): the supplier's matched, unpaid bills as tick boxes with the running total.
    billsPick: 'Choose the supplier to see their matched bills not yet paid.', billsReading: 'Reading the supplier\'s bills from head office…',
    billsNone: 'This supplier has no matched bill waiting to be paid.', billLine: '{bill} — {amount} may be paid',
    billsTotal: 'Ticked: {n} bill(s), {total} in all', billsNoneTicked: 'No bill ticked.',
    confirmTitle: '{amount} paid to {supplier} will be recorded', confirmDetail: 'Paid on {day} by {method}, reference {ref}. What the shop owes the supplier falls by this amount, and the bank statement line with this reference is matched to it on Bank reconciliation. A payment is kept for good; a mistake is corrected by a new entry.',
    confirmAuthority: 'You may pay suppliers; {approver} approved this exact payment.', confirmLabel: 'Record the payment', notConfirmed: 'Not confirmed — nothing was recorded.',
    // D-048 (fix batch 5): the supplier's own state, checked when the payment is ASKED for — before anyone approves it.
    supplierHeld: 'This supplier is on hold, so nothing may be paid to them until the hold is lifted on the Suppliers page. Nothing was asked.',
    noVerifiedBank: 'This supplier has no checked bank account on record, so a bank transfer, cheque or UPI payment to them cannot be recorded yet. First have their bank account checked on the Suppliers page (a call back on a number already held, approved by a second person). Nothing was asked.',
    sharedBank: 'Another supplier or staff member has the same bank account, so payment is stopped until a person has reviewed it on the Fraud signals page. Nothing was asked.',
  },
  ta: {
    payH: 'சப்ளையருக்குச் செலுத்தியதைப் பதி', payLede: 'இது சப்ளையருக்குப் பணம் செலுத்தப்பட்டதைப் பதிவு செய்கிறது — எந்தப் பணத்தையும் அனுப்பாது. செலுத்தலுக்கு இரண்டாவது நபர் தேவை: தொகை மற்றும் பில்களுடன் இங்கே கேளுங்கள், சப்ளையர்களுக்குச் செலுத்த அனுமதி உள்ள வேறொருவர் தமது ஒப்புதல்கள் பக்கத்தில் ஒப்புதல் அளிக்கிறார், பின்னர் பணம் செலுத்தி, நாள் மற்றும் வங்கிக் குறிப்புடன் இங்கே பதியுங்கள். ஒப்புதல் அளிக்கப்பட்டதே சரியாகப் பதியப்படும்.',
    supplier: 'சப்ளையர்', amount: 'செலுத்த வேண்டிய தொகை (₹)', paidOn: 'செலுத்திய நாள்', method: 'எப்படிச் செலுத்தப்பட்டது', reference: 'குறிப்பு (UTR, காசோலை அல்லது ரசீது எண்)',
    m_bank_transfer: 'வங்கிப் பரிமாற்றம்', m_cheque: 'காசோலை', m_upi: 'UPI', m_cash: 'ரொக்கம்',
    ask: 'ஒப்புதல் கேள்', asked: 'கேட்கப்பட்டது. சப்ளையர்களுக்குச் செலுத்த அனுமதி உள்ள வேறொருவர் தமது ஒப்புதல்கள் பக்கத்தில் ஒப்புதல் அளிப்பார்; பின்னர் கீழே பதியுங்கள்.',
    myAsksH: 'நீங்கள் பதியக் கேட்ட செலுத்தல்கள்', showAsks: 'அவற்றைக் காட்டு', noAsks: 'நீங்கள் எந்தச் சப்ளையர் செலுத்தலையும் பதியக் கேட்கவில்லை.', st_waiting: 'ஒப்புதலுக்குக் காத்திருக்கிறது', st_approved: 'ஒப்புதல் கிடைத்தது — செலுத்தியதும் பதியுங்கள்', st_rejected: 'நிராகரிக்கப்பட்டது', st_expired: 'காலாவதியானது', st_used: 'பதியப்பட்டது',
    record: 'இந்தச் செலுத்தலைப் பதி', recorded: 'பதியப்பட்டது. சப்ளையருக்கு இன்னும் செலுத்த வேண்டியது: {owed}.', already: 'ஏற்கனவே பதியப்பட்டது — இருமுறை எழுதப்படவில்லை.',
    needPayment: 'சப்ளையர், ரூபாயில் தொகை, எப்படிச் செலுத்தப்படும் என்பதைத் தட்டச்சு செய்யவும்.',
    recordH: 'ஒப்புதல் கிடைத்தது — செலுத்தியதும் பதியுங்கள்', recordLede: 'பணம் சென்றதும், செலுத்திய நாளையும் அதன் குறிப்பையும் (UTR, காசோலை அல்லது UPI எண்) தட்டச்சு செய்து, ஒப்புதல் பெற்ற வரியில் "இந்தச் செலுத்தலைப் பதி" அழுத்தவும்.',
    needPaid: 'பதிவதற்கு முன் செலுத்திய நாளையும் அதன் குறிப்பையும் (UTR, காசோலை அல்லது UPI எண்) தட்டச்சு செய்யவும்.', paidInFuture: 'செலுத்திய நாள் இன்னும் வராத நாளாக இருக்க முடியாது.',
    notYetPaid: 'இன்னும் செலுத்தவில்லை',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotPay: 'சப்ளையர் செலுத்தலைப் பதிய சப்ளையர்களுக்குச் செலுத்தும் அனுமதி தேவை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் கேட்கப்படவில்லை, பதியப்படவில்லை.',
    settles: 'இது தீர்க்கும் பில்கள் — சப்ளையரின் பொருத்தப்பட்ட, இன்னும் செலுத்தாத பில்களைத் தேர்வு செய்யவும் (விருப்பம்)', settlesShown: '{bills} பில்களைத் தீர்க்கிறது',
    billsPick: 'பொருத்தப்பட்ட, இன்னும் செலுத்தாத பில்களைக் காண சப்ளையரைத் தேர்ந்தெடுக்கவும்.', billsReading: 'சப்ளையரின் பில்களைத் தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
    billsNone: 'இந்தச் சப்ளையருக்குச் செலுத்தக் காத்திருக்கும் பொருத்தப்பட்ட பில் எதுவும் இல்லை.', billLine: '{bill} — {amount} செலுத்தலாம்',
    billsTotal: 'தேர்வு: {n} பில்(கள்), மொத்தம் {total}', billsNoneTicked: 'எந்த பில்லும் தேர்வு செய்யப்படவில்லை.',
    confirmTitle: '{supplier}க்குச் செலுத்திய {amount} பதியப்படும்', confirmDetail: '{day} அன்று {method} மூலம் செலுத்தப்பட்டது, குறிப்பு {ref}. கடை சப்ளையருக்குச் செலுத்த வேண்டியது இந்தத் தொகையால் குறையும்; இந்தக் குறிப்புள்ள வங்கி அறிக்கை வரி வங்கி சரிக்கட்டல் பக்கத்தில் இதனுடன் பொருத்தப்படும். செலுத்தல் நிரந்தரமாக வைக்கப்படும்; தவறு புதிய பதிவால் திருத்தப்படும்.',
    confirmAuthority: 'நீங்கள் சப்ளையர்களுக்குச் செலுத்தலாம்; இந்தச் செலுத்தலுக்கு {approver} ஒப்புதல் அளித்தார்.', confirmLabel: 'செலுத்தலைப் பதி', notConfirmed: 'உறுதிப்படுத்தவில்லை — எதுவும் பதியப்படவில்லை.',
    supplierHeld: 'இந்தச் சப்ளையர் நிறுத்திவைப்பில் உள்ளார்; சப்ளையர்கள் பக்கத்தில் நிறுத்திவைப்பு நீக்கப்படும் வரை அவருக்கு எதுவும் செலுத்த முடியாது. எதுவும் கேட்கப்படவில்லை.',
    noVerifiedBank: 'இந்தச் சப்ளையருக்குச் சரிபார்க்கப்பட்ட வங்கிக் கணக்கு பதிவில் இல்லை; எனவே வங்கிப் பரிமாற்றம், காசோலை அல்லது UPI செலுத்தலை இன்னும் பதிய முடியாது. முதலில் சப்ளையர்கள் பக்கத்தில் அவரது வங்கிக் கணக்கைச் சரிபார்க்கவும் (ஏற்கனவே உள்ள எண்ணுக்குத் திரும்ப அழைத்து, இரண்டாவது நபரின் ஒப்புதலுடன்). எதுவும் கேட்கப்படவில்லை.',
    sharedBank: 'வேறொரு சப்ளையர் அல்லது பணியாளருக்கும் இதே வங்கிக் கணக்கு உள்ளது; மோசடி அறிகுறிகள் பக்கத்தில் ஒருவர் சரிபார்க்கும் வரை செலுத்தல் நிறுத்தப்பட்டுள்ளது. எதுவும் கேட்கப்படவில்லை.',
  },
} as const;

export function supplierPaymentWords(lang: Lang, key: string, fill?: Readonly<Record<string, string | number>>): string {
  const raw = (SUPPLIER_PAYMENT_COPY[lang] as Record<string, string>)[key] ?? (SUPPLIER_PAYMENT_COPY.en as Record<string, string>)[key] ?? key;
  return fill === undefined ? raw : raw.replace(/\{(\w+)\}/g, (_, k: string) => String(fill[k] ?? `{${k}}`));
}
export const supplierPaymentOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => supplierPaymentWords(lang, k), out);
export { rupees };

export interface PaymentForm {
  readonly supplierId: string; readonly amountRupees: string; readonly method: string;
  /** Ignored when asking (OB-807 A): the day and the reference are typed when the approved payment is recorded (`PaidDetails`). */
  readonly paidOn?: string; readonly reference?: string;
  /** U7 · OB-724 — the bills it settles, as typed: bill numbers separated by commas (or spaces). Optional. */
  readonly settles?: string;
}

/** The bill numbers a person typed, trimmed, without blanks or repeats, in the order typed. Pure. */
export const billsOf = (typed: string | undefined): readonly string[] => [...new Set((typed ?? '').split(/[,\s]+/).map((x) => x.trim()).filter((x) => x !== ''))];
/** D-047: one of the supplier's bills a payment may settle — matched, agreed, not named by any payment recorded yet. */
export interface OpenBill { readonly invoiceId: string; readonly poId: string | null; readonly payableMinor: number }

/**
 * D-047 (fix batch 3): the supplier's bills a payment may tick — from head office's own statement of the account
 * (`GET /v1/purchase/suppliers/:supplierId/account`): matched and agreed (not held back), something payable, and not named
 * as settled by a payment already recorded. Pure.
 */
export function openBillsOf(account: unknown): readonly OpenBill[] {
  const a = (account ?? {}) as { invoices?: unknown; payments?: unknown };
  const settled = new Set((Array.isArray(a.payments) ? a.payments as { settles?: unknown }[] : []).flatMap((p) => (Array.isArray(p.settles) ? p.settles.map(String) : [])));
  return (Array.isArray(a.invoices) ? a.invoices as Record<string, unknown>[] : [])
    .filter((i) => i['matched'] === true && i['blocked'] !== true && typeof i['payableMinor'] === 'number' && i['payableMinor'] > 0 && !settled.has(String(i['invoiceId'])))
    .map((i) => ({ invoiceId: String(i['invoiceId']), poId: typeof i['poId'] === 'string' ? i['poId'] : null, payableMinor: i['payableMinor'] as number }));
}

export interface PaymentAsk { readonly requestId: string; readonly kind: string; readonly subjectRef: string; readonly status: string; readonly details: Record<string, unknown>; readonly valueMinor: number | null; readonly decidedBy?: string }

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Advances are asked for on the Supplier bills page with this subject prefix; they are not payments recorded here. */
const ADVANCE_PREFIX = 'advance:';

/**
 * OB-807 A: the payment's TERMS as they are asked for and approved — the amount, how it is paid and the bills it settles —
 * or null when the form is not complete. No paid day and no reference: they exist only once the money has gone. Pure.
 */
export function paymentBody(f: PaymentForm): Record<string, unknown> | null {
  const amountMinor = signedPaiseOf(f.amountRupees);
  if (f.supplierId.trim() === '' || amountMinor === null || amountMinor <= 0 || !(PAY_METHODS as readonly string[]).includes(f.method)) return null;
  const settles = billsOf(f.settles);
  return { amountMinor, method: f.method, ...(settles.length === 0 ? {} : { settles }) };
}

/** OB-807 A: what is typed when an approved payment is recorded — the day it was paid and its reference. */
export interface PaidDetails { readonly paidOn: string; readonly reference: string }

/**
 * The body head office's record route reads, from the APPROVED request (never a form typed again) and the day and reference
 * typed once the money has gone. An approval asked the older way already carries its day and reference: those are sent as
 * approved, and anything typed is not used. 'needPaid' / 'paidInFuture' when the typed ones will not do. Pure.
 */
export function recordBodyOf(ask: PaymentAsk, paid: PaidDetails | undefined, today: string | undefined): Record<string, unknown> | 'needPaid' | 'paidInFuture' {
  const approved = Object.fromEntries(Object.entries(ask.details).filter(([k]) => k !== 'supplierId' && k !== 'paymentId'));
  if ('paidOn' in approved || 'reference' in approved) return approved;
  const paidOn = (paid?.paidOn ?? '').trim(); const reference = (paid?.reference ?? '').trim();
  if (!DAY.test(paidOn) || reference === '') return 'needPaid';
  if (today !== undefined && DAY.test(today) && paidOn > today) return 'paidInFuture';
  return { ...approved, paidOn, reference };
}

type Why = 'nobody' | 'cannotPay' | 'needPayment' | 'needPaid' | 'paidInFuture' | PayBlock;

/** D-048: why head office would refuse to record a payment to this supplier — the same three checks its record route runs. */
export type PayBlock = 'supplierHeld' | 'noVerifiedBank' | 'sharedBank';

/** The supplier as head office's `GET /v1/purchase/suppliers/:supplierId` reads it — only what a payment needs. */
export interface SupplierPayState { readonly name: string | null; readonly blocked: boolean; readonly bankVerified: boolean; readonly sharedBank: boolean }

/** Read the supplier answer into what a payment needs. Pure. */
export function supplierPayStateOf(body: unknown): SupplierPayState {
  const b = (body ?? {}) as Record<string, unknown>;
  const rec = (b['supplier'] ?? null) as Record<string, unknown> | null;
  const name = rec !== null && typeof rec['name'] === 'string' && rec['name'].trim() !== '' ? rec['name'].trim() : null;
  return { name, blocked: b['blocked'] === true, bankVerified: b['bank'] !== null && b['bank'] !== undefined, sharedBank: b['duplicateBankAccount'] === true };
}

/**
 * D-048: the checks head office's record route runs on the supplier (a hold; a bank, cheque or UPI payment with no checked
 * account; an account another holder shares), run here when the payment is ASKED for — so nobody approves a payment that
 * could never be recorded. The same rules, never new ones: cash needs no bank account, exactly as on the route. Pure.
 */
export function payBlockOf(state: SupplierPayState, method: string): PayBlock | null {
  if (state.blocked) return 'supplierHeld';
  if (method !== 'cash' && !state.bankVerified) return 'noVerifiedBank';
  if (state.sharedBank) return 'sharedBank';
  return null;
}

/** D-049: the payment as the approver reads it — the supplier's name, the way it is paid in words, the bills it settles. Pure. */
export function paymentSummary(input: { readonly supplierId: string; readonly supplierName: string | null; readonly body: Record<string, unknown> }): string {
  const b = input.body;
  const how = supplierPaymentWords('en', `m_${String(b['method'])}`);
  const who = input.supplierName === null ? input.supplierId : `${input.supplierName} (${input.supplierId})`;
  const settles = Array.isArray(b['settles']) && b['settles'].length > 0 ? `, settles bill(s) ${(b['settles'] as unknown[]).map(String).join(', ')}` : '';
  // OB-807 A: asked before it is paid, so the day and reference are said only on an approval asked the older way.
  const when = typeof b['paidOn'] === 'string' ? ` on ${b['paidOn']}, ref ${String(b['reference'])}` : '';
  return `Payment to ${who}: ${rupees(b['amountMinor'] as number)} by ${how}${when}${settles}`;
}
type Done<T> = Promise<Outcome<T, Why>>;

export interface SupplierPaymentSession {
  readonly may: { readonly named: boolean; readonly pay: boolean };
  ask(f: PaymentForm): Done<{ readonly requestId: string; readonly paymentId: string }>;
  myAsks(): Done<readonly PaymentAsk[]>;
  /** OB-807 A: the approved payment, recorded with the day it was paid and its reference (typed now, after paying). */
  /** OB-847: the answer carries the payment as saved, with its format-A number (`payment.documentNumber`). */
  record(ask: PaymentAsk, paid?: PaidDetails): Done<{ readonly alreadyRecorded: boolean; readonly owedMinor?: number; readonly payment?: { readonly documentNumber?: string } }>;
  /** D-047: the supplier's matched bills not yet paid (`openBillsOf`); a supplier head office has no record of has none. */
  openBills(supplierId: string): Done<readonly OpenBill[]>;
}

export function createSupplierPaymentSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newId?: (prefix: string) => string;
  /** The shop's today (YYYY-MM-DD), so a paid day still to come is refused here as well as at head office. */
  readonly today?: () => string;
}): SupplierPaymentSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, pay: named && held.has('purchase.supplier.pay') };
  const call = makeCaller({ keyPrefix: 'supplier-payment', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const idOf = input.newId ?? newId;
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = () => (!named ? no('nobody') : !may.pay ? no('cannotPay') : undefined);
  const enc = (s: string): string => encodeURIComponent(s.trim());
  return {
    may,
    ask: async (f) => {
      const g = gate(); if (g) return g;
      const body = paymentBody(f); if (body === null) return no('needPayment');
      const supplierId = f.supplierId.trim();
      // D-048: the supplier is checked BEFORE the approval is asked for. Head office runs the same checks again on record.
      // Not found or not readable by this person: the ask goes on as before, and head office still refuses on record.
      const read = await call<unknown>('GET', `/v1/purchase/suppliers/${enc(supplierId)}`);
      if (read.result === 'lost_link') return read;
      const state = read.result === 'ok' ? supplierPayStateOf(read.value) : null;
      if (state !== null) { const block = payBlockOf(state, String(body['method'])); if (block !== null) return no(block); }
      const paymentId = idOf('pay');
      // The engine fingerprints the record route's details: its body plus the path ids (`actionDetails`).
      const out = await call<{ requestId: string }>('POST', '/v1/approvals/requests', {
        kind: 'supplier_payment', subjectRef: `${supplierId}/${paymentId}`, details: { ...body, supplierId, paymentId }, valueMinor: body['amountMinor'],
        summary: paymentSummary({ supplierId, supplierName: state?.name ?? null, body }),
        reason: `Recording a payment made to ${state?.name ?? `supplier ${supplierId}`}`,
      });
      return out.result === 'ok' ? { result: 'ok', value: { requestId: out.value.requestId, paymentId } } : out;
    },
    myAsks: async () => {
      const g = gate(); if (g) return g;
      const mine = await call<{ mine?: readonly PaymentAsk[] }>('GET', '/v1/approvals/requests');
      if (mine.result !== 'ok') return mine;
      return { result: 'ok', value: (mine.value.mine ?? []).filter((q) => q.kind === 'supplier_payment' && !q.subjectRef.startsWith(ADVANCE_PREFIX) && q.subjectRef.includes('/')) };
    },
    // Exactly what was approved is recorded: the terms come from the approved request, never from a form typed again; the
    // day and the reference are the ones typed now that it has been paid (OB-807 A).
    record: async (ask, paid) => {
      const g = gate(); if (g) return g;
      const supplierId = String(ask.details['supplierId'] ?? ''); const paymentId = String(ask.details['paymentId'] ?? '');
      const body = recordBodyOf(ask, paid, input.today?.());
      if (typeof body === 'string') return no(body);
      return call('POST', `/v1/purchase/suppliers/${enc(supplierId)}/payments/${enc(paymentId)}`, { ...body, approvalId: ask.requestId });
    },
    openBills: async (supplierId) => {
      const g = gate(); if (g) return g;
      if (supplierId.trim() === '') return { result: 'ok', value: [] };
      const out = await call<unknown>('GET', `/v1/purchase/suppliers/${enc(supplierId)}/account`);
      if (out.result === 'refused' && out.status === 404) return { result: 'ok', value: [] };
      return out.result === 'ok' ? { result: 'ok', value: openBillsOf(out.value) } : out;
    },
  };
}
