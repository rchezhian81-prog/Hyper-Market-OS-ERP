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
//      typed again. Head office refuses — nothing recorded — a held supplier, a bank payment with no verified account, a
//      shared account, a payment above the balance owed, or a person who raised, received or matched the order it pays.
// Nothing is read on open.

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';
import { signedPaiseOf, rupees } from './settlement-bank-session';

export type Lang = 'en' | 'ta';
export const PAY_METHODS = ['bank_transfer', 'cheque', 'upi', 'cash'] as const;

export const SUPPLIER_PAYMENT_COPY = {
  en: {
    payH: 'Record a payment to a supplier', payLede: 'This records that money was paid to a supplier — it does not send any money. A payment needs a second person: ask here, someone else who may pay suppliers approves it on their Approvals page, then record it here. What is recorded is exactly what was approved.',
    supplier: 'Supplier', amount: 'Amount paid (₹)', paidOn: 'Paid on', method: 'How it was paid', reference: 'Reference (UTR, cheque or receipt number)',
    m_bank_transfer: 'Bank transfer', m_cheque: 'Cheque', m_upi: 'UPI', m_cash: 'Cash',
    ask: 'Ask for approval', asked: 'Asked. Someone else who may pay suppliers approves it on their Approvals page; then record it below.',
    myAsksH: 'Payments you asked to record', showAsks: 'Show them', noAsks: 'You have not asked to record any supplier payment.', st_waiting: 'waiting for approval', st_approved: 'approved — ready to record', st_rejected: 'rejected', st_expired: 'expired', st_used: 'recorded',
    record: 'Record this payment', recorded: 'Recorded. Still owed to the supplier: {owed}.', already: 'Already recorded — nothing was written twice.',
    needPayment: 'Type the supplier, the amount in rupees, the day it was paid, how, and its reference.',
    nobody: 'Nobody is signed in on this screen.', cannotPay: 'Recording a supplier payment needs the permission to pay suppliers.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was asked or recorded.',
  },
  ta: {
    payH: 'சப்ளையருக்குச் செலுத்தியதைப் பதி', payLede: 'இது சப்ளையருக்குப் பணம் செலுத்தப்பட்டதைப் பதிவு செய்கிறது — எந்தப் பணத்தையும் அனுப்பாது. செலுத்தலுக்கு இரண்டாவது நபர் தேவை: இங்கே கேளுங்கள், சப்ளையர்களுக்குச் செலுத்த அனுமதி உள்ள வேறொருவர் தமது ஒப்புதல்கள் பக்கத்தில் ஒப்புதல் அளிக்கிறார், பின்னர் இங்கே பதியுங்கள். ஒப்புதல் அளிக்கப்பட்டதே சரியாகப் பதியப்படும்.',
    supplier: 'சப்ளையர்', amount: 'செலுத்திய தொகை (₹)', paidOn: 'செலுத்திய நாள்', method: 'எப்படிச் செலுத்தப்பட்டது', reference: 'குறிப்பு (UTR, காசோலை அல்லது ரசீது எண்)',
    m_bank_transfer: 'வங்கிப் பரிமாற்றம்', m_cheque: 'காசோலை', m_upi: 'UPI', m_cash: 'ரொக்கம்',
    ask: 'ஒப்புதல் கேள்', asked: 'கேட்கப்பட்டது. சப்ளையர்களுக்குச் செலுத்த அனுமதி உள்ள வேறொருவர் தமது ஒப்புதல்கள் பக்கத்தில் ஒப்புதல் அளிப்பார்; பின்னர் கீழே பதியுங்கள்.',
    myAsksH: 'நீங்கள் பதியக் கேட்ட செலுத்தல்கள்', showAsks: 'அவற்றைக் காட்டு', noAsks: 'நீங்கள் எந்தச் சப்ளையர் செலுத்தலையும் பதியக் கேட்கவில்லை.', st_waiting: 'ஒப்புதலுக்குக் காத்திருக்கிறது', st_approved: 'ஒப்புதல் கிடைத்தது — பதியத் தயார்', st_rejected: 'நிராகரிக்கப்பட்டது', st_expired: 'காலாவதியானது', st_used: 'பதியப்பட்டது',
    record: 'இந்தச் செலுத்தலைப் பதி', recorded: 'பதியப்பட்டது. சப்ளையருக்கு இன்னும் செலுத்த வேண்டியது: {owed}.', already: 'ஏற்கனவே பதியப்பட்டது — இருமுறை எழுதப்படவில்லை.',
    needPayment: 'சப்ளையர், ரூபாயில் தொகை, செலுத்திய நாள், எப்படி, அதன் குறிப்பு ஆகியவற்றைத் தட்டச்சு செய்யவும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotPay: 'சப்ளையர் செலுத்தலைப் பதிய சப்ளையர்களுக்குச் செலுத்தும் அனுமதி தேவை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் கேட்கப்படவில்லை, பதியப்படவில்லை.',
  },
} as const;

