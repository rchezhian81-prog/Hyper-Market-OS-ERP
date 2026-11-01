// The Buying page's "Open orders" tab (M06-FR-04 "central/local procurement, amendments, cancellations and open-commitment
// tracking" · OB-289 buying scope · OB-290 limits · OB-63 open-to-buy · §28 · hard rule #2). A tested, DOM-free THIN client
// over head office's own routes:
//   • THE OPEN-COMMITMENT REPORT (`GET /v1/purchase/commitments/report`) — what is still on order, by buying scope
//     (central via the warehouse, central direct to the store, local, or "scope not recorded" — never guessed), by supplier
//     and by store; every issued order line with ordered, received, cancelled and open in the product's OWN unit (2.500 kg,
//     never 2500); the over-receipts and the receipts that do not add up named as exceptions;
//   • AMEND an issued order (`POST /v1/purchase/orders/:poId/amendments`) — the full amended line set with a reason; head
//     office keeps the earlier lines on its ledger (hard rule #2), refuses an amendment above the amender's limit (OB-290)
//     and judges a raise against the month's open-to-buy (OB-63, an over-budget reason asked for);
//   • CANCEL quantity (`POST /v1/purchase/orders/:poId/cancellations`) — per product, with a reason; the open commitment
//     falls by exactly that.
// Every quantity a person types is read in the line's own unit by the one shared reading (`typedQuantityMinor`, OB-31).
// Head office re-checks every permission (`purchase.order.approve`); `may` only shapes what is offered. Nothing is read on open.

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';
import { paiseOf, rupees } from './blanket-orders-session';
import { quantityLabel, toDecimalString, normaliseUom, typedQuantityMinor } from '../../../packages/contracts/src/quantity';

export { rupees };
export type Lang = 'en' | 'ta';

