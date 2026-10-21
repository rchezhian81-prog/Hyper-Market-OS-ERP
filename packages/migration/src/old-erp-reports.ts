// OB-263 (owner, 21 Oct 2026, "Item-wise + bill-wise") — reading the old ERP's two evening reports, saved from Excel as CSV.
//
// Each evening the owner saves two reports for the day from the old ERP: an ITEM-WISE sales report (per item: the code or
// barcode, quantity, value and tax) and a BILL-WISE list (per bill: the number, the date, the total and, if the report has
// them, the item lines). We do not know the old ERP's own column names, so nothing here guesses one:
//
//   • our own TEMPLATES name our fields (`OLD_ERP_REPORTS`), and a downloadable header-only CSV carries them;
//   • a one-time MAPPING says, for each of our fields, which column of the old ERP's own header row holds it — picked by the
//     owner from that header row, saved on the store computer per report, changeable with a record of who changed it;
//   • a file is read ONLY through its mapping: a column that is not mapped is never read into a figure and never kept, so a
//     customer's name or phone number in the old report goes nowhere (OB-252, P-04).
//
// Excel's CSV, as it really is: a UTF-8 byte-order mark; commas or semicolons; "quoted" cells with "" inside and line
// breaks inside; report title lines above the header row; a total line at the bottom; Indian grouping ("1,23,456.50");
// rupees with or without paise, with or without "₹" / "Rs."; a minus sign or (brackets) for a minus figure; dates as the
// cell shows them. Rupees become PAISE by reading the digits — never through a floating-point number. A long barcode that
// Excel turned into "8.90123E+12" has lost its digits, and is refused in words rather than matched to the wrong item.
//
// A file is refused WHOLE, with each problem's line, when a mapped column is missing, a figure cannot be read, or a date is
// not the chosen day: a row that cannot be read is a difference nobody could see (P-08, hard rule #10).
//
// Pure: no clock, no I/O, no Node built-ins (the migration screen reads a file's header row with this same code).

import { readOldErpBillNumber } from '../../tender/src/old-erp-bill-number';

export type OldErpReportKind = 'item_wise' | 'bill_wise';
export const OLD_ERP_REPORT_KINDS: readonly OldErpReportKind[] = Object.freeze(['item_wise', 'bill_wise']);

export type ItemWiseField = 'item_code' | 'quantity' | 'value' | 'tax' | 'sale_date' | 'department';
export type BillWiseField = 'bill_number' | 'bill_date' | 'bill_total' | 'item_code' | 'quantity' | 'line_value';
export type ReportField = ItemWiseField | BillWiseField;

export interface ReportFieldSpec {
  readonly key: ReportField;
  readonly required: boolean;
  /** What the field is, in English and Tamil — the mapping step's label and the template's help. */
  readonly words: { readonly en: string; readonly ta: string };
}

export interface OldErpReportSpec {
  readonly kind: OldErpReportKind;
  /** The template file a person downloads. */
  readonly file: string;
  readonly fields: readonly ReportFieldSpec[];
}

/** Our two templates. The column names are OURS; the old ERP's are mapped onto them once. */
export const OLD_ERP_REPORTS: Readonly<Record<OldErpReportKind, OldErpReportSpec>> = Object.freeze({
  item_wise: {
    kind: 'item_wise',
    file: 'old-erp-item-wise-template.csv',
    fields: [
      { key: 'item_code', required: true, words: { en: 'Item code or barcode', ta: 'பொருள் குறியீடு அல்லது பார்கோடு' } },
      { key: 'quantity', required: true, words: { en: 'Quantity sold', ta: 'விற்ற அளவு' } },
      { key: 'value', required: true, words: { en: 'Sales value (₹)', ta: 'விற்பனை மதிப்பு (₹)' } },
      { key: 'tax', required: true, words: { en: 'Tax (₹)', ta: 'வரி (₹)' } },
      { key: 'sale_date', required: false, words: { en: 'Date (if the report has a date column)', ta: 'தேதி (அறிக்கையில் தேதி நெடுவரிசை இருந்தால்)' } },
      // OB-263 A (owner, 21 Oct 2026, "Pick dept column"): the report's own department column, and which of its values is
      // the pilot department — then every other department's rows are set aside, counted.
      { key: 'department', required: false, words: { en: 'Department (if the report has a department column)', ta: 'துறை (அறிக்கையில் துறை நெடுவரிசை இருந்தால்)' } },
    ],
  },
  bill_wise: {
    kind: 'bill_wise',
    file: 'old-erp-bill-wise-template.csv',
    fields: [
      { key: 'bill_number', required: true, words: { en: 'Bill number', ta: 'பில் எண்' } },
      { key: 'bill_date', required: true, words: { en: 'Bill date', ta: 'பில் தேதி' } },
      { key: 'bill_total', required: true, words: { en: 'Bill total (₹)', ta: 'பில் மொத்தம் (₹)' } },
      { key: 'item_code', required: false, words: { en: 'Item code or barcode on the bill line (if the report lists items)', ta: 'பில் வரியில் பொருள் குறியீடு அல்லது பார்கோடு (அறிக்கையில் பொருட்கள் இருந்தால்)' } },
      { key: 'quantity', required: false, words: { en: 'Quantity on the bill line (if listed)', ta: 'பில் வரியில் அளவு (இருந்தால்)' } },
      { key: 'line_value', required: false, words: { en: 'Value of the bill line, tax included (₹, if listed)', ta: 'பில் வரியின் மதிப்பு, வரி உட்பட (₹, இருந்தால்)' } },
    ],
  },
}) as Readonly<Record<OldErpReportKind, OldErpReportSpec>>;

