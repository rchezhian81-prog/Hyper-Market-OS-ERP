// The old ERP (Bpal) exports → the four department-slice files (OB-241 · OB-276 · OB-693 · OB-694 · OB-695 · MG-05).
//
// The shop's old ERP has no item-master export with groups, prices and label facts in one place. Its three Excel
// reports carry the shop's own facts between them, and this turns them into the four published slice templates
// (packages/migration/src/slice-import.ts), for the WHOLE store — every department (OB-800, owner, 15 Nov 2026: no pilot
// department; the store is loaded whole and runs in parallel with Bpal). Nothing of the old ERP's design comes across: only each item's code, name, barcodes, HSN, GST rate and prices (owner, 6 Nov 2026).
//
//   EANCODE report         Item Id · Item Name · EanCode                      one row per barcode
//   HSN report             Item Id · Item Name · Hsn Code · Item Quantity · Gst % · … · Cess Amt
//   Product wise Detail    Purc Date · Purc No · Item Id · Item Name · … · NetCost · Selling · MRP · …   (12 months)
//
// The rules, each the owner's written decision:
//   • OB-800 — every item of the old ERP is taken; its department comes from its HSN (the table below). OB-694's HSN rule
//     still names the packaged-groceries department. This converter writes items sold by barcode (`pcs`); an item with no
//     pack barcode (loose goods, sold by weight or by count) is set aside with that reason — it is marked loose and loaded
//     from the Import page (packages/migration/src/old-system-import.ts).
//   • OB-695 — its MRP, selling price and cost are those of its NEWEST purchase row in the last 12 months.
//   • OB-738 (owner, 14 Nov 2026, "1A", replacing OB-696; option A "sell at the till only") and OB-811 B (16 Nov 2026): a
//     label fact a packed good must carry (M03-FR-03) is never invented, and in every packed-goods department its absence
//     no longer holds an item back (loose foods keep the full rule: set aside until the facts are read). Every item is written into
//     products.csv with the facts staff have read into label-facts.csv (best sellers first) and the rest BLANK — never
//     "none". The loader lets the blank ones follow; head office lists them until read, and the item sells at the till
//     only (never online or by scan-and-go) meanwhile. label-facts.csv stays the staff's working sheet.
//
// Nothing is guessed. A row the rules cannot read is SET ASIDE with its reason (bpal-set-aside.csv) — never loaded,
// never dropped silently (P-08). The slice importer then judges every row again (MG-05) and a named person accepts the
// list before anything goes in (MG-06).

/** One row of a sheet: header name → the cell's text (as the export wrote it). */
export type SheetRow = Readonly<Record<string, string>>;

export const PILOT_CATEGORY_ID = 'packaged-groceries';
export const PILOT_CATEGORY_NAME = 'Packaged groceries';

/** OB-694: the HSN chapters (first two digits) of packaged food and beverages. */
const PILOT_CHAPTERS = new Set(['07', '08', '09', '10', '11', '12', '15', '17', '18', '19', '20', '21', '22']);
/** OB-694: headings outside those chapters that are in, and the one inside them that is out (cold chain). */
const PILOT_HEADINGS_IN = new Set(['0402', '0409']);
const PILOT_HEADINGS_OUT = new Set(['2105']);

/** A 4-, 6- or 8-digit HSN code. */
export const isHsn = (hsn: string): boolean => /^\d{4}(\d{2}){0,2}$/.test(hsn.trim());

/** OB-694: packaged food and beverages by HSN — the packaged-groceries department's HSN rule. */
export function inPilotDepartment(hsn: string): boolean {
  const h = hsn.trim();
  if (!isHsn(h)) return false;
  if (PILOT_HEADINGS_OUT.has(h.slice(0, 4))) return false;
  return PILOT_CHAPTERS.has(h.slice(0, 2)) || PILOT_HEADINGS_IN.has(h.slice(0, 4));
}

