// ORDERS WAITING TO BE ISSUED, ON THE APPROVALS PAGE — fix batch 4a · D-042 (and D-010) · M06-FR-02 · M02-FR-03 · §28 · P-03.
//
// The walkthrough found the second person had to issue a waiting purchase order from the Buying page's BUDGET tab, where
// the row said only "PO-… · sup-demo-foods · ₹2,664.00 · raised by pilot-manager" — they could not see what was being
// bought before pressing "Issue this order". Now the Approvals page lists every order waiting for its second person, each
// with its supplier's name, the items by name, how many, at what agreed price and the line's value, and the total.
//
// The page reads head office in the signed-in person's own session (`GET /v1/purchase/orders`, plus the supplier and item
// names where they can be read) and issues through EXACTLY the path the Budget tab uses —
// `POST /v1/purchase/orders/:poId/approval`, built by `createOpenToBuySession` — so head office's checks all still hold:
// `purchase.order.approve`, never the person who raised it (§28), their money limit (above it the owner decides), the
// month's budget (over it escalates to the owner, OB-63), a supplier hold. The page offers no Issue button on an order the
// person raised themselves, nor to anyone who does not hold the permission; head office refuses either way.
// Holds no rule of its own beyond that; DOM-free and tested.

import { createOpenToBuySession } from './open-to-buy-session';
import { bodyKey, type Answer, type HeadOfficeCall } from './supplier-bills-session';
import {
  mayIssueOrders, ordersWaitingToIssue, ordersSentBackTo,
  type OrderWaitingToIssue, type WaitingOrderViewer,
} from '../../../packages/purchasing/src/orders-waiting-to-issue';

export type { OrderWaitingToIssue } from '../../../packages/purchasing/src/orders-waiting-to-issue';

type Lang = 'en' | 'ta';

