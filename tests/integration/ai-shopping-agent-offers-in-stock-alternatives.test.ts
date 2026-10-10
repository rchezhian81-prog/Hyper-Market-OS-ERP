import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

/**
 * **The Customer Shopping agent (A04) drafts in-stock alternatives from head office's governed records; the customer
 * decides (audit EA-08 · A04 · M20 "the customer confirms the cart" · hard rule #5).**
 *
 * The product master (categories), the published catalogue pack (sellable, price) and the stock ledger are set up through
 * the production routes. Aavin milk has sold out at S1; two other milks are in stock there, one milk only at S2, rice is
 * in another department. Running A04 drafts exactly one proposal: for Aavin at S1, the in-stock milks AT S1, closest in
 * price first — never the S2-only one, never rice. Every proposal is evidence-backed and says the CUSTOMER confirms;
 * nothing is added to any cart or order, and the run says committedAnything: false. Gated like every agent run.
 */

const T = 'ab000000-0000-4000-8000-0000000ea048';
const OWNER = 'u-owner';
const today = new Date().toISOString().slice(0, 10);

async function seed(h: ApiHarness): Promise<void> {
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, 'u-cash', 'cashier');
  const ok = async (method: 'POST' | 'PUT', path: string, body: unknown, key: string) => {
    const r = await h.request({ method, path, userId: OWNER, tenantId: T, idempotencyKey: key, body });
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  };
  await ok('POST', '/v1/catalogue/tax-classes/0401/rates/2017-07-01', { rateBps: 0 }, 'tax');
  const cats = [{ categoryId: 'dairy', name: 'Dairy', parentId: null }, { categoryId: 'grocery', name: 'Grocery', parentId: null }];
  const products = [
    ['MILK-AAVIN', 'Aavin Milk 1L', 'dairy', 60_00], ['MILK-AROKYA', 'Arokya Milk 1L', 'dairy', 62_00],
    ['MILK-HERITAGE', 'Heritage Milk 1L', 'dairy', 70_00], ['MILK-S2ONLY', 'Nandini Milk 1L', 'dairy', 61_00],
    ['RICE-5', 'Ponni Rice 5kg', 'grocery', 60_00],
  ] as const;
  for (const [id, name, cat, price] of products) {
    await ok('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku: id, name, baseUom: 'each', primaryCategoryId: cat, taxClass: '0401', lifecycle: 'active' }, categories: cats }, `pub-${id}`);
    await ok('POST', `/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: 'S1', priceMinor: price, mrpMinor: price + 10_00, costMinor: price - 10_00, marginFloorBps: 0, currency: 'INR', effectiveFrom: today }, `price-${id}`);
  }
  await ok('POST', '/v1/catalogue/pack', { storeId: 'S1', asOf: today }, 'pack');
  const move = (id: string, productId: string, loc: string, kind: string, qty: number) => ok('POST', '/v1/inventory/movements', {
    movementId: id, productId, locationId: loc, kind, quantityMinor: qty, uom: 'each', occurredAt: `${today}T01:00:00.000Z`, enteredBy: OWNER, ...(kind === 'received' ? { unitCostMinor: 50_00 } : {}),
  }, id);
  await move('m1', 'MILK-AAVIN', 'S1', 'received', 5);
  await move('m2', 'MILK-AAVIN', 'S1', 'sold', 5); // sold out at S1
  await move('m3', 'MILK-AROKYA', 'S1', 'received', 12);
  await move('m4', 'MILK-HERITAGE', 'S1', 'received', 3);
  await move('m5', 'MILK-S2ONLY', 'S2', 'received', 9);
  await move('m6', 'RICE-5', 'S1', 'received', 10);
  await ok('PUT', '/v1/ai/agents/enabled', { agents: ['A04'] }, 'en');
  await ok('PUT', '/v1/ai/kill-switch', { on: false, reason: 'trial of the shopping agent' }, 'unkill');
}

describe('A04 drafts in-stock alternatives the customer chooses from (EA-08)', () => {
  it('one proposal for the sold-out milk at S1 — the S1 milks, closest price first; nothing committed', async () => {
    const h = apiHarness();
    await seed(h);
    const run = await h.request({ method: 'POST', path: '/v1/ai/agents/A04/runs', userId: OWNER, tenantId: T, idempotencyKey: 'run-1' });
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    const body = run.body as { proposals: { proposalId: string; summary: string; wouldRequire: string; evidence: { source: string; summary: string }[]; committed: boolean }[]; committedAnything: boolean; costMinor: number };
    expect(body.committedAnything).toBe(false);
    expect(body.costMinor).toBe(0); // deterministic: no model, no spend
    expect(body.proposals.map((p) => p.proposalId)).toEqual([`a04-alternatives-MILK-AAVIN-S1-${today}`]);
    const p = body.proposals[0]!;
    expect(p.committed).toBe(false);
    expect(p.summary).toMatch(/Aavin Milk 1L is out of stock at S1/);
    // Closest in price first (₹62 then ₹70); never the S2-only milk; never rice.
    expect(p.summary.indexOf('Arokya')).toBeGreaterThan(-1);
    expect(p.summary.indexOf('Arokya')).toBeLessThan(p.summary.indexOf('Heritage'));
    expect(p.summary).not.toMatch(/Nandini|Ponni/);
    expect(p.wouldRequire).toMatch(/CUSTOMER confirms/);
    expect(p.evidence.map((e) => e.source)).toEqual(expect.arrayContaining(['inventory availability', 'catalogue pack', 'product master']));

    // On the proposal register — a draft, nothing more; a cashier cannot run the agent.
    const register = (await h.request({ method: 'GET', path: '/v1/ai/proposals', userId: OWNER, tenantId: T })).body as { proposals: { proposalId: string }[]; committedAnything: boolean };
    expect(register.proposals.map((x) => x.proposalId)).toContain(p.proposalId);
    expect((await h.request({ method: 'POST', path: '/v1/ai/agents/A04/runs', userId: 'u-cash', tenantId: T, idempotencyKey: 'run-cash' })).status).toBe(403);

    // Restock Aavin and the proposal goes away on the next run — it re-derives from the ledger every time.
    await h.request({ method: 'POST', path: '/v1/inventory/movements', userId: OWNER, tenantId: T, idempotencyKey: 'm7', body: { movementId: 'm7', productId: 'MILK-AAVIN', locationId: 'S1', kind: 'received', quantityMinor: 4, uom: 'each', occurredAt: `${today}T02:00:00.000Z`, enteredBy: OWNER, unitCostMinor: 50_00 } });
    const again = await h.request({ method: 'POST', path: '/v1/ai/agents/A04/runs', userId: OWNER, tenantId: T, idempotencyKey: 'run-2' });
    expect((again.body as { proposals: unknown[] }).proposals).toEqual([]);
  });
});
