// The old ERP (Bpal) exports → the four department-slice files (OB-241 · OB-276 · OB-693 · OB-694 · OB-695 · MG-05).
//
// The shop's old ERP has no item-master export with groups, prices and label facts in one place. Its three Excel
// reports carry the shop's own facts between them, and this turns them into the four published slice templates
// (packages/migration/src/slice-import.ts), for the ONE pilot department — packaged groceries. Nothing of the old ERP's
// design comes across: only each item's code, name, barcodes, HSN, GST rate and prices (owner, 6 Nov 2026).
//
//   EANCODE report         Item Id · Item Name · EanCode                      one row per barcode
//   HSN report             Item Id · Item Name · Hsn Code · Item Quantity · Gst % · … · Cess Amt
//   Product wise Detail    Purc Date · Purc No · Item Id · Item Name · … · NetCost · Selling · MRP · …   (12 months)
//
// The rules, each the owner's written decision:
//   • OB-694 — an item is in the department when its HSN is in chapters 07 08 09 10 11 12 15 17 18 19 20 21 (not 2105,
//     ice cream) or 22, or heading 0402 (milk powder) / 0409 (honey). Sold per piece (`pcs`): barcode only.
//   • OB-695 — its MRP, selling price and cost are those of its NEWEST purchase row in the last 12 months.
//   • A label fact a packed food must carry (M03-FR-03) is never invented: the packs are read by staff into
//     label-facts.csv (best sellers first, OB-696), and only an item whose five facts are all there is written into
//     products.csv. The rest wait in the sheet; a later load takes them.
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

export function inPilotDepartment(hsn: string): boolean {
  const h = hsn.trim();
  if (!/^\d{4}(\d{2}){0,2}$/.test(h)) return false;
  if (PILOT_HEADINGS_OUT.has(h.slice(0, 4))) return false;
  return PILOT_CHAPTERS.has(h.slice(0, 2)) || PILOT_HEADINGS_IN.has(h.slice(0, 4));
}

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
  /** The staff's label-facts sheet: every item not yet loaded, best sellers first, with what is filled (OB-696). */
  readonly labelFactsSheet: string;
  readonly setAsideCsv: string;
  /** For the accountant: each HSN whose items the old ERP taxes at more than one rate, with the items at each rate. */
  readonly hsnToCheckCsv: string;
  readonly setAside: readonly SetAside[];
  readonly counts: {
    readonly inDepartment: number; readonly ready: number; readonly waitingForLabelFacts: number;
    readonly setAside: number; readonly alreadyLoaded: number; readonly barcodes: number; readonly taxClasses: number;
  };
}

