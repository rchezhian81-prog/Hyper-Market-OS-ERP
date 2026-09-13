import { describe, it, expect } from 'vitest';
import {
  assessMappingQuality,
  type ImportJobRecord,
  type RowError,
  type RowErrorKind,
} from '../../packages/import/src/index';

// A08 "suspicious mappings" (§7.1 · M30-FR-04 · P-05) — the third A08 leg. It reads import history (the only
// mapping-related data that is persisted: the per-column rejection fingerprint) and flags a (source, column,
// reason) that recurs enough to be a pattern, on a mapping-related reason. It reuses the tested scoreSource
// ranking + its corrective action. Read-only; it produces a review list, never an action.

const err = (line: number, column: string, kind: RowErrorKind): RowError => ({ line, column, kind, message: `${column} ${kind}` });

const job = (over: Partial<ImportJobRecord> & Pick<ImportJobRecord, 'jobId' | 'sourceId' | 'errors'>): ImportJobRecord => ({
  tenantId: 'sre', templateId: 'product', fileName: `${over.jobId}.csv`, uploadedBy: 'u-op',
  uploadedAt: '2026-09-01T10:00:00Z', outcome: 'committed',
  totalRows: 100, validRows: 100 - over.errors.length, errorRows: over.errors.length, duplicatesForReview: 0,
  ...over,
});

describe('assessMappingQuality — suspicious mappings from the rejection fingerprint', () => {
  it('flags a column a source keeps failing on, names the source, and carries the corrective action', () => {
    // "hsn" rejected as an unrecognised code across three files from one supplier — a mapping/agreement gap.
    const jobs = [
      job({ jobId: 'j1', sourceId: 'acme-foods', errors: [err(2, 'hsn', 'not_allowed_value'), err(5, 'hsn', 'not_allowed_value')] }),
      job({ jobId: 'j2', sourceId: 'acme-foods', uploadedAt: '2026-09-08T10:00:00Z', errors: [err(3, 'hsn', 'not_allowed_value')] }),
    ];
    const findings = assessMappingQuality({ jobs });
    const hsn = findings.find((f) => f.column === 'hsn');
    expect(hsn).toBeDefined();
    expect(hsn!.sourceId).toBe('acme-foods');
    expect(hsn!.kind).toBe('not_allowed_value');
    expect(hsn!.count).toBe(3);
    expect(hsn!.findingId).toBe('dq-mapping:acme-foods:hsn:not_allowed_value');
    expect(hsn!.headline).toContain('acme-foods');
    expect(hsn!.headline).toContain('hsn');
    expect(hsn!.action.length).toBeGreaterThan(0); // the tested engine's ACTION_FOR text
  });

  it('ignores in-file duplicates — a source exporting the same key twice is not a mapping problem', () => {
    const jobs = [job({ jobId: 'j1', sourceId: 's', errors: [err(2, 'sku', 'duplicate_in_file'), err(3, 'sku', 'duplicate_in_file'), err(4, 'sku', 'duplicate_in_file')] })];
    expect(assessMappingQuality({ jobs })).toEqual([]);
  });

  it('does not flag a one-off — a reason must recur to be a pattern, not a typo', () => {
    const jobs = [job({ jobId: 'j1', sourceId: 's', errors: [err(2, 'price', 'not_an_amount')] })];
    expect(assessMappingQuality({ jobs })).toEqual([]); // count 1 < default minCount 3
  });

  it('does not flag a column that is only a small share of a source\'s failures', () => {
    // 3 "price" failures but 30 "hsn" failures → price is ~9% of failures, below the 20% share floor.
    const hsn = Array.from({ length: 30 }, (_, i) => err(i + 1, 'hsn', 'not_allowed_value'));
    const price = [err(31, 'price', 'not_an_amount'), err(32, 'price', 'not_an_amount'), err(33, 'price', 'not_an_amount')];
    const jobs = [job({ jobId: 'j1', sourceId: 's', errors: [...hsn, ...price] })];
    const findings = assessMappingQuality({ jobs });
    expect(findings.some((f) => f.column === 'price')).toBe(false);
    expect(findings.some((f) => f.column === 'hsn')).toBe(true);
  });

  it('surfaces the worst first and is deterministic across sources', () => {
    const jobs = [
      job({ jobId: 'a', sourceId: 'src-a', errors: Array.from({ length: 4 }, (_, i) => err(i + 1, 'uom', 'not_allowed_value')) }),
      job({ jobId: 'b', sourceId: 'src-b', errors: Array.from({ length: 9 }, (_, i) => err(i + 1, 'mrp', 'not_an_amount')) }),
    ];
    const first = assessMappingQuality({ jobs });
    expect(first.map((f) => f.findingId)).toEqual([
      'dq-mapping:src-b:mrp:not_an_amount', // 9 rejected — worst first
      'dq-mapping:src-a:uom:not_allowed_value',
    ]);
    expect(assessMappingQuality({ jobs })).toEqual(first); // deterministic
  });

  it('says nothing about a clean history', () => {
    expect(assessMappingQuality({ jobs: [job({ jobId: 'j1', sourceId: 's', errors: [] })] })).toEqual([]);
    expect(assessMappingQuality({ jobs: [] })).toEqual([]);
  });
});
