// M06-FR-02 · WF-03 (OB-288 P3) — the Requisitions page's tested, DOM-free session: requisition → RFQ (the suppliers' quotes)
// → the like-for-like comparison → an order raised FROM the requisition at the chosen quote. A thin client over head office's
// own routes (`/v1/purchase/requisitions*`, `/v1/purchase/orders/:poId`); the comparison is head office's tested
// `compareQuotes`, never worked out here. The order it raises is only PROPOSED: a second person issues it on the Buying page
// (§28). The session refuses only the cheap things before a request (nobody signed in, the right not held, a line with no
// product or no amount); head office refuses everything else, by name, and the page shows its words. OB-31: a quantity is
// TYPED in the product's own unit (10 kg) and SENT as its smallest step (10000 g) — the unit is head office's, asked for.

import type { ViewerIdentity } from './browser-entry';
import { normaliseUom, quantityLabel, typedQuantityMinor } from '../../../packages/contracts/src/quantity';

export type Lang = 'en' | 'ta';
export type Outcome<T> =
  | { readonly result: 'ok'; readonly value: T }
  | { readonly result: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string }
  | { readonly result: 'invalid'; readonly why: RequisitionsCopyKey }
  | { readonly result: 'lost_link' };

export interface RequisitionView {
  readonly requisitionId: string;
  readonly currency: string;
  /** OB-31: `quantity` is the unit's smallest step (grams for kg, millilitres for L); `uom` is head office's unit for it. */
  readonly lines: readonly { readonly productId: string; readonly quantity: number; readonly uom?: string }[];
  readonly raisedBy?: string;
  readonly source?: { readonly kind: 'replenishment' | 'a02_draft'; readonly storeId?: string; readonly proposalIds?: readonly string[] };
}
export interface OfferView { readonly supplierId: string; readonly quoteId: string; readonly unitCost: { readonly minor: number }; readonly lineCost: { readonly minor: number }; readonly leadTimeDays: number; readonly comparable: boolean; readonly reason?: string }
export interface Ref { readonly supplierId: string; readonly quoteId: string }
export interface ComparisonView {
  readonly requisitionId: string;
  readonly currency: string;
  readonly lines: readonly { readonly productId: string; readonly quantity: number; readonly uom?: string; readonly offers: readonly OfferView[]; readonly cheapest?: Ref; readonly fastest?: Ref }[];
  readonly totals: readonly { readonly supplierId: string; readonly quoteId: string; readonly totalCost: { readonly minor: number }; readonly maxLeadTimeDays: number }[];
  readonly cheapestOverall?: Ref; readonly fastestOverall?: Ref;
  readonly incompleteQuotes: readonly string[];
  readonly summary: string;
}

/** One row of the comparison as the page draws it: an offer, and whether it is the line's cheapest and/or fastest. */
export interface OfferRow { readonly productId: string; readonly quantity: number; readonly supplierId: string; readonly quoteId: string; readonly unitMinor: number; readonly lineMinor: number; readonly leadTimeDays: number; readonly cheapest: boolean; readonly fastest: boolean; readonly comparable: boolean; readonly reason?: string }

/** The comparison flattened for a table — head office's verdict marked on its own rows; nothing re-ranked here. Pure. */
export function offerRows(c: ComparisonView): readonly OfferRow[] {
  const same = (r: Ref | undefined, o: OfferView): boolean => r !== undefined && r.quoteId === o.quoteId && r.supplierId === o.supplierId;
  return c.lines.flatMap((l) => l.offers.map((o): OfferRow => ({
    productId: l.productId, quantity: l.quantity, supplierId: o.supplierId, quoteId: o.quoteId, unitMinor: o.unitCost.minor, lineMinor: o.lineCost.minor,
    leadTimeDays: o.leadTimeDays, cheapest: same(l.cheapest, o), fastest: same(l.fastest, o), comparable: o.comparable, ...(o.reason === undefined ? {} : { reason: o.reason }),
  })));
}

