// M01-FR-02 — versioned document templates: what a template may say, how a version moves (draft → approved
// by a second person → published, the previous one superseded and kept), and the routes over stub deps.
import { describe, it, expect } from 'vitest';
import {
  validateTemplateContent, draftTemplate, approveTemplate, publishTemplate, latestTemplateVersions, currentTemplate,
  DOCUMENT_KINDS, TEMPLATE_LIMITS, type DocumentTemplateVersion, type DocumentTemplateContent,
} from '../../packages/org/src/index';
import { documentTemplateRoutes, type DocumentTemplateDeps } from '../../services/platform/src/document-templates';
import type { RequestContext, Route } from '../../services/kernel/src/index';

const T = 't-sre';
let NOW = '2026-09-29T10:00:00.000Z';
const CONTENT: DocumentTemplateContent = {
  header: ['SRE Hyper Market', '12 Bazaar Street, Tirunelveli', 'GSTIN: 33ABCDE1234F1Z5', 'Ph: 0462 200 1000'],
  footer: ['Thank you — please visit again', 'Returns within 7 days with this bill'],
  language: 'en_ta', paperFormat: 'thermal-80',
};

describe('validateTemplateContent — every problem at once', () => {
  it('accepts a proper receipt template', () => {
    expect(validateTemplateContent('receipt', CONTENT)).toEqual([]);
    expect(validateTemplateContent('invoice', { header: ['SRE Hyper Market'], footer: [], terms: ['Payment due in 15 days'], language: 'en' })).toEqual([]);
  });
  it('names a missing store name, a wrong GSTIN, too many or too long lines, a bad language and a misplaced paper format', () => {
    const problems = validateTemplateContent('receipt', {
      header: ['', 'GSTIN: 33ABC'], footer: Array.from({ length: 7 }, () => 'x'.repeat(70)), language: 'fr', paperFormat: 'a4',
    });
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining('first header line must name the store'),
      expect.stringContaining('GSTIN that is not 15 characters'),
      expect.stringContaining(`footer has 7 lines; at most ${TEMPLATE_LIMITS.footerLines} fit`),
      expect.stringContaining(`footer line 1 is 70 characters; at most ${TEMPLATE_LIMITS.lineChars}`),
      expect.stringContaining('language must be one of'),
      expect.stringContaining('paperFormat must be'),
    ]));
    expect(validateTemplateContent('invoice', { ...CONTENT })).toEqual(['paperFormat applies to receipts only']);
    expect(validateTemplateContent('receipt', null)).toEqual(['the template content must be an object with header, footer and language']);
    expect(validateTemplateContent('receipt', { footer: [], language: 'en' })).toContain('header is required');
  });
});

