// OB-263 (owner, 21 Oct 2026, "Item-wise + bill-wise") — the evening check of a parallel-run day (MG-10 · OB-248 · OB-256 ·
// OB-264 · OB-265 · OB-269 · OB-800 · P-08 · hard rule #10).
//
// OB-800 (owner, 15 Nov 2026): there is NO pilot department. The whole store is loaded from the old ERP (Bpal) and runs
// alongside it — Bpal stays the record — and the owner checks the two side by side each evening. So this compares the
// WHOLE STORE: every item of every department, with each department's totals and the whole store's total.
//
// The old ERP's two reports for the day (read through their mappings, `old-erp-reports.ts`) against the new till's own
// mirror sales and refunds for the same day, from the store computer's disk. What is compared, and only this:
//
//   • EVERY ITEM. A product is found by its id (the old item code, MG-05) or a barcode. An old row whose code matches NO
//     product of the new catalogue is listed "not in the new catalogue" — a difference, never dropped. A new-till line of
//     a product this store computer's catalogue does not hold is compared too (its old side is nothing) — never dropped.
//   • PER ITEM: quantity, value (tax included) and tax, old against new. The new side is the day's mirror sales less the
//     day's mirror refunds (OB-258: a refund is rung on both). The old side is the report's rows for the item added up.
//     A loose item sold by weight (kg, L) compares to the gram / millilitre (three decimals), exactly. An item sold in
//     whole units whose old rows add up to a part quantity (1.5 of an "each") is not refused: it is compared in
//     thousandths of its unit, and its quantity differs — visible, with its reason to be written (hard rule #10).
//   • PER DEPARTMENT (`departments`): value, tax and quantity totals, by the department each product carries in the
//     catalogue — the department the Bpal load gave it from its HSN code (OB-800's one published table,
//     `bpal-slice.ts` STORE_DEPARTMENTS). A product with no department, and the codes not in the catalogue, each have
//     their own group — said, never folded into a department. The groups add up to the whole store's totals.
//   • THE WHOLE STORE'S TOTALS: value, tax, quantity (per unit: each, kg …) and the number of bills.
//   • BILL BY BILL, by the old bill number keyed on every mirror sale (OB-264): an old bill no new-till sale carries
//     ("not keyed" — every bill of the store is rung on both); a new-till sale whose old bill number is not on the old
//     list ("mistyped, or another day's"); a bill in both whose lines differ in value (only when the old list has the
//     bills' item lines).
//   • A RETURN, CREDIT NOTE OR EXCHANGE the old files show (a minus figure — OB-269: exchanges are done on the old system
//     only) is listed for the owner to EXPLAIN. It is never matched to anything: no matching rule is invented for it.
//   • PAYMENTS AND LOYALTY are not compared in the parallel run (OB-256, OB-265) — said, never a zero.
//
// Anything not known is NOT KNOWN, never 0 (P-08): the tax of a line whose rate the till did not record. The result
// becomes the MG-10 day (`comparisons`): the whole store's totals, and one line per item or bill that differs beyond the
// tolerance, each with its subject — so each difference needs its own reason before the day can be signed
// (`signParallelDay`), exactly as a typed day total does. The department totals are shown, not signed apart: every
// difference inside them is already an item line.
//
// Pure and deterministic.

import type { DayComparison } from './cutover';
import type { BillLine, ItemWiseRow, OldBill } from './old-erp-reports';
import { cleanItemCode } from './old-erp-reports';
import { storeDepartment, STORE_DEPARTMENTS } from './bpal-slice';
import { splitInclusive } from '../../finance/src/day-book';
import { normaliseMobile } from '../../loyalty/src/mobile';
import { normaliseUom, UOM_PRECISION } from '../../contracts/src/quantity';

/** A product of the store's catalogue, as the evening check needs it. */
export interface CheckProduct {
  readonly productId: string;
  readonly name?: string;
  readonly barcodes: readonly string[];
  /** The department (M03-FR-01). Absent: the catalogue does not say — the product is compared under "department not known". */
  readonly categoryId?: string;
  readonly uom: string;
  readonly taxBps?: number;
}