/** The order lines a chosen quote makes from a requisition: each requisition line at that quote's price. Pure. */
export function orderLinesFrom(c: ComparisonView, quoteId: string): readonly { readonly productId: string; readonly orderedQty: number; readonly unitCost: { readonly minor: number; readonly currency: string } }[] | undefined {
  const out: { productId: string; orderedQty: number; unitCost: { minor: number; currency: string } }[] = [];
  for (const l of c.lines) {
    const o = l.offers.find((x) => x.quoteId === quoteId && x.comparable);
    if (o === undefined) return undefined; // the quote does not cover every line like-for-like
    out.push({ productId: l.productId, orderedQty: l.quantity, unitCost: { minor: o.unitCost.minor, currency: c.currency } });
  }
  return out;
}

/**
 * OB-31 — a requisition line's quantity as a person reads it: 10000 of a kg product reads "10.000 kg", 12 items "12".
 * A line head office sent without a unit counts whole items (as head office values it).
 */
export const quantityText = (quantity: number, uom: string | undefined): string => quantityLabel(quantity, uom ?? 'ea');
/** "rice × 10.000 kg" — a line as the list, the quote form and the opened requisition name it. */
export const lineText = (l: { readonly productId: string; readonly quantity: number; readonly uom?: string }): string => `${l.productId} × ${quantityText(l.quantity, l.uom)}`;

