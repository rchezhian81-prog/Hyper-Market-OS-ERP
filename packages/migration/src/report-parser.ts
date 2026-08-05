// Reading what a fifteen-year-old ERP actually exports — MG-01, MG-04, §29.1, OB-06.
//
// The self-extraction decision (OB-06) makes this module necessary. `packages/import` takes clean
// rows and validates them; nothing turns **what these systems actually produce** into rows.
//
// What they produce is not a data file. It is a **printed page that happens to be in a
// spreadsheet**, and it contains everything a printed page contains:
//
//     SRE HYPER MARKET
//     Stock Valuation Report
//     As on 31/03/2026
//
//     Item Code   Description        Dept    Qty      Rate      Value
//     P00001      Aachi Rice 1kg     GRO     412      52.00     21,424.00
//     ...
//     Total for GROCERY                                      4,12,000.00
//                                                    <page break>
//     SRE HYPER MARKET                                    ← the header comes back
//     Item Code   Description        Dept    Qty      Rate      Value
//     ...
//     GRAND TOTAL                                        84,12,000.00
//     Printed 31/03/2026 by ADMIN                        Page 47 of 47
//
// Two things in there will corrupt a migration silently if this module gets them wrong.
//
//   • **`4,12,000.00` IS 4,12,000 — twelve lakh, not four thousand.** Indian digit grouping puts
//     separators at three, then two, then two. Stripping commas happens to work for both
//     conventions, which is why this is dangerous: a parser that *validates* grouping against
//     the Western convention rejects real data, and one that "corrects" it silently multiplies
//     a stock valuation by a factor nobody will notice until an audit.
//   • **`parseFloat(x) * 100` IS WRONG**, always, and it is the line everybody writes. `19.99`
//     times a hundred is 1998.9999999999998 in every language with binary floats. §29.1 says
//     integer minor units, so the decimal part is parsed **as text** and added as an integer.
//     There is no float in this file.
//
// And one thing the report gives us for free: **its own subtotals check our parsing.** If the
// rows we extracted do not add up to the total the report printed beside them, we mis-read the
// file. That is not verification of the ERP — nothing here is, and `extraction.ts` refuses to
// pretend otherwise — but it is a complete, free check that the *reading* was right.
//
// Pure and deterministic: no I/O, no clock, no float.

/** Money as this codebase requires it: an exact integer count of the smallest unit (§29.1). */
export interface ParsedMoney {
  readonly minor: number;
  /** The text it came from, kept so an exception can quote the page (MG-04, hard rule #6). */
  readonly source: string;
}

/**
 * Parse a money figure off a report, exactly.
 *
 * Handles what these reports actually print: `₹`, `Rs.`, Indian or Western grouping, a trailing
 * `CR`/`DR`, parentheses or a trailing minus for negatives, and a bare `-` meaning nil — which is
 * extremely common in Indian reports and is a *number*, not a missing value.
 *
 * `CR` is returned **negative**. In a payables or ledger report a credit balance is money owed by
 * us, and reading it as positive is how a migration inverts the sign of every supplier balance
 * and reconciles to a total that is exactly twice the truth.
 */
export function parseReportMoney(text: string): ParsedMoney | undefined {
  const source = text;
  let s = text.trim();
  if (s === '') return undefined;

  // A lone dash (or en/em dash) is how these reports print nil. It is a zero, not a blank.
  if (/^[-–—]$/.test(s)) return { minor: 0, source };

  let negative = false;

  // (1,200.00) — accounting negative.
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  // Trailing CR/DR. CR is a credit: negative in the sense a migration cares about.
  const crdr = /\s*(CR|DR)\.?$/i.exec(s);
  if (crdr !== null) {
    if (crdr[1]!.toUpperCase() === 'CR') negative = !negative;
    s = s.slice(0, crdr.index).trim();
  }

  // Currency marks and whitespace, INCLUDING the non-breaking space and byte-order mark that
  // Excel leaves in exported cells. Written as escapes rather than as literal bytes: a raw NBSP
  // in a source file is invisible in review and makes the diff unreadable (hard rule #8), which
  // is exactly what the `plain-text-source` guardrail exists to catch — and did, here.
  s = s.replace(/[₹]|Rs\.?|INR/gi, '').replace(/[\s\u00a0\ufeff]/g, '').trim();

  // Trailing or leading minus.
  if (s.endsWith('-')) { negative = !negative; s = s.slice(0, -1); }
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);

  // Separators are dropped rather than validated. Indian grouping (4,12,000) and Western
  // (412,000) both mean the same number once the commas are gone, and a parser that insists on
  // one convention rejects real files from the other.
  s = s.replace(/,/g, '');

  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return undefined;

  const [wholeText = '0', fracText = ''] = s.split('.');
  // The decimal part is parsed AS TEXT. `parseFloat(x) * 100` is the line that turns 19.99 into
  // 1998.9999999999998, and it is wrong in every language with binary floating point.
  const frac = `${fracText}00`.slice(0, 2);
  const whole = wholeText === '' ? 0 : Number(wholeText);
  if (!Number.isSafeInteger(whole)) return undefined;

  const minor = whole * 100 + Number(frac);
  if (!Number.isSafeInteger(minor)) return undefined;

  return { minor: negative ? -minor : minor, source };
}