export const OPEN_ORDERS_COPY = {
  en: {
    tab: 'Open orders', title: 'Open orders', lead: 'What is still on order — by buying scope, supplier and store — and, for the person who approves orders, changing or cancelling an issued order. Head office keeps every earlier version.',
    show: 'Show what is on order', filterScope: 'Buying scope (leave for all)', filterSupplier: 'Supplier (leave for all)', filterStore: 'Store (leave for all)', allScopes: 'All scopes',
    totalOpen: 'Still on order (value)', issuedOrders: 'Issued orders', byScopeH: 'By buying scope', bySupplierH: 'By supplier', byStoreH: 'By store',
    sc_central_via_warehouse: 'Central — through the warehouse', sc_central_direct_to_store: 'Central — straight to the store', sc_local: 'Local — bought by the store', sc_scope_not_recorded: 'Scope not recorded (an older order)',
    store_not_named: 'Store not named (an older order)', orders: 'orders', lines: 'lines',
    exceptionsH: 'Exceptions', overReceived: 'More received than ordered', receiptsDisagree: 'The receipts do not add up to what the order holds', noExceptions: 'No exceptions.',
    ordersH: 'Issued orders with something still to come', noOrders: 'No issued order has anything still to come.',
    order: 'Order', supplier: 'Supplier', deliverTo: 'Deliver to', scope: 'Scope', product: 'Item', ordered: 'Ordered', received: 'Received', cancelled: 'Cancelled', open: 'Still to come', value: 'Value',
    amendments: 'times changed', price: 'Price per unit (₹)', newQty: 'New quantity', cancelQty: 'Quantity to cancel',
    amendH: 'Change this order', amendLead: 'Write the new quantity and price for each item. The earlier lines stay on head office\'s record.', reason: 'Why', overBudgetReason: 'Why, if it goes over the month\'s budget (owner only)',
    amend: 'Save the change', cancelH: 'Cancel some of this order', cancel: 'Cancel this quantity', casePriced: 'priced per case — write the price per unit',
    amended: 'Changed — head office kept the earlier lines on its record.', cancelledNow: 'Cancelled — what is still on order went down by that.',
    needReason: 'Write why first.', needLines: 'Write a quantity and a price per unit for every item (kg and litres may have up to 3 decimals; items are whole numbers).',
    needCancel: 'Write how much to cancel for at least one item, in its own unit (kg and litres may have up to 3 decimals).', unitUnknown: 'This item\'s unit is not one this system knows — change it at head office.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read what is on order.', cannotChange: 'Only a person who approves orders can change or cancel one.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    tab: 'திறந்த ஆணைகள்', title: 'திறந்த ஆணைகள்', lead: 'இன்னும் ஆணையில் உள்ளவை — வாங்கும் முறை, விநியோகஸ்தர், கடை வாரியாக — ஆணைகளுக்கு ஒப்புதல் தருபவருக்கு, வழங்கிய ஆணையை மாற்றுதல் அல்லது ரத்து செய்தல். ஒவ்வொரு முந்தைய பதிப்பையும் தலைமை அலுவலகம் வைத்திருக்கும்.',
    show: 'ஆணையில் உள்ளதைக் காட்டு', filterScope: 'வாங்கும் முறை (எல்லாவற்றுக்கும் விடுங்கள்)', filterSupplier: 'விநியோகஸ்தர் (எல்லாவற்றுக்கும் விடுங்கள்)', filterStore: 'கடை (எல்லாவற்றுக்கும் விடுங்கள்)', allScopes: 'எல்லா முறைகளும்',
    totalOpen: 'இன்னும் ஆணையில் (மதிப்பு)', issuedOrders: 'வழங்கிய ஆணைகள்', byScopeH: 'வாங்கும் முறை வாரியாக', bySupplierH: 'விநியோகஸ்தர் வாரியாக', byStoreH: 'கடை வாரியாக',
    sc_central_via_warehouse: 'மையம் — கிடங்கு வழியாக', sc_central_direct_to_store: 'மையம் — நேரடியாகக் கடைக்கு', sc_local: 'உள்ளூர் — கடையே வாங்கியது', sc_scope_not_recorded: 'முறை பதிவாகவில்லை (பழைய ஆணை)',
    store_not_named: 'கடை குறிப்பிடப்படவில்லை (பழைய ஆணை)', orders: 'ஆணைகள்', lines: 'வரிகள்',
    exceptionsH: 'விதிவிலக்குகள்', overReceived: 'ஆணையிட்டதை விட அதிகம் பெறப்பட்டது', receiptsDisagree: 'பெறுதல்கள் ஆணையில் உள்ளதுடன் கூடவில்லை', noExceptions: 'விதிவிலக்குகள் இல்லை.',
    ordersH: 'இன்னும் வர வேண்டியவை உள்ள வழங்கிய ஆணைகள்', noOrders: 'எந்த வழங்கிய ஆணையிலும் இன்னும் வர வேண்டியது இல்லை.',
    order: 'ஆணை', supplier: 'விநியோகஸ்தர்', deliverTo: 'வழங்க வேண்டிய இடம்', scope: 'முறை', product: 'பொருள்', ordered: 'ஆணையிட்டது', received: 'பெற்றது', cancelled: 'ரத்தானது', open: 'இன்னும் வர வேண்டியது', value: 'மதிப்பு',
    amendments: 'முறை மாற்றப்பட்டது', price: 'அலகு விலை (₹)', newQty: 'புதிய அளவு', cancelQty: 'ரத்து செய்ய வேண்டிய அளவு',
    amendH: 'இந்த ஆணையை மாற்று', amendLead: 'ஒவ்வொரு பொருளுக்கும் புதிய அளவையும் விலையையும் எழுதுங்கள். முந்தைய வரிகள் தலைமை அலுவலகப் பதிவில் இருக்கும்.', reason: 'ஏன்', overBudgetReason: 'மாத வரவுசெலவுத் திட்டத்தைத் தாண்டினால் ஏன் (உரிமையாளர் மட்டும்)',
    amend: 'மாற்றத்தைச் சேமி', cancelH: 'இந்த ஆணையில் சிலவற்றை ரத்து செய்', cancel: 'இந்த அளவை ரத்து செய்', casePriced: 'பெட்டி விலையில் — அலகு விலையை எழுதுங்கள்',
    amended: 'மாற்றப்பட்டது — முந்தைய வரிகளைத் தலைமை அலுவலகம் தன் பதிவில் வைத்தது.', cancelledNow: 'ரத்தானது — இன்னும் ஆணையில் உள்ளது அந்த அளவு குறைந்தது.',
    needReason: 'முதலில் ஏன் என்று எழுதுங்கள்.', needLines: 'ஒவ்வொரு பொருளுக்கும் அளவையும் அலகு விலையையும் எழுதுங்கள் (கிலோ, லிட்டருக்கு 3 தசம இடங்கள் வரை; பொருட்கள் முழு எண்கள்).',
    needCancel: 'குறைந்தது ஒரு பொருளுக்கு எவ்வளவு ரத்து செய்வது என்பதை அதன் அலகில் எழுதுங்கள் (கிலோ, லிட்டருக்கு 3 தசம இடங்கள் வரை).', unitUnknown: 'இந்தப் பொருளின் அலகு இந்த அமைப்புக்குத் தெரியாதது — தலைமை அலுவலகத்தில் மாற்றுங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி ஆணையில் உள்ளதைப் படிக்க முடியாது.', cannotChange: 'ஆணைகளுக்கு ஒப்புதல் தருபவர் மட்டுமே ஒன்றை மாற்றவோ ரத்து செய்யவோ முடியும்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const openOrdersWords = (lang: Lang, key: string): string =>
  (OPEN_ORDERS_COPY[lang] as Record<string, string>)[key] ?? (OPEN_ORDERS_COPY.en as Record<string, string>)[key] ?? key;

export interface OrderLine { readonly productId: string; readonly orderedQty: number; readonly uom?: string; readonly unitCost: { readonly minor: number; readonly currency: string; readonly per?: number } }
export interface IssuedOrder {
  readonly poId: string; readonly number: string; readonly supplierId: string; readonly deliverTo: string; readonly status: 'proposed' | 'issued';
  readonly currency: string; readonly lines: readonly OrderLine[]; readonly buyingScope?: string; readonly amendmentCount: number;
  readonly receivedByProduct: Readonly<Record<string, number>>; readonly cancelledByProduct: Readonly<Record<string, number>>; readonly totalMinor: number;
}
export interface CommitmentLine {
  readonly poId: string; readonly number: string; readonly supplierId: string; readonly deliverTo: string; readonly buyingScope: string; readonly productId: string;
  readonly orderedQty: number; readonly receivedQty: number; readonly cancelledQty: number; readonly openQty: number; readonly openValueMinor: number; readonly agrees: boolean;
}
export interface Group { readonly key: string; readonly orders: number; readonly lines: number; readonly openValueMinor: number }
export interface CommitmentReport {
  readonly lines: readonly CommitmentLine[]; readonly byScope: readonly Group[]; readonly bySupplier: readonly Group[]; readonly byStore: readonly Group[];
  readonly totalOpenMinor: number; readonly issuedOrders: number;
  readonly overReceived: readonly { readonly poId: string; readonly productId: string; readonly overByQty: number }[];
  readonly receiptsDisagree: readonly { readonly poId: string; readonly productId: string }[]; readonly asAt: string;
}
/** The report with each issued order beside it, so every quantity is worded in its own unit and an order can be changed. */
export interface OpenOrdersView { readonly report: CommitmentReport; readonly orders: readonly IssuedOrder[] }
export interface Filter { readonly buyingScope: string; readonly supplierId: string; readonly storeId: string }
export interface AmendForm { readonly lines: readonly { readonly productId: string; readonly qtyText: string; readonly priceText: string }[]; readonly reason: string; readonly overBudgetReason: string }
export interface CancelForm { readonly lines: readonly { readonly productId: string; readonly qtyText: string }[]; readonly reason: string }

type Why = 'nobody' | 'cannotRead' | 'cannotChange' | 'needReason' | 'needLines' | 'needCancel' | 'unitUnknown';
type Done<T = Record<string, unknown>> = Promise<Outcome<T, Why>>;

const seg = (s: string): string => encodeURIComponent(s.trim());
const unitOf = (l: OrderLine): string => l.uom ?? 'ea';

/** A held quantity of one order line in its own unit — "2.500 kg", "12". */
export const lineQty = (minor: number, uom: string): string => quantityLabel(minor, uom);
/** The figure a person edits: the line's quantity as a decimal in its unit ("2.500" for 2500 g), or '' when the unit is unknown. */
export function editableQty(minor: number, uom: string): string {
  const u = normaliseUom(uom);
  return u === undefined ? '' : toDecimalString({ minor, uom: u });
}
/** The per-unit price a person edits, in rupees — blank for a line priced per case (`per` > 1): they write the unit price. */
export const editablePrice = (l: OrderLine): string => (l.unitCost.per !== undefined && l.unitCost.per !== 1 ? '' : (l.unitCost.minor / 100).toFixed(2));

/** The amendment body head office reads — every line in its own unit — or the word key of what is missing. */
export function amendmentBody(order: IssuedOrder, form: AmendForm, amendmentId: string): { readonly body: Record<string, unknown> } | { readonly why: Why } {
  if (form.reason.trim() === '') return { why: 'needReason' };
  const lines: Record<string, unknown>[] = [];
  for (const typed of form.lines) {
    const held = order.lines.find((l) => l.productId === typed.productId);
    if (held === undefined) return { why: 'needLines' };
    if (normaliseUom(unitOf(held)) === undefined) return { why: 'unitUnknown' };
    const orderedQty = typedQuantityMinor(typed.qtyText, unitOf(held));
    const price = paiseOf(typed.priceText);
    if (orderedQty === undefined || price === null) return { why: 'needLines' };
    lines.push({ productId: held.productId, orderedQty, ...(held.uom === undefined ? {} : { uom: held.uom }), unitCost: { minor: price, currency: order.currency } });
  }
  if (lines.length === 0) return { why: 'needLines' };
  return { body: { amendmentId, lines, reason: form.reason.trim(), ...(form.overBudgetReason.trim() === '' ? {} : { overBudgetReason: form.overBudgetReason.trim() }) } };
}

/** The cancellation body — only the items given a quantity — or the word key of what is missing. */
export function cancellationBody(order: IssuedOrder, form: CancelForm, cancellationId: string): { readonly body: Record<string, unknown> } | { readonly why: Why } {
  if (form.reason.trim() === '') return { why: 'needReason' };
  const cancelledByProduct: Record<string, number> = {};
  for (const typed of form.lines) {
    if (typed.qtyText.trim() === '') continue;
    const held = order.lines.find((l) => l.productId === typed.productId);
    if (held === undefined) return { why: 'needCancel' };
    if (normaliseUom(unitOf(held)) === undefined) return { why: 'unitUnknown' };
    const q = typedQuantityMinor(typed.qtyText, unitOf(held));
    if (q === undefined) return { why: 'needCancel' };
    cancelledByProduct[held.productId] = q;
  }
  if (Object.keys(cancelledByProduct).length === 0) return { why: 'needCancel' };
  return { body: { cancellationId, cancelledByProduct, reason: form.reason.trim() } };
}

export const openOrdersOutcomeWords = (lang: Lang, out: Outcome<unknown>, good = 'amended'): string =>
  (out.result === 'ok' ? openOrdersWords(lang, good) : outcomeIn((k) => openOrdersWords(lang, k), out));

export interface OpenOrdersSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly change: boolean };
  read(filter: Filter): Done<OpenOrdersView>;
  amend(order: IssuedOrder, form: AmendForm): Done;
  cancel(order: IssuedOrder, form: CancelForm): Done;
}

