// GSTR-1 from the store's own till sales (roadmap v2.1 A5, M23·M12). The write path in `gst-returns.ts`
// lets a document's tax lines be RECORDED and the return folded from them — but a hypermarket's real
// outward supplies are the thousands of B2C counter sales the till already banks, and nobody is going to
// re-key each one as an outward-supply document. This turns those banked sales INTO the return.
//
// The obstacle it solves: a banked sale line carries what the till charged — the MRP-INCLUSIVE line total —
// but not the HSN or the tax split (those live on the M03 product master, not on the sale). So this needs
// two things per product to file it: the **HSN** and the **GST rate**. Both are supplied by the CALLER as a
// product→tax table (the house idiom — a constraint is DATA the caller supplies, never inferred), which is
// also the honest, freeze-safe answer to "capture the tax facts as they were": the filer states the mapping
// they are filing this period under, rather than this re-deriving it from a master that may have moved.
//
// From there it is the tested tax primitive: `extractInclusiveGst` pulls the GST BACK OUT of each
// MRP-inclusive line total (A9 — the tax is already inside the price), split by place of supply (A8 — a
// counter sale is intra-State: CGST + SGST). A product that sold but is NOT in the tax table, or whose HSN
// is malformed, is surfaced as a visible `unmapped` row (P-08 / hard rule #10) — counted and named, never
// silently dropped from the return. Pure and deterministic; the aggregation reuses `gstr1Table12`.

import { extractInclusiveGst, InvalidInclusiveTaxInput, type PlaceOfSupply } from './inclusive-tax';
import { validateHsnForTurnover, InvalidHsnInput } from './hsn';
import { gstr1Table12, type OutwardSupplyLine, type ClassifiedLine, type Gstr1Table12, type HsnSummaryRow } from './gstr1';

/** A sold line as it appears on a banked `SaleCommitted` event: what the till actually charged. */
export interface SoldTaxLine {
  readonly productId: string;
  readonly quantityMinor: number;
  readonly uom: string;
  /** The MRP-inclusive amount the till charged for the whole line (paisa). The GST is inside it (A9). */
  readonly lineTotalMinor: number;
  /** The HSN the till priced this line under, FROZEN at the time of supply. When present (with `rateBps`)
   *  it is used instead of the period tax table — so a product whose rate/HSN changed mid-period files each
   *  sale under what actually applied when it was sold. Absent on tills that do not yet stamp it. */
  readonly hsnCode?: string;
  /** The GST rate (bps) the till charged, frozen at the time of supply. Used with `hsnCode` above. */
  readonly rateBps?: number;
}

/** The filer's product→tax mapping for the period: the HSN and rate this product is filed under. */
export interface ProductTaxInfo {
  readonly hsnCode: string;
  readonly rateBps: number;
  /** Override the return-wide place of supply for this product (rare for counter sales). */
  readonly placeOfSupply?: PlaceOfSupply;
}

export interface ProductTaxEntry extends ProductTaxInfo {
  readonly productId: string;
}

export type UnmappedReason = 'no_tax_mapping' | 'invalid_hsn' | 'cannot_split_tax';

/** A product that sold in the period but could not be placed on the return — surfaced, never dropped. */
export interface UnmappedProduct {
  readonly productId: string;
  readonly quantityMinor: number;
  readonly lineTotalMinor: number;
  readonly reason: UnmappedReason;
  readonly detail: string;
}

export interface SalesToOutwardResult {
  /** Every filable sold line as a classified (b2c) outward-supply line — folds into the return. */
  readonly lines: readonly ClassifiedLine[];
  readonly table12: Gstr1Table12;
  /** Products that sold but are not filable yet (no mapping / bad HSN), one row each. */
  readonly unmapped: readonly UnmappedProduct[];
  readonly mappedLineCount: number;
  /** Of the filed lines, how many used a rate/HSN FROZEN on the sale line rather than the period tax table. */
  readonly frozenLineCount: number;
  readonly detail: string;
}

export class InvalidSalesToOutwardInput extends Error {
  constructor(detail: string) {
    super(`Cannot build GSTR-1 from sales: ${detail}`);
    this.name = 'InvalidSalesToOutwardInput';
  }
}

/**
 * Turn banked B2C till sales into GSTR-1 outward-supply lines and the Table-12 HSN summary, pulling the GST
 * out of each MRP-inclusive line total against a caller-supplied product→{HSN, rate} table. A counter sale
 * is B2C and intra-State by default (overridable). A product with no mapping or a malformed HSN is returned
 * in `unmapped` (aggregated per product), never silently excluded from the return.
 *
 * @throws InvalidSalesToOutwardInput if the turnover is not a whole non-negative number (it sets the HSN
 *   digit rule), or the default place of supply is neither intra_state nor inter_state.
 */
