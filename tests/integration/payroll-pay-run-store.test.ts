import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';

// Payroll DURABLE pay-run store (WP3 inc9): append lifecycle steps to the append-only ledger so a run
// survives a restart; the current state is a fold of the stored events. Maker ≠ checker at the write
// boundary. Confidential — owner-gated on payroll.statutory.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const append = (h: ApiHarness, u: string, payRunId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/payroll/pay-run/${payRunId}/append`, userId: u, tenantId: A, idempotencyKey: key, body });
const get = (h: ApiHarness, u: string, payRunId: string) =>
  h.request({ method: 'GET', path: `/v1/hr/payroll/pay-run/${payRunId}`, userId: u, tenantId: A });

describe('POST /v1/hr/payroll/pay-run/:id/append + GET …/:id', () => {
  it('drives draft → submit → approve → lock and folds the durable state', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await append(h, 'u-owner', 'pr1', { action: 'draft', actor: 'maker', payPeriod: '2026-08' }, 'a1')).status).toBe(201);
    expect((await append(h, 'u-owner', 'pr1', { action: 'submit', actor: 'maker' }, 'a2')).status).toBe(200);
    expect((await append(h, 'u-owner', 'pr1', { action: 'approve', actor: 'checker' }, 'a3')).status).toBe(200);
    expect((await append(h, 'u-owner', 'pr1', { action: 'lock', actor: 'checker' }, 'a4')).status).toBe(200);
    const state = (await get(h, 'u-owner', 'pr1')).body as { state: string; submittedBy: string; approvedBy: string };
    expect(state.state).toBe('locked');
    expect(state.submittedBy).toBe('maker');
    expect(state.approvedBy).toBe('checker');
  });

  it('refuses a self-approval at the write boundary (maker ≠ checker) and does not store it', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await append(h, 'u-owner', 'pr2', { action: 'draft', actor: 'maker', payPeriod: '2026-08' }, 'b1');
    await append(h, 'u-owner', 'pr2', { action: 'submit', actor: 'maker' }, 'b2');
    const denied = await append(h, 'u-owner', 'pr2', { action: 'approve', actor: 'maker' }, 'b3'); // submitter approving
    expect(denied.status).toBe(422);
    expect((denied.body as { error: { code: string } }).error.code).toBe('pay_run_self_approval');
    expect(((await get(h, 'u-owner', 'pr2')).body as { state: string }).state).toBe('submitted'); // unchanged
  });

  it('survives a restart — a fresh surface over the same store still has the run', async () => {
    const store = new InMemoryEventStore();
    const h1 = apiHarness({ store });
    await h1.seedOwner(A, 'u-owner');
    await append(h1, 'u-owner', 'pr3', { action: 'draft', actor: 'maker', payPeriod: '2026-08' }, 'c1');
    await append(h1, 'u-owner', 'pr3', { action: 'submit', actor: 'maker' }, 'c2');
    await append(h1, 'u-owner', 'pr3', { action: 'approve', actor: 'checker' }, 'c3');
    // "Restart": a brand-new surface built over the SAME durable store.
    const h2 = apiHarness({ store });
    const state = (await get(h2, 'u-owner', 'pr3')).body as { state: string; approvedBy: string };
    expect(state.state).toBe('approved');
    expect(state.approvedBy).toBe('checker');
  });

  it('refuses malformed input, an unknown run, and gates on the confidential permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // no payroll.statutory.read
    expect((await append(h, 'u-owner', 'pr4', { actor: 'maker' }, 'd1')).status).toBe(400); // no action
    expect((await append(h, 'u-owner', 'pr4', { action: 'submit' }, 'd2')).status).toBe(400); // no actor
    expect((await append(h, 'u-owner', 'pr4', { action: 'submit', actor: 'maker' }, 'd3')).status).toBe(422); // no pay run yet
    expect((await get(h, 'u-owner', 'pr-missing')).status).toBe(404);
    expect((await append(h, 'u-cash', 'pr5', { action: 'draft', actor: 'x', payPeriod: '2026-08' }, 'd4')).status).toBe(403);
    expect((await get(h, 'u-cash', 'pr1')).status).toBe(403);
  });
});
