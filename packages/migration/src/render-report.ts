// Rendering a known dataset AS one of these reports — OB-06, MG-01, MG-05.
//
// The Stage 11 rehearsal proves the migration engine against a synthetic dataset in this
// product's own clean shape. That was the right test for the engine. It is **not** the shape the
// data will actually arrive in, now that we extract it ourselves (OB-06): what arrives is a
// printed page in a spreadsheet, with a banner, page breaks, repeated headers and group
// subtotals threaded through it.
//
// So this renders a dataset we already know the truth about **back into that mess** — and the
// rehearsal then reads it with the same parser that will read the real thing.
//
// **The round trip is the point.** We generated the data, so we know exactly what should come
// back. Any row the parser drops, any subtotal it counts as a product, any figure it misreads,
// shows up as a difference against a dataset we hold in our hand. That is a far stronger check
// than parsing a real file and squinting at whether the answer looks plausible — because with a
// real file, nobody knows what the right answer was.
//
// Deliberately faithful to what these systems print, including the parts that are inconvenient:
// the banner repeats on every page, the header comes back after each break, groups carry their
// own subtotals, and the money is written in Indian digit grouping with two decimals always.
//
// Pure and deterministic: no I/O, no clock, no randomness.

import type { LegacyDataset, LegacyProduct } from './synthetic';

export interface RenderOptions {
  /** Rows per printed page. These reports break every 40–60 lines. */
  readonly rowsPerPage?: number;
  /** Group rows by department and print a subtotal per group, as the real report does. */
  readonly groupByDepartment?: boolean;
  readonly reportTitle?: string;
  readonly asOn?: string;
  readonly shopName?: string;
}

/**
 * Format minor units the way these reports print money: Indian grouping, two decimals always.
 *
 * `41200000` → `4,12,000.00`. Separators go at three digits, then every two — which is the
 * convention the parser has to read back, and getting it wrong here would make the round trip
 * agree with itself while both ends were wrong.
 */
export function formatIndianMoney(minor: number): string {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const paise = String(abs % 100).padStart(2, '0');

  const digits = String(whole);
  let grouped: string;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    const last3 = digits.slice(-3);
    let rest = digits.slice(0, -3);
    const parts: string[] = [];
    while (rest.length > 2) {
      parts.unshift(rest.slice(-2));
      rest = rest.slice(0, -2);
    }
    if (rest.length > 0) parts.unshift(rest);
    grouped = `${parts.join(',')},${last3}`;
  }

  return `${negative ? '-' : ''}${grouped}.${paise}`;
}

const STOCK_HEADER = ['Item Code', 'Description', 'Dept', 'Qty', 'Rate', 'Value'] as const;

/**
 * Render the stock position as a printed valuation report.
 *
 * Every piece of furniture a real one carries is here, because every piece of it is something the
 * parser has to survive: the shop banner on each page, the header after each break, a subtotal
 * per department, a grand total, and a print stamp at the end.
 */
export function renderStockReport(
  dataset: LegacyDataset,
  options: RenderOptions = {},
): readonly (readonly string[])[] {
  const rowsPerPage = options.rowsPerPage ?? 40;
  const shopName = options.shopName ?? 'SRE HYPER MARKET';
  const title = options.reportTitle ?? 'Stock Valuation Report';
  const asOn = options.asOn ?? 'As on 31/03/2026';
  const width = STOCK_HEADER.length;
  const pad = (cells: readonly string[]): string[] =>
    [...cells, ...Array<string>(Math.max(0, width - cells.length)).fill('')];

  const byId = new Map<string, LegacyProduct>(dataset.products.map((p) => [p.legacyId, p]));

  // Rows to print, in the order the report would print them.
  interface Line { readonly product: LegacyProduct; readonly qty: number; readonly valueMinor: number }
  const lines: Line[] = [];
  for (const s of dataset.stock) {
    const product = byId.get(s.legacyProductId);
    if (product === undefined) continue;
    lines.push({ product, qty: s.qty, valueMinor: s.valueMinor });
  }

  const groups = options.groupByDepartment !== false
    ? [...new Set(lines.map((l) => l.product.departmentCode))].sort()
    : [''];

  const grid: string[][] = [];
  let onPage = 0;
  let grandTotalMinor = 0;

  const banner = (): void => {
    grid.push(pad([shopName]));
    grid.push(pad([title]));
    grid.push(pad([asOn]));
    grid.push(pad([]));
    grid.push(pad([...STOCK_HEADER]));
    onPage = 0;
  };

  // Page numbers are stamped with a placeholder and rewritten at the end. A real report knows
  // its page count because it is rendered before it is printed; emitting "of ?" would make the
  // completeness check untestable against the one signal that works when nobody wrote a count
  // down.
  const PAGE_PLACEHOLDER = '\u0000TOTAL\u0000';
  const pageBreak = (pageNumber: number): void => {
    grid.push(pad([]));
    grid.push(pad([`Page ${pageNumber} of ${PAGE_PLACEHOLDER}`]));
    banner();
  };

  banner();
  let page = 1;

  for (const department of groups) {
    const inGroup = options.groupByDepartment !== false
      ? lines.filter((l) => l.product.departmentCode === department)
      : lines;
    if (inGroup.length === 0) continue;

    let groupTotalMinor = 0;
    for (const line of inGroup) {
      if (onPage >= rowsPerPage) {
        page += 1;
        pageBreak(page - 1);
      }
      grid.push([
        line.product.legacyId,
        line.product.name,
        line.product.departmentCode,
        String(line.qty),
        formatIndianMoney(line.product.costMinor),
        formatIndianMoney(line.valueMinor),
      ]);
      groupTotalMinor += line.valueMinor;
      onPage += 1;
    }

    if (options.groupByDepartment !== false) {
      grid.push(pad([`Total for ${department}`, '', '', '', '', formatIndianMoney(groupTotalMinor)]));
      grid.push(pad([]));
      onPage += 2;
    }
    grandTotalMinor += groupTotalMinor;
  }

  grid.push(pad(['GRAND TOTAL', '', '', '', '', formatIndianMoney(grandTotalMinor)]));
  grid.push(pad(['Printed on 31/03/2026 by ADMIN']));
  grid.push(pad([`Page ${page} of ${PAGE_PLACEHOLDER}`]));

  const total = String(page);
  return grid.map((row) => row.map((cell) => cell.split(PAGE_PLACEHOLDER).join(total)));
}

