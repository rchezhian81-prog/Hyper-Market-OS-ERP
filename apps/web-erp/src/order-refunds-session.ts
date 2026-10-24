// The Order refunds page — the desk's refund for an ONLINE order, and the worklist of money still waiting on the bank
// (M18-FR-04 "refunds by token … refund approval per policy" · §28 · P-07 · P-08 · hard rules #3, #10). A tested,
// DOM-free session over head office's own routes:
//   • GET  /v1/orders/refunds/pending            — every payment the bank has not answered and every refund still pending;
//   • GET  /v1/orders/:orderId/refunds           — one order's money: paid, refunded, pending, still refundable;
//   • POST /v1/approvals/requests                — the desk ASKS a second person (kind `order_refund`) for exactly this refund;
//   • POST /v1/orders/:orderId/refunds           — the refund, to the ORDER's own payment token, naming the approval;
//   • POST /v1/orders/:orderId/refunds/:id/outcome — the bank statement's word on a pending refund.
// The refund always goes back to the token the order was paid with — the page never asks for, holds or sends a card
// number. Nothing is read or written on open; every write is a person's click.

import type { ViewerIdentity } from './browser-entry';
import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';
export type RefundBasis = 'cancellation' | 'substitution' | 'short_pick' | 'goodwill';
export const REFUND_BASES: readonly RefundBasis[] = ['cancellation', 'substitution', 'short_pick', 'goodwill'];

export interface PendingPayment { readonly orderId: string; readonly amountMinor: number; readonly reason?: string; readonly recordedAt: string }
export interface RefundView { readonly refundId: string; readonly orderId: string; readonly amountMinor: number; readonly basis: string; readonly reason: string; readonly effectiveState: string; readonly requestedBy?: string; readonly approvedBy?: string; readonly at: string }
export interface PendingView { readonly pendingPayments: readonly PendingPayment[]; readonly pendingRefunds: readonly RefundView[]; readonly pendingRefundMinor: number; readonly detail: string }
export interface MoneyView {
  readonly orderId: string;
  readonly payment: { readonly state: string; readonly amountMinor?: number };
  readonly position: { readonly paidMinor: number; readonly refundedMinor: number; readonly pendingMinor: number; readonly refundableMinor: number; readonly refunds: readonly RefundView[] };
}
/** A refund the desk is preparing — its id is fixed when it is drafted, so the approval and the refund name the same thing. */
export interface RefundDraft { readonly orderId: string; readonly refundId: string; readonly amountMinor: number; readonly basis: RefundBasis; readonly reason: string }