describe('the version lifecycle — drafted by one, approved by another, published, superseded but kept', () => {
  const at = (h: number) => `2026-09-29T${String(h).padStart(2, '0')}:00:00.000Z`;
  const drafted = draftTemplate({ versions: [], kind: 'receipt', content: CONTENT, note: 'first bill', by: 'u-admin', at: at(9) });
  const v1 = (drafted as { ok: true; records: DocumentTemplateVersion[] }).records;

  it('a draft is version 1, by its author, with its content copied — nothing in force yet', () => {
    expect(drafted.ok).toBe(true);
    expect(v1[0]).toMatchObject({ kind: 'receipt', version: 1, state: 'draft', authoredBy: 'u-admin', authoredAt: at(9), note: 'first bill' });
    expect(v1[0]!.content).toEqual(CONTENT);
    expect(currentTemplate(latestTemplateVersions(v1), 'receipt')).toBeUndefined();
    expect(draftTemplate({ versions: [], kind: 'receipt', content: { header: [''], footer: [], language: 'en' }, by: 'u', at: at(9) })).toMatchObject({ ok: false, refusal: 'content_invalid' });
  });

  it('the maker cannot approve their own draft (§28); a second person can; only a draft is approved', () => {
    expect(approveTemplate({ versions: v1, kind: 'receipt', version: 1, by: 'u-admin', at: at(10) })).toMatchObject({ ok: false, refusal: 'maker_cannot_approve' });
    expect(approveTemplate({ versions: v1, kind: 'receipt', version: 9, by: 'u-owner', at: at(10) })).toMatchObject({ ok: false, refusal: 'unknown_version' });
    const approved = approveTemplate({ versions: v1, kind: 'receipt', version: 1, by: 'u-owner', at: at(10) }) as { ok: true; records: DocumentTemplateVersion[] };
    expect(approved.records[0]).toMatchObject({ version: 1, state: 'approved', approvedBy: 'u-owner', approvedAt: at(10) });
    const all = latestTemplateVersions([...v1, ...approved.records]);
    expect(all.map((v) => v.state)).toEqual(['approved']); // the furthest state wins the fold
    expect(approveTemplate({ versions: all, kind: 'receipt', version: 1, by: 'u-owner', at: at(11) })).toMatchObject({ ok: false, refusal: 'not_a_draft' });
  });

  it('only an approved version publishes; a second published version supersedes the first, which is kept', () => {
    expect(publishTemplate({ versions: v1, kind: 'receipt', version: 1, by: 'u-owner', at: at(11) })).toMatchObject({ ok: false, refusal: 'not_approved' });
    const approved = approveTemplate({ versions: v1, kind: 'receipt', version: 1, by: 'u-owner', at: at(10) }) as { ok: true; records: DocumentTemplateVersion[] };
    let all = latestTemplateVersions([...v1, ...approved.records]);
    const published = publishTemplate({ versions: all, kind: 'receipt', version: 1, by: 'u-owner', at: at(11) }) as { ok: true; records: DocumentTemplateVersion[] };
    expect(published.records).toHaveLength(1);
    expect(published.records[0]).toMatchObject({ version: 1, state: 'published', publishedBy: 'u-owner', publishedAt: at(11) });
    all = latestTemplateVersions([...all, ...published.records]);
    expect(currentTemplate(all, 'receipt')?.version).toBe(1);
    expect(publishTemplate({ versions: all, kind: 'receipt', version: 1, by: 'u-owner', at: at(12) })).toMatchObject({ ok: false, refusal: 'already_published' });
    // A second version: new footer line. Drafted, approved by someone else, published → v1 superseded, still on the record.
    const d2 = draftTemplate({ versions: all, kind: 'receipt', content: { ...CONTENT, footer: [...CONTENT.footer, 'Helpline 1800 000 000'] }, by: 'u-admin', at: at(13) }) as { ok: true; records: DocumentTemplateVersion[] };
    expect(d2.records[0]!.version).toBe(2);
    all = latestTemplateVersions([...all, ...d2.records]);
    const a2 = approveTemplate({ versions: all, kind: 'receipt', version: 2, by: 'u-owner', at: at(14) }) as { ok: true; records: DocumentTemplateVersion[] };
    all = latestTemplateVersions([...all, ...a2.records]);
    const p2 = publishTemplate({ versions: all, kind: 'receipt', version: 2, by: 'u-owner', at: at(15) }) as { ok: true; records: DocumentTemplateVersion[] };
    expect(p2.records.map((r) => [r.version, r.state])).toEqual([[2, 'published'], [1, 'superseded']]);
    expect(p2.records[1]).toMatchObject({ supersededBy: 2, supersededAt: at(15) });
    all = latestTemplateVersions([...all, ...p2.records]);
    expect(currentTemplate(all, 'receipt')?.version).toBe(2);
    expect(all.map((v) => [v.version, v.state])).toEqual([[1, 'superseded'], [2, 'published']]);
    expect(all[0]!.content).toEqual(CONTENT); // v1's layout is exactly what it was
  });
});

