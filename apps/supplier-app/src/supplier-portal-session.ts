// The supplier's self-service portal — the model behind the one screen a party OUTSIDE the business sees
// (M24-FR-01 · API-03 · §35 · P-03 · P-04). A supplier logs in and reads TWO things about ITS OWN account,
// and nothing else: what it has SENT the shop and whether the shop has acted on it yet, and its STATEMENT —
// the money the shop owes it. Both are scoped to the supplier's OWN partner id (derived from the session on
// the server, never a parameter the supplier can change — a request naming another partner is refused AND
// recorded as a probe), so this screen shows one supplier its own world and can never show it another's.
//
//   • **My submissions** (`GET /v1/supplier-portal/me/submissions`) — every catalogue, RFQ reply, delivery
//     note, invoice, order acknowledgement or claim the supplier sent. The ones still AWAITING the buyer's
//     decision lead, because those are the ones the supplier is waiting on: **nothing a supplier submits takes
//     effect on its own** — a buyer decides (§28) — so "awaiting review" is the honest state, never "accepted".
//   • **My statement** (`GET /v1/supplier-portal/me/statement`) — the closing balance built from the
//     supplier's own lines, with a **disputed** amount shown SEPARATELY (it is neither owed nor written off),
//     and a `reconciles` guard that goes false rather than letting a line vanish. When the login lacks the
//     statement grant the answer is **not accessible** — NOT a balance of zero, because those are not the same
//     thing (P-08: a missing permission is never silently a "you owe nothing").
//
// Like every screen in this product the rules live here in a tested, DOM-free session model on the shared
// packages/ui + packages/a11y primitives (colour is NEVER the only signal — an icon and a word ride with every
// tone). This is a READ surface: a supplier SUBMITS through separate write routes; here it only reads status
// and its account. Bilingual EN/TA — a supplier to a Tamil Nadu hypermarket reads whichever it prefers.
//
// OB-362 (owner, 24–25 Oct 2026, in writing): the ONE exception is a "Delivery update" form — for the supplier's OWN open
// orders only (`GET /v1/supplier-portal/me/orders`, scoped on the server) — which sends the existing `delivery_status`
// submission (dispatched, in transit or delayed, and when it should now arrive). `readDeliveryUpdate` checks it before
// anything is sent.
//
// OB-389 (owner, 26 Oct 2026, in writing): the SECOND and last exception is a "Top-up proposal" form for vendor-managed
// inventory (D03-FR-04) — the supplier's OWN VMI items only (`GET /v1/supplier-portal/me/vmi`, scoped on the server), each
// with the buyer's minimum and maximum, on hand, on order and the room left. It sends a replenishment PROPOSAL
// (`POST /v1/supplier-portal/me/vmi/proposals/:proposalId`) that waits for a buyer; it orders nothing and sets no price
// (P-05, §28). `readTopUpProposal` checks it against the room before anything is sent; nothing else on this screen writes.

