// The till's PRICE CHECK (batch 20a · T2 · M12-FR-01 "price enquiry" · P-01 · P-08).
//
// A customer holds up a pack and asks "how much is this?". Until now the cashier's only way to find out was Find, which
// puts the item ON THE BILL — then it had to be voided. A price check answers the question and touches nothing:
//
//   • it reads THIS till's own signed price list (the one the till charges from), so it works with the cable out — no
//     network call of any kind, ever;
//   • it shows the shelf price (a scale label's own price; a weighed item's price per kg or litre), the MRP when the list
//     carries one, a batch markdown when the scanned code carries one, and every offer IN FORCE on this till now that
//     names the item — in words the cashier can read out;
//   • it never adds a line, never changes the bill, never starts a sale, and writes nothing anywhere;
//   • an unknown code, an item that may not be sold (recalled, stopped) or a till with no price list each says so plainly.
//
// Pure: the caller hands it the catalogue, the offers in force and the instant. Offers are only DESCRIBED here; what a
// bill actually takes off is decided by the promotions engine at checkout, as for every other line.

import { CatalogueCache, type CatalogueProduct, type ScanResult } from '../../../packages/catalogue/src/catalogue';
import { promotionProductIds, type Promotion } from '../../../packages/promotions/src/promotions';
import { wallClockIn } from '../../../packages/calendar/src/trading-day';

export interface Words { readonly en: string; readonly ta: string }

export interface PriceCheckOffer {
  readonly offerId: string;
  readonly words: Words;
}

export interface PriceCheckAnswer {
  readonly outcome: 'priced' | 'not_found' | 'not_sold_here' | 'no_list';
  readonly productId?: string;
  readonly name?: string;
  /** The price the till would charge for what was scanned (a label's price, a weighed label's amount, else one unit). */
  readonly priceMinor?: number;
  /** "kg" / "L" when the price is per unit of weight or volume (a plain code of a weighed item). */
  readonly per?: string;
  readonly mrpMinor?: number;
  /** The scanned batch is under an approved markdown — `priceMinor` is that price. */
  readonly markdown?: boolean;
  readonly offers: readonly PriceCheckOffer[];
  /** The whole answer in the cashier's words, both languages — nothing was added to the bill. */
  readonly words: Words;
}

const W = (en: string, ta: string): Words => ({ en, ta });
const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const WEIGHED = new Set(['kg', 'g', 'L', 'l', 'ml']);
const NOT_ADDED = W('Nothing was added to the bill.', 'பில்லில் எதுவும் சேர்க்கப்படவில்லை.');

/** Is the offer published and within its window at `at` (the same test the promotions engine applies, §31)? */
function inWindow(p: Promotion, at: string): boolean {
  if (p.status !== 'active') return false;
  const t = Date.parse(at); const start = Date.parse(p.startsAt); const end = Date.parse(p.endsAt);
  return !Number.isNaN(t) && !Number.isNaN(start) && !Number.isNaN(end) && t >= start && t <= end;
}