/** The header-only template a person downloads: our column names, one line, nothing else. */
export function oldErpTemplateCsv(kind: OldErpReportKind): string {
  return `${OLD_ERP_REPORTS[kind].fields.map((f) => f.key).join(',')}\r\n`;
}

/** The biggest file the evening check reads: a whole shop's bill list with its item lines for one day fits well inside. */
export const OLD_ERP_FILE_MAX_BYTES = 5 * 1024 * 1024;
/** The most data rows one file may hold. More is the wrong report (a month), not a day to compare. */
export const OLD_ERP_FILE_MAX_ROWS = 100_000;
/** How far down the header row may be (report title lines come first). */
const HEADER_SEARCH_ROWS = 30;
/** The most problems a refusal lists by line (the rest are counted). */
const PROBLEMS_LISTED = 12;

// ── The CSV itself ───────────────────────────────────────────────────────────────────────────────────────────────

export interface CsvTable {
  readonly separator: ',' | ';';
  /** Each record with the line it starts on (1-based) and its cells. Blank lines are left out. */
  readonly records: readonly { readonly line: number; readonly cells: readonly string[] }[];
}

export type CsvRead = { readonly ok: true; readonly table: CsvTable } | { readonly ok: false; readonly problem: string };

/** Count a character outside quotes on the first non-blank line — how Excel's separator is told apart. */
function countOutsideQuotes(line: string, ch: string): number {
  let n = 0;
  let q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (!q && c === ch) n += 1;
  }
  return n;
}

/**
 * Read Excel's CSV: the byte-order mark removed, the separator (comma or semicolon) worked out from the first line with
 * cells, "quoted" cells with "" inside and line breaks inside. A quote that never closes refuses the file.
 */
export function readCsv(text: string): CsvRead {
  const body = text.replace(/^\uFEFF/, '');
  if (body.includes('\u0000')) return { ok: false, problem: 'This is not a CSV text file (it holds binary data). Save the report from Excel as "CSV UTF-8 (Comma delimited)".' };
  const firstLine = body.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  if (firstLine === '') return { ok: false, problem: 'The file is empty.' };
  const separator: ',' | ';' = countOutsideQuotes(firstLine, ';') > countOutsideQuotes(firstLine, ',') ? ';' : ',';
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let startLine = 1;
  let any = false;
  const endRecord = (): void => {
    cells.push(field);
    if (cells.some((c) => c.trim() !== '')) records.push({ line: startLine, cells });
    cells = [];
    field = '';
    any = false;
  };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (!any) { startLine = line; any = true; }
    if (ch === '"' && field.trim() === '') { inQuotes = true; field = ''; continue; }
    if (ch === separator) { cells.push(field); field = ''; continue; }
    if (ch === '\r' && body[i + 1] === '\n') continue;
    if (ch === '\n' || ch === '\r') { endRecord(); line += 1; continue; }
    field += ch;
  }
  if (inQuotes) return { ok: false, problem: `A quoted cell that starts on line ${startLine} is never closed — the file is cut off or not a CSV.` };
  if (any || field !== '' || cells.length > 0) endRecord();
  return { ok: true, table: { separator, records } };
}

