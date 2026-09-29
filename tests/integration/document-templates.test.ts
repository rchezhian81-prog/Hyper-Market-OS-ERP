// M01-FR-02 through the real authenticated API: a document template is versioned, never overwritten —
// drafted by one person, approved by a DIFFERENT one (§28), published; the version it replaces is marked
// superseded and KEPT, so a bill printed under it still reads as it did. A wrong GSTIN is refused before it
// can reach a bill (OC-15). Survives a cold restart. Setup permissions only; a cashier sees none of it.
import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';
const OWNER = 'u-owner'; const PADMIN = 'u-padmin'; const CASH = 'u-cash';
const BASE = '/v1/org/document-templates';
const post = (h: ApiHarness, path: string, u: string, key: string, body?: unknown) =>
  h.request({ method: 'POST', path, userId: u, tenantId: A, idempotencyKey: key, ...(body === undefined ? {} : { body }) });
const get = (h: ApiHarness, path: string, u: string) => h.request({ method: 'GET', path, userId: u, tenantId: A });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const RECEIPT = {
  header: ['SRE Hyper Market', '12 Bazaar Street, Tirunelveli 627001', 'GSTIN: 33ABCDE1234F1Z5', 'Ph: 0462 200 1000'],
  footer: ['Thank you — please visit again', 'Returns within 7 days with this bill'],
  language: 'en_ta', paperFormat: 'thermal-80',
};
interface KindView { kind: string; current: { version: number; content: { footer: string[] } } | null; versions: { version: number; state: string; content: { footer: string[] }; supersededBy?: number }[] }

async function cast(store = new InMemoryEventStore()): Promise<ApiHarness> {
  const h = apiHarness({ store });
  await h.seedOwner(A, OWNER);
  await h.provisionRole(A, PADMIN, 'platform_admin');
  await h.provisionRole(A, CASH, 'cashier');
  return h;
}