// ── OB-800 (owner, 15 Nov 2026): no pilot department — the WHOLE store is loaded, every department ─────────────────
//
// The old ERP (Bpal) has no item group in its exports (OB-694), so an item's department is worked out from its HSN code
// and from how it is sold — by this one published table, never by a guess per item:
//
//   packaged-groceries     OB-694's HSN rule, sold as a pack with a barcode               food · packed  (OB-738 applies)
//   other-packaged-foods   other food HSNs (dairy, eggs, meat, fish 02–04; meat/fish      food · packed
//                          preparations 16; ice cream 2105; salt 2501), sold as a pack
//   personal-care          chapter 33, soap 3401, toothbrushes 960321, sanitary goods 9619 packed
//   household-general      every other HSN, sold as a pack                                packed
//   loose-foods            a food HSN (either food row above) sold LOOSE — by weight      food
//                          (kg) or by count, with no pack barcode
//   loose-general          any other HSN sold loose                                       —
//
// "Sold loose" is never read off a figure: a person marks it on the Import page (a part quantity sold, or a short code in
// the barcode column, is shown as a HINT only). Three kinds of goods carry facts the old ERP does not hold and the Import
// page does not take (tobacco 24: minimum age and pack size; medicines 30; gold, silver and jewellery 71: HUID / BIS):
// they are never loaded from the old ERP — each stays on the list, with that reason, to be set up on the Products page.
//
// The OB-738 allowance (load with label facts blank, sell at the till only) reaches EVERY packed-goods department since the
// owner's OB-811 B (16 Nov 2026, in writing): packaged groceries, other packed foods, personal care, household goods. Loose
// foods keep the full rule — an item missing a label fact its department needs waits, listed, until the fact is read.

export type SoldAs = 'pack' | 'loose_kg' | 'loose_count';

export interface StoreDepartment {
  readonly categoryId: string;
  readonly name: string;
  /** The product engine's safety kinds for the department's items (M03-FR-03). */
  readonly regulated: readonly ('food' | 'packed')[];
}

export const STORE_DEPARTMENTS: readonly StoreDepartment[] = Object.freeze([
  { categoryId: PILOT_CATEGORY_ID, name: PILOT_CATEGORY_NAME, regulated: ['food', 'packed'] },
  { categoryId: 'other-packaged-foods', name: 'Dairy, chilled, frozen and other packed foods', regulated: ['food', 'packed'] },
  { categoryId: 'personal-care', name: 'Personal care', regulated: ['packed'] },
  { categoryId: 'household-general', name: 'Household and general goods', regulated: ['packed'] },
  { categoryId: 'loose-foods', name: 'Loose foods (by weight or by count)', regulated: ['food'] },
  { categoryId: 'loose-general', name: 'Loose non-food goods', regulated: [] },
] satisfies StoreDepartment[]);

const departmentById = new Map(STORE_DEPARTMENTS.map((d) => [d.categoryId, d] as const));
export const storeDepartment = (categoryId: string): StoreDepartment | undefined => departmentById.get(categoryId);

/** Food HSNs outside OB-694's packaged-groceries rule: dairy, eggs, meat, fish (02–04), meat/fish preparations (16), ice cream (2105), salt (2501). */
const OTHER_FOOD_CHAPTERS = new Set(['02', '03', '04', '16']);
const OTHER_FOOD_HEADINGS = new Set(['2105', '2501']);
const PERSONAL_CARE_HEADINGS = new Set(['3401', '9619']);

export function isFoodHsn(hsn: string): boolean {
  const h = hsn.trim();
  return isHsn(h) && (inPilotDepartment(h) || OTHER_FOOD_CHAPTERS.has(h.slice(0, 2)) || OTHER_FOOD_HEADINGS.has(h.slice(0, 4)));
}

/** The department an item belongs to, from its HSN and how it is sold. Undefined when the HSN is not a 4/6/8-digit code. */
export function departmentOf(hsn: string, soldAs: SoldAs = 'pack'): StoreDepartment | undefined {
  const h = hsn.trim();
  if (!isHsn(h)) return undefined;
  const id = soldAs !== 'pack' ? (isFoodHsn(h) ? 'loose-foods' : 'loose-general')
    : inPilotDepartment(h) ? PILOT_CATEGORY_ID
      : isFoodHsn(h) ? 'other-packaged-foods'
        : h.startsWith('33') || h.startsWith('960321') || PERSONAL_CARE_HEADINGS.has(h.slice(0, 4)) ? 'personal-care'
          : 'household-general';
  return departmentById.get(id)!;
}