/** A header cell as compared: trimmed, spaces collapsed, case ignored. Shown to the owner as the file writes it. */
export const headerKey = (cell: string): string => cell.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The file's own header row, for the one-time mapping step: the first record with at least two non-blank cells (report
 * title lines above it have one). Each cell as the file writes it, trimmed. Nothing below the header is read.
 */
export function headerRowOf(text: string): { readonly ok: true; readonly line: number; readonly columns: readonly string[] } | { readonly ok: false; readonly problem: string } {
  const read = readCsv(text);
  if (!read.ok) return read;
  const row = read.table.records.slice(0, HEADER_SEARCH_ROWS).find((r) => r.cells.filter((c) => c.trim() !== '').length >= 2);
  if (row === undefined) return { ok: false, problem: 'No header row was found: the first lines of the file have no row with two or more column names.' };
  const columns = row.cells.map((c) => c.trim()).filter((c) => c !== '');
  return { ok: true, line: row.line, columns };
}

/**
 * The distinct values of one column below the header row, as the file writes them — for the mapping step's "which of
 * these is the pilot department" (OB-263 A). Only that column is read; at most `limit` values.
 */
export function columnValuesOf(text: string, column: string, limit = 200): readonly string[] {
  const read = readCsv(text);
  if (!read.ok) return [];
  const want = headerKey(column);
  const index = read.table.records.slice(0, HEADER_SEARCH_ROWS).findIndex((r) => r.cells.some((c) => headerKey(c) === want));
  if (index < 0) return [];
  const at = read.table.records[index]!.cells.findIndex((c) => headerKey(c) === want);
  const seen = new Map<string, string>();
  for (const r of read.table.records.slice(index + 1)) {
    const v = (r.cells[at] ?? '').trim();
    if (v === '' || isTotalLine(v) || seen.has(headerKey(v))) continue;
    seen.set(headerKey(v), v.slice(0, 120));
    if (seen.size >= limit) break;
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// ── Figures ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Indian (1,23,456) or international (123,456) grouping of the whole-rupee part, or no grouping at all. */
const GROUPED = /^(\d+|\d{1,2}(,\d{2})*,\d{3}|\d{1,3}(,\d{3})+)$/;

interface Decimal { readonly negative: boolean; readonly whole: string; readonly fraction: string }

/** Read a decimal figure as Excel writes it, without ever making a floating-point number. */
function readDecimal(raw: string): Decimal | undefined {
  let t = raw.trim().replace(/\u00A0/g, ' ');
  if (t === '') return undefined;
  let negative = false;
  if (/^\(.*\)$/.test(t)) { negative = true; t = t.slice(1, -1).trim(); }
  if (t.startsWith('-')) { negative = !negative; t = t.slice(1).trim(); }
  t = t.replace(/^(₹|rs\.?|inr)\s*/i, '');
  if (t.startsWith('-')) { negative = !negative; t = t.slice(1).trim(); }
  t = t.replace(/\s+/g, '');
  const m = /^([\d,]+)(?:\.(\d*))?$/.exec(t) ?? /^\.(\d+)$/.exec(t);
  if (m === null) return undefined;
  const whole = m.length === 3 ? m[1]! : '0';
  const fraction = m.length === 3 ? (m[2] ?? '') : m[1]!;
  if (!GROUPED.test(whole)) return undefined;
  return { negative, whole: whole.replace(/,/g, ''), fraction };
}

/** "1,23,456.50" → 12345650 paise. Rupees with or without paise; more than two decimals only when the rest are zeros. */
export function rupeesToPaise(raw: string): number | undefined {
  const d = readDecimal(raw);
  if (d === undefined) return undefined;
  if (d.fraction.length > 2 && !/^0*$/.test(d.fraction.slice(2))) return undefined;
  const paise = Number(d.whole) * 100 + Number((d.fraction + '00').slice(0, 2));
  if (!Number.isSafeInteger(paise)) return undefined;
  return d.negative && paise !== 0 ? -paise : paise;
}

/** "1.234" → 1234 thousandths; "2" → 2000. Up to three decimals (a gram of a kilo); more only when the rest are zeros. */
export function quantityToThousandths(raw: string): number | undefined {
  const d = readDecimal(raw);
  if (d === undefined) return undefined;
  if (d.fraction.length > 3 && !/^0*$/.test(d.fraction.slice(3))) return undefined;
  const milli = Number(d.whole) * 1000 + Number((d.fraction + '000').slice(0, 3));
  if (!Number.isSafeInteger(milli)) return undefined;
  return d.negative && milli !== 0 ? -milli : milli;
}

export type DateOrder = 'dmy' | 'mdy' | 'ymd';
export const DATE_ORDERS: readonly DateOrder[] = Object.freeze(['dmy', 'mdy', 'ymd']);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A date as the cell shows it → "YYYY-MM-DD", read in the ORDER the mapping says (day first, month first or year first —
 * "03/04/2026" is never guessed). A month written as a word ("21-Oct-2026") is read by its name. A time after the date is
 * ignored. A two-figure year is 20YY. Undefined for anything that is not a real calendar date.
 */
export function readOldErpDate(raw: string, order: DateOrder): string | undefined {
  const t = raw.trim().split(/[ T]/)[0] ?? '';
  const parts = t.split(/[/.-]/).filter((p) => p !== '');
  if (parts.length !== 3) return undefined;
  let y: string; let m: string; let d: string;
  const named = parts.findIndex((p) => /^[a-z]{3,9}$/i.test(p));
  if (named >= 0) {
    const month = MONTHS.indexOf(parts[named]!.slice(0, 3).toLowerCase());
    if (month < 0) return undefined;
    m = String(month + 1);
    const rest = parts.filter((_, i) => i !== named);
    [d, y] = order === 'ymd' ? [rest[1]!, rest[0]!] : [rest[0]!, rest[1]!];
  } else if (order === 'ymd') [y, m, d] = parts as [string, string, string];
  else if (order === 'dmy') [d, m, y] = parts as [string, string, string];
  else [m, d, y] = parts as [string, string, string];
  if (!/^\d{1,2}$/.test(d) || !/^\d{1,2}$/.test(m) || !/^(\d{2}|\d{4})$/.test(y)) return undefined;
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return undefined;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > last) return undefined;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** An item code as matched: trimmed, Excel's text mark ("'0123") removed. */
export const cleanItemCode = (raw: string): string => raw.trim().replace(/^'/, '').trim();
/** Excel turned a long number into "8.90123E+12": its digits are gone. */
export const isScientificNotation = (code: string): boolean => /^\d+(\.\d+)?e\+?\d+$/i.test(code);
/** A total line at the foot of a report, not an item or a bill. */
export const isTotalLine = (code: string): boolean => /^(grand\s*|sub\s*|net\s*)?total\b/i.test(code.trim());

// ── The mapping ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ColumnMapping {
  readonly kind: OldErpReportKind;
  /** For each of our fields, the old ERP's column name as its header row writes it. A field not listed is not mapped. */
  readonly columns: Readonly<Partial<Record<ReportField, string>>>;
  /** How the report writes its dates (needed whenever a date column is mapped). */
  readonly dateOrder?: DateOrder;
  /** Item-wise only: does the report's value already include the tax? If not, value + tax is what the customer paid. */
  readonly valueIncludesTax?: boolean;
  /**
   * Item-wise, with the department column mapped (OB-263 A): which of that column's values, as the file writes it, is the
   * pilot department. Rows with any other value are set aside and counted, never compared.
   */
  readonly pilotDepartmentValue?: string;
  /**
   * Bill-wise, with the item lines mapped (OB-263 B, owner, 21 Oct 2026, "Ask once when mapping"): do the line values
   * already include the tax? If not, the pilot lines are compared without tax against the new till's lines without tax.
   */
  readonly lineValuesIncludeTax?: boolean;
}

export type MappingJudgement = { readonly ok: true; readonly mapping: ColumnMapping } | { readonly ok: false; readonly problems: readonly string[] };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Judge a mapping as sent by the screen: every required field mapped, no column used twice, the date order chosen when a
 * date is mapped, the tax question answered for the item-wise report, and a bill's item lines mapped all together (code
 * and value) or not at all. With `header`, every mapped column must be on that header row.
 */
export function judgeMapping(kind: OldErpReportKind, raw: unknown, header?: readonly string[]): MappingJudgement {
  const spec = OLD_ERP_REPORTS[kind];
  const problems: string[] = [];
  const body = isObj(raw) ? raw : {};
  const given = isObj(body['columns']) ? body['columns'] : {};
  const columns: Partial<Record<ReportField, string>> = {};
  const known = new Set<string>(spec.fields.map((f) => f.key));
  for (const [k, v] of Object.entries(given)) {
    if (!known.has(k)) { problems.push(`"${k}" is not a field of the ${kind === 'item_wise' ? 'item-wise' : 'bill-wise'} report`); continue; }
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || v.trim() === '' || v.length > 120) { problems.push(`the column for "${k}" must be a column name from the file`); continue; }
    columns[k as ReportField] = v.trim();
  }
  for (const f of spec.fields) if (f.required && columns[f.key] === undefined) problems.push(`choose the column for "${f.words.en}"`);
  const used = Object.entries(columns).map(([k, v]) => [k, headerKey(v!)] as const);
  for (const [k, v] of used) {
    const other = used.find(([k2, v2]) => k2 !== k && v2 === v);
    if (other !== undefined && k < other[0]) problems.push(`one column ("${columns[k as ReportField]}") cannot be both "${k}" and "${other[0]}"`);
  }
  const dateMapped = columns.sale_date !== undefined || columns.bill_date !== undefined;
  const dateOrder = body['dateOrder'];
  if (dateMapped && !(DATE_ORDERS as readonly unknown[]).includes(dateOrder)) problems.push('say how the report writes its dates: day first (21/10/2026), month first (10/21/2026) or year first (2026-10-21)');
  const valueIncludesTax = body['valueIncludesTax'];
  if (kind === 'item_wise' && typeof valueIncludesTax !== 'boolean') problems.push('say whether the report\'s sales value already includes the tax');
  if (kind === 'bill_wise' && (columns.item_code !== undefined || columns.line_value !== undefined || columns.quantity !== undefined)
    && (columns.item_code === undefined || columns.line_value === undefined)) {
    problems.push('a bill\'s item lines need both the item code and the line value columns (the quantity is optional) — or none of them');
  }
  const linesMapped = kind === 'bill_wise' && columns.item_code !== undefined && columns.line_value !== undefined;
  const lineValuesIncludeTax = body['lineValuesIncludeTax'];
  if (linesMapped && typeof lineValuesIncludeTax !== 'boolean') problems.push('say whether the bill lines\' values already include the tax');
  const deptValue = body['pilotDepartmentValue'];
  const deptMapped = kind === 'item_wise' && columns.department !== undefined;
  if (deptMapped && (typeof deptValue !== 'string' || deptValue.trim() === '' || deptValue.length > 120)) {
    problems.push('choose which value of the department column is the pilot department');
  }
  if (header !== undefined) {
    const have = new Set(header.map(headerKey));
    for (const [k, v] of Object.entries(columns)) if (!have.has(headerKey(v!))) problems.push(`the file has no column "${v}" (chosen for "${k}")`);
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    mapping: {
      kind, columns,
      ...(dateMapped ? { dateOrder: dateOrder as DateOrder } : {}),
      ...(kind === 'item_wise' ? { valueIncludesTax: valueIncludesTax as boolean } : {}),
      ...(deptMapped ? { pilotDepartmentValue: (deptValue as string).trim() } : {}),
      ...(linesMapped ? { lineValuesIncludeTax: lineValuesIncludeTax as boolean } : {}),
    },
  };
}

