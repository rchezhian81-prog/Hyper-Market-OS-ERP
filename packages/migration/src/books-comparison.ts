// MG-10 "Operate old and new systems for the approved period and reconcile DAILY" — the books side of the day (OB-288 P5).
//
// The evening check (`evening-check.ts`) compares the day's SALES, old against new. What the parallel run did not compare
// each day (STATUS: "purchase/balance/margin daily controls not covered"): what the shop BOUGHT, what it OWES and is OWED,
// what it HOLDS, and what it MADE. Here the old ERP's own day reports — saved from Excel as CSV, read through a one-time
// column mapping exactly as the evening check reads its two (no column name is ever guessed) — are compared with head
// office's own registers for the same day:
//
//   • PURCHASES — the purchase register (bill by bill: supplier, bill number, value with tax) against the supplier bills
//     head office captured for the day: per bill, plus bills on one side only, plus the day's total;
//   • SUPPLIER BALANCES — what the old ERP says is owed to each supplier against the purchase register's own figure;
//   • CUSTOMER BALANCES — what each credit customer owes, old against the credit-customer ledger;
//   • STOCK — the closing stock (item by item quantity, and the total value) against head office's stock ledger;
//   • MARGIN — the day's sales net of tax and the cost of what was sold, old against head office's books.
//
// Matching is by code: the old supplier, customer and item codes are the ids the migration loaded them under (MG-05).
// A code on one side only is a difference by name. A figure head office cannot work out (an item with no buying cost,
// a day book not posted) is NOT COMPARED and listed — never a zero standing in for "not known" (P-08); the day cannot be
// signed while anything stays not compared. Every difference beyond the reconciler's tolerance becomes one MG-10 line
// with its own subject, so each needs its own reason before the day is signed (`signParallelDay`).
//
// Pure and deterministic.

import { readCsv, headerKey, rupeesToPaise, quantityToThousandths, cleanItemCode, isTotalLine, isScientificNotation, readOldErpDate, type DateOrder } from './old-erp-reports';
import type { DayComparison, BooksDayArea } from './cutover';

export type BooksReport = 'purchase_register' | 'supplier_balances' | 'customer_balances' | 'stock_balance' | 'margin';
export const BOOKS_REPORTS: readonly BooksReport[] = Object.freeze(['purchase_register', 'supplier_balances', 'customer_balances', 'stock_balance', 'margin']);

/** The MG-10 areas the books side adds (each line carries its subject; the totals carry none). */
export type BooksArea = BooksDayArea;
export const BOOKS_AREAS: readonly BooksArea[] = Object.freeze([
  'purchases_value', 'purchase_bill_value', 'purchase_bill_not_on_new', 'purchase_bill_not_on_old',
  'supplier_balance', 'supplier_balance_total', 'customer_balance', 'customer_balance_total',
  'stock_quantity', 'stock_value_total', 'margin_sales_net', 'margin_cost',
]);

interface ReportField { readonly key: string; readonly required: boolean; readonly kind: 'code' | 'rupees' | 'quantity' | 'date'; readonly words: { readonly en: string; readonly ta: string } }