export const ORDERS_TO_ISSUE_WORDS = Object.freeze({
  en: {
    heading: 'Purchase orders waiting to be issued', reading: 'Reading the purchase orders waiting at head office…',
    none: 'No purchase order is waiting to be issued.', unreachable: 'Head office could not be reached, so the waiting purchase orders are not known.',
    notYourRole: 'Your role does not see purchase orders.', supplier: 'Supplier', raisedBy: 'Raised by', total: 'Total',
    item: 'Item', qty: 'How many', price: 'Agreed price', value: 'Value', perUnit: 'per', overBudget: 'Over this month\'s budget — only the owner can issue it.',
    yours: 'You raised this order, so a second person must issue it.', notYours: 'Only a person who may issue purchase orders can issue it.',
    reason: 'Why this order is approved (required)', overReason: 'Why it may go over budget', issue: 'Issue this order',
    needReason: 'Write why this order is approved first.', issued: 'Issued — the order goes to the supplier.', issuedOver: 'Issued over budget — the reason is on record.',
    refused: 'Head office did not issue it:',
    // P2 (batch 18c · OB-871): reject, send back, withdraw, resubmit — before the order is issued.
    decideReason: 'Your reason or note (required for every button)', sendBack: 'Send back to raiser', reject: 'Reject',
    withdraw: 'Withdraw my order', withdrawReason: 'Why you are taking it back (required)', needNote: 'Write your reason or note first.',
    rejected: 'Rejected — the order has ended. The reason is on record.', sentBack: 'Sent back — the person who raised it can change it and resubmit it.',
    withdrawn: 'Withdrawn — the order has ended. The reason is on record.', resubmitted: 'Resubmitted — it waits for a second person again.',
    notDone: 'Head office did not do it:', sentBackHeading: 'Orders sent back to you', sentBackNone: 'No order has been sent back to you.',
    sentBackBy: 'Sent back by', note: 'Note', resubmitNote: 'What you changed (required)', resubmit: 'Resubmit the order',
    resubmittedBy: 'Resubmitted with changes',
  },
  ta: {
    heading: 'வழங்கக் காத்திருக்கும் கொள்முதல் ஆணைகள்', reading: 'தலைமை அலுவலகத்தில் காத்திருக்கும் கொள்முதல் ஆணைகளைப் படிக்கிறது…',
    none: 'வழங்கக் காத்திருக்கும் கொள்முதல் ஆணை எதுவும் இல்லை.', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே காத்திருக்கும் ஆணைகள் தெரியவில்லை.',
    notYourRole: 'உங்கள் பங்கு கொள்முதல் ஆணைகளைப் பார்ப்பதில்லை.', supplier: 'விநியோகஸ்தர்', raisedBy: 'உருவாக்கியவர்', total: 'மொத்தம்',
    item: 'பொருள்', qty: 'எத்தனை', price: 'ஒப்புக்கொண்ட விலை', value: 'மதிப்பு', perUnit: 'ஒன்றுக்கு', overBudget: 'இந்த மாதப் பட்ஜெட்டை மீறுகிறது — உரிமையாளர் மட்டுமே வழங்க முடியும்.',
    yours: 'இந்த ஆணையை நீங்கள் உருவாக்கினீர்கள், எனவே இரண்டாவது நபர் வழங்க வேண்டும்.', notYours: 'கொள்முதல் ஆணைகளை வழங்க அனுமதி உள்ளவர் மட்டுமே வழங்க முடியும்.',
    reason: 'இந்த ஆணைக்கு ஏன் ஒப்புதல் (கட்டாயம்)', overReason: 'ஏன் பட்ஜெட்டை மீறலாம்', issue: 'இந்த ஆணையை வழங்கு',
    needReason: 'முதலில் இந்த ஆணைக்கு ஏன் ஒப்புதல் என்று எழுதுங்கள்.', issued: 'வழங்கப்பட்டது — ஆணை விநியோகஸ்தருக்குச் செல்கிறது.', issuedOver: 'பட்ஜெட்டை மீறி வழங்கப்பட்டது — காரணம் பதிவில் உள்ளது.',
    refused: 'தலைமை அலுவலகம் வழங்கவில்லை:',
    decideReason: 'உங்கள் காரணம் அல்லது குறிப்பு (ஒவ்வொரு பொத்தானுக்கும் கட்டாயம்)', sendBack: 'உருவாக்கியவருக்குத் திருப்பி அனுப்பு', reject: 'நிராகரி',
    withdraw: 'என் ஆணையைத் திரும்பப் பெறு', withdrawReason: 'ஏன் திரும்பப் பெறுகிறீர்கள் (கட்டாயம்)', needNote: 'முதலில் உங்கள் காரணம் அல்லது குறிப்பை எழுதுங்கள்.',
    rejected: 'நிராகரிக்கப்பட்டது — ஆணை முடிந்தது. காரணம் பதிவில் உள்ளது.', sentBack: 'திருப்பி அனுப்பப்பட்டது — உருவாக்கியவர் மாற்றி மீண்டும் சமர்ப்பிக்கலாம்.',
    withdrawn: 'திரும்பப் பெறப்பட்டது — ஆணை முடிந்தது. காரணம் பதிவில் உள்ளது.', resubmitted: 'மீண்டும் சமர்ப்பிக்கப்பட்டது — இரண்டாவது நபருக்காக மீண்டும் காத்திருக்கிறது.',
    notDone: 'தலைமை அலுவலகம் செய்யவில்லை:', sentBackHeading: 'உங்களுக்குத் திருப்பி அனுப்பப்பட்ட ஆணைகள்', sentBackNone: 'எந்த ஆணையும் உங்களுக்குத் திருப்பி அனுப்பப்படவில்லை.',
    sentBackBy: 'திருப்பி அனுப்பியவர்', note: 'குறிப்பு', resubmitNote: 'நீங்கள் என்ன மாற்றினீர்கள் (கட்டாயம்)', resubmit: 'ஆணையை மீண்டும் சமர்ப்பி',
    resubmittedBy: 'மாற்றங்களுடன் மீண்டும் சமர்ப்பிக்கப்பட்டது',
  },
} as const);

export type OrdersToIssueWord = keyof typeof ORDERS_TO_ISSUE_WORDS.en;

export function ordersToIssueText(lang: Lang, key: OrdersToIssueWord): string {
  return (ORDERS_TO_ISSUE_WORDS[lang] ?? ORDERS_TO_ISSUE_WORDS.en)[key];
}

