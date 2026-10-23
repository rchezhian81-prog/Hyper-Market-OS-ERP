import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startRealCloud, type RealCloud } from '../support/real-store';

/**
 * **M01 on real PostgreSQL, through the production API assembly (EA-10's M01 proof gap: "the org/config/branch FRs
 * proven on PostgreSQL").** The in-memory suites (org-structure, setup-surface, document-templates) prove the rules;
 * this runs the same acts on the production assembly — the durable settings table, the SQL ledger, row-level security
 * as the application role — and then RESTARTS the API over the same database and reads every one of them back:
 *
 *   • M01-FR-01 org hierarchy: company → GST registration (checksum-checked, a duplicate refused) → branch → warehouse;
 *     a branch with no GST registration is a draft that cannot activate; a complete one activates; ancestry, descendants
 *     and the GSTIN a transaction is filed under read back; a structural violation is refused; a cashier cannot build it.
 *   • M01-FR-02/03 configuration: a setup answer saved with its version, a stale version refused (409), an unknown key
 *     404, a cashier refused; the answer and its version survive the restart.
 *   • M01-FR-02 document templates: drafted by the owner, the maker refused as approver (§28), approved by a second
 *     person with setup authority, published; the first version is superseded and KEPT when the second is published.
 *
 * Needs DATABASE_URL; without it the suite SKIPS.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner'; const PADMIN = 'u-owner-2'; const CASH = 'u-cash'; // PADMIN: a second person with setup authority
const G1 = '33AABCS1429B1Z1'; const BAD = '33AABCS1429B1ZZ';
const KEY = ['m01', 'org', 'pack', 'key'].join('-').padEnd(48, '0');
const RECEIPT = (footer: string) => ({
  header: ['SRE Hyper Market', '12 Bazaar Street, Tirunelveli 627001', 'GSTIN: 33ABCDE1234F1Z5', 'Ph: 0462 200 1000'],
  footer: [footer], language: 'en_ta', paperFormat: 'thermal-80',
});
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;

describe.skipIf(!DATABASE_URL)('M01 — org hierarchy, configuration and document templates on real PostgreSQL, kept across a restart', () => {
  const tenantId = randomUUID();
  let cloud: RealCloud;
  const start = () => startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: OWNER, packSigningKey: KEY });
  const post = (who: string, path: string, body: unknown, key = `k-${randomUUID()}`) => cloud.request({ method: 'POST', path, userId: who, body, idempotencyKey: key });
  const put = (who: string, path: string, body: unknown, key = `k-${randomUUID()}`) => cloud.request({ method: 'PUT', path, userId: who, body, idempotencyKey: key });
  const get = (who: string, path: string) => cloud.request({ method: 'GET', path, userId: who });

  beforeAll(async () => {
    cloud = await start();
    await cloud.grant(PADMIN, 'owner');
    await cloud.grant(CASH, 'cashier');
  }, 120_000);
  afterAll(async () => { await cloud?.stop(); });

  it('builds and activates the hierarchy, saves configuration and publishes a template — every refusal by name', async () => {
    // M01-FR-01
    expect((await post(CASH, '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' })).status).toBe(403);
    expect((await post(OWNER, '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }, 'n-c1')).status).toBe(201);
    expect(codeOf(await post(OWNER, `/v1/org/gst-registrations/${BAD}`, { companyId: 'C1', legalName: 'SRE Retail Pvt Ltd' }))).toBe('gstin_invalid');
    expect((await post(OWNER, `/v1/org/gst-registrations/${G1}`, { companyId: 'C1', legalName: 'SRE Retail Pvt Ltd' }, 'g-1')).status).toBe(201);
    expect(codeOf(await post(OWNER, `/v1/org/gst-registrations/${G1}`, { companyId: 'C1', legalName: 'Someone Else' }))).toBe('gstin_already_registered');
    const draft = (await post(OWNER, '/v1/org/nodes/B2', { kind: 'branch', name: 'Second store', parentId: 'C1', companyId: 'C1' }, 'n-b2')).body as { node: { status: string }; canActivate: boolean };
    expect(draft).toMatchObject({ node: { status: 'draft' }, canActivate: false });
    expect(codeOf(await post(OWNER, '/v1/org/nodes/B2/activation', {}))).toBe('cannot_activate');
    expect((await post(OWNER, '/v1/org/nodes/B1', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1', gstin: G1 }, 'n-b1')).status).toBe(201);
    expect((await post(OWNER, '/v1/org/nodes/W1', { kind: 'warehouse', name: 'Back store', parentId: 'B1', companyId: 'C1' }, 'n-w1')).status).toBeLessThan(300);
    // OB-288 P1 (M01-FR-01 "structural changes are owner-approved"): activation waits for another owner's approval.
    expect(codeOf(await post(OWNER, '/v1/org/nodes/B1/activation', {}))).toBe('structural_change_needs_owner_approval');
    const ask = (await post(OWNER, '/v1/approvals/requests', { kind: 'org_structure_change', subjectRef: 'B1', details: { nodeId: 'B1', action: 'activate' }, summary: 'open the main store', reason: 'ready to trade' })).body as { requestId: string };
    expect(codeOf(await post(OWNER, `/v1/approvals/requests/${ask.requestId}/decide`, { decision: 'approved', reason: 'mine' }))).toBe('self_approval');
    expect((await post(PADMIN, `/v1/approvals/requests/${ask.requestId}/decide`, { decision: 'approved', reason: 'checked GST and address' })).status).toBe(201);
    expect((await post(OWNER, '/v1/org/nodes/B1/activation', { approvalId: ask.requestId }, 'act-b1')).status).toBe(200);
    expect(codeOf(await post(OWNER, '/v1/org/nodes/D1', { kind: 'department', name: 'Grocery', parentId: 'C1' }))).toBe('hierarchy_violation');

    // M01-FR-02/03 configuration
    const setup = (await get(OWNER, '/v1/platform/setup')).body as { items: { key: string; version: number }[] };
    const tax = setup.items.find((i) => i.key === 'tax.default_bps')!;
    expect((await put(OWNER, '/v1/platform/setup/tax.default_bps', { value: 1800, ifVersion: tax.version }, 'set-tax')).status).toBe(200);
    expect((await put(OWNER, '/v1/platform/setup/tax.default_bps', { value: 1200, ifVersion: tax.version })).status).toBe(409);
    expect((await put(OWNER, '/v1/platform/setup/no.such.key', { value: 1, ifVersion: 0 })).status).toBe(404);
    expect((await put(CASH, '/v1/platform/setup/tax.default_bps', { value: 500, ifVersion: tax.version + 1 })).status).toBe(403);

    // M01-FR-02 document templates — two people, versions kept
    const base = '/v1/org/document-templates/receipt/versions';
    expect((await post(OWNER, base, { content: RECEIPT('Thank you'), note: 'first' }, 't-1')).status).toBe(201);
    expect(codeOf(await post(OWNER, `${base}/1/approve`, {}))).toBe('maker_cannot_approve');
    expect((await post(PADMIN, `${base}/1/approve`, {}, 't-1a')).status).toBeLessThan(300);
    expect((await post(PADMIN, `${base}/1/publish`, {}, 't-1p')).status).toBeLessThan(300);
    expect((await post(OWNER, base, { content: RECEIPT('Thank you — visit again'), note: 'second' }, 't-2')).status).toBe(201);
    expect((await post(PADMIN, `${base}/2/approve`, {}, 't-2a')).status).toBeLessThan(300);
    expect((await post(PADMIN, `${base}/2/publish`, {}, 't-2p')).status).toBeLessThan(300);
  }, 120_000);

  it('after a RESTART over the same database, every one of them reads back exactly', async () => {
    await cloud.stop();
    cloud = await start();
    const b1 = (await get(OWNER, '/v1/org/nodes/B1')).body as { node: { status: string }; ancestry: string[]; descendants: string[]; filedUnderGstin: string | null };
    expect(b1).toMatchObject({ node: { status: 'active' }, ancestry: ['B1', 'C1'], filedUnderGstin: G1 });
    expect(b1.descendants).toContain('W1');
    expect(((await get(OWNER, '/v1/org/nodes/B2')).body as { node: { status: string } }).node.status).toBe('draft');
    const tax = ((await get(OWNER, '/v1/platform/setup')).body as { items: { key: string; value: unknown; version: number; isDefault: boolean }[] }).items.find((i) => i.key === 'tax.default_bps');
    expect(tax).toMatchObject({ value: 1800, isDefault: false });
    const kind = (await get(OWNER, '/v1/org/document-templates/receipt')).body as { current: { version: number }; versions: { version: number; state: string; content: { footer: string[] } }[] };
    expect(kind.current.version).toBe(2);
    expect(kind.versions.map((v) => [v.version, v.state])).toEqual([[1, 'superseded'], [2, 'published']]);
    expect(kind.versions[0]!.content.footer).toEqual(['Thank you']); // the first version is KEPT as it was
    expect((await get(CASH, '/v1/org/document-templates/receipt')).status).toBe(403);
  }, 120_000);
});
