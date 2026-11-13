import { describe, it, expect } from 'vitest';
import { importQualityRoutes, type ImportQualityDeps } from '../../services/purchase/src/import-quality';
import type { ImportJobRecord } from '../../packages/import/src/job-history';
import type { RequestContext, Route } from '../../services/kernel/src/index';

/**
 * U7 (OB-726) · the import job history (every job, refusals included — M30-FR-04) is paged by head office when the page
 * asks: one page, the total of ALL the jobs that match (no longer cut at the first 50 without a word — P-08), a search
 * over the file, the source, the uploader and the outcome, and a sort by time or file. Without ?page= the old answer.
 */
const T = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ctxOf = (query: Record<string, string>): RequestContext => ({ tenantId: T, userId: 'u-owner', scope: 'all', params: {}, query, body: undefined, traceId: 't' } as unknown as RequestContext);
const job = (n: number): ImportJobRecord => ({
  jobId: `job-${String(n).padStart(2, '0')}`, tenantId: T, templateId: 'supplier-invoice-v1', sourceId: n % 2 === 0 ? 'supplier-anand' : 'supplier-ravi',
  fileName: `file-${n}.csv`, uploadedBy: 'u-owner', uploadedAt: `2026-10-01T08:${String(n).padStart(2, '0')}:00.000Z`, outcome: n === 7 ? 'refused' : 'committed',
  totalRows: 10, validRows: 10, errorRows: 0, duplicatesForReview: 0, errors: [], ...(n === 7 ? { refusalReason: 'bad GSTIN' } : {}),
} as unknown as ImportJobRecord);
const jobs = Array.from({ length: 60 }, (_, i) => job(i + 1));
const route = (): Route => importQualityRoutes({ jobs: () => jobs, recordImportJob: () => {}, now: () => '2026-11-13T09:00:00.000Z' } as unknown as ImportQualityDeps).find((r) => r.method === 'GET' && r.path === '/v1/purchase/import-jobs')!;

describe('U7 · the import job history is paged by head office', () => {
  it('answers one page and the total of all sixty jobs, newest first — none dropped at fifty', async () => {
    const body = (await route().handler(ctxOf({ page: '6', size: '10' }))).body as { jobs: { jobId: string }[]; count: number; paging: { total: number; pages: number } };
    expect(body.paging).toMatchObject({ total: 60, pages: 6 });
    expect(body.jobs.map((j) => j.jobId)).toEqual(['job-10', 'job-09', 'job-08', 'job-07', 'job-06', 'job-05', 'job-04', 'job-03', 'job-02', 'job-01']);
  });

  it('searches the file, source, uploader and outcome, and sorts by file', async () => {
    const refused = (await route().handler(ctxOf({ page: '1', size: '10', search: 'REFUSED' }))).body as { jobs: { jobId: string }[]; paging: { total: number } };
    expect(refused.jobs.map((j) => j.jobId)).toEqual(['job-07']);
    const anand = (await route().handler(ctxOf({ page: '1', size: '2', search: 'anand', sort: 'fileName', dir: 'asc' }))).body as { jobs: { fileName: string }[]; paging: { total: number } };
    expect(anand.paging.total).toBe(30);
    expect(anand.jobs.map((j) => j.fileName)).toEqual(['file-2.csv', 'file-4.csv']);
  });

  it('without ?page= answers exactly as before (the first fifty)', async () => {
    const body = (await route().handler(ctxOf({}))).body as { jobs: unknown[]; count: number; paging?: unknown };
    expect(body.count).toBe(50);
    expect(body.paging).toBeUndefined();
  });
});