describe('versioned document templates (M01-FR-02, API-01)', () => {
  it('draft → a second person approves → publish; the maker cannot approve their own draft; a retry saves nothing twice', async () => {
    const h = await cast();
    const d = await post(h, `${BASE}/receipt/versions`, OWNER, 'dt-1', { content: RECEIPT, note: 'first bill layout' });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ kind: 'receipt', version: 1, state: 'draft', authoredBy: OWNER, note: 'first bill layout' });
    // Same key, same request → the stored first answer, and still one version.
    const again = await post(h, `${BASE}/receipt/versions`, OWNER, 'dt-1', { content: RECEIPT, note: 'first bill layout' });
    expect(again.status).toBe(201);
    expect((await get(h, `${BASE}/receipt`, OWNER)).body).toMatchObject({ current: null, versions: [{ version: 1, state: 'draft' }] });

    const own = await post(h, `${BASE}/receipt/versions/1/approve`, OWNER, 'dt-2');
    expect(own.status).toBe(403);
    expect(codeOf(own)).toBe('maker_cannot_approve');
    const early = await post(h, `${BASE}/receipt/versions/1/publish`, PADMIN, 'dt-3');
    expect(early.status).toBe(409);
    expect(codeOf(early)).toBe('not_approved');

    const approved = await post(h, `${BASE}/receipt/versions/1/approve`, PADMIN, 'dt-4');
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ version: 1, state: 'approved', approvedBy: PADMIN });
    const published = await post(h, `${BASE}/receipt/versions/1/publish`, OWNER, 'dt-5');
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ version: 1, state: 'published', publishedBy: OWNER });
    expect((published.body as { supersededVersion?: number }).supersededVersion).toBeUndefined();

    const view = (await get(h, `${BASE}/receipt`, OWNER)).body as KindView;
    expect(view.current?.version).toBe(1);
    expect(view.versions.map((v) => [v.version, v.state])).toEqual([[1, 'published']]);
  });

  it('a second version supersedes the first, which is KEPT with its layout; the register lists every kind; it survives a cold restart', async () => {
    const store = new InMemoryEventStore();
    const h = await cast(store);
    await post(h, `${BASE}/receipt/versions`, OWNER, 'dt-1', { content: RECEIPT });
    await post(h, `${BASE}/receipt/versions/1/approve`, PADMIN, 'dt-2');
    await post(h, `${BASE}/receipt/versions/1/publish`, PADMIN, 'dt-3');
    // The platform admin drafts the change this time; the owner is the second person.
    const d2 = await post(h, `${BASE}/receipt/versions`, PADMIN, 'dt-4', { content: { ...RECEIPT, footer: [...RECEIPT.footer, 'Helpline 1800 000 000'] } });
    expect(d2.body).toMatchObject({ version: 2, state: 'draft', authoredBy: PADMIN });
    expect(codeOf(await post(h, `${BASE}/receipt/versions/2/approve`, PADMIN, 'dt-5'))).toBe('maker_cannot_approve');
    await post(h, `${BASE}/receipt/versions/2/approve`, OWNER, 'dt-6');
    const p2 = await post(h, `${BASE}/receipt/versions/2/publish`, OWNER, 'dt-7');
    expect(p2.status).toBe(200);
    expect(p2.body).toMatchObject({ version: 2, state: 'published', supersededVersion: 1 });
    expect(codeOf(await post(h, `${BASE}/receipt/versions/2/publish`, OWNER, 'dt-8'))).toBe('already_published');

    const view = (await get(h, `${BASE}/receipt`, OWNER)).body as KindView;
    expect(view.current?.version).toBe(2);
    expect(view.current?.content.footer).toHaveLength(3);
    expect(view.versions.map((v) => [v.version, v.state])).toEqual([[1, 'superseded'], [2, 'published']]);
    expect(view.versions[0]).toMatchObject({ supersededBy: 2 });
    expect(view.versions[0]!.content.footer).toEqual(RECEIPT.footer); // v1 reads exactly as it was printed

    const all = (await get(h, BASE, OWNER)).body as { kinds: { kind: string; current: { version: number } | null; versions: number }[] };
    expect(all.kinds.map((k) => k.kind)).toEqual(['receipt', 'invoice', 'purchase_order', 'grn', 'statement']);
    expect(all.kinds[0]).toMatchObject({ kind: 'receipt', current: { version: 2 }, versions: 2 });
    expect(all.kinds[1]).toMatchObject({ kind: 'invoice', current: null, versions: 0 });

    // Cold restart: a fresh API over the same durable store folds the same standing state.
    const h2 = apiHarness({ store });
    const after = (await get(h2, `${BASE}/receipt`, OWNER)).body as KindView;
    expect(after.current?.version).toBe(2);
    expect(after.versions.map((v) => [v.version, v.state])).toEqual([[1, 'superseded'], [2, 'published']]);
  });

  it('refuses what would be a tax error or a broken bill before it is saved: a malformed GSTIN, no store name, a wrong kind, a bad version', async () => {
    const h = await cast();
    const gstin = await post(h, `${BASE}/invoice/versions`, OWNER, 'dt-1', { content: { header: ['SRE Hyper Market', 'GSTIN: 33ABCDE1234'], footer: [], terms: ['Payment due in 15 days'], language: 'en' } });
    expect(gstin.status).toBe(400);
    expect(codeOf(gstin)).toBe('template_content_invalid');
    expect((gstin.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/GSTIN that is not 15 characters/);
    const nameless = await post(h, `${BASE}/statement/versions`, OWNER, 'dt-2', { content: { header: [''], footer: ['Page 1'], language: 'ta' } });
    expect(codeOf(nameless)).toBe('template_content_invalid');
    expect(codeOf(await post(h, `${BASE}/poster/versions`, OWNER, 'dt-3', { content: RECEIPT }))).toBe('unknown_document_kind');
    expect(codeOf(await post(h, `${BASE}/grn/versions/abc/approve`, OWNER, 'dt-4'))).toBe('bad_template_version');
    expect((await post(h, `${BASE}/grn/versions/1/approve`, OWNER, 'dt-5')).status).toBe(404);
    const all = (await get(h, BASE, OWNER)).body as { kinds: { versions: number }[] };
    expect(all.kinds.every((k) => k.versions === 0)).toBe(true); // nothing was saved
  });

  it('is a setup surface: a cashier can neither read nor draft a template', async () => {
    const h = await cast();
    expect((await get(h, BASE, CASH)).status).toBe(403);
    expect((await get(h, `${BASE}/receipt`, CASH)).status).toBe(403);
    expect((await post(h, `${BASE}/receipt/versions`, CASH, 'dt-1', { content: RECEIPT })).status).toBe(403);
    expect((await post(h, `${BASE}/receipt/versions/1/approve`, CASH, 'dt-2')).status).toBe(403);
  });
});
