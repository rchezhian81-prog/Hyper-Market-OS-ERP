import { describe, it, expect } from 'vitest';
import {
  DATA_IO_COPY, COPY_KEYS, createDataIoSession, IMPORT_APPROVAL_KIND,
  type DataIoPorts, type ExportDomainView, type ExportAuditView, type ImportTemplateView,
  type ValidateResult, type ExportResult, type CommitResult, type ImportPreviewView, type CommitRequest,
} from '../../apps/web-erp/src/data-io-session';
import type { ApprovalAsk, ApprovalRequestView, AskResult, InboxRead } from '../../apps/web-erp/src/approvals-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The data import & export console (M30-FR-01/02/03 · §28 · ADR-0024). EXPORT lists domains (which columns are
// sensitive), runs an audited export, and shows the log. IMPORT checks a pasted file to a preview; then the TWO-PERSON
// flow on head office's maker-checker engine: the uploader ASKS for approval in their own session (kind
// data_import_commit, the job name and the file's check code), a DIFFERENT person approves it on their own Approvals
// page, and LOAD names the uploader's own APPROVED request — never a typed approver. The screen refuses the cheap
// things locally before any POST; the server re-validates and is the single gate.

const DOMAINS: readonly ExportDomainView[] = [
  { domain: 'products', requires: 'catalogue.pack.read', columns: [
    { name: 'sku', type: 'text', sensitive: false }, { name: 'name', type: 'text', sensitive: false }, { name: 'cost', type: 'money_minor', sensitive: true },
  ] },
];
const RECENT: readonly ExportAuditView[] = [
  { userId: 'u-owner', domain: 'products', at: '2026-09-17T05:00:00Z', rowCount: 120, redactedColumns: ['cost'] },
];
const TEMPLATES: readonly ImportTemplateView[] = [
  { id: 'products-basic', domain: 'products', label: 'Products (SKU, name, price)', financial: false },
  { id: 'opening-cash', domain: 'finance', label: 'Opening cash (financial)', financial: true },
];
const PREVIEW: ImportPreviewView = {
  totalRows: 2, validCount: 2, errorRowCount: 0, errors: [], duplicateCount: 0, commitReady: true,
};
const FP = 'a'.repeat(64);
const CHECKED: ValidateResult = { preview: PREVIEW, contentFingerprint: FP };

/** One of the uploader's own requests, as GET /v1/approvals/requests returns it under `mine`. */
const request = (over: Partial<ApprovalRequestView> = {}): ApprovalRequestView => ({
  requestId: 'areq-1', kind: IMPORT_APPROVAL_KIND, label: 'Apply a bulk import', subjectRef: 'JOB-1', valueMinor: null,
  details: { jobId: 'JOB-1', contentFingerprint: FP }, summary: 'Load 2 rows (Products (SKU, name, price)) as "JOB-1"',
  reason: 'September prices', requestedBy: 'u-op', requestedAt: '2026-10-07T04:00:00.000Z', status: 'waiting', ...over,
});
const inboxOf = (...mine: ApprovalRequestView[]): InboxRead => ({ result: 'read', inbox: { waitingForMe: [], mine, asAt: '2026-10-07T05:00:00.000Z' } });

const ports = (over: Partial<DataIoPorts> = {}): DataIoPorts => ({
  exportDomains: () => DOMAINS,
  recentExports: () => RECENT,
  importTemplates: () => TEMPLATES,
  mayExport: () => true,
  mayImport: () => true,
  mayCommitImport: () => true,
  runExport: async () => 'exported',
  validate: async () => CHECKED,
  commit: async () => 'committed',
  askApproval: async (ask) => ({ result: 'asked', request: request({ summary: ask.summary, reason: ask.reason }) }),
  approvalInbox: async () => inboxOf(request({ status: 'approved', decidedBy: 'u-owner', decisionReason: 'ok', expiresAt: '2026-10-08T04:00:00.000Z' })),
  ...over,
});
const session = (over: Partial<DataIoPorts> = {}, userId: string | null = 'u-op') =>
  createDataIoSession({ userId }, ports(over));

