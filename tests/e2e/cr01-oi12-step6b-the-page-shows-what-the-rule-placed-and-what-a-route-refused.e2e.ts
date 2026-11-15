import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { STREAM } from '../../services/api/src/adapters';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { storeRules } from '../support/store-rules';

/**
 * **CR-01 OI-12 step 6b · OB-760 A (P-08): the Auto-approve limits page says what the rule PLACED, and what an ordinary route
 * REFUSED — in a real browser, over head office's own routes. Synthetic data only.**
 *   • a synthetic ₹4,200 reorder inside the owner's ₹5,000 limit is raised and issued by the rule through the ordinary
 *     purchase-order routes: the page says "Placed by the rule" with the order's number, and head office holds that order,
 *     issued, in the rule's name;
 *   • a synthetic 25% markdown inside the 30% limit is refused by the price route (below the store's margin floor): the page
 *     says "Refused by the ordinary route — waits for a person" with the route's code, and nothing was priced;
 *   • the page writes nothing on open, and follows the language toggle into Tamil.
 */
const OWNER = 'u-owner'; const ACCOUNTANT = 'u-accountant';

describe.skipIf(!HAVE_BROWSER)('CR-01 OI-12 step 6b: the page shows what the rule placed and what a route refused, in a real browser', () => {
  let shop: BoxPageShop;
  const store = new InMemoryEventStore();
  const ok = async (p: Promise<{ status: number; body: unknown }>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'auto-approve',
      harness: { store },
      people: [{ userId: OWNER, permissions: ['ai.autoapprove.read', 'ai.autoapprove.propose', 'ai.autoapprove.confirm', 'ai.autoapprove.stop'] }],
      seed: async (ho, T) => {
        await ho.seedOwner(T, OWNER);
        await ho.provisionRole(T, ACCOUNTANT, 'accountant');
        await deliveryPlaces(ho, T, 'S1');
        await approvedSuppliers(ho, T, 'sup-synthetic-01');
        await storeRules(ho, T, OWNER, 'S1', 2_000); // a 20% margin floor at S1
      },
    });
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) => shop.call(method, path, userId, body);
    await ok(call('POST', '/v1/prices/list/p-curd/entries/e1', OWNER, { scope: 'store', scopeRef: 'S1', priceMinor: 4_000, mrpMinor: 4_500, costMinor: 2_600, marginFloorBps: 0, currency: 'INR', effectiveFrom: shopDateIn(new Date().toISOString()) }), 'curd price');
    for (const [kind, limit] of [['reorder_from_approved_supplier', 500_000], ['markdown_short_dated', 3_000]] as const) {
      const asked = await ok(call('POST', '/v1/ai/auto-approve/requests', OWNER, { action: 'set_limit', kind, limit, basedOnVersion: 0, reason: 'synthetic browser trial' }), `ask ${kind}`);
      await ok(call('POST', `/v1/ai/auto-approve/requests/${(asked.body as { request: { requestId: string } }).request.requestId}/decision`, ACCOUNTANT, { decision: 'confirmed' }), `confirm ${kind}`);
    }
    const start = await ok(call('POST', '/v1/ai/auto-approve/requests', OWNER, { action: 'resume', basedOnVersion: 0, reason: 'synthetic browser trial' }), 'ask start');
    await ok(call('POST', `/v1/ai/auto-approve/requests/${(start.body as { request: { requestId: string } }).request.requestId}/decision`, ACCOUNTANT, { decision: 'confirmed' }), 'confirm start');
    await ok(call('PUT', '/v1/ai/kill-switch', OWNER, { on: false, reason: 'synthetic browser trial' }), 'AI on');
    const raise = async (proposalId: string, agent: string, act: Record<string, unknown>) => {
      const at = new Date().toISOString();
      const p = { proposalId, agent, summary: `synthetic ${proposalId}`, wouldRequire: 'the ordinary route', evidence: [{ source: 'synthetic', reference: 'r', summary: 's' }], createdAt: at, committed: false, act };
      await store.append(shop.tenantId, STREAM.ai, makeEvent({ id: `ai-proposal-${proposalId}`, type: 'AiProposalRaised', occurredAt: at, idempotencyKey: `ai-proposal-${shop.tenantId}-${proposalId}-${randomUUID()}`, source: 'test/synthetic', payload: p }));
    };
    await raise('a02-browser-rice', 'A02', { kind: 'reorder_from_approved_supplier', supplierId: 'sup-synthetic-01', supplierApproved: true, valueMinor: 420_000, lines: [{ productId: 'p-rice', qty: 10, unitCostMinor: 42_000, uom: 'ea' }], deliverToLocationId: 'S1' });
    await raise('a03-browser-curd', 'A03', { kind: 'markdown_short_dated', productId: 'p-curd', batchId: 'b-curd', percentOffBps: 2_500, daysToExpiry: 3, storeId: 'S1', currentPriceMinor: 4_000, newPriceMinor: 3_000, mrpMinor: 4_500, costMinor: 2_600, surplusQty: 12 });
    await ok(call('POST', '/v1/ai/auto-approve/sweep', OWNER, {}), 'sweep');
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('placed: the order number; refused: the route and its reason; in English and Tamil', async () => {
    const o = await shop.open(OWNER, '/auto-approve/');
    await o.page.waitForFunction("document.body.dataset.autoApprove === 'ok'", undefined, { timeout: 15_000 });
    const placed = '#decision-list li[data-proposal="a02-browser-rice"]';
    await says(o.page, placed, /Placed by the rule/);
    await says(o.page, `${placed} .placed`, /^Placed as: po-auto-[0-9a-f]+ \(POST \/v1\/purchase\/orders\/:poId \+ \/approval\)$/);
    const poId = await o.page.getAttribute(placed, 'data-placed');
    // Head office holds that order, issued, in the rule's name.
    const po = (await shop.call('GET', `/v1/purchase/orders/${poId!}`, OWNER)).body as { order: { status: string; requisitionedBy: string; approvedBy: string } };
    expect(po.order).toMatchObject({ status: 'issued', requisitionedBy: 'rule:auto-approve', approvedBy: 'rule:reorder_from_approved_supplier-v1' });

    const refused = '#decision-list li[data-proposal="a03-browser-curd"]';
    await says(o.page, refused, /Refused by the ordinary route — waits for a person/);
    await says(o.page, `${refused} .refused`, /^Refused by: POST \/v1\/prices\/changes \(price_below_floor\)$/);
    expect(await o.page.getAttribute(refused, 'data-refused')).toBe('price_below_floor');
    expect(o.writes, 'nothing is written on open').toEqual([]);

    await o.page.click('#lang');
    await says(o.page, placed, /விதியால் வைக்கப்பட்டது/);
    await says(o.page, refused, /வழக்கமான வழி மறுத்தது/);
    expect(o.errors).toEqual([]);
    await o.close();
  });
});