/** Goods whose legal facts the old ERP does not hold: never loaded from it — set up on the Products page. Undefined: loadable. */
export function setUpElsewhere(hsn: string): string | undefined {
  const ch = hsn.trim().slice(0, 2);
  if (ch === '24') return 'tobacco is age-restricted and sold in whole packs only: its minimum age and pack size are not in the old ERP — set it up on the Products page';
  if (ch === '30') return 'medicines carry rules the old ERP does not hold — set it up on the Products page';
  if (ch === '71') return 'gold, silver and jewellery need the hallmark (HUID) or BIS details, which the old ERP does not hold — set it up on the Products page';
  return undefined;
}

/**
 * OB-738 · OB-811 B (owner, 16 Nov 2026, in writing): the departments whose items load with label facts still to read (sell
 * at the till only, kept off online and scan-and-go, listed until filled) — every PACKED-goods department, read off this
 * table's own `regulated` column (a department whose items are `packed`). Loose foods and loose goods have no pack, so they
 * keep the full rule. The product engine's `LABEL_FACTS_MAY_FOLLOW_IN` is pinned equal to this by a test.
 */
export const labelFactsMayFollowIn = (dept: StoreDepartment): boolean => dept.regulated.includes('packed');

/** The departments the given category ids name, in the table's order — what a load's slice.json lists. */
export const departmentsNamed = (categoryIds: Iterable<string>): StoreDepartment[] => {
  const want = new Set(categoryIds);
  return STORE_DEPARTMENTS.filter((d) => want.has(d.categoryId));
};