export function supplierPaymentWords(lang: Lang, key: string, fill?: Readonly<Record<string, string | number>>): string {
  const raw = (SUPPLIER_PAYMENT_COPY[lang] as Record<string, string>)[key] ?? (SUPPLIER_PAYMENT_COPY.en as Record<string, string>)[key] ?? key;
  return fill === undefined ? raw : raw.replace(/\{(\w+)\}/g, (_, k: string) => String(fill[k] ?? `{${k}}`));
}
export const supplierPaymentOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => supplierPaymentWords(lang, k), out);
export { rupees };

export interface PaymentForm { readonly supplierId: string; readonly amountRupees: string; readonly paidOn: string; readonly method: string; readonly reference: string }
export interface PaymentAsk { readonly requestId: string; readonly kind: string; readonly subjectRef: string; readonly status: string; readonly details: Record<string, unknown>; readonly valueMinor: number | null; readonly decidedBy?: string }

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Advances are asked for on the Supplier bills page with this subject prefix; they are not payments recorded here. */
const ADVANCE_PREFIX = 'advance:';

/** The payment as head office's record route reads it (exactly what is asked for), or null when the form is not complete. Pure. */
export function paymentBody(f: PaymentForm): Record<string, unknown> | null {
  const amountMinor = signedPaiseOf(f.amountRupees);
  if (f.supplierId.trim() === '' || amountMinor === null || amountMinor <= 0 || !DAY.test(f.paidOn.trim()) || !(PAY_METHODS as readonly string[]).includes(f.method) || f.reference.trim() === '') return null;
  return { amountMinor, paidOn: f.paidOn.trim(), method: f.method, reference: f.reference.trim() };
}

type Why = 'nobody' | 'cannotPay' | 'needPayment';
type Done<T> = Promise<Outcome<T, Why>>;

export interface SupplierPaymentSession {
  readonly may: { readonly named: boolean; readonly pay: boolean };
  ask(f: PaymentForm): Done<{ readonly requestId: string; readonly paymentId: string }>;
  myAsks(): Done<readonly PaymentAsk[]>;
  record(ask: PaymentAsk): Done<{ readonly alreadyRecorded: boolean; readonly owedMinor?: number }>;
}

export function createSupplierPaymentSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newId?: (prefix: string) => string;
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
      const paymentId = idOf('pay');
      // The engine fingerprints the record route's details: its body plus the path ids (`actionDetails`).
      const out = await call<{ requestId: string }>('POST', '/v1/approvals/requests', {
        kind: 'supplier_payment', subjectRef: `${supplierId}/${paymentId}`, details: { ...body, supplierId, paymentId }, valueMinor: body['amountMinor'],
        summary: `Payment to supplier ${supplierId}: ${rupees(body['amountMinor'] as number)} by ${String(body['method'])} on ${String(body['paidOn'])}, ref ${String(body['reference'])}`,
        reason: `Recording a payment made to supplier ${supplierId}`,
      });
      return out.result === 'ok' ? { result: 'ok', value: { requestId: out.value.requestId, paymentId } } : out;
    },
    myAsks: async () => {
      const g = gate(); if (g) return g;
      const mine = await call<{ mine?: readonly PaymentAsk[] }>('GET', '/v1/approvals/requests');
      if (mine.result !== 'ok') return mine;
      return { result: 'ok', value: (mine.value.mine ?? []).filter((q) => q.kind === 'supplier_payment' && !q.subjectRef.startsWith(ADVANCE_PREFIX) && q.subjectRef.includes('/')) };
    },
    // Exactly what was approved is recorded: the details come from the approved request, never from a form typed again.
    record: async (ask) => {
      const g = gate(); if (g) return g;
      const supplierId = String(ask.details['supplierId'] ?? ''); const paymentId = String(ask.details['paymentId'] ?? '');
      const body = Object.fromEntries(Object.entries(ask.details).filter(([k]) => k !== 'supplierId' && k !== 'paymentId'));
      return call('POST', `/v1/purchase/suppliers/${enc(supplierId)}/payments/${enc(paymentId)}`, { ...body, approvalId: ask.requestId });
    },
  };
}