describe('the routes (API-01)', () => {
  function stub() {
    const records: DocumentTemplateVersion[] = [];
    const deps: DocumentTemplateDeps = { now: () => NOW, versions: () => records, record: (_t, v) => { records.push(v); } };
    return { records, routes: documentTemplateRoutes(deps) };
  }
  const ctx = (over: Partial<RequestContext> = {}): RequestContext =>
    ({ tenantId: T, userId: 'u-admin', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over });
  const routeFor = (routes: readonly Route[], method: string, path: string): Route => {
    const r = routes.find((x) => x.method === method && x.path === path);
    if (r === undefined) throw new Error(`no route ${method} ${path}`);
    return r;
  };
  const BASE = '/v1/org/document-templates';
  interface Thrown { status: number; body: { code: string; whatHappened: string } }
  const thrown = async (fn: () => unknown): Promise<Thrown> => {
    try { await fn(); } catch (e) { return e as Thrown; }
    throw new Error('expected a refusal');
  };
  const draft = (routes: readonly Route[], kind: string, content: unknown, userId = 'u-admin') =>
    routeFor(routes, 'POST', `${BASE}/:kind/versions`).handler(ctx({ userId, params: { kind }, body: { content } }));
  const act = (routes: readonly Route[], op: 'approve' | 'publish', kind: string, version: string, userId: string) =>
    routeFor(routes, 'POST', `${BASE}/:kind/versions/:version/${op}`).handler(ctx({ userId, params: { kind, version } }));

  it('five routes: read all kinds, read one, draft, approve, publish — setup permissions, writes idempotent', () => {
    const { routes } = stub();
    expect(routes.map((r) => [r.method, r.path, r.permission, r.idempotent === true])).toEqual([
      ['GET', BASE, 'platform.setup.read', false],
      ['GET', `${BASE}/:kind`, 'platform.setup.read', false],
      ['POST', `${BASE}/:kind/versions`, 'platform.setup.write', true],
      ['POST', `${BASE}/:kind/versions/:version/approve`, 'platform.setup.write', true],
      ['POST', `${BASE}/:kind/versions/:version/publish`, 'platform.setup.write', true],
    ]);
  });

  it('drafts, refuses the maker\'s own approval, approves by a second person, publishes, supersedes, and reads back every state', async () => {
    const s = stub();
    const d = await draft(s.routes, 'receipt', CONTENT);
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ kind: 'receipt', version: 1, state: 'draft', authoredBy: 'u-admin' });
    const own = await thrown(() => act(s.routes, 'approve', 'receipt', '1', 'u-admin'));
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('maker_cannot_approve');
    expect((await act(s.routes, 'approve', 'receipt', '1', 'u-owner')).body).toMatchObject({ state: 'approved', approvedBy: 'u-owner' });
    expect((await thrown(() => act(s.routes, 'publish', 'receipt', '2', 'u-owner'))).status).toBe(404);
    expect((await act(s.routes, 'publish', 'receipt', '1', 'u-owner')).body).toMatchObject({ state: 'published', publishedBy: 'u-owner' });
    NOW = '2026-09-29T12:00:00.000Z';
    await draft(s.routes, 'receipt', { ...CONTENT, footer: ['Nandri!'] });
    await act(s.routes, 'approve', 'receipt', '2', 'u-owner');
    const p2 = await act(s.routes, 'publish', 'receipt', '2', 'u-owner');
    expect(p2.body).toMatchObject({ version: 2, state: 'published', supersededVersion: 1 });
    const one = (await routeFor(s.routes, 'GET', `${BASE}/:kind`).handler(ctx({ params: { kind: 'receipt' } }))).body as { current: { version: number }; versions: { version: number; state: string; content: DocumentTemplateContent }[] };
    expect(one.current.version).toBe(2);
    expect(one.versions.map((v) => [v.version, v.state])).toEqual([[1, 'superseded'], [2, 'published']]);
    expect(one.versions[0]!.content.footer).toEqual(CONTENT.footer); // the old layout stays readable
    const all = (await routeFor(s.routes, 'GET', BASE).handler(ctx())).body as { kinds: { kind: string; current: { version: number } | null; versions: number }[] };
    expect(all.kinds.map((k) => k.kind)).toEqual([...DOCUMENT_KINDS]);
    expect(all.kinds.find((k) => k.kind === 'receipt')).toMatchObject({ current: { version: 2 }, versions: 2 });
    expect(all.kinds.find((k) => k.kind === 'invoice')).toMatchObject({ current: null, versions: 0 });
    expect(s.records).toHaveLength(7); // draft, approved, published, draft, approved, published, superseded — appended, never rewritten
  });

  it('refuses an unknown kind, a bad version, invalid content and an out-of-order move', async () => {
    const s = stub();
    expect((await thrown(() => draft(s.routes, 'poster', CONTENT))).body.code).toBe('unknown_document_kind');
    const bad = await thrown(() => draft(s.routes, 'receipt', { header: [''], footer: [], language: 'en' }));
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('template_content_invalid');
    expect(bad.body.whatHappened).toMatch(/first header line must name the store/);
    await draft(s.routes, 'grn', { header: ['SRE Hyper Market — goods received'], footer: ['Checked by'], language: 'en' });
    expect((await thrown(() => act(s.routes, 'approve', 'grn', 'one', 'u-owner'))).body.code).toBe('bad_template_version');
    expect((await thrown(() => act(s.routes, 'publish', 'grn', '1', 'u-owner'))).body.code).toBe('not_approved');
    expect(s.records).toHaveLength(1);
  });
});
