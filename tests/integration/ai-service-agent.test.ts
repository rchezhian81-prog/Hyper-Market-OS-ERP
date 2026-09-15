import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { serviceCaseAdapter } from '../../services/api/src/adapters';
import type { ServiceCase } from '../../packages/service-desk/src/index';

// The Service agent (A05) on the live surface (API-13 · §7.1 · M21 · P-05 · P-08).
//
// A05 reads the tenant's REAL stored service-desk cases (the SAME serviceCases fold the desk board reads)
// and, over the tested assessFirstResponse, surfaces the OPEN cases nobody has replied to yet that are
// BREACHING or AT RISK of their first-response SLA — worst-first, the wait a customer actually feels. Its
// purpose is "policy and order answers, DRAFT case responses — exceptions escalate to a person": it flags
// who is waiting and by how long, and a SERVICE AGENT replies (a supervisor approves any AI-drafted reply).
// It takes NO action on the customer's case (hard rule #5): committedAnything:false. The three run gates hold.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const put = (h: ApiHarness, path: string, body: unknown, key: string) =>
  h.request({ method: 'PUT', path, userId: 'u-owner', tenantId: A, idempotencyKey: key, body });
const runA05 = (h: ApiHarness, key: string) =>
  h.request({ method: 'POST', path: '/v1/ai/agents/A05/runs', userId: 'u-owner', tenantId: A, idempotencyKey: key, body: { estimatedCostMinor: 1_000 } });

async function armA05(h: ApiHarness): Promise<void> {
  expect((await put(h, '/v1/ai/kill-switch', { on: false }, 'k')).status).toBe(200);
  expect((await put(h, '/v1/ai/budget', { capMinor: 500_000, periodEnds: '2027-01-01T00:00:00Z' }, 'b')).status).toBe(200);
  expect((await put(h, '/v1/ai/agents/enabled', { agents: ['A05'] }, 'e')).status).toBe(200);
}

// The AI run route reads the REAL clock (no ?asOf=), and a case's openedAt is stamped server-side at
// creation — so a freshly-opened case can never look old. To test breaching cases we seed backdated cases
// directly through the SAME serviceCaseAdapter the app persists with: a case opened N minutes ago.
const minsAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
async function seedCase(h: ApiHarness, over: Partial<ServiceCase> & { caseId: string }): Promise<void> {
  const c: ServiceCase = {
    tenantId: A, kind: 'complaint', customerRef: 'cust-1', assignedTo: 'agent-1',
    priority: 'normal', state: 'open', summary: 'item damaged', openedAt: minsAgo(10), ...over,
  };
  await serviceCaseAdapter({ store: h.store, now: () => new Date().toISOString() }).recordCase(A, c.caseId, c, `seed-${c.caseId}`);
}

interface Proposal {
  readonly proposalId: string; readonly agent: string; readonly summary: string; readonly wouldRequire: string;
  readonly evidence: readonly { source: string; reference: string; summary: string }[]; readonly committed: boolean;
}
interface RunBody { readonly proposals: readonly Proposal[]; readonly committedAnything: boolean; }

describe('the Service agent (A05) surfaces cases breaching first-response, worst-first', () => {
  it('escalates a breached urgent case, flags an at-risk one, ignores fresh + already-answered, commits nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // urgent target 30 min → 120 min old = breached (escalate).
    await seedCase(h, { caseId: 'C-breach', priority: 'urgent', summary: 'fridge leaking', openedAt: minsAgo(120) });
    // normal target 480 min → 400 min old (>= 80% of 480) = at risk, not yet breached.
    await seedCase(h, { caseId: 'C-atrisk', priority: 'normal', summary: 'wrong item delivered', openedAt: minsAgo(400) });
    // Fresh: nothing to flag yet.
    await seedCase(h, { caseId: 'C-fresh', priority: 'normal', openedAt: minsAgo(5) });
    // Already answered: the first-response clock is stopped — never surfaced.
    await seedCase(h, { caseId: 'C-answered', priority: 'urgent', openedAt: minsAgo(120), firstRespondedAt: minsAgo(115) });
    await armA05(h);

    const res = await runA05(h, 'run1');
    expect(res.status).toBe(200);
    const body = res.body as RunBody;
    expect(body.committedAnything).toBe(false);
    for (const p of body.proposals) expect(p.committed).toBe(false);

    const breach = body.proposals.find((p) => p.proposalId === 'svc-case:breached:C-breach');
    expect(breach).toBeDefined();
    expect(breach!.agent).toBe('A05');
    expect(breach!.summary).toContain('BREACHED');
    expect(breach!.wouldRequire).toBe('POST /v1/service/cases/:caseId/first-response');
    expect(breach!.evidence[0]!.source).toBe('service desk cases');
    expect(breach!.evidence[0]!.reference).toBe('C-breach');

    // The at-risk case is flagged too, and the breached (escalate) one is ranked first.
    expect(body.proposals.some((p) => p.proposalId === 'svc-case:at_risk:C-atrisk')).toBe(true);
    expect(body.proposals[0]!.proposalId).toBe('svc-case:breached:C-breach');
    // Fresh and already-answered cases are never surfaced.
    expect(body.proposals.some((p) => p.proposalId.includes('C-fresh'))).toBe(false);
    expect(body.proposals.some((p) => p.proposalId.includes('C-answered'))).toBe(false);
  });

  it('an enabled A05 with every case fresh or answered drafts nothing — no fabricated urgency', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedCase(h, { caseId: 'C-fresh', priority: 'normal', openedAt: minsAgo(5) });
    await seedCase(h, { caseId: 'C-answered', priority: 'urgent', openedAt: minsAgo(120), firstRespondedAt: minsAgo(115) });
    await armA05(h);
    const body = (await runA05(h, 'run1')).body as RunBody;
    expect(body.proposals).toEqual([]);
    expect(body.committedAnything).toBe(false);
  });
});
