// Is the file we got actually the whole file? — MG-01, MG-05, OB-06, P-08.
//
// The most dangerous failure in self-extraction, and the reason it is dangerous is that it does
// not look like a failure:
//
//     The operator opens the stock screen, sets no filter, clicks Export to Excel, and gets a
//     file. It parses cleanly. Its rows are well-formed. Its own grand total agrees with the sum
//     of its rows to the paisa. Everything reconciles.
//
//     It contains 4,000 of the shop's 41,200 products, because the grid was paginated and the
//     export took the page.
//
// Nothing downstream can catch that. The cleaning detectors find no faults, because there are no
// faults in what arrived. The control totals reconcile, because both sides are computed over the
// same short file. It is **internally consistent about a shop that is a tenth of the real one**,
// and the first person to notice is a customer whose product does not scan.
//
// So completeness is checked **before** anything else looks at the file, on four signals, in
// order of how much they can be trusted:
//
//   1. **A declared row count**, taken off the screen before exporting. The strongest signal, and
//      the one that requires somebody to have written a number down.
//   2. **`Page N of M`.** Almost every one of these reports prints it, and it is the signal that
//      works when nobody wrote anything down: if the last page seen is 3 and the report says
//      *of 47*, the file is truncated and no arithmetic is needed to know it.
//   3. **The end marker.** A report cut short has no *"End of Report"* and no print stamp,
//      because those are printed last.
//   4. **A gap in the identifier sequence**, where the source numbers its rows.
//
// **A file that fails any of these is refused, not flagged.** A warning on a truncated export is
// a warning somebody clicks past at nine at night, and the cost of being wrong is a migration
// that has to be redone after cutover.
//
// Pure and deterministic: no I/O, no clock.

export type CompletenessSignal =
  | 'declared_row_count'
  | 'page_of_pages'
  | 'end_marker'
  | 'identifier_sequence';

export type CompletenessVerdict = 'complete' | 'truncated' | 'unverifiable';

export interface SignalResult {
  readonly signal: CompletenessSignal;
  readonly available: boolean;
  readonly passed: boolean;
  readonly detail: string;
}

export interface CompletenessCheck {
  readonly verdict: CompletenessVerdict;
  readonly signals: readonly SignalResult[];
  readonly rowsFound: number;
  readonly rowsExpected?: number;
  /** True only when a signal actively says the file is short. */
  readonly truncated: boolean;
  /** True when no signal was available at all — different from "it passed". */
  readonly unverifiable: boolean;
  readonly usable: boolean;
  readonly detail: string;
  readonly ownerAction: string;
}

const PAGE_OF = /page\s+(\d+)\s+of\s+(\d+)/i;
const END_MARKER = /(end\s+of\s+report|printed\s+(on|by)|generated\s+(on|by)|\*{3,})/i;

const pagesPresent = (text: string): boolean => PAGE_OF.test(text);

/**
 * Decide whether an exported file is the whole file.
 *
 * `unverifiable` is a **distinct verdict from `complete`**, and keeping them apart is the point.
 * A file with no page numbers, no end marker and no declared count has not passed anything — it
 * has merely failed to be caught. Collapsing the two is how *"we checked it"* comes to mean
 * *"nothing objected"*, which is what everybody assumes it meant anyway.
 */
