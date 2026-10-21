// OB-263 (owner, 21 Oct 2026, "Item-wise + bill-wise") — the evening check of a mirror-pilot day (MG-10 · OB-248 · OB-256 ·
// OB-264 · OB-265 · OB-269 · P-08 · hard rule #10).
//
// The old ERP's two reports for the day (read through their mappings, `old-erp-reports.ts`) against the new till's own
// mirror sales and refunds for the same day, from the store computer's disk. What is compared, and only this:
//
//   • PILOT DEPARTMENT ONLY. An old row whose code is a product of the new catalogue in another department is not compared
//     (counted and said). An old row whose code matches NO product of the new catalogue is listed "not in the new
//     catalogue" — a difference, never dropped. A product is found by its id (the old item code, MG-05) or a barcode.
//   • PER ITEM: quantity, value (tax included) and tax, old against new. The new side is the day's mirror sales less the
//     day's mirror refunds (OB-258: a refund is rung on both). The old side is the report's rows for the item added up.
//   • THE DAY'S TOTALS: value, tax, quantity (per unit: each, kg …) and the number of bills.
//   • BILL BY BILL, by the old bill number keyed on every mirror sale (OB-264): an old bill with pilot items no new-till sale
//     carries ("not keyed"); a new-till sale whose old bill number is not on the old list ("mistyped, or another day's");
//     a bill in both whose pilot lines differ in value. Which old bills had pilot items, and their pilot value, can only be
//     known from the bill's item lines: without them only the second check is possible, and the result says so.
//   • A RETURN, CREDIT NOTE OR EXCHANGE the old files show (a minus figure — OB-269: exchanges are done on the old system
//     only) is listed for the owner to EXPLAIN. It is never matched to anything: no matching rule is invented for it.
//   • PAYMENTS AND LOYALTY are not compared in the mirror pilot (OB-256, OB-265) — said, never a zero.
//
// Anything not known is NOT KNOWN, never 0 (P-08): the tax of a line whose rate the till did not record, the bill count
// without the bills' item lines. The result becomes the MG-10 day (`comparisons`): the totals, and one line per item or bill
// that differs beyond the tolerance, each with its subject — so each difference needs its own reason before the day can be
// signed (`signParallelDay`), exactly as a typed day total does.
//
// Pure and deterministic.

import type { DayComparison } from './cutover';
import type { BillLine, ItemWiseRow, OldBill } from './old-erp-reports';
import { cleanItemCode } from './old-erp-reports';
import { splitInclusive } from '../../finance/src/day-book';
import { normaliseMobile } from '../../loyalty/src/mobile';