const LOAD = { templateId: 'products-basic', text: 'sku,name,price\nRICE5,Rice,45000\nDAL1,Dal,12000', jobId: 'JOB-1' };
const ASK = { ...LOAD, why: 'September prices' };

describe('the import/export copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(DATA_IO_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });
  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...DATA_IO_COPY.en }, ta: { ...DATA_IO_COPY.ta, askBtn: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('askBtn');
  });
  it('no word on the screen asks anyone to TYPE an approver any more', () => {
    for (const lang of ['en', 'ta'] as const) {
      const all = Object.keys(DATA_IO_COPY[lang]);
      expect(all).not.toContain('approverLabel');
    }
    expect(DATA_IO_COPY.en.importLead).toMatch(/ask for approval/i);
  });
});

describe('the export panel lists domains, flags sensitive columns, and shows the log', () => {
  it('presents each domain with its sensitive-column count and the recent exports', () => {
    const view = session().exportPanel('en');
    expect(view.mayExport).toBe(true);
    expect(view.domains).toHaveLength(1);
    expect(view.domains[0]!.sensitiveCount).toBe(1);
    expect(view.domains[0]!.columns.find((c) => c.name === 'cost')!.sensitive).toBe(true);
    expect(view.recent[0]!.redactedColumns).toEqual(['cost']);
    expect(view.screenState.tone).not.toBe('error');
  });
  it('without export.read the panel is locked and shows nothing', () => {
    const view = session({ mayExport: () => false }).exportPanel('en');
    expect(view.mayExport).toBe(false);
    expect(view.domains).toEqual([]);
    expect(view.recent).toEqual([]);
  });
});

describe('the import panel offers templates and reflects permission + identity', () => {
  it('lists the templates and both permission flags', () => {
    const view = session().importPanel();
    expect(view.templates.map((t) => t.id)).toEqual(['products-basic', 'opening-cash']);
    expect(view.templates.find((t) => t.id === 'opening-cash')!.financial).toBe(true);
    expect(view.mayImport).toBe(true);
    expect(view.mayCommit).toBe(true);
  });
  it('reflects a person who may check but not load, and nobody-named', () => {
    expect(session({ mayCommitImport: () => false }).importPanel().mayCommit).toBe(false);
    expect(session({}, null).importPanel().nobodyNamed).toBe(true);
    expect(session({}, 'u-op').importPanel().nobodyNamed).toBe(false);
  });
});

describe('running an export refuses locally before any POST', () => {
  it('refuses without export.read or with an empty domain, and never calls the port', async () => {
    let ran = 0;
    const s = session({ mayExport: () => false, runExport: async () => { ran += 1; return 'exported'; } });
    expect(await s.runExport('products')).toBe('refused');
    expect(await session({ runExport: async () => { ran += 1; return 'exported'; } }).runExport('   ')).toBe('refused');
    expect(ran).toBe(0);
  });
  it('a permitted export reaches the port and passes the result through', async () => {
    const seen: string[] = [];
    const s = session({ runExport: async (d) => { seen.push(d); return 'exported'; } });
    expect(await s.runExport('products')).toBe('exported');
    expect(seen).toEqual(['products']);
    expect(await session({ runExport: async () => 'lost_link' as ExportResult }).runExport('products')).toBe('lost_link');
  });
});

describe('checking an import refuses locally, else previews with the file\'s check code', () => {
  it('refuses without import permission, an unknown template, or empty text — no POST', async () => {
    let ran = 0;
    const spy = (): DataIoPorts => ports({ validate: async () => { ran += 1; return CHECKED; } });
    expect(await createDataIoSession({ userId: 'u-op' }, { ...spy(), mayImport: () => false }).validate('products-basic', 'a,b')).toBe('refused');
    expect(await createDataIoSession({ userId: 'u-op' }, spy()).validate('not-a-template', 'a,b')).toBe('refused');
    expect(await createDataIoSession({ userId: 'u-op' }, spy()).validate('products-basic', '   ')).toBe('refused');
    expect(ran).toBe(0);
  });
  it('a valid request reaches the port with the declared total and returns the preview and the check code', async () => {
    const seen: unknown[] = [];
    const s = session({ validate: async (req) => { seen.push(req); return CHECKED; } });
    const r = await s.validate('opening-cash', 'a,b\\n1,2', 5000);
    expect(r).not.toBe('refused');
    expect((r as { preview: ImportPreviewView }).preview.commitReady).toBe(true);
    expect((r as { contentFingerprint: string }).contentFingerprint).toBe(FP);
    expect(seen[0]).toMatchObject({ templateId: 'opening-cash', declaredTotalMinor: 5000 });
    expect(await session({ validate: async () => 'lost_link' as ValidateResult }).validate('products-basic', 'a,b')).toBe('lost_link');
  });
});