export function checkExportCompleteness(input: {
  /** Every line of the raw file, before parsing. Page furniture is the evidence here. */
  readonly lines: readonly string[];
  readonly rowsFound: number;
  /** Row count read off the screen BEFORE exporting. The strongest signal there is. */
  readonly declaredRowCount?: number;
  /** Identifiers of the parsed rows, where the source numbers them. */
  readonly identifiers?: readonly string[];
}): CompletenessCheck {
  const signals: SignalResult[] = [];
  const text = input.lines.join('\n');

  // 1 — the declared count.
  if (input.declaredRowCount === undefined) {
    signals.push({
      signal: 'declared_row_count', available: false, passed: false,
      detail: 'no row count was taken off the screen before exporting — the strongest check there is, and it costs one glance',
    });
  } else {
    const passed = input.rowsFound === input.declaredRowCount;
    signals.push({
      signal: 'declared_row_count', available: true, passed,
      detail: passed
        ? `${input.rowsFound} rows, exactly as the screen said`
        : `the screen said ${input.declaredRowCount} and the file has ${input.rowsFound}. A file with fewer rows than the screen showed is not a smaller export — it is the wrong file`,
    });
  }

  // 2 — Page N of M. The signal that works when nobody wrote anything down.
  const pages = [...text.matchAll(new RegExp(PAGE_OF, 'gi'))]
    .map((m) => ({ page: Number(m[1]), of: Number(m[2]) }))
    .filter((p) => Number.isFinite(p.page) && Number.isFinite(p.of) && p.of > 0);

  if (pages.length === 0) {
    signals.push({
      signal: 'page_of_pages', available: false, passed: false,
      detail: 'the file carries no "Page N of M" — either the report does not print it, or the part that does was cut off',
    });
  } else {
    const declaredPages = Math.max(...pages.map((p) => p.of));
    const lastPageSeen = Math.max(...pages.map((p) => p.page));
    const passed = lastPageSeen >= declaredPages;
    signals.push({
      signal: 'page_of_pages', available: true, passed,
      detail: passed
        ? `the file runs to page ${lastPageSeen} of ${declaredPages}`
        : `the file stops at page ${lastPageSeen} and the report says there are ${declaredPages}. ${declaredPages - lastPageSeen} pages are missing, and no arithmetic is needed to know it`,
    });
  }

  // 3 — the end marker. Printed last, so it is absent from anything cut short — but ONLY for a
  // file that would have had one. A plain CSV export has no end marker and never did, and
  // reading its absence as truncation condemns every clean export there is. So the signal is
  // available only when the file shows it is the printed-report kind: page numbering somewhere,
  // or a print stamp somewhere.
  const looksPrinted = pagesPresent(text) || END_MARKER.test(text);
  const tail = input.lines.slice(-8).join('\n');
  const hasEnd = END_MARKER.test(tail);
  signals.push(looksPrinted
    ? {
      signal: 'end_marker', available: true, passed: hasEnd,
      detail: hasEnd
        ? 'the file ends with the report\'s own end marker'
        : 'this is a printed report — it carries page furniture — and yet has no end marker or print stamp in its last lines. Those are printed last, so a file cut short does not have them',
    }
    : {
      signal: 'end_marker', available: false, passed: false,
      detail: 'this file carries no page furniture at all, so it is not the kind that ends with a print stamp — its absence says nothing',
    });

  // 4 — a gap in a numbered identifier sequence.
  const ids = input.identifiers ?? [];
  const numbered = ids
    .map((id) => /^([A-Za-z]*)(\d+)$/.exec(id))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ prefix: m[1]!, n: Number(m[2]) }));

  if (numbered.length < ids.length || numbered.length < 2) {
    signals.push({
      signal: 'identifier_sequence', available: false, passed: false,
      detail: 'identifiers are not a simple numbered sequence, so a gap in them says nothing',
    });
  } else {
    const prefixes = new Set(numbered.map((x) => x.prefix));
    // DISTINCT identifiers. A product legitimately appears once per location, and counting the
    // repeats inflates the density until a heavily filtered export looks dense enough to pass.
    const sorted = [...new Set(numbered.map((x) => x.n))].sort((a, b) => a - b);
    const span = sorted[sorted.length - 1]! - sorted[0]! + 1;
    // Gaps are normal — products get deleted. A run that is mostly gap is not.
    const density = sorted.length / span;
    const passed = prefixes.size > 1 || density >= 0.5;
    signals.push({
      signal: 'identifier_sequence', available: true, passed,
      detail: passed
        ? `${sorted.length} identifiers across a span of ${span} — gaps are normal, a deleted product leaves one`
        : `${sorted.length} identifiers spread across a span of ${span}: more than half the sequence is missing, which is a filtered or truncated export rather than deleted products`,
    });
  }

  const available = signals.filter((s) => s.available);
  const failed = available.filter((s) => !s.passed);
  const truncated = failed.length > 0;
  const unverifiable = available.length === 0;
  const verdict: CompletenessVerdict = truncated ? 'truncated' : unverifiable ? 'unverifiable' : 'complete';

  return {
    verdict,
    signals,
    rowsFound: input.rowsFound,
    ...(input.declaredRowCount === undefined ? {} : { rowsExpected: input.declaredRowCount }),
    truncated,
    unverifiable,
    // Refused, not flagged. A warning on a truncated export is one somebody clicks past at nine
    // at night, and the cost of being wrong is a migration redone after cutover.
    usable: verdict === 'complete',
    detail: truncated
      ? `REFUSED as truncated — ${failed.map((s) => s.detail).join('; ')}`
      : unverifiable
        ? 'nothing in this file could confirm it is complete: no declared row count, no page numbering, no end marker, no usable sequence. It has not passed — it has failed to be caught, and those are different'
        : `complete on ${available.length} signals: ${available.map((s) => s.detail).join('; ')}`,
    ownerAction: truncated
      ? 'export it again, with no filter set and no page limit — and note the row count off the screen first'
      : unverifiable
        ? 'before exporting again, note the row count shown on the screen. One glance, and it turns an unverifiable file into a checkable one'
        : 'nothing — the file is complete',
  };
}

