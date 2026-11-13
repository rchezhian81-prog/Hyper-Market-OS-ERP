import { describe, it, expect } from 'vitest';
import { createImportChecksSession } from '../../apps/web-erp/src/w5-platform-session';

// U7 (OB-726) · Data in and out: "Every file loaded, refused or abandoned" is read ONE page at a time from head office
// through the register's loader (search and sort at head office), with the total of every job — never the first fifty.

function fake() {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ jobs: [{ jobId: 'job-1', fileName: 'anand-oct.csv', uploadedBy: 'u-owner', uploadedAt: '2026-10-01T08:00:00.000Z', outcome: 'refused', rows: '6/10', detail: 'refused' }], count: 1, paging: { page: 2, size: 10, total: 61, pages: 7 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { asked, fetch };
}

describe('the import checks session reads one page of jobs', () => {
  it('asks head office for one page, sorted by its own field, and reads the rows and the total', async () => {
    const f = fake();
    const s = createImportChecksSession({ viewer: { userId: 'u-owner', permissions: ['purchase.import.read'] }, fetch: f.fetch });
    const out = await s.jobsPage({ page: 1, size: 10, search: 'anand', sort: 'file', dir: 'asc' });
    expect(f.asked).toEqual(['/v1/purchase/import-jobs?page=2&size=10&search=anand&sort=fileName&dir=asc']);
    expect(out).toMatchObject({ result: 'ok', value: { total: 61, rows: [{ jobId: 'job-1' }] } });
  });

  it('a person who may not read the history is told so, and nothing is asked', async () => {
    const f = fake();
    const s = createImportChecksSession({ viewer: { userId: 'u-c', permissions: [] }, fetch: f.fetch });
    expect((await s.jobsPage({ page: 0, size: 10, search: '', sort: null, dir: 'asc' })).result).toBe('invalid');
    expect(f.asked).toEqual([]);
  });
});