describe('asking for approval — the uploader\'s own request, for this job and this exact file (ADR-0024)', () => {
  it('refuses locally without load permission, a template, a file, a job name or a reason — nothing is asked', async () => {
    let asked = 0;
    const counting = { askApproval: async (): Promise<AskResult> => { asked += 1; return { result: 'lost_link' }; } };
    expect((await session({ ...counting, mayCommitImport: () => false }).askForApproval('en', ASK)).kind).toBe('not_allowed');
    expect(await session(counting).askForApproval('en', { ...ASK, templateId: 'nope' })).toEqual({ kind: 'incomplete', missing: 'template' });
    expect(await session(counting).askForApproval('en', { ...ASK, text: '  ' })).toEqual({ kind: 'incomplete', missing: 'file' });
    expect(await session(counting).askForApproval('en', { ...ASK, jobId: ' ' })).toEqual({ kind: 'incomplete', missing: 'job' });
    expect(await session(counting).askForApproval('en', { ...ASK, why: '' })).toEqual({ kind: 'incomplete', missing: 'why' });
    expect(asked).toBe(0);
  });

  it('never asks for a file that is not ready — a second person is never shown a broken load', async () => {
    let asked = 0;
    const s = session({
      validate: async () => ({ preview: { ...PREVIEW, errorRowCount: 1, commitReady: false }, contentFingerprint: FP }),
      askApproval: async () => { asked += 1; return { result: 'lost_link' }; },
    });
    expect(await s.askForApproval('en', ASK)).toEqual({ kind: 'not_ready' });
    expect(asked).toBe(0);
  });

  it('asks with exactly the kind, the job as subject, the job + check code as details, no amount, a plain summary and the reason', async () => {
    const seen: ApprovalAsk[] = [];
    const s = session({ askApproval: async (ask) => { seen.push(ask); return { result: 'asked', request: request({ summary: ask.summary }) }; } });
    const out = await s.askForApproval('en', { ...ASK, jobId: '  JOB-1 ', why: '  September prices  ' });
    expect(out.kind).toBe('asked');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      kind: 'data_import_commit', subjectRef: 'JOB-1', details: { jobId: 'JOB-1', contentFingerprint: FP }, valueMinor: null,
      summary: 'Load 2 rows (Products (SKU, name, price)) as "JOB-1"', reason: 'September prices',
    });
    // No person other than the caller is named anywhere in what is sent.
    expect(JSON.stringify(seen[0])).not.toMatch(/u-owner|approver|decidedBy|uploadedBy/);
  });

  it('a financial load\'s summary carries the declared total; the summary follows the reader\'s language', async () => {
    const seen: ApprovalAsk[] = [];
    const s = session({ askApproval: async (ask) => { seen.push(ask); return { result: 'asked', request: request() }; } });
    await s.askForApproval('en', { ...ASK, templateId: 'opening-cash', declaredTotalMinor: 500000 });
    expect(seen[0]!.summary).toBe('Load 2 rows (Opening cash (financial)) as "JOB-1", declared total ₹5,000.00');
    await s.askForApproval('ta', ASK);
    expect(seen[1]!.summary).toMatch(/[஀-௿]/);
    expect(seen[1]!.summary).toContain('"JOB-1"');
  });

  it('the waiting state names the summary; a refusal shows the server\'s own words; no link says nothing was asked', async () => {
    const s = session();
    const asked = await s.askForApproval('en', ASK);
    const p = s.presentAskOutcome('en', asked);
    expect(p.label).toMatch(/^Asked\. Waiting for a second person to approve: Load 2 rows/);
    expect(p.icon.trim()).not.toBe('');
    expect(p.needsAttention).toBe(true);

    const refused = await session({ askApproval: async () => ({ result: 'refused', code: 'not_permitted_for_this_approval', whatHappened: 'u-op may not apply a bulk import.' }) }).askForApproval('en', ASK);
    expect(refused).toEqual({ kind: 'refused', whatHappened: 'u-op may not apply a bulk import.' });
    expect(s.presentAskOutcome('en', refused).label).toBe('Not asked: u-op may not apply a bulk import.');
    expect(s.presentAskOutcome('en', refused).tone).toBe('error');

    expect(await session({ askApproval: async () => ({ result: 'lost_link' }) }).askForApproval('en', ASK)).toEqual({ kind: 'lost_link' });
    expect(await session({ validate: async () => 'lost_link' }).askForApproval('en', ASK)).toEqual({ kind: 'lost_link' });
    // A bare stand-in with no engine wired cannot ask — and says so, rather than pretending.
    const { askApproval: _drop, ...bare } = ports();
    expect(await createDataIoSession({ userId: 'u-op' }, bare).askForApproval('en', ASK)).toEqual({ kind: 'lost_link' });
  });
});