// ── Reading a report through its mapping ─────────────────────────────────────────────────────────────────────────

/** One item-wise row, as kept: our fields only. */
export interface ItemWiseRow {
  readonly line: number;
  readonly code: string;
  readonly quantityThousandths: number;
  /** What the customer paid for the item, tax included (value + tax when the report's value excludes it). */
  readonly valueMinor: number;
  readonly taxMinor: number;
}

/** One bill line, as kept. */
export interface BillLine {
  readonly line: number;
  readonly code: string;
  readonly quantityThousandths?: number;
  readonly valueMinor: number;
}

/** One bill on the bill-wise list, as kept. */
export interface OldBill {
  readonly billNumber: string;
  readonly line: number;
  readonly totalMinor: number;
  /** Present only when the mapping has the item lines. */
  readonly lines?: readonly BillLine[];
}

/** What reading a file set aside, counted and said — never silently. */
export interface ReadSummary {
  readonly headerLine: number;
  readonly rowsRead: number;
  /** Lines under the header with no item code / bill number: blank lines in a report's layout. */
  readonly withoutCode: number;
  /** A "Total" / "Grand total" line at the foot of the report. */
  readonly totalLines: number;
  /** Bill-wise with item lines: line rows that took the bill number from the row above (a grouped report). */
  readonly linesUnderBillAbove?: number;
  /** Item-wise: whether the report's own date column was checked against the chosen day. */
  readonly dateChecked?: boolean;
  /**
   * Item-wise with the department column mapped (OB-263 A): the pilot department's value it kept, and the rows it set
   * aside — another department's, and rows with no department written — counted, never compared.
   */
  readonly department?: { readonly pilotValue: string; readonly otherDepartmentRows: number; readonly noDepartmentRows: number };
  /** Bill-wise with item lines (OB-263 B): whether the line values include the tax. */
  readonly lineValuesIncludeTax?: boolean;
}

