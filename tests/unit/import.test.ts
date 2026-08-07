import { describe, it, expect } from 'vitest';
import {
  parseDelimited,
  validateImport,
  commitImport,
  MalformedFileError,
  MissingHeaderError,
  type TemplateSpec,
} from '../../packages/import/src/index';
import { requestApproval, decide, type Approver } from '../../packages/approvals/src/index';
import { money } from '../../packages/contracts/src/money';

// Import is validate → preview → approve → commit: bad rows are reported with their
// line numbers, duplicates go to review, financial imports must reconcile, and
// NOTHING commits until a different person approves (M30-FR-01/03/04, audit A-03).

const AT = '2026-08-02T09:00:00Z';

describe('parseDelimited', () => {
  it('parses a plain file into header-keyed rows', () => {
    const parsed = parseDelimited('sku,name,qty\nA1,Rice,2\nB2,Dal,3\n');
    expect(parsed.headers).toEqual(['sku', 'name', 'qty']);
    expect(parsed.rows).toEqual([
      { sku: 'A1', name: 'Rice', qty: '2' },
      { sku: 'B2', name: 'Dal', qty: '3' },
    ]);
    expect(parsed.lineNumbers).toEqual([2, 3]); // for honest error reporting
  });

  it('handles the things that silently corrupt a naive split', () => {
    const text = 'sku,name,note\nA1,"Rice, Basmati 1kg","He said ""fresh"""\nB2,"Multi\nline",ok\n';
    const parsed = parseDelimited(text);
    expect(parsed.rows[0]?.name).toBe('Rice, Basmati 1kg'); // comma inside quotes
    expect(parsed.rows[0]?.note).toBe('He said "fresh"'); // escaped quotes
    expect(parsed.rows[1]?.name).toBe('Multi\nline'); // newline inside a quoted field
  });

  it('handles CRLF line endings and a BOM', () => {
    const parsed = parseDelimited('\uFEFFsku,name\r\nA1,Rice\r\n');
    expect(parsed.headers).toEqual(['sku', 'name']);
    expect(parsed.rows[0]).toEqual({ sku: 'A1', name: 'Rice' });
  });

  it('supports tab-separated exports', () => {
    const parsed = parseDelimited('sku\tname\nA1\tRice\n', { delimiter: '\t' });
    expect(parsed.rows[0]).toEqual({ sku: 'A1', name: 'Rice' });
  });

  it('reports a row with the wrong column count instead of shifting cells', () => {
    expect(() => parseDelimited('sku,name\nA1,Rice,EXTRA\n')).toThrow(MalformedFileError);
  });

  it('reports an unclosed quote rather than guessing', () => {
    expect(() => parseDelimited('sku,name\nA1,"Rice\n')).toThrow(MalformedFileError);
  });

  it('rejects an empty file', () => {
    expect(() => parseDelimited('')).toThrow(MissingHeaderError);
  });
});

const PRODUCT_TEMPLATE: TemplateSpec = {
  id: 'tpl-product',
  domain: 'product',
  columns: [
    { name: 'sku', type: 'text', required: true },
    { name: 'name', type: 'text', required: true },
    { name: 'tax_class', type: 'enum', required: true, allowed: ['gst0', 'gst5', 'gst18'] },
    { name: 'supplier', type: 'text', referenceSet: 'supplier' },
    { name: 'price_minor', type: 'money_minor', required: true },
  ],
  keyColumns: ['sku'],
};

const REFERENCES = { supplier: ['SUP-1', 'SUP-2'] };

function preview(text: string, over: Record<string, unknown> = {}) {
  const parsed = parseDelimited(text);
  return validateImport({
    template: PRODUCT_TEMPLATE,
    rows: parsed.rows,
    lineNumbers: parsed.lineNumbers,
    references: REFERENCES,
    ...over,
  });
}

const GOOD = 'sku,name,tax_class,supplier,price_minor\nA1,Rice 1kg,gst18,SUP-1,10000\nB2,Dal 1kg,gst5,SUP-2,5000\n';