export function salesToOutwardSupplies(input: {
  readonly sales: readonly SoldTaxLine[];
  readonly taxTable: readonly ProductTaxEntry[];
  readonly annualTurnoverMinor: number;
  /** Place of supply for lines that do not override it. Default 'intra_state' (a walk-in counter sale). */
  readonly placeOfSupply?: PlaceOfSupply;
}): SalesToOutwardResult {
  if (!Number.isInteger(input.annualTurnoverMinor) || input.annualTurnoverMinor < 0) {
    throw new InvalidSalesToOutwardInput('annualTurnoverMinor must be a whole non-negative number of paisa');
  }
  const defaultPos: PlaceOfSupply = input.placeOfSupply ?? 'intra_state';
  if (defaultPos !== 'intra_state' && defaultPos !== 'inter_state') {
    throw new InvalidSalesToOutwardInput("placeOfSupply must be 'intra_state' or 'inter_state'");
  }

  const table = new Map<string, ProductTaxInfo>();
  for (const e of input.taxTable) table.set(e.productId, e);

  const lines: ClassifiedLine[] = [];
  const unmappedAcc = new Map<string, { quantityMinor: number; lineTotalMinor: number; reason: UnmappedReason; detail: string }>();
  const addUnmapped = (l: SoldTaxLine, reason: UnmappedReason, detail: string): void => {
    const row = unmappedAcc.get(l.productId) ?? { quantityMinor: 0, lineTotalMinor: 0, reason, detail };
    row.quantityMinor += l.quantityMinor;
    row.lineTotalMinor += l.lineTotalMinor;
    unmappedAcc.set(l.productId, row);
  };

  let frozenLineCount = 0;
  for (const l of input.sales) {
    // A line that carries its OWN tax facts (frozen at the time of supply) wins over the period table —
    // that is what makes a mid-period rate/HSN change file correctly. Both must be present and well-formed.
    const frozen = typeof l.hsnCode === 'string' && l.hsnCode !== '' && Number.isInteger(l.rateBps) && (l.rateBps as number) >= 0;
    const info: ProductTaxInfo | undefined = frozen ? { hsnCode: l.hsnCode as string, rateBps: l.rateBps as number } : table.get(l.productId);
    if (info === undefined) {
      addUnmapped(l, 'no_tax_mapping', 'sold with no HSN/rate on the sale line and none in the catalogue/tax table');
      continue;
    }
    if (frozen) frozenLineCount += 1;
    try {
      const v = validateHsnForTurnover({ hsnCode: info.hsnCode, annualTurnoverMinor: input.annualTurnoverMinor });
      if (!v.valid) { addUnmapped(l, 'invalid_hsn', `HSN rejected (${v.detail})`); continue; }
    } catch (e) {
      addUnmapped(l, 'invalid_hsn', e instanceof InvalidHsnInput ? e.message : 'HSN malformed'); continue;
    }
    const pos = info.placeOfSupply ?? defaultPos;
    let taxableMinor: number, cgstMinor = 0, sgstMinor = 0, igstMinor = 0;
    try {
      const gst = extractInclusiveGst({ mrpMinor: l.lineTotalMinor, rateBps: info.rateBps, placeOfSupply: pos });
      taxableMinor = gst.taxableMinor;
      for (const c of gst.components) {
        if (c.component === 'CGST') cgstMinor = c.amountMinor;
        else if (c.component === 'SGST') sgstMinor = c.amountMinor;
        else igstMinor = c.amountMinor;
      }
    } catch (e) {
      addUnmapped(l, 'cannot_split_tax', e instanceof InvalidInclusiveTaxInput ? e.message : 'tax could not be split'); continue;
    }
    const line: OutwardSupplyLine = {
      hsnCode: info.hsnCode, quantityMinor: l.quantityMinor, uom: l.uom,
      taxableMinor, rateBps: info.rateBps, cgstMinor, sgstMinor, igstMinor,
    };
    lines.push({ ...line, supplyKind: 'b2c' });
  }

  const unmapped: UnmappedProduct[] = [...unmappedAcc.entries()]
    .map(([productId, r]) => ({ productId, ...r }))
    .sort((a, b) => a.productId.localeCompare(b.productId));
  const table12 = gstr1Table12(lines);
  return {
    lines,
    table12,
    unmapped,
    mappedLineCount: lines.length,
    frozenLineCount,
    detail: `${lines.length} sold line(s) filed across ${table12.rows.length} HSN/rate row(s)${frozenLineCount > 0 ? ` (${frozenLineCount} at a rate frozen on the sale)` : ''}; taxable ${table12.totalTaxableMinor}, tax ${table12.totalTaxMinor}${unmapped.length > 0 ? `; ${unmapped.length} product(s) unmapped and NOT on the return` : ''}`,
  };
}

