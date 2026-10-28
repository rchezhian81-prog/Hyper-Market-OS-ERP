// Shelf tags — the price ticket on the shelf edge (roadmap addendum B3 · OB-505 · Legal Metrology · P-02 · P-08).
//
// A shelf tag tells the shopper four things: what the item is, what the till will charge, the MRP printed on the pack, and
// the price PER STANDARD UNIT (₹ per kg, ₹ per litre, ₹ per piece — the tested `unitSalePrice`), so a 480 g pack can be
// compared with a 500 g one without arithmetic. It is printed from an office screen in English, Tamil or both.
//
// What makes a tag lawful, and refused when it is not (nothing is printed rather than a wrong tag — P-08):
//   • THE PRICE IS THE TILL'S — the selling price comes from the signed pack the tills charge from (P-02); a tag can never
//     show a price the till would not charge;
//   • NEVER ABOVE THE MRP — a selling price above the pack's MRP is refused (an illegal overcharge), and a packaged (counted)
//     item with no MRP on record is refused rather than printed without one; a loose item sold by weight carries none;
//   • THE UNIT PRICE IS WORKED OUT, NEVER LEFT OFF — from the product's declared net quantity ("500 g", "1 L", "6 pieces")
//     for a packed item, or the price itself for an item sold per kg / per litre; a net quantity the price cannot be divided
//     by refuses the tag and says how to write it;
//   • THE CHARACTERS ARE TALL ENOUGH — the tag stock's area sets the Legal Metrology Rule 9 minimum height (the tested
//     `validateLabelHeight`, the same template approach the counter label uses — `packages/production/src/packing.ts`);
//     a template printing letters or numerals below it is refused. The screen prints at the template's own heights.
//
// Pure and deterministic: integer money throughout; no clock, no I/O.

import { validateLabelHeight, InvalidLabelHeightInput, type LabelHeightCheck } from './label-height';
import { unitSalePrice, InvalidUnitPriceInput, type UnitSalePrice } from './unit-price';
import { readNetQuantity } from '../../production/src/packing';

/** The tag stock and the character heights it prints at (mm). Area = width × height (the principal display panel). */
export interface ShelfTagTemplate {
  readonly templateId: string;
  readonly widthMm: number;
  readonly heightMm: number;
  /** The smallest letter height any word on the tag is printed at (name, MRP words, unit words). */
  readonly letterHeightMm: number;
  /** The smallest numeral height any figure is printed at (MRP, unit price). */
  readonly numeralHeightMm: number;
  /** The selling price's numeral height — the largest thing on the tag. */
  readonly priceHeightMm: number;
}

/** The tag stocks the screen offers: a standard 70 × 38 mm shelf-edge ticket and a large 100 × 60 mm one. */
export const SHELF_TAG_TEMPLATES: readonly ShelfTagTemplate[] = Object.freeze([
  Object.freeze({ templateId: 'shelf-70x38', widthMm: 70, heightMm: 38, letterHeightMm: 2.5, numeralHeightMm: 2.5, priceHeightMm: 8 }),
  Object.freeze({ templateId: 'shelf-100x60', widthMm: 100, heightMm: 60, letterHeightMm: 4, numeralHeightMm: 4, priceHeightMm: 14 }),
]);

/**
 * The CSS font size (mm) that prints a character at least `heightMm` tall. A typeface's capital and numeral height is about
 * seven tenths of its font size (Latin and Tamil sans faces alike), so the font size is the height ÷ 0.7, rounded UP to a
 * tenth of a millimetre — the printed character is never shorter than the height the tag was judged at.
 */
export const CAP_HEIGHT_OF_FONT = 0.7;
export function fontSizeMmFor(heightMm: number): number {
  return Math.ceil((heightMm / CAP_HEIGHT_OF_FONT) * 10) / 10;
}

export type TagLanguage = 'en' | 'ta' | 'both';

