// MG-05 / MG-04 / §34.1 — the FIRST real-data load as the owner decided it (OB-241, D3 option B): ONE pilot
// department's products, barcodes, tax classes and prices (B1 plus OC-21), from four CSV files that follow a
// published template, with PER-ROW exceptions instead of a whole-file refusal.
//
// The bulk loader (`load.ts`) refuses the whole extract on the first malformed row — right for a full rehearsal,
// wrong for a department slice that a person fills in by hand from the old ERP's export: one mistyped MRP would
// stop four hundred good products. Here every row is judged on its own:
//
//   • a GOOD row is STAGED — it is in the bundle the loader will send, unchanged by any default;
//   • a BAD row is QUARANTINED — it becomes one line of the exception list with its file, line, the source key
//     (the old ERP's item code / HSN / barcode), the column and the reason, in plain words (§34.1 "reject/
//     quarantine file with source key, reason, … owner, disposition and approval");
//   • a row that DEPENDS on a quarantined row is quarantined too, and says so (a barcode for an item that did not
//     stage, a product whose tax class did not stage) — never sent half-formed.
//
// Nothing here applies anything. `sliceApplyGate` is the one door: it opens only when a NAMED person has accepted
// THIS exception list (bound by the slice digest — change one byte of a file and the acceptance no longer
// matches). Silence, a blank name or an acceptance over a different list keeps it shut — "never apply a partial
// load silently".
//
// Pure and deterministic: no I/O, no clock. The digest uses an injected hasher (the CLI passes SHA-256).

import { cell, moneyToMinor, percentToBps, inferBarcodeKind, list } from './load-csv';
import { validateBundle, type BarcodeKind, type ExtractBundle, type ExtractProduct, type ExtractTaxRate } from './load';
import { validateProduct, CategoryNotFoundError, type Category, type ProductRecord, type RegulatedKind } from '../../product/src/product';
import { simpleHasher, type Hasher } from './discovery';

// ── The templates ────────────────────────────────────────────────────────────────────────────────────

export type SliceFile = 'products.csv' | 'barcodes.csv' | 'tax-classes.csv' | 'prices.csv';
export const SLICE_FILES: readonly SliceFile[] = Object.freeze(['tax-classes.csv', 'products.csv', 'prices.csv', 'barcodes.csv']);

export interface SliceTemplate {
  readonly file: SliceFile;
  /** Exactly the header line the file must start with (spelling and order as published). */
  readonly columns: readonly string[];
  /** The columns a row cannot do without. */
  readonly required: readonly string[];
  /** What each column means, for the runbook and the template's own help. */
  readonly help: Readonly<Record<string, string>>;
}

