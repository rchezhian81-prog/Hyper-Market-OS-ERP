// Template-driven import: validate → preview → approve → commit (M30-FR-01/03/04).
// This is the module that carries the store's #1 daily pain (audit A-03) — an 80+
// line supplier invoice that today is typed by hand.
//
// The pipeline exists so that **nothing changes until a human has seen exactly what
// would change**:
//   1. VALIDATE — every row is checked against the template's rules (mandatory
//      fields, types, allowed values, referential integrity) and against the file
//      itself (duplicate keys). A bad row is reported WITH ITS LINE NUMBER and a
//      plain reason — never silently skipped or coerced (P-08);
//   2. PREVIEW — the caller sees the counts and the errors before anything happens,
//      plus a reconciliation check for financial imports (the declared total must
//      equal the sum of the rows, or the import is refused);
//   3. APPROVE — a maker-checker approval by a DIFFERENT person is required for the
//      import to commit (§28 / M30-FR-01);
//   4. COMMIT — ATOMIC: either every valid row is applied or none is. An import with
//      any blocking error commits NOTHING (M30-FR-01 acceptance).
//
// Duplicates are queued for review, NEVER auto-merged (M03-FR-04 / M30-FR-03).
// Pure and deterministic — the caller supplies the rows and the commit function.

import type { DecidedRequest } from '../../approvals/src/approvals';

export type ColumnType = 'text' | 'integer' | 'money_minor' | 'enum';

export interface ColumnSpec {
  readonly name: string;
  readonly type: ColumnType;
  readonly required?: boolean;
  /** Allowed values for an `enum` column. */
  readonly allowed?: readonly string[];
  /** Reference set this value must exist in (referential integrity, M30-FR-03). */
  readonly referenceSet?: string;
}

export interface TemplateSpec {
  readonly id: string;
  /** The domain this template writes to, e.g. "product", "supplier_invoice". */
  readonly domain: string;
  readonly columns: readonly ColumnSpec[];
  /** Columns that together identify a row — used for duplicate detection. */
  readonly keyColumns: readonly string[];
  /** For a financial import: the column whose sum must equal the declared total. */
  readonly amountColumn?: string;
}

export interface ValidateInput {
  readonly template: TemplateSpec;
  readonly rows: readonly Readonly<Record<string, string>>[];
  /** Source line number for each row, for honest error reporting. */
  readonly lineNumbers: readonly number[];
  /** Known values per reference set, so an orphan reference is caught. */
  readonly references?: Readonly<Record<string, readonly string[]>>;
  /** Keys already in the system — a match is flagged for review, never auto-merged. */
  readonly existingKeys?: readonly string[];
  /** Declared control total (minor units) for a financial import. */
  readonly declaredTotalMinor?: number;
}

export type RowErrorKind =
  | 'missing_required'
  | 'not_an_integer'
  | 'not_an_amount'
  | 'not_allowed_value'
  | 'unknown_reference'
  | 'duplicate_in_file';

export interface RowError {
  /** 1-based line in the source file — so the user can go and fix it. */
  readonly line: number;
  readonly column: string;
  readonly kind: RowErrorKind;
  readonly message: string;
}

export interface ImportPreview {
  readonly template: TemplateSpec;
  readonly totalRows: number;
  /** Rows that passed every check and would be applied. */
  readonly validRows: readonly Readonly<Record<string, string>>[];
  readonly validCount: number;
  /** Rows with at least one blocking error — nothing commits while any exist. */
  readonly errors: readonly RowError[];
  readonly errorRowCount: number;
  /** Rows whose key already exists — for review, never auto-merged (M30-FR-03). */
  readonly duplicatesForReview: readonly { readonly line: number; readonly key: string }[];
  /** Sum of the amount column (minor units) when the template is financial. */
  readonly sumMinor?: number;
  /** True when the declared control total matches the sum (M30-FR-03). */
  readonly reconciles?: boolean;
  /** True only when the import may proceed to approval. */
  readonly commitReady: boolean;
}

const INTEGER = /^-?\d+$/;

function keyOf(row: Readonly<Record<string, string>>, keyColumns: readonly string[]): string {
  return keyColumns.map((c) => (row[c] ?? '').toLowerCase()).join('\u0000');
}

/**
 * Validate rows against the template. Returns a preview: what would be applied, what
 * is wrong (per row, with line numbers), what duplicates need review, and whether a
 * financial import reconciles. Nothing is changed here.
 */
