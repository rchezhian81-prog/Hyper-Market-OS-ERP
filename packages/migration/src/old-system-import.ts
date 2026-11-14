// Import from the old system, with every gap FIXED in the new one (owner, 7 Nov 2026, OB-704) — the rules, pure and tested.
//
// The old ERP (Bpal) gives the shop's item facts in three Excel reports, and they carry gaps: barcodes with a wrong
// check digit or none, one HSN taxed at two GST rates, prices missing or above MRP, and none of the five label facts a
// packed food must carry (M03-FR-03). The owner's decision: the gaps are not carried. Each is fixed here, by the person
// whose job it is, and every fix is kept with who, when, the old value and the new one (P-04 · hard rule #2: a fix is a
// new fact, never an overwrite; the latest fix of a kind for an item is the one that applies).
//
//   analyseOldSystem   the reports → the department's items as the old ERP reads them (no fix applied yet)
//   resolveImport      items + fixes → each item as it would load, with its remaining GAPS (empty: ready) and the
//                      label FACTS STILL TO READ (OB-733: not a gap — the item loads, sells at the till only, listed)
//   validateFix        what a fix may say (a barcode must be a real GTIN, a price must not exceed MRP …)
//   sliceFilesFor      the ready items → the four published slice files (then sealed, staged, accepted, applied
//                      exactly as `migration:slice` does — MG-02 · MG-05 · MG-06)
//
// Who may fix what is the API's (services/migration/src/old-system-imports.ts): a GST rate only Finance (the accountant
// or the owner, `catalogue.tax.approve`); a barcode, a price, a label fact or "not in this department" whoever runs the
// load (`migration.load.record`). Nothing here is guessed: an item with any gap left is not written.
//
// OB-733 (owner, 14 Nov 2026, "1A", replacing OB-696; option A "sell at the till only"): a missing label fact is NOT a
// gap. The item loads with the fact blank (never "none", never a guess) and head office lists it until it is read off the
// pack; meanwhile it is sold at the till only — never online or by scan-and-go. A label fix may give some of the five
// facts; each fact keeps the latest value given, and a fact once read is corrected, never blanked.

import {
  cellOf, csv, inPilotDepartment, isGtin, LABEL_FACTS, minusOneYear, paiseText, PILOT_CATEGORY_ID, PURCHASE_COLUMNS,
  purchaseDay, rupeesToPaise, type LabelFact, type SheetRow,
} from './bpal-slice';

/** One item of the pilot department, as the old ERP reads it. */
export interface OldItem {
  readonly itemId: string;
  readonly name: string;
  /** Quantity sold in the HSN report's period — best sellers come first everywhere. */
  readonly sold: number;
  /** Every (HSN, GST basis points) reading the old ERP gives this item. One is clean; two is a gap. */
  readonly taxReadings: readonly { readonly hsn: string; readonly gstBps: number | null }[];
  readonly cess: boolean;
  /** Barcodes with a right check digit, and the ones without. */
  readonly barcodes: readonly string[];
  readonly badBarcodes: readonly string[];
  /** The newest purchase in the 12 months (OB-695), or none. */
  readonly price?: { readonly day: string; readonly mrp?: number; readonly sell?: number; readonly cost?: number };
}

export type FixKind = 'barcode' | 'tax' | 'price' | 'label' | 'exclude';

/** One person's fix to one item — kept for ever; the latest of a kind for an item applies. */
export interface ImportFix {
  readonly importId: string;
  readonly itemId: string;
  readonly kind: FixKind;
  /** barcode: { barcodes: string[] } · tax: { hsn, gstPercent } · price: { mrp, sell, cost } (rupees) ·
   *  label: { allergens, country_of_origin, net_quantity, packer, consumer_care } · exclude: { excluded: boolean } */
  readonly value: Readonly<Record<string, unknown>>;
  readonly reason: string;
  readonly by: string;
  readonly at: string;
}

/** What stops an item loading. A label fact never does (OB-733) — see `ResolvedItem.factsToRead`. */
export type GapKind = 'barcode' | 'tax' | 'price';
export interface Gap { readonly kind: GapKind; readonly why: string }