/** Our templates. The column names are OURS; the old ERP's are mapped onto them once. */
export const BOOKS_REPORT_SPECS: Readonly<Record<BooksReport, { readonly report: BooksReport; readonly file: string; readonly fields: readonly ReportField[]; readonly words: { readonly en: string; readonly ta: string } }>> = Object.freeze({
  purchase_register: {
    report: 'purchase_register', file: 'old-erp-purchase-register-template.csv', words: { en: 'Purchase register for the day', ta: 'அன்றைய கொள்முதல் பதிவேடு' },
    fields: [
      { key: 'supplier_code', required: true, kind: 'code', words: { en: 'Supplier code', ta: 'சப்ளையர் குறியீடு' } },
      { key: 'bill_number', required: true, kind: 'code', words: { en: 'Supplier bill number', ta: 'சப்ளையர் பில் எண்' } },
      { key: 'bill_date', required: false, kind: 'date', words: { en: 'Bill date', ta: 'பில் தேதி' } },
      { key: 'bill_value', required: true, kind: 'rupees', words: { en: 'Bill value with tax (₹)', ta: 'வரியுடன் பில் மதிப்பு (₹)' } },
    ],
  },
  supplier_balances: {
    report: 'supplier_balances', file: 'old-erp-supplier-balances-template.csv', words: { en: 'Supplier outstanding', ta: 'சப்ளையர் நிலுவை' },
    fields: [
      { key: 'supplier_code', required: true, kind: 'code', words: { en: 'Supplier code', ta: 'சப்ளையர் குறியீடு' } },
      { key: 'balance', required: true, kind: 'rupees', words: { en: 'Amount owed to the supplier (₹)', ta: 'சப்ளையருக்குச் செலுத்த வேண்டிய தொகை (₹)' } },
    ],
  },
  customer_balances: {
    report: 'customer_balances', file: 'old-erp-customer-balances-template.csv', words: { en: 'Credit customer outstanding', ta: 'கடன் வாடிக்கையாளர் நிலுவை' },
    fields: [
      { key: 'customer_code', required: true, kind: 'code', words: { en: 'Customer code', ta: 'வாடிக்கையாளர் குறியீடு' } },
      { key: 'balance', required: true, kind: 'rupees', words: { en: 'Amount the customer owes (₹)', ta: 'வாடிக்கையாளர் செலுத்த வேண்டிய தொகை (₹)' } },
    ],
  },
  stock_balance: {
    report: 'stock_balance', file: 'old-erp-stock-balance-template.csv', words: { en: 'Closing stock', ta: 'இறுதி இருப்பு' },
    fields: [
      { key: 'item_code', required: true, kind: 'code', words: { en: 'Item code or barcode', ta: 'பொருள் குறியீடு அல்லது பார்கோடு' } },
      { key: 'quantity', required: true, kind: 'quantity', words: { en: 'Quantity in stock', ta: 'இருப்பில் உள்ள அளவு' } },
      { key: 'value', required: false, kind: 'rupees', words: { en: 'Stock value (₹, if the report has it)', ta: 'இருப்பு மதிப்பு (₹, அறிக்கையில் இருந்தால்)' } },
    ],
  },
  margin: {
    report: 'margin', file: 'old-erp-margin-template.csv', words: { en: 'Gross profit for the day', ta: 'அன்றைய மொத்த லாபம்' },
    fields: [
      { key: 'item_code', required: false, kind: 'code', words: { en: 'Item code (if the report is item by item)', ta: 'பொருள் குறியீடு (அறிக்கை பொருள் வாரியாக இருந்தால்)' } },
      { key: 'sales_value', required: true, kind: 'rupees', words: { en: 'Sales net of tax (₹)', ta: 'வரி நீங்கிய விற்பனை (₹)' } },
      { key: 'cost_value', required: true, kind: 'rupees', words: { en: 'Cost of goods sold (₹)', ta: 'விற்ற பொருட்களின் அடக்கவிலை (₹)' } },
    ],
  },
});

/** The header-only template a person downloads: our column names, one line, nothing else. */
export function booksTemplateCsv(report: BooksReport): string {
  return `${BOOKS_REPORT_SPECS[report].fields.map((f) => f.key).join(',')}\r\n`;
}

export type Row = Readonly<Record<string, number | string>>;
export type BooksRead = { readonly ok: true; readonly rows: readonly Row[] } | { readonly ok: false; readonly problems: readonly string[] };

