// The Online orders desk (W3 · M18-FR-01 / FR-02 / FR-04 · D05-FR-03 · §28 · P-03 · P-07 · P-08 · hard rules #2, #10). A
// tested, DOM-free session over head office's OWN order routes — the desk never decides a step itself:
//   • GET  /v1/orders/:orderId                 — one order's lifecycle state, its lines and the stock it holds;
//   • GET  /v1/orders/:orderId/backorders      — the shortfall recorded against it (the visible exception, P-08);
//   • GET  /v1/orders/:orderId/refunds         — its payment's state (paid, waiting for the bank, declined);
//   • POST /v1/orders/:orderId/transition      — move it one step (confirm, pick, pack, dispatch, deliver, collect, cancel);
//                                                a cancel gives every reservation back in the same step (M18-FR-04);
//   • POST /v1/orders/:orderId/backorder       — record what was ordered and is not held (ordered minus reserved, never a
//                                                fresh stock check, so it cannot oversell — M18-FR-02);
//   • GET  /v1/orders/refunds/pending          — every payment the bank has not answered;
//   • POST /v1/orders/:orderId/payment/resolution — what the bank's statement said, with its line (no fake "paid", §31);
//   • GET  /v1/orders/reservations             — the stock online orders hold at a store, and holds past their time;
//   • POST /v1/orders/channel-reconcile        — two order lists compared both ways (M18-FR-04 "channel totals tie");
//   • GET  /v1/inventory/online-availability   — what the app may promise per product, after the online buffer (D05-FR-03);
//   • POST /v1/inventory/online-buffer         — how many units the app keeps back for shoppers in the store, with a reason.
// Head office re-checks every act on its own permission and refuses an illegal step by name. Nothing is read or written on
// open; every write is a person's click. The till is never touched (hard rule #1): the buffer limits the APP only.

import type { ViewerIdentity } from './browser-entry';
import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';
export type OrderEvent = 'confirm' | 'pick' | 'pack' | 'dispatch' | 'deliver' | 'collect' | 'return' | 'cancel';
export const ORDER_EVENTS: readonly OrderEvent[] = ['confirm', 'pick', 'pack', 'dispatch', 'deliver', 'collect', 'return', 'cancel'];

/** The next steps head office's lifecycle allows from each state (packages/orders/src/lifecycle.ts) — the buttons offered. */
export const NEXT_STEPS: Readonly<Record<string, readonly OrderEvent[]>> = Object.freeze({
  placed: ['confirm', 'cancel'], confirmed: ['pick', 'cancel'], picking: ['pack', 'cancel'], packed: ['dispatch', 'collect', 'cancel'],
  dispatched: ['deliver', 'return'], delivered: [], collected: [], returned: [], cancelled: [],
});

export interface OrderLine { readonly productId: string; readonly quantityMinor: number }
export interface Reservation { readonly reservationId: string; readonly orderId: string; readonly productId: string; readonly quantityMinor: number; readonly locationId: string; readonly heldUntil: string }
export interface BackorderLine { readonly productId: string; readonly requestedMinor: number; readonly reservedMinor: number; readonly shortfallMinor: number }
export interface Backorder { readonly orderId: string; readonly lines: readonly BackorderLine[]; readonly at: string }
export interface OrderView {
  readonly orderId: string; readonly state: string; readonly locationId: string;
  readonly lines: readonly OrderLine[]; readonly reservations: readonly Reservation[];
  /** Undefined when head office would not say (another permission) — never shown as "none". */
  readonly backorders?: readonly Backorder[];
  readonly payment?: { readonly state: string; readonly amountMinor?: number };
}
export interface PendingPayment { readonly orderId: string; readonly amountMinor: number; readonly reason?: string; readonly recordedAt: string }
export interface ChannelOrder { readonly orderId: string; readonly valueMinor: number; readonly state: string }
export interface Reconciliation {
  readonly channel: string; readonly matched: number; readonly matchedValueMinor: number; readonly atRiskValueMinor: number; readonly reconciles: boolean; readonly detail: string;
  readonly discrepancies: readonly { readonly kind: string; readonly orderId: string; readonly channelValueMinor?: number; readonly ledgerValueMinor?: number; readonly varianceMinor: number; readonly detail: string }[];
}
export interface AvailabilityRow { readonly productId: string; readonly onHandMinor: number; readonly promisedMinor: number; readonly bufferMinor: number; readonly appMayPromiseMinor: number; readonly flags?: readonly string[] }
export interface Availability { readonly locationId: string; readonly rows: readonly AvailabilityRow[]; readonly buffers: readonly { readonly productId: string | null; readonly bufferMinor: number; readonly reason: string; readonly setBy: string; readonly setAt: string }[]; readonly asAt: string }