/** A sale line as the till wrote it. */
export interface CheckSaleLine {
  readonly productId: string;
  readonly quantityMinor: number;
  readonly uom?: string;
  readonly lineTotalMinor: number;
  readonly taxRateBps?: number;
}

export interface CheckSale {
  readonly saleId: string;
  readonly number: string;
  readonly tradingDay: string;
  readonly oldErpBillNumber?: string;
  readonly lines: readonly CheckSaleLine[];
}

export interface CheckRefund {
  readonly returnId: string;
  readonly originalSaleId?: string;
  readonly tradingDay: string;
  readonly refundMinor: number;
  readonly lines: readonly { readonly productId: string; readonly quantityMinor: number }[];
}

export interface CheckTolerance {
  /** How far a value may differ (paise) before it needs a reason — the day's, each item's and each bill's. */
  readonly valueMinor: number;
  /** How far the tax may differ (paise). */
  readonly taxMinor: number;
}

/** A figure that may not be known. Never a zero standing in for "not known". */
export type Known = { readonly known: true; readonly minor: number } | { readonly known: false; readonly why: string };
const known = (minor: number): Known => ({ known: true, minor });
const notKnown = (why: string): Known => ({ known: false, why });

/** Which group an item's figures are added into (OB-800). */
export type DepartmentGroup = 'department' | 'no_department' | 'not_in_catalogue';

export interface ItemCheck {
  readonly productId: string;
  readonly name?: string;
  readonly uom: string;
  /** The department the catalogue gives the product (absent: it does not say, or the product is not in it). */
  readonly categoryId?: string;
  /** OB-800: a new-till product this store computer's catalogue does not hold. */
  readonly notInCatalogue?: true;
  /**
   * OB-800: the quantities below are in THOUSANDTHS of the unit — an item sold in whole units whose old rows add up to a
   * part quantity (1.5 of an "each"). Absent: in the unit's own smallest step (1 each, 1 gram of a kg).
   */
  readonly quantityInThousandths?: true;
  /** The old codes that matched this product, as written in the file. */
  readonly oldCodes: readonly string[];
  readonly old: { readonly quantityMinor: number; readonly valueMinor: number; readonly taxMinor: number };
  readonly new: { readonly quantityMinor: number; readonly valueMinor: number; readonly tax: Known };
  /** Which of quantity, value and tax differ beyond the tolerance. */
  readonly differs: readonly ('quantity' | 'value' | 'tax')[];
}

/** A quantity total for one unit. `inThousandths`: in thousandths of the unit (see `ItemCheck.quantityInThousandths`). */
export interface QuantityTotal {
  readonly uom: string;
  readonly old: number;
  readonly new: number;
  readonly inThousandths?: true;
}

/** OB-800: one department's totals (or the "not known" / "not in the catalogue" group's). */
export interface DepartmentTotals {
  readonly group: DepartmentGroup;
  readonly categoryId?: string;
  readonly name: string;
  /** How many items were compared in it, and how many of them differ. */
  readonly items: number;
  readonly itemsDiffering: number;
  readonly value: { readonly old: number; readonly new: number };
  readonly tax: { readonly old: number; readonly new: Known };
  readonly quantity: readonly QuantityTotal[];
}

export interface BillCheck {
  readonly billNumber: string;
  readonly kind: 'not_keyed' | 'not_on_old' | 'value_differs';
  readonly oldValueMinor?: number;
  readonly newValueMinor?: number;
  /** The new till's bill, when it has one. */
  readonly newBill?: string;
}

export interface ExplainRow {
  readonly subject: string;
  readonly source: 'item_wise' | 'bill_wise';
  /** The line in the old file. */
  readonly line: number;
  readonly code?: string;
  readonly billNumber?: string;
  readonly valueMinor: number;
}