import { translator, presentScreenState, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { presentStatus, type StatusPresentation } from '../../../packages/a11y/src/signals';

// ── the raw feeds, exactly as the cloud hands them over (the screen consumes the served JSON) ───────────────

// OB-288 commercial desks (M24-FR-02): `delivery_status` — the supplier told us where an order's delivery has got to.
export type SubmissionKind = 'rfq_response' | 'catalogue' | 'asn' | 'invoice' | 'po_acknowledgement' | 'claim' | 'delivery_status';

/** One thing the supplier sent (`…/me/submissions`). `requiresReview` true = the buyer has not decided yet. */
export interface SubmissionView {
  readonly submissionId: string;
  readonly kind: SubmissionKind;
  readonly requiresReview: boolean;
  readonly receivedAt: string;
}

/** The supplier's statement (`…/me/statement`) — its own account with the shop. */
export interface StatementView {
  readonly partnerId: string;
  /** False when this login has no statement grant — an empty statement is NOT "you owe nothing". */
  readonly accessible: boolean;
  readonly openingMinor: number;
  readonly invoicedMinor: number;
  readonly debitedMinor: number;
  readonly creditedMinor: number;
  readonly paidMinor: number;
  readonly closingMinor: number;
  readonly disputedMinor: number;
  /** The closing balance is built from named buckets and cross-checked; false rather than let a line vanish. */
  readonly reconciles: boolean;
  readonly detail: string;
}

/** OB-362: one of the supplier's own open orders (`…/me/orders`) — what the Delivery update form may name. */
export interface SupplierOrderView {
  readonly poId: string;
  readonly number: string;
  readonly issuedAt: string | null;
  readonly deliverToLocationId: string | null;
}

/** OB-362: the supplier's own open orders as last read; `ordersKnown` false = head office could not list them (never "none"). */
export interface SupplierOrdersFeed {
  readonly ordersKnown: boolean;
  readonly orders: readonly SupplierOrderView[];
  /** This login holds the order-communication grant a delivery update needs. */
  readonly mayUpdate: boolean;
}

/** The feeds the portal last read (live from the cloud, or the injected stand-in). */
export interface SupplierPortalData {
  readonly submissions: readonly SubmissionView[];
  readonly statement: StatementView | null;
  /** OB-362: the supplier's own open orders — absent until read. */
  readonly orders?: SupplierOrdersFeed | null;
  /** OB-389: the supplier's own VMI items and proposals — absent until read. */
  readonly vmi?: SupplierVmiFeed | null;
  readonly asAt: string;
}

/** OB-362: the delivery statuses a supplier may send (`DELIVERY_STATUSES`, services/purchase/src/supplier-portal.ts). */
export const DELIVERY_UPDATE_STATUSES = Object.freeze(['dispatched', 'in_transit', 'delayed'] as const);
export type DeliveryUpdateStatus = (typeof DELIVERY_UPDATE_STATUSES)[number];

/** OB-362: what the form holds, as typed. */
export interface DeliveryUpdateInput { readonly poId: string; readonly status: string; readonly expectedOn: string; readonly note: string }
/** OB-362: the `delivery_status` document the form sends — or why it is not sent. */
export type DeliveryUpdateRead =
  | { readonly ok: true; readonly document: { readonly poId: string; readonly status: DeliveryUpdateStatus; readonly expectedOn: string; readonly note?: string } }
  | { readonly ok: false; readonly why: 'needOrder' | 'notYourOrder' | 'needStatus' | 'needDate' | 'noteTooLong' | 'cannotUpdate' };

/** OB-362: read the form against the supplier's own open orders — refused here, before anything is sent. */
export function readDeliveryUpdate(input: DeliveryUpdateInput, feed: SupplierOrdersFeed | null | undefined): DeliveryUpdateRead {
  if (feed === null || feed === undefined || !feed.mayUpdate) return { ok: false, why: 'cannotUpdate' };
  const poId = input.poId.trim();
  if (poId === '') return { ok: false, why: 'needOrder' };
  if (!feed.orders.some((o) => o.poId === poId)) return { ok: false, why: 'notYourOrder' };
  if (!(DELIVERY_UPDATE_STATUSES as readonly string[]).includes(input.status)) return { ok: false, why: 'needStatus' };
  const day = input.expectedOn.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return { ok: false, why: 'needDate' };
  const note = input.note.trim();
  if (note.length > 300) return { ok: false, why: 'noteTooLong' };
  return { ok: true, document: { poId, status: input.status as DeliveryUpdateStatus, expectedOn: day, ...(note === '' ? {} : { note }) } };
}

/** OB-389: one of the supplier's own VMI items at a store, as `/me/vmi` answers it. */
export interface SupplierVmiItem {
  readonly storeId: string;
  readonly productId: string;
  readonly minQty: number;
  readonly maxQty: number;
  readonly uom: string;
  readonly onHand: number;
  readonly onOrder: number;
  /** How much more may be proposed: maximum − on hand − on order, never below 0. */
  readonly room: number;
  readonly belowMinimum: boolean;
}

/** OB-389: a top-up proposal the supplier sent, with the buyer's decision and its reason once made. */
export interface SupplierVmiProposalView {
  readonly proposalId: string;
  readonly storeId: string;
  readonly lines: readonly { readonly productId: string; readonly quantity: number }[];
  readonly proposedAt: string;
  readonly status: 'awaiting_buyer' | 'accepted' | 'rejected';
  readonly reason: string | null;
}

/** OB-389: the supplier's own VMI items and proposals as last read. */
export interface SupplierVmiFeed {
  readonly items: readonly SupplierVmiItem[];
  /** The server's "Not set" words when the buyer has set no limits yet — never an empty list read as nothing to do. */
  readonly notSet: string | null;
  readonly proposals: readonly SupplierVmiProposalView[];
  /** This login holds the grant a proposal needs (`supplier.portal.self.submit`); the server re-checks it. */
  readonly mayPropose: boolean;
}

/** OB-389: what the Top-up proposal form holds, as typed — one store, a quantity box per item there. */
export interface TopUpInput { readonly storeId: string; readonly quantities: Readonly<Record<string, string>>; readonly note: string }
/** OB-389: the proposal the form sends — or why it is not sent. */
export type TopUpRead =
  | { readonly ok: true; readonly document: { readonly storeId: string; readonly lines: readonly { readonly productId: string; readonly quantity: number }[]; readonly note?: string } }
  | { readonly ok: false; readonly why: 'cannotPropose' | 'needStore' | 'notYourStore' | 'needQuantity' | 'badQuantity' | 'aboveRoom' | 'notYourItem' | 'noteTooLong'; readonly productId?: string };

/** OB-389: read the form against the supplier's own VMI items at that store — refused here, before anything is sent. */
export function readTopUpProposal(input: TopUpInput, feed: SupplierVmiFeed | null | undefined): TopUpRead {
  if (feed === null || feed === undefined || !feed.mayPropose) return { ok: false, why: 'cannotPropose' };
  const storeId = input.storeId.trim();
  if (storeId === '') return { ok: false, why: 'needStore' };
  const here = feed.items.filter((i) => i.storeId === storeId);
  if (here.length === 0) return { ok: false, why: 'notYourStore' };
  const lines: { productId: string; quantity: number }[] = [];
  for (const [productId, raw] of Object.entries(input.quantities)) {
    const typed = raw.trim();
    if (typed === '') continue;
    const item = here.find((i) => i.productId === productId);
    if (item === undefined) return { ok: false, why: 'notYourItem', productId };
    if (!/^\d+$/.test(typed) || Number(typed) <= 0) return { ok: false, why: 'badQuantity', productId };
    const quantity = Number(typed);
    if (quantity > item.room) return { ok: false, why: 'aboveRoom', productId };
    lines.push({ productId, quantity });
  }
  if (lines.length === 0) return { ok: false, why: 'needQuantity' };
  const note = input.note.trim();
  if (note.length > 300) return { ok: false, why: 'noteTooLong' };
  return { ok: true, document: { storeId, lines, ...(note === '' ? {} : { note }) } };
}

export interface SupplierPortalPorts {
  /** The feeds the portal last read. */
  portal(): SupplierPortalData;
  /** Whether this login is a supplier self-service login (`supplier.portal.self`). */
  mayRead(): boolean;
}

export interface SupplierPortalConfig {
  /** Who is looking. `null` means the login was not identified. */
  readonly userId: string | null;
}

// ── the copy: ONE bilingual object for the whole screen ─────────────────────────────────────────────────────

export type CopyKey =
  | 'title' | 'lead' | 'langName'
  | 'refresh' | 'asOfLabel'
  | 'sentHeading' | 'awaitingLabel' | 'processedLabel' | 'sentNone'
  | 'statementHeading' | 'notAccessible'
  | 'openingLabel' | 'invoicedLabel' | 'creditedLabel' | 'debitedLabel' | 'paidLabel' | 'closingLabel' | 'disputedLabel'
  | 'reconciledLabel' | 'notReconciledLabel' | 'disputedSeparate'
  | 'kindRfq' | 'kindCatalogue' | 'kindAsn' | 'kindInvoice' | 'kindPoAck' | 'kindClaim' | 'kindDelivery'
  | 'awaitingState' | 'processedState'
  | 'scrReady' | 'scrEmpty' | 'stateNotPermitted'
  | 'notIdentified' | 'staleShell' | 'sampleData'
  | 'deliveryH' | 'deliveryLead' | 'orderL' | 'chooseOrder' | 'statusL' | 'status_dispatched' | 'status_in_transit' | 'status_delayed'
  | 'expectedL' | 'noteL' | 'sendUpdate' | 'updateSent' | 'needOrder' | 'notYourOrder' | 'needStatus' | 'needDate' | 'noteTooLong'
  | 'cannotUpdate' | 'noOpenOrders' | 'ordersUnknown' | 'notSent' | 'refusedSay'
  | 'vmiH' | 'vmiLead' | 'vmiStoreL' | 'chooseStore' | 'vmiItemFacts' | 'vmiQtyL' | 'vmiNoteL' | 'sendTopUp' | 'topUpSent'
  | 'cannotPropose' | 'needStore' | 'notYourStore' | 'needQuantity' | 'badQuantity' | 'aboveRoom' | 'notYourItem'
  | 'vmiUnknown' | 'vmiProposalsH' | 'vmiAwaiting' | 'vmiAccepted' | 'vmiRejected' | 'vmiBelowMin' | 'topUpNotSent';

export const SUPPLIER_PORTAL_COPY: BilingualCopy<CopyKey> = {
  en: {
    title: 'Your account with SRE', langName: 'தமிழ்',
    lead: 'What you have sent us and where each stands, and your statement — the money we owe you. Anything you send waits for a buyer to check it; it is never in force on its own. This page shows your own account only; it changes nothing.',
    refresh: 'Refresh', asOfLabel: 'As of',
    sentHeading: 'What you have sent us', awaitingLabel: 'Waiting on us', processedLabel: 'Processed', sentNone: 'You have not sent us anything yet.',
    statementHeading: 'Your statement', notAccessible: 'Your login cannot see the statement. Ask us to turn it on — this does not mean nothing is owed.',
    openingLabel: 'Opening balance', invoicedLabel: 'Invoiced', creditedLabel: 'Credit notes', debitedLabel: 'Debit notes', paidLabel: 'Paid to you', closingLabel: 'Outstanding',
    disputedLabel: 'Disputed (shown separately)',
    reconciledLabel: 'Balance reconciles', notReconciledLabel: 'Balance does not reconcile — please raise it with us',
    disputedSeparate: 'A disputed amount is shown on its own — it is neither owed nor written off until it is settled.',
    kindRfq: 'RFQ reply', kindCatalogue: 'Catalogue', kindAsn: 'Delivery note', kindInvoice: 'Invoice', kindPoAck: 'Order acknowledgement', kindClaim: 'Claim', kindDelivery: 'Delivery update',
    awaitingState: 'Waiting on us', processedState: 'Processed',
    scrReady: 'Showing your account', scrEmpty: 'Nothing to show yet — you have sent us nothing and your statement is clear.',
    stateNotPermitted: 'This login is not a supplier login for this portal.',
    notIdentified: 'This login was not identified.',
    staleShell: 'No connection. This page is what you were last shown, at', sampleData: 'Sample data — this is not your account.',
    deliveryH: 'Delivery update', deliveryLead: 'Tell us where one of your orders has got to. A buyer sees it at once; it changes nothing else.',
    orderL: 'Your order', chooseOrder: 'Choose one of your open orders', statusL: 'Where it has got to', status_dispatched: 'Dispatched', status_in_transit: 'On the way', status_delayed: 'Delayed',
    expectedL: 'When it should now arrive', noteL: 'Note (optional, up to 300 letters)', sendUpdate: 'Send the delivery update', updateSent: 'Sent — the buyer can see it.',
    needOrder: 'Choose your order first. Nothing was sent.', notYourOrder: 'That is not one of your open orders. Nothing was sent.', needStatus: 'Say where it has got to. Nothing was sent.',
    needDate: 'Give the day it should now arrive. Nothing was sent.', noteTooLong: 'The note is longer than 300 letters. Nothing was sent.',
    cannotUpdate: 'Your login cannot send delivery updates. Ask us to turn it on.', noOpenOrders: 'You have no open orders with us right now.',
    ordersUnknown: 'Your orders could not be read just now, so no update can be sent.', notSent: 'No connection — the update was not sent. Try again when you are online.', refusedSay: 'We could not take it:',
    vmiH: 'Top-up proposal', vmiLead: 'For the items you keep stocked for us: propose how much to send to a store, within the room the buyer\'s maximum leaves. A buyer decides; nothing is ordered until then, and you set no price.',
    vmiStoreL: 'Store', chooseStore: 'Choose a store', vmiItemFacts: 'min {min} · max {max} · on hand {onHand} · on order {onOrder} · room {room} {uom}',
    vmiQtyL: 'How many to send', vmiNoteL: 'Note (optional, up to 300 letters)', sendTopUp: 'Send the top-up proposal', topUpSent: 'Sent — it waits for a buyer to decide.',
    cannotPropose: 'Your login cannot send top-up proposals. Ask us to turn it on.', needStore: 'Choose the store first. Nothing was sent.',
    notYourStore: 'You keep no items stocked at that store. Nothing was sent.', needQuantity: 'Give a quantity for at least one item. Nothing was sent.',
    badQuantity: 'A quantity is a whole number above 0. Nothing was sent.', aboveRoom: 'That is more than the room the buyer\'s maximum leaves. Nothing was sent.',
    notYourItem: 'That item is not one of yours at this store. Nothing was sent.', vmiUnknown: 'Your stocked items could not be read just now, so no proposal can be sent.',
    vmiProposalsH: 'Your top-up proposals', vmiAwaiting: 'Waiting for a buyer', vmiAccepted: 'Accepted — the buyer raised an order', vmiRejected: 'Not accepted',
    vmiBelowMin: 'Below the minimum', topUpNotSent: 'No connection — the proposal was not sent. Try again when you are online.',
  },
  ta: {
    title: 'SRE உடன் உங்கள் கணக்கு', langName: 'English',
    lead: 'நீங்கள் எங்களுக்கு அனுப்பியவை மற்றும் அவற்றின் நிலை, மேலும் உங்கள் அறிக்கை — நாங்கள் உங்களுக்குச் செலுத்த வேண்டிய பணம். நீங்கள் அனுப்பும் எதுவும் ஒரு வாங்குபவர் சரிபார்க்கும் வரை காத்திருக்கும்; அது தானாகவே அமலுக்கு வராது. இந்தப் பக்கம் உங்கள் சொந்தக் கணக்கை மட்டுமே காட்டுகிறது; எதையும் மாற்றாது.',
    refresh: 'புதுப்பி', asOfLabel: 'நிலவரம்',
    sentHeading: 'நீங்கள் அனுப்பியவை', awaitingLabel: 'எங்களிடம் காத்திருக்கிறது', processedLabel: 'செயலாக்கப்பட்டது', sentNone: 'நீங்கள் இன்னும் எதையும் அனுப்பவில்லை.',
    statementHeading: 'உங்கள் அறிக்கை', notAccessible: 'உங்கள் உள்நுழைவு அறிக்கையைப் பார்க்க முடியாது. இயக்க எங்களிடம் கேளுங்கள் — இதற்கு எதுவும் நிலுவை இல்லை என்று அர்த்தம் அல்ல.',
    openingLabel: 'தொடக்க இருப்பு', invoicedLabel: 'விலைப்பட்டியல்', creditedLabel: 'வரவு குறிப்புகள்', debitedLabel: 'பற்று குறிப்புகள்', paidLabel: 'உங்களுக்குச் செலுத்தியது', closingLabel: 'நிலுவை',
    disputedLabel: 'தகராறு (தனியாகக் காட்டப்படுகிறது)',
    reconciledLabel: 'இருப்பு பொருந்துகிறது', notReconciledLabel: 'இருப்பு பொருந்தவில்லை — தயவுசெய்து எங்களிடம் தெரிவிக்கவும்',
    disputedSeparate: 'தகராறில் உள்ள தொகை தனியாகக் காட்டப்படுகிறது — தீர்க்கப்படும் வரை அது செலுத்த வேண்டியதோ தள்ளுபடி செய்யப்பட்டதோ அல்ல.',
    kindRfq: 'RFQ பதில்', kindCatalogue: 'பட்டியல்', kindAsn: 'விநியோகக் குறிப்பு', kindInvoice: 'விலைப்பட்டியல்', kindPoAck: 'ஆர்டர் ஒப்புகை', kindClaim: 'உரிமைகோரல்', kindDelivery: 'டெலிவரி நிலவரம்',
    awaitingState: 'எங்களிடம் காத்திருக்கிறது', processedState: 'செயலாக்கப்பட்டது',
    scrReady: 'உங்கள் கணக்கைக் காட்டுகிறது', scrEmpty: 'இன்னும் காட்ட எதுவும் இல்லை — நீங்கள் எதையும் அனுப்பவில்லை, உங்கள் அறிக்கையும் தெளிவாக உள்ளது.',
    stateNotPermitted: 'இந்த உள்நுழைவு இந்த போர்ட்டலுக்கான சப்ளையர் உள்நுழைவு அல்ல.',
    notIdentified: 'இந்த உள்நுழைவு அடையாளம் காணப்படவில்லை.',
    staleShell: 'இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகக் காட்டப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கணக்கு அல்ல.',
    deliveryH: 'டெலிவரி நிலவரம்', deliveryLead: 'உங்கள் ஆர்டர்களில் ஒன்று எங்கே வந்துள்ளது என்று சொல்லுங்கள். வாங்குபவர் உடனே பார்ப்பார்; இது வேறு எதையும் மாற்றாது.',
    orderL: 'உங்கள் ஆர்டர்', chooseOrder: 'உங்கள் திறந்த ஆர்டர்களில் ஒன்றைத் தேர்ந்தெடுங்கள்', statusL: 'எங்கே வந்துள்ளது', status_dispatched: 'அனுப்பப்பட்டது', status_in_transit: 'வழியில் உள்ளது', status_delayed: 'தாமதம்',
    expectedL: 'இப்போது எப்போது வந்து சேரும்', noteL: 'குறிப்பு (விருப்பம், 300 எழுத்துகள் வரை)', sendUpdate: 'டெலிவரி நிலவரத்தை அனுப்பு', updateSent: 'அனுப்பப்பட்டது — வாங்குபவர் பார்க்கலாம்.',
    needOrder: 'முதலில் உங்கள் ஆர்டரைத் தேர்ந்தெடுங்கள். எதுவும் அனுப்பப்படவில்லை.', notYourOrder: 'அது உங்கள் திறந்த ஆர்டர்களில் ஒன்று அல்ல. எதுவும் அனுப்பப்படவில்லை.', needStatus: 'எங்கே வந்துள்ளது என்று சொல்லுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    needDate: 'இப்போது வந்து சேர வேண்டிய நாளைக் கொடுங்கள். எதுவும் அனுப்பப்படவில்லை.', noteTooLong: 'குறிப்பு 300 எழுத்துகளை விட நீளமானது. எதுவும் அனுப்பப்படவில்லை.',
    cannotUpdate: 'உங்கள் உள்நுழைவு டெலிவரி நிலவரம் அனுப்ப முடியாது. இயக்க எங்களிடம் கேளுங்கள்.', noOpenOrders: 'இப்போது எங்களிடம் உங்கள் திறந்த ஆர்டர் எதுவும் இல்லை.',
    ordersUnknown: 'உங்கள் ஆர்டர்களை இப்போது படிக்க முடியவில்லை, எனவே நிலவரம் அனுப்ப முடியாது.', notSent: 'இணைப்பு இல்லை — நிலவரம் அனுப்பப்படவில்லை. இணைப்பு வந்ததும் மீண்டும் முயலுங்கள்.', refusedSay: 'எங்களால் ஏற்க முடியவில்லை:',
    vmiH: 'இருப்பு நிரப்பும் முன்மொழிவு', vmiLead: 'எங்களுக்காக நீங்கள் இருப்பு வைக்கும் பொருட்களுக்கு: வாங்குபவரின் அதிகபட்ச அளவு விடும் இடத்திற்குள், ஒரு கடைக்கு எவ்வளவு அனுப்பலாம் என்று முன்மொழியுங்கள். வாங்குபவர் முடிவு செய்வார்; அதுவரை எதுவும் ஆர்டர் செய்யப்படாது, விலையையும் நீங்கள் நிர்ணயிப்பதில்லை.',
    vmiStoreL: 'கடை', chooseStore: 'ஒரு கடையைத் தேர்ந்தெடுங்கள்', vmiItemFacts: 'குறைந்தது {min} · அதிகபட்சம் {max} · கையிருப்பு {onHand} · ஆர்டரில் {onOrder} · இடம் {room} {uom}',
    vmiQtyL: 'எத்தனை அனுப்புவது', vmiNoteL: 'குறிப்பு (விருப்பம், 300 எழுத்துகள் வரை)', sendTopUp: 'முன்மொழிவை அனுப்பு', topUpSent: 'அனுப்பப்பட்டது — வாங்குபவர் முடிவுக்காகக் காத்திருக்கிறது.',
    cannotPropose: 'உங்கள் உள்நுழைவு முன்மொழிவுகளை அனுப்ப முடியாது. இயக்க எங்களிடம் கேளுங்கள்.', needStore: 'முதலில் கடையைத் தேர்ந்தெடுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    notYourStore: 'அந்தக் கடையில் நீங்கள் இருப்பு வைக்கும் பொருள் எதுவும் இல்லை. எதுவும் அனுப்பப்படவில்லை.', needQuantity: 'குறைந்தது ஒரு பொருளுக்கு அளவைக் கொடுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    badQuantity: 'அளவு 0-க்கு மேற்பட்ட முழு எண். எதுவும் அனுப்பப்படவில்லை.', aboveRoom: 'வாங்குபவரின் அதிகபட்ச அளவு விடும் இடத்தை விட அதிகம். எதுவும் அனுப்பப்படவில்லை.',
    notYourItem: 'அந்தப் பொருள் இந்தக் கடையில் உங்களுடையது அல்ல. எதுவும் அனுப்பப்படவில்லை.', vmiUnknown: 'உங்கள் இருப்புப் பொருட்களை இப்போது படிக்க முடியவில்லை, எனவே முன்மொழிவு அனுப்ப முடியாது.',
    vmiProposalsH: 'உங்கள் முன்மொழிவுகள்', vmiAwaiting: 'வாங்குபவருக்காகக் காத்திருக்கிறது', vmiAccepted: 'ஏற்கப்பட்டது — வாங்குபவர் ஆர்டர் எழுப்பினார்', vmiRejected: 'ஏற்கப்படவில்லை',
    vmiBelowMin: 'குறைந்த அளவுக்குக் கீழே', topUpNotSent: 'இணைப்பு இல்லை — முன்மொழிவு அனுப்பப்படவில்லை. இணைப்பு வந்ததும் மீண்டும் முயலுங்கள்.',
  },
};

export const COPY_KEYS: readonly CopyKey[] = Object.freeze(Object.keys(SUPPLIER_PORTAL_COPY.en) as CopyKey[]);

const KIND_KEY: Record<SubmissionKind, CopyKey> = {
  rfq_response: 'kindRfq', catalogue: 'kindCatalogue', asn: 'kindAsn', invoice: 'kindInvoice',
  po_acknowledgement: 'kindPoAck', claim: 'kindClaim', delivery_status: 'kindDelivery',
};

// ── the presented shapes the view renders ────────────────────────────────────────────────────────────────

export interface PresentedSubmission {
  readonly submissionId: string;
  readonly kindLabel: string;
  readonly receivedAt: string;
  readonly awaiting: boolean;
  /** Awaiting the buyer's decision reads as a degraded "waiting" state; processed reads OK — icon + word, never colour alone. */
  readonly status: StatusPresentation;
}

export interface PresentedStatement {
  readonly accessible: boolean;
  readonly opening: string;
  readonly invoiced: string;
  readonly credited: string;
  readonly debited: string;
  readonly paid: string;
  readonly closing: string;
  readonly disputed: string;
  readonly disputedMinor: number;
  readonly reconciles: boolean;
  readonly detail: string;
  /** ok when it reconciles, error when it does not (a mismatch the supplier should raise) — icon + word. */
  readonly status: StatusPresentation;
}

export interface SupplierPortalView {
  readonly screenState: StatusPresentation;
  /** Submissions still awaiting the buyer's decision — the ones the supplier is waiting on, first. */
  readonly awaiting: readonly PresentedSubmission[];
  /** Submissions the buyer has already acted on. */
  readonly processed: readonly PresentedSubmission[];
  /** The statement, or null when it is not shown (either no feed, or the login lacks the grant — see below). */
  readonly statement: PresentedStatement | null;
  /** True when the statement feed IS present but the login lacks the grant — the screen shows the "ask us to
   *  turn it on" line, NOT a balance of zero (P-08: not accessible is never the same as "you owe nothing"). */
  readonly statementInaccessible: boolean;
  readonly awaitingCount: number;
  readonly notIdentified: boolean;
  /** True when at least one submission is awaiting the buyer, or the statement does not reconcile. */
  readonly anyAttention: boolean;
}

export interface SupplierPortalSession {
  text(lang: Lang, key: CopyKey): string;
  view(lang: Lang): SupplierPortalView;
}

const rupees = (minor: number): string => {
  const sign = minor < 0 ? '-' : '';
  return `${sign}₹${(Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const EMPTY_VIEW = (screenState: StatusPresentation, notIdentified: boolean): SupplierPortalView => ({
  screenState, awaiting: [], processed: [], statement: null, statementInaccessible: false, awaitingCount: 0, notIdentified, anyAttention: false,
});

export function createSupplierPortalSession(
  config: SupplierPortalConfig,
  ports: SupplierPortalPorts,
): SupplierPortalSession {
  const text = (lang: Lang, key: CopyKey): string => translator(SUPPLIER_PORTAL_COPY, lang)(key);

  const presentSubmission = (lang: Lang, s: SubmissionView): PresentedSubmission => {
    const t = translator(SUPPLIER_PORTAL_COPY, lang);
    const status = s.requiresReview
      ? presentStatus({ tone: 'degraded', icon: '⏳', label: t('awaitingState'), announcement: t('awaitingState'), needsAttention: true })
      : presentStatus({ tone: 'ok', icon: '✓', label: t('processedState'), announcement: t('processedState'), needsAttention: false });
    return { submissionId: s.submissionId, kindLabel: t(KIND_KEY[s.kind]), receivedAt: s.receivedAt, awaiting: s.requiresReview, status };
  };

  const presentStatement = (lang: Lang, s: StatementView): PresentedStatement => {
    const t = translator(SUPPLIER_PORTAL_COPY, lang);
    // Reconciled is a clean OK; a mismatch is an error the supplier should raise (icon + word ride with it).
    const status = s.reconciles
      ? presentStatus({ tone: 'ok', icon: '✓', label: t('reconciledLabel'), announcement: s.detail, needsAttention: false })
      : presentStatus({ tone: 'error', icon: '✕', label: t('notReconciledLabel'), announcement: s.detail, needsAttention: true });
    return {
      accessible: s.accessible,
      opening: rupees(s.openingMinor), invoiced: rupees(s.invoicedMinor), credited: rupees(s.creditedMinor),
      debited: rupees(s.debitedMinor), paid: rupees(s.paidMinor), closing: rupees(s.closingMinor),
      disputed: rupees(s.disputedMinor), disputedMinor: s.disputedMinor,
      reconciles: s.reconciles, detail: s.detail, status,
    };
  };

  return {
    text,
    view: (lang) => {
      const t = translator(SUPPLIER_PORTAL_COPY, lang);
      const notIdentified = config.userId === null;

      if (!ports.mayRead()) {
        return EMPTY_VIEW(presentScreenState({ state: 'error', label: t('stateNotPermitted') }), notIdentified);
      }

      const data = ports.portal();
      // Awaiting the buyer's decision leads — those are the ones the supplier is waiting on (P-03). Within each
      // group the newest first, so a supplier sees what it most recently sent at the top.
      const byNewest = (a: SubmissionView, b: SubmissionView): number => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0);
      const awaiting = data.submissions.filter((s) => s.requiresReview).sort(byNewest).map((s) => presentSubmission(lang, s));
      const processed = data.submissions.filter((s) => !s.requiresReview).sort(byNewest).map((s) => presentSubmission(lang, s));
      // The statement is presented only when accessible; an inaccessible statement is a permission answer, not a
      // balance, so the screen shows the "ask us to turn it on" line rather than a misleading set of zeros.
      const statement = data.statement !== null && data.statement.accessible ? presentStatement(lang, data.statement) : null;

      const anyAttention = awaiting.length > 0 || (statement !== null && !statement.reconciles);
      // Anything worth a page: any submission, an accessible statement, OR a statement the login cannot see
      // (the "ask us to turn it on" line is content, not a calm blank).
      const anythingShown = data.submissions.length > 0 || data.statement !== null;
      const state = anythingShown ? 'ready' : 'empty';

      return {
        screenState: presentScreenState({ state, label: t(state === 'empty' ? 'scrEmpty' : 'scrReady') }),
        awaiting,
        processed,
        statement,
        statementInaccessible: data.statement !== null && !data.statement.accessible,
        awaitingCount: awaiting.length,
        notIdentified,
        anyAttention,
      };
    },
  };
}