export interface ResolvedItem {
  readonly itemId: string;
  readonly name: string;
  readonly sold: number;
  readonly excluded: boolean;
  readonly loaded: boolean;
  readonly barcodes: readonly string[];
  readonly hsn?: string;
  readonly gstBps?: number;
  readonly price?: { readonly mrp: number; readonly sell: number; readonly cost: number };
  readonly facts: Readonly<Partial<Record<LabelFact, string>>>;
  /** OB-733: the label facts not read off the pack yet — not a blocker; listed, best sellers first, until filled. */
  readonly factsToRead: readonly LabelFact[];
  readonly gaps: readonly Gap[];
  /** The fixes that apply now, by kind — so a screen can say who fixed what. */
  readonly fixedBy: Readonly<Partial<Record<FixKind, { readonly by: string; readonly at: string }>>>;
}

// ── the reports → the department's items ─────────────────────────────────────────────────────────────

export interface OldSystemAnalysis {
  readonly items: readonly OldItem[];
  readonly counts: { readonly hsnItems: number; readonly inDepartment: number; readonly purchaseRows: number };
}

export function analyseOldSystem(input: {
  readonly eanRows: readonly SheetRow[]; readonly hsnRows: readonly SheetRow[]; readonly purchaseRows: readonly SheetRow[]; readonly today: string;
}): OldSystemAnalysis {
  const byId = new Map<string, { name: string; readings: Map<string, { hsn: string; gstBps: number | null }>; sold: number; cess: boolean }>();
  for (const r of input.hsnRows) {
    const id = cellOf(r, 'Item Id');
    if (id === '') continue;
    const hsn = cellOf(r, 'Hsn Code', 'HSN Code', 'HSN');
    const gstText = cellOf(r, 'Gst %', 'GST %', 'Gst%');
    const gst = Number(gstText);
    const gstBps = gstText !== '' && Number.isFinite(gst) && gst >= 0 ? Math.round(gst * 100) : null;
    const e = byId.get(id) ?? { name: cellOf(r, 'Item Name'), readings: new Map(), sold: 0, cess: false };
    e.readings.set(`${hsn}|${gstBps}`, { hsn, gstBps });
    e.sold += Number(cellOf(r, 'Item Quantity', 'Qty')) || 0;
    const cess = (rupeesToPaise(cellOf(r, 'Cess Amt', 'Cess Amount') || '0') ?? 0) !== 0 || (rupeesToPaise(cellOf(r, 'Addl Cess Amt', 'AddlCess Amount') || '0') ?? 0) !== 0;
    e.cess ||= cess;
    byId.set(id, e);
  }
  const dept = new Map([...byId].filter(([, e]) => [...e.readings.values()].some((x) => inPilotDepartment(x.hsn))));

  const codes = new Map<string, string[]>();
  const bad = new Map<string, string[]>();
  for (const r of input.eanRows) {
    const id = cellOf(r, 'Item Id');
    if (!dept.has(id)) continue;
    const code = cellOf(r, 'EanCode', 'EAN Code', 'Barcode');
    if (code === '') continue;
    const into = isGtin(code) ? codes : bad;
    const list = into.get(id) ?? [];
    if (!list.includes(code)) list.push(code);
    into.set(id, list);
  }

  const since = minusOneYear(input.today);
  const newest = new Map<string, { day: string; no: number; mrp?: number; sell?: number; cost?: number }>();
  for (const r of input.purchaseRows) {
    const id = cellOf(r, 'Item Id');
    if (!dept.has(id)) continue;
    const day = purchaseDay(cellOf(r, ...PURCHASE_COLUMNS.date));
    if (day === undefined || day < since || day > input.today) continue;
    const no = Number(cellOf(r, ...PURCHASE_COLUMNS.no)) || 0;
    const prev = newest.get(id);
    if (prev !== undefined && (prev.day > day || (prev.day === day && prev.no >= no))) continue;
    const mrp = rupeesToPaise(cellOf(r, ...PURCHASE_COLUMNS.mrp));
    const sell = rupeesToPaise(cellOf(r, ...PURCHASE_COLUMNS.sell));
    const cost = rupeesToPaise(cellOf(r, ...PURCHASE_COLUMNS.cost));
    newest.set(id, { day, no, ...(mrp === undefined ? {} : { mrp }), ...(sell === undefined ? {} : { sell }), ...(cost === undefined ? {} : { cost }) });
  }

  const items: OldItem[] = [...dept].map(([itemId, e]) => {
    const p = newest.get(itemId);
    return {
      itemId, name: e.name.trim(), sold: e.sold, taxReadings: [...e.readings.values()], cess: e.cess,
      barcodes: codes.get(itemId) ?? [], badBarcodes: bad.get(itemId) ?? [],
      ...(p === undefined ? {} : { price: { day: p.day, ...(p.mrp === undefined ? {} : { mrp: p.mrp }), ...(p.sell === undefined ? {} : { sell: p.sell }), ...(p.cost === undefined ? {} : { cost: p.cost }) } }),
    };
  }).sort((a, b) => (b.sold - a.sold) || a.itemId.localeCompare(b.itemId, 'en', { numeric: true }));
  return { items, counts: { hsnItems: byId.size, inDepartment: items.length, purchaseRows: input.purchaseRows.length } };
}