/** One product as the tag reads it: the pack's price and MRP, and the product master's net quantity and Tamil name. */
export interface ShelfTagProduct {
  readonly productId: string;
  readonly sku?: string;
  readonly barcode?: string;
  readonly name: string;
  readonly nameTa?: string;
  /** The selling price per base unit, from the signed pack (what the till charges). */
  readonly sellingPriceMinor: number;
  readonly mrpMinor?: number;
  /** The pack's base unit: 'ea' for a counted item, 'kg' / 'l' (or 'g' / 'ml') for one sold by measure. */
  readonly baseUom: string;
  /** The net quantity as declared on the product master ("500 g", "1 L", "6 pieces"). */
  readonly netQuantity?: string;
}

export interface ShelfTag {
  readonly productId: string;
  readonly sku?: string;
  readonly barcode?: string;
  readonly nameEn: string;
  /** The Tamil name — absent when the product master has none (then `notes` says so). */
  readonly nameTa?: string;
  readonly language: TagLanguage;
  readonly sellingPriceMinor: number;
  /** The MRP, or absent for a loose item sold by measure (`loose` true). */
  readonly mrpMinor?: number;
  readonly loose: boolean;
  /** MRP − selling price, when the item sells below its MRP. */
  readonly savingMinor?: number;
  readonly netQuantity?: string;
  readonly unitPrice: { readonly unitPriceMinor: number; readonly per: UnitSalePrice['per']; readonly exempt: boolean };
  readonly template: ShelfTagTemplate;
  readonly heights: { readonly letters: LabelHeightCheck; readonly numerals: LabelHeightCheck; readonly price: LabelHeightCheck };
  /** Font sizes (mm) that print each part at least as tall as it was judged at. */
  readonly fontMm: { readonly letters: number; readonly numerals: number; readonly price: number };
  /** Things the person printing should know (e.g. no Tamil name on record) — said, never hidden. */
  readonly notes: readonly string[];
}

export type ShelfTagRefusal =
  | 'no_name' | 'no_price' | 'above_mrp' | 'no_mrp' | 'no_net_quantity' | 'unknown_unit' | 'too_small' | 'template_invalid';

export type ShelfTagResult =
  | { readonly ok: true; readonly tag: ShelfTag }
  | { readonly ok: false; readonly productId: string; readonly refusal: ShelfTagRefusal; readonly detail: string };

const rupees = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;
const MEASURED: Readonly<Record<string, { readonly per: UnitSalePrice['per']; readonly factor: number }>> = Object.freeze({
  kg: { per: 'kg', factor: 1 }, g: { per: 'kg', factor: 1000 }, l: { per: 'l', factor: 1 }, ml: { per: 'l', factor: 1000 },
});

