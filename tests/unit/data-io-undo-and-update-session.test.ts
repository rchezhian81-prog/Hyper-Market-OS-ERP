import { describe, it, expect } from 'vitest';
import {
  createDataIoSession, UNDO_APPROVAL_KIND,
  type DataIoPorts, type CommitResult, type UndoRequest, type LoadedJobView,
} from '../../apps/web-erp/src/data-io-session';
import type { ApprovalAsk, ApprovalRequestView, InboxRead } from '../../apps/web-erp/src/approvals-session';

// M30 round 8 — the import console's UNDO of a load and its preview of an UPDATE file, in the DOM-free session model the
// shell draws. An undo is the same two-person flow as a load: the uploader ASKS (kind data_import_rollback, the job, a reason),
// a different person approves on their own page, and "Undo it" names the uploader's own APPROVED undo request — never a typed
// name. Not asked / waiting / rejected / expired / used are said and nothing is POSTed; head office's refusal (a later change
// the undo would lose) comes back in its own words. The loads list says which loads are in place and which were undone.

const undoRequest = (over: Partial<ApprovalRequestView> = {}): ApprovalRequestView => ({
  requestId: 'undo-1', kind: UNDO_APPROVAL_KIND, label: 'Undo a bulk import', subjectRef: 'U-1', valueMinor: null,
  details: { jobId: 'U-1' }, summary: 'Undo the load "U-1"', reason: 'wrong brand file', requestedBy: 'u-owner',
  requestedAt: '2026-10-10T04:00:00.000Z', status: 'waiting', ...over,
});
const inboxOf = (...mine: ApprovalRequestView[]): InboxRead => ({ result: 'read', inbox: { waitingForMe: [], mine, asAt: '2026-10-10T05:00:00.000Z' } });
const JOBS: readonly LoadedJobView[] = [
  { jobId: 'U-1', templateId: 'product-update-v1', rowsApplied: 2, uploadedBy: 'u-owner', approvedBy: 'u-mgr', at: '2026-10-10T03:00:00.000Z' },
  { jobId: 'P-0', templateId: 'product-v1', rowsApplied: 1, uploadedBy: 'u-owner', approvedBy: 'u-mgr', at: '2026-10-09T03:00:00.000Z', rolledBack: { at: '2026-10-09T05:00:00.000Z', requestedBy: 'u-owner', approvedBy: 'u-mgr', reason: 'duplicate file' } },
];

function session(over: Partial<DataIoPorts> = {}) {
  const sent: UndoRequest[] = [];
  const asked: ApprovalAsk[] = [];
  const ports: DataIoPorts = {
    exportDomains: () => [], recentExports: () => [],
    importTemplates: () => [{ id: 'product-update-v1', domain: 'product', label: 'Change existing products', financial: false }, { id: 'product-v1', domain: 'product', label: 'New products', financial: false }],
    mayExport: () => true, mayImport: () => true, mayCommitImport: () => true,
    runExport: async () => ({ kind: 'exported', rowCount: 1, redactedColumns: [], file: { fileName: 'products.csv', mime: 'text/csv', content: 'sku\nA\n' } } as const), validate: async () => 'refused', commit: async () => 'committed',
    askApproval: async (ask) => { asked.push(ask); return { result: 'asked', request: undoRequest({ summary: ask.summary, reason: ask.reason }) }; },
    approvalInbox: async () => inboxOf(undoRequest({ status: 'approved', decidedBy: 'u-mgr', decisionReason: 'ok' })),
    loadedJobs: async () => ({ result: 'read', jobs: JOBS }),
    undo: async (req) => { sent.push(req); return 'committed' as CommitResult; },
    ...over,
  };
  return { s: createDataIoSession({ userId: 'u-owner' }, ports), sent, asked };
}

describe('the loads list says which loads are in place and which were undone (M30 round 8)', () => {
  it('newest first, with the template\'s words, who loaded and approved; an undone one says who asked, who approved and why — and cannot be undone again', async () => {
    const { s } = session();
    const view = await s.loads('en');
    expect(view.state).toBe('read');
    expect(view.rows.map((r) => [r.jobId, r.undone, r.mayUndo, r.status.label])).toEqual([
      ['U-1', false, true, 'In place'],
      ['P-0', true, false, 'Undone — u-owner asked, u-mgr approved: "duplicate file"'],
    ]);
    expect(view.rows[0]?.line).toMatch(/^Change existing products · 2 rows · loaded by u-owner, approved by u-mgr · /);
    // Colour is never the only signal: the undone row carries its own icon and words.
    expect(view.rows[1]?.status.icon).toBe('↺');
    expect((await s.loads('ta')).rows[0]?.status.label).toBe('நடைமுறையில் உள்ளது');
  });
  it('without import permission nothing is read; without a link it says so', async () => {
    expect((await session({ mayImport: () => false }).s.loads('en')).state).toBe('not_allowed');
    expect((await session({ loadedJobs: async () => ({ result: 'lost_link' }) }).s.loads('en')).state).toBe('lost_link');
    // A person who may read but not load sees the list but no undo.
    expect((await session({ mayCommitImport: () => false }).s.loads('en')).rows.every((r) => !r.mayUndo)).toBe(true);
  });
});