describe('validateImport — the preview', () => {
  it('accepts a clean file and shows what would be applied', () => {
    const result = preview(GOOD);
    expect(result.totalRows).toBe(2);
    expect(result.validCount).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.commitReady).toBe(true);
  });

  it('reports a missing mandatory field with its line number', () => {
    const result = preview('sku,name,tax_class,supplier,price_minor\nA1,,gst18,SUP-1,10000\n');
    expect(result.errors[0]).toMatchObject({ line: 2, column: 'name', kind: 'missing_required' });
    expect(result.commitReady).toBe(false);
  });

  it('reports a bad number, a bad amount and a disallowed value plainly', () => {
    const result = preview('sku,name,tax_class,supplier,price_minor\nA1,Rice,gst99,SUP-1,ten\n');
    const kinds = result.errors.map((e) => e.kind);
    expect(kinds).toContain('not_allowed_value');
    expect(kinds).toContain('not_an_amount');
    expect(result.errors.find((e) => e.kind === 'not_allowed_value')?.message).toContain('gst0, gst5, gst18');
  });

  it('catches an orphan reference (referential integrity, M30-FR-03)', () => {
    const result = preview('sku,name,tax_class,supplier,price_minor\nA1,Rice,gst18,SUP-9,10000\n');
    expect(result.errors[0]).toMatchObject({ kind: 'unknown_reference', line: 2 });
  });

  it('blocks a duplicate key within the file and says where the other one is', () => {
    const result = preview('sku,name,tax_class,supplier,price_minor\nA1,Rice,gst18,SUP-1,10000\nA1,Rice again,gst18,SUP-1,11000\n');
    expect(result.errors[0]).toMatchObject({ kind: 'duplicate_in_file', line: 3 });
    expect(result.errors[0]?.message).toContain('line 2');
    expect(result.commitReady).toBe(false);
  });

  it('flags a key that already exists for review — never auto-merges (M03-FR-04)', () => {
    const result = preview(GOOD, { existingKeys: ['a1'] });
    expect(result.duplicatesForReview).toEqual([{ line: 2, key: 'a1' }]);
    expect(result.commitReady).toBe(true); // review is a decision, not a blocker
  });

  it('counts a row with several problems once', () => {
    const result = preview('sku,name,tax_class,supplier,price_minor\nA1,,gst99,SUP-9,ten\n');
    expect(result.errorRowCount).toBe(1);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

const INVOICE_TEMPLATE: TemplateSpec = {
  id: 'tpl-invoice',
  domain: 'supplier_invoice',
  columns: [
    { name: 'line_no', type: 'integer', required: true },
    { name: 'sku', type: 'text', required: true },
    { name: 'amount_minor', type: 'money_minor', required: true },
  ],
  keyColumns: ['line_no'],
  amountColumn: 'amount_minor',
};

/** Build a realistic supplier invoice with `n` lines (audit A-03's real case). */
function invoiceCsv(n: number): { text: string; totalMinor: number } {
  let text = 'line_no,sku,amount_minor\n';
  let totalMinor = 0;
  for (let i = 1; i <= n; i += 1) {
    const amount = 1000 + i * 37; // varied, realistic paise amounts
    totalMinor += amount;
    text += `${i},"SKU-${i}, pack of ${i}",${amount}\n`;
  }
  return { text, totalMinor };
}

describe('financial import — reconciliation (M30-FR-03)', () => {
  it('reconciles an 80-line supplier invoice against its declared total (audit A-03)', () => {
    const { text, totalMinor } = invoiceCsv(80);
    const parsed = parseDelimited(text);
    const result = validateImport({
      template: INVOICE_TEMPLATE,
      rows: parsed.rows,
      lineNumbers: parsed.lineNumbers,
      declaredTotalMinor: totalMinor,
    });

    expect(result.totalRows).toBe(80); // the whole invoice in one go
    expect(result.validCount).toBe(80);
    expect(result.errors).toEqual([]);
    expect(result.sumMinor).toBe(totalMinor);
    expect(result.reconciles).toBe(true);
    expect(result.commitReady).toBe(true);
  });

  it('refuses an invoice whose lines do not add up to the declared total', () => {
    const { text, totalMinor } = invoiceCsv(10);
    const parsed = parseDelimited(text);
    const result = validateImport({
      template: INVOICE_TEMPLATE,
      rows: parsed.rows,
      lineNumbers: parsed.lineNumbers,
      declaredTotalMinor: totalMinor + 100, // supplier's stated total is ₹1 out
    });
    expect(result.reconciles).toBe(false);
    expect(result.commitReady).toBe(false);
  });
});

describe('commitImport — nothing changes until approved', () => {
  function approvalFor(jobId: string, by = 'manager-9') {
    const req = requestApproval({
      id: jobId,
      subjectType: 'data_import',
      subjectRef: jobId,
      requestedBy: 'requester-0',
      value: money(0, 'INR'),
    });
    const approver: Approver = { userId: by, branchScope: 'all', authorityLimit: null };
    const outcome = decide(req, approver, 'approved', 'checked against the paper invoice', AT);
    if (!outcome.ok) throw new Error('expected approval');
    return outcome.request;
  }

  it('applies every valid row once approved', () => {
    const applied: unknown[] = [];
    const result = commitImport(
      { preview: preview(GOOD), uploadedBy: 'clerk-1', jobId: 'job-1', approval: approvalFor('job-1') },
      (rows) => applied.push(...rows),
    );
    expect(result).toEqual({ committed: true, rowsApplied: 2 });
    expect(applied).toHaveLength(2);
  });

  it('commits NOTHING without an approval', () => {
    let touched = false;
    const result = commitImport({ preview: preview(GOOD), uploadedBy: 'clerk-1', jobId: 'job-1' }, () => {
      touched = true;
    });
    expect(result).toMatchObject({ committed: false, rowsApplied: 0, refusal: 'not_approved' });
    expect(touched).toBe(false);
  });

  it('refuses an import approved by the person who uploaded it (§28)', () => {
    const result = commitImport(
      { preview: preview(GOOD), uploadedBy: 'clerk-1', jobId: 'job-1', approval: approvalFor('job-1', 'clerk-1') },
      () => undefined,
    );
    expect(result.refusal).toBe('self_approved');
  });

  it('commits nothing when any row has an error — all or nothing', () => {
    let touched = false;
    const bad = preview('sku,name,tax_class,supplier,price_minor\nA1,Rice,gst18,SUP-1,10000\nB2,,gst5,SUP-2,5000\n');
    const result = commitImport(
      { preview: bad, uploadedBy: 'clerk-1', jobId: 'job-1', approval: approvalFor('job-1') },
      () => {
        touched = true;
      },
    );
    expect(result.refusal).toBe('has_errors');
    expect(touched).toBe(false); // the good row is NOT applied either
  });

  it('refuses a financial import that does not reconcile', () => {
    const { text, totalMinor } = invoiceCsv(5);
    const parsed = parseDelimited(text);
    const notBalancing = validateImport({
      template: INVOICE_TEMPLATE,
      rows: parsed.rows,
      lineNumbers: parsed.lineNumbers,
      declaredTotalMinor: totalMinor - 1,
    });
    const result = commitImport(
      { preview: notBalancing, uploadedBy: 'clerk-1', jobId: 'job-1', approval: approvalFor('job-1') },
      () => undefined,
    );
    expect(result.refusal).toBe('does_not_reconcile');
  });

  it('reports nothing applied when the apply step throws (caller rolls back)', () => {
    expect(() =>
      commitImport(
        { preview: preview(GOOD), uploadedBy: 'clerk-1', jobId: 'job-1', approval: approvalFor('job-1') },
        () => {
          throw new Error('database unavailable');
        },
      ),
    ).toThrow('database unavailable');
  });
});