// ── what a fix may say ───────────────────────────────────────────────────────────────────────────────

const money = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : typeof v === 'string' ? rupeesToPaise(v) : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Why this fix cannot be kept — empty when it can. A fix is refused, never trimmed into something else. */
export function validateFix(kind: FixKind, value: Readonly<Record<string, unknown>>, reason: string): string[] {
  const problems: string[] = [];
  if (reason.trim().length < 3) problems.push('say why, in a few words (for example "read off the pack")');
  switch (kind) {
    case 'barcode': {
      const list = Array.isArray(value['barcodes']) ? (value['barcodes'] as unknown[]).map(str).filter((c) => c !== '') : [];
      if (list.length === 0) problems.push('give at least one barcode, as printed on the pack');
      for (const c of list) if (!isGtin(c)) problems.push(`${c} is not a pack barcode: 8, 12, 13 or 14 digits with a right check digit — scan it again`);
      if (new Set(list).size !== list.length) problems.push('the same barcode is given twice');
      break;
    }
    case 'tax': {
      const hsn = str(value['hsn']);
      const gst = typeof value['gstPercent'] === 'number' ? value['gstPercent'] : Number(str(value['gstPercent']));
      if (!/^\d{4}(\d{2}){0,2}$/.test(hsn)) problems.push('the HSN code must be 4, 6 or 8 digits');
      else if (!inPilotDepartment(hsn)) problems.push(`HSN ${hsn} is not packaged food or beverages (OB-694) — to leave the item out, mark it "not in this department" instead`);
      if (!Number.isFinite(gst) || ![0, 0.25, 3, 5, 12, 18, 28, 40].includes(gst)) problems.push('the GST rate must be one of the slabs: 0, 0.25, 3, 5, 12, 18, 28 or 40 %');
      break;
    }
    case 'price': {
      const mrp = money(value['mrp']); const sell = money(value['sell']); const cost = money(value['cost']);
      if (mrp === undefined || mrp <= 0) problems.push('the MRP must be an amount in rupees above zero, as printed on the pack');
      if (sell === undefined || sell <= 0) problems.push('the selling price must be an amount in rupees above zero');
      if (cost === undefined || cost <= 0) problems.push('the cost must be an amount in rupees above zero');
      if (mrp !== undefined && sell !== undefined && sell > mrp) problems.push('the selling price is above the MRP — MRP is the legal ceiling');
      break;
    }
    case 'label': {
      // OB-733: any of the five may be given now and the rest later; a blank one stays "still to read" (never "none").
      if (LABEL_FACTS.every((k) => str(value[k]) === '')) problems.push('give at least one label fact as the pack prints it (allergens: write "none" only when the pack declares none)');
      for (const k of Object.keys(value)) if (!(LABEL_FACTS as readonly string[]).includes(k)) problems.push(`"${k}" is not one of the five label facts`);
      break;
    }
    case 'exclude':
      if (typeof value['excluded'] !== 'boolean') problems.push('say whether the item is left out (true) or taken back in (false)');
      break;
  }
  return problems;
}

// ── items + fixes → as each would load, with the gaps left ───────────────────────────────────────────

