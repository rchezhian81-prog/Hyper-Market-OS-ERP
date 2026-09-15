import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// The Workforce/SOP guidance agent (A10) on the live surface (API-13 · §7.1 · M25-FR-02 · P-05 · P-08).
//
// A10 reads the tenant's REAL stored daily tasks (the SAME task-store fold `assessDailyTasks` runs for the
// workforce board) and drafts guidance for the ones that need a person now — a CRITICAL overdue task escalates
// to the manager on duty, a non-critical overdue one is flagged to assign. It gives role-aware guidance and
// takes NO HR decision (hard rule #5): the reply says committedAnything:false, and a MANAGER completes/assigns
// the task through the ordinary workforce route. The three run gates (kill switch, budget, enablement) hold.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const put = (h: ApiHarness, path: string, body: unknown, key: string) =>
  h.request({ method: 'PUT', path, userId: 'u-owner', tenantId: A, idempotencyKey: key, body });
const defineTask = (h: ApiHarness, taskId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/tasks/${taskId}`, userId: 'u-owner', tenantId: A, idempotencyKey: key, body });
const completeTask = (h: ApiHarness, taskId: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/tasks/${taskId}/complete`, userId: 'u-owner', tenantId: A, idempotencyKey: key, body: { doneBy: 'u-owner' } });
const runA10 = (h: ApiHarness, key: string) =>
  h.request({ method: 'POST', path: '/v1/ai/agents/A10/runs', userId: 'u-owner', tenantId: A, idempotencyKey: key, body: { estimatedCostMinor: 1_000 } });

/** Turn A10 on and fund it, with the kill switch off — the three gates a run must pass. */
async function armA10(h: ApiHarness): Promise<void> {
  expect((await put(h, '/v1/ai/kill-switch', { on: false }, 'k')).status).toBe(200);
  expect((await put(h, '/v1/ai/budget', { capMinor: 500_000, periodEnds: '2027-01-01T00:00:00Z' }, 'b')).status).toBe(200);
  expect((await put(h, '/v1/ai/agents/enabled', { agents: ['A10'] }, 'e')).status).toBe(200);
}

interface Proposal {
  readonly proposalId: string; readonly agent: string; readonly summary: string; readonly wouldRequire: string;
  readonly evidence: readonly { source: string; reference: string; summary: string }[]; readonly committed: boolean;
}
interface RunBody { readonly proposals: readonly Proposal[]; readonly committedAnything: boolean; }

// The AI run route reads the REAL clock (no ?asOf= override), so due times are anchored to `Date.now()`:
// PAST is an hour ago (always overdue when the run fires), FUTURE a day out (always still pending). Anchoring to
// the wall clock keeps the test true whenever it runs, instead of expiring on a hard-coded calendar date.
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

describe('the Workforce guidance agent (A10) drafts from real stored tasks', () => {
  it('escalates a critical overdue task, flags a non-critical one, ignores a pending one, and commits nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await defineTask(h, 'T-chiller', { description: 'Chiller temperature check', forRole: 'cashier', dueAt: PAST, critical: true }, 'd1');
    await defineTask(h, 'T-sweep', { description: 'Sweep the aisles', forRole: 'cashier', dueAt: PAST, critical: false }, 'd2');
    await defineTask(h, 'T-later', { description: 'Evening restock', forRole: 'cashier', dueAt: FUTURE, critical: true }, 'd3');
    await armA10(h);

    const res = await runA10(h, 'run1');
    expect(res.status).toBe(200);
    const body = res.body as RunBody;
    expect(body.committedAnything).toBe(false);
    for (const p of body.proposals) expect(p.committed).toBe(false);

    const crit = body.proposals.find((p) => p.proposalId === 'wf-guidance:escalated:T-chiller');
    expect(crit).toBeDefined();
    expect(crit!.agent).toBe('A10');
    expect(crit!.summary).toContain('CRITICAL');
    expect(crit!.wouldRequire).toBe('POST /v1/hr/workforce/tasks/:taskId/complete');
    expect(crit!.evidence[0]!.source).toBe('workforce daily tasks');
    expect(crit!.evidence[0]!.reference).toBe('T-chiller');

    expect(body.proposals.some((p) => p.proposalId === 'wf-guidance:overdue:T-sweep')).toBe(true);
    // A task not yet due is never flagged — no fabricated urgency.
    expect(body.proposals.some((p) => p.proposalId.includes('T-later'))).toBe(false);
  });

  it('stops flagging a task once it has been completed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await defineTask(h, 'T-chiller', { description: 'Chiller temperature check', forRole: 'cashier', dueAt: PAST, critical: true }, 'd1');
    await armA10(h);
    expect((((await runA10(h, 'run1')).body) as RunBody).proposals.some((p) => p.proposalId === 'wf-guidance:escalated:T-chiller')).toBe(true);

    expect((await completeTask(h, 'T-chiller', 'c1')).status).toBe(200);
    const after = (await runA10(h, 'run2')).body as RunBody;
    expect(after.proposals.some((p) => p.proposalId.includes('T-chiller'))).toBe(false);
  });

  it('an enabled A10 with nothing overdue drafts nothing — no fabricated guidance', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await defineTask(h, 'T-later', { description: 'Evening restock', forRole: 'cashier', dueAt: FUTURE, critical: true }, 'd1');
    await armA10(h);
    const body = (await runA10(h, 'run1')).body as RunBody;
    expect(body.proposals).toEqual([]);
    expect(body.committedAnything).toBe(false);
  });
});