export function validateImport(input: ValidateInput): ImportPreview {
  const { template, rows, lineNumbers } = input;
  const errors: RowError[] = [];
  const duplicatesForReview: { line: number; key: string }[] = [];
  const seenInFile = new Map<string, number>();
  const existing = new Set(input.existingKeys ?? []);
  const badRows = new Set<number>();
  const validRows: Record<string, string>[] = [];
  let sumMinor = 0;

  rows.forEach((row, index) => {
    const line = lineNumbers[index] ?? index + 2;
    let rowOk = true;

    for (const column of template.columns) {
      const raw = row[column.name] ?? '';

      if (column.required && raw === '') {
        errors.push({ line, column: column.name, kind: 'missing_required', message: `"${column.name}" is required but blank.` });
        rowOk = false;
        continue;
      }
      if (raw === '') continue; // optional and blank — nothing further to check

      if (column.type === 'integer' && !INTEGER.test(raw)) {
        errors.push({ line, column: column.name, kind: 'not_an_integer', message: `"${raw}" is not a whole number.` });
        rowOk = false;
      }
      if (column.type === 'money_minor' && !INTEGER.test(raw)) {
        errors.push({ line, column: column.name, kind: 'not_an_amount', message: `"${raw}" is not an amount in whole paise.` });
        rowOk = false;
      }
      if (column.type === 'enum' && !(column.allowed ?? []).includes(raw)) {
        errors.push({
          line,
          column: column.name,
          kind: 'not_allowed_value',
          message: `"${raw}" is not one of: ${(column.allowed ?? []).join(', ')}.`,
        });
        rowOk = false;
      }
      if (column.referenceSet !== undefined) {
        const known = input.references?.[column.referenceSet] ?? [];
        if (!known.includes(raw)) {
          errors.push({
            line,
            column: column.name,
            kind: 'unknown_reference',
            message: `"${raw}" is not a known ${column.referenceSet}.`,
          });
          rowOk = false;
        }
      }
    }

    // Duplicate WITHIN the file is a blocking error — the user must decide which wins.
    const key = keyOf(row, template.keyColumns);
    const firstSeen = seenInFile.get(key);
    if (firstSeen !== undefined) {
      errors.push({
        line,
        column: template.keyColumns.join('+'),
        kind: 'duplicate_in_file',
        message: `The same key also appears on line ${firstSeen}.`,
      });
      rowOk = false;
    } else {
      seenInFile.set(key, line);
    }

    // A key that already EXISTS is flagged for review, never auto-merged.
    if (existing.has(key)) {
      duplicatesForReview.push({ line, key });
    }

    if (rowOk) {
      validRows.push({ ...row });
      if (template.amountColumn !== undefined) {
        sumMinor += Number(row[template.amountColumn] ?? 0);
      }
    } else {
      badRows.add(line);
    }
  });

  const isFinancial = template.amountColumn !== undefined;
  const reconciles =
    isFinancial && input.declaredTotalMinor !== undefined ? sumMinor === input.declaredTotalMinor : undefined;

  return {
    template,
    totalRows: rows.length,
    validRows,
    validCount: validRows.length,
    errors,
    errorRowCount: badRows.size,
    duplicatesForReview,
    ...(isFinancial ? { sumMinor } : {}),
    ...(reconciles !== undefined ? { reconciles } : {}),
    // Ready only when nothing is wrong, something is there, and a financial
    // import balances against its declared control total.
    commitReady: errors.length === 0 && validRows.length > 0 && reconciles !== false,
  };
}

export type CommitRefusal =
  | 'has_errors'
  | 'nothing_to_import'
  | 'does_not_reconcile'
  | 'not_approved'
  | 'self_approved';

export interface CommitResult {
  readonly committed: boolean;
  readonly rowsApplied: number;
  readonly refusal?: CommitRefusal;
}

export interface CommitInput {
  readonly preview: ImportPreview;
  /** Who uploaded the file — they may not approve their own import (§28). */
  readonly uploadedBy: string;
  /** The maker-checker approval for THIS import job. */
  readonly approval?: DecidedRequest;
  /** The job id the approval must reference. */
  readonly jobId: string;
}

/**
 * Commit an approved import. ATOMIC: it applies every valid row through `apply`, or
 * nothing at all — any blocking error, a failed reconciliation, or a missing/invalid
 * approval refuses the whole job. If `apply` throws, nothing is reported as
 * committed, so the caller's transaction can roll back (M30-FR-01/04).
 */
export function commitImport(
  input: CommitInput,
  apply: (rows: readonly Readonly<Record<string, string>>[]) => void,
): CommitResult {
  const { preview } = input;

  if (preview.errors.length > 0) {
    return { committed: false, rowsApplied: 0, refusal: 'has_errors' };
  }
  if (preview.validCount === 0) {
    return { committed: false, rowsApplied: 0, refusal: 'nothing_to_import' };
  }
  if (preview.reconciles === false) {
    return { committed: false, rowsApplied: 0, refusal: 'does_not_reconcile' };
  }

  const a = input.approval;
  if (a === undefined || a.status !== 'approved' || a.subjectRef !== input.jobId) {
    return { committed: false, rowsApplied: 0, refusal: 'not_approved' };
  }
  if (a.decidedBy === input.uploadedBy) {
    // The person who uploaded cannot approve their own import (§28).
    return { committed: false, rowsApplied: 0, refusal: 'self_approved' };
  }

  apply(preview.validRows); // throws → the caller rolls back; nothing is reported applied
  return { committed: true, rowsApplied: preview.validCount };
}
