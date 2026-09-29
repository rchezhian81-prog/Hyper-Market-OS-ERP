// The checked extract files → an `ExtractBundle`. Pure: parsed rows in, a bundle (or the list of rows it
// could not read) out. The columns are the field list in docs/requirements/data-requirements.md Part B,
// written the way a person exporting from the old ERP can name them, and every conversion is stated:
//
//   money        rupees with paise ("123.45") → minor units (12345); never a guessed zero
//   quantity     in the unit of measure: each/pcs/unit ×1; kg or litre ×1000 (grams / millilitres); g, ml ×1
//   rate         percent ("5" or "5.0") → basis points (500)
//   yes/no       yes, y, true, 1 → true; anything else → false
//   allergens    "none" → an empty list (a positive declaration); an empty cell → nothing declared (refused for food)
//   lists        pipe-separated ("8901234|8901235")
//   barcode kind inferred from the code: 13 digits → ean (02 / 20–29 prefix → embedded, an in-store scale code),
//                12 → upc, 14 → gtin, 8 → ean, otherwise internal
//
// Files (all optional except products): categories.csv, tax-rates.csv, products.csv, suppliers.csv,
// customers.csv, opening-stock.csv. Column names are matched case-insensitively with spaces, dashes and
// underscores ignored, so "Item Code", "item_code" and "ITEMCODE" are the same column.

import type { BarcodeKind, ExtractBundle, ExtractCategory, ExtractCustomer, ExtractProduct, ExtractStockRow, ExtractSupplier, ExtractTaxRate } from './load';

export interface CsvRows {
  readonly headers: readonly string[];
  readonly rows: readonly Readonly<Record<string, string>>[];
  readonly lineNumbers?: readonly number[];
}

export interface ExtractFiles {
  readonly products: CsvRows;
  readonly categories?: CsvRows;
  readonly taxRates?: CsvRows;
  readonly suppliers?: CsvRows;
  readonly customers?: CsvRows;
  readonly openingStock?: CsvRows;
}

export interface MappedBundle {
  readonly bundle: ExtractBundle;
  /** Rows that could not be read, each named with its file and line — the operator fixes the file once. */
  readonly problems: readonly string[];
}

const norm = (h: string): string => h.toLowerCase().replace(/[\s_\-%()]/g, '');

/** Case/space-insensitive column lookup over one row. */
function cell(row: Readonly<Record<string, string>>, ...names: readonly string[]): string | undefined {
  const wanted = names.map(norm);
  for (const [k, v] of Object.entries(row)) {
    if (wanted.includes(norm(k))) {
      const t = v.trim();
      return t === '' ? undefined : t;
    }
  }
  return undefined;
}