/** A GTIN (EAN-8, UPC-A, EAN-13, GTIN-14) whose check digit is right. Anything else is not a pack barcode. */
export function isGtin(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const d = [...code].map(Number);
  const check = d.pop()!;
  const sum = d.reverse().reduce((s, x, i) => s + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** The five label facts a packed food must carry before it may be sold (M03-FR-03; Legal Metrology · FSSAI). */
export const LABEL_FACTS = ['allergens', 'country_of_origin', 'net_quantity', 'packer', 'consumer_care'] as const;
export type LabelFact = typeof LABEL_FACTS[number];

/**
 * The label facts an item of this department must carry before it loads — the product engine's own rule (M03-FR-03,
 * `validateProduct`): a food needs its allergens and country of origin; a packed item its net quantity, packer, consumer
 * care and country of origin. In a packed-goods department OB-738 · OB-811 B let them follow (`labelFactsMayFollowIn`).
 */
export function labelFactsNeeded(dept: StoreDepartment): readonly LabelFact[] {
  const food = dept.regulated.includes('food');
  const packed = dept.regulated.includes('packed');
  return LABEL_FACTS.filter((k) => (k === 'allergens' ? food : k === 'country_of_origin' ? food || packed : packed));
}

export interface SetAside { readonly itemId: string; readonly name: string; readonly reason: string }

export interface BpalSliceInput {
  readonly eanRows: readonly SheetRow[];
  readonly hsnRows: readonly SheetRow[];
  readonly purchaseRows: readonly SheetRow[];
  /** Filled label facts, keyed by the item code (label-facts.csv as staff saved it). Absent: none filled yet. */
  readonly labelFacts?: ReadonlyMap<string, Readonly<Partial<Record<LabelFact, string>>>>;
  /** Item codes already loaded by an earlier slice: not written again (a later load takes only new items). */
  readonly alreadyLoaded?: ReadonlySet<string>;
  /** The day the old ERP's GST rates were read off it (YYYY-MM-DD): each tax class is in force from it. */
  readonly ratesFrom: string;
  /** Today in the shop (YYYY-MM-DD): a purchase older than 12 months before it gives no price (OB-695). */
  readonly today: string;
}

export interface BpalSliceOutput {
  readonly files: { readonly 'tax-classes.csv': string; readonly 'products.csv': string; readonly 'prices.csv': string; readonly 'barcodes.csv': string };
  /** The staff's label-facts sheet: every item not yet loaded, best sellers first, with what is filled (OB-738). */
  readonly labelFactsSheet: string;
  readonly setAsideCsv: string;
  /** For the accountant: each HSN whose items the old ERP taxes at more than one rate, with the items at each rate. */
  readonly hsnToCheckCsv: string;
  readonly setAside: readonly SetAside[];
  readonly counts: {
    /** `items`: every item the reports name (OB-800: every department). `ready`: every item written into the four files.
     *  `factsStillToRead`: those of them with a label fact their department needs blank (OB-738 · OB-811 B — packed goods). */
    readonly items: number; readonly ready: number; readonly factsStillToRead: number;
    readonly setAside: number; readonly alreadyLoaded: number; readonly barcodes: number; readonly taxClasses: number;
    /** The ready items per department (category id → count); a department with none is left out. */
    readonly byDepartment: Readonly<Record<string, number>>;
  };
  /** The departments the ready items are in — what slice.json lists (OB-800). */
  readonly departments: readonly StoreDepartment[];
}

/** A cell by any of its header names (case and spaces aside); '' when blank or absent. */
export const cellOf = (row: SheetRow, ...names: string[]): string => {
  for (const n of names) {
    const hit = Object.keys(row).find((k) => k.trim().toLowerCase() === n.toLowerCase());
    if (hit !== undefined && (row[hit] ?? '').trim() !== '') return row[hit]!.trim();
  }
  return '';
};

/** Rupees as the export wrote them (often with float noise: 84.966999999) → paise, or undefined when not a number. */
export function rupeesToPaise(raw: string): number | undefined {
  const t = raw.replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return undefined;
  return Math.round(Number(t) * 100);
}
const text = cellOf;
export const paiseText = (p: number): string => (p / 100).toFixed(2);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const validDay = (y: number, m: number, d: number): string | undefined => {
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return m >= 1 && m <= 12 && d >= 1 && !Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) && new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : undefined;
};

/**
 * A purchase date as the export wrote it → yyyy-mm-dd: an Excel day number (46328, with or without a time fraction),
 * dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy, dd-Mon-yyyy (07-Nov-2026) or yyyy-mm-dd — each with or without a time after it
 * (the old ERP's 12-month report writes "07/11/2026 13:27"). Day first, as Indian reports write it; anything else is
 * not a date (undefined), never a guess.
 */
export function purchaseDay(raw: string): string | undefined {
  const t = raw.trim().replace(/[ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?(\s*[AaPp][Mm])?$/, '').trim();
  if (/^\d{5}(\.\d+)?$/.test(t)) {
    const ms = Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (dmy) return validDay(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
  const dMony = /^(\d{1,2})[ /.-]([A-Za-z]{3})[A-Za-z]*[ /.-](\d{4})$/.exec(t);
  if (dMony) { const m = MONTHS.indexOf(dMony[2]!.toLowerCase()); return m < 0 ? undefined : validDay(Number(dMony[3]), m + 1, Number(dMony[1])); }
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (ymd) return validDay(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
  return undefined;
}

/** The names the old ERP's purchase reports give each column this reads (the 12-month report names some differently). */
export const PURCHASE_COLUMNS = {
  date: ['Purc Date', 'Purchase Date', 'Inv Date', 'Invoice Date', 'Bill Date', 'Date'],
  no: ['Purc No', 'Purchase No', 'Inv No', 'Invoice No', 'Bill No'],
  mrp: ['MRP'],
  sell: ['Selling', 'Selling Rate', 'Sales Rate', 'Sale Rate', 'Selling Price'],
  cost: ['NetCost', 'Net Cost', 'Cost', 'Net Rate', 'Purchase Rate', 'Purc Rate', 'Landing Cost'],
} as const;

export interface PurchaseReportReading {
  readonly rows: number;
  /** The rows whose date could be read, and the oldest and newest of them. */
  readonly datedRows: number;
  readonly oldest?: string;
  readonly newest?: string;
  /** Why the report cannot give prices — each in words, naming the columns it does have. Empty: it can. */
  readonly problems: readonly string[];
}

/**
 * Read the purchase report BEFORE anything is judged (P-08): a report whose date or price columns cannot be read would
 * otherwise set every item aside as "no purchase", which says the wrong thing. This names what is missing and the
 * columns the report does have, so the right report (or the right column) can be found.
 */
export function readPurchaseReport(rows: readonly SheetRow[]): PurchaseReportReading {
  const headers = rows.length === 0 ? [] : Object.keys(rows[0]!);
  const has = (names: readonly string[]): boolean => headers.some((h) => names.some((n) => n.toLowerCase() === h.trim().toLowerCase()));
  const problems: string[] = [];
  const columns = `its columns are: ${headers.join(', ')}`;
  if (rows.length === 0) problems.push('the purchase report has no rows under its header');
  for (const [what, names] of [['the purchase date', PURCHASE_COLUMNS.date], ['the MRP', PURCHASE_COLUMNS.mrp], ['the selling price', PURCHASE_COLUMNS.sell], ['the cost', PURCHASE_COLUMNS.cost]] as const) {
    if (rows.length > 0 && !has(names)) problems.push(`no column for ${what} (looked for: ${names.join(', ')}) — ${columns}`);
  }
  const days = rows.map((r) => purchaseDay(text(r, ...PURCHASE_COLUMNS.date))).filter((d): d is string => d !== undefined).sort();
  if (rows.length > 0 && has(PURCHASE_COLUMNS.date) && days.length === 0) {
    const sample = rows.slice(0, 3).map((r) => `"${text(r, ...PURCHASE_COLUMNS.date)}"`).join(', ');
    problems.push(`no purchase date could be read (the first ones read ${sample}) — a date is never guessed`);
  }
  return { rows: rows.length, datedRows: days.length, ...(days.length === 0 ? {} : { oldest: days[0]!, newest: days[days.length - 1]! }), problems };
}

export const minusOneYear = (day: string): string => `${Number(day.slice(0, 4)) - 1}${day.slice(4)}`;

/** A CSV cell: quoted when it holds a comma, a quote or a line break. */
const csvCell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** A sheet a person opens in Excel: a UTF-8 byte-order mark first, or Excel shows "—" and Tamil names as "â€”". */
export const forExcel = (sheet: string): string => `\uFEFF${sheet}`;
export const csv = (header: readonly string[], rows: readonly (readonly string[])[]): string =>
  [header.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';

export function bpalToSlice(input: BpalSliceInput): BpalSliceOutput {
  const setAside: SetAside[] = [];
  const asideIds = new Set<string>();
  const putAside = (itemId: string, name: string, reason: string): void => { setAside.push({ itemId, name, reason }); asideIds.add(itemId); };

  // ── HSN and GST, per item: one reading, or set aside ───────────────────────────────────────────
  const hsnOf = new Map<string, { name: string; readings: Set<string>; hsn: string; gst: string; sold: number; cess: boolean }>();
  for (const r of input.hsnRows) {
    const id = text(r, 'Item Id');
    if (id === '') continue;
    const hsn = text(r, 'Hsn Code', 'HSN Code', 'HSN');
    const gst = text(r, 'Gst %', 'GST %', 'Gst%');
    const sold = Number(text(r, 'Item Quantity', 'Qty')) || 0;
    const cessPaise = rupeesToPaise(text(r, 'Cess Amt', 'Cess Amount') || '0') ?? 0;
    const addl = rupeesToPaise(text(r, 'Addl Cess Amt', 'AddlCess Amount') || '0') ?? 0;
    const e = hsnOf.get(id) ?? { name: text(r, 'Item Name'), readings: new Set<string>(), hsn, gst, sold: 0, cess: false };
    e.readings.add(`${hsn}|${gst}`);
    e.sold += sold;
    e.cess ||= cessPaise !== 0 || addl !== 0;
    hsnOf.set(id, e);
  }

  // OB-800: every item the old ERP names is accounted for — one the barcode or purchase report names but the HSN report does
  // not has no HSN to load at; it is set aside with that reason, never dropped.
  const namedElsewhere = new Map<string, string>();
  for (const r of [...input.eanRows, ...input.purchaseRows]) {
    const id = text(r, 'Item Id');
    if (id !== '' && !hsnOf.has(id) && !namedElsewhere.has(id)) namedElsewhere.set(id, text(r, 'Item Name'));
  }
  for (const [id, name] of namedElsewhere) putAside(id, name, 'not in the HSN report, so the old ERP gives it no HSN or GST rate — Finance sets them on the Import page');

  // ── every department (OB-800); the department from the HSN (the table above) ─────────────────────────────
  const dept = new Map<string, { name: string; hsn: string; gstBps: number; sold: number; department: StoreDepartment }>();
  for (const [id, e] of hsnOf) {
    const name = e.name;
    if (e.readings.size > 1) { putAside(id, name, `the old ERP gives this item two HSN / GST readings (${[...e.readings].map((x) => x.replace('|', ' at ') + '%').join(' and ')}) — which is right is a decision, not a default`); continue; }
    const department = departmentOf(e.hsn);
    if (department === undefined) { putAside(id, name, `the HSN "${e.hsn}" is not a 4, 6 or 8-digit code — Finance sets it on the Import page`); continue; }
    const elsewhere = setUpElsewhere(e.hsn);
    if (elsewhere !== undefined) { putAside(id, name, elsewhere); continue; }
    const gstBps = Math.round(Number(e.gst) * 100);
    if (e.gst === '' || !Number.isFinite(gstBps) || gstBps < 0) { putAside(id, name, `the GST rate "${e.gst}" is not a percent`); continue; }
    if (e.cess) { putAside(id, name, 'the old ERP charged cess on this item, and its cess rate is not in the export — a cess rate is never guessed'); continue; }
    dept.set(id, { name, hsn: e.hsn, gstBps, sold: e.sold, department });
  }

  // One HSN, one rate: an HSN whose items carry two rates is set aside whole (which rate is right is a decision).
  const ratesOfHsn = new Map<string, Set<number>>();
  for (const d of dept.values()) ratesOfHsn.set(d.hsn, (ratesOfHsn.get(d.hsn) ?? new Set()).add(d.gstBps));
  const hsnCheck: (readonly string[])[] = [];
  for (const [hsn, rates] of [...ratesOfHsn].sort(([a], [b]) => a.localeCompare(b))) {
    if (rates.size < 2) continue;
    for (const bps of [...rates].sort((a, b) => a - b)) {
      const items = [...dept].filter(([, d]) => d.hsn === hsn && d.gstBps === bps);
      hsnCheck.push([hsn, String(bps / 100), String(items.length), items.slice(0, 3).map(([id, d]) => `${id} ${d.name}`).join(' | ')]);
    }
  }
  for (const [id, d] of [...dept]) {
    const rates = ratesOfHsn.get(d.hsn)!;
    if (rates.size > 1) { putAside(id, d.name, `HSN ${d.hsn} has items at ${[...rates].map((b) => `${b / 100}%`).join(' and ')} in the old ERP — one HSN code, one rate`); dept.delete(id); }
  }

  // ── barcodes: a pack barcode with a right check digit; an item with none is not sold by barcode ──────────
  const codesOf = new Map<string, string[]>();
  const badCodes = new Map<string, string[]>();
  for (const r of input.eanRows) {
    const id = text(r, 'Item Id');
    if (!dept.has(id)) continue;
    const code = text(r, 'EanCode', 'EAN Code', 'Barcode');
    if (code === '') continue;
    if (isGtin(code)) { const list = codesOf.get(id) ?? []; if (!list.includes(code)) list.push(code); codesOf.set(id, list); } else (badCodes.get(id) ?? badCodes.set(id, []).get(id)!).push(code);
  }
  const codeOwners = new Map<string, string[]>();
  for (const [id, codes] of codesOf) for (const c of codes) codeOwners.set(c, [...(codeOwners.get(c) ?? []), id]);
  const LOOSE = 'if it is sold loose (by weight or by count), mark it so on the Import page, which loads it in kg or by the piece';
  for (const [id, d] of [...dept]) {
    const codes = codesOf.get(id) ?? [];
    const shared = codes.filter((c) => (codeOwners.get(c) ?? []).length > 1);
    if (shared.length > 0) { putAside(id, d.name, `barcode ${shared.join(', ')} also names another item in the old ERP — one barcode, one item`); dept.delete(id); continue; }
    if (codes.length === 0) {
      const bad = badCodes.get(id) ?? [];
      putAside(id, d.name, bad.length > 0 ? `no barcode with a right check digit (read: ${bad.join(', ')}) — scan the pack, or ${LOOSE}` : `no barcode in the old ERP — scan the pack, or ${LOOSE}`);
      dept.delete(id);
    }
  }

  // ── prices: the newest purchase in the last 12 months (OB-695) ──────────────────────────────────
  const since = minusOneYear(input.today);
  const newest = new Map<string, { day: string; no: number; mrp?: number; sell?: number; cost?: number }>();
  for (const r of input.purchaseRows) {
    const id = text(r, 'Item Id');
    if (!dept.has(id)) continue;
    const day = purchaseDay(text(r, ...PURCHASE_COLUMNS.date));
    if (day === undefined || day < since || day > input.today) continue;
    const no = Number(text(r, ...PURCHASE_COLUMNS.no)) || 0;
    const prev = newest.get(id);
    if (prev !== undefined && (prev.day > day || (prev.day === day && prev.no >= no))) continue;
    const mrp = rupeesToPaise(text(r, ...PURCHASE_COLUMNS.mrp));
    const sell = rupeesToPaise(text(r, ...PURCHASE_COLUMNS.sell));
    const cost = rupeesToPaise(text(r, ...PURCHASE_COLUMNS.cost));
    newest.set(id, { day, no, ...(mrp === undefined ? {} : { mrp }), ...(sell === undefined ? {} : { sell }), ...(cost === undefined ? {} : { cost }) });
  }
  const priced = new Map<string, { mrp: number; sell: number; cost: number }>();
  for (const [id, d] of [...dept]) {
    const p = newest.get(id);
    if (p === undefined) { putAside(id, d.name, `no purchase in the 12 months to ${input.today} — no price to load (OB-695)`); dept.delete(id); continue; }
    if (p.mrp === undefined || p.mrp <= 0 || p.sell === undefined || p.sell <= 0 || p.cost === undefined || p.cost <= 0) {
      putAside(id, d.name, `the newest purchase (${p.day}) has no usable MRP, selling price or cost — a blank price is never loaded as zero`); dept.delete(id); continue;
    }
    if (p.sell > p.mrp) { putAside(id, d.name, `the selling price ${paiseText(p.sell)} is above the MRP ${paiseText(p.mrp)} on the newest purchase (${p.day}) — MRP is the legal ceiling`); dept.delete(id); continue; }
    priced.set(id, { mrp: p.mrp, sell: p.sell, cost: p.cost });
  }

  // ── label facts (M03-FR-03): packed goods load with facts still to read (OB-738 · OB-811 B); loose foods wait ──
  const already = input.alreadyLoaded ?? new Set<string>();
  const facts: ReadonlyMap<string, Readonly<Partial<Record<LabelFact, string>>>> = input.labelFacts ?? new Map();
  const factOf = (id: string, k: LabelFact): string => (facts.get(id)?.[k] ?? '').trim();
  /** Every fact this item's department needs is read (OB-811 B: a shampoo is never asked for allergens). */
  const allRead = (id: string): boolean => labelFactsNeeded(dept.get(id)!.department).every((k) => factOf(id, k) !== '');
  const bySales = (a: string, b: string): number => (dept.get(b)!.sold - dept.get(a)!.sold) || a.localeCompare(b, 'en', { numeric: true });
  /** Every item not loaded yet that passed every other check — the staff's label-facts sheet lists all of them. */
  const waiting: string[] = [];
  const ready: string[] = [];
  let alreadyLoaded = 0;
  for (const id of [...dept.keys()].sort(bySales)) {
    if (already.has(id)) { alreadyLoaded += 1; continue; }
    waiting.push(id);
    const d = dept.get(id)!.department;
    const missing = labelFactsNeeded(d).filter((k) => factOf(id, k) === '');
    if (missing.length > 0 && !labelFactsMayFollowIn(d)) {
      putAside(id, dept.get(id)!.name, `${d.name}: the label facts ${missing.map((k) => k.replace(/_/g, ' ')).join(', ')} are not read yet — only packed goods may load before them (OB-738 · OB-811 B); fill label-facts.csv`);
      continue;
    }
    ready.push(id);
  }

  const hsnUsed = new Map<string, number>();
  for (const id of ready) hsnUsed.set(dept.get(id)!.hsn, dept.get(id)!.gstBps);
  const files = {
    'tax-classes.csv': csv(['hsn_code', 'effective_from', 'rate_percent'],
      [...hsnUsed].sort(([a], [b]) => a.localeCompare(b)).map(([h, bps]) => [h, input.ratesFrom, String(bps / 100)])),
    'products.csv': csv(['item_code', 'description', 'uom', 'category', 'hsn_code', 'status', ...LABEL_FACTS],
      ready.map((id) => { const d = dept.get(id)!; return [id, d.name, 'pcs', d.department.categoryId, d.hsn, 'active', ...LABEL_FACTS.map((k) => factOf(id, k))]; })),
    'prices.csv': csv(['item_code', 'mrp', 'selling_price', 'cost_price'],
      ready.map((id) => { const p = priced.get(id)!; return [id, paiseText(p.mrp), paiseText(p.sell), paiseText(p.cost)]; })),
    'barcodes.csv': csv(['item_code', 'barcode'], ready.flatMap((id) => codesOf.get(id)!.map((c) => [id, c]))),
  } as const;

  // The staff's working sheet: every item not yet loaded, best sellers first, the facts already filled kept in it — so
  // the same file is filled, saved and given back with --label-facts as often as needed, and nothing typed is lost.
  const labelFactsSheet = forExcel(csv(['item_code', 'description', 'department', 'barcode', 'sold_qty', ...LABEL_FACTS, 'all_facts_read'],
    waiting.map((id) => {
      const d = dept.get(id)!;
      return [id, d.name, d.department.name, codesOf.get(id)![0]!, String(d.sold), ...LABEL_FACTS.map((k) => factOf(id, k)), allRead(id) ? 'yes' : 'no'];
    })));
  setAside.sort((a, b) => a.itemId.localeCompare(b.itemId, 'en', { numeric: true }));
  const setAsideCsv = forExcel(csv(['item_code', 'description', 'reason'], setAside.map((s) => [s.itemId, s.name, s.reason])));
  const readyFollow = ready.filter((id) => !allRead(id));

  return {
    files, labelFactsSheet, setAsideCsv, setAside,
    hsnToCheckCsv: forExcel(csv(['hsn_code', 'rate_percent', 'items', 'for_example'], hsnCheck)),
    departments: departmentsNamed(ready.map((id) => dept.get(id)!.department.categoryId)),
    counts: {
      items: hsnOf.size + namedElsewhere.size, ready: ready.length, factsStillToRead: readyFollow.length,
      setAside: setAside.length, alreadyLoaded, barcodes: ready.reduce((n, id) => n + codesOf.get(id)!.length, 0), taxClasses: hsnUsed.size,
      byDepartment: Object.fromEntries(STORE_DEPARTMENTS.map((d) => [d.categoryId, ready.filter((id) => dept.get(id)!.department.categoryId === d.categoryId).length] as const).filter(([, n]) => n > 0)),
    },
  };
}

/** Read a CSV the staff saved from Excel (label-facts.csv, an earlier products.csv): header → rows of text. */
export function readCsv(textIn: string): SheetRow[] {
  const t = textIn.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false; } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i += 1; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (head === undefined) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

/** label-facts.csv as staff filled it → the facts per item code. */
export function labelFactsFrom(rows: readonly SheetRow[]): Map<string, Partial<Record<LabelFact, string>>> {
  const out = new Map<string, Partial<Record<LabelFact, string>>>();
  for (const r of rows) {
    const id = (r['item_code'] ?? '').trim();
    if (id === '') continue;
    out.set(id, Object.fromEntries(LABEL_FACTS.map((k) => [k, (r[k] ?? '').trim()])) as Partial<Record<LabelFact, string>>);
  }
  return out;
}
