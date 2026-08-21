import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M01-FR-01 org hierarchy on the live API — the skeleton every transaction, permission and report is
// scoped to. A GSTIN is checksum-valid and unique; the parent/kind rules hold; an incomplete node is a
// DRAFT that reports what stops it activating; a branch cannot activate without a company and a valid,
// own GST registration. Managing gated platform.setup.write; reading gated org.branch.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const G1 = '33AABCS1429B1Z1'; // a valid Tamil Nadu GSTIN
const G2 = '33AAACT2727Q1Z3'; // another valid one
const BAD = '33AABCS1429B1ZZ'; // valid shape, wrong check character

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const putNode = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/org/nodes/${id}`, userId: u, tenantId: A, idempotencyKey: key, body });
const registerGst = (h: ApiHarness, u: string, gstin: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/org/gst-registrations/${gstin}`, userId: u, tenantId: A, idempotencyKey: key, body });
const activate = (h: ApiHarness, u: string, id: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/org/nodes/${id}/activation`, userId: u, tenantId: A, idempotencyKey: key, body: {} });
const getNode = (h: ApiHarness, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/org/nodes/${id}`, userId: u, tenantId: A });
const listNodes = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/org/nodes', userId: u, tenantId: A });

type View = { node: { status: string }; canActivate: boolean; ancestry: string[]; descendants: string[]; filedUnderGstin: string | null; issues: { message: string }[] };

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');            // platform.setup.write + org.branch.read
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // org.branch.read, NOT platform.setup.write
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('org hierarchy: company → GST → branch, validated as a whole (M01-FR-01)', () => {
  it('builds a company, registers GST, and activates a branch under it', async () => {
    const h = await cast();
    expect((await putNode(h, 'u-owner', 'C1', { kind: 'company', name: 'SRE Retail' }, 'k1')).status).toBe(201);
    expect((await registerGst(h, 'u-owner', G1, { companyId: 'C1', legalName: 'SRE Retail Pvt Ltd' }, 'k2')).status).toBe(201);
    // A complete branch is activatable straight away.
    const b = (await putNode(h, 'u-owner', 'B1', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1', gstin: G1 }, 'k3')).body as View;
    expect(b.canActivate).toBe(true);
    expect((await activate(h, 'u-owner', 'B1', 'k4')).status).toBe(200);
    // Its scope reads back: filed under G1, ancestry up to the company.
    const view = (await getNode(h, 'u-owner', 'B1')).body as View;
    expect(view.node.status).toBe('active');
    expect(view.ancestry).toEqual(['B1', 'C1']);
    expect(view.filedUnderGstin).toBe(G1);
    expect(((await getNode(h, 'u-owner', 'C1')).body as View).descendants).toEqual(['B1']);
  });

  it('records an incomplete branch as a draft and refuses to activate it', async () => {
    const h = await cast();
    await putNode(h, 'u-owner', 'C1', { kind: 'company', name: 'SRE Retail' }, 'k1');
    // No GST registration → a draft, activation blocked.
    const b = (await putNode(h, 'u-owner', 'B1', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1' }, 'k2')).body as View;
    expect(b.node.status).toBe('draft');
    expect(b.canActivate).toBe(false);
    expect(b.issues.some((i) => i.message.includes('GST registration'))).toBe(true);
    expect(codeOf(await activate(h, 'u-owner', 'B1', 'k3'))).toBe('cannot_activate');
  });

  it('refuses a structural violation and a wrong-company GST attribution', async () => {
    const h = await cast();
    await putNode(h, 'u-owner', 'C1', { kind: 'company', name: 'One' }, 'k1');
    // A department cannot sit directly under a company.
    expect(codeOf(await putNode(h, 'u-owner', 'D1', { kind: 'department', name: 'Grocery', parentId: 'C1' }, 'k2'))).toBe('hierarchy_violation');
    // A company cannot have a parent.
    expect(codeOf(await putNode(h, 'u-owner', 'C2bad', { kind: 'company', name: 'Two', parentId: 'C1' }, 'k3'))).toBe('hierarchy_violation');
    // G1 is registered to C1; a branch under C2 claiming G1 is a wrong-company attribution → blocked.
    await registerGst(h, 'u-owner', G1, { companyId: 'C1', legalName: 'One Ltd' }, 'k4');
    await putNode(h, 'u-owner', 'C2', { kind: 'company', name: 'Two' }, 'k5');
    const b = (await putNode(h, 'u-owner', 'B2', { kind: 'branch', name: 'Two store', parentId: 'C2', companyId: 'C2', gstin: G1 }, 'k6')).body as View;
    expect(b.canActivate).toBe(false);
    expect(b.issues.some((i) => i.message.includes('different company'))).toBe(true);
  });

  it('checksum-validates a GSTIN and refuses a duplicate', async () => {
    const h = await cast();
    await putNode(h, 'u-owner', 'C1', { kind: 'company', name: 'One' }, 'k1');
    // A mistyped check character is caught at entry.
    expect(codeOf(await registerGst(h, 'u-owner', BAD, { companyId: 'C1', legalName: 'One Ltd' }, 'k2'))).toBe('gstin_invalid');
    expect((await registerGst(h, 'u-owner', G1, { companyId: 'C1', legalName: 'One Ltd' }, 'k3')).status).toBe(201);
    // The same GSTIN a second time (a typo of the first) is refused.
    expect(codeOf(await registerGst(h, 'u-owner', G1, { companyId: 'C1', legalName: 'One Ltd Again' }, 'k4'))).toBe('gstin_already_registered');
  });

  it('gates management on platform.setup, allows the read to org.branch.read, and survives a restart', async () => {
    const h = await cast();
    // A store manager may read the structure but not change it; a cashier cannot even read it.
    expect((await putNode(h, 'u-mgr', 'C1', { kind: 'company', name: 'One' }, 'k1')).status).toBe(403);
    await putNode(h, 'u-owner', 'C1', { kind: 'company', name: 'One' }, 'k2');
    await registerGst(h, 'u-owner', G2, { companyId: 'C1', legalName: 'One Ltd' }, 'k3');
    await putNode(h, 'u-owner', 'B1', { kind: 'branch', name: 'Main', parentId: 'C1', companyId: 'C1', gstin: G2 }, 'k4');
    await activate(h, 'u-owner', 'B1', 'k5');
    expect((await listNodes(h, 'u-mgr')).status).toBe(200);
    expect((await listNodes(h, 'u-cash')).status).toBe(403);

    const restarted = apiHarness({ store: h.store });
    const view = (await getNode(restarted, 'u-owner', 'B1')).body as View;
    expect(view.node.status).toBe('active');
    expect(view.filedUnderGstin).toBe(G2);
  });
});