export const SLICE_TEMPLATES: Readonly<Record<SliceFile, SliceTemplate>> = Object.freeze({
  'tax-classes.csv': {
    file: 'tax-classes.csv',
    columns: ['hsn_code', 'effective_from', 'rate_percent'],
    required: ['hsn_code', 'effective_from', 'rate_percent'],
    help: {
      hsn_code: 'The HSN code exactly as the CA mapped it (OC-21).',
      effective_from: 'The date the rate applies from, YYYY-MM-DD.',
      rate_percent: 'The GST rate in percent: 0, 5, 12, 18 or 28 (up to two decimals).',
    },
  },
  'products.csv': {
    file: 'products.csv',
    columns: ['item_code', 'sku', 'description', 'uom', 'category', 'hsn_code', 'brand', 'status', 'allergens', 'country_of_origin', 'net_quantity', 'packer', 'consumer_care', 'ingredients', 'storage', 'minimum_age'],
    required: ['item_code', 'description', 'uom', 'category', 'hsn_code'],
    help: {
      item_code: 'The old ERP item code. It becomes the product id.',
      sku: 'The SKU; blank means the item code.',
      description: 'The name the till prints.',
      uom: 'The unit it is sold in: each, kg, litre, g, ml.',
      category: 'The pilot department\'s category id — every row must name it.',
      hsn_code: 'One of the HSN codes in tax-classes.csv.',
      brand: 'Optional.',
      status: 'active, new or clearance (discontinued counts as clearance). Blank means active.',
      allergens: 'Food: the allergens separated by |, or the word none. Blank is silence, and a food item is refused for it.',
      country_of_origin: 'Food: required.',
      net_quantity: 'Packed or weighed: required (e.g. 500 g).',
      packer: 'Packed: the packer or importer name and address.',
      consumer_care: 'Packed: who a customer complains to — a name with a phone or email (Legal Metrology).',
      ingredients: 'Optional.',
      storage: 'Optional storage conditions.',
      minimum_age: 'Age-restricted: the minimum age in whole years.',
    },
  },
  'prices.csv': {
    file: 'prices.csv',
    columns: ['item_code', 'mrp', 'selling_price', 'cost_price', 'margin_floor_percent'],
    required: ['item_code', 'mrp', 'selling_price', 'cost_price'],
    help: {
      item_code: 'An item code in products.csv. Exactly one row per item.',
      mrp: 'MRP in rupees with paise (123.45). The legal ceiling.',
      selling_price: 'The shelf price in rupees with paise. Never above MRP.',
      cost_price: 'The cost in rupees with paise. Never left at zero to mean "unknown" — leave the row out instead.',
      margin_floor_percent: 'Optional. The lowest margin allowed without a second person, in percent. Blank means 0.',
    },
  },
  'barcodes.csv': {
    file: 'barcodes.csv',
    columns: ['item_code', 'barcode', 'kind'],
    required: ['item_code', 'barcode'],
    help: {
      item_code: 'An item code in products.csv. One row per barcode; an item may have several.',
      barcode: 'The code printed on the pack.',
      kind: 'Optional: ean, upc, gtin, internal, case or embedded. Blank means worked out from the code.',
    },
  },
}) as Readonly<Record<SliceFile, SliceTemplate>>;

/** The header-only template file a person downloads and fills in: one header line, nothing else. */
export function sliceTemplateCsv(file: SliceFile): string {
  return `${SLICE_TEMPLATES[file].columns.join(',')}\n`;
}

// ── Reading a file, one row at a time ────────────────────────────────────────────────────────────────

/** One physical line of a slice file: its cells, or why it could not be read. */
export interface ReadableRecord { readonly line: number; readonly row: Readonly<Record<string, string>> }
export interface UnreadableRecord { readonly line: number; readonly unreadable: string }
export type SliceRecord = ReadableRecord | UnreadableRecord;

export interface ReadSliceFile {
  readonly headers: readonly string[];
  /** A problem with the header itself — then no row is read at all (the columns would be guessed). */
  readonly headerProblem?: string;
  readonly records: readonly SliceRecord[];
}

/** Split ONE line into cells (comma, "quoted" cells, "" for a quote inside). Undefined when a quote never closes. */
export function splitCsvLine(text: string): string[] | undefined {
  const cells: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field.trim() === '') { inQuotes = true; field = ''; } else if (ch === ',') { cells.push(field); field = ''; } else field += ch;
  }
  if (inQuotes) return undefined;
  cells.push(field);
  return cells;
}

/**
 * Read a slice file line by line. One row is one line (the templates never need a line break inside a cell), so
 * a broken line — an unclosed quote, the wrong number of cells — is ONE exception, and every other line still reads.
 * The header must be the template's columns, in any order and case; an unknown or missing column refuses the header,
 * because a guessed column is a guessed price.
 */
