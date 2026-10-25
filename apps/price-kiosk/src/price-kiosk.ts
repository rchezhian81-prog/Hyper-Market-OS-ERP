// The price kiosk (D14-FR-02 "handheld, payment terminal and price kiosk" · D04-FR-06 · R8-3 · P-01 · P-08).
//
// A customer scans an item and reads its price — from the store computer's SIGNED price list, with no network. It is
// READ-ONLY: it can sell nothing, post nothing and change nothing. And it ALWAYS says how old its price list is, because
// a kiosk quoting a price that has since moved is a promise the till will not keep (the engine's rule, `quotePrice`).
//
//   • The price is the till's own shelf price for that product (the same signed list the till charges from). Offers are
//     applied at the till, and the kiosk says so rather than guess which one applies.
//   • A weighed item's own scale label carries its price; a plain code of a weighed item shows the price per unit of
//     weight. A recalled or unsellable item is never quoted — "please ask a colleague".
//   • After how long the kiosk stops quoting is the OWNER's number: he decided 24 hours (OB-375, 25 Oct 2026), and head
//     office carries it in the store pack (`kioskStaleAfterMinutes`, 1 440). Past it the kiosk quotes nothing and says
//     "ask a colleague"; it shows the list's age on every answer. A pack that carries no number is "not set" — the kiosk
//     then quotes with the age, never an invented limit (P-08).

import { CatalogueCache, type CatalogueSnapshot } from '../../../packages/catalogue/src/catalogue';
import { quotePrice } from '../../../packages/self-checkout/src/self-checkout';

export interface Words { readonly en: string; readonly ta: string }

export interface KioskAnswer {
  readonly outcome: 'quoted' | 'not_found' | 'stale' | 'no_price' | 'not_sold_here' | 'no_list';
  readonly name?: string;
  readonly priceMinor?: number;
  /** "per kg" etc. for a plain code of a weighed item; absent for an each-item or a labelled weighed item. */
  readonly per?: string;
  readonly minutesSincePack: number | null;
  readonly words: Words;
  readonly age: Words;
}

const W = (en: string, ta: string): Words => ({ en, ta });
const rupees = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;
const WEIGHED = new Set(['kg', 'g', 'L', 'ml']);

export function ageWords(minutes: number | null): Words {
  if (minutes === null) return W('This kiosk has no price list from the store computer.', 'இந்தக் கியோஸ்கில் கடை கணினியின் விலைப் பட்டியல் இல்லை.');
  if (minutes < 60) return W(`Prices from a list updated ${minutes} minute(s) ago.`, `${minutes} நிமிடம் முன்பு புதுப்பிக்கப்பட்ட பட்டியலின் விலைகள்.`);
  const hours = Math.floor(minutes / 60);
  return W(`Prices from a list updated ${hours} hour(s) ago.`, `${hours} மணி நேரம் முன்பு புதுப்பிக்கப்பட்ட பட்டியலின் விலைகள்.`);
}

export interface PriceKiosk {
  lookup(code: string): KioskAnswer;
  /** How old the price list is now, in words — shown before anything is scanned too. */
  age(): Words;
  /** The owner's "stop quoting after" minutes, or "not set". */
  readonly staleAfter: number | null;
}