export function resolveImport(items: readonly OldItem[], fixes: readonly ImportFix[], loaded: ReadonlySet<string> = new Set()): ResolvedItem[] {
  const latest = new Map<string, ImportFix>();
  for (const f of [...fixes].sort((a, b) => a.at.localeCompare(b.at))) latest.set(`${f.itemId}|${f.kind}`, f);
  const fixOf = (id: string, kind: FixKind): ImportFix | undefined => latest.get(`${id}|${kind}`);
  const labelFixes = new Map<string, ImportFix[]>();
  for (const f of [...fixes].sort((a, b) => a.at.localeCompare(b.at))) if (f.kind === 'label') labelFixes.set(f.itemId, [...(labelFixes.get(f.itemId) ?? []), f]);
  const labelFixesOf = (id: string): readonly ImportFix[] => labelFixes.get(id) ?? [];

  const draft = items.map((it) => {
    const gaps: Gap[] = [];
    const fixedBy: Partial<Record<FixKind, { by: string; at: string }>> = {};
    const mark = (f: ImportFix | undefined): void => { if (f !== undefined) fixedBy[f.kind] = { by: f.by, at: f.at }; };
    const ex = fixOf(it.itemId, 'exclude'); mark(ex);
    const excluded = ex?.value['excluded'] === true;

    const bf = fixOf(it.itemId, 'barcode'); mark(bf);
    const barcodes = bf !== undefined ? (bf.value['barcodes'] as string[]).map((c) => c.trim()) : [...it.barcodes];
    if (barcodes.length === 0) gaps.push({ kind: 'barcode', why: it.badBarcodes.length > 0 ? `the old ERP's barcode ${it.badBarcodes.join(', ')} has a wrong check digit — scan the pack` : 'the old ERP has no barcode for it — scan the pack' });

    const tf = fixOf(it.itemId, 'tax'); mark(tf);
    let hsn: string | undefined; let gstBps: number | undefined;
    if (tf !== undefined) { hsn = String(tf.value['hsn']).trim(); gstBps = Math.round(Number(tf.value['gstPercent']) * 100); }
    else if (it.cess) gaps.push({ kind: 'tax', why: 'the old ERP charged cess on it, and the cess rate is not in its export — Finance confirms the GST rate (cess is not loaded in the pilot)' });
    else if (it.taxReadings.length !== 1) gaps.push({ kind: 'tax', why: `the old ERP gives it ${it.taxReadings.length} HSN/GST readings (${it.taxReadings.map((r) => `${r.hsn} at ${r.gstBps === null ? '?' : r.gstBps / 100}%`).join(', ')}) — Finance decides which is right` });
    else if (it.taxReadings[0]!.gstBps === null) gaps.push({ kind: 'tax', why: 'the old ERP gives no GST rate — Finance sets it' });
    else if (!inPilotDepartment(it.taxReadings[0]!.hsn)) gaps.push({ kind: 'tax', why: `HSN ${it.taxReadings[0]!.hsn} is not packaged food — Finance confirms the HSN, or mark it "not in this department"` });
    else { hsn = it.taxReadings[0]!.hsn; gstBps = it.taxReadings[0]!.gstBps; }

    const pf = fixOf(it.itemId, 'price'); mark(pf);
    let price: { mrp: number; sell: number; cost: number } | undefined;
    if (pf !== undefined) price = { mrp: money(pf.value['mrp'])!, sell: money(pf.value['sell'])!, cost: money(pf.value['cost'])! };
    else if (it.price === undefined) gaps.push({ kind: 'price', why: 'not bought in the last 12 months, so the old ERP gives no price — type the MRP, selling price and cost' });
    else if (it.price.mrp === undefined || it.price.sell === undefined || it.price.cost === undefined || it.price.mrp <= 0 || it.price.sell <= 0 || it.price.cost <= 0) gaps.push({ kind: 'price', why: `the newest purchase (${it.price.day}) has no usable MRP, selling price or cost — type them` });
    else if (it.price.sell > it.price.mrp) gaps.push({ kind: 'price', why: `the old ERP's selling price ${paiseText(it.price.sell)} is above its MRP ${paiseText(it.price.mrp)} (${it.price.day}) — type the right figures` });
    else price = { mrp: it.price.mrp, sell: it.price.sell, cost: it.price.cost };

    // OB-733: each fact keeps the latest value any label fix gave it (a blank in a later fix never unreads it). A fact not
    // read yet is listed, not a gap.
    const lf = fixOf(it.itemId, 'label'); mark(lf);
    const facts: Partial<Record<LabelFact, string>> = {};
    for (const f of labelFixesOf(it.itemId)) for (const k of LABEL_FACTS) { const v = str(f.value[k]); if (v !== '') facts[k] = v; }
    const factsToRead = LABEL_FACTS.filter((k) => (facts[k] ?? '') === '');

    return { it, excluded, barcodes, hsn, gstBps, price, facts, factsToRead, gaps, fixedBy };
  });

  // Across items: a barcode names one item, and an HSN carries one rate (the tax class is the HSN).
  const live = draft.filter((d) => !d.excluded);
  const owners = new Map<string, string[]>();
  for (const d of live) for (const c of d.barcodes) owners.set(c, [...(owners.get(c) ?? []), d.it.itemId]);
  const ratesOf = new Map<string, Set<number>>();
  for (const d of live) if (d.hsn !== undefined && d.gstBps !== undefined) ratesOf.set(d.hsn, (ratesOf.get(d.hsn) ?? new Set()).add(d.gstBps));

  return draft.map((d) => {
    const gaps = [...d.gaps];
    if (!d.excluded) {
      const shared = d.barcodes.filter((c) => (owners.get(c) ?? []).length > 1);
      if (shared.length > 0) gaps.push({ kind: 'barcode', why: `barcode ${shared.join(', ')} is also on item ${shared.flatMap((c) => owners.get(c)!.filter((o) => o !== d.it.itemId)).join(', ')} — one barcode names one item` });
      const rates = d.hsn === undefined ? undefined : ratesOf.get(d.hsn);
      if (rates !== undefined && rates.size > 1 && !gaps.some((g) => g.kind === 'tax')) {
        gaps.push({ kind: 'tax', why: `HSN ${d.hsn} carries ${[...rates].sort((a, b) => a - b).map((b) => `${b / 100}%`).join(' and ')} across items — one HSN, one rate: Finance confirms this item's HSN and rate` });
      }
    }
    return {
      itemId: d.it.itemId, name: d.it.name, sold: d.it.sold, excluded: d.excluded, loaded: loaded.has(d.it.itemId),
      barcodes: d.barcodes, ...(d.hsn === undefined ? {} : { hsn: d.hsn }), ...(d.gstBps === undefined ? {} : { gstBps: d.gstBps }),
      ...(d.price === undefined ? {} : { price: d.price }), facts: d.facts, factsToRead: d.excluded ? [] : d.factsToRead, gaps: d.excluded ? [] : gaps, fixedBy: d.fixedBy,
    };
  });
}