export function readSliceFile(file: SliceFile, text: string): ReadSliceFile {
  const template = SLICE_TEMPLATES[file];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const headerCells = splitCsvLine(lines[0] ?? '');
  if (headerCells === undefined || (lines[0] ?? '').trim() === '') {
    return { headers: [], headerProblem: `${file}: the first line must be the template's column names (${template.columns.join(',')})`, records: [] };
  }
  const headers = headerCells.map((h) => h.trim().toLowerCase());
  const unknown = headers.filter((h) => !template.columns.includes(h));
  const missing = template.required.filter((c) => !headers.includes(c));
  const doubled = headers.filter((h, i) => headers.indexOf(h) !== i);
  if (unknown.length > 0 || missing.length > 0 || doubled.length > 0) {
    const parts = [
      unknown.length > 0 ? `not a template column: ${unknown.join(', ')}` : '',
      missing.length > 0 ? `required column missing: ${missing.join(', ')}` : '',
      doubled.length > 0 ? `column given twice: ${[...new Set(doubled)].join(', ')}` : '',
    ].filter((p) => p !== '');
    return { headers, headerProblem: `${file}: ${parts.join('; ')} — use the published template (${template.columns.join(',')})`, records: [] };
  }
  const records: SliceRecord[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (raw.trim() === '') continue;
    const line = i + 1;
    const cells = splitCsvLine(raw);
    if (cells === undefined) { records.push({ line, unreadable: 'a quoted value is never closed on this line' }); continue; }
    if (cells.length !== headers.length) { records.push({ line, unreadable: `expected ${headers.length} cells, found ${cells.length}` }); continue; }
    const row: Record<string, string> = {};
    headers.forEach((h, k) => { row[h] = cells[k]!; });
    records.push({ line, row });
  }
  return { headers, records };
}

// ── The exception list ───────────────────────────────────────────────────────────────────────────────

export type SliceExceptionCode =
  | 'unreadable_line' | 'missing_value' | 'bad_value' | 'duplicate' | 'outside_the_department'
  | 'no_tax_class' | 'no_price' | 'unknown_item' | 'depends_on_a_quarantined_row' | 'price_above_mrp'
  | 'product_rules' | 'barcode_on_two_items';

/** One quarantined row — the §34.1 reject/quarantine line. Its disposition is always "quarantined": it is not sent. */
export interface SliceException {
  readonly file: SliceFile;
  readonly line: number;
  /** The old ERP's key for the row: the item code, the HSN code, or the barcode. Blank only when unreadable. */
  readonly sourceKey: string;
  readonly column?: string;
  readonly code: SliceExceptionCode;
  readonly reason: string;
  readonly disposition: 'quarantined';
}

export interface SliceDepartment {
  /** The pilot department's category id — every product row must name it (OB-241: one department first). */
  readonly categoryId: string;
  readonly name: string;
  /** food | packed | weighed | age_restricted | drug | hazardous — drives the product engine's safety rules. */
  readonly regulated?: readonly RegulatedKind[];
}

export interface StagedSlice {
  readonly department: SliceDepartment;
  /** The bundle the loader will send — the STAGED rows only. Suppliers, customers and stock are never in a slice. */
  readonly bundle: ExtractBundle;
  /** Every quarantined row, in file order, file by file. Never pruned. */
  readonly exceptions: readonly SliceException[];
  readonly counts: Readonly<Record<SliceFile, { readonly rows: number; readonly staged: number; readonly quarantined: number }>>;
  /** What the acceptance binds to: the staged bundle AND the exception list. Change either and it changes. */
  readonly digest: string;
  /** A file whose HEADER could not be read — then the slice is not stageable at all. */
  readonly headerProblems: readonly string[];
}

const REGULATED: readonly RegulatedKind[] = ['food', 'packed', 'weighed', 'age_restricted', 'drug', 'hazardous'];
const BARCODE_KINDS: readonly BarcodeKind[] = ['gtin', 'ean', 'upc', 'internal', 'case', 'embedded'];
const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

function lifecycleOf(status: string | undefined): ExtractProduct['lifecycle'] | undefined {
  const s = (status ?? 'active').trim().toLowerCase();
  if (s === 'active' || s === '') return 'active';
  if (s === 'new') return 'new';
  if (s === 'clearance' || s === 'discontinued' || s === 'inactive') return 'clearance';
  return undefined;
}

/** A stable canonical JSON (sorted keys) so the digest never depends on property order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Judge every row of the four files on its own, stage the good ones and quarantine the rest — with each reason.
 * The order matters and is the loader's: tax classes first (a product needs its rate), then products, then prices
 * (a product with no price cannot be sold, so it is quarantined), then barcodes (for staged products only).
 */