export const ORDER_REFUNDS_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Order refunds',
    lead: 'Refund an online order back to the payment it was made with, after a second person approves it, and see every payment and refund still waiting on the bank. A refund the bank has not confirmed stays "waiting" — it is never shown as done.',
    pendingH: 'Waiting on the bank', showPending: 'Show what is waiting', noneWaiting: 'Nothing is waiting on the bank.', paymentWaiting: 'Payment not confirmed by the bank', refundWaiting: 'Refund not confirmed by the bank',
    statementRef: 'Bank statement line', refunded: 'The bank refunded it', declined: 'The bank declined it', outcomeSaved: 'Recorded from the statement:',
    refundH: 'Refund an order', orderId: 'Order number', showOrder: 'Show the order\'s money', paid: 'Paid', refundedK: 'Refunded', pendingK: 'Waiting', refundableK: 'Can still be refunded', paymentState: 'Payment',
    amount: 'Amount to refund (₹)', basis: 'Why the money goes back', reason: 'In words, for the record', ask: 'Ask a second person to approve', asked: 'Asked — request', askedNext: 'A person who may approve refunds decides it in Approvals. Then issue it here.',
    issue: 'Issue the approved refund', issued: 'Refund', state_issued: 'refunded', state_pending: 'waiting for the bank', state_refused: 'refused by the bank', toToken: 'It goes back to the payment the order was made with.',
    basis_cancellation: 'Order cancelled', basis_substitution: 'A cheaper substitute', basis_short_pick: 'Something was missing', basis_goodwill: 'Goodwill',
    needOrder: 'Give the order number first. Nothing was read.', needAmount: 'Give an amount in rupees, more than zero. Nothing was sent.', needReason: 'Say why in words first. Nothing was sent.', needStatement: 'Give the bank statement line first. Nothing was sent.', needAsk: 'Ask for the approval first, then issue the refund once it is approved.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.', cannotRead: 'Your role cannot read orders.', cannotIssue: 'Your role cannot refund orders.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
  },
  ta: {
    lang: 'English', title: 'ஆர்டர் பணத் திருப்பம்',
    lead: 'ஆன்லைன் ஆர்டரின் பணத்தை, அது செலுத்தப்பட்ட அதே கட்டண முறைக்கே, இரண்டாவது நபர் ஒப்புக்கொண்ட பிறகு திருப்பித் தரவும்; வங்கியின் பதிலுக்காகக் காத்திருக்கும் ஒவ்வொரு கட்டணத்தையும் திருப்பத்தையும் பார்க்கவும். வங்கி உறுதிசெய்யாத திருப்பம் "காத்திருக்கிறது" என்றே இருக்கும் — முடிந்ததாக ஒருபோதும் காட்டப்படாது.',
    pendingH: 'வங்கிக்காகக் காத்திருப்பவை', showPending: 'காத்திருப்பதைக் காட்டு', noneWaiting: 'வங்கிக்காக எதுவும் காத்திருக்கவில்லை.', paymentWaiting: 'வங்கி உறுதிசெய்யாத கட்டணம்', refundWaiting: 'வங்கி உறுதிசெய்யாத திருப்பம்',
    statementRef: 'வங்கி அறிக்கை வரி', refunded: 'வங்கி திருப்பித் தந்தது', declined: 'வங்கி மறுத்தது', outcomeSaved: 'அறிக்கையிலிருந்து பதிவு செய்யப்பட்டது:',
    refundH: 'ஒரு ஆர்டரைத் திருப்பு', orderId: 'ஆர்டர் எண்', showOrder: 'ஆர்டரின் பணத்தைக் காட்டு', paid: 'செலுத்தியது', refundedK: 'திருப்பியது', pendingK: 'காத்திருக்கிறது', refundableK: 'இன்னும் திருப்பலாம்', paymentState: 'கட்டணம்',
    amount: 'திருப்ப வேண்டிய தொகை (₹)', basis: 'பணம் ஏன் திரும்புகிறது', reason: 'பதிவுக்காக வார்த்தைகளில்', ask: 'இரண்டாவது நபரின் ஒப்புதலைக் கேள்', asked: 'கேட்கப்பட்டது — கோரிக்கை', askedNext: 'திருப்பங்களை ஒப்புக்கொள்ளக்கூடியவர் ஒப்புதல்கள் பக்கத்தில் முடிவு செய்வார். பிறகு இங்கே வழங்குங்கள்.',
    issue: 'ஒப்புக்கொண்ட திருப்பத்தை வழங்கு', issued: 'திருப்பம்', state_issued: 'திருப்பித் தரப்பட்டது', state_pending: 'வங்கிக்காகக் காத்திருக்கிறது', state_refused: 'வங்கி மறுத்தது', toToken: 'ஆர்டர் செலுத்தப்பட்ட அதே கட்டண முறைக்கே அது திரும்பும்.',
    basis_cancellation: 'ஆர்டர் ரத்து', basis_substitution: 'மலிவான மாற்றுப் பொருள்', basis_short_pick: 'ஏதோ குறைந்தது', basis_goodwill: 'நல்லெண்ணம்',
    needOrder: 'முதலில் ஆர்டர் எண்ணைக் கொடுங்கள். எதுவும் படிக்கப்படவில்லை.', needAmount: 'பூஜ்ஜியத்தை விட அதிகமான ரூபாய்த் தொகையைக் கொடுங்கள். எதுவும் அனுப்பப்படவில்லை.', needReason: 'முதலில் காரணத்தை வார்த்தைகளில் சொல்லுங்கள். எதுவும் அனுப்பப்படவில்லை.', needStatement: 'முதலில் வங்கி அறிக்கை வரியைக் கொடுங்கள். எதுவும் அனுப்பப்படவில்லை.', needAsk: 'முதலில் ஒப்புதலைக் கேளுங்கள்; ஒப்புக்கொண்ட பிறகு திருப்பத்தை வழங்குங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', cannotRead: 'உங்கள் பங்கு ஆர்டர்களைப் படிக்க முடியாது.', cannotIssue: 'உங்கள் பங்கு ஆர்டர்களுக்குப் பணம் திருப்ப முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
  },
} as const;
export type OrderRefundsKey = keyof typeof ORDER_REFUNDS_COPY.en;
export const orderRefundsWords = (lang: Lang, key: OrderRefundsKey | string): string => (ORDER_REFUNDS_COPY[lang] as Record<string, string>)[key] ?? (ORDER_REFUNDS_COPY.en as Record<string, string>)[key] ?? key;
export const orderRefundsOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => orderRefundsWords(lang, k), out);