/** Build one shelf tag, or say exactly why it cannot print. */
export function buildShelfTag(product: ShelfTagProduct, template: ShelfTagTemplate, language: TagLanguage): ShelfTagResult {
  const refuse = (refusal: ShelfTagRefusal, detail: string): ShelfTagResult => ({ ok: false, productId: product.productId, refusal, detail });
  const name = product.name.trim();
  if (name === '') return refuse('no_name', 'the product has no name on record');
  const price = product.sellingPriceMinor;
  if (!Number.isInteger(price) || price <= 0) return refuse('no_price', 'the price pack holds no selling price above zero for it');

  // Character heights (B24 / Rule 9) for the tag stock — every part judged, the smallest refusing the whole tag.
  let heights: ShelfTag['heights'];
  const area = Math.round(template.widthMm * template.heightMm) / 100; // mm² → cm²
  try {
    heights = {
      letters: validateLabelHeight({ principalPanelAreaCm2: area, declaredHeightMm: template.letterHeightMm }),
      numerals: validateLabelHeight({ principalPanelAreaCm2: area, declaredHeightMm: template.numeralHeightMm }),
      price: validateLabelHeight({ principalPanelAreaCm2: area, declaredHeightMm: template.priceHeightMm }),
    };
  } catch (e) {
    if (e instanceof InvalidLabelHeightInput) return refuse('template_invalid', `tag stock ${template.templateId}: ${e.message}`);
    throw e;
  }
  const small = (['letters', 'numerals', 'price'] as const).filter((k) => !heights[k].valid);
  if (small.length > 0) return refuse('too_small', `tag stock ${template.templateId}: ${small.map((k) => `${k} ${heights[k].detail}`).join('; ')}`);

  // The unit sale price (B3): per kg / litre for an item sold by measure; from the declared net quantity for a counted one.
  const uom = product.baseUom.trim().toLowerCase();
  const measured = MEASURED[uom];
  let unitPrice: ShelfTag['unitPrice'];
  if (measured !== undefined) {
    // Sold by measure: the pack's price is per base unit already — per kg / litre (per g / ml × 1000).
    unitPrice = { unitPriceMinor: price * measured.factor, per: measured.per, exempt: false };
  } else if (uom === 'ea' || uom === 'each' || uom === 'pc' || uom === 'piece') {
    const net = readNetQuantity(product.netQuantity ?? '');
    if (net === undefined) {
      return refuse('no_net_quantity', product.netQuantity === undefined || product.netQuantity.trim() === ''
        ? 'the product master has no net quantity, so the price per kg / litre / piece cannot be worked out — write it on the product (like 500 g, 1 L or 6 pieces)'
        : `its net quantity reads "${product.netQuantity}", which the price cannot be divided by — write it like 500 g, 1.5 kg, 500 ml, 1 L or 6 pieces`);
    }
    try {
      const u = unitSalePrice({ mrpMinor: price, netQuantity: net.netQuantity, unit: net.unit });
      unitPrice = { unitPriceMinor: u.unitPriceMinor, per: u.per, exempt: u.exempt };
    } catch (e) {
      if (e instanceof InvalidUnitPriceInput) return refuse('no_net_quantity', e.message);
      throw e;
    }
  } else {
    return refuse('unknown_unit', `it is sold by "${product.baseUom}", a unit a shelf tag cannot work a price per kg, litre or piece from`);
  }

  // MRP: never below the selling price; required for a counted (packaged) item; a loose item sold by measure has none.
  const loose = measured !== undefined;
  const mrp = product.mrpMinor;
  if (mrp !== undefined && (!Number.isInteger(mrp) || mrp <= 0)) return refuse('no_mrp', 'the MRP on record is not a whole amount above zero');
  if (mrp === undefined && !loose) return refuse('no_mrp', 'no MRP is on record for this packaged item — a shelf tag shows the MRP; publish it on the product first');
  if (mrp !== undefined && price > mrp) return refuse('above_mrp', `the selling price ${rupees(price)} is above the MRP ${rupees(mrp)} — that is an illegal overcharge; correct the price before any tag is printed`);

  const nameTa = product.nameTa?.trim() === '' ? undefined : product.nameTa?.trim();
  const notes: string[] = [];
  if (language !== 'en' && nameTa === undefined) notes.push('no Tamil name on the product master — the tag prints the English name; add it on App content');
  return {
    ok: true,
    tag: {
      productId: product.productId,
      ...(product.sku === undefined ? {} : { sku: product.sku }),
      ...(product.barcode === undefined ? {} : { barcode: product.barcode }),
      nameEn: name,
      ...(nameTa === undefined ? {} : { nameTa }),
      language,
      sellingPriceMinor: price,
      ...(mrp === undefined ? {} : { mrpMinor: mrp }),
      loose,
      ...(mrp !== undefined && mrp > price ? { savingMinor: mrp - price } : {}),
      ...(product.netQuantity === undefined || product.netQuantity.trim() === '' ? {} : { netQuantity: product.netQuantity.trim() }),
      unitPrice,
      template,
      heights,
      fontMm: { letters: fontSizeMmFor(template.letterHeightMm), numerals: fontSizeMmFor(template.numeralHeightMm), price: fontSizeMmFor(template.priceHeightMm) },
      notes,
    },
  };
}