/** Paise as the page shows them: ₹2,664.00. */
export function rupeesText(minor: number): string {
  const sign = minor < 0 ? '−' : '';
  const a = Math.abs(minor);
  return `${sign}₹${Math.floor(a / 100).toLocaleString('en-IN')}.${String(a % 100).padStart(2, '0')}`;
}

export type OrdersRead =
  | { readonly state: 'read'; readonly orders: readonly OrderWaitingToIssue[]; readonly sentBack: readonly OrderWaitingToIssue[] }
  | { readonly state: 'not_your_role' }
  | { readonly state: 'unreachable' };

export type IssueOutcome =
  | { readonly kind: 'needs_reason' }
  | { readonly kind: 'not_yours' }
  | { readonly kind: 'issued'; readonly overBudget: boolean }
  | { readonly kind: 'refused'; readonly whatHappened: string }
  | { readonly kind: 'lost_link' }
  // P2 (batch 18c)
  | { readonly kind: 'needs_note' }
  | { readonly kind: 'stepped'; readonly step: 'rejected' | 'sent_back' | 'withdrawn' | 'resubmitted' }
  | { readonly kind: 'not_done'; readonly whatHappened: string };

/** P2: a line as the raiser changed it — the quantity in the item's smallest steps, and a price in paise when changed. */
export interface ResubmitLine { readonly productId: string; readonly orderedQty: number; readonly unitCostMinor?: number }

export interface OrdersToIssueSession {
  readonly mayIssue: boolean;
  read(): Promise<OrdersRead>;
  /** Issue a waiting order — on an explicit click only, with the approver's written reason. */
  issue(order: Pick<OrderWaitingToIssue, 'poId' | 'raisedByViewer'>, reason: string, overBudgetReason?: string): Promise<IssueOutcome>;
  /** P2: the second person rejects a waiting order (it ends) — explicit click, written reason. */
  reject(order: Pick<OrderWaitingToIssue, 'poId' | 'raisedByViewer'>, reason: string): Promise<IssueOutcome>;
  /** P2: the second person sends a waiting order back to its raiser with a note. */
  sendBack(order: Pick<OrderWaitingToIssue, 'poId' | 'raisedByViewer'>, note: string): Promise<IssueOutcome>;
  /** P2: the raiser takes back their own waiting (or sent-back) order. */
  withdraw(order: Pick<OrderWaitingToIssue, 'poId' | 'raisedByViewer'>, reason: string): Promise<IssueOutcome>;
  /** P2: the raiser resubmits an order sent back to them, with what they changed. */
  resubmit(order: Pick<OrderWaitingToIssue, 'poId' | 'raisedByViewer'>, note: string, lines: readonly ResubmitLine[]): Promise<IssueOutcome>;
  /** The words an outcome is shown in. */
  outcomeWords(lang: Lang, outcome: IssueOutcome): string;
}

const namesFrom = (body: unknown, list: string, id: string): Map<string, string> => {
  const out = new Map<string, string>();
  const rows = body !== null && typeof body === 'object' && Array.isArray((body as Record<string, unknown>)[list]) ? (body as Record<string, unknown[]>)[list]! : [];
  for (const r of rows) {
    if (r === null || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o[id] === 'string' && typeof o['name'] === 'string' && o['name'].trim() !== '') out.set(o[id] as string, o['name']);
  }
  return out;
};

