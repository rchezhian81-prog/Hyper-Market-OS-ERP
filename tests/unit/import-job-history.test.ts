import { describe, it, expect } from 'vitest';
import {
  recordJob,
  scoreSource,
  jobHistory,
  compareSources,
  type ImportJobRecord,
} from '../../packages/import/src/job-history';
import type { ImportPreview, RowError, TemplateSpec } from '../../packages/import/src/import-job';

// M30-FR-04 remainder: job history and data-quality scoring.

const TEMPLATE: TemplateSpec = {
  id: 'tpl-supplier-price',
  domain: 'supplier_price',
  columns: [
    { name: 'sku', type: 'text', required: true },
    { name: 'price', type: 'money_minor', required: true },
    { name: 'hsn', type: 'text', required: true },
  ],
  keyColumns: ['sku'],
};

const error = (over: Partial<RowError>): RowError => ({
  line: 4, column: 'hsn', kind: 'missing_required', message: 'hsn is required', ...over,
});

function preview(over: Partial<ImportPreview> = {}): ImportPreview {
  return {
    template: TEMPLATE,
    totalRows: 100,
    validRows: [],
    validCount: 88,
    errors: Array.from({ length: 12 }, (_, n) => error({ line: n + 4 })),
    errorRowCount: 12,
    duplicatesForReview: [],
    commitReady: false,
    ...over,
  };
}

/** A refused weekly price file, 12% of rows rejected — the situation nobody notices. */
const REFUSED = recordJob({
  jobId: 'ij-1', tenantId: 't-sre', sourceId: 'sup-anand', fileName: 'prices-aug.csv',
  uploadedBy: 'u-buyer', uploadedAt: '2026-08-04T09:00:00Z',
  preview: preview(), outcome: 'refused', refusalReason: 'has_errors',
});

const job = (over: Partial<ImportJobRecord> = {}): ImportJobRecord => ({ ...REFUSED, ...over });

describe('a job record is kept whether it succeeded or NOT (hard rule #6)', () => {
  it('records a refusal with its reasons intact', () => {
    const r = job();
    expect(r.outcome).toBe('refused');
    expect(r.errorRows).toBe(12);
    // A history of only the successes is how a file that fails half the time looks perfect.
    expect(r.errors).toHaveLength(12);
    expect(r.refusalReason).toBe('has_errors');
  });

  it('records a commit with its approver', () => {
    const r = recordJob({
      jobId: 'ij-2', tenantId: 't-sre', sourceId: 'sup-anand', fileName: 'prices-aug-fixed.csv',
      uploadedBy: 'u-buyer', uploadedAt: '2026-08-04T10:00:00Z',
      preview: preview({ validCount: 100, errors: [], errorRowCount: 0, commitReady: true }),
      outcome: 'committed', approvedBy: 'u-manager',
    });
    expect(r.outcome).toBe('committed');
    expect(r.approvedBy).toBe('u-manager');
    expect(r.templateId).toBe('tpl-supplier-price');
  });

  it('carries the reconciliation result for a financial import', () => {
    const r = recordJob({
      jobId: 'ij-3', tenantId: 't-sre', sourceId: 'sup-anand', fileName: 'inv.csv',
      uploadedBy: 'u-buyer', uploadedAt: '2026-08-04T11:00:00Z',
      preview: preview({ sumMinor: 412_000, reconciles: false }),
      outcome: 'refused', refusalReason: 'does_not_reconcile',
    });
    expect(r.sumMinor).toBe(412_000);
    expect(r.reconciled).toBe(false);
  });
});