export function rupees(minor: number): string {
  return `₹${Math.floor(Math.abs(minor) / 100).toLocaleString('en-IN')}.${String(Math.abs(minor) % 100).padStart(2, '0')}`;
}
/** Rupees as typed ("1,250.50") → whole paise, or undefined. */
export function paiseOf(text: string): number | undefined {
  const t = text.replace(/[,\s₹]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  const [r, p = ''] = t.split('.');
  return Number(r) * 100 + Number(p.padEnd(2, '0'));
}

export interface OrderRefundsSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly issue: boolean };
  pending(): Promise<Outcome<PendingView>>;
  money(orderId: string): Promise<Outcome<MoneyView>>;
  /** Fix the refund's id and figures, and ask a second person to approve exactly it. */
  ask(input: { readonly orderId: string; readonly amount: string; readonly basis: RefundBasis; readonly reason: string }): Promise<Outcome<{ readonly draft: RefundDraft; readonly requestId: string }>>;
  /** Issue the drafted refund, naming the approval a second person gave. */
  issue(draft: RefundDraft, approvalId: string): Promise<Outcome<{ readonly refund: RefundView & { readonly effectiveState: string }; readonly tellTheCustomer?: string }>>;
  /** The bank statement's word on a pending refund. */
  outcome(orderId: string, refundId: string, result: 'refunded' | 'declined', statementRef: string): Promise<Outcome<{ readonly refund?: RefundView }>>;
}

export function createOrderRefundsSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newRefundId?: () => string }): OrderRefundsSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && perms.has('order.read'), issue: named && perms.has('order.refund.issue') };
  const call = makeCaller({ keyPrefix: 'order-refunds', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const guard = (need: boolean, why: OrderRefundsKey): Outcome<never, OrderRefundsKey> | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !need ? { result: 'invalid', why } : undefined);
  const enc = encodeURIComponent;
  const newRefundId = input.newRefundId ?? (() => newId('rf'));
  const bodyOf = (d: RefundDraft) => ({ refundId: d.refundId, amountMinor: d.amountMinor, basis: d.basis, reason: d.reason });
  return {
    may,
    pending: async () => guard(may.read, 'cannotRead') ?? call('GET', '/v1/orders/refunds/pending'),
    money: async (orderId) => {
      const g = guard(may.read, 'cannotRead'); if (g) return g;
      return orderId.trim() === '' ? { result: 'invalid', why: 'needOrder' } : call('GET', `/v1/orders/${enc(orderId.trim())}/refunds`);
    },
    ask: async ({ orderId, amount, basis, reason }) => {
      const g = guard(may.issue, 'cannotIssue'); if (g) return g;
      if (orderId.trim() === '') return { result: 'invalid', why: 'needOrder' };
      const amountMinor = paiseOf(amount);
      if (amountMinor === undefined || amountMinor <= 0) return { result: 'invalid', why: 'needAmount' };
      if (reason.trim() === '' || !REFUND_BASES.includes(basis)) return { result: 'invalid', why: 'needReason' };
      const draft: RefundDraft = { orderId: orderId.trim(), refundId: newRefundId(), amountMinor, basis, reason: reason.trim() };
      // The approval names exactly the refund's body plus the order — the engine fingerprints these details.
      const asked = await call<{ readonly requestId: string }>('POST', '/v1/approvals/requests', {
        kind: 'order_refund', subjectRef: `${draft.orderId}/${draft.refundId}`, details: { ...bodyOf(draft), orderId: draft.orderId }, valueMinor: amountMinor,
        summary: `Refund ${rupees(amountMinor)} on order ${draft.orderId} (${basis})`, reason: draft.reason,
      });
      return asked.result === 'ok' ? { result: 'ok', value: { draft, requestId: asked.value.requestId } } : asked;
    },
    issue: async (draft, approvalId) => {
      const g = guard(may.issue, 'cannotIssue'); if (g) return g;
      if (approvalId.trim() === '') return { result: 'invalid', why: 'needAsk' };
      return call('POST', `/v1/orders/${enc(draft.orderId)}/refunds`, { ...bodyOf(draft), approvalId: approvalId.trim() });
    },
    outcome: async (orderId, refundId, result, statementRef) => {
      const g = guard(may.issue, 'cannotIssue'); if (g) return g;
      if (statementRef.trim() === '') return { result: 'invalid', why: 'needStatement' };
      return call('POST', `/v1/orders/${enc(orderId)}/refunds/${enc(refundId)}/outcome`, { result, evidenceRef: statementRef.trim() });
    },
  };
}