export type ReportRefusal = 'not_csv' | 'too_large' | 'too_many_rows' | 'header_not_found' | 'unreadable_rows' | 'wrong_day' | 'looks_personal' | 'repeated_bill';

export type ReportRead<T> =
  | ({ readonly ok: true; readonly summary: ReadSummary } & T)
  | { readonly ok: false; readonly refusedBecause: ReportRefusal; readonly problems: readonly string[] };

const refuse = (refusedBecause: ReportRefusal, problems: readonly string[]): { readonly ok: false; readonly refusedBecause: ReportRefusal; readonly problems: readonly string[] } =>
  ({ ok: false, refusedBecause, problems: problems.length > PROBLEMS_LISTED ? [...problems.slice(0, PROBLEMS_LISTED), `… and ${problems.length - PROBLEMS_LISTED} more`] : problems });

/** Find the header row that holds every mapped column, and where each one is. */
function locate(table: CsvTable, mapping: ColumnMapping): { readonly line: number; readonly index: number; readonly at: Partial<Record<ReportField, number>> } | { readonly missing: readonly string[] } {
  const wanted = (Object.entries(mapping.columns) as [ReportField, string | undefined][]).filter((e): e is [ReportField, string] => typeof e[1] === 'string');
  let best: { missing: string[] } | undefined;
  for (let i = 0; i < Math.min(table.records.length, HEADER_SEARCH_ROWS); i += 1) {
    const keys = table.records[i]!.cells.map(headerKey);
    const at: Partial<Record<ReportField, number>> = {};
    const missing: string[] = [];
    for (const [field, column] of wanted) {
      const k = keys.indexOf(headerKey(column));
      if (k < 0) missing.push(column); else at[field] = k;
    }
    if (missing.length === 0) return { line: table.records[i]!.line, index: i, at };
    if (best === undefined || missing.length < best.missing.length) best = { missing };
  }
  return { missing: best?.missing ?? wanted.map(([, c]) => c) };
}