export function createOpenOrdersSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newId?: (prefix: string) => string;
}): OpenOrdersSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('purchase.commitment.read'), change: named && held.has('purchase.order.approve') };
  const call = makeCaller({ keyPrefix: 'open-orders', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const idOf = input.newId ?? newId;
  const gate = (need: 'read' | 'change'): { result: 'invalid'; why: Why } | undefined =>
    !named ? { result: 'invalid', why: 'nobody' } : !may[need] ? { result: 'invalid', why: need === 'read' ? 'cannotRead' : 'cannotChange' } : undefined;
  return {
    may,
    read: async (f) => {
      const no = gate('read'); if (no !== undefined) return no;
      const q = new URLSearchParams();
      if (f.buyingScope.trim() !== '') q.set('buyingScope', f.buyingScope.trim());
      if (f.supplierId.trim() !== '') q.set('supplierId', f.supplierId.trim());
      if (f.storeId.trim() !== '') q.set('storeId', f.storeId.trim());
      const report = await call<CommitmentReport>('GET', `/v1/purchase/commitments/report${q.toString() === '' ? '' : `?${q.toString()}`}`);
      if (report.result !== 'ok') return report;
      const orders = await call<{ orders?: readonly IssuedOrder[] }>('GET', '/v1/purchase/orders');
      if (orders.result !== 'ok') return orders;
      const wanted = new Set(report.value.lines.map((l) => l.poId));
      return { result: 'ok', value: { report: report.value, orders: (orders.value.orders ?? []).filter((o) => o.status === 'issued' && wanted.has(o.poId)) } };
    },
    amend: async (order, form) => {
      const no = gate('change'); if (no !== undefined) return no;
      const made = amendmentBody(order, form, idOf('amd'));
      if ('why' in made) return { result: 'invalid', why: made.why };
      return call('POST', `/v1/purchase/orders/${seg(order.poId)}/amendments`, made.body);
    },
    cancel: async (order, form) => {
      const no = gate('change'); if (no !== undefined) return no;
      const made = cancellationBody(order, form, idOf('cxl'));
      if ('why' in made) return { result: 'invalid', why: made.why };
      return call('POST', `/v1/purchase/orders/${seg(order.poId)}/cancellations`, made.body);
    },
  };
}
