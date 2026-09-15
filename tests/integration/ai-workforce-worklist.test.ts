import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// The Workforce/SOP manager's INBOX (A10) on the live surface (API-13 · §7.1 · M25-FR-02 · P-05 · P-08) —
// slice 1, the backend worklist. The day's escalated/overdue task guidance (the SAME tested assessDailyTasks
// the A10 run uses) folded with the managers' dismissals, re-derived every read so a task that is
// completed/assigned leaves the list on its own. A person's worklist, not an action: it commits nothing, a
// set-aside is recorded in the manager's OWN name (the AI never writes it), and the inbox is hidden when the
// kill switch is on or A10 is not enabled by name — the same governance a run honours, but with no model call
// and no spend.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

// The worklist re-derives at the REAL clock (no ?asOf override), like the run route — so a task an hour past
// its due time is always overdue when the inbox reads, whenever the test runs.
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

const put = (h: ApiHarness, path: string, body: unknown, key: string) =>
  h.request({ method: 'PUT', path, userId: 'u-owner', tenantId: A, idempotencyKey: key, body });
const defineTask = (h: ApiHarness, taskId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/tasks/${taskId}`, userId: 'u-owner', tenantId: A, idempotencyKey: key, body });
const completeTask = (h: ApiHarness, taskId: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/hr/workforce/tasks/${taskId}/complete`, userId: 'u-owner', tenantId: A, idempotencyKey: key, body: { doneBy: 'u-owner' } });
const worklist = (h: ApiHarness, u = 'u-owner') =>
  h.request({ method: 'GET', path: '/v1/ai/workforce/worklist', userId: u, tenantId: A });
const dismiss = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/ai/workforce/dismissals', userId: u, tenantId: A, idempotencyKey: key, body });

async function armA10(h: ApiHarness): Promise<void> {
  expect((await put(h, '/v1/ai/kill-switch', { on: false }, 'k')).status).toBe(200);
  expect((await put(h, '/v1/ai/budget', { capMinor: 500_000, periodEnds: '2027-01-01T00:00:00Z' }, 'b')).status).toBe(200);
  expect((await put(h, '/v1/ai/agents/enabled', { agents: ['A10'] }, 'e')).status).toBe(200);
}
async function raiseOverdueCriticalTask(h: ApiHarness): Promise<void> {
  // A distinct idempotency key from the dismiss calls below — keys are scoped per tenant across routes, so
  // reusing 'd1' here would collide with a dismiss keyed 'd1' and be refused as a replay (409).
  expect((await defineTask(h, 'T-chiller', { description: 'Chiller temperature check', forRole: 'cashier', dueAt: PAST, critical: true }, 'seed-chiller')).status).toBe(200);
}

interface Entry { readonly finding: { readonly findingId: string; readonly kind: string; readonly taskId: string }; readonly status: string; readonly dismissal?: { readonly by: string; readonly reason: string } }
interface WL { readonly agentActive: boolean; readonly open: readonly Entry[]; readonly dismissed: readonly Entry[]; readonly openCount: number; readonly dismissedCount: number }

describe('the Workforce guidance manager inbox (A10 worklist)', () => {
  it('lists a live escalated-task guidance, and re-derives so a completed task drops off on its own', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await raiseOverdueCriticalTask(h);
    await armA10(h);

    const wl = (await worklist(h)).body as WL;
    expect(wl.agentActive).toBe(true);
    expect(wl.openCount).toBe(1);
    expect(wl.open[0]!.finding.findingId).toBe('wf-guidance:escalated:T-chiller');
    expect(wl.open[0]!.finding.kind).toBe('escalated');
    expect(wl.open[0]!.finding.taskId).toBe('T-chiller');

    // Completing the task the ordinary way clears the guidance — it vanishes with no dismissal needed.
    expect((await completeTask(h, 'T-chiller', 'c1')).status).toBe(200);
    expect(((await worklist(h)).body as WL).openCount).toBe(0);
  });

  it('a manager sets guidance aside with a reason (in their own name), and can reopen it', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await raiseOverdueCriticalTask(h);
    await armA10(h);

    expect((await dismiss(h, 'u-owner', { findingId: 'wf-guidance:escalated:T-chiller', reason: 'already assigned to the closing shift lead' }, 'd1')).status).toBe(200);
    let wl = (await worklist(h)).body as WL;
    expect(wl.openCount).toBe(0);
    expect(wl.dismissedCount).toBe(1);
    expect(wl.dismissed[0]!.dismissal!.by).toBe('u-owner');
    expect(wl.dismissed[0]!.dismissal!.reason).toContain('closing shift');

    // Reopen puts it back on the open list (append-only — the dismissal is not erased, a new decision wins).
    expect((await dismiss(h, 'u-owner', { findingId: 'wf-guidance:escalated:T-chiller', reopen: true }, 'd2')).status).toBe(200);
    wl = (await worklist(h)).body as WL;
    expect(wl.openCount).toBe(1);
    expect(wl.dismissedCount).toBe(0);
  });

  it('is hidden when the kill switch is on and when A10 is not enabled — the same governance as a run', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await raiseOverdueCriticalTask(h);

    // Not enabled yet → inactive, empty.
    const notEnabled = (await worklist(h)).body as WL;
    expect(notEnabled.agentActive).toBe(false);
    expect(notEnabled.open).toEqual([]);

    // Enabled → active; then kill switch on → hidden again.
    await armA10(h);
    expect(((await worklist(h)).body as WL).agentActive).toBe(true);
    expect((await put(h, '/v1/ai/kill-switch', { on: true }, 'k2')).status).toBe(200);
    const killed = (await worklist(h)).body as WL;
    expect(killed.agentActive).toBe(false);
    expect(killed.openCount).toBe(0);
  });

  it('gates the inbox (read) and the dismissal (write), and refuses a malformed dismissal', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // holds neither ai.proposal.read nor ai.suggestion.dismiss
    await raiseOverdueCriticalTask(h);
    await armA10(h);

    expect((await worklist(h, 'u-cash')).status).toBe(403);
    expect((await dismiss(h, 'u-cash', { findingId: 'wf-guidance:escalated:T-chiller', reason: 'x' }, 'dc')).status).toBe(403);
    const bad = await dismiss(h, 'u-owner', { reason: 'no id' }, 'dbad');
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_dismissal');
  });
});