/** A product of the store's catalogue, as the evening check needs it. */
export interface CheckProduct {
  readonly productId: string;
  readonly name?: string;
  readonly barcodes: readonly string[];
  /** The department (M03-FR-01). Absent: the catalogue does not say, and the product is never counted as the pilot's. */
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

export interface ItemCheck {
  readonly productId: string;
  readonly name?: string;
  readonly uom: string;
  /** The old codes that matched this product, as written in the file. */
  readonly oldCodes: readonly string[];
  readonly old: { readonly quantityMinor: number; readonly valueMinor: number; readonly taxMinor: number };
  readonly new: { readonly quantityMinor: number; readonly valueMinor: number; readonly tax: Known };
  /** Which of quantity, value and tax differ beyond the tolerance. */
  readonly differs: readonly ('quantity' | 'value' | 'tax')[];
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
  readonly department: { readonly categoryId: string; readonly name: string };
  readonly tolerance: CheckTolerance;
  readonly items: readonly ItemCheck[];
  readonly notInCatalogue: readonly { readonly code: string; readonly quantityThousandths: number; readonly valueMinor: number; readonly taxMinor: number; readonly lines: readonly number[] }[];
  /** Old rows of catalogue products in other departments: not compared, said. */
  readonly otherDepartments: { readonly rows: number; readonly valueMinor: number };
  /** New-till lines of products outside the pilot department, or not in the catalogue: not compared, said. */
  readonly newOutsideDepartment: { readonly lines: number; readonly valueMinor: number };
  readonly totals: {
    readonly value: { readonly old: number; readonly new: number };
    readonly tax: { readonly old: number; readonly new: Known };
    readonly quantity: readonly { readonly uom: string; readonly old: number; readonly new: number }[];
    readonly bills: { readonly old: Known; readonly new: number };
  };
  readonly bills: {
    /** "lines": the old list has each bill's item lines; "presence_only": it has not, and only that is checked. */
    readonly checked: 'lines' | 'presence_only';
    readonly matched: number;
    readonly differences: readonly BillCheck[];
  };
  readonly explain: readonly ExplainRow[];
  /** OB-256 · OB-265: never compared in the mirror pilot. */
  readonly notCompared: readonly { readonly area: 'payments' | 'loyalty'; readonly decision: 'OB-256' | 'OB-265' }[];
  /** The MG-10 day: the totals and every line beyond tolerance, each with its subject. */
  readonly comparisons: readonly DayComparison[];
}

export type EveningCheckRefusal = 'no_pilot_department' | 'no_catalogue' | 'code_looks_personal' | 'quantity_not_whole' | 'too_many_differences';

export type EveningCheckResult =
  | { readonly ok: true; readonly check: EveningCheck }
  | { readonly ok: false; readonly refusedBecause: EveningCheckRefusal; readonly detail: string };

/** More differences than this in one day is a wrong mapping or another day's file, not a day to explain line by line. */
export const MAX_DAY_DIFFERENCES = 1000;

/**
 * A line's subject as head office keeps it: letters, digits and . _ / : @ # - (anything else becomes "_"), at most 64.
 * The store computer keeps the code exactly as the file wrote it beside it.
 */
export function subjectOf(text: string): string {
  const s = text.trim().replace(/[^A-Za-z0-9 ._/:@#-]/g, '_').slice(0, 64);
  return /^[A-Za-z0-9]/.test(s) ? s : `x${s}`.slice(0, 64);
}

/** Each unit's precision (the smallest step): ea → 1, kg / L → 1000 (grams / millilitres), g / ml → 1. */
const precisionOf = (uom: string): number => (uom === 'kg' || uom === 'L' ? 3 : 0);

/** Old quantity in thousandths → the product's own smallest unit, or undefined when it does not fit (1.5 of an "each"). */
function toProductMinor(thousandths: number, uom: string): number | undefined {
  const p = precisionOf(uom);
  if (p === 3) return thousandths;
  return thousandths % 1000 === 0 ? thousandths / 1000 : undefined;
}

/** Spread `total` over `weights` in proportion, the remainder on the last — so the parts always add to the total. */
function spread(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sum <= 0) return weights.map((_, i) => (i === weights.length - 1 ? total : 0));
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  parts[parts.length - 1] = total - parts.slice(0, -1).reduce((a, b) => a + b, 0);
  return parts;
}

export function eveningCheck(input: {
  readonly businessDate: string;
  readonly department: { readonly categoryId: string; readonly name: string } | undefined;
  readonly catalogue: readonly CheckProduct[] | undefined;
  readonly itemWise: readonly ItemWiseRow[];
  readonly billWise: { readonly bills: readonly OldBill[]; readonly withLines: boolean };
  readonly sales: readonly CheckSale[];
  readonly refunds: readonly CheckRefund[];
  readonly tolerance: CheckTolerance;
}): EveningCheckResult {
  const dept = input.department;
  if (dept === undefined) {
    return { ok: false, refusedBecause: 'no_pilot_department', detail: 'The pilot department is not known on this store computer yet: it comes from the department slice once it is applied (MG-05). Nothing was compared.' };
  }
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
  const inPilot = (p: CheckProduct | undefined): p is CheckProduct => p !== undefined && p.categoryId === dept.categoryId;

  // ── The new till's side: the day's mirror sales and refunds, per pilot product.
  type NewItem = { quantityMinor: number; valueMinor: number; taxMinor: number; taxKnown: boolean };
  const fresh = (): NewItem => ({ quantityMinor: 0, valueMinor: 0, taxMinor: 0, taxKnown: true });
  const newItems = new Map<string, NewItem>();
  let outsideLines = 0;
  let outsideValue = 0;
  const salesOfDay = input.sales.filter((s) => s.tradingDay === day);
  const saleById = new Map(input.sales.map((s) => [s.saleId, s] as const));
  const rateOf = (l: { readonly productId: string; readonly taxRateBps?: number }): number | undefined =>
    (typeof l.taxRateBps === 'number' && Number.isInteger(l.taxRateBps) && l.taxRateBps >= 0 ? l.taxRateBps : byId.get(l.productId)?.taxBps);
  const add = (productId: string, quantityMinor: number, valueMinor: number, rate: number | undefined, sign: 1 | -1): void => {
    const item = newItems.get(productId) ?? fresh();
    item.quantityMinor += sign * quantityMinor;
    item.valueMinor += sign * valueMinor;
    if (rate === undefined) item.taxKnown = false;
    else item.taxMinor += sign * splitInclusive(valueMinor, rate).tax;
    newItems.set(productId, item);
  };
  for (const s of salesOfDay) {
    for (const l of s.lines) {
      if (!inPilot(byId.get(l.productId))) { outsideLines += 1; outsideValue += l.lineTotalMinor; continue; }
      add(l.productId, l.quantityMinor, l.lineTotalMinor, rateOf(l), 1);
    }
  }
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
      if (!inPilot(byId.get(l.productId))) { outsideLines += 1; outsideValue -= parts[i]!; return; }
      const rate = original?.lines.find((x) => x.productId === l.productId);
      add(l.productId, l.quantityMinor, parts[i]!, rate === undefined ? byId.get(l.productId)?.taxBps : rateOf(rate), -1);
    });
  }

  // ── The old side: the item-wise rows, per pilot product; the rest said.
  type OldItem = { quantityMinor: number; valueMinor: number; taxMinor: number; codes: Set<string> };
  const oldItems = new Map<string, OldItem>();
  const notInCatalogue = new Map<string, { code: string; quantityThousandths: number; valueMinor: number; taxMinor: number; lines: number[] }>();
  const explain: ExplainRow[] = [];
  let otherRows = 0;
  let otherValue = 0;
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
    if (!inPilot(p)) { otherRows += 1; otherValue += row.valueMinor; continue; }
    const q = toProductMinor(row.quantityThousandths, p.uom);
    if (q === undefined) {
      return { ok: false, refusedBecause: 'quantity_not_whole', detail: `Line ${row.line} of the item-wise file: ${row.code} is sold in whole units (${p.uom}) but the file says ${row.quantityThousandths / 1000}. Check the quantity column in the mapping.` };
    }
    const o = oldItems.get(p.productId) ?? { quantityMinor: 0, valueMinor: 0, taxMinor: 0, codes: new Set<string>() };
    o.quantityMinor += q; o.valueMinor += row.valueMinor; o.taxMinor += row.taxMinor; o.codes.add(row.code);
    oldItems.set(p.productId, o);
  }

  // ── Per item.
  const tol = input.tolerance;
  const items: ItemCheck[] = [];
  for (const productId of [...new Set([...oldItems.keys(), ...newItems.keys()])].sort()) {
    const p = byId.get(productId)!;
    const o = oldItems.get(productId) ?? { quantityMinor: 0, valueMinor: 0, taxMinor: 0, codes: new Set<string>() };
    const n = newItems.get(productId) ?? fresh();
    const differs: ('quantity' | 'value' | 'tax')[] = [];
    if (o.quantityMinor !== n.quantityMinor) differs.push('quantity');
    if (Math.abs(n.valueMinor - o.valueMinor) > tol.valueMinor) differs.push('value');
    if (n.taxKnown && Math.abs(n.taxMinor - o.taxMinor) > tol.taxMinor) differs.push('tax');
    items.push({
      productId, ...(p.name === undefined ? {} : { name: p.name }), uom: p.uom, oldCodes: [...o.codes].sort(),
      old: { quantityMinor: o.quantityMinor, valueMinor: o.valueMinor, taxMinor: o.taxMinor },
      new: { quantityMinor: n.quantityMinor, valueMinor: n.valueMinor, tax: n.taxKnown ? known(n.taxMinor) : notKnown('a line on the new till carries no tax rate') },
      differs,
    });
  }

  // ── Bill by bill.
  const pilotLineValue = (lines: readonly BillLine[]): number | undefined => {
    const pilot = lines.filter((l) => inPilot(productOf(l.code)));
    return pilot.length === 0 ? undefined : pilot.reduce((a, l) => a + l.valueMinor, 0);
  };
  const newByOldBill = new Map<string, CheckSale>();
  for (const s of salesOfDay) if (s.oldErpBillNumber !== undefined && !newByOldBill.has(s.oldErpBillNumber)) newByOldBill.set(s.oldErpBillNumber, s);
  const newPilotValue = (s: CheckSale): number => s.lines.filter((l) => inPilot(byId.get(l.productId))).reduce((a, l) => a + l.lineTotalMinor, 0);
  const oldByNumber = new Map(input.billWise.bills.map((b) => [b.billNumber, b] as const));
  const billDiffs: BillCheck[] = [];
  let matched = 0;
  let oldPilotBills = 0;
  for (const b of input.billWise.bills) {
    const isReturn = b.totalMinor < 0 || (b.lines ?? []).some((l) => l.valueMinor < 0 || (l.quantityThousandths ?? 0) < 0);
    if (isReturn) {
      explain.push({ subject: subjectOf(`bill:${b.billNumber}`), source: 'bill_wise', line: b.line, billNumber: b.billNumber, valueMinor: b.totalMinor });
      continue;
    }
    if (!input.billWise.withLines) continue;
    const oldValue = pilotLineValue(b.lines ?? []);
    if (oldValue === undefined) continue;
    oldPilotBills += 1;
    const keyed = newByOldBill.get(b.billNumber);
    if (keyed === undefined) { billDiffs.push({ billNumber: b.billNumber, kind: 'not_keyed', oldValueMinor: oldValue }); continue; }
    const newValue = newPilotValue(keyed);
    if (Math.abs(newValue - oldValue) > tol.valueMinor) billDiffs.push({ billNumber: b.billNumber, kind: 'value_differs', oldValueMinor: oldValue, newValueMinor: newValue, newBill: keyed.number });
    else matched += 1;
  }
  for (const s of salesOfDay) {
    if (s.oldErpBillNumber === undefined) continue;
    const old = oldByNumber.get(s.oldErpBillNumber);
    if (old === undefined) { billDiffs.push({ billNumber: s.oldErpBillNumber, kind: 'not_on_old', newValueMinor: newPilotValue(s), newBill: s.number }); continue; }
    if (!input.billWise.withLines && old.totalMinor >= 0) matched += 1;
  }

  // ── The totals.
  const sum = (f: (i: ItemCheck) => number): number => items.reduce((a, i) => a + f(i), 0);
  const notInValue = [...notInCatalogue.values()].reduce((a, n) => a + n.valueMinor, 0);
  const notInTax = [...notInCatalogue.values()].reduce((a, n) => a + n.taxMinor, 0);
  const valueOld = sum((i) => i.old.valueMinor) + notInValue;
  const valueNew = sum((i) => i.new.valueMinor);
  const taxOld = sum((i) => i.old.taxMinor) + notInTax;
  const taxNew: Known = items.every((i) => i.new.tax.known)
    ? known(items.reduce((a, i) => a + (i.new.tax.known ? i.new.tax.minor : 0), 0))
    : notKnown('a line on the new till carries no tax rate, so its tax is not known');
  const uoms = [...new Set(items.map((i) => i.uom))].sort();
  const quantity = uoms.map((uom) => ({
    uom,
    old: items.filter((i) => i.uom === uom).reduce((a, i) => a + i.old.quantityMinor, 0),
    new: items.filter((i) => i.uom === uom).reduce((a, i) => a + i.new.quantityMinor, 0),
  }));
  const newBills = salesOfDay.filter((s) => s.lines.some((l) => inPilot(byId.get(l.productId)))).length;
  const billsOld: Known = input.billWise.withLines
    ? known(oldPilotBills)
    : notKnown('the bill-wise file has no item lines, so which old bills had pilot items is not known');

  // ── The MG-10 day.
  const comparisons: DayComparison[] = [
    { area: 'sales_value', legacyValue: valueOld, newValue: valueNew, toleranceMinor: tol.valueMinor },
    ...(taxNew.known ? [{ area: 'tax' as const, legacyValue: taxOld, newValue: taxNew.minor, toleranceMinor: tol.taxMinor }] : []),
    ...(billsOld.known ? [{ area: 'sales_count' as const, legacyValue: billsOld.minor, newValue: newBills, toleranceMinor: 0 }] : []),
    ...quantity.map((q) => ({ area: 'stock_movement' as const, subject: q.uom, legacyValue: q.old, newValue: q.new, toleranceMinor: 0 })),
  ];
  for (const i of items) {
    if (i.differs.includes('quantity')) comparisons.push({ area: 'item_quantity', subject: subjectOf(i.productId), legacyValue: i.old.quantityMinor, newValue: i.new.quantityMinor, toleranceMinor: 0 });
    if (i.differs.includes('value')) comparisons.push({ area: 'item_value', subject: subjectOf(i.productId), legacyValue: i.old.valueMinor, newValue: i.new.valueMinor, toleranceMinor: tol.valueMinor });
    if (i.differs.includes('tax') && i.new.tax.known) comparisons.push({ area: 'item_tax', subject: subjectOf(i.productId), legacyValue: i.old.taxMinor, newValue: i.new.tax.minor, toleranceMinor: tol.taxMinor });
  }
  for (const n of notInCatalogue.values()) comparisons.push({ area: 'item_not_in_catalogue', subject: subjectOf(n.code), legacyValue: 1, newValue: 0, toleranceMinor: 0 });
  for (const b of billDiffs) {
    if (b.kind === 'not_keyed') comparisons.push({ area: 'bill_not_keyed', subject: b.billNumber, legacyValue: 1, newValue: 0, toleranceMinor: 0 });
    else if (b.kind === 'not_on_old') comparisons.push({ area: 'bill_not_on_old', subject: b.billNumber, legacyValue: 0, newValue: 1, toleranceMinor: 0 });
    else comparisons.push({ area: 'bill_value', subject: b.billNumber, legacyValue: b.oldValueMinor!, newValue: b.newValueMinor!, toleranceMinor: tol.valueMinor });
  }
  for (const e of explain) comparisons.push({ area: 'old_return', subject: e.subject, legacyValue: 1, newValue: 0, toleranceMinor: 0 });

  const differing = comparisons.filter((c) => Math.abs(c.newValue - c.legacyValue) > c.toleranceMinor).length;
  if (notInCatalogue.size > MAX_DAY_DIFFERENCES) {
    return { ok: false, refusedBecause: 'too_many_differences', detail: `${notInCatalogue.size} items in the item-wise file are not in the new catalogue. If this is the whole shop's report, save it again for the pilot department (${dept.name}) only, and load that. Nothing was kept.` };
  }
  if (differing > MAX_DAY_DIFFERENCES) {
    return { ok: false, refusedBecause: 'too_many_differences', detail: `${differing} differences — that is a wrong column in the mapping or another day's file, not a day to explain line by line. Check the mapping and the day of both files. Nothing was kept.` };
  }

  return {
    ok: true,
    check: {
      businessDate: day,
      department: { categoryId: dept.categoryId, name: dept.name },
      tolerance: tol,
      items,
      notInCatalogue: [...notInCatalogue.values()].sort((a, b) => (a.code < b.code ? -1 : 1)),
      otherDepartments: { rows: otherRows, valueMinor: otherValue },
      newOutsideDepartment: { lines: outsideLines, valueMinor: outsideValue },
      totals: { value: { old: valueOld, new: valueNew }, tax: { old: taxOld, new: taxNew }, quantity, bills: { old: billsOld, new: newBills } },
      bills: { checked: input.billWise.withLines ? 'lines' : 'presence_only', matched, differences: billDiffs },
      explain,
      notCompared: [{ area: 'payments', decision: 'OB-256' }, { area: 'loyalty', decision: 'OB-265' }],
      comparisons,
    },
  };
}