// ── Route D: two people, two files ────────────────────────────────────────────

export interface KeyingDifference {
  readonly key: string;
  readonly field: string;
  readonly first: string;
  readonly second: string;
}

export interface DoubleKeyResult {
  readonly agreed: number;
  readonly differences: readonly KeyingDifference[];
  readonly onlyInFirst: readonly string[];
  readonly onlyInSecond: readonly string[];
  readonly identical: boolean;
  /** Never `true`: agreement between two typists is not evidence the source was right. */
  readonly verifiesTheSource: false;
  readonly detail: string;
}

/**
 * Compare two independent typings of the same pages.
 *
 * The runbook permits re-keying only for a small table, and only double-entered. This is that
 * control: two people key the same pages separately and the files are compared, because one
 * person typing carefully produces a file with no way to tell a correct row from a confident
 * mistake.
 *
 * `verifiesTheSource` is typed as the literal `false`. Two typists agreeing proves they read the
 * same page the same way. It says nothing about whether the page was right — that is still the
 * bank statement, the supplier's ledger and the shelves.
 */
export function compareDoubleKeyed(input: {
  readonly first: readonly Readonly<Record<string, string>>[];
  readonly second: readonly Readonly<Record<string, string>>[];
  readonly keyField: string;
  /** Fields to compare. Empty means every field present in either row. */
  readonly fields?: readonly string[];
}): DoubleKeyResult {
  const index = (rows: readonly Readonly<Record<string, string>>[]): Map<string, Readonly<Record<string, string>>> =>
    new Map(rows.map((r) => [r[input.keyField] ?? '', r]));

  const a = index(input.first);
  const b = index(input.second);

  const onlyInFirst = [...a.keys()].filter((k) => !b.has(k)).sort();
  const onlyInSecond = [...b.keys()].filter((k) => !a.has(k)).sort();

  const differences: KeyingDifference[] = [];
  let agreed = 0;

  for (const [key, rowA] of a) {
    const rowB = b.get(key);
    if (rowB === undefined) continue;
    const fields = input.fields ?? [...new Set([...Object.keys(rowA), ...Object.keys(rowB)])];
    let rowAgrees = true;
    for (const field of fields) {
      const first = (rowA[field] ?? '').trim();
      const second = (rowB[field] ?? '').trim();
      if (first !== second) {
        differences.push({ key, field, first, second });
        rowAgrees = false;
      }
    }
    if (rowAgrees) agreed += 1;
  }

  const identical = differences.length === 0 && onlyInFirst.length === 0 && onlyInSecond.length === 0;

  return {
    agreed,
    differences: differences.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : x.field < y.field ? -1 : 1)),
    onlyInFirst,
    onlyInSecond,
    identical,
    verifiesTheSource: false,
    detail: identical
      ? `both typings agree on all ${agreed} rows — which means they read the page the same way, and nothing more. Whether the page was right is still the bank, the supplier and the shelves`
      : `${differences.length} field differences across ${new Set(differences.map((d) => d.key)).size} rows, ${onlyInFirst.length} rows only the first typist entered, ${onlyInSecond.length} only the second. Every one is a line for a person to settle against the page — not an average to take`,
  };
}