export const ONLINE_ORDERS_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Online orders',
    lead: 'Look up an online order and move it one step at a time, cancel it (its stock goes back to the shelf), record what could not be held, settle a payment the bank has not answered, compare a channel\'s order list with ours, and keep stock back from the app for shoppers in the store. Head office checks every step; a step it does not allow is refused and nothing changes.',
    orderH: 'One order', orderId: 'Order number', showOrder: 'Show the order', stateK: 'Now', storeK: 'Store', linesK: 'Ordered', heldK: 'Stock held for it', heldNone: 'No stock is held for it.',
    backK: 'Not held (backorder)', backNone: 'No backorder recorded.', backUnknown: 'Backorder: head office did not say.', payK: 'Payment', payUnknown: 'Payment: head office did not say.',
    nextK: 'Next steps', noNext: 'This order is finished — no step is left.', backorder: 'Record what is not held as a backorder', moved: 'Moved:', released: 'Stock given back:', nothingReleased: 'No stock was held, so none was given back.',
    backorderSaved: 'Backorder recorded:', nothingToBackorder: 'Everything ordered is held — nothing to backorder.',
    ev_confirm: 'Confirm', ev_pick: 'Start picking', ev_pack: 'Packed', ev_dispatch: 'Dispatched', ev_deliver: 'Delivered', ev_collect: 'Collected at the store', ev_return: 'Came back undelivered', ev_cancel: 'Cancel the order',
    st_placed: 'placed', st_confirmed: 'confirmed', st_picking: 'being picked', st_packed: 'packed', st_dispatched: 'dispatched', st_delivered: 'delivered', st_collected: 'collected', st_returned: 'returned undelivered', st_cancelled: 'cancelled',
    pay_authorised: 'paid', pay_pending: 'waiting for the bank', pay_declined: 'declined by the bank', pay_none: 'no online payment',
    payH: 'Payments waiting for the bank', showPay: 'Show what is waiting', noPay: 'No payment is waiting for the bank.', payWaiting: 'Waiting for the bank',
    statement: 'Bank statement line', paid: 'The bank paid it', declined: 'The bank declined it', settled: 'Recorded from the statement:',
    resH: 'Stock held for online orders', store: 'Store', showRes: 'Show the stock held', resNone: 'No stock is held for online orders at this store.', expired: 'past its time — give it back or move the order',
    recH: 'Compare a channel\'s orders with ours', channel: 'Channel name', channelList: 'The channel\'s list — one order a line: number, rupees, state', ledgerList: 'Our list — one order a line: number, rupees, state', compare: 'Compare', theirs: 'The channel says', ours: 'We say',
    recOk: 'Every order matches.', recBad: 'Differences:', recMatched: 'Matched', recAtRisk: 'Money in the differences',
    k_in_channel_not_in_ledger: 'On the channel, not with us — a customer is waiting', k_in_ledger_not_in_channel: 'With us, not on the channel — it will not be paid', k_value_mismatch: 'Different amount', k_state_mismatch: 'Different state',
    bufH: 'Stock the app keeps back for the store', bufLead: 'The app may promise what is on hand, less what other orders hold, less this buffer. The till is never limited by it. A product with no figure set keeps nothing back, and says so.',
    showAvail: 'Show what the app may promise', product: 'Product (blank = every product at the store)', units: 'How many to keep back (pieces; grams for loose kg items)', bufReason: 'Why (needed)', setBuffer: 'Save the buffer',
    onHand: 'on hand', promised: 'held for orders', keptBack: 'kept back', appMay: 'the app may promise', notSetBuf: 'buffer not set', bufSaved: 'Buffer saved:', allProducts: 'every product',
    needOrder: 'Give the order number first. Nothing was read.', needStore: 'Give the store first. Nothing was read.', needStatement: 'Give the bank statement line first. Nothing was sent.',
    needChannel: 'Give the channel\'s name and both lists. Nothing was sent.', badLine: 'A line could not be read (number, rupees, state):', needUnits: 'Give a whole number of units, 0 or more. Nothing was sent.', needReason: 'Say why first. Nothing was sent.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.', cannotRead: 'Your role cannot read orders.', cannotMove: 'Your role cannot move orders.', cannotBackorder: 'Your role cannot record backorders.',
    cannotSettle: 'Your role cannot record payments.', cannotReserve: 'Your role cannot read the stock held for orders.', cannotAvail: 'Your role cannot read stock.', cannotBuffer: 'Your role cannot set the online buffer.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
  },
  ta: {
    lang: 'English', title: 'ஆன்லைன் ஆர்டர்கள்',
    lead: 'ஒரு ஆன்லைன் ஆர்டரைத் தேடி ஒவ்வொரு படியாக நகர்த்துங்கள், ரத்து செய்யுங்கள் (அதன் சரக்கு அலமாரிக்குத் திரும்பும்), வைத்திருக்க முடியாததைப் பதிவு செய்யுங்கள், வங்கி பதில் சொல்லாத கட்டணத்தைத் தீர்த்து வையுங்கள், ஒரு விற்பனை வழியின் ஆர்டர் பட்டியலை நம்முடையதுடன் ஒப்பிடுங்கள், கடையில் வாங்குபவர்களுக்காக ஆப்பிலிருந்து சரக்கை ஒதுக்கி வையுங்கள். ஒவ்வொரு படியையும் தலைமை அலுவலகம் சரிபார்க்கும்; அனுமதிக்காத படி மறுக்கப்படும், எதுவும் மாறாது.',
    orderH: 'ஒரு ஆர்டர்', orderId: 'ஆர்டர் எண்', showOrder: 'ஆர்டரைக் காட்டு', stateK: 'இப்போது', storeK: 'கடை', linesK: 'ஆர்டர் செய்தவை', heldK: 'இதற்காக வைத்துள்ள சரக்கு', heldNone: 'இதற்காக எந்தச் சரக்கும் வைக்கப்படவில்லை.',
    backK: 'வைக்க முடியாதவை (பின்னர் தருவது)', backNone: 'பின்னர் தருவது எதுவும் பதிவாகவில்லை.', backUnknown: 'பின்னர் தருவது: தலைமை அலுவலகம் சொல்லவில்லை.', payK: 'கட்டணம்', payUnknown: 'கட்டணம்: தலைமை அலுவலகம் சொல்லவில்லை.',
    nextK: 'அடுத்த படிகள்', noNext: 'இந்த ஆர்டர் முடிந்தது — எந்தப் படியும் இல்லை.', backorder: 'வைக்க முடியாததைப் பின்னர் தருவதாகப் பதிவு செய்', moved: 'நகர்த்தப்பட்டது:', released: 'திரும்பக் கொடுத்த சரக்கு:', nothingReleased: 'எந்தச் சரக்கும் வைக்கப்படவில்லை, எனவே எதுவும் திரும்பவில்லை.',
    backorderSaved: 'பின்னர் தருவது பதிவானது:', nothingToBackorder: 'ஆர்டர் செய்த அனைத்தும் வைக்கப்பட்டுள்ளன — பின்னர் தருவது எதுவுமில்லை.',
    ev_confirm: 'உறுதிசெய்', ev_pick: 'எடுக்கத் தொடங்கு', ev_pack: 'பொதி செய்யப்பட்டது', ev_dispatch: 'அனுப்பப்பட்டது', ev_deliver: 'வழங்கப்பட்டது', ev_collect: 'கடையில் பெற்றுக்கொண்டார்', ev_return: 'வழங்கப்படாமல் திரும்பியது', ev_cancel: 'ஆர்டரை ரத்து செய்',
    st_placed: 'பதிவானது', st_confirmed: 'உறுதிசெய்யப்பட்டது', st_picking: 'எடுக்கப்படுகிறது', st_packed: 'பொதி செய்யப்பட்டது', st_dispatched: 'அனுப்பப்பட்டது', st_delivered: 'வழங்கப்பட்டது', st_collected: 'பெற்றுக்கொள்ளப்பட்டது', st_returned: 'வழங்கப்படாமல் திரும்பியது', st_cancelled: 'ரத்து செய்யப்பட்டது',
    pay_authorised: 'செலுத்தப்பட்டது', pay_pending: 'வங்கிக்காகக் காத்திருக்கிறது', pay_declined: 'வங்கி மறுத்தது', pay_none: 'ஆன்லைன் கட்டணம் இல்லை',
    payH: 'வங்கிக்காகக் காத்திருக்கும் கட்டணங்கள்', showPay: 'காத்திருப்பதைக் காட்டு', noPay: 'வங்கிக்காக எந்தக் கட்டணமும் காத்திருக்கவில்லை.', payWaiting: 'வங்கிக்காகக் காத்திருக்கிறது',
    statement: 'வங்கி அறிக்கை வரி', paid: 'வங்கி செலுத்தியது', declined: 'வங்கி மறுத்தது', settled: 'அறிக்கையிலிருந்து பதிவு செய்யப்பட்டது:',
    resH: 'ஆன்லைன் ஆர்டர்களுக்காக வைத்துள்ள சரக்கு', store: 'கடை', showRes: 'வைத்துள்ள சரக்கைக் காட்டு', resNone: 'இந்தக் கடையில் ஆன்லைன் ஆர்டர்களுக்காக எந்தச் சரக்கும் வைக்கப்படவில்லை.', expired: 'நேரம் கடந்தது — திருப்பிக் கொடுங்கள் அல்லது ஆர்டரை நகர்த்துங்கள்',
    recH: 'ஒரு விற்பனை வழியின் ஆர்டர்களை நம்முடையதுடன் ஒப்பிடு', channel: 'விற்பனை வழியின் பெயர்', channelList: 'அந்த வழியின் பட்டியல் — ஒரு வரிக்கு ஒரு ஆர்டர்: எண், ரூபாய், நிலை', ledgerList: 'நம் பட்டியல் — ஒரு வரிக்கு ஒரு ஆர்டர்: எண், ரூபாய், நிலை', compare: 'ஒப்பிடு', theirs: 'அந்த வழி சொல்வது', ours: 'நாம் சொல்வது',
    recOk: 'எல்லா ஆர்டர்களும் பொருந்துகின்றன.', recBad: 'வேறுபாடுகள்:', recMatched: 'பொருந்தியவை', recAtRisk: 'வேறுபாடுகளில் உள்ள பணம்',
    k_in_channel_not_in_ledger: 'அந்த வழியில் உள்ளது, நம்மிடம் இல்லை — ஒரு வாடிக்கையாளர் காத்திருக்கிறார்', k_in_ledger_not_in_channel: 'நம்மிடம் உள்ளது, அந்த வழியில் இல்லை — பணம் வராது', k_value_mismatch: 'தொகை வேறுபடுகிறது', k_state_mismatch: 'நிலை வேறுபடுகிறது',
    bufH: 'கடைக்காக ஆப் ஒதுக்கி வைக்கும் சரக்கு', bufLead: 'கையிருப்பில், மற்ற ஆர்டர்கள் வைத்துள்ளதையும் இந்த ஒதுக்கீட்டையும் கழித்து மீதியை மட்டுமே ஆப் உறுதியளிக்கலாம். பில் கவுண்டரை இது ஒருபோதும் கட்டுப்படுத்தாது. எண்ணிக்கை அமைக்காத பொருளுக்கு எதுவும் ஒதுக்கப்படாது, அதுவும் சொல்லப்படும்.',
    showAvail: 'ஆப் உறுதியளிக்கக்கூடியதைக் காட்டு', product: 'பொருள் (காலி = கடையின் எல்லாப் பொருட்களும்)', units: 'எவ்வளவு ஒதுக்க வேண்டும் (எண்ணிக்கை; கிலோ பொருளுக்குக் கிராம்)', bufReason: 'ஏன் (தேவை)', setBuffer: 'ஒதுக்கீட்டைச் சேமி',
    onHand: 'கையிருப்பு', promised: 'ஆர்டர்களுக்காக வைத்தது', keptBack: 'ஒதுக்கியது', appMay: 'ஆப் உறுதியளிக்கலாம்', notSetBuf: 'ஒதுக்கீடு அமைக்கப்படவில்லை', bufSaved: 'ஒதுக்கீடு சேமிக்கப்பட்டது:', allProducts: 'எல்லாப் பொருட்களும்',
    needOrder: 'முதலில் ஆர்டர் எண்ணைக் கொடுங்கள். எதுவும் படிக்கப்படவில்லை.', needStore: 'முதலில் கடையைக் கொடுங்கள். எதுவும் படிக்கப்படவில்லை.', needStatement: 'முதலில் வங்கி அறிக்கை வரியைக் கொடுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    needChannel: 'விற்பனை வழியின் பெயரையும் இரண்டு பட்டியல்களையும் கொடுங்கள். எதுவும் அனுப்பப்படவில்லை.', badLine: 'ஒரு வரியைப் படிக்க முடியவில்லை (எண், ரூபாய், நிலை):', needUnits: '0 அல்லது அதற்கு மேற்பட்ட முழு எண்ணைக் கொடுங்கள். எதுவும் அனுப்பப்படவில்லை.', needReason: 'முதலில் காரணத்தைச் சொல்லுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', cannotRead: 'உங்கள் பங்கு ஆர்டர்களைப் படிக்க முடியாது.', cannotMove: 'உங்கள் பங்கு ஆர்டர்களை நகர்த்த முடியாது.', cannotBackorder: 'உங்கள் பங்கு பின்னர் தருவதைப் பதிவு செய்ய முடியாது.',
    cannotSettle: 'உங்கள் பங்கு கட்டணங்களைப் பதிவு செய்ய முடியாது.', cannotReserve: 'உங்கள் பங்கு ஆர்டர்களுக்காக வைத்த சரக்கைப் படிக்க முடியாது.', cannotAvail: 'உங்கள் பங்கு சரக்கைப் படிக்க முடியாது.', cannotBuffer: 'உங்கள் பங்கு ஆன்லைன் ஒதுக்கீட்டை அமைக்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
  },
} as const;
export type OnlineOrdersKey = keyof typeof ONLINE_ORDERS_COPY.en;
export const onlineOrdersWords = (lang: Lang, key: OnlineOrdersKey | string): string => (ONLINE_ORDERS_COPY[lang] as Record<string, string>)[key] ?? (ONLINE_ORDERS_COPY.en as Record<string, string>)[key] ?? key;
export const onlineOrdersOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => onlineOrdersWords(lang, k), out);

