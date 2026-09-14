import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// The Security/Fraud agent (A07) on the live surface (API-13 · §7.1 · M15-FR-04 · P-04 · P-05).
//
// A07 reads the tenant's REAL persisted loss-prevention investigation cases (the same fold the manager's
// worklist reads) and drafts a PRIORITISED review list — the biggest open exposure first — so the highest
// loss is worked first (P-03). It takes NO autonomous sanction (its whole authority forbids it): the
// proposals commit nothing (committedAnything:false, hard rule #5), a security officer works the case through
// the ordinary loss-prevention surface, and every proposal cites the case's opaque SUBJECT REFERENCE, never a
// name (P-04).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const put = (h: ApiHarness, path: string, body: unknown, key: string) =>
  h.request({ method: 'PUT', path, userId: 'u-owner', tenantId: A, idempotencyKey: key, body });
const openCase = (h: ApiHarness, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/loss-prevention/cases/${id}`, userId: 'u-owner', tenantId: A, idempotencyKey: `open-${id}`, body });
const closeCase = (h: ApiHarness, id: string, body: unknown) =>
  h.request({ method: 'POST', path: `/v1/loss-prevention/cases/${id}/close`, userId: 'u-owner', tenantId: A, idempotencyKey: `close-${id}`, body });
const runA07 = (h: ApiHarness, key: string) =>
  h.request({ method: 'POST', path: '/v1/ai/agents/A07/runs', userId: 'u-owner', tenantId: A, idempotencyKey: key, body: { estimatedCostMinor: 1_000 } });

/** Turn A07 on and fund it, with the kill switch off — the three gates a run must pass. */
async function armA07(h: ApiHarness): Promise<void> {
  expect((await put(h, '/v1/ai/kill-switch', { on: false }, 'k')).status).toBe(200);
  expect((await put(h, '/v1/ai/budget', { capMinor: 500_000, periodEnds: '2027-01-01T00:00:00Z' }, 'b')).status).toBe(200);
  expect((await put(h, '/v1/ai/agents/enabled', { agents: ['A07'] }, 'e')).status).toBe(200);
}

const aCase = (over: Record<string, unknown>) =>
  ({ raisedFromRef: 'voidabuse:till-1', subjectRef: 'staff-9', summary: 'repeated post-void refunds', valueMinor: 50_000, assignedTo: 'u-mgr', ...over });

interface Proposal {
  readonly proposalId: string; readonly agent: string; readonly summary: string; readonly wouldRequire: string;
  readonly evidence: readonly { source: string; reference: string; summary: string }[]; readonly committed: boolean;
}
interface RunBody { readonly proposals: readonly Proposal[]; readonly committedAnything: boolean; }

describe('the Security/Fraud agent (A07) prioritises open investigations, taking no sanction', () => {
  it('drafts a prioritised review list — biggest exposure first — citing the case (not a name), committing nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // Two open cases of different value; A07 should surface the bigger one first.
    expect((await openCase(h, 'c-small', aCase({ subjectRef: 'staff-2', valueMinor: 20_000, summary: 'short till' }))).status).toBe(201);
    expect((await openCase(h, 'c-big', aCase({ subjectRef: 'staff-9', valueMinor: 90_000, summary: 'post-void refunds' }))).status).toBe(201);
    await armA07(h);

    const body = (await runA07(h, 'r1')).body as RunBody;
    expect(body.committedAnything).toBe(false);
    for (const p of body.proposals) expect(p.committed).toBe(false);

    const ids = body.proposals.map((p) => p.proposalId);
    expect(ids).toEqual(['sec-investigation:c-big', 'sec-investigation:c-small']); // biggest exposure first

    const big = body.proposals[0]!;
    expect(big.agent).toBe('A07');
    expect(big.wouldRequire).toBe('GET /v1/loss-prevention/cases');
    expect(big.evidence[0]!.source).toBe('loss-prevention cases');
    expect(big.evidence[0]!.reference).toBe('c-big');
    // Cites the opaque subject reference, never a name (P-04).
    expect(big.evidence[0]!.summary).toContain('staff-9');
    expect(big.summary).toContain('staff-9');
  });

  it('drops a case off the list once it is closed — a closed case is not an open investigation', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await openCase(h, 'c1', aCase({ subjectRef: 'staff-3' }));
    await armA07(h);
    expect((((await runA07(h, 'r1')).body) as RunBody).proposals.some((p) => p.proposalId === 'sec-investigation:c1')).toBe(true);

    // Close it (unfounded — a first-class outcome, no second signer needed).
    expect((await closeCase(h, 'c1', { outcome: 'unfounded', note: 'the till roll explains it' })).status).toBe(200);
    const after = (await runA07(h, 'r2')).body as RunBody;
    expect(after.proposals.some((p) => p.proposalId === 'sec-investigation:c1')).toBe(false);
  });

  it('an enabled A07 with no open investigations prioritises nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await armA07(h);
    const body = (await runA07(h, 'r1')).body as RunBody;
    expect(body.proposals).toEqual([]);
    expect(body.committedAnything).toBe(false);
  });
});
