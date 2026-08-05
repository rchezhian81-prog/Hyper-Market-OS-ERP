// Check a file that came out of the old system — MG-01/02/05, OB-06.
//
// Every verification module in `packages/migration` has been unreachable by anybody who is not
// writing TypeScript. This is the door: it takes a file exactly as the incumbent produced it and
// runs the checks in the order the runbook specifies, printing something a person can act on.
//
//   node --experimental-strip-types scripts/extract-check.mts <file> [--rows N] [--column NAME]
//
// **Completeness runs first and refuses.** A paginated grid that exported one page parses
// perfectly, sums to its own total to the paisa, and holds a tenth of the shop. Every later check
// would pass on it. So nothing else looks at the file until that one is satisfied — and the
// strongest signal, `--rows`, is the count read off the screen *before* exporting, which costs one
// glance and is the only check that does not depend on the file being honest about itself.
//
// Exit codes are for the person, not for a machine: 0 usable, 1 refused, 2 could not read it.

import { readFileSync } from 'node:fs';
import { checkExportCompleteness } from '../packages/migration/src/completeness.ts';
import { parseReport, parseReportMoney } from '../packages/migration/src/report-parser.ts';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const out = (s = ''): void => { process.stdout.write(`${s}\n`); };
const rule = (): void => { out('─'.repeat(78)); };

if (file === undefined) {
  out('Usage: node --experimental-strip-types scripts/extract-check.mts <file> [options]');
  out();
  out('  --rows N        The row count you read off the SCREEN before exporting.');
  out('                  This is the strongest check there is and it costs one glance.');
  out('  --column NAME   A column you know is in the file, used to find the real header');
  out('                  under the shop name and the report title. Default: "code".');
  out('  --sep C         Column separator. Default: comma.');
  process.exit(2);
}

let raw: string;
try {
  raw = readFileSync(file, 'utf8');
} catch (e) {
  out(`Could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

const sep = flag('sep') ?? ',';
const lines = raw.split(/\r?\n/);

/**
 * Split a line into fields, respecting quotes.
 *
 * The first version of this split on the separator directly, which broke the moment it met a real
 * file: **Indian money is written with commas and these exports are comma-separated**, so
 * `"1,28,000.00"` became three cells and the only figures that matter were destroyed. The row
 * count still looked right, which is how it nearly went unnoticed.
 */
const fields = (line: string): string[] => {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (c === '"') {
      // A doubled quote inside a quoted field is one literal quote.
      if (quoted && line[i + 1] === '"') { cell += '"'; i += 1; continue; }
      quoted = !quoted;
      continue;
    }
    if (!quoted && line.startsWith(sep, i)) {
      cells.push(cell.trim());
      cell = '';
      i += sep.length - 1;
      continue;
    }
    cell += c;
  }
  cells.push(cell.trim());
  return cells;
};

const grid = lines.map(fields);
const declared = flag('rows') === undefined ? undefined : Number(flag('rows'));

rule();
out(`  CHECKING  ${file}`);
out(`  ${lines.length} line(s) in the file`);
rule();
out();

// ── 1. Parse, so completeness has a row count to check ──────────────────────
const parsed = parseReport({ grid, expectColumn: flag('column') ?? 'code' });

if (!parsed.ok) {
  out('COULD NOT READ THIS AS A REPORT');
  out();
  out(`  ${parsed.detail}`);
  out();
  out('  What to try:');
  out('    • Pass --column with a column name you can see in the file, so the real');
  out('      header can be found under the shop name and the report title.');
  out('    • If the file is tab-separated, add:  --sep "\\t"');
  out();
  process.exit(2);
}

const report = parsed.report!;

// ── 2. Completeness FIRST, and it refuses ───────────────────────────────────
const completeness = checkExportCompleteness({
  lines,
  rowsFound: report.rows.length,
  ...(declared === undefined || !Number.isFinite(declared) ? {} : { declaredRowCount: declared }),
  identifiers: report.rows.map((r) => Object.values(r)[0] ?? ''),
});

out('IS THE WHOLE FILE HERE?');
out();
for (const s of completeness.signals) {
  const mark = !s.available ? '  ?' : s.passed ? '  ✓' : '  ✗';
  out(`${mark} ${s.detail}`);
}
out();
out(`  Verdict: ${completeness.verdict.toUpperCase().replace(/_/g, ' ')}`);
out();

if (completeness.verdict !== 'complete') {
  out('  ' + completeness.ownerAction.split('. ').join('.\n  '));
  out();
  rule();
  out('  REFUSED — nothing else has looked at this file.');
  out();
  out('  A short export is the dangerous one precisely because it looks fine: it');
  out('  parses cleanly, its rows are well formed, and its own total agrees with the');
  out('  sum of its rows to the paisa. It is internally consistent about a shop a');
  out('  fraction of the real size, and the first person to notice is a customer');
  out('  whose item will not scan.');
  out();
  if (declared === undefined) {
    out('  Go back to the screen, read the row count, and run this again with');
    out(`    --rows <that number>`);
    out();
  }
  rule();
  process.exit(1);
}

// ── 3. What is actually in it ───────────────────────────────────────────────
rule();
out('  WHAT IS IN THE FILE');
rule();
out();
// `headerLine` is already 1-based — the parser numbers lines the way a person quoting the
// file would, so an exception can say "line 5" and mean it. Adding one made it off by one.
out(`  Header found on line ${report.headerLine}: ${report.header.filter((h) => h !== '').join(' | ')}`);
out(`  ${report.rows.length} product row(s)`);
out(`  ${report.subtotals.length} group subtotal(s) — counted as totals, never as products`);
out();

if (report.dropped.length > 0) {
  out(`  ${report.dropped.length} line(s) were not data, and none was dropped silently:`);
  const byKind = new Map<string, number>();
  for (const d of report.dropped) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1);
  for (const [kind, n] of byKind) out(`    • ${n} × ${kind.replace(/_/g, ' ')}`);
  out();
}

if (report.grandTotal?.amount !== undefined) {
  const printed = report.grandTotal.amount.minor;
  const summed = report.rows.reduce((t, r) => {
    for (const key of Object.keys(r)) {
      if (/value|amount|total/i.test(key)) return t + (parseReportMoney(r[key] ?? '')?.minor ?? 0);
    }
    return t;
  }, 0);

  const rupees = (m: number): string => `₹${(m / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  out(`  The file's own printed total: ${rupees(printed)}`);
  out(`  Adding up its rows gives:     ${rupees(summed)}`);
  out(printed === summed
    ? '  These agree.'
    : `  These DIFFER by ${rupees(Math.abs(summed - printed))} — the parse has lost or gained something.`);
  out();
  out('  Note this proves only that the file is consistent with ITSELF. It is not');
  out('  evidence the figure is right — for that the stock has to be counted on the');
  out('  shelves, which is the only record of stock that exists anywhere.');
  out();
}

rule();
out('  USABLE. Next: seal an untouched copy before anything reads it again (MG-02),');
out('  then gather the outside evidence — see docs/runbooks/legacy-self-extraction.md');
rule();
process.exit(0);