/** Read one old-ERP report through its mapping. Refused whole on an unreadable row (P-08). */
export function readBooksReport(input: { readonly report: BooksReport; readonly text: string; readonly mapping: unknown; readonly day: string; readonly dateOrder?: DateOrder }): BooksRead {
  const spec = BOOKS_REPORT_SPECS[input.report];
  const m = input.mapping;
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return { ok: false, problems: ['the column mapping is { "<our field>": "<the old ERP\'s column name>" }'] };
  const mapping = m as Record<string, unknown>;
  const problems: string[] = [];
  for (const f of spec.fields) {
    if (mapping[f.key] === undefined) { if (f.required) problems.push(`"${f.key}" (${f.words.en}) is required and is not mapped`); continue; }
    if (typeof mapping[f.key] !== 'string' || (mapping[f.key] as string).trim() === '') problems.push(`"${f.key}" is mapped to an empty column name`);
  }
  for (const k of Object.keys(mapping)) if (!spec.fields.some((f) => f.key === k)) problems.push(`"${k}" is not a field of ${spec.words.en.toLowerCase()}`);
  if (problems.length > 0) return { ok: false, problems };
  const csv = readCsv(input.text);
  if (!csv.ok) return { ok: false, problems: [csv.problem] };
  const wanted = Object.values(mapping).map((c) => headerKey(c as string));
  const headerIndex = csv.table.records.findIndex((r) => wanted.every((w) => r.cells.map(headerKey).includes(w)));
  if (headerIndex < 0) return { ok: false, problems: [`no row of the file holds every mapped column (${Object.values(mapping).join(', ')})`] };
  const header = csv.table.records[headerIndex]!.cells.map(headerKey);
  const rows: Row[] = [];
  for (const rec of csv.table.records.slice(headerIndex + 1)) {
    if (rec.cells.every((c) => c.trim() === '')) continue;
    const cell = (k: string): string => { const col = mapping[k]; if (col === undefined) return ''; const i = header.indexOf(headerKey(col as string)); return i < 0 ? '' : (rec.cells[i] ?? '').trim(); };
    const first = spec.fields.find((f) => f.kind === 'code' && mapping[f.key] !== undefined);
    if (first !== undefined && isTotalLine(cell(first.key))) continue;
    if (first === undefined && rec.cells.some((c) => isTotalLine(c))) continue;
    const row: Record<string, number | string> = {};
    for (const f of spec.fields) {
      if (mapping[f.key] === undefined) continue;
      const raw = f.kind === 'code' ? cleanItemCode(cell(f.key)) : cell(f.key);
      if (raw === '') { if (f.required) problems.push(`line ${rec.line}: ${f.words.en} is empty`); continue; }
      if (f.kind === 'code') {
        if (isScientificNotation(raw)) { problems.push(`line ${rec.line}: "${raw}" lost its digits in Excel — format the column as text`); continue; }
        row[f.key] = raw;
      } else if (f.kind === 'rupees') {
        const p = rupeesToPaise(raw);
        if (p === undefined) problems.push(`line ${rec.line}: "${raw}" is not a rupee figure (${f.words.en})`); else row[f.key] = p;
      } else if (f.kind === 'quantity') {
        const q = quantityToThousandths(raw);
        if (q === undefined) problems.push(`line ${rec.line}: "${raw}" is not a quantity (${f.words.en})`); else row[f.key] = q;
      } else {
        const d = readOldErpDate(raw, input.dateOrder ?? 'dmy');
        if (d === undefined) problems.push(`line ${rec.line}: "${raw}" is not a date`);
        else if (d !== input.day) problems.push(`line ${rec.line}: the bill is dated ${d}, not ${input.day} — this is another day's report`);
        else row[f.key] = d;
      }
    }
    rows.push(row);
  }
  if (problems.length > 0) return { ok: false, problems: problems.slice(0, 12).concat(problems.length > 12 ? [`… and ${problems.length - 12} more`] : []) };
  return { ok: true, rows };
}

/** What head office holds for the day, read by its adapter from its own registers. `null` means not known — never zero. */
export interface HeadOfficeBooksDay {
  readonly purchases: readonly { readonly supplierId: string; readonly billNumber: string; readonly valueMinor: number }[];
  readonly supplierBalances: readonly { readonly supplierId: string; readonly owedMinor: number }[];
  readonly customerBalances: readonly { readonly customerId: string; readonly owedMinor: number }[];
  /** On hand per product in THOUSANDTHS of its unit (1 each = 1000), and the value at head office's cost (null: no cost). */
  readonly stock: readonly { readonly productId: string; readonly thousandths: number; readonly valueMinor: number | null }[];
  readonly margin: { readonly salesNetMinor: number | null; readonly costMinor: number | null; readonly whyNot?: string };
}

export interface BooksTolerance { readonly valueMinor: number; readonly quantityThousandths: number }

export interface BooksComparison {
  readonly comparisons: readonly DayComparison[];
  /** What could not be compared, with why — the day is not signed while any is here. */
  readonly notCompared: readonly { readonly area: BooksArea; readonly subject?: string; readonly why: string }[];
  /** Which reports were given (a report not given is said, never compared as empty). */
  readonly reports: readonly BooksReport[];
}