/** Ready: in the department, not loaded yet, no gap left. Label facts still to read do not hold it back (OB-733). */
export const isReady = (r: ResolvedItem): boolean => !r.excluded && !r.loaded && r.gaps.length === 0;

// ── the ready items → the four published slice files ────────────────────────────────────────────────

export function sliceFilesFor(ready: readonly ResolvedItem[], ratesFrom: string): Record<'tax-classes.csv' | 'products.csv' | 'prices.csv' | 'barcodes.csv', string> {
  const rates = new Map<string, number>();
  for (const r of ready) rates.set(r.hsn!, r.gstBps!);
  return {
    'tax-classes.csv': csv(['hsn_code', 'effective_from', 'rate_percent'], [...rates].sort(([a], [b]) => a.localeCompare(b)).map(([h, b]) => [h, ratesFrom, String(b / 100)])),
    'products.csv': csv(['item_code', 'description', 'uom', 'category', 'hsn_code', 'status', ...LABEL_FACTS],
      // OB-733: a fact not read yet is written BLANK — the loader lets it follow and head office lists it; never "none".
      ready.map((r) => [r.itemId, r.name, 'pcs', PILOT_CATEGORY_ID, r.hsn!, 'active', ...LABEL_FACTS.map((k) => r.facts[k] ?? '')])),
    'prices.csv': csv(['item_code', 'mrp', 'selling_price', 'cost_price'], ready.map((r) => [r.itemId, paiseText(r.price!.mrp), paiseText(r.price!.sell), paiseText(r.price!.cost)])),
    'barcodes.csv': csv(['item_code', 'barcode'], ready.flatMap((r) => r.barcodes.map((c) => [r.itemId, c]))),
  };
}

/**
 * The counts a screen shows at the top: how many items wait on each kind of fix, how many are ready, and — not a blocker
 * (OB-733) — how many in the department, loaded or not, still have label facts to read off the pack.
 */
export function importSummary(resolved: readonly ResolvedItem[]): { readonly items: number; readonly ready: number; readonly loaded: number; readonly excluded: number; readonly gaps: Readonly<Record<GapKind, number>>; readonly factsToRead: number } {
  const gaps: Record<GapKind, number> = { barcode: 0, tax: 0, price: 0 };
  for (const r of resolved) if (!r.excluded && !r.loaded) for (const k of new Set(r.gaps.map((g) => g.kind))) gaps[k] += 1;
  return {
    items: resolved.length, ready: resolved.filter(isReady).length, loaded: resolved.filter((r) => r.loaded).length, excluded: resolved.filter((r) => r.excluded).length, gaps,
    factsToRead: resolved.filter((r) => !r.excluded && r.factsToRead.length > 0).length,
  };
}