export interface RoundTrip {
  readonly expectedRows: number;
  readonly parsedRows: number;
  readonly expectedTotalMinor: number;
  readonly parsedTotalMinor: number;
  /** Rows the parser produced that are not in the source, and vice versa. Named, not counted. */
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly lossless: boolean;
  readonly detail: string;
}

/**
 * Compare what came back out of the parser against the dataset that went in.
 *
 * The check that a real file can never give: we know the answer. A row dropped at a page break,
 * a subtotal counted as a product or a misread figure all show up here against ground truth —
 * **named**, so the failure says which product went missing rather than that the count is short.
 */
export function checkRoundTrip(input: {
  readonly dataset: LegacyDataset;
  readonly parsedRows: readonly Readonly<Record<string, string>>[];
  readonly idColumn?: string;
  readonly valueColumn?: string;
  /** Parses a printed figure back to minor units — injected so this file stays dependency-free. */
  readonly parseMoney: (text: string) => { readonly minor: number } | undefined;
}): RoundTrip {
  const idColumn = input.idColumn ?? 'Item Code';
  const valueColumn = input.valueColumn ?? 'Value';

  const known = new Set(input.dataset.products.map((p) => p.legacyId));
  const expectedLines = input.dataset.stock.filter((s) => known.has(s.legacyProductId));
  const expectedTotalMinor = expectedLines.reduce((t, s) => t + s.valueMinor, 0);

  // Multiset comparison: a product legitimately appears once per location, so counting distinct
  // ids would hide a lost duplicate — which is exactly the row a page break eats.
  const tally = (xs: readonly string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const expectedTally = tally(expectedLines.map((s) => s.legacyProductId));
  const parsedTally = tally(input.parsedRows.map((r) => r[idColumn] ?? ''));

  const missing: string[] = [];
  const extra: string[] = [];
  for (const [id, n] of expectedTally) {
    const got = parsedTally.get(id) ?? 0;
    if (got < n) missing.push(`${id} × ${n - got}`);
  }
  for (const [id, n] of parsedTally) {
    const want = expectedTally.get(id) ?? 0;
    if (n > want) extra.push(`${id} × ${n - want}`);
  }

  let parsedTotalMinor = 0;
  for (const row of input.parsedRows) {
    const parsed = input.parseMoney(row[valueColumn] ?? '');
    if (parsed !== undefined) parsedTotalMinor += parsed.minor;
  }

  const lossless = missing.length === 0 && extra.length === 0
    && parsedTotalMinor === expectedTotalMinor;

  return {
    expectedRows: expectedLines.length,
    parsedRows: input.parsedRows.length,
    expectedTotalMinor,
    parsedTotalMinor,
    missing: missing.sort(),
    extra: extra.sort(),
    lossless,
    detail: lossless
      ? `${expectedLines.length} rows and ${expectedTotalMinor} in minor units survived the round trip exactly — through ${input.parsedRows.length > 0 ? 'page breaks, repeated headers and group subtotals' : 'nothing'}`
      : `round trip LOST something: ${missing.length} rows missing (${missing.slice(0, 5).join(', ')}), ${extra.length} extra (${extra.slice(0, 5).join(', ')}), total out by ${parsedTotalMinor - expectedTotalMinor}`,
  };
}