export const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const REQUISITIONS_COPY = {
  en: {
    lang: 'தமிழ்', title: 'Requisitions and quotes',
    lead: 'Raise what the shop needs, record what each supplier quotes, and compare them like for like. The order you raise from a quote is only proposed — a second person issues it on the Buying page.',
    worklist: 'Requisitions', none: 'No requisitions yet.', id: 'Requisition', lines: 'Lines', raisedBy: 'Raised by', from: 'From', typed: 'typed', fromReplenishment: 'replenishment proposal', fromDrafts: 'purchase-agent draft', open: 'Open',
    raise: 'Raise a requisition', newId: 'Requisition number', product: 'Product code', quantity: 'Quantity (items, or kg / litres)', addLine: 'Add a line', raiseIt: 'Raise the requisition',
    quotes: 'Record a supplier\'s quote', supplier: 'Supplier code', quoteId: 'Quote number', unitCost: 'Price per item, kg or litre (₹)', leadDays: 'Lead time (days)', recordQuote: 'Record the quote',
    comparison: 'Comparison', cheapest: 'Cheapest', fastest: 'Fastest', notComparable: 'Not comparable', total: 'Total', slowestLine: 'complete in', days: 'days',
    cheapestOverall: 'Cheapest overall', fastestOverall: 'Fastest overall', incomplete: 'Could not be compared in full (a line is missing):', noQuotes: 'No quotes yet.',
    order: 'Raise the order from a quote', chooseQuote: 'Quote', deliverTo: 'Deliver to (store code)', poId: 'Order number', raiseOrder: 'Propose the order',
    proposed: 'Order proposed — a second person issues it on the Buying page.', raised: 'Requisition raised.', quoted: 'Quote recorded.',
    nobody: 'Nobody is signed in on this screen — you can do nothing here.', cannotRead: 'Your role cannot read requisitions.', cannotRaise: 'Your role cannot raise requisitions or quotes.',
    needId: 'Give the requisition (or order, or quote) a number first. Nothing was sent.', needLine: 'Each line needs a product code and a quantity above 0 in the product\'s own unit — whole items, or up to three decimals of a kg or a litre (2.5). Nothing was sent.',

    needPrice: 'Each line needs a price (in rupees, up to two decimals) and a whole number of days. Nothing was sent.', needSupplier: 'Type the supplier code first. Nothing was sent.',
    notWholeQuote: 'That quote does not cover every line like for like, so no order can be raised from it. Nothing was sent.', needStore: 'Say which store the order is delivered to. Nothing was sent.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was saved, and nothing old is shown.',
  },
  ta: {
    lang: 'English', title: 'கோரிக்கைகளும் விலைப்புள்ளிகளும்',
    lead: 'கடைக்குத் தேவையானதைக் கோருங்கள், ஒவ்வொரு விநியோகஸ்தரின் விலைப்புள்ளியைப் பதிவு செய்யுங்கள், சமமாக ஒப்பிடுங்கள். ஒரு விலைப்புள்ளியிலிருந்து எழுப்பும் ஆணை முன்மொழிவு மட்டுமே — இரண்டாம் நபர் அதை வாங்குதல் பக்கத்தில் வெளியிடுவார்.',
    worklist: 'கோரிக்கைகள்', none: 'இன்னும் கோரிக்கைகள் இல்லை.', id: 'கோரிக்கை', lines: 'வரிகள்', raisedBy: 'எழுப்பியவர்', from: 'எதிலிருந்து', typed: 'தட்டச்சு', fromReplenishment: 'மறுநிரப்பு முன்மொழிவு', fromDrafts: 'கொள்முதல் உதவியாளர் வரைவு', open: 'திற',
    raise: 'கோரிக்கை எழுப்பு', newId: 'கோரிக்கை எண்', product: 'பொருள் குறியீடு', quantity: 'அளவு (பொருட்கள், அல்லது கிலோ / லிட்டர்)', addLine: 'வரி சேர்', raiseIt: 'கோரிக்கையை எழுப்பு',
    quotes: 'விநியோகஸ்தரின் விலைப்புள்ளியைப் பதிவு செய்', supplier: 'விநியோகஸ்தர் குறியீடு', quoteId: 'விலைப்புள்ளி எண்', unitCost: 'ஒரு பொருள், கிலோ அல்லது லிட்டருக்கு விலை (₹)', leadDays: 'விநியோக நேரம் (நாட்கள்)', recordQuote: 'விலைப்புள்ளியைப் பதிவு செய்',
    comparison: 'ஒப்பீடு', cheapest: 'குறைந்த விலை', fastest: 'விரைவானது', notComparable: 'ஒப்பிட முடியாது', total: 'மொத்தம்', slowestLine: 'முடிவது', days: 'நாட்கள்',
    cheapestOverall: 'மொத்தத்தில் குறைந்த விலை', fastestOverall: 'மொத்தத்தில் விரைவானது', incomplete: 'முழுமையாக ஒப்பிட முடியவில்லை (ஒரு வரி இல்லை):', noQuotes: 'இன்னும் விலைப்புள்ளிகள் இல்லை.',
    order: 'விலைப்புள்ளியிலிருந்து ஆணை எழுப்பு', chooseQuote: 'விலைப்புள்ளி', deliverTo: 'விநியோகிக்கும் இடம் (கடை குறியீடு)', poId: 'ஆணை எண்', raiseOrder: 'ஆணையை முன்மொழி',
    proposed: 'ஆணை முன்மொழியப்பட்டது — இரண்டாம் நபர் அதை வாங்குதல் பக்கத்தில் வெளியிடுவார்.', raised: 'கோரிக்கை எழுப்பப்பட்டது.', quoted: 'விலைப்புள்ளி பதிவாகியது.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — இங்கே எதுவும் செய்ய முடியாது.', cannotRead: 'உங்கள் பங்கு கோரிக்கைகளைப் படிக்க முடியாது.', cannotRaise: 'உங்கள் பங்கு கோரிக்கைகளையோ விலைப்புள்ளிகளையோ எழுப்ப முடியாது.',
    needId: 'முதலில் கோரிக்கைக்கு (அல்லது ஆணைக்கு, விலைப்புள்ளிக்கு) ஒரு எண் கொடுங்கள். எதுவும் அனுப்பப்படவில்லை.', needLine: 'ஒவ்வொரு வரிக்கும் பொருள் குறியீடும் அந்தப் பொருளின் அலகில் 0-க்கு மேற்பட்ட அளவும் வேண்டும் — முழுப் பொருட்கள், அல்லது கிலோ / லிட்டரில் மூன்று தசம இடங்கள் வரை (2.5). எதுவும் அனுப்பப்படவில்லை.',

    needPrice: 'ஒவ்வொரு வரிக்கும் விலையும் (ரூபாயில், இரண்டு தசம இடங்கள் வரை) முழு நாட்களும் வேண்டும். எதுவும் அனுப்பப்படவில்லை.', needSupplier: 'முதலில் விநியோகஸ்தர் குறியீட்டைத் தட்டச்சு செய்யவும். எதுவும் அனுப்பப்படவில்லை.',
    notWholeQuote: 'அந்த விலைப்புள்ளி எல்லா வரிகளையும் சமமாக உள்ளடக்கவில்லை, எனவே அதிலிருந்து ஆணை எழுப்ப முடியாது. எதுவும் அனுப்பப்படவில்லை.', needStore: 'ஆணை எந்தக் கடைக்கு விநியோகிக்கப்படும் என்று சொல்லுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் சேமிக்கப்படவில்லை, பழையது எதுவும் காட்டப்படவில்லை.',
  },
} as const;
export type RequisitionsCopyKey = keyof typeof REQUISITIONS_COPY.en;

