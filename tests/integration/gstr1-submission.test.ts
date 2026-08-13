import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';

// GST return DURABLE submission safety (WP4 inc2): preview → approve → submit → acknowledge per filing
// period, maker ≠ checker + duplicate-prevention + digest-match at the write boundary; the LIVE path stays
// off-by-default + killable; the deterministic sandbox runs otherwise. Confidential — owner-gated.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GSTIN = '33ABCDE1234F1Z5';
const DIGEST = 'sha256:approved-figures';
const P = '082026';

const preview = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/finance/gstr1/submission/${P}/preview`, userId: u, tenantId: A, idempotencyKey: key, body });
const approve = (h: ApiHarness, u: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/finance/gstr1/submission/${P}/approve`, userId: u, tenantId: A, idempotencyKey: key, body: {} });
const submit = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/finance/gstr1/submission/${P}/submit`, userId: u, tenantId: A, idempotencyKey: key, body });
const recordResponse = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/finance/gstr1/submission/${P}/record-response`, userId: u, tenantId: A, idempotencyKey: key, body });
const get = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: `/v1/finance/gstr1/submission/${P}`, userId: u, tenantId: A });

// Seed the owner (all GST perms) and a maker who can only prepare (store_manager: generate, not approve).
async function seed(h: ApiHarness): Promise<void> {
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-maker', 'store_manager');
}

describe('GSTR-1 submission safety routes', () => {
  it('files through the sandbox on preview → approve → submit (maker ≠ checker)', async () => {
    const h = apiHarness();
    await seed(h);
    expect((await preview(h, 'u-maker', { returnDigest: DIGEST, summary: 'B2C ₹1,80,000' }, 'p1')).status).toBe(201);
    expect((await approve(h, 'u-owner', 'a1')).status).toBe(200);
    const filed = (await submit(h, 'u-owner', { gstin: GSTIN, digest: DIGEST }, 's1')).body as { sandbox: boolean; result: { status: string; arn: string }; current: { state: string; arn: string } };
    expect(filed.sandbox).toBe(true);
    expect(filed.result.status).toBe('acknowledged');
    expect(filed.current.state).toBe('filed');
    expect(filed.current.arn.startsWith('SANDBOX-')).toBe(true);
  });

  it('refuses a self-approval (the maker cannot approve their own return)', async () => {
    const h = apiHarness();
    await seed(h);
    await preview(h, 'u-owner', { returnDigest: DIGEST }, 'p2'); // owner previews
    const denied = await approve(h, 'u-owner', 'a2'); // …and tries to approve their own
    expect(denied.status).toBe(422);
    expect((denied.body as { error: { code: string } }).error.code).toBe('submission_self_approval');
  });

  it('refuses a duplicate submission and figures changed since approval', async () => {
    const h = apiHarness();
    await seed(h);
    await preview(h, 'u-maker', { returnDigest: DIGEST }, 'p3');
    await approve(h, 'u-owner', 'a3');
    // Digest changed since approval → refused.
    expect((await submit(h, 'u-owner', { gstin: GSTIN, digest: 'sha256:CHANGED' }, 's3a')).status).toBe(422);
    // File it, then a second submit is refused as already filed.
    expect((await submit(h, 'u-owner', { gstin: GSTIN, digest: DIGEST }, 's3b')).status).toBe(200);
    expect((await submit(h, 'u-owner', { gstin: GSTIN, digest: DIGEST }, 's3c')).status).toBe(422); // already filed
  });

  it('keeps the LIVE path off by default and killable; the sandbox still works', async () => {
    const h = apiHarness();
    await seed(h);
    await preview(h, 'u-maker', { returnDigest: DIGEST }, 'p4');
    await approve(h, 'u-owner', 'a4');
    // Live requested but not enabled → blocked at the gate.
    expect((await submit(h, 'u-owner', { gstin: GSTIN, digest: DIGEST, live: true }, 's4a')).status).toBe(403);
    // Enabled but killed → still blocked (kill switch overrides).
    expect((await submit(h, 'u-owner', { gstin: GSTIN, digest: DIGEST, live: true, controls: { enabled: true, killed: true } }, 's4b')).status).toBe(403);
    // Enabled + not killed → the gate opens, but no certified connector is wired → 503 (not the sandbox).
    expect((await submit(h, 'u-owner', { gstin: GSTIN, digest: DIGEST, live: true, controls: { enabled: true } }, 's4c')).status).toBe(503);
    // The sandbox path still files.
    expect((await submit(h, 'u-owner', { gstin: GSTIN, digest: DIGEST }, 's4d')).status).toBe(200);
  });

  it('handles the async portal path: submit → record-response, and unknown routes away from filed', async () => {
    const h = apiHarness();
    await seed(h);
    await preview(h, 'u-maker', { returnDigest: DIGEST }, 'p5');
    await approve(h, 'u-owner', 'a5');
    expect((await submit(h, 'u-owner', { gstin: GSTIN, digest: DIGEST, async: true }, 's5')).status).toBe(202);
    expect(((await get(h, 'u-owner')).body as { state: string }).state).toBe('submitting');
    // A timeout answer → unknown (never straight to filed).
    expect((await recordResponse(h, 'u-owner', { status: 'unknown', detail: 'gateway timeout' }, 'r5')).status).toBe(200);
    expect(((await get(h, 'u-owner')).body as { state: string }).state).toBe('unknown');
  });

  it('survives a restart, and gates on RBAC + tenant isolation', async () => {
    const store = new InMemoryEventStore();
    const h1 = apiHarness({ store });
    await seed(h1);
    await h1.provisionRole(A, 'u-cash', 'cashier'); // no finance.gstr.generate
    await preview(h1, 'u-maker', { returnDigest: DIGEST }, 'p6');
    await approve(h1, 'u-owner', 'a6');
    await submit(h1, 'u-owner', { gstin: GSTIN, digest: DIGEST }, 's6');
    // Restart: a fresh surface over the same store still has the filed return.
    const h2 = apiHarness({ store });
    expect(((await get(h2, 'u-owner')).body as { state: string }).state).toBe('filed');
    // RBAC: a cashier cannot preview (no generate) or approve (no approve).
    expect((await preview(h1, 'u-cash', { returnDigest: DIGEST }, 'p6b')).status).toBe(403);
    expect((await approve(h1, 'u-cash', 'a6b')).status).toBe(403);
    // A maker (store_manager) cannot approve or submit (no approve/submit perms).
    expect((await approve(h1, 'u-maker', 'a6c')).status).toBe(403);
    // Tenant isolation: another tenant sees no submission for this period.
    const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await h1.seedOwner(B, 'u-b');
    expect((await h1.request({ method: 'GET', path: `/v1/finance/gstr1/submission/${P}`, userId: 'u-b', tenantId: B })).status).toBe(404);
  });
});
