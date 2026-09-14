import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// The Inventory agent (A03) on the live surface (API-13 · §7 · M10-FR-01 · ADR-0015 · ADR-0006 · P-05).
//
// A03 reads the tenant's REAL near-expiry stock on the cloud ledger — the SAME `nearExpiryStock` fold the
// `/v1/inventory/near-expiry` route uses — and drafts markdown/disposal SUGGESTIONS, worst-first (earliest
// expiry leading). It commits nothing (committedAnything:false, hard rule #5): a MANAGER applies the markdown
// through the price-change approval path (`POST /v1/prices/changes`) or the disposal through the write-off
// path (`POST /v1/inventory/write-off/:writeOffId`) — never the agent. Each proposal cites the real batch.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INR = 'INR';
const POLICY = { excessToleranceBp: 500, shortageToleranceBp: 200, nearExpiryDays: 7 };
const cost = (minor: number) => ({ minor, currency: INR });

// The API's clock is the real wall-clock, and the A03 run reads near-expiry as-of that day. Seed expiries
// RELATIVE to the same clock so the scenario holds whatever day the suite runs on.
const iso = (d: Date): string => d.toISOString().slice(0, 10);
const dayOffset = (n: number): string => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

const put = (h: ApiHarness, path: string, body: unknown, key: string) =>
  h.request({ method: 'PUT', path, userId: 'u-owner', tenantId: A, idempotencyKey: key, body });
const receive = (h: ApiHarness, grnId: string, lines: unknown[], rules: unknown[], key: string, receivedOnDate: string) =>
  h.request({
    method: 'POST', path: `/v1/inventory/goods-receipt/${grnId}`, userId: 'u-owner', tenantId: A, idempotencyKey: key,
    body: { warehouseId: 'wh1', receivedOnDate, currency: INR, lines, rules, policy: POLICY },
  });
const grnLine = (extra: Record<string, unknown> = {}) =>
  ({ lineId: 'L1', productId: 'milk-1l', orderedMinor: 100, countedMinor: 100, uom: 'each', unitCost: cost(5000), condition: 'good', ...extra });
const runA03 = (h: ApiHarness, key: string) =>
  h.request({ method: 'POST', path: '/v1/ai/agents/A03/runs', userId: 'u-owner', tenantId: A, idempotencyKey: key, body: { estimatedCostMinor: 1_000 } });

/** Turn A03 on and fund it, with the kill switch off — the three gates a run must pass. */
async function armA03(h: ApiHarness): Promise<void> {
  expect((await put(h, '/v1/ai/kill-switch', { on: false }, 'k')).status).toBe(200);
  expect((await put(h, '/v1/ai/budget', { capMinor: 500_000, periodEnds: '2027-01-01T00:00:00Z' }, 'b')).status).toBe(200);
  expect((await put(h, '/v1/ai/agents/enabled', { agents: ['A03'] }, 'e')).status).toBe(200);
}

interface Proposal {
  readonly proposalId: string; readonly agent: string; readonly summary: string; readonly wouldRequire: string;
  readonly evidence: readonly { source: string; reference: string; summary: string }[]; readonly committed: boolean;
}
interface RunBody { readonly proposals: readonly Proposal[]; readonly committedAnything: boolean; }

describe('the Inventory agent (A03) suggests markdowns/disposals over near-expiry stock, committing nothing', () => {
  it('drafts a disposal for expired stock and a markdown for near-expiry stock — worst-first, citing the batch, committing nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner'); // owner has inventory.movement.append + the AI-run permission

    // A batch already past its use-by by run time (received well before, so accepted as sellable) → dispose.
    expect((await receive(
      h, 'grn-old',
      [grnLine({ productId: 'bread-1', batchId: 'B-OLD', expiry: dayOffset(-5), orderedMinor: 50, countedMinor: 50 })],
      [{ productId: 'bread-1', batchTracked: true }], 'k-old', dayOffset(-40),
    )).status).toBe(201);
    // A batch expiring in 3 days → markdown.
    expect((await receive(
      h, 'grn-soon',
      [grnLine({ productId: 'milk-1l', batchId: 'B-SOON', expiry: dayOffset(3) })],
      [{ productId: 'milk-1l', batchTracked: true }], 'k-soon', dayOffset(-2),
    )).status).toBe(201);

    await armA03(h);
    const body = (await runA03(h, 'r1')).body as RunBody;

    // Commits nothing (hard rule #5 / P-05).
    expect(body.committedAnything).toBe(false);
    for (const p of body.proposals) expect(p.committed).toBe(false);

    // Worst-first: the expired batch (earliest expiry) leads the near-expiry one.
    expect(body.proposals.map((p) => p.proposalId)).toEqual(['inv-dispose:B-OLD', 'inv-markdown:B-SOON']);

    const dispose = body.proposals[0]!;
    expect(dispose.agent).toBe('A03');
    expect(dispose.wouldRequire).toBe('POST /v1/inventory/write-off/:writeOffId'); // a manager commits the write-off
    expect(dispose.evidence[0]!.source).toBe('near-expiry stock (cloud ledger)');
    expect(dispose.evidence[0]!.reference).toBe('B-OLD');
    expect(dispose.summary).toContain('B-OLD');
    expect(dispose.summary).toContain('bread-1');

    const markdown = body.proposals[1]!;
    expect(markdown.wouldRequire).toBe('POST /v1/prices/changes'); // a manager commits the price change
    expect(markdown.evidence[0]!.reference).toBe('B-SOON');
    expect(markdown.summary).toContain('B-SOON');
  });

  it('nets what has already sold: a near-expiry batch sold through drops off the suggestion list', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // Receive 100 near-expiry, then sell all 100 of that batch → nothing left on hand to mark down.
    await receive(h, 'grn-st', [grnLine({ productId: 'milk-1l', batchId: 'B-ST', expiry: dayOffset(3) })], [{ productId: 'milk-1l', batchTracked: true }], 'k-st', dayOffset(-2));
    await h.request({
      method: 'POST', path: '/v1/sales', userId: 'u-owner', tenantId: A, idempotencyKey: 's1',
      body: {
        saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-owner',
        tradingDay: dayOffset(-1), committedAt: `${dayOffset(-1)}T10:00:00Z`, totalMinor: 5000, currency: INR, packVersion: 1,
        lines: [{ productId: 'milk-1l', quantityMinor: 100, uom: 'each', unitPriceMinor: 2500, lineTotalMinor: 5000, batchId: 'B-ST' }],
        tenders: [{ kind: 'cash', amountMinor: 5000 }],
      },
    });

    await armA03(h);
    const body = (await runA03(h, 'r1')).body as RunBody;
    expect(body.proposals.some((p) => p.proposalId === 'inv-markdown:B-ST')).toBe(false); // sold through → not suggested
  });

  it('an enabled A03 with no near-expiry stock suggests nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await armA03(h);
    const body = (await runA03(h, 'r1')).body as RunBody;
    expect(body.proposals).toEqual([]);
    expect(body.committedAnything).toBe(false);
  });
});