export function createOrdersToIssueSession(
  call: HeadOfficeCall,
  viewer: WaitingOrderViewer,
  /** The items' names this store computer holds (`/directory/products`); an empty map names each item by its code. */
  productNames: () => Promise<ReadonlyMap<string, string>> = async () => new Map(),
): OrdersToIssueSession {
  const mayIssue = mayIssueOrders(viewer);
  // The Budget tab's own issue path — the one way an order is issued (no second door).
  const issuer = createOpenToBuySession(call, { permissions: viewer.permissions ?? [] });
  // P2 (batch 18c): one POST per step, on an explicit click only; a blank reason sends nothing.
  const step = async (poId: string, path: string, kind: 'rejected' | 'sent_back' | 'withdrawn' | 'resubmitted', body: { readonly reason: string; readonly lines?: readonly ResubmitLine[] }): Promise<IssueOutcome> => {
    if (body.reason === '') return { kind: 'needs_note' };
    const got = await call({ method: 'POST', path: `/v1/purchase/orders/${encodeURIComponent(poId)}/${path}`, body, idempotencyKey: bodyKey(`${path}-${poId}-${Date.now().toString(36)}`, body) }); // a later cycle (sent back twice) is a new step
    if (got === 'unreachable') return { kind: 'lost_link' };
    if (got.status < 300) return { kind: 'stepped', step: kind };
    const e = (got.body as { error?: { whatHappened?: unknown } } | null)?.error;
    return { kind: 'not_done', whatHappened: typeof e?.whatHappened === 'string' ? e.whatHappened : `head office answered ${got.status}` };
  };
  return {
    mayIssue,
    read: async () => {
      const got = await call({ method: 'GET', path: '/v1/purchase/orders' });
      if (got === 'unreachable') return { state: 'unreachable' };
      if (got.status === 401 || got.status === 403) return { state: 'not_your_role' };
      if (got.status >= 300) return { state: 'unreachable' };
      // Supplier names where this person may read them (`supplier.view`); otherwise each supplier is named by its code.
      const sup = await call({ method: 'GET', path: '/v1/purchase/suppliers' });
      const suppliers = sup !== 'unreachable' && sup.status < 300 ? namesFrom(sup.body, 'suppliers', 'supplierId') : new Map<string, string>();
      // Item names: this store computer's own catalogue first (no head-office call); any item it does not name is looked
      // up in head office's catalogue (`catalogue.pack.read`); one neither names is shown by its code, never a guess.
      const products = new Map(await productNames().catch(() => new Map<string, string>()));
      const wanted = ordersWaitingToIssue(got.body, viewer).flatMap((o) => o.lines.map((l) => l.productId));
      if (wanted.some((id) => !products.has(id))) {
        const cat = await call({ method: 'GET', path: '/v1/catalogue/products' });
        if (cat !== 'unreachable' && cat.status < 300) for (const [id, name] of namesFrom(cat.body, 'products', 'productId')) if (!products.has(id)) products.set(id, name);
      }
      return { state: 'read', orders: ordersWaitingToIssue(got.body, viewer, { products, suppliers }), sentBack: ordersSentBackTo(got.body, viewer, { products, suppliers }) };
    },
    reject: async (order, reason) => {
      if (order.raisedByViewer) return { kind: 'not_yours' };
      return step(order.poId, 'rejection', 'rejected', { reason: reason.trim() });
    },
    sendBack: async (order, note) => {
      if (order.raisedByViewer) return { kind: 'not_yours' };
      return step(order.poId, 'send-back', 'sent_back', { reason: note.trim() });
    },
    withdraw: async (order, reason) => step(order.poId, 'withdrawal', 'withdrawn', { reason: reason.trim() }),
    resubmit: async (order, note, lines) => step(order.poId, 'resubmission', 'resubmitted', { reason: note.trim(), lines: lines.map((l) => ({ ...l })) }),
    issue: async (order, reason, overBudgetReason) => {
      if (order.raisedByViewer) return { kind: 'not_yours' };
      if (reason.trim() === '') return { kind: 'needs_reason' };
      const answer: Answer<{ readonly overBudget: boolean }> = await issuer.issue(order.poId, reason, overBudgetReason);
      if (answer.ok) return { kind: 'issued', overBudget: answer.value.overBudget };
      if (answer.unreachable) return { kind: 'lost_link' };
      return { kind: 'refused', whatHappened: answer.whatHappened };
    },
    outcomeWords: (lang, outcome) => {
      const w = (k: OrdersToIssueWord): string => ordersToIssueText(lang, k);
      switch (outcome.kind) {
        case 'needs_reason': return w('needReason');
        case 'not_yours': return w('yours');
        case 'issued': return outcome.overBudget ? w('issuedOver') : w('issued');
        case 'refused': return `${w('refused')} ${outcome.whatHappened}`;
        case 'lost_link': return w('unreachable');
        case 'needs_note': return w('needNote');
        case 'stepped': return w(outcome.step === 'sent_back' ? 'sentBack' : outcome.step);
        case 'not_done': return `${w('notDone')} ${outcome.whatHappened}`;
      }
    },
  };
}