export function stageSlice(input: {
  readonly department: SliceDepartment;
  readonly files: Readonly<Partial<Record<SliceFile, string>>>;
  readonly hasher?: Hasher;
}): StagedSlice {
  const hasher = input.hasher ?? simpleHasher;
  const exceptions: SliceException[] = [];
  const quarantine = (file: SliceFile, line: number, sourceKey: string, code: SliceExceptionCode, reason: string, column?: string): void => {
    exceptions.push({ file, line, sourceKey, ...(column === undefined ? {} : { column }), code, reason, disposition: 'quarantined' });
  };
  const counts: Record<SliceFile, { rows: number; staged: number; quarantined: number }> = {
    'tax-classes.csv': { rows: 0, staged: 0, quarantined: 0 }, 'products.csv': { rows: 0, staged: 0, quarantined: 0 },
    'prices.csv': { rows: 0, staged: 0, quarantined: 0 }, 'barcodes.csv': { rows: 0, staged: 0, quarantined: 0 },
  };
  const headerProblems: string[] = [];
  const read: Partial<Record<SliceFile, ReadSliceFile>> = {};
  for (const f of SLICE_FILES) {
    const text = input.files[f];
    if (text === undefined) {
      if (f === 'products.csv' || f === 'prices.csv' || f === 'tax-classes.csv') headerProblems.push(`${f} is missing — a department slice needs products, their prices and their tax classes`);
      continue;
    }
    const r = readSliceFile(f, text);
    if (r.headerProblem !== undefined) headerProblems.push(r.headerProblem);
    read[f] = r;
    counts[f].rows = r.records.length;
  }
  const dept = input.department;
  const regulatedBad = (dept.regulated ?? []).filter((r) => !REGULATED.includes(r));
  if (dept.categoryId.trim() === '' || dept.name.trim() === '') headerProblems.push('the slice must name the pilot department (category id and name)');
  if (regulatedBad.length > 0) headerProblems.push(`the department's regulated kinds must be among ${REGULATED.join(', ')} (not ${regulatedBad.join(', ')})`);

  const category: Category = { categoryId: dept.categoryId, name: dept.name, parentId: null, ...(dept.regulated === undefined ? {} : { regulated: dept.regulated }) };
  const rowsOf = (f: SliceFile): readonly SliceRecord[] => (headerProblems.length > 0 ? [] : read[f]?.records ?? []);
  const unreadable = (f: SliceFile, r: SliceRecord): r is UnreadableRecord => {
    if ('unreadable' in r) { quarantine(f, r.line, '', 'unreadable_line', `line ${r.line} could not be read: ${r.unreadable}`); return true; }
    return false;
  };

  // ── tax classes ────────────────────────────────────────────────────────────────────────────────
  const taxRates: ExtractTaxRate[] = [];
  const taxSeen = new Map<string, number>();
  const stagedHsn = new Set<string>();
  for (const r of rowsOf('tax-classes.csv')) {
    if (unreadable('tax-classes.csv', r)) continue;
    const hsn = cell(r.row, 'hsn_code');
    const from = cell(r.row, 'effective_from');
    const rateText = cell(r.row, 'rate_percent');
    const key = hsn ?? '';
    if (hsn === undefined) { quarantine('tax-classes.csv', r.line, '', 'missing_value', 'the HSN code is blank', 'hsn_code'); continue; }
    if (from === undefined || !isDate(from)) { quarantine('tax-classes.csv', r.line, key, from === undefined ? 'missing_value' : 'bad_value', `the effective date ${from === undefined ? 'is blank' : `"${from}" is not a real date in YYYY-MM-DD`}`, 'effective_from'); continue; }
    const bps = percentToBps(rateText);
    if (bps === undefined || bps > 10_000) { quarantine('tax-classes.csv', r.line, key, rateText === undefined ? 'missing_value' : 'bad_value', `the rate ${rateText === undefined ? 'is blank' : `"${rateText}" is not a percent from 0 to 100`} — an unmapped tax code is an exception, never a default (OC-21)`, 'rate_percent'); continue; }
    const k = `${hsn}|${from}`;
    const first = taxSeen.get(k);
    if (first !== undefined) { quarantine('tax-classes.csv', r.line, key, 'duplicate', `HSN ${hsn} from ${from} is also on line ${first}`, 'hsn_code'); continue; }
    taxSeen.set(k, r.line);
    taxRates.push({ hsnCode: hsn, effectiveFrom: from, rateBps: bps });
    stagedHsn.add(hsn);
  }

  // ── products ───────────────────────────────────────────────────────────────────────────────────
  interface Draft { readonly line: number; readonly product: Omit<ExtractProduct, 'barcodes' | 'priceMinor' | 'mrpMinor' | 'costMinor' | 'marginFloorBps'> }
  const drafts = new Map<string, Draft>();
  const productLine = new Map<string, number>();
  const skuOwner = new Map<string, string>();
  const quarantinedItems = new Set<string>();
  for (const r of rowsOf('products.csv')) {
    if (unreadable('products.csv', r)) continue;
    const id = cell(r.row, 'item_code');
    if (id === undefined) { quarantine('products.csv', r.line, '', 'missing_value', 'the item code is blank', 'item_code'); continue; }
    const q = (code: SliceExceptionCode, reason: string, column?: string): void => { quarantine('products.csv', r.line, id, code, reason, column); quarantinedItems.add(id); };
    const first = productLine.get(id);
    if (first !== undefined) { quarantine('products.csv', r.line, id, 'duplicate', `item ${id} is also on line ${first} — one row per item`, 'item_code'); continue; }
    productLine.set(id, r.line);
    const name = cell(r.row, 'description');
    const uom = cell(r.row, 'uom');
    const categoryId = cell(r.row, 'category');
    const hsn = cell(r.row, 'hsn_code');
    const missing = [name === undefined ? 'description' : '', uom === undefined ? 'uom' : '', categoryId === undefined ? 'category' : '', hsn === undefined ? 'hsn_code' : ''].filter((m) => m !== '');
    if (missing.length > 0) { q('missing_value', `blank: ${missing.join(', ')}`, missing[0]); continue; }
    if (categoryId !== dept.categoryId) { q('outside_the_department', `category "${categoryId}" is not the pilot department "${dept.categoryId}" — the first load is one department only (OB-241)`, 'category'); continue; }
    if (!stagedHsn.has(hsn!)) { q('no_tax_class', `HSN ${hsn} has no staged rate in tax-classes.csv — a product cannot go on sale without a tax class (OC-21)`, 'hsn_code'); continue; }
    const lifecycle = lifecycleOf(cell(r.row, 'status'));
    if (lifecycle === undefined) { q('bad_value', `status "${cell(r.row, 'status')}" is not active, new or clearance`, 'status'); continue; }
    const sku = cell(r.row, 'sku') ?? id;
    const owner = skuOwner.get(sku.toLowerCase());
    if (owner !== undefined) { q('duplicate', `SKU ${sku} already belongs to item ${owner} — one SKU names one item`, 'sku'); continue; }
    const ageText = cell(r.row, 'minimum_age');
    if (ageText !== undefined && !/^\d+$/.test(ageText)) { q('bad_value', `minimum age "${ageText}" is not a whole number of years`, 'minimum_age'); continue; }
    const allergenText = cell(r.row, 'allergens');
    const safety = {
      ...(allergenText === undefined ? {} : { allergens: allergenText.toLowerCase() === 'none' ? [] : list(allergenText) }),
      ...(cell(r.row, 'ingredients') === undefined ? {} : { ingredients: cell(r.row, 'ingredients')! }),
      ...(cell(r.row, 'country_of_origin') === undefined ? {} : { countryOfOrigin: cell(r.row, 'country_of_origin')! }),
      ...(cell(r.row, 'storage') === undefined ? {} : { storageConditions: cell(r.row, 'storage')! }),
      ...(cell(r.row, 'net_quantity') === undefined ? {} : { netQuantity: cell(r.row, 'net_quantity')! }),
      ...(cell(r.row, 'packer') === undefined ? {} : { packerDetails: cell(r.row, 'packer')! }),
      ...(cell(r.row, 'consumer_care') === undefined ? {} : { consumerCareContact: cell(r.row, 'consumer_care')! }),
      ...(ageText === undefined ? {} : { minimumAge: Number(ageText) }),
    };
    const brand = cell(r.row, 'brand');
    const product = {
      productId: id, sku, name: name!, baseUom: uom!, primaryCategoryId: dept.categoryId, taxClass: hsn!, lifecycle,
      ...(brand === undefined ? {} : { brand }),
      ...(Object.keys(safety).length === 0 ? {} : { safety }),
    };
    // The SAME product engine the publish route runs: a food item with no allergen declaration is quarantined here,
    // with the engine's own words, never a 422 half-way through the load.
    const record: ProductRecord = { ...product, tenantId: 'slice' } as ProductRecord;
    let ruleProblems: string[] = [];
    try {
      ruleProblems = validateProduct(record, [category]).issues.filter((i) => i.severity === 'blocks_publish').map((i) => i.message);
    } catch (err) {
      if (!(err instanceof CategoryNotFoundError)) throw err;
      ruleProblems = [`category ${dept.categoryId} could not be read`];
    }
    if (ruleProblems.length > 0) { q('product_rules', ruleProblems.join('; ')); continue; }
    skuOwner.set(sku.toLowerCase(), id);
    drafts.set(id, { line: r.line, product });
  }

  // ── prices ─────────────────────────────────────────────────────────────────────────────────────
  const prices = new Map<string, { priceMinor: number; mrpMinor: number; costMinor: number; marginFloorBps: number }>();
  const priceLine = new Map<string, number>();
  for (const r of rowsOf('prices.csv')) {
    if (unreadable('prices.csv', r)) continue;
    const id = cell(r.row, 'item_code');
    if (id === undefined) { quarantine('prices.csv', r.line, '', 'missing_value', 'the item code is blank', 'item_code'); continue; }
    const q = (code: SliceExceptionCode, reason: string, column?: string): void => quarantine('prices.csv', r.line, id, code, reason, column);
    const first = priceLine.get(id);
    if (first !== undefined) {
      // Both rows are held back: which of two prices is right is a decision, not a default.
      if (prices.has(id)) { quarantine('prices.csv', first, id, 'duplicate', `item ${id} has another price on line ${r.line} — one price per item`, 'item_code'); prices.delete(id); }
      q('duplicate', `item ${id} already has a price on line ${first} — one price per item; which one is right is a decision, not a default`, 'item_code');
      continue;
    }
    priceLine.set(id, r.line);
    if (!drafts.has(id)) {
      q(quarantinedItems.has(id) || productLine.has(id) ? 'depends_on_a_quarantined_row' : 'unknown_item',
        quarantinedItems.has(id) || productLine.has(id) ? `item ${id} did not stage in products.csv, so its price is held back with it` : `item ${id} is not in products.csv`, 'item_code');
      continue;
    }
    const mrp = moneyToMinor(cell(r.row, 'mrp'));
    const sell = moneyToMinor(cell(r.row, 'selling_price'));
    const cost = moneyToMinor(cell(r.row, 'cost_price'));
    const bad = [mrp === undefined || mrp < 0 ? 'mrp' : '', sell === undefined || sell < 0 ? 'selling_price' : '', cost === undefined || cost < 0 ? 'cost_price' : ''].filter((c) => c !== '');
    if (bad.length > 0) { q('bad_value', `not a rupee amount (e.g. 123.45): ${bad.join(', ')} — a blank or unreadable price is never loaded as zero`, bad[0]); continue; }
    if (sell! > mrp!) { q('price_above_mrp', `selling price ${(sell! / 100).toFixed(2)} is above MRP ${(mrp! / 100).toFixed(2)} — MRP is the legal ceiling`, 'selling_price'); continue; }
    const floorText = cell(r.row, 'margin_floor_percent');
    const floor = floorText === undefined ? 0 : percentToBps(floorText);
    if (floor === undefined || floor > 9_999) { q('bad_value', `margin floor "${floorText}" is not a percent below 100`, 'margin_floor_percent'); continue; }
    prices.set(id, { priceMinor: sell!, mrpMinor: mrp!, costMinor: cost!, marginFloorBps: floor });
  }
  // A staged product with no price cannot be sold: it is held back, said, never loaded priceless.
  for (const [id, d] of drafts) {
    if (!prices.has(id)) {
      const duplicatePriced = priceLine.has(id);
      quarantine('products.csv', d.line, id, 'no_price', duplicatePriced ? `item ${id} has more than one price row, so it has no single price to load` : `item ${id} has no usable row in prices.csv — an item without a price is not loaded`);
      quarantinedItems.add(id);
      drafts.delete(id);
    }
  }

  // ── barcodes ───────────────────────────────────────────────────────────────────────────────────
  const barcodeRows: { line: number; id: string; code: string; kind: BarcodeKind }[] = [];
  const codeLines = new Map<string, { id: string; line: number }[]>();
  for (const r of rowsOf('barcodes.csv')) {
    if (unreadable('barcodes.csv', r)) continue;
    const id = cell(r.row, 'item_code');
    const code = cell(r.row, 'barcode');
    if (id === undefined || code === undefined) { quarantine('barcodes.csv', r.line, code ?? id ?? '', 'missing_value', `blank: ${[id === undefined ? 'item_code' : '', code === undefined ? 'barcode' : ''].filter((s) => s !== '').join(', ')}`, id === undefined ? 'item_code' : 'barcode'); continue; }
    if (!/^[A-Za-z0-9-]{3,48}$/.test(code)) { quarantine('barcodes.csv', r.line, code, 'bad_value', `barcode "${code}" is not 3–48 letters or digits`, 'barcode'); continue; }
    const kindText = cell(r.row, 'kind');
    const kind = kindText === undefined ? inferBarcodeKind(code) : (kindText.toLowerCase() as BarcodeKind);
    if (!BARCODE_KINDS.includes(kind)) { quarantine('barcodes.csv', r.line, code, 'bad_value', `kind "${kindText}" is not one of ${BARCODE_KINDS.join(', ')}`, 'kind'); continue; }
    codeLines.set(code, [...(codeLines.get(code) ?? []), { id, line: r.line }]);
    barcodeRows.push({ line: r.line, id, code, kind });
  }
  const barcodesFor = new Map<string, { code: string; kind: BarcodeKind }[]>();
  for (const b of barcodeRows) {
    const holders = codeLines.get(b.code)!;
    const items = new Set(holders.map((h) => h.id));
    if (items.size > 1) {
      // One code naming two items is ambiguous at the till: BOTH rows are held back, so nobody's scan rings the wrong item.
      quarantine('barcodes.csv', b.line, b.code, 'barcode_on_two_items', `barcode ${b.code} is given to items ${[...items].join(' and ')} — one code names exactly one item`, 'barcode');
      continue;
    }
    if (holders[0]!.line !== b.line) { quarantine('barcodes.csv', b.line, b.code, 'duplicate', `barcode ${b.code} for item ${b.id} is also on line ${holders[0]!.line}`, 'barcode'); continue; }
    if (!drafts.has(b.id)) {
      quarantine('barcodes.csv', b.line, b.code, productLine.has(b.id) ? 'depends_on_a_quarantined_row' : 'unknown_item',
        productLine.has(b.id) ? `item ${b.id} did not stage, so its barcode is held back with it` : `item ${b.id} is not in products.csv`, 'item_code');
      continue;
    }
    barcodesFor.set(b.id, [...(barcodesFor.get(b.id) ?? []), { code: b.code, kind: b.kind }]);
  }

  const products: ExtractProduct[] = [...drafts.entries()]
    .sort((a, b) => a[1].line - b[1].line)
    .map(([id, d]) => ({ ...d.product, barcodes: barcodesFor.get(id) ?? [], ...prices.get(id)! }));
  // Only the tax classes a staged product uses are sent — and every one the file listed is accounted for.
  const bundle: ExtractBundle = {
    categories: [{ categoryId: dept.categoryId, name: dept.name, parentId: null, ...(dept.regulated === undefined ? {} : { regulated: dept.regulated }) }],
    taxRates, products, suppliers: [], customers: [], openingStock: [],
  };

  // Belt and braces: the bulk loader's own whole-bundle check must find nothing in what was staged. If it ever does,
  // the staging is wrong, and that is a bug to see — never a row to send.
  const leftovers = headerProblems.length > 0 ? [] : validateBundle(bundle);
  if (leftovers.length > 0) throw new Error(`slice staging let through rows the loader would refuse: ${leftovers.join('; ')}`);

  const order = new Map(SLICE_FILES.map((f, i) => [f, i] as const));
  exceptions.sort((a, b) => (order.get(a.file)! - order.get(b.file)!) || a.line - b.line);
  for (const e of exceptions) counts[e.file].quarantined += 1;
  counts['tax-classes.csv'].staged = taxRates.length;
  counts['products.csv'].staged = products.length;
  counts['prices.csv'].staged = products.length;
  counts['barcodes.csv'].staged = products.reduce((n, p) => n + p.barcodes.length, 0);
  // A row can only be staged or quarantined. Products are the one file where the count can differ (a later
  // dependent quarantine re-uses the product's own line), so the arithmetic is said, never assumed.
  const digest = hasher(canonical({ department: dept, bundle, exceptions, headerProblems }));
  return { department: dept, bundle, exceptions, counts, digest, headerProblems };
}

