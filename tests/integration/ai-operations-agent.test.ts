import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// The Operations agent (A06) on the live surface (API-13 · §7.1 · M35-FR-04 · P-05 · P-08).
//
// A06 reads the tenant's REAL persisted operational alerts (the alert-lifecycle fold the alerts board reads)
// and, for each incident that still needs attention, drafts a proposal explaining it and naming the reviewed
// runbook for its component. It commits nothing (hard rule #5): the reply says committedAnything:false and an
// OPERATOR acknowledges the alert (taking ownership) and runs the runbook. The three run gates still hold.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const put = (h: ApiHarness, path: string, body: unknown, key: string) =>
  h.request({ method: 'PUT', path, userId: 'u-owner', tenantId: A, idempotencyKey: key, body });
const raise = (h: ApiHarness, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/platform/alerts/raise', userId: 'u-owner', tenantId: A, idempotencyKey: key, body });
const ack = (h: ApiHarness, alertId: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/platform/alerts/${alertId}/acknowledge`, userId: 'u-owner', tenantId: A, idempotencyKey: key, body: {} });
const runA06 = (h: ApiHarness, key: string) =>
  h.request({ method: 'POST', path: '/v1/ai/agents/A06/runs', userId: 'u-owner', tenantId: A, idempotencyKey: key, body: { estimatedCostMinor: 1_000 } });

/** Turn A06 on and fund it, with the kill switch off — the three gates a run must pass. */
async function armA06(h: ApiHarness): Promise<void> {
  expect((await put(h, '/v1/ai/kill-switch', { on: false }, 'k')).status).toBe(200);
  expect((await put(h, '/v1/ai/budget', { capMinor: 500_000, periodEnds: '2027-01-01T00:00:00Z' }, 'b')).status).toBe(200);
  expect((await put(h, '/v1/ai/agents/enabled', { agents: ['A06'] }, 'e')).status).toBe(200);
}

/** Raise a real dead-letter incident (deadLetterCount ≥ 1 → down), owned by a named operator. */
const DEAD_LETTER_RULE = { alertId: 'dl-1', component: 'dead_letter', firesAt: 'degraded', ownerUserId: 'u-op', ownerName: 'Operator', ackWithinMinutes: 15 };
async function raiseDeadLetterIncident(h: ApiHarness): Promise<void> {
  const res = await raise(h, { signals: { deadLetterCount: 3 }, alertRules: [DEAD_LETTER_RULE] }, 'r1');
  expect(res.status).toBe(200);
  expect((res.body as { newlyOpened: number }).newlyOpened).toBe(1);
}

interface Proposal {
  readonly proposalId: string; readonly agent: string; readonly summary: string; readonly wouldRequire: string;
  readonly evidence: readonly { source: string; reference: string; summary: string }[]; readonly committed: boolean;
}
interface RunBody { readonly proposals: readonly Proposal[]; readonly refused: readonly unknown[]; readonly committedAnything: boolean; }

describe('the Operations agent (A06) drafts runbook recommendations from real alerts', () => {
  it('recommends a runbook for a live incident, cites the alert, and commits nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await raiseDeadLetterIncident(h);
    await armA06(h);

    const res = await runA06(h, 'run1');
    expect(res.status).toBe(200);
    const body = res.body as RunBody;
    expect(body.committedAnything).toBe(false);
    for (const p of body.proposals) expect(p.committed).toBe(false);

    const rec = body.proposals.find((p) => p.proposalId === 'ops-runbook:dl-1');
    expect(rec).toBeDefined();
    expect(rec!.agent).toBe('A06');
    expect(rec!.summary).toContain('dead_letter');
    // A06 recommends; a person acknowledges the alert (takes ownership) and runs the runbook.
    expect(rec!.wouldRequire).toBe('POST /v1/platform/alerts/:alertId/acknowledge');
    expect(rec!.evidence[0]!.source).toBe('operational alerts');
    expect(rec!.evidence[0]!.reference).toBe('dl-1');
    expect(rec!.evidence[0]!.summary.toLowerCase()).toContain('runbook:');
  });

  it('stops recommending an alert once a named person has acknowledged it', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await raiseDeadLetterIncident(h);
    await armA06(h);
    expect((((await runA06(h, 'run1')).body) as RunBody).proposals.some((p) => p.proposalId === 'ops-runbook:dl-1')).toBe(true);

    expect((await ack(h, 'dl-1', 'ack1')).status).toBe(200);
    const after = (await runA06(h, 'run2')).body as RunBody;
    expect(after.proposals.some((p) => p.proposalId === 'ops-runbook:dl-1')).toBe(false);
  });

  it('an enabled A06 with no live incidents recommends nothing — no fabricated advice', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await armA06(h);
    const body = (await runA06(h, 'run1')).body as RunBody;
    expect(body.proposals).toEqual([]);
    expect(body.committedAnything).toBe(false);
  });
});