/** One offer in plain words, both languages — what it is, who it is for and until when. Undefined: a kind never applied here. */
export function offerWords(p: Promotion, nameOf: (productId: string) => string, timeZone?: string): Words | undefined {
  let en: string; let ta: string;
  switch (p.kind) {
    case 'percent_off': {
      const pct = (p.percentBps ?? 0) / 100;
      en = `${pct}% off`; ta = `${pct}% தள்ளுபடி`;
      if (p.minSpendMinor !== undefined && p.minSpendMinor > 0) { en += ` on ${rupees(p.minSpendMinor)} or more`; ta += ` (${rupees(p.minSpendMinor)} அல்லது அதற்கு மேல் வாங்கினால்)`; }
      break;
    }
    case 'amount_off':
      en = `${rupees(p.amountOffMinor ?? 0)} off`; ta = `${rupees(p.amountOffMinor ?? 0)} தள்ளுபடி`;
      if (p.minSpendMinor !== undefined && p.minSpendMinor > 0) { en += ` on ${rupees(p.minSpendMinor)} or more`; ta += ` (${rupees(p.minSpendMinor)} அல்லது அதற்கு மேல் வாங்கினால்)`; }
      break;
    case 'buy_x_get_y':
      en = `Buy ${p.buyQty ?? 0}, get ${p.getQty ?? 0} free`; ta = `${p.buyQty ?? 0} வாங்கினால் ${p.getQty ?? 0} இலவசம்`;
      break;
    case 'member_price':
      en = `Members pay ${rupees(p.memberUnitPrice?.minor ?? 0)}`; ta = `உறுப்பினர்களுக்கு ${rupees(p.memberUnitPrice?.minor ?? 0)}`;
      break;
    case 'multibuy':
      en = `${p.multibuyQty ?? 0} for ${rupees(p.multibuyPriceMinor ?? 0)}`; ta = `${p.multibuyQty ?? 0} எண்ணிக்கை ${rupees(p.multibuyPriceMinor ?? 0)}`;
      break;
    case 'bundle_price': {
      const set = (p.bundleItems ?? []).map((i) => `${i.qty} × ${nameOf(i.productId)}`).join(' + ');
      en = `Set price ${rupees(p.bundlePriceMinor ?? 0)} for ${set}`; ta = `தொகுப்பு விலை ${rupees(p.bundlePriceMinor ?? 0)}: ${set}`;
      break;
    }
    case 'mix_match': {
      const pct = (p.getPercentBps ?? 0) / 100;
      const off = pct >= 100 ? W('free', 'இலவசம்') : W(`${pct}% off`, `${pct}% தள்ளுபடி`);
      en = `Buy ${p.buyQty ?? 0} of the offer items, get ${p.getQty ?? 0} ${off.en}`; ta = `சலுகைப் பொருட்களில் ${p.buyQty ?? 0} வாங்கினால் ${p.getQty ?? 0} ${off.ta}`;
      break;
    }
    default:
      return undefined; // a bank-card offer never applies at this till (OB-305) — not offered as if it did
  }
  if (p.requiresMember === true && p.kind !== 'member_price') { en += ' (loyalty members)'; ta += ' (உறுப்பினர்களுக்கு)'; }
  if (p.requiresCoupon !== undefined) { en += ` (with coupon ${p.requiresCoupon})`; ta += ` (கூப்பன் ${p.requiresCoupon} உடன்)`; }
  // The last day on the SHOP's clock (its zone), never the UTC date of the end.
  const until = Number.isNaN(Date.parse(p.endsAt)) ? p.endsAt : wallClockIn(p.endsAt, timeZone).slice(0, 10);
  return W(`${en} — until ${until}`, `${ta} — ${until} வரை`);
}

/**
 * Answer a price check for a scanned or keyed code. Never adds to the bill; reads only the till's own price list.
 * `byIdOrSku` lets a row picked from Find be checked by its product id or SKU when it has no barcode.
 */