describe('the score belongs to the SOURCE, not the operator (M30-FR-04)', () => {
  /** A week of daily files, each 12% rejected. Nobody ever noticed. */
  const WEEK = Array.from({ length: 8 }, (_, n) =>
    job({ jobId: `ij-${n}`, uploadedAt: `2026-08-0${n + 1}T09:00:00Z` }));

  it('bands a 12%-rejected source as poor and names the ONE reason', () => {
    const s = scoreSource({
      sourceId: 'sup-anand',
      jobs: WEEK,
      from: '2026-08-01', to: '2026-08-08',
    });
    expect(s.acceptedBps).toBe(8_800);
    expect(s.band).toBe('poor');
    expect(s.topReasons[0]?.column).toBe('hsn');
    expect(s.topReasons[0]?.shareBps).toBe(10_000);
    // The actionable half: one email to the supplier, not an hour of retyping.
    expect(s.topReasons[0]?.action).toContain('missing at their end, not ours');
  });

  it('puts a number on the QUIET cost', () => {
    const s = scoreSource({
      sourceId: 'sup-anand',
      jobs: WEEK,
      from: '2026-08-01', to: '2026-08-08',
    });
    // 96 rejected rows in 8 days × 2 min = 3.2h, extrapolated to a year.
    expect(s.annualFixHours).toBeGreaterThan(100);
    // "12% rejected" sounds tolerable. This does not.
    expect(s.detail).toContain('hour(s) a year of somebody retyping rows');
  });

  it('says CLEAN when there is nothing to chase', () => {
    const clean = Array.from({ length: 4 }, (_, n) =>
      job({
        jobId: `ok-${n}`, uploadedAt: `2026-08-0${n + 1}T09:00:00Z`,
        outcome: 'committed', errorRows: 0, validRows: 100, errors: [],
      }));
    const s = scoreSource({ sourceId: 'sup-anand', jobs: clean, from: '2026-08-01', to: '2026-08-08' });
    expect(s.band).toBe('clean');
    expect(s.detail).toContain('nothing to chase');
  });

  it('REFUSES to score a handful of rows — a rate on noise is noise', () => {
    const s = scoreSource({
      sourceId: 'sup-anand',
      jobs: [job({ totalRows: 8, validRows: 4, errorRows: 4 })],
      from: '2026-08-01', to: '2026-08-08',
    });
    expect(s.band).toBe('not_enough_data');
    expect(s.acceptedBps).toBe('not_enough_data');
    expect(s.detail).toContain('noise, not quality');
  });

  it('reports DIRECTION beside the level, so effort that is working shows up', () => {
    const worse = Array.from({ length: 4 }, (_, n) =>
      job({ jobId: `p-${n}`, uploadedAt: `2026-07-0${n + 1}T09:00:00Z`, errorRows: 30, validRows: 70 }));
    const better = Array.from({ length: 4 }, (_, n) =>
      job({ jobId: `c-${n}`, uploadedAt: `2026-08-0${n + 1}T09:00:00Z`, errorRows: 12, validRows: 88 }));

    const s = scoreSource({
      sourceId: 'sup-anand', jobs: better, previous: worse, from: '2026-08-01', to: '2026-08-08',
    });
    // Still "poor" — but improving, and a report showing only the band would call this a
    // failure two quarters running.
    expect(s.band).toBe('poor');
    expect(s.direction).toBe('improving');

    const declining = scoreSource({
      sourceId: 'sup-anand', jobs: worse.map((j) => ({ ...j, uploadedAt: '2026-08-02T09:00:00Z' })),
      previous: better, from: '2026-08-01', to: '2026-08-08',
    });
    expect(declining.direction).toBe('worsening');
  });

  it('will not call a direction from too little history', () => {
    const s = scoreSource({
      sourceId: 'sup-anand',
      jobs: Array.from({ length: 4 }, (_, n) => job({ jobId: `c-${n}`, uploadedAt: `2026-08-0${n + 1}T09:00:00Z` })),
      previous: [job({ totalRows: 10, errorRows: 1 })],
      from: '2026-08-01', to: '2026-08-08',
    });
    expect(s.direction).toBe('not_comparable');
  });

  it('never scores another source\'s files', () => {
    const s = scoreSource({
      sourceId: 'sup-anand',
      jobs: [
        ...Array.from({ length: 4 }, (_, n) => job({ jobId: `a-${n}`, uploadedAt: `2026-08-0${n + 1}T09:00:00Z` })),
        job({ jobId: 'k-1', sourceId: 'sup-kumar', totalRows: 1_000, errorRows: 900, uploadedAt: '2026-08-02T09:00:00Z' }),
      ],
      from: '2026-08-01', to: '2026-08-08',
    });
    expect(s.totalRows).toBe(400);
  });

  it('ranks reasons by count, and each carries what to DO', () => {
    const mixed = job({
      errors: [
        ...Array.from({ length: 9 }, (_, n) => error({ line: n, column: 'hsn' })),
        ...Array.from({ length: 3 }, (_, n) => error({ line: 20 + n, column: 'price', kind: 'not_an_amount' })),
      ],
      totalRows: 200, errorRows: 12, validRows: 188,
    });
    const s = scoreSource({ sourceId: 'sup-anand', jobs: [mixed], from: '2026-08-01', to: '2026-08-08' });
    expect(s.topReasons.map((r) => r.column)).toEqual(['hsn', 'price']);
    expect(s.topReasons[1]?.action).toContain('currency symbol or a comma');
  });
});

