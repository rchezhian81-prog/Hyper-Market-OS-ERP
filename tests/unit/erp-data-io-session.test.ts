import { describe, it, expect } from 'vitest';
import {
  DATA_IO_COPY, COPY_KEYS, createDataIoSession,
  type DataIoPorts, type ExportDomainView, type ExportAuditView, type ImportTemplateView,
  type ValidateResult, type ExportResult, type CommitResult, type ImportPreviewView,
} from '../../apps/web-erp/src/data-io-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The data import & export console (M30-FR-01/02/03 · §28). EXPORT lists domains (which columns are
// sensitive), runs an audited export, and shows the log. IMPORT validates a pasted file to a preview, then
// commits the whole job under §28 — the uploader may never approve their own. The screen refuses the cheap
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

const ports = (over: Partial<DataIoPorts> = {}): DataIoPorts => ({
  exportDomains: () => DOMAINS,
  recentExports: () => RECENT,
  importTemplates: () => TEMPLATES,
  mayExport: () => true,
  mayImport: () => true,
  mayCommitImport: () => true,
  runExport: async () => 'exported',
  validate: async () => PREVIEW,
  commit: async () => 'committed',
  ...over,
});
const session = (over: Partial<DataIoPorts> = {}, userId: string | null = 'u-op') =>
  createDataIoSession({ userId }, ports(over));

describe('the import/export copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(DATA_IO_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });
  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...DATA_IO_COPY.en }, ta: { ...DATA_IO_COPY.ta, exportBtn: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('exportBtn');
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
  it('reflects a checker who may validate but not commit, and nobody-named', () => {
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

describe('validating an import refuses locally, else previews', () => {
  it('refuses without import permission, an unknown template, or empty text — no POST', async () => {
    let ran = 0;
    const spy = (): DataIoPorts => ports({ validate: async () => { ran += 1; return PREVIEW; } });
    expect(await createDataIoSession({ userId: 'u-op' }, { ...spy(), mayImport: () => false }).validate('products-basic', 'a,b')).toBe('refused');
    expect(await createDataIoSession({ userId: 'u-op' }, spy()).validate('not-a-template', 'a,b')).toBe('refused');
    expect(await createDataIoSession({ userId: 'u-op' }, spy()).validate('products-basic', '   ')).toBe('refused');
    expect(ran).toBe(0);
  });
  it('a valid request reaches the port with the declared total and returns the preview', async () => {
    const seen: unknown[] = [];
    const s = session({ validate: async (req) => { seen.push(req); return PREVIEW; } });
    const r = await s.validate('opening-cash', 'a,b\\n1,2', 5000);
    expect((r as ImportPreviewView).commitReady).toBe(true);
    expect(seen[0]).toMatchObject({ templateId: 'opening-cash', declaredTotalMinor: 5000 });
    expect(await session({ validate: async () => 'lost_link' as ValidateResult }).validate('products-basic', 'a,b')).toBe('lost_link');
  });
});

describe('committing an import enforces §28 locally before any POST', () => {
  it('refuses without commit permission, a job name, an approver, or a self-approval', async () => {
    let ran = 0;
    const spy = (userId: string | null = 'u-op') => createDataIoSession({ userId }, ports({ commit: async () => { ran += 1; return 'committed'; } }));
    const base = { templateId: 'products-basic', text: 'a,b\\n1,2', jobId: 'JOB-1', approver: 'u-owner' as string };
    expect(await createDataIoSession({ userId: 'u-op' }, { ...ports({ commit: async () => { ran += 1; return 'committed'; } }), mayCommitImport: () => false }).commit(base)).toBe('refused');
    expect(await spy().commit({ ...base, jobId: '  ' })).toBe('refused');
    expect(await spy().commit({ ...base, approver: '' })).toBe('refused');
    // §28: the approver is the uploader (the person at the screen).
    expect(await spy().commit({ ...base, approver: 'u-op' })).toBe('refused');
    // Unknown template.
    expect(await spy().commit({ ...base, templateId: 'nope' })).toBe('refused');
    expect(ran).toBe(0);
  });
  it('a clean commit with a separate approver reaches the port and passes the result through', async () => {
    const seen: unknown[] = [];
    const s = session({ commit: async (req) => { seen.push(req); return 'committed'; } });
    expect(await s.commit({ templateId: 'products-basic', text: 'a,b\\n1,2', jobId: ' JOB-1 ', approver: ' u-owner ' })).toBe('committed');
    expect(seen[0]).toMatchObject({ jobId: 'JOB-1', approver: 'u-owner' }); // trimmed
    expect(await session({ commit: async () => 'refused' as CommitResult }).commit({ templateId: 'products-basic', text: 'a,b', jobId: 'J', approver: 'u-owner' })).toBe('refused');
  });
});

describe('results present as distinct, glanceable tones', () => {
  it('export / validate / commit outcomes each carry a tone, icon and word', () => {
    const s = session();
    expect(s.presentExportResult('en', 'exported').tone).toBe('ok');
    expect(s.presentExportResult('en', 'lost_link').tone).toBe('degraded');
    expect(s.presentExportResult('en', 'refused').tone).toBe('error');
    expect(s.presentCommitResult('en', 'committed').tone).toBe('ok');
    expect(s.presentValidateResult('en', 'refused').tone).toBe('error');
    for (const p of [s.presentExportResult('en', 'exported'), s.presentCommitResult('en', 'refused'), s.presentValidateResult('en', 'lost_link')]) {
      expect(p.icon.trim()).not.toBe('');
      expect(p.label.trim()).not.toBe('');
    }
  });
});
