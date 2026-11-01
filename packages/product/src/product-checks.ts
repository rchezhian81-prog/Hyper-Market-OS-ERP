// The three product-master check reports (OB-625, owner, 1 Nov 2026, in writing: "build them in wave 2, read-only, before
// the pilot" · roadmap M03 reporting lines · M03-FR-02/03 · D01-FR-01/04).
//
//   1. NO TAX MAPPING — a product with no HSN code, or whose HSN code has no GST rate in force on the shop's day. The
//      publish rule refuses a product with no HSN, but a rate schedule can still be missing for the code it carries (a code
//      typed before Finance recorded its rate), and a bill for it would have no GST rate to apply.
//   2. ALLERGEN AND INGREDIENT DETAILS MISSING WHERE THE CATEGORY NEEDS THEM — the category, not this file, says what is
//      needed: a category the tenant declared `food` needs an allergen declaration (an empty list is "declared: none" and
//      passes; silence does not — the same rule `validateProduct` applies); a category declared both `food` and `packed`
//      needs an ingredient list (FSS labelling of pre-packaged food). A product whose category is not on head office's list
//      cannot be judged, and is named as such — never counted as fine.
//   3. NO BARCODE — no code at any pack level in head office's barcode register (the tested `barcodeCoverageGaps`). A
//      product sold by weight is marked, because the till rings it from a scale label rather than its own barcode.
//
// Read-only and deterministic: the same master yields the same rows in the same order. The products checked are the ones
// that can be sold (`SELLABLE_LIFECYCLE`) — a draft is expected to be unfinished and a discontinued line is not sold — and
// the report says how many it checked, so a nought reads as "checked N, none found", never as "not looked".

import { SELLABLE_LIFECYCLE, type Category, type ProductRecord } from './product';
import { BarcodeRegistry, barcodeCoverageGaps, type BarcodeAssignment } from './pack';

export type ProductCheckReport = 'tax' | 'allergens' | 'barcode';

/** Why a product is on a report — a code the page turns into words, English and Tamil. */
export type ProductCheckReason =
  | 'no_hsn_code'
  | 'no_gst_rate_today'
  | 'gst_rate_not_read'
  | 'no_allergen_declaration'
  | 'no_ingredient_list'
  | 'category_not_on_the_list'
  | 'no_barcode';

export interface ProductCheckRow {
  readonly report: ProductCheckReport;
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly hsnCode: string | null;
  readonly reasons: readonly ProductCheckReason[];
  /** Report 3 only: sold by weight, so the till rings it from a scale label. */
  readonly soldByWeight?: boolean;
}

export interface ProductChecks {
  /** How many products were checked (the sellable ones), and of how many on the master. */
  readonly checked: number;
  readonly onMaster: number;
  readonly rows: readonly ProductCheckRow[];
  readonly counts: Readonly<Record<ProductCheckReport, number>>;
  /** Report 2: products whose category is not on the list, so what they need cannot be said. Also listed as rows. */
  readonly notJudged: number;
}

const WEIGHED_UOM = new Set(['kg', 'g', 'gm', 'l', 'ltr', 'ml']);

/** The GST rate in force on `day` from a schedule: undefined when the schedule has none on or before it. */
function rateOn(schedule: readonly { readonly effectiveFrom: string; readonly rateBps: number }[], day: string): number | undefined {
  let best: { effectiveFrom: string; rateBps: number } | undefined;
  for (const p of schedule) if (p.effectiveFrom <= day && (best === undefined || p.effectiveFrom >= best.effectiveFrom)) best = p;
  return best?.rateBps;
}

export function productChecks(input: {
  readonly products: readonly ProductRecord[];
  readonly categories: readonly Category[];
  readonly barcodes: readonly BarcodeAssignment[];
  /** Each HSN code's GST rate schedule as head office holds it; `null` when it could not be read. */
  readonly gstSchedules: ReadonlyMap<string, readonly { readonly effectiveFrom: string; readonly rateBps: number }[] | null>;
  /** The shop's day (YYYY-MM-DD) the rate in force is judged on. */
  readonly onDay: string;
}): ProductChecks {
  const sellable = new Set(SELLABLE_LIFECYCLE);
  const products = [...input.products].filter((p) => sellable.has(p.lifecycle)).sort((a, b) => a.productId.localeCompare(b.productId));
  const categoryOf = new Map(input.categories.map((c) => [c.categoryId, c] as const));
  const registry = new BarcodeRegistry();
  for (const a of input.barcodes) { try { registry.register(a); } catch { /* a code held twice is the registry's own refusal; one owner is enough here */ } }
  const noBarcode = new Set(barcodeCoverageGaps(products.map((p) => p.productId), registry));

  const rows: ProductCheckRow[] = [];
  let notJudged = 0;
  for (const p of products) {
    const category = p.primaryCategoryId === null ? undefined : categoryOf.get(p.primaryCategoryId);
    const hsn = p.taxClass === null || p.taxClass.trim() === '' ? null : p.taxClass.trim();
    const base = { productId: p.productId, sku: p.sku, name: p.name, categoryId: p.primaryCategoryId, categoryName: category?.name ?? null, hsnCode: hsn };

    // 1 — tax mapping
    if (hsn === null) rows.push({ ...base, report: 'tax', reasons: ['no_hsn_code'] });
    else {
      const schedule = input.gstSchedules.get(hsn);
      if (schedule === null || schedule === undefined) rows.push({ ...base, report: 'tax', reasons: ['gst_rate_not_read'] });
      else if (rateOn(schedule, input.onDay) === undefined) rows.push({ ...base, report: 'tax', reasons: ['no_gst_rate_today'] });
    }

    // 2 — allergens and ingredients, as the category asks
    if (category === undefined) {
      notJudged += 1;
      rows.push({ ...base, report: 'allergens', reasons: ['category_not_on_the_list'] });
    } else {
      const regulated = category.regulated ?? [];
      const reasons: ProductCheckReason[] = [];
      if (regulated.includes('food') && p.safety?.allergens === undefined) reasons.push('no_allergen_declaration');
      if (regulated.includes('food') && regulated.includes('packed') && (p.safety?.ingredients ?? '').trim() === '') reasons.push('no_ingredient_list');
      if (reasons.length > 0) rows.push({ ...base, report: 'allergens', reasons });
    }

    // 3 — barcode
    if (noBarcode.has(p.productId)) {
      const weighed = WEIGHED_UOM.has(p.baseUom.trim().toLowerCase()) || (category?.regulated ?? []).includes('weighed');
      rows.push({ ...base, report: 'barcode', reasons: ['no_barcode'], soldByWeight: weighed });
    }
  }
  const count = (r: ProductCheckReport) => rows.filter((x) => x.report === r).length;
  return { checked: products.length, onMaster: input.products.length, rows, counts: { tax: count('tax'), allergens: count('allergens'), barcode: count('barcode') }, notJudged };
}
