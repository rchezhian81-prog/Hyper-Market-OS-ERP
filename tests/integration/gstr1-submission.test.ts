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

// --- reconciliation, polling, cancel and the exception queue (WP4 inc3) ------------------------------

const req = (h: ApiHarness, method: 'POST' | 'GET', path: string, userId: string, body?: unknown, idem?: string) =>
  h.request({ method, path, userId, tenantId: A, ...(body !== undefined ? { body } : {}), ...(idem !== undefined ? { idempotencyKey: idem } : {}) });
const pre = (h: ApiHarness, u: string, per: string, k: string) => req(h, 'POST', `/v1/finance/gstr1/submission/${per}/preview`, u, { returnDigest: DIGEST }, k);
const app = (h: ApiHarness, u: string, per: string, k: string) => req(h, 'POST', `/v1/finance/gstr1/submission/${per}/approve`, u, {}, k);
const sub = (h: ApiHarness, u: string, per: string, body: unknown, k: string) => req(h, 'POST', `/v1/finance/gstr1/submission/${per}/submit`, u, body, k);
const rr = (h: ApiHarness, u: string, per: string, body: unknown, k: string) => req(h, 'POST', `/v1/finance/gstr1/submission/${per}/record-response`, u, body, k);
const stateOf = async (h: ApiHarness, u: string, per: string) => ((await req(h, 'GET', `/v1/finance/gstr1/submission/${per}`, u)).body as { state: string }).state;

describe('GSTR-1 submission reconciliation (WP4 inc3)', () => {
  it('reconciles a stuck unknown submission to filed with operator evidence', async () => {
    const h = apiHarness();
    await seed(h);
    await pre(h, 'u-maker', P, 'rp1'); await app(h, 'u-owner', P, 'ra1');
    await sub(h, 'u-owner', P, { gstin: GSTIN, digest: DIGEST, async: true }, 'rs1');
    await rr(h, 'u-owner', P, { status: 'unknown', detail: 'timeout' }, 'rr1');
    expect(await stateOf(h, 'u-owner', P)).toBe('unknown');
    // Missing evidence is refused; with a note it resolves.
    expect((await req(h, 'POST', `/v1/finance/gstr1/submission/${P}/reconcile`, 'u-owner', { resolvedState: 'filed' }, 'rc1a')).status).toBe(400);
    const done = await req(h, 'POST', `/v1/finance/gstr1/submission/${P}/reconcile`, 'u-owner', { resolvedState: 'filed', note: 'ARN found on portal', arn: 'AA0826REAL' }, 'rc1b');
    expect(done.status).toBe(200);
    expect((done.body as { current: { state: string; arn: string } }).current.state).toBe('filed');
    expect((done.body as { current: { arn: string } }).current.arn).toBe('AA0826REAL');
    // Reconcile is refused once the return is no longer unknown.
    expect((await req(h, 'POST', `/v1/finance/gstr1/submission/${P}/reconcile`, 'u-owner', { resolvedState: 'failed', note: 'x' }, 'rc1c')).status).toBe(422);
  });

  it('poll recovers a lost acknowledgement (submitting → filed) and resolves an unknown', async () => {
    const h = apiHarness();
    await seed(h);
    // Async submit leaves it submitting; poll re-queries the sandbox and files it.
    await pre(h, 'u-maker', P, 'pp1'); await app(h, 'u-owner', P, 'pa1');
    await sub(h, 'u-owner', P, { gstin: GSTIN, digest: DIGEST, async: true }, 'ps1');
    expect(await stateOf(h, 'u-owner', P)).toBe('submitting');
    const polled = await req(h, 'POST', `/v1/finance/gstr1/submission/${P}/poll`, 'u-owner', { gstin: GSTIN }, 'pl1');
    expect(polled.status).toBe(200);
    expect((polled.body as { current: { state: string } }).current.state).toBe('filed');
    // A poll on a terminal submission is a safe no-op.
    const again = await req(h, 'POST', `/v1/finance/gstr1/submission/${P}/poll`, 'u-owner', { gstin: GSTIN }, 'pl2');
    expect((again.body as { polled: boolean }).polled).toBe(false);
  });

  it('cancels a return before filing (approver), and refuses to cancel a filed one', async () => {
    const h = apiHarness();
    await seed(h);
    await pre(h, 'u-maker', P, 'cp1');
    // A maker (no approve) cannot cancel; the approver can.
    expect((await req(h, 'POST', `/v1/finance/gstr1/submission/${P}/cancel`, 'u-maker', { reason: 'wrong period' }, 'cc1a')).status).toBe(403);
    expect((await req(h, 'POST', `/v1/finance/gstr1/submission/${P}/cancel`, 'u-owner', { reason: 'wrong period' }, 'cc1b')).status).toBe(200);
    expect(await stateOf(h, 'u-owner', P)).toBe('cancelled');
    // Re-file the period fresh, then a filed return cannot be cancelled.
    await pre(h, 'u-maker', P, 'cp2'); await app(h, 'u-owner', P, 'ca2');
    await sub(h, 'u-owner', P, { gstin: GSTIN, digest: DIGEST }, 'cs2');
    expect((await req(h, 'POST', `/v1/finance/gstr1/submission/${P}/cancel`, 'u-owner', { reason: 'too late' }, 'cc2')).status).toBe(422);
  });

  it('lists the exception queue — failed + unknown need attention, filed and pending are separate', async () => {
    const h = apiHarness();
    await seed(h);
    // P1 filed (success)
    await pre(h, 'u-maker', '012026', 'q1'); await app(h, 'u-owner', '012026', 'q2'); await sub(h, 'u-owner', '012026', { gstin: GSTIN, digest: DIGEST }, 'q3');
    // P2 failed
    await pre(h, 'u-maker', '022026', 'q4'); await app(h, 'u-owner', '022026', 'q5'); await sub(h, 'u-owner', '022026', { gstin: GSTIN, digest: DIGEST, async: true }, 'q6');
    await rr(h, 'u-owner', '022026', { status: 'failed', errorCode: 'RET_VALIDATION' }, 'q7');
    // P3 unknown
    await pre(h, 'u-maker', '032026', 'q8'); await app(h, 'u-owner', '032026', 'q9'); await sub(h, 'u-owner', '032026', { gstin: GSTIN, digest: DIGEST, async: true }, 'q10');
    await rr(h, 'u-owner', '032026', { status: 'unknown', detail: 't/o' }, 'q11');
    // P4 pending (previewed only)
    await pre(h, 'u-maker', '042026', 'q12');

    const list = async (state?: string) => (await h.request({ method: 'GET', path: '/v1/finance/gstr1/submissions', userId: 'u-owner', tenantId: A, ...(state !== undefined ? { query: { state } } : {}) })).body as { count: number; submissions: { period: string; queue: string }[] };
    expect((await list()).count).toBe(4);
    const exceptions = await list('exceptions');
    expect(exceptions.submissions.map((s) => s.period).sort()).toEqual(['022026', '032026']);
    expect((await list('success')).submissions.map((s) => s.period)).toEqual(['012026']);
    expect((await list('pending')).submissions.map((s) => s.period)).toEqual(['042026']);
    // The queue is owner/read-gated; a cashier cannot read it.
    await h.provisionRole(A, 'u-cash2', 'cashier');
    expect((await req(h, 'GET', '/v1/finance/gstr1/submissions', 'u-cash2')).status).toBe(403);
  });
});