describe('asking to undo and undoing — two people, never a typed name (M30 round 8)', () => {
  it('asks under data_import_rollback for exactly this job, with the reason; a missing reason asks nothing', async () => {
    const { s, asked } = session();
    expect(await s.askToUndo('en', { jobId: 'U-1', why: '  ' })).toEqual({ kind: 'incomplete', missing: 'why' });
    expect(asked).toHaveLength(0);
    const o = await s.askToUndo('en', { jobId: 'U-1', why: 'wrong brand file' });
    expect(o.kind).toBe('asked');
    expect(asked).toEqual([{ kind: UNDO_APPROVAL_KIND, subjectRef: 'U-1', details: { jobId: 'U-1' }, valueMinor: null, summary: 'Undo the load "U-1"', reason: 'wrong brand file' }]);
    expect(s.presentUndoAskOutcome('en', o).label).toBe('Asked. Waiting for a second person to approve the undo: Undo the load "U-1"');
    expect(s.presentUndoAskOutcome('en', { kind: 'incomplete', missing: 'why' }).label).toMatch(/Say why this load should be undone/);
    expect((await session({ mayCommitImport: () => false }).s.askToUndo('en', { jobId: 'U-1', why: 'x' })).kind).toBe('not_allowed');
  });

  it('"Undo it" names the caller\'s own APPROVED undo request for this job — and POSTs nothing when there is none usable', async () => {
    const approved = session();
    expect(await approved.s.undo({ jobId: 'U-1', why: 'wrong brand file' })).toEqual({ kind: 'undone' });
    expect(approved.sent).toEqual([{ jobId: 'U-1', reason: 'wrong brand file', approvalId: 'undo-1' }]);
    expect(approved.s.presentUndoOutcome('en', { kind: 'undone' })).toMatchObject({ tone: 'ok', label: expect.stringMatching(/^Undone\. .*nothing was deleted/) });

    const cases: [InboxRead, string][] = [
      [inboxOf(), 'not_asked'],
      [inboxOf(undoRequest({ status: 'waiting' })), 'waiting'],
      [inboxOf(undoRequest({ status: 'rejected', decidedBy: 'u-mgr', decisionReason: 'the file was right' })), 'rejected'],
      [inboxOf(undoRequest({ status: 'expired' })), 'expired'],
      [inboxOf(undoRequest({ status: 'used' })), 'used'],
      // Another job's approved undo does not count for this one.
      [inboxOf(undoRequest({ status: 'approved', subjectRef: 'OTHER', details: { jobId: 'OTHER' } })), 'not_asked'],
    ];
    for (const [inbox, kind] of cases) {
      const { s, sent } = session({ approvalInbox: async () => inbox });
      const o = await s.undo({ jobId: 'U-1', why: 'x' });
      expect(o.kind, kind).toBe(kind);
      expect(sent, kind).toHaveLength(0);
    }
    const rejected = await session({ approvalInbox: async () => inboxOf(undoRequest({ status: 'rejected', decidedBy: 'u-mgr', decisionReason: 'the file was right' })) }).s.undo({ jobId: 'U-1', why: 'x' });
    expect(session().s.presentUndoOutcome('en', rejected).label).toBe('Not undone — u-mgr rejected it: "the file was right".');
    // No reason, no permission: refused before anything is read or sent.
    expect((await session().s.undo({ jobId: 'U-1', why: '' })).kind).toBe('needs_why');
    expect((await session({ mayCommitImport: () => false }).s.undo({ jobId: 'U-1', why: 'x' })).kind).toBe('not_allowed');
  });

  it('head office\'s refusal comes back in its own words — a later change the undo would lose — and an undone load is said', async () => {
    const words = 'Import job \'U-2\' cannot be undone: product p-soap was changed again after this load.';
    const { s } = session({ undo: async () => ({ code: 'import_effect_in_use', whatHappened: words }) });
    const o = await s.undo({ jobId: 'U-1', why: 'x' });
    expect(o).toEqual({ kind: 'refused', whatHappened: words });
    expect(s.presentUndoOutcome('en', o)).toMatchObject({ tone: 'error', label: `Not undone: ${words}` });
    expect((await session({ undo: async () => ({ code: 'import_already_rolled_back', whatHappened: '' }) }).s.undo({ jobId: 'U-1', why: 'x' })).kind).toBe('already_undone');
    expect((await session({ undo: async () => 'lost_link' }).s.undo({ jobId: 'U-1', why: 'x' })).kind).toBe('lost_link');
  });
});

describe('an update file\'s preview says what each row changes (M30 round 8)', () => {
  it('one line per change, from → to, in English and Tamil', () => {
    const { s } = session();
    const changes = [{ line: 2, key: 'p-rice', changes: [{ field: 'name', from: 'Rice 5kg', to: 'Ponni Rice 5kg' }, { field: 'brand', from: '', to: 'Kaveri' }] }];
    expect(s.presentChanges('en', changes)).toEqual(['line 2 · p-rice: name "Rice 5kg" → "Ponni Rice 5kg"', 'line 2 · p-rice: brand "" → "Kaveri"']);
    expect(s.presentChanges('ta', changes)[0]).toBe('வரி 2 · p-rice: name "Rice 5kg" → "Ponni Rice 5kg"');
  });
});