export interface EveningCheck {
  readonly businessDate: string;
  /** OB-800: what was compared — the whole store. Absent on a day loaded before OB-800 (one pilot department). */
  readonly scope?: 'whole_store';
  /** Before OB-800 only: the one pilot department a day was compared for. Kept so an earlier day still reads. */
  readonly department?: { readonly categoryId: string; readonly name: string };
  readonly tolerance: CheckTolerance;
  readonly items: readonly ItemCheck[];
  readonly notInCatalogue: readonly { readonly code: string; readonly quantityThousandths: number; readonly valueMinor: number; readonly taxMinor: number; readonly lines: readonly number[] }[];
  /** OB-800: each department's totals, in the published table's order; then any other department; then the two groups. */
  readonly departments?: readonly DepartmentTotals[];
  /** Before OB-800 only: old rows of other departments, not compared. */
  readonly otherDepartments?: { readonly rows: number; readonly valueMinor: number };
  /** Before OB-800 only: new-till lines outside the pilot department, not compared. */
  readonly newOutsideDepartment?: { readonly lines: number; readonly valueMinor: number };
  /** The whole store's totals (before OB-800: the pilot department's). */
  readonly totals: {
    readonly value: { readonly old: number; readonly new: number };
    readonly tax: { readonly old: number; readonly new: Known };
    readonly quantity: readonly QuantityTotal[];
    readonly bills: { readonly old: Known; readonly new: number };
  };
  readonly bills: {
    /** "lines": the old list has each bill's item lines; "presence_only": it has not — only whether each bill is on both. */
    readonly checked: 'lines' | 'presence_only';
    /**
     * OB-263 B: what a bill's lines are compared on — with the tax (as the customer paid), or without it, when the owner
     * said the bill-wise list's line values are before tax; the new till's lines are then taken without tax too.
     */
    readonly valueBasis: 'with_tax' | 'without_tax';
    /** Without tax: bills in both whose new-till lines carry no tax rate, so their value is not known and not compared. */
    readonly valueNotKnown: number;
    readonly matched: number;
    readonly differences: readonly BillCheck[];
  };
  readonly explain: readonly ExplainRow[];
  /** OB-256 · OB-265: never compared in the parallel run. */
  readonly notCompared: readonly { readonly area: 'payments' | 'loyalty'; readonly decision: 'OB-256' | 'OB-265' }[];
  /** The MG-10 day: the totals and every line beyond tolerance, each with its subject. */
  readonly comparisons: readonly DayComparison[];
}

export type EveningCheckRefusal = 'no_catalogue' | 'code_looks_personal' | 'too_many_differences';

export type EveningCheckResult =
  | { readonly ok: true; readonly check: EveningCheck }
  | { readonly ok: false; readonly refusedBecause: EveningCheckRefusal; readonly detail: string };

/** More differences than this in one day is a wrong mapping or another day's file, not a day to explain line by line. */
export const MAX_DAY_DIFFERENCES = 1000;

/** The words for the two groups that are not a department (OB-800). */
export const NO_DEPARTMENT_NAME = 'Department not known';
export const NOT_IN_CATALOGUE_NAME = 'Not in the new catalogue';

/**
 * A line's subject as head office keeps it: letters, digits and . _ / : @ # - (anything else becomes "_"), at most 64.
 * The store computer keeps the code exactly as the file wrote it beside it.
 */