/** Parse a plain quantity — no currency, but the same grouping and negative conventions. */
export function parseReportQuantity(text: string): number | undefined {
  const money = parseReportMoney(text);
  if (money === undefined) return undefined;
  return money.minor / 100;
}

// ── Row classification ────────────────────────────────────────────────────────

export type RowKind =
  | 'data'
  | 'header'
  /** The header again, after a page break. Dropped, but counted — see below. */
  | 'repeated_header'
  | 'subtotal'
  | 'grand_total'
  | 'title'
  | 'blank'
  | 'footer';

export interface ClassifiedRow {
  readonly lineNumber: number;
  readonly kind: RowKind;
  readonly cells: readonly string[];
  readonly why: string;
}

const SUBTOTAL_MARKERS = /^(total\s+for|sub[\s-]?total|group\s+total|dept(artment)?\s+total)\b/i;
const GRAND_MARKERS = /^(grand\s+total|report\s+total|net\s+total|total)\s*:?\s*$/i;
const FOOTER_MARKERS = /(page\s+\d+\s+of\s+\d+|printed\s+(on|by)|generated\s+(on|by)|\*{3,}|end\s+of\s+report)/i;

const normalise = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Decide what one row is.
 *
 * Ordered so the ambiguous cases resolve the safe way. A subtotal misread as data **adds the
 * group's total to the group's own rows** and doubles it — which reconciles to a number that
 * looks plausible and is exactly wrong, so subtotals are matched before anything else.
 */
export function classifyRow(input: {
  readonly cells: readonly string[];
  readonly lineNumber: number;
  readonly header?: readonly string[];
}): ClassifiedRow {
  const cells = input.cells;
  const at = { lineNumber: input.lineNumber, cells };
  const filled = cells.filter((c) => c.trim() !== '');
  const first = normalise(cells[0] ?? '');
  const joined = normalise(cells.join(' '));

  if (filled.length === 0) {
    return { ...at, kind: 'blank', why: 'no cell has any content' };
  }

  if (FOOTER_MARKERS.test(joined)) {
    return { ...at, kind: 'footer', why: 'page furniture: a page number, a print stamp or an end marker' };
  }

  // Subtotals FIRST. A "Total for GROCERY" row read as data adds the group's own total back into
  // the group, and the result is a valuation that is plausibly wrong rather than obviously wrong.
  if (SUBTOTAL_MARKERS.test(first) || SUBTOTAL_MARKERS.test(joined)) {
    return { ...at, kind: 'subtotal', why: `a group subtotal — must never be counted as a row of data` };
  }
  if (GRAND_MARKERS.test(first) || GRAND_MARKERS.test(joined)) {
    return { ...at, kind: 'grand_total', why: 'the report total' };
  }

  if (input.header !== undefined) {
    const headerKey = input.header.map(normalise).filter((c) => c !== '').join('|');
    const rowKey = cells.map(normalise).filter((c) => c !== '').join('|');
    if (headerKey === rowKey) {
      return { ...at, kind: 'repeated_header', why: 'the column header again, after a page break' };
    }
  }

  // A single filled cell in a wide row is a title or a banner, not a record.
  if (filled.length === 1 && cells.length > 2) {
    return { ...at, kind: 'title', why: 'one cell in a wide row: a title or a group banner, not a record' };
  }

  return { ...at, kind: 'data', why: 'a row of data' };
}