describe('loading — names the uploader\'s own APPROVED request; never a typed approver', () => {
  it('refuses locally without load permission, a template, a file or a job name — no read, no POST', async () => {
    let commits = 0; let reads = 0;
    const spy = { commit: async (): Promise<CommitResult> => { commits += 1; return 'committed'; }, approvalInbox: async (): Promise<InboxRead> => { reads += 1; return inboxOf(); } };
    expect(await session({ ...spy, mayCommitImport: () => false }).commit(LOAD)).toEqual({ kind: 'not_allowed' });
    expect(await session(spy).commit({ ...LOAD, templateId: 'nope' })).toEqual({ kind: 'incomplete', missing: 'template' });
    expect(await session(spy).commit({ ...LOAD, text: ' ' })).toEqual({ kind: 'incomplete', missing: 'file' });
    expect(await session(spy).commit({ ...LOAD, jobId: '' })).toEqual({ kind: 'incomplete', missing: 'job' });
    expect(commits).toBe(0);
    expect(reads).toBe(0);
  });

  it('an approved request for this job and this file is named by its id — and nothing else identifies anyone', async () => {
    const seen: CommitRequest[] = [];
    const s = session({ commit: async (req) => { seen.push(req); return 'committed'; } });
    expect(await s.commit({ ...LOAD, jobId: ' JOB-1 ' })).toEqual({ kind: 'committed' });
    expect(seen).toEqual([{ templateId: 'products-basic', text: LOAD.text, jobId: 'JOB-1', approvalId: 'areq-1' }]);
    expect(Object.keys(seen[0]!)).not.toContain('approver');
    expect(s.presentLoadOutcome('en', { kind: 'committed' }).tone).toBe('ok');
  });

  it('not asked yet → says nobody was asked, and nothing is POSTed', async () => {
    let commits = 0;
    const s = session({ approvalInbox: async () => inboxOf(), commit: async () => { commits += 1; return 'committed'; } });
    const out = await s.commit(LOAD);
    expect(out).toEqual({ kind: 'not_asked' });
    expect(s.presentLoadOutcome('en', out).label).toMatch(/^Not approved yet — nobody has been asked/);
    expect(commits).toBe(0);
  });

  it('still waiting → "Not approved yet — waiting for a second person", and nothing is POSTed', async () => {
    let commits = 0;
    const s = session({ approvalInbox: async () => inboxOf(request()), commit: async () => { commits += 1; return 'committed'; } });
    const out = await s.commit(LOAD);
    expect(out).toEqual({ kind: 'waiting' });
    const p = s.presentLoadOutcome('en', out);
    expect(p.label).toMatch(/^Not approved yet — waiting for a second person/);
    expect(p.icon.trim()).not.toBe('');
    expect(commits).toBe(0);
  });

  it('rejected → says who rejected it and why, in both languages, and nothing is POSTed', async () => {
    let commits = 0;
    const rejected = request({ status: 'rejected', decidedBy: 'u-owner', decisionReason: 'prices look wrong' });
    const s = session({ approvalInbox: async () => inboxOf(rejected), commit: async () => { commits += 1; return 'committed'; } });
    const out = await s.commit(LOAD);
    expect(out).toEqual({ kind: 'rejected', decidedBy: 'u-owner', reason: 'prices look wrong' });
    expect(s.presentLoadOutcome('en', out).label).toBe('Not loaded — u-owner rejected it: "prices look wrong". Fix what they said and ask again.');
    expect(s.presentLoadOutcome('ta', out).label).toContain('u-owner');
    expect(s.presentLoadOutcome('ta', out).label).toContain('prices look wrong');
    expect(commits).toBe(0);
  });

  it('expired or already used → said plainly; a request for another job does not count', async () => {
    expect(await session({ approvalInbox: async () => inboxOf(request({ status: 'expired', decidedBy: 'u-owner' })) }).commit(LOAD)).toEqual({ kind: 'expired' });
    expect(await session({ approvalInbox: async () => inboxOf(request({ status: 'used', decidedBy: 'u-owner', usedBy: 'import-JOB-1' })) }).commit(LOAD)).toEqual({ kind: 'used' });
    const otherJob = request({ subjectRef: 'JOB-2', status: 'approved', decidedBy: 'u-owner', details: { jobId: 'JOB-2', contentFingerprint: FP } });
    expect(await session({ approvalInbox: async () => inboxOf(otherJob) }).commit(LOAD)).toEqual({ kind: 'not_asked' });
    const otherKind = request({ kind: 'supplier_bank_change', status: 'approved', decidedBy: 'u-owner' });
    expect(await session({ approvalInbox: async () => inboxOf(otherKind) }).commit(LOAD)).toEqual({ kind: 'not_asked' });
  });

  it('the file changed since asking (its check code moved) → "the file changed, ask again", and nothing is POSTed', async () => {
    let commits = 0;
    const s = session({
      validate: async () => ({ preview: PREVIEW, contentFingerprint: 'b'.repeat(64) }),
      commit: async () => { commits += 1; return 'committed'; },
    });
    const out = await s.commit(LOAD);
    expect(out).toEqual({ kind: 'file_changed' });
    expect(s.presentLoadOutcome('en', out).label).toMatch(/changed after you asked\. Ask for approval again/);
    expect(commits).toBe(0);
  });

  it('of two approvals for the job, the one for THIS file is named', async () => {
    const seen: CommitRequest[] = [];
    const old = request({ requestId: 'areq-old', status: 'approved', decidedBy: 'u-owner', details: { jobId: 'JOB-1', contentFingerprint: 'c'.repeat(64) }, requestedAt: '2026-10-07T05:00:00.000Z' });
    const right = request({ requestId: 'areq-right', status: 'approved', decidedBy: 'u-mgr', requestedAt: '2026-10-07T03:00:00.000Z' });
    const s = session({ approvalInbox: async () => inboxOf(old, right), commit: async (req) => { seen.push(req); return 'committed'; } });
    expect(await s.commit(LOAD)).toEqual({ kind: 'committed' });
    expect(seen[0]!.approvalId).toBe('areq-right');
  });

  it('maps the server\'s approval refusals to the same plain outcomes, and anything else to its own words', async () => {
    const refusing = (code: string, whatHappened = 'words'): DataIoPorts => ports({ commit: async () => ({ code, whatHappened }) });
    const load = (p: DataIoPorts) => createDataIoSession({ userId: 'u-op' }, p).commit(LOAD);
    expect(await load(refusing('approval_does_not_match'))).toEqual({ kind: 'file_changed' });
    expect(await load(refusing('approval_still_waiting'))).toEqual({ kind: 'waiting' });
    expect(await load(refusing('approval_expired'))).toEqual({ kind: 'expired' });
    expect(await load(refusing('approval_already_used'))).toEqual({ kind: 'used' });
    expect(await load(refusing('no_approval'))).toEqual({ kind: 'not_asked' });
    const other = await load(refusing('import_refused_not_reconciled', 'The import was not committed: the file does not reconcile.'));
    expect(other).toEqual({ kind: 'refused', whatHappened: 'The import was not committed: the file does not reconcile.' });
    expect(session().presentLoadOutcome('en', other).label).toBe('Not loaded: The import was not committed: the file does not reconcile.');
    expect(await load(ports({ commit: async () => 'lost_link' }))).toEqual({ kind: 'lost_link' });
  });

  it('no link to head office → no load, said as a lost link (never as "loaded")', async () => {
    expect(await session({ approvalInbox: async () => ({ result: 'lost_link' }) }).commit(LOAD)).toEqual({ kind: 'lost_link' });
    const { approvalInbox: _drop, ...bare } = ports();
    expect(await createDataIoSession({ userId: 'u-op' }, bare).commit(LOAD)).toEqual({ kind: 'lost_link' });
    expect(await session({ approvalInbox: async () => ({ result: 'refused', code: 'unauthenticated', whatHappened: 'Sign in again.' }) }).commit(LOAD))
      .toEqual({ kind: 'refused', whatHappened: 'Sign in again.' });
  });
});

