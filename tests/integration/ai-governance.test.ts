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

    const enabled = await put(h, 'u-owner', '/v1/ai/agents/enabled', { expected: [], agents: ['A08'] }, 'e1');
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
    expect(codeOf(await put(h, 'u-owner', '/v1/ai/agents/enabled', { expected: [], agents: ['A99'] }, 'e1'))).toBe('not_readable_as_an_agent_list');
    expect(codeOf(await put(h, 'u-owner', '/v1/ai/agents/enabled', { expected: [], agents: 'A08' }, 'e2'))).toBe('not_readable_as_an_agent_list');
    expect(codeOf(await put(h, 'u-owner', '/v1/ai/budget', { capMinor: -1, periodEnds: '2027-01-01T00:00:00Z' }, 'b1'))).toBe('not_readable_as_a_budget');
    expect(codeOf(await put(h, 'u-owner', '/v1/ai/budget', { capMinor: 100 }, 'b2'))).toBe('not_readable_as_a_budget');
  });

  it('OB-557: a change made against a stale list is refused by name — nobody\'s switch is silently overwritten', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionOwner(A, 'u-owner-2');
    const enabled = async () => ((await h.request({ method: 'GET', path: '/v1/ai/control', userId: 'u-owner', tenantId: A })).body as { agents: { agentId: string; enabled: boolean }[] }).agents.filter((x) => x.enabled).map((x) => x.agentId);
    // Both owners read "none switched on". The first switches A08 on.
    expect((await put(h, 'u-owner', '/v1/ai/agents/enabled', { expected: [], agents: ['A08'] }, 's1')).status).toBe(200);
    // The second, still holding the list they read, switches A01 on: refused by name, A08 still on.
    const stale = await put(h, 'u-owner-2', '/v1/ai/agents/enabled', { expected: [], agents: ['A01'] }, 's2');
    expect(stale.status).toBe(409);
    expect(codeOf(stale)).toBe('enabled_list_changed');
    expect((stale.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/head office now has A08 switched on, not none/);
    expect(await enabled()).toEqual(['A08']);
    // Re-read and try again on what is there now: accepted.
    expect((await put(h, 'u-owner-2', '/v1/ai/agents/enabled', { expected: ['A08'], agents: ['A01', 'A08'] }, 's3')).status).toBe(200);
    expect(await enabled()).toEqual(['A01', 'A08']);
    // Asking for exactly what is already there is no clash (a retry): nothing changes.
    expect((await put(h, 'u-owner', '/v1/ai/agents/enabled', { expected: ['A08'], agents: ['A08', 'A01'] }, 's4')).body).toMatchObject({ unchanged: true });
    // The list read is required: a change without it is not readable, and nothing changes.
    expect(codeOf(await put(h, 'u-owner', '/v1/ai/agents/enabled', { agents: [] }, 's5'))).toBe('not_readable_as_an_agent_list');
    expect(await enabled()).toEqual(['A01', 'A08']);
  });

  it('is owner governance — a cashier can neither enable an agent nor set the budget', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await put(h, 'u-cash', '/v1/ai/agents/enabled', { expected: [], agents: ['A08'] }, 'e1')).status).toBe(403);
    expect((await put(h, 'u-cash', '/v1/ai/budget', { capMinor: 500_000, periodEnds: '2027-01-01T00:00:00Z' }, 'b1')).status).toBe(403);
  });
});