// ── Whole-report parsing ──────────────────────────────────────────────────────

export interface ParsedSubtotal {
  readonly label: string;
  readonly lineNumber: number;
  readonly amount?: ParsedMoney;
}

export interface ParsedReport {
  readonly header: readonly string[];
  readonly headerLine: number;
  /** Data rows only, keyed by the header. Ready for `packages/import` to validate. */
  readonly rows: readonly Readonly<Record<string, string>>[];
  /** The source line each row came from, so an exception can quote the page (MG-04). */
  readonly lineNumbers: readonly number[];
  readonly subtotals: readonly ParsedSubtotal[];
  readonly grandTotal?: ParsedSubtotal;
  /** Everything dropped, with the reason. Nothing vanishes silently (P-08). */
  readonly dropped: readonly ClassifiedRow[];
  readonly detail: string;
}

export type ParseRefusal = 'no_header_found' | 'no_data_rows' | 'ragged_rows';

export interface ParseResult {
  readonly ok: boolean;
  readonly report?: ParsedReport;
  readonly refusedBecause?: ParseRefusal;
  readonly detail: string;
}

/**
 * Turn a raw exported grid into rows, subtotals and a list of what was dropped and why.
 *
 * The header is **found**, not assumed to be line 1: these exports begin with the shop's name,
 * the report title and the date, and a parser that takes the first line as the header produces a
 * dataset whose columns are named after a shop.
 *
 * Nothing is discarded silently. Every dropped line is returned with its reason, because the
 * question after a short load is always *"where did the other four hundred rows go"* and a
 * parser that cannot answer it makes that unanswerable (P-08, hard rule #6).
 */
export function parseReport(input: {
  readonly grid: readonly (readonly string[])[];
  /** A column name expected in the header, used to find it. Case-insensitive, partial. */
  readonly expectColumn: string;
  /** How far to look before giving up. These reports rarely have more than a dozen title rows. */
  readonly searchLimit?: number;
}): ParseResult {
  const limit = Math.min(input.searchLimit ?? 30, input.grid.length);
  const wanted = normalise(input.expectColumn);

  let headerLine = -1;
  for (let i = 0; i < limit; i += 1) {
    const row = input.grid[i] ?? [];
    const filled = row.filter((c) => c.trim() !== '');
    if (filled.length < 2) continue;
    if (row.some((c) => normalise(c).includes(wanted))) {
      headerLine = i;
      break;
    }
  }

  if (headerLine === -1) {
    return {
      ok: false, refusedBecause: 'no_header_found',
      detail: `no header row containing "${input.expectColumn}" in the first ${limit} lines. Refused rather than guessed: taking line 1 as the header on one of these exports names the columns after the shop`,
    };
  }

  const header = (input.grid[headerLine] ?? []).map((c) => c.trim());
  const rows: Record<string, string>[] = [];
  const lineNumbers: number[] = [];
  const subtotals: ParsedSubtotal[] = [];
  const dropped: ClassifiedRow[] = [];
  let grandTotal: ParsedSubtotal | undefined;

  // The banner above the header is accounted for too. It is tempting to skip it — it is the shop
  // name and the report title, and obviously not data — but "nothing is discarded silently" has
  // to be true of the WHOLE file or it is not a claim anybody can rely on. The question after a
  // short load is *"where did the other rows go"*, and it is asked about the file, not about the
  // part below the header.
  for (let i = 0; i < headerLine; i += 1) {
    dropped.push(classifyRow({ cells: (input.grid[i] ?? []).map((c) => c.trim()), lineNumber: i + 1 }));
  }

  for (let i = headerLine + 1; i < input.grid.length; i += 1) {
    const cells = (input.grid[i] ?? []).map((c) => c.trim());
    const classified = classifyRow({ cells, lineNumber: i + 1, header });

    if (classified.kind === 'data') {
      const row: Record<string, string> = {};
      header.forEach((name, column) => {
        if (name !== '') row[name] = cells[column] ?? '';
      });
      rows.push(row);
      lineNumbers.push(i + 1);
      continue;
    }

    if (classified.kind === 'subtotal' || classified.kind === 'grand_total') {
      // The rightmost parseable figure. A subtotal line prints its amount in the value column,
      // with the label on the left and blanks between.
      let amount: ParsedMoney | undefined;
      for (let c = cells.length - 1; c >= 0; c -= 1) {
        const parsed = parseReportMoney(cells[c] ?? '');
        if (parsed !== undefined && (cells[c] ?? '').trim() !== '') { amount = parsed; break; }
      }
      const entry: ParsedSubtotal = {
        label: cells.find((c) => c !== '') ?? '',
        lineNumber: i + 1,
        ...(amount === undefined ? {} : { amount }),
      };
      if (classified.kind === 'grand_total') grandTotal = entry; else subtotals.push(entry);
    }

    dropped.push(classified);
  }

  if (rows.length === 0) {
    return {
      ok: false, refusedBecause: 'no_data_rows',
      detail: `header found at line ${headerLine + 1} but no data rows beneath it — an empty parse is a mis-read file, not an empty report`,
    };
  }

  const droppedByKind = dropped.reduce<Record<string, number>>((acc, d) => {
    acc[d.kind] = (acc[d.kind] ?? 0) + 1;
    return acc;
  }, {});

  return {
    ok: true,
    report: {
      header, headerLine: headerLine + 1, rows, lineNumbers, subtotals,
      ...(grandTotal === undefined ? {} : { grandTotal }),
      dropped,
      detail: `${rows.length} data rows from line ${headerLine + 2}; dropped ${dropped.length} (${Object.entries(droppedByKind).map(([k, n]) => `${n} ${k}`).join(', ')})`,
    },
    detail: `parsed ${rows.length} rows, ${subtotals.length} subtotals${grandTotal ? ' and a grand total' : ''}`,
  };
}