describe('the uploader sees their own load requests and where each stands', () => {
  it('lists only import requests, newest first, each with a status in words', async () => {
    const s = session({
      approvalInbox: async () => inboxOf(
        request({ requestId: 'areq-a', subjectRef: 'JOB-A', requestedAt: '2026-10-06T04:00:00.000Z', status: 'rejected', decidedBy: 'u-owner', decisionReason: 'wrong file' }),
        request({ requestId: 'areq-b', subjectRef: 'JOB-B', requestedAt: '2026-10-07T04:00:00.000Z', status: 'approved', decidedBy: 'u-owner', expiresAt: '2026-10-08T04:00:00.000Z' }),
        request({ requestId: 'areq-c', kind: 'supplier_bank_change', subjectRef: 'SUP-1' }),
      ),
    });
    const view = await s.importRequests('en');
    expect(view.state).toBe('read');
    expect(view.rows.map((r) => r.requestId)).toEqual(['areq-b', 'areq-a']);
    expect(view.rows[0]!.status.label).toBe('Approved by u-owner — use it before 08-10-2026 09:30');
    expect(view.rows[1]!.status.label).toBe('Rejected by u-owner: wrong file');
    expect(view.rows[1]!.status.tone).toBe('error');
    for (const r of view.rows) { expect(r.status.icon.trim()).not.toBe(''); expect(r.status.label.trim()).not.toBe(''); }
  });
  it('says when it could not read, and shows nothing to a person who may not load', async () => {
    expect((await session({ approvalInbox: async () => ({ result: 'lost_link' }) }).importRequests('en')).state).toBe('lost_link');
    expect(await session({ mayCommitImport: () => false }).importRequests('en')).toEqual({ state: 'not_allowed', rows: [] });
  });
});

describe('results present as distinct, glanceable tones', () => {
  it('export / validate / ask / load outcomes each carry a tone, icon and word', () => {
    const s = session();
    expect(s.presentExportResult('en', 'exported').tone).toBe('ok');
    expect(s.presentExportResult('en', 'lost_link').tone).toBe('degraded');
    expect(s.presentExportResult('en', 'refused').tone).toBe('error');
    expect(s.presentValidateResult('en', 'refused').tone).toBe('error');
    const all = [
      s.presentExportResult('en', 'exported'), s.presentValidateResult('en', 'lost_link'),
      s.presentAskOutcome('ta', { kind: 'not_ready' }), s.presentAskOutcome('en', { kind: 'incomplete', missing: 'why' }),
      ...(['committed', 'not_asked', 'waiting', 'expired', 'used', 'file_changed', 'lost_link', 'not_allowed'] as const).map((kind) => s.presentLoadOutcome('ta', { kind })),
    ];
    for (const p of all) {
      expect(p.icon.trim()).not.toBe('');
      expect(p.label.trim()).not.toBe('');
    }
  });
});