function tableOf(text: string, kind: OldErpReportKind, mapping: ColumnMapping):
  | { readonly ok: true; readonly table: CsvTable; readonly header: { readonly line: number; readonly index: number; readonly at: Partial<Record<ReportField, number>> } }
  | { readonly ok: false; readonly refusedBecause: ReportRefusal; readonly problems: readonly string[] } {
  if (mapping.kind !== kind) return refuse('header_not_found', [`this mapping is for the ${mapping.kind === 'item_wise' ? 'item-wise' : 'bill-wise'} report`]);
  if (text.length > OLD_ERP_FILE_MAX_BYTES) return refuse('too_large', [`the file is larger than ${OLD_ERP_FILE_MAX_BYTES / (1024 * 1024)} MB — that is not one day's report for one department`]);
  const read = readCsv(text);
  if (!read.ok) return refuse('not_csv', [read.problem]);
  if (read.table.records.length > OLD_ERP_FILE_MAX_ROWS + HEADER_SEARCH_ROWS) return refuse('too_many_rows', [`the file has more than ${OLD_ERP_FILE_MAX_ROWS} rows — choose one day's report, not a month's`]);
  const header = locate(read.table, mapping);
  if ('missing' in header) {
    return refuse('header_not_found', header.missing.map((c) => `the file has no column "${c}" — the mapping says this column holds one of our fields. If the old system's report changed, change the mapping.`));
  }
  return { ok: true, table: read.table, header };
}

const cell = (cells: readonly string[], at: number | undefined): string => (at === undefined ? '' : (cells[at] ?? '').trim());