/** A subject for an MG-10 line: letters, digits and a few marks, at most 64 characters (`isComparisonSubject`). */
export const subjectOf = (s: string): string => s.replace(/[^A-Za-z0-9 ._/:@#-]/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64) || 'x';

/** Compare the given old reports with head office's day. Pure. */
export function compareBooksDay(input: {
  readonly old: Partial<Record<BooksReport, readonly Row[]>>;
  readonly ho: HeadOfficeBooksDay;
  readonly tolerance: BooksTolerance;
}): BooksComparison {
  const out: DayComparison[] = [];
  const notCompared: { area: BooksArea; subject?: string; why: string }[] = [];
  const tol = input.tolerance;
  const line = (area: BooksArea, legacyValue: number, newValue: number, toleranceMinor: number, subject?: string): void => {
    out.push({ area: area as DayComparison['area'], legacyValue, newValue, toleranceMinor, ...(subject === undefined ? {} : { subject: subjectOf(subject) }) });
  };
  const sum = (rows: readonly Row[], k: string): number => rows.reduce((s, r) => s + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0);

  const pr = input.old.purchase_register;
  if (pr !== undefined) {
    const oldBills = new Map<string, number>();
    for (const r of pr) { const k = `${r['supplier_code']}/${r['bill_number']}`; oldBills.set(k, (oldBills.get(k) ?? 0) + (r['bill_value'] as number)); }
    const newBills = new Map<string, number>();
    for (const b of input.ho.purchases) { const k = `${b.supplierId}/${b.billNumber}`; newBills.set(k, (newBills.get(k) ?? 0) + b.valueMinor); }
    for (const k of [...new Set([...oldBills.keys(), ...newBills.keys()])].sort()) {
      const o = oldBills.get(k);
      const n = newBills.get(k);
      if (o !== undefined && n !== undefined) { if (Math.abs(o - n) > tol.valueMinor) line('purchase_bill_value', o, n, tol.valueMinor, k); }
      else if (o !== undefined) line('purchase_bill_not_on_new', 1, 0, 0, k);
      else line('purchase_bill_not_on_old', 0, 1, 0, k);
    }
    line('purchases_value', sum(pr, 'bill_value'), input.ho.purchases.reduce((s, b) => s + b.valueMinor, 0), tol.valueMinor);
  }

  const balances = (rows: readonly Row[] | undefined, codeKey: string, ho: readonly { id: string; owedMinor: number }[], area: BooksArea, totalArea: BooksArea): void => {
    if (rows === undefined) return;
    const oldBy = new Map<string, number>();
    for (const r of rows) oldBy.set(r[codeKey] as string, (oldBy.get(r[codeKey] as string) ?? 0) + (r['balance'] as number));
    const newBy = new Map(ho.map((x) => [x.id, x.owedMinor] as const));
    for (const k of [...new Set([...oldBy.keys(), ...newBy.keys()])].sort()) {
      const o = oldBy.get(k) ?? 0;
      const n = newBy.get(k) ?? 0;
      if (Math.abs(o - n) > tol.valueMinor) line(area, o, n, tol.valueMinor, k);
    }
    line(totalArea, sum(rows, 'balance'), ho.reduce((s, x) => s + x.owedMinor, 0), tol.valueMinor);
  };
  balances(input.old.supplier_balances, 'supplier_code', input.ho.supplierBalances.map((x) => ({ id: x.supplierId, owedMinor: x.owedMinor })), 'supplier_balance', 'supplier_balance_total');
  balances(input.old.customer_balances, 'customer_code', input.ho.customerBalances.map((x) => ({ id: x.customerId, owedMinor: x.owedMinor })), 'customer_balance', 'customer_balance_total');

  const sb = input.old.stock_balance;
  if (sb !== undefined) {
    const oldQty = new Map<string, number>();
    for (const r of sb) oldQty.set(r['item_code'] as string, (oldQty.get(r['item_code'] as string) ?? 0) + (r['quantity'] as number));
    const newQty = new Map<string, number>();
    for (const s of input.ho.stock) newQty.set(s.productId, (newQty.get(s.productId) ?? 0) + s.thousandths);
    for (const k of [...new Set([...oldQty.keys(), ...newQty.keys()])].sort()) {
      const o = oldQty.get(k) ?? 0;
      const n = newQty.get(k) ?? 0;
      if (Math.abs(o - n) > tol.quantityThousandths) line('stock_quantity', o, n, tol.quantityThousandths, k);
    }
    if (sb.some((r) => typeof r['value'] === 'number')) {
      const unvalued = input.ho.stock.filter((s) => s.valueMinor === null && s.thousandths !== 0).map((s) => s.productId);
      if (unvalued.length > 0) notCompared.push({ area: 'stock_value_total', why: `head office holds no buying cost for ${unvalued.slice(0, 10).join(', ')}${unvalued.length > 10 ? ` and ${unvalued.length - 10} more` : ''}, so the stock value is not known (never valued at zero)` });
      else line('stock_value_total', sum(sb, 'value'), input.ho.stock.reduce((s, x) => s + (x.valueMinor ?? 0), 0), tol.valueMinor);
    }
  }

  const mg = input.old.margin;
  if (mg !== undefined) {
    if (input.ho.margin.salesNetMinor === null) notCompared.push({ area: 'margin_sales_net', why: input.ho.margin.whyNot ?? 'the day\'s sales net of tax are not in head office\'s books yet' });
    else line('margin_sales_net', sum(mg, 'sales_value'), input.ho.margin.salesNetMinor, tol.valueMinor);
    if (input.ho.margin.costMinor === null) notCompared.push({ area: 'margin_cost', why: input.ho.margin.whyNot ?? 'what the day\'s sales cost is not known at head office' });
    else line('margin_cost', sum(mg, 'cost_value'), input.ho.margin.costMinor, tol.valueMinor);
  }
  return { comparisons: out, notCompared, reports: BOOKS_REPORTS.filter((r) => input.old[r] !== undefined) };
}
