import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller } from '../support/p3-purchase';

/**
 * **FG-4 · D03-FR-04 "VMI and consignment ownership" — vendor-managed inventory: the supplier proposes a replenishment for
 * ITS OWN items, inside the minimum and maximum the BUYER set; nothing commits without a buyer.**
 *
 *   • until the buyer sets a limit, the supplier's list is "not set" and it can propose nothing;
 *   • the buyer sets rice at store-1 (min 20, max 50) for sup-1; the supplier sees rice — on hand 15, on order 0, room 35 —
 *     and nothing of sup-2's; asking for sup-2's list is refused and recorded as a probe;
 *   • a proposal past the maximum is refused with the room left; one for an item that is not the supplier's is refused and
 *     recorded; a body naming a supplier is refused;
 *   • a proposal inside the limits waits for a buyer; the supplier sees it waiting;
 *   • the buyer accepts it into a purchase-order PROPOSAL (priced by the buyer, never the supplier) — it is NOT issued: a
 *     second person still issues it; the room then counts it as on order;
 *   • a proposal judged again on today's stock: one that no longer fits is a visible 409, never an order past the maximum;
 *   • a rejection is kept with its reason, which the supplier reads; a decision is once;
 *   • a cold restart reads the same.
 * Synthetic data only.
 */

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Item { storeId: string; productId: string; minQty: number; maxQty: number; onHand: number; onOrder: number; room: number; belowMinimum: boolean }