/** Read the item-wise report for `day` through its mapping. */
export function readItemWiseReport(input: { readonly text: string; readonly mapping: ColumnMapping; readonly day: string }): ReportRead<{ readonly rows: readonly ItemWiseRow[] }> {
  const t = tableOf(input.text, 'item_wise', input.mapping);
  if (!t.ok) return t;
  const { at } = t.header;
  const rows: ItemWiseRow[] = [];
  const problems: string[] = [];
  const wrongDays = new Set<string>();
  let withoutCode = 0;
  let totalLines = 0;
  let otherDepartmentRows = 0;
  let noDepartmentRows = 0;
  const pilot = at.department === undefined || input.mapping.pilotDepartmentValue === undefined ? undefined : headerKey(input.mapping.pilotDepartmentValue);
  for (const r of t.table.records.slice(t.header.index + 1)) {
    const rawCode = cell(r.cells, at.item_code);
    const code = cleanItemCode(rawCode);
    if (isTotalLine(code)) { totalLines += 1; continue; }
    // OB-263 A: another department's row is set aside before it is read at all — counted, never compared.
    if (pilot !== undefined) {
      const dept = headerKey(cell(r.cells, at.department));
      if (dept === '') { if (code !== '') noDepartmentRows += 1; else withoutCode += 1; continue; }
      if (dept !== pilot) { otherDepartmentRows += 1; continue; }
    }
    if (code === '') { withoutCode += 1; continue; }
    const lineProblems: string[] = [];
    if (isScientificNotation(code)) lineProblems.push(`the item code "${code}" was turned into a number by Excel and its digits are lost — format that column as Text in Excel and save again`);
    else if (code.length > 64) lineProblems.push(`the item code "${code.slice(0, 20)}…" is longer than 64 characters`);
    const quantity = quantityToThousandths(cell(r.cells, at.quantity));
    if (quantity === undefined) lineProblems.push(`the quantity "${cell(r.cells, at.quantity)}" is not a number`);
    const value = rupeesToPaise(cell(r.cells, at.value));
    if (value === undefined) lineProblems.push(`the value "${cell(r.cells, at.value)}" is not a rupee amount`);
    const tax = rupeesToPaise(cell(r.cells, at.tax));
    if (tax === undefined) lineProblems.push(`the tax "${cell(r.cells, at.tax)}" is not a rupee amount`);
    if (at.sale_date !== undefined) {
      const date = readOldErpDate(cell(r.cells, at.sale_date), input.mapping.dateOrder ?? 'dmy');
      if (date === undefined) lineProblems.push(`the date "${cell(r.cells, at.sale_date)}" is not a date written ${orderWords(input.mapping.dateOrder)}`);
      else if (date !== input.day) wrongDays.add(date);
    }
    if (lineProblems.length > 0) { problems.push(`line ${r.line}: ${lineProblems.join('; ')}`); continue; }
    rows.push({
      line: r.line, code, quantityThousandths: quantity!,
      valueMinor: input.mapping.valueIncludesTax === false ? value! + tax! : value!, taxMinor: tax!,
    });
  }
  if (wrongDays.size > 0) return refuse('wrong_day', [`this item-wise report is for ${[...wrongDays].sort().join(', ')}, not ${input.day} — save the report for ${input.day} and load that`]);
  if (problems.length > 0) return refuse('unreadable_rows', problems);
  return {
    ok: true, rows,
    summary: {
      headerLine: t.header.line, rowsRead: rows.length, withoutCode, totalLines, dateChecked: at.sale_date !== undefined,
      ...(pilot === undefined ? {} : { department: { pilotValue: input.mapping.pilotDepartmentValue!, otherDepartmentRows, noDepartmentRows } }),
    },
  };
}

const orderWords = (o: DateOrder | undefined): string => (o === 'mdy' ? 'month first' : o === 'ymd' ? 'year first' : 'day first');

/**
 * Read the bill-wise list for `day` through its mapping. With the item lines mapped, rows with the same bill number are
 * that bill's lines, and a line row with no bill number belongs to the bill above it (a grouped report); the bill's date
 * and total may be written on its first row only, but where written twice they must agree.
 */
