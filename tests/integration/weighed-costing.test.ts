import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Weighed-department costing, end to end (M11-FR-02, API-04). A butcher/fish/deli counter takes weight in
// and puts less weight out; the survivors must carry the whole input cost (so the shelf price isn't set
// too low), and a yield below the department's standard is a valued exception with the money attached —
// the one line that stops a fish counter running at a loss for a year. Costed runs are persisted and read
// WORST-FIRST. Gated production.plan.commit (costing) / production.read (board + price-by-weight).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const INR = 'INR';

const cost = (h: ApiHarness, u: string, runId: string, body: unknown, key = `wr-${runId}`) =>
  h.request({ method: 'POST', path: `/v1/production/weighed-runs/${runId}`, userId: u, tenantId: A, idempotencyKey: key, body });
const board = (h: ApiHarness, u: string, query?: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/production/weighed-runs', userId: u, tenantId: A, ...(query ? { query } : {}) });
const priceByWeight = (h: ApiHarness, u: string, body: unknown, key = `pbw-${Math.random()}`) =>
  h.request({ method: 'POST', path: '/v1/production/price-by-weight', userId: u, tenantId: A, idempotencyKey: key, body });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                // production.plan.commit + production.read
  await h.provisionRole(A, 'u-cash', 'cashier');  // none
  return h;
}

describe('weighed-department costing (M11-FR-02): cost, yield exceptions, price by weight', () => {
  it('carries the whole input cost onto the survivors and flags a below-standard yield — idempotently', async () => {
    const h = await cast();
    // 10 kg of fish at ₹300/kg goes in; only 7 kg of fillet comes out against an 80% standard.
    const res = await cost(h, 'u-owner', 'wr1', {
      departmentId: 'fish',
      inputs: [{ productId: 'whole-fish', weightGrams: 10_000, costPerKg: { minor: 30_000, currency: INR } }],
      outputs: [{ productId: 'fillet', weightGrams: 7_000 }],
      standardYieldBp: 8_000, toleranceBp: 0,
    });
    expect(res.status).toBe(201);
    const r = (res.body as { result: {
      yieldBp: number; verdict: string; inputCost: { minor: number };
      outputs: { productId: string; costPerKg: { minor: number } }[];
      exceptions: { kind: string }[];
    } }).result;
    expect(r.yieldBp).toBe(7_000);                    // 70%
    expect(r.verdict).toBe('low_yield');
    expect(r.inputCost.minor).toBe(300_000);          // ₹3000 paid for the whole fish
    // The fillet must cost MORE per kg than the input, because 3 kg was paid for and binned:
    // 300000 ÷ 7 kg = ₹428.57/kg.
    expect(r.outputs.find((o) => o.productId === 'fillet')!.costPerKg.minor).toBe(42_857);
    expect(r.exceptions).toHaveLength(1);
    expect(r.exceptions[0]!.kind).toBe('yield_variance');

    // Costed once: a re-post (distinct idempotency key) returns what was recorded, not a second figure.
    const again = await cost(h, 'u-owner', 'wr1', { departmentId: 'fish', inputs: [{ productId: 'whole-fish', weightGrams: 1, costPerKg: { minor: 1, currency: INR } }], outputs: [] }, 'wr1-again');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadyCosted: true });
    expect((again.body as { result: { yieldBp: number } }).result.yieldBp).toBe(7_000); // the original, not the re-post

    // Durable across a restart.
    const h2 = apiHarness({ store: h.store });
    expect(((await board(h2, 'u-owner')).body as { count: number }).count).toBe(1);
  });

  it('flags a run where more weight came out than went in — a mis-weigh, not physics', async () => {
    const h = await cast();
    const res = await cost(h, 'u-owner', 'wr-gain', {
      departmentId: 'deli',
      inputs: [{ productId: 'ham', weightGrams: 5_000, costPerKg: { minor: 50_000, currency: INR } }],
      outputs: [{ productId: 'sliced-ham', weightGrams: 5_200 }],
    });
    const r = (res.body as { result: { exceptions: { kind: string }[] } }).result;
    expect(r.exceptions.some((e) => e.kind === 'gained_weight')).toBe(true);
  });

  it('reads the board worst-first, filters by department, and can show only the flagged runs', async () => {
    const h = await cast();
    // A clean run (meets standard, no exception) and a bad one (below standard).
    await cost(h, 'u-owner', 'wr-clean', { departmentId: 'butcher', inputs: [{ productId: 'beef', weightGrams: 10_000, costPerKg: { minor: 40_000, currency: INR } }], outputs: [{ productId: 'steak', weightGrams: 8_000 }], standardYieldBp: 8_000, toleranceBp: 0 });
    await cost(h, 'u-owner', 'wr-bad', { departmentId: 'butcher', inputs: [{ productId: 'lamb', weightGrams: 10_000, costPerKg: { minor: 60_000, currency: INR } }], outputs: [{ productId: 'chops', weightGrams: 6_500 }], standardYieldBp: 8_000, toleranceBp: 0 });

    const all = (await board(h, 'u-owner')).body as { count: number; withExceptions: number; runs: { runId: string }[] };
    expect(all.count).toBe(2);
    expect(all.withExceptions).toBe(1);
    expect(all.runs[0]!.runId).toBe('wr-bad'); // the loss-making cut is at the top (P-03)

    // Department filter, and only-exceptions view.
    expect(((await board(h, 'u-owner', { department: 'fish' })).body as { count: number }).count).toBe(0);
    const flagged = (await board(h, 'u-owner', { onlyExceptions: 'true' })).body as { count: number; runs: { runId: string }[] };
    expect(flagged.count).toBe(1);
    expect(flagged.runs[0]!.runId).toBe('wr-bad');
  });

  it('prices a weighed pack exactly, refuses a bad body, and gates on the production permissions', async () => {
    const h = await cast();
    // 457 g at ₹250/kg = ₹114.25.
    const p = await priceByWeight(h, 'u-owner', { pricePerKg: { minor: 25_000, currency: INR }, weightGrams: 457 });
    expect(p.status).toBe(200);
    expect((p.body as { price: { minor: number } }).price.minor).toBe(11_425);

    expect(codeOf(await priceByWeight(h, 'u-owner', { pricePerKg: { minor: 25_000, currency: INR }, weightGrams: 0 }))).toBe('price_by_weight_needs_rate_and_weight');
    expect(codeOf(await cost(h, 'u-owner', 'wr-x', { inputs: [{ productId: 'x', weightGrams: 100, costPerKg: { minor: 100, currency: INR } }], outputs: [] }))).toBe('weighed_run_needs_a_department');
    expect(codeOf(await cost(h, 'u-owner', 'wr-y', { departmentId: 'fish', inputs: [], outputs: [] }))).toBe('weighed_run_needs_inputs');

    // A cashier holds no production.* → refused on cost, board and pricing.
    expect((await cost(h, 'u-cash', 'wr-z', { departmentId: 'fish', inputs: [{ productId: 'x', weightGrams: 100, costPerKg: { minor: 100, currency: INR } }], outputs: [] }, 'wr-cash')).status).toBe(403);
    expect((await board(h, 'u-cash')).status).toBe(403);
    expect((await priceByWeight(h, 'u-cash', { pricePerKg: { minor: 100, currency: INR }, weightGrams: 100 }, 'pbw-cash')).status).toBe(403);
  });
});