export function priceCheck(input: {
  readonly catalogue: CatalogueCache | undefined;
  readonly code: string;
  /** Today at this till (YYYY-MM-DD) — a 2D code's use-by date is judged against it, as at the sale. */
  readonly asOf?: string;
  /** The instant offers are judged at — this till's clock. */
  readonly at: string;
  /** The offers this till applies now (loaded, not refused, not held back by a clock hold). */
  readonly offers: readonly Promotion[];
  /** True when no offer may reach this product (a carry bag, OB-173; tobacco, COTPA s.5). */
  readonly noOffersFor?: (productId: string) => boolean;
  /** The shop's zone, for the offer's last day; absent = this till's own wall clock (it stands in the shop). */
  readonly timeZone?: string;
}): PriceCheckAnswer {
  if (input.catalogue === undefined) {
    return { outcome: 'no_list', offers: [], words: W('This till has no price list from the store computer, so a price cannot be checked. Tell the manager.', 'இந்த டில்லில் கடை கணினியின் விலைப் பட்டியல் இல்லை, எனவே விலையைச் சரிபார்க்க முடியாது. மேலாளரிடம் சொல்லவும்.') };
  }
  const cache = input.catalogue;
  const code = input.code.trim();
  let hit: ScanResult | undefined;
  let product: CatalogueProduct | undefined;
  try {
    hit = cache.scan(code, input.asOf === undefined ? undefined : { asOf: input.asOf });
    product = hit.product;
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name !== 'UnknownBarcodeError') {
      return { outcome: 'not_sold_here', offers: [], words: W(`This item may not be sold now (${(e as Error).message}). ${NOT_ADDED.en}`, `இந்தப் பொருளை இப்போது விற்க முடியாது. ${NOT_ADDED.ta}`) };
    }
    // A row picked from Find with no barcode comes back as its SKU or id.
    const byId = cache.findBySku(code) ?? cache.findByProductId(code);
    if (byId === undefined) {
      return { outcome: 'not_found', offers: [], words: W(`${code} is not in this till's price list. ${NOT_ADDED.en}`, `${code} இந்த டில்லின் விலைப் பட்டியலில் இல்லை. ${NOT_ADDED.ta}`) };
    }
    if (byId.status !== 'active' || byId.recallBlock === true) {
      return { outcome: 'not_sold_here', productId: byId.productId, name: byId.name, offers: [], words: W(`${byId.name} may not be sold now. ${NOT_ADDED.en}`, `${byId.name} இப்போது விற்க முடியாது. ${NOT_ADDED.ta}`) };
    }
    product = byId;
  }
  const uom = product.baseUom;
  const measured = WEIGHED.has(uom);
  const labelPrice = hit?.barcodeKind === 'price_embedded' ? hit.priceOverrideMinor : undefined;
  const unitPrice = hit?.markdownPriceMinor ?? product.unitPriceMinor;
  const perUnit = uom === 'kg' || uom === 'L' || uom === 'l' ? 1000 : 1;
  const priceMinor = labelPrice ?? (hit?.barcodeKind === 'weight_embedded' ? Math.round((unitPrice * hit.quantityMinor) / perUnit) : unitPrice);
  const per = measured && hit?.barcodeKind !== 'weight_embedded' && hit?.barcodeKind !== 'price_embedded' ? uom : undefined;
  const nameOf = (id: string): string => cache.findByProductId(id)?.name ?? id;
  const offers: PriceCheckOffer[] = input.noOffersFor?.(product.productId) === true ? [] : input.offers
    .filter((p) => inWindow(p, input.at) && promotionProductIds(p).includes(product.productId))
    .flatMap((p) => { const w = offerWords(p, nameOf, input.timeZone); return w === undefined ? [] : [{ offerId: p.id, words: w }]; });
  const price = `${rupees(priceMinor)}${per === undefined ? '' : ` / ${per}`}`;
  const mrp = product.mrpMinor === undefined ? W('', '') : W(` MRP ${rupees(product.mrpMinor)}.`, ` MRP ${rupees(product.mrpMinor)}.`);
  const md = hit?.markdownPriceMinor === undefined ? W('', '') : W(' (reduced — this batch is marked down)', ' (குறைக்கப்பட்டது — இந்த பேட்ச் விலை குறைப்பில்)');
  const offerLine = offers.length === 0 ? W(' No offer on this item now.', ' இப்போது இந்தப் பொருளுக்குச் சலுகை இல்லை.')
    : W(` Offer: ${offers.map((o) => o.words.en).join('; ')}.`, ` சலுகை: ${offers.map((o) => o.words.ta).join('; ')}.`);
  return {
    outcome: 'priced', productId: product.productId, name: product.name, priceMinor, ...(per === undefined ? {} : { per }),
    ...(product.mrpMinor === undefined ? {} : { mrpMinor: product.mrpMinor }), ...(hit?.markdownPriceMinor === undefined ? {} : { markdown: true }),
    offers,
    words: W(
      `${product.name}: ${price}${md.en}.${mrp.en}${offerLine.en} ${NOT_ADDED.en}`,
      `${product.name}: ${price}${md.ta}.${mrp.ta}${offerLine.ta} ${NOT_ADDED.ta}`,
    ),
  };
}