export function readBillWiseReport(input: { readonly text: string; readonly mapping: ColumnMapping; readonly day: string }): ReportRead<{ readonly bills: readonly OldBill[]; readonly withLines: boolean }> {
  const t = tableOf(input.text, 'bill_wise', input.mapping);
  if (!t.ok) return t;
  const { at } = t.header;
  const withLines = at.item_code !== undefined && at.line_value !== undefined;
  const bills = new Map<string, { billNumber: string; line: number; total?: number; date?: string; lines: BillLine[] }>();
  const problems: string[] = [];
  const wrongDays = new Set<string>();
  let personal = 0;
  let withoutCode = 0;
  let totalLines = 0;
  let underAbove = 0;
  let current: string | undefined;
  for (const r of t.table.records.slice(t.header.index + 1)) {
    const rawBill = cell(r.cells, at.bill_number);
    const lineCode = withLines ? cleanItemCode(cell(r.cells, at.item_code)) : '';
    if (isTotalLine(rawBill) || (rawBill === '' && isTotalLine(lineCode))) { totalLines += 1; current = undefined; continue; }
    let billNumber: string;
    if (rawBill === '') {
      if (withLines && lineCode !== '' && current !== undefined) { billNumber = current; underAbove += 1; } else { withoutCode += 1; continue; }
    } else {
      const read = readOldErpBillNumber(rawBill);
      if (!read.ok) {
        if (read.refusedBecause === 'old_bill_looks_personal') personal += 1;
        else problems.push(`line ${r.line}: "${rawBill}" is not a bill number (letters, digits, "-" and "/", up to 16)`);
        continue;
      }
      billNumber = read.value;
    }
    const lineProblems: string[] = [];
    const held = bills.get(billNumber);
    if (held !== undefined && !withLines && rawBill !== '') {
      return refuse('repeated_bill', [`bill ${billNumber} is on more than one row (lines ${held.line} and ${r.line}). If the report lists each bill's items, choose the item columns in the mapping; if not, the report lists a bill twice.`]);
    }
    const bill = held ?? { billNumber, line: r.line, lines: [] };
    const totalText = cell(r.cells, at.bill_total);
    if (totalText !== '') {
      const total = rupeesToPaise(totalText);
      if (total === undefined) lineProblems.push(`the bill total "${totalText}" is not a rupee amount`);
      else if (bill.total !== undefined && bill.total !== total) lineProblems.push(`bill ${billNumber} shows two different totals`);
      else bill.total = total;
    }
    const dateText = cell(r.cells, at.bill_date);
    if (dateText !== '') {
      const date = readOldErpDate(dateText, input.mapping.dateOrder ?? 'dmy');
      if (date === undefined) lineProblems.push(`the date "${dateText}" is not a date written ${orderWords(input.mapping.dateOrder)}`);
      else { bill.date = date; if (date !== input.day) wrongDays.add(date); }
    }
    if (withLines && lineCode !== '') {
      if (isScientificNotation(lineCode)) lineProblems.push(`the item code "${lineCode}" was turned into a number by Excel and its digits are lost — format that column as Text and save again`);
      const value = rupeesToPaise(cell(r.cells, at.line_value));
      if (value === undefined) lineProblems.push(`the line value "${cell(r.cells, at.line_value)}" is not a rupee amount`);
      const qText = cell(r.cells, at.quantity);
      const quantity = at.quantity === undefined || qText === '' ? undefined : quantityToThousandths(qText);
      if (at.quantity !== undefined && qText !== '' && quantity === undefined) lineProblems.push(`the quantity "${qText}" is not a number`);
      if (lineProblems.length === 0) bill.lines.push({ line: r.line, code: lineCode, valueMinor: value!, ...(quantity === undefined ? {} : { quantityThousandths: quantity }) });
    }
    if (lineProblems.length > 0) { problems.push(`line ${r.line}: ${lineProblems.join('; ')}`); continue; }
    bills.set(billNumber, bill);
    current = billNumber;
  }
  if (personal > 0) {
    return refuse('looks_personal', [`${personal} row(s) in the column chosen for the bill number look like phone, Aadhaar or card numbers. Check the mapping: choose the column that holds the bill number. Nothing was kept.`]);
  }
  for (const b of bills.values()) {
    if (b.total === undefined) problems.push(`bill ${b.billNumber} (line ${b.line}) has no total`);
    if (b.date === undefined) problems.push(`bill ${b.billNumber} (line ${b.line}) has no date`);
  }
  if (wrongDays.size > 0) return refuse('wrong_day', [`this bill list has bills dated ${[...wrongDays].sort().join(', ')}, not only ${input.day} — save the list for ${input.day} alone and load that`]);
  if (problems.length > 0) return refuse('unreadable_rows', problems);
  const out: OldBill[] = [...bills.values()].map((b) => ({
    billNumber: b.billNumber, line: b.line, totalMinor: b.total!, ...(withLines ? { lines: b.lines } : {}),
  }));
  return {
    ok: true, bills: out, withLines,
    summary: {
      headerLine: t.header.line, rowsRead: out.length, withoutCode, totalLines,
      ...(withLines ? { linesUnderBillAbove: underAbove, lineValuesIncludeTax: input.mapping.lineValuesIncludeTax !== false } : {}),
    },
  };
}