export function rupees(minor: number): string {
  const sign = minor < 0 ? '−' : '';
  return `${sign}₹${Math.floor(Math.abs(minor) / 100).toLocaleString('en-IN')}.${String(Math.abs(minor) % 100).padStart(2, '0')}`;
}
/** Rupees as typed ("1,250.50") → whole paise, or undefined. */
export function paiseOf(text: string): number | undefined {
  const t = text.replace(/[,\s₹]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  const [r, p = ''] = t.split('.');
  return Number(r) * 100 + Number(p.padEnd(2, '0'));
}

/**
 * One order a line — "number, rupees, state" (commas or tabs between, blank lines skipped). A line that cannot be read is
 * named, never dropped: a list with one line left out would "reconcile" by hiding the very order that differs (P-08).
 */
export function readOrderList(text: string): { readonly ok: true; readonly orders: readonly ChannelOrder[] } | { readonly ok: false; readonly line: string } {
  const orders: ChannelOrder[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    // Split on tabs or commas; the amount may carry its own thousands commas ("1,250.50"), so the first part is the number,
    // the last the state, and what lies between is the amount.
    const parts = line.split(/[,\t]/).map((s) => s.trim());
    const orderId = parts[0] ?? '';
    const state = parts.length >= 3 ? parts[parts.length - 1]! : '';
    const amount = parts.slice(1, -1).join('');
    const valueMinor = paiseOf(amount);
    if (orderId === '' || state === '' || valueMinor === undefined) return { ok: false, line };
    orders.push({ orderId, valueMinor, state: state.toLowerCase() });
  }
  return { ok: true, orders };
}

export interface OnlineOrdersSession {
  readonly may: {
    readonly named: boolean; readonly read: boolean; readonly move: boolean; readonly backorder: boolean; readonly settle: boolean;
    readonly reservations: boolean; readonly availability: boolean; readonly buffer: boolean;
  };
  /** The order, its backorders and its payment's state — the last two left out (never "none") when head office would not say. */
  order(orderId: string): Promise<Outcome<OrderView>>;
  move(orderId: string, event: OrderEvent): Promise<Outcome<{ readonly orderId: string; readonly event: string; readonly from: string; readonly state: string; readonly released: readonly Reservation[] }>>;
  backorder(orderId: string): Promise<Outcome<{ readonly outcome: 'backordered' | 'nothing_to_backorder'; readonly lines: readonly BackorderLine[] }>>;
  pendingPayments(): Promise<Outcome<readonly PendingPayment[]>>;
  settle(orderId: string, result: 'authorised' | 'declined', statementRef: string): Promise<Outcome<{ readonly payment: { readonly state: string } }>>;
  reservations(locationId: string): Promise<Outcome<{ readonly outstanding: readonly Reservation[]; readonly expired: readonly Reservation[]; readonly asAt: string }>>;
  reconcile(input: { readonly channel: string; readonly channelList: string; readonly ledgerList: string }): Promise<Outcome<Reconciliation> & { readonly badLine?: string }>;
  availability(locationId: string): Promise<Outcome<Availability>>;
  setBuffer(input: { readonly locationId: string; readonly productId: string; readonly units: string; readonly reason: string }): Promise<Outcome<{ readonly buffer: { readonly productId: string | null; readonly bufferMinor: number } }>>;
}

export function createOnlineOrdersSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): OnlineOrdersSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const has = (p: string): boolean => named && perms.has(p);
  const may = {
    named, read: has('order.read'), move: has('order.lifecycle.manage'), backorder: has('order.backorder.manage'), settle: has('order.payment.record'),
    reservations: has('order.reservation.read'), availability: has('inventory.availability.read'), buffer: has('inventory.online.buffer.set'),
  };
  const call = makeCaller({ keyPrefix: 'online-orders', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const guard = (need: boolean, why: OnlineOrdersKey): Outcome<never, OnlineOrdersKey> | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !need ? { result: 'invalid', why } : undefined);
  const enc = encodeURIComponent;
  return {
    may,
    order: async (orderId) => {
      const g = guard(may.read, 'cannotRead'); if (g) return g;
      const id = orderId.trim();
      if (id === '') return { result: 'invalid', why: 'needOrder' };
      const main = await call<Omit<OrderView, 'backorders' | 'payment'>>('GET', `/v1/orders/${enc(id)}`);
      if (main.result !== 'ok') return main;
      const [back, money] = await Promise.all([
        call<{ readonly backorders: readonly Backorder[] }>('GET', `/v1/orders/${enc(id)}/backorders`),
        call<{ readonly payment: { readonly state: string; readonly amountMinor?: number } }>('GET', `/v1/orders/${enc(id)}/refunds`),
      ]);
      return { result: 'ok', value: {
        ...main.value,
        ...(back.result === 'ok' ? { backorders: back.value.backorders } : {}),
        ...(money.result === 'ok' && money.value.payment !== undefined ? { payment: money.value.payment } : {}),
      } };
    },
    move: async (orderId, event) => {
      const g = guard(may.move, 'cannotMove'); if (g) return g;
      if (orderId.trim() === '') return { result: 'invalid', why: 'needOrder' };
      return call('POST', `/v1/orders/${enc(orderId.trim())}/transition`, { event });
    },
    backorder: async (orderId) => {
      const g = guard(may.backorder, 'cannotBackorder'); if (g) return g;
      if (orderId.trim() === '') return { result: 'invalid', why: 'needOrder' };
      return call('POST', `/v1/orders/${enc(orderId.trim())}/backorder`, {});
    },
    pendingPayments: async () => {
      const g = guard(may.read, 'cannotRead'); if (g) return g;
      const out = await call<{ readonly pendingPayments: readonly PendingPayment[] }>('GET', '/v1/orders/refunds/pending');
      return out.result === 'ok' ? { result: 'ok', value: out.value.pendingPayments ?? [] } : out;
    },
    settle: async (orderId, result, statementRef) => {
      const g = guard(may.settle, 'cannotSettle'); if (g) return g;
      if (orderId.trim() === '') return { result: 'invalid', why: 'needOrder' };
      if (statementRef.trim() === '') return { result: 'invalid', why: 'needStatement' };
      return call('POST', `/v1/orders/${enc(orderId.trim())}/payment/resolution`, { result, evidenceRef: statementRef.trim() });
    },
    reservations: async (locationId) => {
      const g = guard(may.reservations, 'cannotReserve'); if (g) return g;
      if (locationId.trim() === '') return { result: 'invalid', why: 'needStore' };
      return call('GET', `/v1/orders/reservations?locationId=${enc(locationId.trim())}`);
    },
    reconcile: async ({ channel, channelList, ledgerList }) => {
      const g = guard(may.read, 'cannotRead'); if (g) return g;
      if (channel.trim() === '' || channelList.trim() === '' || ledgerList.trim() === '') return { result: 'invalid', why: 'needChannel' };
      const theirs = readOrderList(channelList);
      if (!theirs.ok) return { result: 'invalid', why: 'badLine', badLine: theirs.line };
      const ours = readOrderList(ledgerList);
      if (!ours.ok) return { result: 'invalid', why: 'badLine', badLine: ours.line };
      return call('POST', '/v1/orders/channel-reconcile', { channel: channel.trim(), channelOrders: theirs.orders, ledgerOrders: ours.orders });
    },
    availability: async (locationId) => {
      const g = guard(may.availability, 'cannotAvail'); if (g) return g;
      if (locationId.trim() === '') return { result: 'invalid', why: 'needStore' };
      return call('GET', `/v1/inventory/online-availability?locationId=${enc(locationId.trim())}`);
    },
    setBuffer: async ({ locationId, productId, units, reason }) => {
      const g = guard(may.buffer, 'cannotBuffer'); if (g) return g;
      if (locationId.trim() === '') return { result: 'invalid', why: 'needStore' };
      const n = units.trim();
      if (!/^\d+$/.test(n) || !Number.isSafeInteger(Number(n))) return { result: 'invalid', why: 'needUnits' };
      if (reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      return call('POST', '/v1/inventory/online-buffer', { locationId: locationId.trim(), productId: productId.trim() === '' ? null : productId.trim(), bufferMinor: Number(n), reason: reason.trim() });
    },
  };
}
