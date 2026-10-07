import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';

// Payroll DURABLE pay-run store (WP3 inc9): append lifecycle steps to the append-only ledger so a run
// survives a restart; the current state is a fold of the stored events. Maker ≠ checker at the write
// boundary — and WHO takes each step is the signed-in person (ADR-0024 · audit PA-03): the maker drafts and
// submits under their own sign-in, a different person approves and locks under theirs. Confidential —
// owner-gated on payroll.statutory.read, so the two people here are two owners.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const append = (h: ApiHarness, u: string, payRunId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/payroll/pay-run/${payRunId}/append`, userId: u, tenantId: A, idempotencyKey: key, body });
const get = (h: ApiHarness, u: string, payRunId: string) =>
  h.request({ method: 'GET', path: `/v1/hr/payroll/pay-run/${payRunId}`, userId: u, tenantId: A });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

/** The maker (u-owner) and a second owner who checks (u-owner-2). */
async function twoOwners(h: ApiHarness): Promise<void> {
  await h.seedOwner(A, 'u-owner');
  await h.provisionOwner(A, 'u-owner-2');
}

describe('POST /v1/hr/payroll/pay-run/:id/append + GET …/:id', () => {
  it('drives draft → submit → approve → lock, each step by the person signed in, and folds the durable state', async () => {
    const h = apiHarness();
    await twoOwners(h);
    expect((await append(h, 'u-owner', 'pr1', { action: 'draft', payPeriod: '2026-08' }, 'a1')).status).toBe(201);
    expect((await append(h, 'u-owner', 'pr1', { action: 'submit' }, 'a2')).status).toBe(200);
    expect((await append(h, 'u-owner-2', 'pr1', { action: 'approve' }, 'a3')).status).toBe(200);
    expect((await append(h, 'u-owner-2', 'pr1', { action: 'lock', actor: 'u-owner-2' }, 'a4')).status).toBe(200); // naming yourself is fine
    const state = (await get(h, 'u-owner', 'pr1')).body as { state: string; submittedBy: string; approvedBy: string };
    expect(state.state).toBe('locked');
    expect(state.submittedBy).toBe('u-owner');
    expect(state.approvedBy).toBe('u-owner-2');
  });

  it('refuses a self-approval at the write boundary (maker ≠ checker) and does not store it', async () => {
    const h = apiHarness();
    await twoOwners(h);
    await append(h, 'u-owner', 'pr2', { action: 'draft', payPeriod: '2026-08' }, 'b1');
    await append(h, 'u-owner', 'pr2', { action: 'submit' }, 'b2');
    const denied = await append(h, 'u-owner', 'pr2', { action: 'approve' }, 'b3'); // the submitter, signed in, approving
    expect(denied.status).toBe(422);
    expect(codeOf(denied)).toBe('pay_run_self_approval');
    expect(((await get(h, 'u-owner', 'pr2')).body as { state: string }).state).toBe('submitted'); // unchanged
  });

  it('a typed name is not a person: one sign-in cannot submit as one name and approve as another (audit PA-03)', async () => {
    const h = apiHarness();
    await twoOwners(h);
    await append(h, 'u-owner', 'pr6', { action: 'draft', payPeriod: '2026-08' }, 'e1');
    // Before: a body `actor` was taken as who acted, so one person could play maker and checker under two names.
    const typedMaker = await append(h, 'u-owner', 'pr6', { action: 'submit', actor: 'maker' }, 'e2');
    expect(typedMaker.status).toBe(400);
    expect(codeOf(typedMaker)).toBe('actor_is_the_caller');
    await append(h, 'u-owner', 'pr6', { action: 'submit' }, 'e3');
    const typedChecker = await append(h, 'u-owner', 'pr6', { action: 'approve', actor: 'u-owner-2' }, 'e4');
    expect(typedChecker.status).toBe(400);
    expect(codeOf(typedChecker)).toBe('actor_is_the_caller');
    expect(((await get(h, 'u-owner', 'pr6')).body as { state: string }).state).toBe('submitted'); // nothing approved
  });

  it('survives a restart — a fresh surface over the same store still has the run', async () => {
    const store = new InMemoryEventStore();
    const h1 = apiHarness({ store });
    await twoOwners(h1);
    await append(h1, 'u-owner', 'pr3', { action: 'draft', payPeriod: '2026-08' }, 'c1');
    await append(h1, 'u-owner', 'pr3', { action: 'submit' }, 'c2');
    await append(h1, 'u-owner-2', 'pr3', { action: 'approve' }, 'c3');
    // "Restart": a brand-new surface built over the SAME durable store.
    const h2 = apiHarness({ store });
    const state = (await get(h2, 'u-owner', 'pr3')).body as { state: string; approvedBy: string };
    expect(state.state).toBe('approved');
    expect(state.approvedBy).toBe('u-owner-2');
  });

  it('refuses malformed input, an unknown run, and gates on the confidential permission', async () => {
    const h = apiHarness();
    await twoOwners(h);
    await h.provisionRole(A, 'u-cash', 'cashier'); // no payroll.statutory.read
    expect((await append(h, 'u-owner', 'pr4', {}, 'd1')).status).toBe(400); // no action
    expect((await append(h, 'u-owner', 'pr4', { action: 'draft' }, 'd2')).status).toBe(400); // a draft with no period
    expect((await append(h, 'u-owner', 'pr4', { action: 'submit' }, 'd3')).status).toBe(422); // no pay run yet
    expect((await get(h, 'u-owner', 'pr-missing')).status).toBe(404);
    expect((await append(h, 'u-cash', 'pr5', { action: 'draft', payPeriod: '2026-08' }, 'd4')).status).toBe(403);
    expect((await get(h, 'u-cash', 'pr1')).status).toBe(403);
  });
});
