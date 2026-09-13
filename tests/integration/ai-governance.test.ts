import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// The AI control surface (API-13, AI-NFR budget/enable/kill-switch). Before an agent can run at all it
// must be (1) below the kill switch (off), (2) enabled BY NAME — nothing runs by default — and (3)
// funded. Those three gates are checked BEFORE any run. This proves the two governance writes that were
// missing (enable agents, set budget): once both are set and the kill switch is off, an enabled agent
// passes the gate; an un-enabled one is refused; and both writes are owner-only.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const put = (h: ApiHarness, u: string, path: string, body: unknown, key: string) =>
  h.request({ method: 'PUT', path, userId: u, tenantId: A, idempotencyKey: key, body });
const run = (h: ApiHarness, u: string, agent: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/ai/agents/${agent}/runs`, userId: u, tenantId: A, idempotencyKey: key, body: { estimatedCostMinor: 1_000 } });
const getBudget = (h: ApiHarness, u: string) => h.request({ method: 'GET', path: '/v1/ai/budget', userId: u, tenantId: A });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

describe('the AI control surface: enable by name, fund, and only then run (API-13)', () => {
  it('funds and enables an agent, and only then does its run pass the gate', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // Kill switch off (default is ON — the safe direction).
    expect((await put(h, 'u-owner', '/v1/ai/kill-switch', { on: false }, 'k0')).status).toBe(200);

    // Set the budget; the GET reflects it, spend starts at zero.
    expect((await put(h, 'u-owner', '/v1/ai/budget', { capMinor: 500_000, periodEnds: '2027-01-01T00:00:00Z' }, 'b1')).status).toBe(200);
    const budget = (await getBudget(h, 'u-owner')).body as { capMinor: number; spentMinor: number };
    expect(budget.capMinor).toBe(500_000);
    expect(budget.spentMinor).toBe(0);

    // A08 is refused until it is enabled BY NAME (nothing runs by default).
    expect((await run(h, 'u-owner', 'A08', 'r0')).status).toBe(429); // agent_not_permitted_here

    const enabled = await put(h, 'u-owner', '/v1/ai/agents/enabled', { agents: ['A08'] }, 'e1');
    expect(enabled.status).toBe(200);
    expect((enabled.body as { enabled: string[] }).enabled).toEqual(['A08']);

    // Now the gate passes: the run is allowed (it produces no proposals yet — that is the next slice —
    // but it is no longer refused, and it commits nothing).
    const ran = await run(h, 'u-owner', 'A08', 'r1');
    expect(ran.status).toBe(200);
    expect((ran.body as { committedAnything: boolean }).committedAnything).toBe(false);

    // An agent that was NOT enabled is still refused.
    expect((await run(h, 'u-owner', 'A02', 'r2')).status).toBe(429);
  });

  it('refuses a malformed agent list or budget', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect(codeOf(await put(h, 'u-owner', '/v1/ai/agents/enabled', { agents: ['A99'] }, 'e1'))).toBe('not_readable_as_an_agent_list');
    expect(codeOf(await put(h, 'u-owner', '/v1/ai/agents/enabled', { agents: 'A08' }, 'e2'))).toBe('not_readable_as_an_agent_list');
    expect(codeOf(await put(h, 'u-owner', '/v1/ai/budget', { capMinor: -1, periodEnds: '2027-01-01T00:00:00Z' }, 'b1'))).toBe('not_readable_as_a_budget');
    expect(codeOf(await put(h, 'u-owner', '/v1/ai/budget', { capMinor: 100 }, 'b2'))).toBe('not_readable_as_a_budget');
  });

  it('is owner governance — a cashier can neither enable an agent nor set the budget', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await put(h, 'u-cash', '/v1/ai/agents/enabled', { agents: ['A08'] }, 'e1')).status).toBe(403);
    expect((await put(h, 'u-cash', '/v1/ai/budget', { capMinor: 500_000, periodEnds: '2027-01-01T00:00:00Z' }, 'b1')).status).toBe(403);
  });
});