export function createPriceKiosk(input: { readonly catalogue?: CatalogueSnapshot; readonly staleAfterMinutes: number | null; readonly now: () => string }): PriceKiosk {
  const cache = input.catalogue === undefined ? undefined : new CatalogueCache(input.catalogue);
  return {
    staleAfter: input.staleAfterMinutes,
    age: () => ageWords(input.catalogue === undefined ? null : Math.max(0, Math.round((Date.parse(input.now()) - Date.parse(input.catalogue.builtAt)) / 60_000))),
    lookup(code) {
      if (cache === undefined || input.catalogue === undefined) {
        return { outcome: 'no_list', minutesSincePack: null, words: W('Prices cannot be checked here right now. Please ask a colleague.', 'இப்போது இங்கே விலையைச் சரிபார்க்க முடியாது. எங்கள் ஊழியரிடம் கேளுங்கள்.'), age: ageWords(null) };
      }
      const builtAt = input.catalogue.builtAt;
      const minutesSincePack = Math.max(0, Math.round((Date.parse(input.now()) - Date.parse(builtAt)) / 60_000));
      const age = ageWords(minutesSincePack);
      let hit: ReturnType<CatalogueCache['scan']>;
      try {
        hit = cache.scan(code.trim(), { asOf: input.now().slice(0, 10) });
      } catch (e) {
        const name = (e as { name?: string }).name;
        if (name === 'UnknownBarcodeError') return { outcome: 'not_found', minutesSincePack, age, words: W('That item is not in this shop\'s list. A colleague can check it.', 'அந்தப் பொருள் இந்தக் கடையின் பட்டியலில் இல்லை. எங்கள் ஊழியர் சரிபார்ப்பார்.') };
        return { outcome: 'not_sold_here', minutesSincePack, age, words: W('This item is not on sale here. Please ask a colleague.', 'இந்தப் பொருள் இங்கே விற்பனையில் இல்லை. எங்கள் ஊழியரிடம் கேளுங்கள்.') };
      }
      const labelPrice = hit.barcodeKind === 'price_embedded' ? hit.priceOverrideMinor : undefined;
      const unitPrice = hit.markdownPriceMinor ?? hit.product.unitPriceMinor;
      const weighedPlain = WEIGHED.has(hit.product.baseUom) && hit.barcodeKind !== 'weight_embedded' && hit.barcodeKind !== 'price_embedded';
      // A weight label carries the quantity in the unit's smallest part (grams of a kg, millilitres of a litre).
      const perUnit = hit.product.baseUom === 'kg' || hit.product.baseUom === 'L' ? 1000 : 1;
      const priceMinor = labelPrice ?? (hit.barcodeKind === 'weight_embedded' ? Math.round((unitPrice * hit.quantityMinor) / perUnit) : unitPrice);
      const q = quotePrice({
        productId: hit.product.productId,
        pack: [{ productId: hit.product.productId, name: hit.product.name, priceMinor }],
        packBuiltAt: builtAt, at: input.now(),
        // Not set → the kiosk keeps quoting and shows the age on every answer (P-08: no invented limit).
        staleAfterMinutes: input.staleAfterMinutes ?? Number.POSITIVE_INFINITY,
      });
      if (q.outcome === 'stale') {
        return { outcome: 'stale', name: hit.product.name, minutesSincePack, age, words: W('This kiosk\'s price list is too old to quote from. Please ask a colleague for the price.', 'இந்தக் கியோஸ்கின் விலைப் பட்டியல் மிகவும் பழையது. விலையை எங்கள் ஊழியரிடம் கேளுங்கள்.') };
      }
      if (q.outcome !== 'quoted' || q.priceMinor === undefined) {
        return { outcome: 'no_price', name: hit.product.name, minutesSincePack, age, words: W(`${hit.product.name}: no price is set. Please ask at the counter.`, `${hit.product.name}: விலை அமைக்கப்படவில்லை. கவுண்டரில் கேளுங்கள்.`) };
      }
      const per = weighedPlain ? `per ${hit.product.baseUom}` : undefined;
      return {
        outcome: 'quoted', name: hit.product.name, priceMinor: q.priceMinor, ...(per === undefined ? {} : { per }), minutesSincePack, age,
        words: W(`${hit.product.name}: ${rupees(q.priceMinor)}${per === undefined ? '' : ` ${per}`}. Offers are applied at the till.`, `${hit.product.name}: ${rupees(q.priceMinor)}${per === undefined ? '' : ` / ${hit.product.baseUom}`}. சலுகைகள் கட்டண மையத்தில் கணக்கிடப்படும்.`),
      };
    },
  };
}
