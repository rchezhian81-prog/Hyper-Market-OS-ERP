import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * **The extraction tool runs.**
 *
 * Every verification module in `packages/migration` was unreachable by anybody who was not writing
 * TypeScript. `scripts/extract-check.mts` is the door, which makes it the piece a person in the
 * shop actually touches — so it is exercised here as a real subprocess against real files, not as
 * an import. A tool tested only through its library is a tool whose argument handling, exit codes
 * and output nobody has ever checked.
 */

const ROOT = new URL('../../', import.meta.url).pathname;
let dir: string;

const run = (args: readonly string[]): { code: number; out: string } => {
  try {
    const out = execFileSync(
      process.execPath,
      ['--experimental-strip-types', join(ROOT, 'scripts', 'extract-check.mts'), ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
};

const write = (name: string, lines: readonly string[]): string => {
  const path = join(dir, name);
  writeFileSync(path, lines.join('\n'), 'utf8');
  return path;
};

/** A stock report as these systems actually print one: banner, title, blanks, subtotals. */
const GOOD = [
  'SRE HYPER MARKET,,,',
  'Stock Valuation Report,,,',
  'As on 31/03/2026,,,',
  ',,,',
  'Item Code,Description,Qty,Value',
  'P0001,Amul Ghee Gold 1L,200,"1,28,000.00"',
  'P0002,Sunflower Oil 5L,300,"90,000.00"',
  'P0003,Ponni Rice 25kg,150,"60,000.00"',
  'Total for GROCERY,,650,"2,78,000.00"',
  'P0004,Toor Dal 5kg,100,"30,000.00"',
  'Grand Total,,750,"3,08,000.00"',
];

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'sre-extract-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('it reads what these systems actually produce', () => {
  it('finds the header under the shop name and the report title', () => {
    const r = run([write('good.csv', GOOD), '--column', 'Item Code', '--rows', '4']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Header found on line 5');
    expect(r.out).toContain('4 product row(s)');
  });

  it('does NOT count a group subtotal as a product', () => {
    // The misread that silently doubles a department.
    const r = run([write('good2.csv', GOOD), '--column', 'Item Code', '--rows', '4']);
    expect(r.out).toContain('1 group subtotal(s)');
    expect(r.out).toContain('never as products');
  });

  it('reads Indian money through a comma-separated file', () => {
    // The first version of this tool split on the separator directly. Indian money is written with
    // commas and these exports are comma-separated, so "1,28,000.00" became three cells and the
    // only figures that matter were destroyed — while the row count still looked right.
    const r = run([write('good3.csv', GOOD), '--column', 'Item Code', '--rows', '4']);
    expect(r.out).toContain('₹3,08,000.00');
    expect(r.out).toContain('These agree.');
    expect(r.out).not.toContain('NaN');
  });

  it('says the file agreeing with itself proves nothing about the figure', () => {
    const r = run([write('good4.csv', GOOD), '--column', 'Item Code', '--rows', '4']);
    expect(r.out).toContain('consistent with ITSELF');
    expect(r.out).toContain('counted on the');
  });

  it('accounts for every line it did not treat as data', () => {
    const r = run([write('good5.csv', GOOD), '--column', 'Item Code', '--rows', '4']);
    expect(r.out).toContain('none was dropped silently');
  });
});

describe('it REFUSES the export that would pass every later check', () => {
  const TRUNCATED = [
    'SRE HYPER MARKET,,,',
    'Stock Valuation Report,,,',
    'Page 1 of 47,,,',
    ',,,',
    'Item Code,Description,Qty,Value',
    'P0001,Amul Ghee Gold 1L,200,"1,28,000.00"',
    'P0002,Sunflower Oil 5L,300,"90,000.00"',
    'Grand Total,,500,"2,18,000.00"',
  ];

  it('exits non-zero on a file that stops at page 1 of 47', () => {
    const r = run([write('short.csv', TRUNCATED), '--column', 'Item Code']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('46 pages are missing');
    expect(r.out).toContain('REFUSED');
  });

  it('looks at NOTHING else once it has refused', () => {
    // The whole point of the ordering: every later check passes on a truncated file, because it
    // is internally consistent about a shop a fraction of the real size.
    const r = run([write('short2.csv', TRUNCATED), '--column', 'Item Code']);
    expect(r.out).not.toContain('WHAT IS IN THE FILE');
    expect(r.out).toContain('nothing else has looked at this file');
  });

  it('refuses a row count that does not match what the screen said', () => {
    const r = run([write('good6.csv', GOOD), '--column', 'Item Code', '--rows', '41200']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('41200');
  });

  it('tells the person the one thing that would settle it', () => {
    const r = run([write('short3.csv', TRUNCATED), '--column', 'Item Code']);
    expect(r.out).toContain('read the row count');
    expect(r.out).toContain('--rows');
  });
});

describe('it fails helpfully rather than cryptically', () => {
  it('explains itself when given no file', () => {
    const r = run([]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('--rows N');
    expect(r.out).toContain('costs one glance');
  });

  it('says so when the file is not there', () => {
    const r = run([join(dir, 'nothing.csv')]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('Could not read');
  });

  it('suggests what to try when it cannot find a header', () => {
    const r = run([write('junk.csv', ['nothing', 'useful', 'here']), '--column', 'Item Code']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('What to try');
    expect(r.out).toContain('--sep');
  });

  it('handles a tab-separated file when told to', () => {
    const r = run([
      write('tabs.tsv', GOOD.map((l) => l.replace(/,/g, '\t').replace(/"/g, ''))),
      '--column', 'Item Code', '--rows', '4', '--sep', '\t',
    ]);
    // The money loses its grouping without quotes, but the structure is read correctly.
    expect(r.code).toBe(0);
    expect(r.out).toContain('4 product row(s)');
  });
});