const text = (row: SheetRow, ...names: string[]): string => {
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
const paiseText = (p: number): string => (p / 100).toFixed(2);

/** A purchase date as the export wrote it: an Excel day number (46328) or dd/mm/yyyy, or yyyy-mm-dd → yyyy-mm-dd. */
export function purchaseDay(raw: string): string | undefined {
  const t = raw.trim();
  if (/^\d{5}(\.\d+)?$/.test(t)) {
    const ms = Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return undefined;
}

const minusOneYear = (day: string): string => `${Number(day.slice(0, 4)) - 1}${day.slice(4)}`;

/** A CSV cell: quoted when it holds a comma, a quote or a line break. */
const csvCell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = (header: readonly string[], rows: readonly (readonly string[])[]): string =>
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

  // ── the department (OB-694) ────────────────────────────────────────────────────────────────────
  const dept = new Map<string, { name: string; hsn: string; gstBps: number; sold: number }>();
  for (const [id, e] of hsnOf) {
    const hsns = [...e.readings].map((x) => x.split('|')[0]!);
    if (!hsns.some(inPilotDepartment)) continue;
    const name = e.name;
    if (e.readings.size > 1) { putAside(id, name, `the old ERP gives this item two HSN / GST readings (${[...e.readings].map((x) => x.replace('|', ' at ') + '%').join(' and ')}) — which is right is a decision, not a default`); continue; }
    if (!inPilotDepartment(e.hsn)) continue;
    const gstBps = Math.round(Number(e.gst) * 100);
    if (e.gst === '' || !Number.isFinite(gstBps) || gstBps < 0) { putAside(id, name, `the GST rate "${e.gst}" is not a percent`); continue; }
    if (e.cess) { putAside(id, name, 'the old ERP charged cess on this item, and its cess rate is not in the export — a cess rate is never guessed'); continue; }
    dept.set(id, { name, hsn: e.hsn, gstBps, sold: e.sold });
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
  for (const [id, d] of [...dept]) {
    const codes = codesOf.get(id) ?? [];
    const shared = codes.filter((c) => (codeOwners.get(c) ?? []).length > 1);
    if (shared.length > 0) { putAside(id, d.name, `barcode ${shared.join(', ')} also names another item in the old ERP — one barcode, one item`); dept.delete(id); continue; }
    if (codes.length === 0) {
      const bad = badCodes.get(id) ?? [];
      putAside(id, d.name, bad.length > 0 ? `no barcode with a right check digit (read: ${bad.join(', ')}) — the pilot sells by barcode only` : 'no barcode in the old ERP — the pilot sells by barcode only');
      dept.delete(id);
    }
  }

  // ── prices: the newest purchase in the last 12 months (OB-695) ──────────────────────────────────
  const since = minusOneYear(input.today);
  const newest = new Map<string, { day: string; no: number; mrp?: number; sell?: number; cost?: number }>();
  for (const r of input.purchaseRows) {
    const id = text(r, 'Item Id');
    if (!dept.has(id)) continue;
    const day = purchaseDay(text(r, 'Purc Date', 'Purchase Date'));
    if (day === undefined || day < since || day > input.today) continue;
    const no = Number(text(r, 'Purc No', 'Purchase No')) || 0;
    const prev = newest.get(id);
    if (prev !== undefined && (prev.day > day || (prev.day === day && prev.no >= no))) continue;
    const mrp = rupeesToPaise(text(r, 'MRP'));
    const sell = rupeesToPaise(text(r, 'Selling', 'Selling Rate'));
    const cost = rupeesToPaise(text(r, 'NetCost', 'Net Cost', 'Cost'));
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

  // ── label facts (M03-FR-03): only an item with all five is ready; the rest wait in the sheet ─────────
  const already = input.alreadyLoaded ?? new Set<string>();
  const facts = input.labelFacts ?? new Map();
  const ready: string[] = [];
  const waiting: string[] = [];
  let alreadyLoaded = 0;
  for (const id of dept.keys()) {
    if (already.has(id)) { alreadyLoaded += 1; continue; }
    const f = facts.get(id);
    if (f !== undefined && LABEL_FACTS.every((k) => (f[k] ?? '').trim() !== '')) ready.push(id); else waiting.push(id);
  }
  const bySales = (a: string, b: string): number => (dept.get(b)!.sold - dept.get(a)!.sold) || a.localeCompare(b, 'en', { numeric: true });
  ready.sort(bySales);
  waiting.sort(bySales);

  const hsnUsed = new Map<string, number>();
  for (const id of ready) hsnUsed.set(dept.get(id)!.hsn, dept.get(id)!.gstBps);
  const files = {
    'tax-classes.csv': csv(['hsn_code', 'effective_from', 'rate_percent'],
      [...hsnUsed].sort(([a], [b]) => a.localeCompare(b)).map(([h, bps]) => [h, input.ratesFrom, String(bps / 100)])),
    'products.csv': csv(['item_code', 'description', 'uom', 'category', 'hsn_code', 'status', ...LABEL_FACTS],
      ready.map((id) => { const d = dept.get(id)!; const f = facts.get(id)!; return [id, d.name, 'pcs', PILOT_CATEGORY_ID, d.hsn, 'active', ...LABEL_FACTS.map((k) => f[k]!.trim())]; })),
    'prices.csv': csv(['item_code', 'mrp', 'selling_price', 'cost_price'],
      ready.map((id) => { const p = priced.get(id)!; return [id, paiseText(p.mrp), paiseText(p.sell), paiseText(p.cost)]; })),
    'barcodes.csv': csv(['item_code', 'barcode'], ready.flatMap((id) => codesOf.get(id)!.map((c) => [id, c]))),
  } as const;

  // The staff's working sheet: every item not yet loaded, best sellers first, the facts already filled kept in it — so
  // the same file is filled, saved and given back with --label-facts as often as needed, and nothing typed is lost.
  const labelFactsSheet = csv(['item_code', 'description', 'barcode', 'sold_qty', ...LABEL_FACTS, 'ready'],
    [...ready, ...waiting].sort(bySales).map((id) => {
      const d = dept.get(id)!; const f = facts.get(id) ?? {};
      return [id, d.name, codesOf.get(id)![0]!, String(d.sold), ...LABEL_FACTS.map((k) => (f[k] ?? '').trim()), ready.includes(id) ? 'yes' : 'no'];
    }));
  setAside.sort((a, b) => a.itemId.localeCompare(b.itemId, 'en', { numeric: true }));
  const setAsideCsv = csv(['item_code', 'description', 'reason'], setAside.map((s) => [s.itemId, s.name, s.reason]));

  return {
    files, labelFactsSheet, setAsideCsv, setAside,
    hsnToCheckCsv: csv(['hsn_code', 'rate_percent', 'items', 'for_example'], hsnCheck),
    counts: {
      inDepartment: dept.size + [...asideIds].length, ready: ready.length, waitingForLabelFacts: waiting.length,
      setAside: setAside.length, alreadyLoaded, barcodes: ready.reduce((n, id) => n + codesOf.get(id)!.length, 0), taxClasses: hsnUsed.size,
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