// --- Netting returns (credit notes) against the outward supplies (A5, CGST s.34) -------------------
//
// A GSTR-1 for B2C reports outward supplies NET of the credit notes for returns issued in the period: a
// return reverses the tax in the proportion it was charged, so the liability falls. Both sides are the same
// shape — a returned line is just an outward supply reversed — so `salesToOutwardSupplies` produces BOTH the
// sales Table-12 and the returns Table-12 (from the returned lines), and this nets them per HSN/rate. A
// return declared in a period whose original sale is not on file, or whose line has no HSN, surfaces as
// `unmapped` on the returns side exactly as a sale does — never silently dropped.

export interface NetHsnRow {
  readonly hsnCode: string;
  readonly rateBps: number;
  readonly salesTaxableMinor: number;
  readonly salesTaxMinor: number;
  readonly returnsTaxableMinor: number;
  readonly returnsTaxMinor: number;
  /** sales − returns, the figure filed for this HSN/rate. May be negative if returns exceed sales. */
  readonly netTaxableMinor: number;
  readonly netTaxMinor: number;
}

export interface NetGstr1Table12 {
  readonly rows: readonly NetHsnRow[];
  readonly salesTaxableMinor: number;
  readonly salesTaxMinor: number;
  readonly returnsTaxableMinor: number;
  readonly returnsTaxMinor: number;
  readonly netTaxableMinor: number;
  readonly netTaxMinor: number;
  readonly detail: string;
}

const rowTax = (r: HsnSummaryRow): number => r.cgstMinor + r.sgstMinor + r.igstMinor;

/**
 * Net a returns Table-12 against a sales Table-12, per HSN/rate: the filed taxable value and tax are
 * `sales − returns`. Rows present on either side appear, ordered by HSN then rate (stable, diffable). Pure.
 */
export function netTable12(sales: Gstr1Table12, returns: Gstr1Table12): NetGstr1Table12 {
  const acc = new Map<string, { hsnCode: string; rateBps: number; salesTaxableMinor: number; salesTaxMinor: number; returnsTaxableMinor: number; returnsTaxMinor: number }>();
  const key = (r: HsnSummaryRow): string => `${r.hsnCode}|${r.rateBps}`;
  const seed = (r: HsnSummaryRow) => acc.get(key(r)) ?? { hsnCode: r.hsnCode, rateBps: r.rateBps, salesTaxableMinor: 0, salesTaxMinor: 0, returnsTaxableMinor: 0, returnsTaxMinor: 0 };
  for (const r of sales.rows) {
    const row = seed(r); row.salesTaxableMinor += r.taxableMinor; row.salesTaxMinor += rowTax(r); acc.set(key(r), row);
  }
  for (const r of returns.rows) {
    const row = seed(r); row.returnsTaxableMinor += r.taxableMinor; row.returnsTaxMinor += rowTax(r); acc.set(key(r), row);
  }
  const rows: NetHsnRow[] = [...acc.values()]
    .sort((a, b) => a.hsnCode.localeCompare(b.hsnCode) || a.rateBps - b.rateBps)
    .map((r) => ({ ...r, netTaxableMinor: r.salesTaxableMinor - r.returnsTaxableMinor, netTaxMinor: r.salesTaxMinor - r.returnsTaxMinor }));
  const salesTaxableMinor = sales.totalTaxableMinor;
  const salesTaxMinor = sales.totalTaxMinor;
  const returnsTaxableMinor = returns.totalTaxableMinor;
  const returnsTaxMinor = returns.totalTaxMinor;
  return {
    rows,
    salesTaxableMinor, salesTaxMinor, returnsTaxableMinor, returnsTaxMinor,
    netTaxableMinor: salesTaxableMinor - returnsTaxableMinor,
    netTaxMinor: salesTaxMinor - returnsTaxMinor,
    detail: `net taxable ${salesTaxableMinor - returnsTaxableMinor} (sales ${salesTaxableMinor} − returns ${returnsTaxableMinor}), net tax ${salesTaxMinor - returnsTaxMinor}`,
  };
}
