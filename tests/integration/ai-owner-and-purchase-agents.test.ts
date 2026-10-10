import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Audit EA-08 (A01 · A02 · AI-NFR-01/04/08/10): the Owner Intelligence (A01) and Purchase (A02) agents had no run
// implementation, and no run was ever recorded or metered. Now, through the real API:
//   • A01 reads the governed reports (takings, their source freshness, the top department) and raises READ-ONLY
//     insights, each with evidence, proposing no action;
//   • A02 finds a product that has stocked out while it sold in the last week and drafts a reorder suggestion for a buyer
//     — no quantity invented (no reorder level is stored), no order raised;
//   • every run is recorded with its SERVER-metered cost (0: no model is called), and its proposals land on the register;
//     a caller's cost estimate is ignored and said; the kill switch stops everything and records nothing.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const today = new Date().toISOString().slice(0, 10);

const put = (h: ApiHarness, path: string, body: unknown, key: string) => h.request({ method: 'PUT', path, userId: 'u-owner', tenantId: A, idempotencyKey: key, body });
const run = (h: ApiHarness, agent: string, key: string, body: unknown = {}) => h.request({ method: 'POST', path: `/v1/ai/agents/${agent}/runs`, userId: 'u-owner', tenantId: A, idempotencyKey: key, body });

interface RunBody { runId: string; proposals: { proposalId: string; agent: string; summary: string; wouldRequire: string; evidence: unknown[]; committed: false }[]; costMinor: number; calledAModel: boolean; committedAnything: false; ignoredFromCaller?: string[] }

async function shop(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-till', 'cashier');
  expect((await put(h, '/v1/platform/setup/locale.time_zone', { value: 'UTC' }, 'tz')).status).toBe(200);
  // Two of a product received at S1, then three sold — it is out of stock with demand.
  expect((await h.request({ method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId: A, idempotencyKey: 'mv-1', body: {
    movementId: 'mv-1', productId: 'P-OIL', locationId: 'S1', kind: 'received', quantityMinor: 2, uom: 'ea', occurredAt: new Date(Date.now() - 3_600_000).toISOString(), enteredBy: 'u-owner', unitCostMinor: 15_000,
  } })).status).toBe(202);
  expect((await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-till', tenantId: A, idempotencyKey: 'sale-1', body: {
    saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', locationId: 'S1', cashierId: 'u-till', tradingDay: today, committedAt: new Date(Date.now() - 60_000).toISOString(),
    totalMinor: 54_000, currency: 'INR', packVersion: 1,
    lines: [{ productId: 'P-OIL', quantityMinor: 3, uom: 'ea', unitPriceMinor: 18_000, lineTotalMinor: 54_000 }], tenders: [{ kind: 'cash', amountMinor: 54_000 }],
  } })).status).toBe(202);
  expect((await put(h, '/v1/ai/kill-switch', { on: false }, 'k0')).status).toBe(200);
  expect((await put(h, '/v1/ai/agents/enabled', { agents: ['A01', 'A02'] }, 'e1')).status).toBe(200);
  return h;
}

describe('A01 and A02 run on governed records, are recorded and metered, and commit nothing (EA-08)', () => {
  it('A01 raises read-only insights from the governed reports, each with evidence', async () => {
    const h = await shop();
    const res = await run(h, 'A01', 'a01-1', { estimatedCostMinor: 999 });
    expect(res.status).toBe(200);
    const body = res.body as RunBody;
    expect(body.committedAnything).toBe(false);
    expect(body.costMinor).toBe(0);
    expect(body.calledAModel).toBe(false);
    expect(body.ignoredFromCaller).toEqual([expect.stringMatching(/estimatedCostMinor/)]);
    const takings = body.proposals.find((p) => p.proposalId === `a01-takings-${today}`)!;
    expect(takings.summary).toMatch(/Taken so far today: ₹540\.00/);
    expect(takings.wouldRequire).toMatch(/A01 is read-only/);
    expect(takings.evidence.length).toBeGreaterThan(0);
    expect(body.proposals.every((p) => p.agent === 'A01' && p.committed === false)).toBe(true);
  });

  it('A02 drafts a reorder suggestion for a stock-out with demand — no quantity invented, no order raised', async () => {
    const h = await shop();
    const body = (await run(h, 'A02', 'a02-1')).body as RunBody;
    expect(body.proposals).toHaveLength(1);
    const p = body.proposals[0]!;
    expect(p.summary).toMatch(/P-OIL is out of stock at S1 \(on hand -1\) and sold 3 in the last 7 days/);
    expect(p.summary).toMatch(/how many is the buyer's decision/);
    expect(p.wouldRequire).toMatch(/POST \/v1\/purchase\/orders\/:poId by a buyer, approved by a second person/);
    // Nothing was ordered: the purchase-order register is untouched.
    expect(await h.store.readStream(A, 'purchase\u001forders')).toHaveLength(0);
  });

  it('every run is recorded with its metered cost and its proposals land on the register; the kill switch records nothing', async () => {
    const h = await shop();
    await run(h, 'A01', 'a01-r');
    await run(h, 'A02', 'a02-r');
    const runs = await h.store.readStream(A, 'ai', { type: 'AiRunRecorded' });
    expect(runs.map((e) => (e.event.payload as { agent: string; costMinor: number; by: string }).agent).sort()).toEqual(['A01', 'A02']);
    expect(runs.every((e) => (e.event.payload as { costMinor: number }).costMinor === 0)).toBe(true);
    const listed = (await h.request({ method: 'GET', path: '/v1/ai/proposals', userId: 'u-owner', tenantId: A })).body as { proposals?: { agent: string }[] };
    expect((listed.proposals ?? []).map((p) => p.agent)).toEqual(expect.arrayContaining(['A01', 'A02']));
    expect(((await h.request({ method: 'GET', path: '/v1/ai/budget', userId: 'u-owner', tenantId: A })).body as { spentMinor: number }).spentMinor).toBe(0);

    expect((await put(h, '/v1/ai/kill-switch', { on: true }, 'k1')).status).toBe(200);
    expect((await run(h, 'A01', 'a01-killed')).status).toBe(503);
    expect(await h.store.readStream(A, 'ai', { type: 'AiRunRecorded' })).toHaveLength(2);
  });
});