export const requisitionsWords = (lang: Lang, key: RequisitionsCopyKey | string): string =>
  (REQUISITIONS_COPY[lang] as Record<string, string>)[key] ?? (REQUISITIONS_COPY.en as Record<string, string>)[key] ?? key;
export function requisitionsOutcomeWords(lang: Lang, out: Outcome<unknown>): string {
  if (out.result === 'refused') return `${requisitionsWords(lang, 'refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return requisitionsWords(lang, out.why);
  if (out.result === 'lost_link') return requisitionsWords(lang, 'unreachable');
  return '';
}

/** Rupees as a person types them ("39", "39.5", "39.50") to whole paise; undefined for anything else. */
export function paiseFromRupees(text: string): number | undefined {
  const m = /^\s*(\d{1,9})(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (m === null) return undefined;
  return Number(m[1]) * 100 + (m[2] === undefined ? 0 : Number(m[2].padEnd(2, '0')));
}

export interface RequisitionsSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly raise: boolean };
  list(): Promise<Outcome<readonly RequisitionView[]>>;
  raise(requisitionId: string, lines: readonly { readonly productId: string; readonly quantity: string }[]): Promise<Outcome<RequisitionView>>;
  recordQuote(requisitionId: string, quoteId: string, supplierId: string, lines: readonly { readonly productId: string; readonly unitRupees: string; readonly leadDays: string }[]): Promise<Outcome<unknown>>;
  comparison(requisitionId: string): Promise<Outcome<ComparisonView>>;
  raiseOrder(input: { readonly requisitionId: string; readonly poId: string; readonly supplierId: string; readonly quoteId: string; readonly deliverTo: string; readonly comparison: ComparisonView }): Promise<Outcome<{ readonly order: { readonly poId: string; readonly status: string; readonly totalMinor: number } }>>;
}

export function createRequisitionsSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): RequisitionsSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && perms.has('purchase.commitment.read'), raise: named && perms.has('purchase.order.propose') };
  const http = input.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  const newKey = input.newKey ?? (() => `req-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Outcome<T>> {
    try {
      const res = await http(path, {
        method, credentials: 'same-origin',
        headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': newKey() } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) { const err = (json['error'] ?? {}) as { code?: string; whatHappened?: string }; return { result: 'refused', status: res.status, code: err.code ?? String(res.status), whatHappened: err.whatHappened ?? `status ${res.status}` }; }
      return { result: 'ok', value: json as T };
    } catch { return { result: 'lost_link' }; }
  }
  const gate = (need: 'read' | 'raise'): Outcome<never> | undefined =>
    !named ? { result: 'invalid', why: 'nobody' } : !may[need] ? { result: 'invalid', why: need === 'read' ? 'cannotRead' : 'cannotRaise' } : undefined;
  const id = (s: string): string => s.trim();
  return {
    may,
    list: async () => {
      const g = gate('read'); if (g !== undefined) return g;
      const out = await call<{ requisitions: RequisitionView[] }>('GET', '/v1/purchase/requisitions');
      return out.result === 'ok' ? { result: 'ok', value: out.value.requisitions } : out;
    },
    raise: async (requisitionId, lines) => {
      const g = gate('raise'); if (g !== undefined) return g;
      if (id(requisitionId) === '') return { result: 'invalid', why: 'needId' };
      const typed = lines.map((l) => ({ productId: l.productId.trim(), text: l.quantity.trim() }));
      // The cheap refusals first, before any request: a blank product, or an amount that is not a positive number at all.
      if (typed.length === 0 || typed.some((l) => l.productId === '' || !/^\d+(\.\d+)?$/.test(l.text) || !(Number(l.text) > 0))) return { result: 'invalid', why: 'needLine' };
      // OB-31 rule 1: what is typed is in the product's OWN unit ("10" kg); head office stores the smallest step (10000 g). The
      // unit is head office's (its product master), asked for once per product — never guessed on this screen. A product the
      // master does not hold (404), or whose unit it does not know, counts whole items — exactly as head office then values it.
      const units = new Map<string, string>();
      for (const productId of new Set(typed.map((l) => l.productId))) {
        const got = await call<{ product?: { baseUom?: string } }>('GET', `/v1/catalogue/products/${encodeURIComponent(productId)}`);
        if (got.result === 'refused' && got.status === 404) { units.set(productId, 'ea'); continue; }
        if (got.result !== 'ok') return got;
        units.set(productId, normaliseUom(got.value.product?.baseUom ?? '') ?? 'ea');
      }
      const parsed = typed.map((l) => ({ productId: l.productId, quantity: typedQuantityMinor(l.text, units.get(l.productId) ?? '') }));
      if (parsed.some((l) => l.quantity === undefined)) return { result: 'invalid', why: 'needLine' };
      const out = await call<{ requisition: RequisitionView }>('POST', `/v1/purchase/requisitions/${encodeURIComponent(id(requisitionId))}`, { currency: 'INR', lines: parsed });
      return out.result === 'ok' ? { result: 'ok', value: out.value.requisition } : out;
    },
    recordQuote: async (requisitionId, quoteId, supplierId, lines) => {
      const g = gate('raise'); if (g !== undefined) return g;
      if (id(requisitionId) === '' || id(quoteId) === '') return { result: 'invalid', why: 'needId' };
      if (id(supplierId) === '') return { result: 'invalid', why: 'needSupplier' };
      // A line left wholly blank is a line this supplier did not quote: it is left out, and head office's comparison names
      // the quote as not comparable in full. A line half-filled is a mistake, refused before sending.
      const parsed = lines.filter((l) => l.unitRupees.trim() !== '' || l.leadDays.trim() !== '')
        .map((l) => ({ productId: l.productId, minor: paiseFromRupees(l.unitRupees), lead: /^\d+$/.test(l.leadDays.trim()) ? Number(l.leadDays.trim()) : undefined }));
      if (parsed.length === 0 || parsed.some((l) => l.minor === undefined || l.lead === undefined)) return { result: 'invalid', why: 'needPrice' };
      return call('POST', `/v1/purchase/requisitions/${encodeURIComponent(id(requisitionId))}/quotes/${encodeURIComponent(id(quoteId))}`, {
        supplierId: id(supplierId), lines: parsed.map((l) => ({ productId: l.productId, unitCost: { minor: l.minor!, currency: 'INR' }, leadTimeDays: l.lead! })),
      });
    },
    comparison: async (requisitionId) => {
      const g = gate('read'); if (g !== undefined) return g;
      const out = await call<{ comparison: ComparisonView }>('GET', `/v1/purchase/requisitions/${encodeURIComponent(id(requisitionId))}/comparison`);
      return out.result === 'ok' ? { result: 'ok', value: out.value.comparison } : out;
    },
    raiseOrder: async (o) => {
      const g = gate('raise'); if (g !== undefined) return g;
      if (id(o.poId) === '') return { result: 'invalid', why: 'needId' };
      if (id(o.deliverTo) === '') return { result: 'invalid', why: 'needStore' };
      const lines = orderLinesFrom(o.comparison, o.quoteId);
      if (lines === undefined) return { result: 'invalid', why: 'notWholeQuote' };
      return call('POST', `/v1/purchase/orders/${encodeURIComponent(id(o.poId))}`, { supplierId: o.supplierId, deliverToLocationId: id(o.deliverTo), requisitionId: o.requisitionId, lines });
    },
  };
}
