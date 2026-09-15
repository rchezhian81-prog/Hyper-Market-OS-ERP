import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// The Marketing agent (A09) on the live surface (API-13 · §7.1 · M16-FR-02 · A09 · P-05 · P-08).
//
// A09 reads the tenant's REAL stored customer facts + consent (the SAME data the stateful
// `GET /v1/customer/segments/audience` board reads) and DRAFTS which audiences are worth a campaign —
// within consent, by margin, best-margin-first. It states reach honestly: the contactable count AND the
// number who match the segment but withheld consent (surfaced, never silently dropped — P-08). It takes NO
// commercial action (its authority forbids it): the reply is committedAnything:false, every proposal
// committed:false, and a MARKETING APPROVER launches any campaign (no auto-send; the per-channel consent
// check still binds at send time). The three run gates (kill switch, budget, enablement) hold.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const put = (h: ApiHarness, path: string, body: unknown, key: string) =>
  h.request({ method: 'PUT', path, userId: 'u-owner', tenantId: A, idempotencyKey: key, body });
const setPolicy = (h: ApiHarness, body: unknown) =>
  h.request({ method: 'POST', path: '/v1/customer/segments/policy', userId: 'u-owner', tenantId: A, idempotencyKey: 'pol', body });
const recordOrder = (h: ApiHarness, orderId: string, body: unknown) =>
  h.request({ method: 'POST', path: `/v1/customer/facts/orders/${orderId}`, userId: 'u-owner', tenantId: A, idempotencyKey: `o-${orderId}`, body });
const recordConsent = (h: ApiHarness, cust: string, purpose: string, channel: string, given: boolean) =>
  h.request({ method: 'POST', path: `/v1/customers/${cust}/consent`, userId: 'u-owner', tenantId: A, idempotencyKey: `c-${cust}-${purpose}-${channel}-${given}`, body: { purpose, channel, given, evidence: 'test seed consent' } });
const runA09 = (h: ApiHarness, key: string) =>
  h.request({ method: 'POST', path: '/v1/ai/agents/A09/runs', userId: 'u-owner', tenantId: A, idempotencyKey: key, body: { estimatedCostMinor: 1_000 } });

/** Turn A09 on and fund it, with the kill switch off — the three gates a run must pass. */
async function armA09(h: ApiHarness): Promise<void> {
  expect((await put(h, '/v1/ai/kill-switch', { on: false }, 'k')).status).toBe(200);
  expect((await put(h, '/v1/ai/budget', { capMinor: 500_000, periodEnds: '2027-01-01T00:00:00Z' }, 'b')).status).toBe(200);
  expect((await put(h, '/v1/ai/agents/enabled', { agents: ['A09'] }, 'e')).status).toBe(200);
}

interface Proposal {
  readonly proposalId: string; readonly agent: string; readonly summary: string; readonly wouldRequire: string;
  readonly evidence: readonly { source: string; reference: string; summary: string }[]; readonly committed: boolean;
}
interface RunBody { readonly proposals: readonly Proposal[]; readonly committedAnything: boolean; }

// The AI run route reads the REAL clock (no ?asOf=), so orders are dated relative to now: three within the
// last week make a customer "loyal" (with loyalAtOrders:3) and recent (not lapsing), whenever the test runs.
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
async function threeRecentOrders(h: ApiHarness, ref: string): Promise<void> {
  for (const [i, d] of [5, 4, 3].entries()) {
    await recordOrder(h, `${ref}-${i}`, { customerRef: ref, at: daysAgo(d), netMinor: 20_000, marginMinor: 6_000, channel: 'store' });
  }
}

describe('the Marketing agent (A09) drafts campaign audiences within consent and by margin', () => {
  it('drafts the loyal audience, states reach honestly, and commits nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setPolicy(h, { loyalAtOrders: 3 });
    // C1 is loyal AND fully consented → contactable. C2 is loyal and profiled, but withheld MARKETING
    // consent → matches the segment yet is not contactable (the excluded-for-consent case).
    await threeRecentOrders(h, 'C1');
    await threeRecentOrders(h, 'C2');
    await recordConsent(h, 'C1', 'profiling', 'sms', true);
    await recordConsent(h, 'C1', 'marketing', 'sms', true);
    await recordConsent(h, 'C2', 'profiling', 'sms', true);
    await armA09(h);

    const res = await runA09(h, 'run1');
    expect(res.status).toBe(200);
    const body = res.body as RunBody;
    expect(body.committedAnything).toBe(false);
    for (const p of body.proposals) expect(p.committed).toBe(false);

    const loyal = body.proposals.find((p) => p.proposalId === 'mkt-audience:loyal');
    expect(loyal).toBeDefined();
    expect(loyal!.agent).toBe('A09');
    expect(loyal!.summary).toContain('loyal');
    expect(loyal!.summary).toContain('1 contactable');
    // Reach is stated honestly — the one who withheld marketing consent is surfaced, not hidden.
    expect(loyal!.summary).toContain('1 more match but have not consented');
    expect(loyal!.wouldRequire).toContain('marketing approver');
    expect(loyal!.evidence[0]!.source).toBe('customer segments');
    expect(loyal!.evidence[0]!.reference).toBe('loyal');
  });

  it('drafts NOTHING when no consenting customer can be contacted — no campaign to a list of nobody', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setPolicy(h, { loyalAtOrders: 3 });
    await threeRecentOrders(h, 'C1');
    // Profiled (so they can be segmented) but NO marketing consent → not contactable → nothing to draft.
    await recordConsent(h, 'C1', 'profiling', 'sms', true);
    await armA09(h);

    const body = (await runA09(h, 'run1')).body as RunBody;
    expect(body.proposals).toEqual([]);
    expect(body.committedAnything).toBe(false);
  });
});