/** The exception list as a CSV the acceptor reads — one quarantined row per line, with its reason. */
export function sliceExceptionsCsv(staged: Pick<StagedSlice, 'exceptions'>): string {
  const q = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = staged.exceptions.map((e) => [e.file, String(e.line), e.sourceKey, e.column ?? '', e.code, e.reason, e.disposition].map(q).join(','));
  return `${['file', 'line', 'source_key', 'column', 'code', 'reason', 'disposition'].join(',')}\n${rows.join('\n')}${rows.length > 0 ? '\n' : ''}`;
}

// ── The one door ─────────────────────────────────────────────────────────────────────────────────────

/** A named person's acceptance of ONE exception list (bound by its digest), as the cloud keeps it. */
export interface SliceAcceptance {
  readonly sliceDigest: string;
  readonly acceptedBy: string;
  readonly acceptedAt: string;
  readonly statement: string;
  readonly quarantined: number;
}

export type SliceGateRefusal = 'header_problems' | 'nothing_staged' | 'not_accepted' | 'accepted_a_different_list' | 'accepted_by_nobody';

export type SliceGate =
  | { readonly open: true; readonly detail: string }
  | { readonly open: false; readonly refusedBecause: SliceGateRefusal; readonly detail: string };

/**
 * May this staged slice be applied? Only when a NAMED person has accepted exactly this exception list — even an
 * empty one (an empty list accepted is a fact; an empty list nobody looked at is an assumption). A partial load
 * is never applied silently: the acceptance is the record that somebody saw what was held back.
 */