export function subjectOf(text: string): string {
  const s = text.trim().replace(/[^A-Za-z0-9 ._/:@#-]/g, '_').slice(0, 64);
  return /^[A-Za-z0-9]/.test(s) ? s : `x${s}`.slice(0, 64);
}

/** The unit as the system stores it (OB-31: "KG", "kgs" → kg; "pcs" → ea); an unknown spelling is kept as written. */
const unitOf = (uom: string): string => normaliseUom(uom) ?? uom;

/** Each unit's decimal places: kg / L → 3 (grams / millilitres); ea, g, ml → 0. An unknown unit counts in whole units. */
const precisionOf = (uom: string): number => {
  const u = normaliseUom(uom);
  return u === undefined ? 0 : UOM_PRECISION[u];
};

/** How many thousandths one smallest step of the unit is: 1 for kg / L (a gram, a millilitre), 1000 for a whole unit. */
const thousandthsPerStep = (uom: string): number => 10 ** (3 - precisionOf(uom));

/** A stock_movement subject: the unit, and "/1000" when the total is in thousandths of it. */
export const quantitySubject = (q: Pick<QuantityTotal, 'uom' | 'inThousandths'>): string => (q.inThousandths === true ? `${q.uom}/1000` : q.uom);

/** Spread `total` over `weights` in proportion, the remainder on the last — so the parts always add to the total. */
function spread(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sum <= 0) return weights.map((_, i) => (i === weights.length - 1 ? total : 0));
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  parts[parts.length - 1] = total - parts.slice(0, -1).reduce((a, b) => a + b, 0);
  return parts;
}

/** Quantity totals per unit; a unit with any item in thousandths is totalled in thousandths for all its items. */
function quantityTotals(items: readonly ItemCheck[]): QuantityTotal[] {
  const uoms = [...new Set(items.map((i) => i.uom))].sort();
  return uoms.map((uom) => {
    const of = items.filter((i) => i.uom === uom);
    const thousandths = of.some((i) => i.quantityInThousandths === true);
    const scale = (i: ItemCheck): number => (thousandths && i.quantityInThousandths !== true ? thousandthsPerStep(uom) : 1);
    return {
      uom,
      old: of.reduce((a, i) => a + i.old.quantityMinor * scale(i), 0),
      new: of.reduce((a, i) => a + i.new.quantityMinor * scale(i), 0),
      ...(thousandths ? { inThousandths: true as const } : {}),
    };
  });
}

const taxTotal = (items: readonly ItemCheck[]): Known => (items.every((i) => i.new.tax.known)
  ? known(items.reduce((a, i) => a + (i.new.tax.known ? i.new.tax.minor : 0), 0))
  : notKnown('a line on the new till carries no tax rate, so its tax is not known'));

export function eveningCheck(input: {
  readonly businessDate: string;
  readonly catalogue: readonly CheckProduct[] | undefined;
  readonly itemWise: readonly ItemWiseRow[];
  /** `lineValuesIncludeTax: false` (OB-263 B): the bills' line values are before tax. Absent: they include it. */
  readonly billWise: { readonly bills: readonly OldBill[]; readonly withLines: boolean; readonly lineValuesIncludeTax?: boolean };
  readonly sales: readonly CheckSale[];
  readonly refunds: readonly CheckRefund[];
  readonly tolerance: CheckTolerance;
}): EveningCheckResult {
  if (input.catalogue === undefined || input.catalogue.length === 0) {
    return { ok: false, refusedBecause: 'no_catalogue', detail: 'This store computer holds no catalogue yet, so no item can be matched. Nothing was compared.' };
  }
  const day = input.businessDate;
  const byId = new Map<string, CheckProduct>();
  const byCode = new Map<string, CheckProduct>();
  const byUpper = new Map<string, CheckProduct>();
  for (const p of input.catalogue) {
    byId.set(p.productId, p);
    byCode.set(p.productId, p);
    byUpper.set(p.productId.toUpperCase(), p);
    for (const b of p.barcodes) { if (!byCode.has(b)) byCode.set(b, p); if (!byUpper.has(b.toUpperCase())) byUpper.set(b.toUpperCase(), p); }
  }
  const productOf = (rawCode: string): CheckProduct | undefined => {
    const code = cleanItemCode(rawCode);
    return byCode.get(code) ?? byUpper.get(code.toUpperCase());
  };

  // ── The new till's side: the day's mirror sales and refunds, per product — every product, every department.
  type NewItem = { quantityMinor: number; valueMinor: number; taxMinor: number; taxKnown: boolean; uom?: string };
  const fresh = (): NewItem => ({ quantityMinor: 0, valueMinor: 0, taxMinor: 0, taxKnown: true });
  const newItems = new Map<string, NewItem>();
  const salesOfDay = input.sales.filter((s) => s.tradingDay === day);
  const saleById = new Map(input.sales.map((s) => [s.saleId, s] as const));
  const rateOf = (l: { readonly productId: string; readonly taxRateBps?: number }): number | undefined =>
    (typeof l.taxRateBps === 'number' && Number.isInteger(l.taxRateBps) && l.taxRateBps >= 0 ? l.taxRateBps : byId.get(l.productId)?.taxBps);
  const add = (productId: string, quantityMinor: number, valueMinor: number, rate: number | undefined, sign: 1 | -1, uom?: string): void => {
    const item = newItems.get(productId) ?? fresh();
    item.quantityMinor += sign * quantityMinor;
    item.valueMinor += sign * valueMinor;
    if (rate === undefined) item.taxKnown = false;
    else item.taxMinor += sign * splitInclusive(valueMinor, rate).tax;
    if (item.uom === undefined && uom !== undefined) item.uom = uom;
    newItems.set(productId, item);
  };
  for (const s of salesOfDay) for (const l of s.lines) add(l.productId, l.quantityMinor, l.lineTotalMinor, rateOf(l), 1, l.uom);
  for (const r of input.refunds.filter((x) => x.tradingDay === day)) {
    // The refund's money spread over its lines at the bill's own prices (the original sale on this box), else by the
    // catalogue's prices — so the item values always add to exactly what was refunded.
    const original = r.originalSaleId === undefined ? undefined : saleById.get(r.originalSaleId);
    const weights = r.lines.map((l) => {
      const sold = original?.lines.filter((x) => x.productId === l.productId) ?? [];
      const soldQty = sold.reduce((a, x) => a + x.quantityMinor, 0);
      const soldValue = sold.reduce((a, x) => a + x.lineTotalMinor, 0);
      return soldQty > 0 ? Math.round((soldValue * l.quantityMinor) / soldQty) : l.quantityMinor;
    });
    const parts = spread(Math.abs(r.refundMinor), weights);
    r.lines.forEach((l, i) => {
      const soldLine = original?.lines.find((x) => x.productId === l.productId);
      add(l.productId, l.quantityMinor, parts[i]!, soldLine === undefined ? byId.get(l.productId)?.taxBps : rateOf(soldLine), -1, soldLine?.uom);
    });
  }

  // ── The old side: the item-wise rows, per product (in thousandths, as the file gives them); the rest listed.
  type OldItem = { quantityThousandths: number; valueMinor: number; taxMinor: number; codes: Set<string> };
  const oldItems = new Map<string, OldItem>();
  const notInCatalogue = new Map<string, { code: string; quantityThousandths: number; valueMinor: number; taxMinor: number; lines: number[] }>();
  const explain: ExplainRow[] = [];
  for (const row of input.itemWise) {
    const p = productOf(row.code);
    if (row.quantityThousandths < 0 || row.valueMinor < 0) {
      explain.push({ subject: subjectOf(`item:${row.code}@${row.line}`), source: 'item_wise', line: row.line, code: row.code, valueMinor: row.valueMinor });
    }
    if (p === undefined) {
      if (normaliseMobile(row.code) !== undefined) {
        return { ok: false, refusedBecause: 'code_looks_personal', detail: `Line ${row.line} of the item-wise file: the code in the item column looks like a phone number and matches no product. Check the mapping: choose the column that holds the item code. Nothing was kept.` };
      }
      const n = notInCatalogue.get(row.code) ?? { code: row.code, quantityThousandths: 0, valueMinor: 0, taxMinor: 0, lines: [] };
      n.quantityThousandths += row.quantityThousandths; n.valueMinor += row.valueMinor; n.taxMinor += row.taxMinor; n.lines.push(row.line);
      notInCatalogue.set(row.code, n);
      continue;
    }
    const o = oldItems.get(p.productId) ?? { quantityThousandths: 0, valueMinor: 0, taxMinor: 0, codes: new Set<string>() };
    o.quantityThousandths += row.quantityThousandths; o.valueMinor += row.valueMinor; o.taxMinor += row.taxMinor; o.codes.add(row.code);
    oldItems.set(p.productId, o);
  }

  // ── Per item.
  const tol = input.tolerance;
  const items: ItemCheck[] = [];
  for (const productId of [...new Set([...oldItems.keys(), ...newItems.keys()])].sort()) {
    const p = byId.get(productId);
    const o = oldItems.get(productId) ?? { quantityThousandths: 0, valueMinor: 0, taxMinor: 0, codes: new Set<string>() };
    const n = newItems.get(productId) ?? fresh();
    // The unit: the catalogue's; for a product it does not hold, the till's own line's (said as not in the catalogue).
    const uom = unitOf(p?.uom ?? n.uom ?? 'ea');
    const step = thousandthsPerStep(uom);
    // A whole number of the unit's steps compares in the unit; a part of one (1.5 "each") in thousandths — never refused.
    const inThousandths = o.quantityThousandths % step !== 0;
    const oldQty = inThousandths ? o.quantityThousandths : o.quantityThousandths / step;
    const newQty = inThousandths ? n.quantityMinor * step : n.quantityMinor;
    const differs: ('quantity' | 'value' | 'tax')[] = [];
    if (oldQty !== newQty) differs.push('quantity');
    if (Math.abs(n.valueMinor - o.valueMinor) > tol.valueMinor) differs.push('value');
    if (n.taxKnown && Math.abs(n.taxMinor - o.taxMinor) > tol.taxMinor) differs.push('tax');
    items.push({
      productId, ...(p?.name === undefined ? {} : { name: p.name }), uom,
      ...(p?.categoryId === undefined ? {} : { categoryId: p.categoryId }),
      ...(p === undefined ? { notInCatalogue: true as const } : {}),
      ...(inThousandths ? { quantityInThousandths: true as const } : {}),
      oldCodes: [...o.codes].sort(),
      old: { quantityMinor: oldQty, valueMinor: o.valueMinor, taxMinor: o.taxMinor },
      new: { quantityMinor: newQty, valueMinor: n.valueMinor, tax: n.taxKnown ? known(n.taxMinor) : notKnown('a line on the new till carries no tax rate') },
      differs,
    });
  }

  // ── Bill by bill: every bill of the store is rung on both (OB-800).
  const lineValue = (lines: readonly BillLine[]): number => lines.reduce((a, l) => a + l.valueMinor, 0);
  const newByOldBill = new Map<string, CheckSale>();
  for (const s of salesOfDay) if (s.oldErpBillNumber !== undefined && !newByOldBill.has(s.oldErpBillNumber)) newByOldBill.set(s.oldErpBillNumber, s);
  const withoutTax = input.billWise.withLines && input.billWise.lineValuesIncludeTax === false;
  /** A new-till bill's lines in value — with tax, or without it (each line's own rate) when the old lines are before tax. */
  const newBillValue = (s: CheckSale): number | undefined => {
    let total = 0;
    for (const l of s.lines) {
      if (!withoutTax) { total += l.lineTotalMinor; continue; }
      const rate = rateOf(l);
      if (rate === undefined) return undefined;
      total += l.lineTotalMinor - splitInclusive(l.lineTotalMinor, rate).tax;
    }
    return total;
  };
  let valueNotKnown = 0;
  const oldByNumber = new Map(input.billWise.bills.map((b) => [b.billNumber, b] as const));
  const billDiffs: BillCheck[] = [];
  let matched = 0;
  let oldBills = 0;
  for (const b of input.billWise.bills) {
    const isReturn = b.totalMinor < 0 || (b.lines ?? []).some((l) => l.valueMinor < 0 || (l.quantityThousandths ?? 0) < 0);
    if (isReturn) {
      explain.push({ subject: subjectOf(`bill:${b.billNumber}`), source: 'bill_wise', line: b.line, billNumber: b.billNumber, valueMinor: b.totalMinor });
      continue;
    }
    oldBills += 1;
    const lines = input.billWise.withLines ? b.lines ?? [] : [];
    const oldValue = lines.length > 0 ? lineValue(lines) : withoutTax ? undefined : b.totalMinor;
    const keyed = newByOldBill.get(b.billNumber);
    if (keyed === undefined) { billDiffs.push({ billNumber: b.billNumber, kind: 'not_keyed', ...(oldValue === undefined ? {} : { oldValueMinor: oldValue }) }); continue; }
    // Without the item lines, only that the bill is on both is checked — its total is not compared (that is a choice
    // the owner has not made: a bill total rounded to the rupee against the till's lines).
    if (lines.length === 0) { matched += 1; continue; }
    const newValue = newBillValue(keyed);
    if (newValue === undefined) { valueNotKnown += 1; continue; }
    if (Math.abs(newValue - oldValue!) > tol.valueMinor) billDiffs.push({ billNumber: b.billNumber, kind: 'value_differs', oldValueMinor: oldValue!, newValueMinor: newValue, newBill: keyed.number });
    else matched += 1;
  }
  for (const s of salesOfDay) {
    if (s.oldErpBillNumber === undefined || oldByNumber.has(s.oldErpBillNumber)) continue;
    const v = newBillValue(s);
    billDiffs.push({ billNumber: s.oldErpBillNumber, kind: 'not_on_old', ...(v === undefined ? {} : { newValueMinor: v }), newBill: s.number });
  }

  // ── The departments (OB-800), and the whole store's totals.
  const notIn = [...notInCatalogue.values()];
  const notInValue = notIn.reduce((a, n) => a + n.valueMinor, 0);
  const notInTax = notIn.reduce((a, n) => a + n.taxMinor, 0);
  const groupOf = (i: ItemCheck): string => (i.notInCatalogue === true ? '\u0000not_in_catalogue' : i.categoryId ?? '\u0000no_department');
  const groupKeys = new Set(items.map(groupOf));
  if (notIn.length > 0) groupKeys.add('\u0000not_in_catalogue');
  const ordered = [
    ...STORE_DEPARTMENTS.map((d) => d.categoryId).filter((k) => groupKeys.has(k)),
    ...[...groupKeys].filter((k) => !k.startsWith('\u0000') && storeDepartment(k) === undefined).sort(),
    ...['\u0000no_department', '\u0000not_in_catalogue'].filter((k) => groupKeys.has(k)),
  ];
  const departments: DepartmentTotals[] = ordered.map((key) => {
    const of = items.filter((i) => groupOf(i) === key);
    const group: DepartmentGroup = key === '\u0000not_in_catalogue' ? 'not_in_catalogue' : key === '\u0000no_department' ? 'no_department' : 'department';
    const extraValue = group === 'not_in_catalogue' ? notInValue : 0;
    const extraTax = group === 'not_in_catalogue' ? notInTax : 0;
    return {
      group, ...(group === 'department' ? { categoryId: key } : {}),
      name: group === 'department' ? storeDepartment(key)?.name ?? key : group === 'no_department' ? NO_DEPARTMENT_NAME : NOT_IN_CATALOGUE_NAME,
      items: of.length + (group === 'not_in_catalogue' ? notIn.length : 0),
      itemsDiffering: of.filter((i) => i.differs.length > 0).length + (group === 'not_in_catalogue' ? notIn.length : 0),
      value: { old: of.reduce((a, i) => a + i.old.valueMinor, 0) + extraValue, new: of.reduce((a, i) => a + i.new.valueMinor, 0) },
      tax: { old: of.reduce((a, i) => a + i.old.taxMinor, 0) + extraTax, new: taxTotal(of) },
      quantity: quantityTotals(of),
    };
  });

  const valueOld = items.reduce((a, i) => a + i.old.valueMinor, 0) + notInValue;
  const valueNew = items.reduce((a, i) => a + i.new.valueMinor, 0);
  const taxOld = items.reduce((a, i) => a + i.old.taxMinor, 0) + notInTax;
  const taxNew = taxTotal(items);
  const quantity = quantityTotals(items);
  const newBills = salesOfDay.filter((s) => s.lines.length > 0).length;
  const billsOld: Known = known(oldBills);

  // ── The MG-10 day.
  const comparisons: DayComparison[] = [
    { area: 'sales_value', legacyValue: valueOld, newValue: valueNew, toleranceMinor: tol.valueMinor },
    ...(taxNew.known ? [{ area: 'tax' as const, legacyValue: taxOld, newValue: taxNew.minor, toleranceMinor: tol.taxMinor }] : []),
    { area: 'sales_count', legacyValue: oldBills, newValue: newBills, toleranceMinor: 0 },
    ...quantity.map((q) => ({ area: 'stock_movement' as const, subject: quantitySubject(q), legacyValue: q.old, newValue: q.new, toleranceMinor: 0 })),
  ];
  for (const i of items) {
    if (i.differs.includes('quantity')) comparisons.push({ area: 'item_quantity', subject: subjectOf(i.productId), legacyValue: i.old.quantityMinor, newValue: i.new.quantityMinor, toleranceMinor: 0 });
    if (i.differs.includes('value')) comparisons.push({ area: 'item_value', subject: subjectOf(i.productId), legacyValue: i.old.valueMinor, newValue: i.new.valueMinor, toleranceMinor: tol.valueMinor });
    if (i.differs.includes('tax') && i.new.tax.known) comparisons.push({ area: 'item_tax', subject: subjectOf(i.productId), legacyValue: i.old.taxMinor, newValue: i.new.tax.minor, toleranceMinor: tol.taxMinor });
  }
  for (const n of notIn) comparisons.push({ area: 'item_not_in_catalogue', subject: subjectOf(n.code), legacyValue: 1, newValue: 0, toleranceMinor: 0 });
  for (const b of billDiffs) {
    if (b.kind === 'not_keyed') comparisons.push({ area: 'bill_not_keyed', subject: b.billNumber, legacyValue: 1, newValue: 0, toleranceMinor: 0 });
    else if (b.kind === 'not_on_old') comparisons.push({ area: 'bill_not_on_old', subject: b.billNumber, legacyValue: 0, newValue: 1, toleranceMinor: 0 });
    else comparisons.push({ area: 'bill_value', subject: b.billNumber, legacyValue: b.oldValueMinor!, newValue: b.newValueMinor!, toleranceMinor: tol.valueMinor });
  }
  for (const e of explain) comparisons.push({ area: 'old_return', subject: e.subject, legacyValue: 1, newValue: 0, toleranceMinor: 0 });

  const differing = comparisons.filter((c) => Math.abs(c.newValue - c.legacyValue) > c.toleranceMinor).length;
  if (differing > MAX_DAY_DIFFERENCES) {
    return { ok: false, refusedBecause: 'too_many_differences', detail: `${differing} differences — that is a wrong column in the mapping, a report kept to one department, or another day's file, not a day to explain line by line. Check the mapping and the day of both files. Nothing was kept.` };
  }

  return {
    ok: true,
    check: {
      businessDate: day,
      scope: 'whole_store',
      tolerance: tol,
      items,
      notInCatalogue: notIn.sort((a, b) => (a.code < b.code ? -1 : 1)),
      departments,
      totals: { value: { old: valueOld, new: valueNew }, tax: { old: taxOld, new: taxNew }, quantity, bills: { old: billsOld, new: newBills } },
      bills: { checked: input.billWise.withLines ? 'lines' : 'presence_only', valueBasis: withoutTax ? 'without_tax' : 'with_tax', valueNotKnown, matched, differences: billDiffs },
      explain,
      notCompared: [{ area: 'payments', decision: 'OB-256' }, { area: 'loyalty', decision: 'OB-265' }],
      comparisons,
    },
  };
}