/** Rupees-and-paise text → minor units; undefined when it is not a money amount. */
export function moneyToMinor(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const cleaned = text.replace(/[₹,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const negative = cleaned.startsWith('-');
  const [whole, frac = ''] = cleaned.replace('-', '').split('.');
  const minor = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return negative ? -minor : minor;
}

/** "5", "5.0", "12.5" → basis points. */
export function percentToBps(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const cleaned = text.replace(/[%\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const [whole, frac = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

/** A quantity in its unit of measure → minor units of that measure. */
export function quantityToMinor(text: string | undefined, uom: string): number | undefined {
  if (text === undefined) return undefined;
  const cleaned = text.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const u = uom.trim().toLowerCase();
  const perUnit = u === 'kg' || u === 'litre' || u === 'liter' || u === 'l' || u === 'ltr' ? 1000 : 1;
  const value = Number(cleaned) * perUnit;
  return Number.isInteger(value) ? value : undefined;
}

export function inferBarcodeKind(code: string): BarcodeKind {
  if (!/^\d+$/.test(code)) return 'internal';
  if (code.length === 13) return /^(02|2[0-9])/.test(code) ? 'embedded' : 'ean';
  if (code.length === 12) return 'upc';
  if (code.length === 14) return 'gtin';
  if (code.length === 8) return 'ean';
  return 'internal';
}

const yes = (text: string | undefined): boolean => text !== undefined && ['yes', 'y', 'true', '1'].includes(text.trim().toLowerCase());
const list = (text: string | undefined): readonly string[] => (text === undefined ? [] : text.split('|').map((s) => s.trim()).filter((s) => s !== ''));

function lifecycleOf(status: string | undefined): ExtractProduct['lifecycle'] {
  const s = (status ?? 'active').trim().toLowerCase();
  if (s === 'discontinued' || s === 'inactive' || s === 'clearance') return 'clearance';
  if (s === 'new') return 'new';
  return 'active';
}

export function bundleFromFiles(files: ExtractFiles): MappedBundle {
  const problems: string[] = [];
  const at = (file: string, rows: CsvRows, i: number): string => `${file} line ${rows.lineNumbers?.[i] ?? i + 2}`;

  const categories: ExtractCategory[] = [];
  files.categories?.rows.forEach((row, i) => {
    const categoryId = cell(row, 'category_id', 'category', 'department_code', 'code');
    const name = cell(row, 'name', 'description', 'category_name', 'department');
    if (categoryId === undefined || name === undefined) { problems.push(`${at('categories.csv', files.categories!, i)}: needs a category id and a name`); return; }
    const parentId = cell(row, 'parent_id', 'parent', 'parent_category') ?? null;
    const regulated = list(cell(row, 'regulated'));
    categories.push({ categoryId, name, parentId, ...(regulated.length === 0 ? {} : { regulated }) });
  });

  const taxRates: ExtractTaxRate[] = [];
  files.taxRates?.rows.forEach((row, i) => {
    const hsnCode = cell(row, 'hsn_code', 'hsn', 'tax_class');
    const effectiveFrom = cell(row, 'effective_from', 'from', 'date');
    const rateBps = percentToBps(cell(row, 'rate_percent', 'rate', 'gst_rate', 'tax_rate'));
    if (hsnCode === undefined || effectiveFrom === undefined || rateBps === undefined) { problems.push(`${at('tax-rates.csv', files.taxRates!, i)}: needs an HSN code, an effective date and a rate in percent`); return; }
    taxRates.push({ hsnCode, effectiveFrom, rateBps });
  });

  const products: ExtractProduct[] = [];
  files.products.rows.forEach((row, i) => {
    const where = at('products.csv', files.products, i);
    const productId = cell(row, 'item_code', 'product_id', 'code', 'item');
    const name = cell(row, 'description', 'name', 'item_name');
    const sku = cell(row, 'sku') ?? productId;
    const baseUom = cell(row, 'uom', 'unit', 'unit_of_measure') ?? 'each';
    const primaryCategoryId = cell(row, 'category_id', 'category', 'department');
    const taxClass = cell(row, 'hsn_code', 'hsn', 'tax_class');
    const mrpMinor = moneyToMinor(cell(row, 'mrp'));
    const priceMinor = moneyToMinor(cell(row, 'selling_price', 'price', 'sale_price'));
    const costMinor = moneyToMinor(cell(row, 'cost_price', 'cost', 'purchase_price'));
    const missing: string[] = [];
    if (productId === undefined) missing.push('item code');
    if (name === undefined) missing.push('description');
    if (primaryCategoryId === undefined) missing.push('category');
    if (taxClass === undefined) missing.push('HSN code');
    if (mrpMinor === undefined) missing.push('MRP');
    if (priceMinor === undefined) missing.push('selling price');
    if (costMinor === undefined) missing.push('cost price (say "we do not know" by leaving the row out and listing it as an exception — never a zero)');
    if (missing.length > 0) { problems.push(`${where}: missing or unreadable ${missing.join(', ')}`); return; }
    const barcodes = list(cell(row, 'barcodes', 'barcode', 'ean')).map((code) => ({ code, kind: inferBarcodeKind(code) }));
    // Allergens: the word "none" is a positive declaration (an empty list); an empty cell is silence, which
    // the engine refuses for a food item — the operator must write "none" to mean none.
    const allergenText = cell(row, 'allergens');
    const allergens = allergenText === undefined ? undefined : allergenText.trim().toLowerCase() === 'none' ? [] : list(allergenText);
    const ingredients = cell(row, 'ingredients');
    const countryOfOrigin = cell(row, 'country_of_origin', 'origin');
    const storageConditions = cell(row, 'storage_conditions', 'storage');
    const netQuantity = cell(row, 'net_quantity', 'pack_size');
    const packerDetails = cell(row, 'packer_details', 'packer', 'packed_by', 'importer');
    const minimumAgeText = cell(row, 'minimum_age', 'min_age');
    const minimumAge = minimumAgeText !== undefined && /^\d+$/.test(minimumAgeText) ? Number(minimumAgeText) : yes(cell(row, 'age_restricted')) ? 18 : undefined;
    const safety = {
      ...(ingredients === undefined ? {} : { ingredients }),
      ...(allergens === undefined ? {} : { allergens }),
      ...(countryOfOrigin === undefined ? {} : { countryOfOrigin }),
      ...(storageConditions === undefined ? {} : { storageConditions }),
      ...(netQuantity === undefined ? {} : { netQuantity }),
      ...(packerDetails === undefined ? {} : { packerDetails }),
      ...(minimumAge === undefined ? {} : { minimumAge }),
    };
    const brand = cell(row, 'brand', 'manufacturer');
    const marginFloor = percentToBps(cell(row, 'margin_floor_percent', 'margin_floor')) ?? 0;
    products.push({
      productId: productId!, sku: sku!, name: name!, baseUom, primaryCategoryId: primaryCategoryId!, taxClass: taxClass!,
      lifecycle: lifecycleOf(cell(row, 'status', 'active')),
      ...(brand === undefined ? {} : { brand }),
      ...(Object.keys(safety).length === 0 ? {} : { safety }),
      barcodes, priceMinor: priceMinor!, mrpMinor: mrpMinor!, costMinor: costMinor!, marginFloorBps: marginFloor,
    });
  });

  const suppliers: ExtractSupplier[] = [];
  files.suppliers?.rows.forEach((row, i) => {
    const partnerId = cell(row, 'supplier_code', 'code', 'partner_id', 'supplier_id');
    const name = cell(row, 'name', 'supplier_name', 'supplier');
    if (partnerId === undefined || name === undefined) { problems.push(`${at('suppliers.csv', files.suppliers!, i)}: needs a supplier code and a name`); return; }
    const gstin = cell(row, 'gstin');
    suppliers.push({ partnerId, name, ...(gstin === undefined ? {} : { gstin }) });
  });

  const customers: ExtractCustomer[] = [];
  files.customers?.rows.forEach((row, i) => {
    const customerId = cell(row, 'customer_code', 'code', 'customer_id', 'customer');
    if (customerId === undefined) { problems.push(`${at('customers.csv', files.customers!, i)}: needs a customer code`); return; }
    const pointsText = cell(row, 'loyalty_points', 'points', 'points_balance');
    const loyaltyPoints = pointsText === undefined ? undefined : (/^\d+$/.test(pointsText) ? Number(pointsText) : undefined);
    if (pointsText !== undefined && loyaltyPoints === undefined) { problems.push(`${at('customers.csv', files.customers!, i)}: loyalty points "${pointsText}" is not a whole number`); return; }
    customers.push({ customerId, ...(loyaltyPoints === undefined ? {} : { loyaltyPoints }) });
  });

  const openingStock: ExtractStockRow[] = [];
  files.openingStock?.rows.forEach((row, i) => {
    const where = at('opening-stock.csv', files.openingStock!, i);
    const productId = cell(row, 'item_code', 'product_id', 'code', 'item');
    const uom = cell(row, 'uom', 'unit') ?? products.find((p) => p.productId === productId)?.baseUom ?? 'each';
    const quantityMinor = quantityToMinor(cell(row, 'quantity', 'qty', 'quantity_on_hand', 'on_hand'), uom);
    const unitCostMinor = moneyToMinor(cell(row, 'cost_price', 'cost', 'unit_cost'));
    if (productId === undefined || quantityMinor === undefined || unitCostMinor === undefined) {
      problems.push(`${where}: needs an item code, a quantity in its unit of measure and a unit cost (a cost you do not know is an exception, never a zero)`);
      return;
    }
    const batchId = cell(row, 'batch', 'batch_id', 'lot');
    const expiry = cell(row, 'expiry', 'expiry_date', 'use_by');
    openingStock.push({ productId, quantityMinor, uom, unitCostMinor, ...(batchId === undefined ? {} : { batchId }), ...(expiry === undefined ? {} : { expiry }) });
  });

  return { bundle: { categories, taxRates, products, suppliers, customers, openingStock }, problems };
}