export function sliceApplyGate(staged: Pick<StagedSlice, 'digest' | 'exceptions' | 'headerProblems' | 'bundle'>, acceptance: SliceAcceptance | undefined): SliceGate {
  if (staged.headerProblems.length > 0) return { open: false, refusedBecause: 'header_problems', detail: `the files do not follow the templates: ${staged.headerProblems.join('; ')}` };
  if (staged.bundle.products.length === 0) return { open: false, refusedBecause: 'nothing_staged', detail: 'no product row staged — there is nothing to load; read the exception list and fix the files' };
  if (acceptance === undefined) {
    return { open: false, refusedBecause: 'not_accepted', detail: `${staged.exceptions.length} row(s) are quarantined and nobody has accepted the exception list — a partial load is never applied silently` };
  }
  if (acceptance.acceptedBy.trim() === '') return { open: false, refusedBecause: 'accepted_by_nobody', detail: 'the acceptance carries no name' };
  if (acceptance.sliceDigest !== staged.digest) {
    return { open: false, refusedBecause: 'accepted_a_different_list', detail: `the acceptance by ${acceptance.acceptedBy} was over a different exception list (the files changed since) — stage again and have the new list accepted` };
  }
  return { open: true, detail: `${acceptance.acceptedBy} accepted this exception list (${staged.exceptions.length} quarantined row(s)) on ${acceptance.acceptedAt}` };
}