// ── The report checks our reading ─────────────────────────────────────────────

export interface ParseCheck {
  readonly checked: number;
  readonly ourTotalMinor: number;
  readonly printedTotalMinor?: number;
  readonly differenceMinor: number;
  readonly matches: boolean;
  /** Never `true`: this checks the READING, not the incumbent system. */
  readonly verifiesTheData: false;
  readonly detail: string;
}

/**
 * Add up what we parsed and compare it to the total the report printed.
 *
 * A complete, free check that the **reading** was right — a mis-classified subtotal, a
 * misparsed Indian-grouped figure or a dropped page all show up here as an exact difference.
 *
 * `verifiesTheData` is typed as the literal `false` for the same reason `certifiesTheTarget` is
 * in the performance harness. This proves we read the report correctly. It says **nothing** about
 * whether the report was right, because both sides came out of the same system — which is exactly
 * the comparison `planVerification` refuses. The stock figure is still proved by counting the
 * shelves, and nothing here changes that.
 */
export function checkAgainstPrintedTotal(input: {
  readonly rows: readonly Readonly<Record<string, string>>[];
  readonly amountColumn: string;
  readonly printed?: ParsedMoney;
}): ParseCheck {
  let ourTotalMinor = 0;
  let checked = 0;
  for (const row of input.rows) {
    const parsed = parseReportMoney(row[input.amountColumn] ?? '');
    if (parsed === undefined) continue;
    ourTotalMinor += parsed.minor;
    checked += 1;
  }

  const printedTotalMinor = input.printed?.minor;
  const differenceMinor = printedTotalMinor === undefined ? 0 : ourTotalMinor - printedTotalMinor;
  const matches = printedTotalMinor !== undefined && differenceMinor === 0;

  return {
    checked,
    ourTotalMinor,
    ...(printedTotalMinor === undefined ? {} : { printedTotalMinor }),
    differenceMinor,
    matches,
    verifiesTheData: false,
    detail: printedTotalMinor === undefined
      ? `${checked} rows summing to ${ourTotalMinor}, with no printed total to read them against — the file gives no free check on the parse`
      : matches
        ? `${checked} rows sum exactly to the ${printedTotalMinor} the report printed, so the READING is right. It says nothing about whether the report is — both sides came from the same system`
        : `${checked} rows sum to ${ourTotalMinor} against a printed ${printedTotalMinor}, out by ${differenceMinor}. That is a mis-read file: a subtotal counted as data, a page dropped, or a figure parsed wrongly`,
  };
}
