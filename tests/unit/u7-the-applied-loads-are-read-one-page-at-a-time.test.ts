import { describe, it, expect } from 'vitest';
import { createDataIoSession, type DataIoPorts, type LoadedJobView } from '../../apps/web-erp/src/data-io-session';

// U7 (OB-726) · Data in and out: the loads already applied are read ONE page at a time from head office through the
// register's loader (search and sort at head office, newest first by default), each still saying whether it is in place
// or undone — in the reader's language at the moment it is drawn — and whether this person may undo it.

const JOBS: readonly LoadedJobView[] = [
  { jobId: 'U-1', templateId: 'product-update-v1', rowsApplied: 2, uploadedBy: 'u-owner', approvedBy: 'u-mgr', at: '2026-10-10T03:00:00.000Z' },
  { jobId: 'P-0', templateId: 'product-v1', rowsApplied: 1, uploadedBy: 'u-owner', approvedBy: 'u-mgr', at: '2026-10-09T03:00:00.000Z', rolledBack: { at: '2026-10-09T05:00:00.000Z', requestedBy: 'u-owner', approvedBy: 'u-mgr', reason: 'duplicate file' } },
];

function session(over: Partial<DataIoPorts> = {}) {
  const asked: string[] = [];
  const ports = {
    exportDomains: () => [], recentExports: () => [],
    importTemplates: () => [{ id: 'product-update-v1', domain: 'product', label: 'Change existing products', financial: false }, { id: 'product-v1', domain: 'product', label: 'New products', financial: false }],
    mayExport: () => true, mayImport: () => true, mayCommitImport: () => true,
    runExport: async () => ({ kind: 'exported', rowCount: 0, redactedColumns: [] }), validate: async () => 'refused', commit: async () => 'lost_link',
    loadedJobsPage: async (query: string) => { asked.push(query); return { result: 'read', jobs: JOBS, total: 23 }; },
    ...over,
  } as unknown as DataIoPorts;
  return { s: createDataIoSession({ userId: 'u-owner' }, ports), asked };
}

describe('the applied loads are read one page at a time', () => {
  it('asks head office for one page — newest first unless a column is chosen — and reads the jobs and the total', async () => {
    const { s, asked } = session();
    const page = await s.loadsPage({ page: 0, size: 10, search: '', sort: null, dir: 'asc' });
    expect(asked).toEqual(['page=1&size=10&sort=at&dir=desc']);
    expect(page).toEqual({ state: 'read', jobs: JOBS, total: 23 });
    await s.loadsPage({ page: 2, size: 10, search: 'U-1', sort: 'job', dir: 'asc' });
    expect(asked[1]).toBe('page=3&size=10&search=U-1&sort=jobId&dir=asc');
  });

  it('presents one load in the language asked, with whether it may be undone', () => {
    const { s } = session();
    expect([s.presentLoad('en', JOBS[0]!).status.label, s.presentLoad('en', JOBS[0]!).mayUndo]).toEqual(['In place', true]);
    const undone = s.presentLoad('en', JOBS[1]!);
    expect([undone.undone, undone.mayUndo, undone.status.label]).toEqual([true, false, 'Undone — u-owner asked, u-mgr approved: "duplicate file"']);
    expect(s.presentLoad('ta', JOBS[1]!).status.label).not.toBe(undone.status.label);
  });

  it('says plainly when it may not read, or has no link — never an empty list', async () => {
    expect(await session({ mayImport: () => false } as Partial<DataIoPorts>).s.loadsPage({ page: 0, size: 10, search: '', sort: null, dir: 'asc' })).toEqual({ state: 'not_allowed' });
    expect(await session({ loadedJobsPage: undefined } as Partial<DataIoPorts>).s.loadsPage({ page: 0, size: 10, search: '', sort: null, dir: 'asc' })).toEqual({ state: 'lost_link' });
    expect(await session({ loadedJobsPage: async () => ({ result: 'refused' }) } as unknown as Partial<DataIoPorts>).s.loadsPage({ page: 0, size: 10, search: '', sort: null, dir: 'asc' })).toEqual({ state: 'refused' });
  });
});
