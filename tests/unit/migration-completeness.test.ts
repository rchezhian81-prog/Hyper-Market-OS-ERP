import { describe, it, expect } from 'vitest';
import { checkExportCompleteness, compareDoubleKeyed } from '../../packages/migration/src/completeness';
import { renderStockReport } from '../../packages/migration/src/render-report';
import { generateLegacyDataset } from '../../packages/migration/src/synthetic';

// OB-06, MG-01, MG-05, P-08 — is the file we got actually the whole file?

const dataset = generateLegacyDataset({ products: 60, documents: 20, customers: 20 });
const grid = renderStockReport(dataset, { rowsPerPage: 10 });
const lines = grid.map((r) => r.join('\t'));
const rowCount = dataset.stock.length;
const identifiers = dataset.stock.map((s) => s.legacyProductId);

describe('a complete export passes on every signal it can', () => {
  const check = checkExportCompleteness({
    lines, rowsFound: rowCount, declaredRowCount: rowCount, identifiers,
  });

  it('is complete', () => {
    expect(check.verdict).toBe('complete');
    expect(check.usable).toBe(true);
    expect(check.truncated).toBe(false);
  });

  it('reports every signal, including the ones that were not available', () => {
    expect(check.signals.map((s) => s.signal).sort())
      .toEqual(['declared_row_count', 'end_marker', 'identifier_sequence', 'page_of_pages']);
    for (const s of check.signals) expect(s.detail.length).toBeGreaterThan(20);
  });
});

describe('the failure that reconciles perfectly: a truncated export', () => {
  // The grid cut off part-way, as a paginated grid's export actually arrives.
  const short = lines.slice(0, Math.floor(lines.length / 3));

  it('CATCHES it on the declared row count — a smaller file is the wrong file', () => {
    const check = checkExportCompleteness({
      lines: short, rowsFound: 12, declaredRowCount: rowCount, identifiers,
    });
    expect(check.verdict).toBe('truncated');
    expect(check.usable).toBe(false);
    expect(check.detail).toContain('is not a smaller export — it is the wrong file');
  });

  it('CATCHES it on "Page N of M" even when NOBODY wrote a row count down', () => {
    // The signal that costs nothing and works anyway: the report says how many pages it has.
    const check = checkExportCompleteness({ lines: short, rowsFound: 12 });
    expect(check.verdict).toBe('truncated');
    const pageSignal = check.signals.find((s) => s.signal === 'page_of_pages')!;
    expect(pageSignal.available).toBe(true);
    expect(pageSignal.passed).toBe(false);
    expect(pageSignal.detail).toContain('pages are missing, and no arithmetic is needed to know it');
  });

  it('CATCHES it on the missing end marker — that is printed last', () => {
    const check = checkExportCompleteness({ lines: short, rowsFound: 12 });
    const end = check.signals.find((s) => s.signal === 'end_marker')!;
    expect(end.passed).toBe(false);
    expect(end.detail).toContain('printed last');
  });

  it('REFUSES it rather than flagging it', () => {
    // A warning on a truncated export is one somebody clicks past at nine at night, and the cost
    // of being wrong is a migration redone after cutover.
    const check = checkExportCompleteness({ lines: short, rowsFound: 12, declaredRowCount: rowCount });
    expect(check.usable).toBe(false);
    expect(check.detail).toContain('REFUSED as truncated');
    expect(check.ownerAction).toContain('with no filter set and no page limit');
  });

  it('catches a FILTERED export, where the sequence is mostly gap', () => {
    // Not truncated at the end — a date filter left every third PRODUCT. The file ends properly,
    // the page count is right, and only the sequence gives it away.
    //
    // Filtered by distinct product, not by row: a product appears once per location, so taking
    // every third ROW still leaves most products present and the sequence looks dense. That was
    // the first version of this fixture, and it did not test what its own comment claimed.
    const distinct = [...new Set(identifiers)].sort();
    const everyThird = distinct.filter((_, i) => i % 3 === 0);
    const check = checkExportCompleteness({
      lines, rowsFound: everyThird.length, identifiers: everyThird,
    });
    const sequence = check.signals.find((s) => s.signal === 'identifier_sequence')!;
    expect(sequence.available).toBe(true);
    expect(sequence.passed).toBe(false);
    expect(sequence.detail).toContain('rather than deleted products');
  });

  it('does NOT cry wolf on the normal gaps a deleted product leaves', () => {
    // A scanner that flags ordinary gaps gets switched off within a fortnight.
    const withHoles = identifiers.filter((_, i) => i % 9 !== 0);
    const check = checkExportCompleteness({ lines, rowsFound: withHoles.length, identifiers: withHoles });
    expect(check.signals.find((s) => s.signal === 'identifier_sequence')!.passed).toBe(true);
  });
});

