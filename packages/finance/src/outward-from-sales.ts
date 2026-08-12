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
import { gstr1Table12, type OutwardSupplyLine, type ClassifiedLine, type Gstr1Table12 } from './gstr1';

/** A sold line as it appears on a banked `SaleCommitted` event: what the till actually charged. */
export interface SoldTaxLine {
  readonly productId: string;
  readonly quantityMinor: number;
  readonly uom: string;
  /** The MRP-inclusive amount the till charged for the whole line (paisa). The GST is inside it (A9). */
  readonly lineTotalMinor: number;
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

  for (const l of input.sales) {
    const info = table.get(l.productId);
    if (info === undefined) {
      addUnmapped(l, 'no_tax_mapping', 'sold with no HSN/rate in the supplied tax table');
      continue;
    }
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
    detail: `${lines.length} sold line(s) filed across ${table12.rows.length} HSN/rate row(s); taxable ${table12.totalTaxableMinor}, tax ${table12.totalTaxMinor}${unmapped.length > 0 ? `; ${unmapped.length} product(s) unmapped and NOT on the return` : ''}`,
  };
}