describe('the job history shows refusals AND the resubmission', () => {
  const jobs = [
    job({ jobId: 'ij-1', uploadedAt: '2026-08-04T09:00:00Z' }),
    job({
      jobId: 'ij-2', uploadedAt: '2026-08-04T10:00:00Z', outcome: 'committed',
      approvedBy: 'u-manager', errorRows: 0, validRows: 100, errors: [], duplicatesForReview: 3,
    }),
  ];

  it('shows both attempts, newest first', () => {
    const rows = jobHistory({ jobs });
    expect(rows.map((r) => r.jobId)).toEqual(['ij-2', 'ij-1']);
    // The first attempt is the EVIDENCE that the file was wrong.
    expect(rows[1]?.detail).toContain('refused: has_errors');
    expect(rows[0]?.detail).toContain('approved by u-manager');
    expect(rows[0]?.detail).toContain('3 duplicate(s) were left for review');
  });

  it('shows the row counts at a glance', () => {
    expect(jobHistory({ jobs })[1]?.rows).toBe('88/100');
  });

  it('filters by source and by template', () => {
    const withOther = [...jobs, job({ jobId: 'ij-9', sourceId: 'sup-kumar' })];
    expect(jobHistory({ jobs: withOther, sourceId: 'sup-anand' })).toHaveLength(2);
    expect(jobHistory({ jobs: withOther, templateId: 'tpl-other' })).toHaveLength(0);
  });

  it('honours a limit', () => {
    expect(jobHistory({ jobs, limit: 1 })).toHaveLength(1);
  });
});

describe('comparing sources produces a list of PEOPLE TO TALK TO, not a league table', () => {
  const score = (sourceId: string, errorRows: number) =>
    scoreSource({
      sourceId,
      jobs: Array.from({ length: 4 }, (_, n) =>
        job({ jobId: `${sourceId}-${n}`, sourceId, errorRows, validRows: 100 - errorRows, uploadedAt: `2026-08-0${n + 1}T09:00:00Z` })),
      from: '2026-08-01', to: '2026-08-08',
    });

  it('names who to email and what it costs between them', () => {
    const c = compareSources({
      scores: [score('sup-anand', 12), score('sup-kumar', 25), score('sup-clean', 0)],
      asAt: '2026-08-08',
    });
    expect(c.worthAConversation).toEqual(['sup-kumar', 'sup-anand']);
    expect(c.worthAConversation).not.toContain('sup-clean');
    expect(c.totalAnnualFixHours).toBeGreaterThan(0);
    // Not a chart to screenshot into a meeting.
    expect(c.detail).toContain('fix at their end once');
  });

  it('says nothing when every source is clean', () => {
    const c = compareSources({ scores: [score('sup-clean', 0)], asAt: '2026-08-08' });
    expect(c.worthAConversation).toEqual([]);
    expect(c.detail).toContain('none costing enough to chase');
  });
});