describe('"unverifiable" is a distinct verdict from "complete"', () => {
  // A bare CSV with no page furniture and no declared count.
  const bare = ['Item Code,Value', 'P00001,100.00', 'P00002,200.00'];

  it('does not call an uncheckable file complete', () => {
    const check = checkExportCompleteness({ lines: bare, rowsFound: 2 });
    expect(check.verdict).toBe('unverifiable');
    expect(check.usable).toBe(false);
    expect(check.truncated).toBe(false);
  });

  it('says plainly that it failed to be CAUGHT, not that it passed', () => {
    // Collapsing the two is how "we checked it" comes to mean "nothing objected", which is what
    // everybody assumes it meant anyway.
    const check = checkExportCompleteness({ lines: bare, rowsFound: 2 });
    expect(check.detail).toContain('it has failed to be caught, and those are different');
    expect(check.ownerAction).toContain('note the row count shown on the screen');
  });

  it('becomes checkable the moment somebody writes one number down', () => {
    const check = checkExportCompleteness({ lines: bare, rowsFound: 2, declaredRowCount: 2 });
    expect(check.verdict).toBe('complete');
  });
});

describe('two people, two files — the only way re-keying is permitted', () => {
  const first = [
    { code: 'T01', name: 'Cash', rate: '0' },
    { code: 'T02', name: 'Card', rate: '0' },
    { code: 'T03', name: 'UPI', rate: '0' },
  ];

  it('agrees when both typed the same thing', () => {
    const r = compareDoubleKeyed({ first, second: [...first], keyField: 'code' });
    expect(r.identical).toBe(true);
    expect(r.agreed).toBe(3);
  });

  it('NAMES the field two typists disagreed on, rather than counting differences', () => {
    const second = [
      { code: 'T01', name: 'Cash', rate: '0' },
      { code: 'T02', name: 'Cards', rate: '0' },
      { code: 'T03', name: 'UPI', rate: '0' },
    ];
    const r = compareDoubleKeyed({ first, second, keyField: 'code' });
    expect(r.identical).toBe(false);
    expect(r.differences).toEqual([{ key: 'T02', field: 'name', first: 'Card', second: 'Cards' }]);
    // A line for a person to settle against the page — not an average to take.
    expect(r.detail).toContain('not an average to take');
  });

  it('catches a row one typist missed entirely', () => {
    const r = compareDoubleKeyed({ first, second: first.slice(0, 2), keyField: 'code' });
    expect(r.onlyInFirst).toEqual(['T03']);
    expect(r.onlyInSecond).toEqual([]);
  });

  it('REFUSES to call agreement between typists evidence about the source', () => {
    // They agree that they read the same page the same way. Whether the page was right is still
    // the bank, the supplier and the shelves.
    const r = compareDoubleKeyed({ first, second: [...first], keyField: 'code' });
    const verifies: false = r.verifiesTheSource;
    expect(verifies).toBe(false);
    expect(r.detail).toContain('and nothing more');
  });
});