describe.each(backings)('D03-FR-04 — vendor-managed inventory — on $name', ({ harness }) => {
  it('the supplier proposes inside the buyer\'s limits; a buyer accepts it into an order proposal or rejects it', async () => {
    let h = harness();
    const T = randomUUID();
    await p3Shop(h, T, 'sup-1', 'sup-2');
    let call = caller(h, T);
    const ok = async (p: ReturnType<typeof call>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    for (const u of ['u-sup1', 'u-sup2']) await h.provisionRole(T, u, 'supplier');
    await ok(call('POST', '/v1/catalogue/tax-classes/10063000/rates/2017-07-01', P3.OWNER, { rateBps: 500 }), 'tax');
    for (const id of ['p-rice', 'p-dal']) {
      await ok(call('POST', `/v1/catalogue/products/${id}/publish`, P3.OWNER, { product: { sku: id, name: id, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '10063000', lifecycle: 'active' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }), `publish ${id}`);
    }
    for (const [sup, login] of [['sup-1', 'u-sup1'], ['sup-2', 'u-sup2']] as const) {
      await ok(call('POST', `/v1/supplier-portal/partners/${sup}`, P3.BUYER, { grants: ['view_orders'], documents: [], requiredDocuments: [], logins: [login] }), `portal ${sup}`);
    }
    // 15 rice on hand at the back store of store-1.
    await ok(call('POST', '/v1/inventory/movements', P3.OWNER, { movementId: 'open-rice', productId: 'p-rice', locationId: P3.BACK, kind: 'received', quantityMinor: 15, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: P3.OWNER, unitCostMinor: 4_000 }), 'stock');

    const mine = async (who: string, hh = h) => (await ok(caller(hh, T)('GET', '/v1/supplier-portal/me/vmi', who), `vmi ${who}`)).body as { partnerId: string; items: Item[]; notSet?: string; proposals: { proposalId: string; status: string; reason: string | null }[] };
    const propose = (who: string, id: string, body: Record<string, unknown>) => call('POST', `/v1/supplier-portal/me/vmi/proposals/${id}`, who, body);

    // ── 1 · Not set until the buyer sets it.
    expect((await mine('u-sup1')).notSet).toMatch(/^Not set/);
    expect(codeOf(await propose('u-sup1', 'vp-0', { storeId: P3.STORE, lines: [{ productId: 'p-rice', quantity: 10 }] }))).toBe('not_your_item');

    // ── 2 · The buyer sets the limits; nonsense, an unknown supplier, a cashier are refused.
    const limit = (sup: string, product: string, body: Record<string, unknown>, who: string = P3.BUYER) => call('POST', `/v1/purchase/vmi/limits/${sup}/${P3.STORE}/${product}`, who, body);
    expect(codeOf(await limit('sup-1', 'p-rice', { minQty: 60, maxQty: 50, uom: 'ea' }))).toBe('not_readable_as_a_vmi_limit');
    expect(codeOf(await limit('sup-nobody', 'p-rice', { minQty: 20, maxQty: 50, uom: 'ea' }))).toBe('supplier_unknown');
    expect((await limit('sup-1', 'p-rice', { minQty: 20, maxQty: 50, uom: 'ea' }, P3.CASHIER)).status).toBe(403);
    await ok(limit('sup-1', 'p-rice', { minQty: 20, maxQty: 50, uom: 'ea' }), 'rice limit');
    await ok(limit('sup-2', 'p-dal', { minQty: 5, maxQty: 10, uom: 'ea' }), 'dal limit (sup-2)');

    // ── 3 · The supplier sees only its own items, with the stock; another supplier's list is refused and recorded.
    const m1 = await mine('u-sup1');
    expect(m1.items).toEqual([expect.objectContaining({ productId: 'p-rice', minQty: 20, maxQty: 50, onHand: 15, onOrder: 0, room: 35, belowMinimum: true })]);
    expect(JSON.stringify(m1)).not.toContain('p-dal');
    expect(codeOf(await h.request({ method: 'GET', path: '/v1/supplier-portal/me/vmi', userId: 'u-sup1', tenantId: T, query: { partnerId: 'sup-2' } }))).toBe('not_your_data');
    expect((await call('GET', '/v1/supplier-portal/me/vmi', P3.BUYER)).status).toBe(403); // a buyer is no supplier login

    // ── 4 · Proposals: past the maximum, another supplier's item, a named supplier — refused. Inside — it waits.
    const past = await propose('u-sup1', 'vp-1', { storeId: P3.STORE, lines: [{ productId: 'p-rice', quantity: 40 }] });
    expect(codeOf(past)).toBe('outside_the_agreed_limits');
    expect((past.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/at most 35 may be proposed/);
    expect(codeOf(await propose('u-sup1', 'vp-2', { storeId: P3.STORE, lines: [{ productId: 'p-dal', quantity: 5 }] }))).toBe('not_your_item');
    expect(codeOf(await propose('u-sup1', 'vp-3', { storeId: P3.STORE, supplierId: 'sup-2', lines: [{ productId: 'p-rice', quantity: 5 }] }))).toBe('proposal_names_a_supplier');
    const good = await propose('u-sup1', 'vp-4', { storeId: P3.STORE, lines: [{ productId: 'p-rice', quantity: 30 }], note: 'weekly top-up' });
    expect(good.status, JSON.stringify(good.body)).toBe(201);
    expect((await mine('u-sup1')).proposals).toEqual([expect.objectContaining({ proposalId: 'vp-4', status: 'awaiting_buyer' })]);
    // Three tries at what is not its own (an item before it was set, the list, another supplier's item) — a pattern, surfaced.
    const probes = (await ok(call('GET', '/v1/supplier-portal/probing', P3.BUYER), 'probing')).body as { probing: { partnerId: string; userId: string; attempts: number }[] };
    expect(probes.probing).toEqual([expect.objectContaining({ partnerId: 'sup-1', userId: 'u-sup1', attempts: 3 })]);

    // ── 5 · The buyer's queue; the decision. No price → refused (the supplier never prices it). Accepted → an order PROPOSAL.
    const queue = (await ok(call('GET', '/v1/purchase/vmi-proposals', P3.BUYER), 'queue')).body as { proposals: { proposalId: string }[]; awaiting: number };
    expect(queue).toMatchObject({ awaiting: 1 });
    const decide = (id: string, body: Record<string, unknown>, who: string = P3.BUYER) => call('POST', `/v1/purchase/vmi-proposals/${id}/decide`, who, body);
    expect(codeOf(await decide('vp-4', { decision: 'accept', reason: 'ok', poId: 'po-vmi-1' }))).toBe('vmi_order_needs_a_price');
    expect((await decide('vp-4', { decision: 'accept', reason: 'ok', poId: 'po-vmi-1', lines: [{ productId: 'p-rice', unitCost: { minor: 4_000, currency: 'INR' } }] }, P3.CASHIER)).status).toBe(403);
    const accepted = await decide('vp-4', { decision: 'accept', reason: 'stock is below the minimum', poId: 'po-vmi-1', lines: [{ productId: 'p-rice', unitCost: { minor: 4_000, currency: 'INR' } }] });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    const po = (await ok(call('GET', '/v1/purchase/orders/po-vmi-1', P3.OWNER), 'the order')).body as { order: { status: string; supplierId: string; requisitionedBy: string; deliverToLocationId: string; totalMinor: number } };
    expect(po.order).toMatchObject({ status: 'proposed', supplierId: 'sup-1', requisitionedBy: P3.BUYER, deliverToLocationId: P3.STORE, totalMinor: 120_000 }); // never issued by the supplier or the system
    expect(codeOf(await decide('vp-4', { decision: 'reject', reason: 'changed my mind' }))).toBe('already_decided');
    // The room now counts the order: 50 − 15 − 30 = 5.
    expect((await mine('u-sup1')).items[0]).toMatchObject({ onOrder: 30, room: 5, belowMinimum: false });

    // ── 6 · Judged again on today's stock: a second proposal that fitted, then the stock arrived, no longer fits.
    expect((await propose('u-sup1', 'vp-5', { storeId: P3.STORE, lines: [{ productId: 'p-rice', quantity: 5 }] })).status).toBe(201);
    await ok(call('POST', '/v1/inventory/movements', P3.OWNER, { movementId: 'more-rice', productId: 'p-rice', locationId: P3.BACK, kind: 'received', quantityMinor: 3, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: P3.OWNER, unitCostMinor: 4_000 }), 'more stock');
    expect(codeOf(await decide('vp-5', { decision: 'accept', reason: 'ok', poId: 'po-vmi-2', lines: [{ productId: 'p-rice', unitCost: { minor: 4_000, currency: 'INR' } }] }))).toBe('vmi_limits_changed_since');
    expect((await call('GET', '/v1/purchase/orders/po-vmi-2', P3.OWNER)).status).toBe(404); // nothing was ordered
    await ok(decide('vp-5', { decision: 'reject', reason: 'the store filled up since' }), 'reject');

    h = harness(h); // ── COLD RESTART ──
    call = caller(h, T);
    const after = await mine('u-sup1', h);
    expect(after.proposals.map((p) => [p.proposalId, p.status, p.reason])).toEqual([['vp-4', 'accepted', 'stock is below the minimum'], ['vp-5', 'rejected', 'the store filled up since']]);
    expect(JSON.stringify(after)).not.toMatch(/unitCost|4000|120000/); // the supplier never sees the order's prices
    const buyerView = (await ok(call('GET', '/v1/purchase/vmi/sup-1', P3.BUYER), 'buyer view')).body as { items: Item[]; proposals: { status: string }[] };
    expect(buyerView.items[0]).toMatchObject({ onHand: 18, onOrder: 30, room: 2 });
    expect(buyerView.proposals.map((p) => p.status)).toEqual(['accepted', 'rejected']);
  }, 180_000);
});
