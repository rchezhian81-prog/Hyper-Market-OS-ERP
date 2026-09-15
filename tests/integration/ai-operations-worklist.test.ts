import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// The Operations operator's INBOX (A06) on the live surface (API-13 · M35-FR-04 · P-05 · P-08) — slice 1,
// the backend worklist. The live incident recommendations (the SAME tested recommendOperationsRunbooks the
// A06 run uses) folded with the operators' dismissals, re-derived every read so an acknowledged/cleared
// incident leaves the list on its own. A person's worklist, not an action: it commits nothing, a dismissal is
// recorded in the operator's OWN name (the AI never writes it), and the inbox is hidden when the kill switch
// is on or A06 is not enabled by name — the same governance a run honours, but with no model call and no spend.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const put = (h: ApiHarness, path: string, body: unknown, key: string) =>
  h.request({ method: 'PUT', path, userId: 'u-owner', tenantId: A, idempotencyKey: key, body });
const raise = (h: ApiHarness, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/platform/alerts/raise', userId: 'u-owner', tenantId: A, idempotencyKey: key, body });
const ack = (h: ApiHarness, alertId: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/platform/alerts/${alertId}/acknowledge`, userId: 'u-owner', tenantId: A, idempotencyKey: key, body: {} });
const worklist = (h: ApiHarness, u = 'u-owner') =>
  h.request({ method: 'GET', path: '/v1/ai/operations/worklist', userId: u, tenantId: A });
const dismiss = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/ai/operations/dismissals', userId: u, tenantId: A, idempotencyKey: key, body });

async function armA06(h: ApiHarness): Promise<void> {
  expect((await put(h, '/v1/ai/kill-switch', { on: false }, 'k')).status).toBe(200);
  expect((await put(h, '/v1/ai/budget', { capMinor: 500_000, periodEnds: '2027-01-01T00:00:00Z' }, 'b')).status).toBe(200);
  expect((await put(h, '/v1/ai/agents/enabled', { agents: ['A06'] }, 'e')).status).toBe(200);
}
const DEAD_LETTER_RULE = { alertId: 'dl-1', component: 'dead_letter', firesAt: 'degraded', ownerUserId: 'u-op', ownerName: 'Operator', ackWithinMinutes: 15 };
async function raiseDeadLetterIncident(h: ApiHarness): Promise<void> {
  expect((await raise(h, { signals: { deadLetterCount: 3 }, alertRules: [DEAD_LETTER_RULE] }, 'r1')).status).toBe(200);
}

interface Entry { readonly finding: { readonly findingId: string; readonly component: string }; readonly status: string; readonly dismissal?: { readonly by: string; readonly reason: string } }
interface WL { readonly agentActive: boolean; readonly open: readonly Entry[]; readonly dismissed: readonly Entry[]; readonly openCount: number; readonly dismissedCount: number }

describe('the Operations operator inbox (A06 worklist)', () => {
  it('lists a live incident recommendation, and re-derives so an acknowledged incident drops off on its own', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await raiseDeadLetterIncident(h);
    await armA06(h);

    const wl = (await worklist(h)).body as WL;
    expect(wl.agentActive).toBe(true);
    expect(wl.openCount).toBe(1);
    expect(wl.open[0]!.finding.findingId).toBe('ops-runbook:dl-1');
    expect(wl.open[0]!.finding.component).toBe('dead_letter');

    // Acknowledging the alert clears the incident — the recommendation vanishes with no dismissal needed.
    expect((await ack(h, 'dl-1', 'ack1')).status).toBe(200);
    expect(((await worklist(h)).body as WL).openCount).toBe(0);
  });

  it('an operator sets a recommendation aside with a reason (in their own name), and can reopen it', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await raiseDeadLetterIncident(h);
    await armA06(h);

    expect((await dismiss(h, 'u-owner', { findingId: 'ops-runbook:dl-1', reason: 'already being handled by the on-call operator' }, 'd1')).status).toBe(200);
    let wl = (await worklist(h)).body as WL;
    expect(wl.openCount).toBe(0);
    expect(wl.dismissedCount).toBe(1);
    expect(wl.dismissed[0]!.dismissal!.by).toBe('u-owner');
    expect(wl.dismissed[0]!.dismissal!.reason).toContain('on-call');

    // Reopen puts it back on the open list (append-only — the dismissal is not erased, a new decision wins).
    expect((await dismiss(h, 'u-owner', { findingId: 'ops-runbook:dl-1', reopen: true }, 'd2')).status).toBe(200);
    wl = (await worklist(h)).body as WL;
    expect(wl.openCount).toBe(1);
    expect(wl.dismissedCount).toBe(0);
  });

  it('is hidden when the kill switch is on and when A06 is not enabled — the same governance as a run', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await raiseDeadLetterIncident(h);

    // Not enabled yet → inactive, empty.
    const notEnabled = (await worklist(h)).body as WL;
    expect(notEnabled.agentActive).toBe(false);
    expect(notEnabled.open).toEqual([]);

    // Enabled → active; then kill switch on → hidden again.
    await armA06(h);
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
    await raiseDeadLetterIncident(h);
    await armA06(h);

    expect((await worklist(h, 'u-cash')).status).toBe(403);
    expect((await dismiss(h, 'u-cash', { findingId: 'ops-runbook:dl-1', reason: 'x' }, 'dc')).status).toBe(403);
    const bad = await dismiss(h, 'u-owner', { reason: 'no id' }, 'dbad');
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_dismissal');
  });
});
