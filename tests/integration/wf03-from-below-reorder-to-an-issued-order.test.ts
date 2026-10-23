import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller } from '../support/p3-purchase';

// WF-03 Purchase planning — "Demand/min-max/budget → requisition → RFQ → comparison → approval → PO" (M06, M09, A02;
// OB-288 P3), as ONE journey through the real routes: an item below its reorder point is proposed by the replenishment
// engine on head office's own stock; the BUYER turns the proposal into a requisition (head office re-works the quantities,
// never the caller's); two suppliers quote; the comparison names the cheapest; the buyer raises the order from the
// requisition at that supplier's price; a SECOND person issues it. Separately, an A02 draft (no quantity) becomes a
// requisition only when the buyer names how many — the agent wrote nothing. In memory and — with DATABASE_URL — on real
// PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const ITEMS = [{ productId: 'rice', maxLevel: 50, reorderPoint: 10 }, { productId: 'dal', maxLevel: 20, reorderPoint: 5 }];

describe.each(backings)('WF-03 — below reorder → requisition → RFQ → comparison → issued PO — on $name', ({ harness }) => {
  it('one journey, every step a person\'s own act; the requisition remembers where it came from; a restart reads the issued order', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T, 'sup-1', 'sup-2');
    const call = caller(h, T);
    // On hand at the store: 2 rice (below its reorder point of 10), 18 dal (above 5).
    for (const [id, p, q] of [['mv-r', 'rice', 2], ['mv-d', 'dal', 18]] as const) {
      expect((await call('POST', '/v1/inventory/movements', P3.OWNER, { movementId: id, productId: p, locationId: P3.BACK, kind: 'received', quantityMinor: q, uom: 'ea', occurredAt: new Date(Date.now() - 3_600_000).toISOString(), enteredBy: P3.OWNER, unitCostMinor: 4_000 })).status).toBeLessThan(300);
    }
    // The proposal, read the way the buyer's screen reads it: rice 48 (up to 50), dal nothing.
    const proposal = (await h.request({ method: 'POST', path: '/v1/replenishment/propose', userId: P3.BUYER, tenantId: T, idempotencyKey: 'prop', query: { storeId: P3.STORE }, body: { items: ITEMS } })).body as { proposals: { productId: string; suggestedQty: number }[] };
    expect(proposal.proposals.find((p) => p.productId === 'rice')).toMatchObject({ suggestedQty: 48 });

    // The buyer accepts the rice line — head office re-works it on its own facts; dal was not proposed, so it is refused.
    const fromProposal = (body: Record<string, unknown>, id = 'rq-1') => call('POST', `/v1/purchase/requisitions/${id}/from-replenishment`, P3.BUYER, { storeId: P3.STORE, currency: 'INR', items: ITEMS, ...body });
    expect(codeOf(await fromProposal({ accept: [{ productId: 'dal' }] }, 'rq-x'))).toBe('not_proposed');
    expect(codeOf(await fromProposal({ items: [{ productId: 'rice', maxLevel: 50, onHand: 0 }], accept: [{ productId: 'rice' }] }, 'rq-y'))).toBe('replenishment_carries_caller_stock');
    expect((await call('POST', '/v1/purchase/requisitions/rq-z/from-replenishment', P3.CASHIER, { storeId: P3.STORE, currency: 'INR', items: ITEMS, accept: [{ productId: 'rice' }] })).status).toBe(403);
    const rq = await fromProposal({ accept: [{ productId: 'rice', quantity: 50 }] });
    expect(rq.status).toBe(201);
    expect(rq.body).toMatchObject({
      requisition: { requisitionId: 'rq-1', lines: [{ productId: 'rice', quantity: 50 }], raisedBy: P3.BUYER, source: { kind: 'replenishment', storeId: P3.STORE, proposed: { rice: 48 } } },
      changedByBuyer: [{ productId: 'rice', proposed: 48, chosen: 50 }],
    });

    // RFQ → comparison: sup-2 is cheaper.
    for (const [q, sup, cost, lead] of [['q1', 'sup-1', 4_200, 2], ['q2', 'sup-2', 3_900, 5]] as const) {
      expect((await call('POST', `/v1/purchase/requisitions/rq-1/quotes/${q}`, P3.BUYER, { supplierId: sup, lines: [{ productId: 'rice', unitCost: { minor: cost, currency: 'INR' }, leadTimeDays: lead }] })).status).toBe(201);
    }
    const cmp = (await call('GET', '/v1/purchase/requisitions/rq-1/comparison', P3.BUYER)).body as { comparison: { cheapestOverall: { supplierId: string }; fastestOverall: { supplierId: string } } };
    expect(cmp.comparison).toMatchObject({ cheapestOverall: { supplierId: 'sup-2' }, fastestOverall: { supplierId: 'sup-1' } });

    // The order raised FROM the requisition at the chosen quote; a second person issues it.
    expect((await call('POST', '/v1/purchase/orders/po-1', P3.BUYER, { supplierId: 'sup-2', deliverToLocationId: P3.STORE, requisitionId: 'rq-1', lines: [{ productId: 'rice', orderedQty: 50, unitCost: { minor: 3_900, currency: 'INR' } }] })).status).toBe(201);
    expect((await call('POST', '/v1/purchase/orders/po-1/approval', P3.BUYER, { reason: 'mine' })).status).toBe(403); // a buyer cannot issue
    expect((await call('POST', '/v1/purchase/orders/po-1/approval', P3.OWNER, { reason: 'cheapest like-for-like quote' })).status).toBe(200);

    const again = harness(h);
    const po = (await again.request({ method: 'GET', path: '/v1/purchase/orders/po-1', userId: P3.OWNER, tenantId: T })).body as { order: Record<string, unknown>; openCommitment: { totalOpenValue: { minor: number } } };
    expect(po.order).toMatchObject({ status: 'issued', requisitionId: 'rq-1', requisitionedBy: P3.BUYER, approvedBy: P3.OWNER, buyingScope: 'central_direct_to_store' });
    expect(po.openCommitment.totalOpenValue.minor).toBe(195_000);
    // The new order is now ON ORDER: the same proposal suggests nothing more for rice.
    const later = (await again.request({ method: 'POST', path: '/v1/replenishment/propose', userId: P3.BUYER, tenantId: T, idempotencyKey: 'prop-2', query: { storeId: P3.STORE }, body: { items: ITEMS } })).body as { proposals: { productId: string; suggestedQty: number }[] };
    expect(later.proposals.find((p) => p.productId === 'rice')?.suggestedQty ?? 0).toBe(0);
  }, 120_000);

  it('an A02 draft becomes a requisition only when the buyer names how many — the agent wrote nothing and ordered nothing', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    const today = new Date().toISOString().slice(0, 10);
    await h.request({ method: 'PUT', path: '/v1/platform/setup/locale.time_zone', userId: P3.OWNER, tenantId: T, idempotencyKey: 'tz', body: { value: 'UTC' } });
    await h.provisionRole(T, 'u-till', 'cashier');
    expect((await call('POST', '/v1/inventory/movements', P3.OWNER, { movementId: 'mv-1', productId: 'P-OIL', locationId: P3.STORE, kind: 'received', quantityMinor: 2, uom: 'ea', occurredAt: new Date(Date.now() - 3_600_000).toISOString(), enteredBy: P3.OWNER, unitCostMinor: 15_000 })).status).toBeLessThan(300);
    expect((await call('POST', '/v1/sales', 'u-till', {
      saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', locationId: P3.STORE, cashierId: 'u-till', tradingDay: today, committedAt: new Date(Date.now() - 60_000).toISOString(),
      totalMinor: 54_000, currency: 'INR', packVersion: 1, lines: [{ productId: 'P-OIL', quantityMinor: 3, uom: 'ea', unitPriceMinor: 18_000, lineTotalMinor: 54_000 }], tenders: [{ kind: 'cash', amountMinor: 54_000 }],
    })).status).toBeLessThan(300);
    await h.request({ method: 'PUT', path: '/v1/ai/kill-switch', userId: P3.OWNER, tenantId: T, idempotencyKey: 'k0', body: { on: false } });
    await h.request({ method: 'PUT', path: '/v1/ai/agents/enabled', userId: P3.OWNER, tenantId: T, idempotencyKey: 'e1', body: { agents: ['A02'] } });
    const run = (await call('POST', '/v1/ai/agents/A02/runs', P3.OWNER, {})).body as { proposals: { proposalId: string }[] };
    const draftId = run.proposals[0]!.proposalId;

    const fromDrafts = (body: Record<string, unknown>, id: string) => call('POST', `/v1/purchase/requisitions/${id}/from-drafts`, P3.BUYER, { currency: 'INR', ...body });
    expect(codeOf(await fromDrafts({ lines: [{ proposalId: draftId, productId: 'P-OIL' }] }, 'rq-n'))).toBe('not_readable_as_a_requisition_from_drafts'); // no quantity: the buyer's to say
    expect(codeOf(await fromDrafts({ lines: [{ proposalId: 'a02-nothing', productId: 'P-OIL', quantity: 24 }] }, 'rq-u'))).toBe('draft_unknown');
    expect(codeOf(await fromDrafts({ lines: [{ proposalId: draftId, productId: 'P-RICE', quantity: 24 }] }, 'rq-w'))).toBe('draft_is_about_another_product');
    const rq = await fromDrafts({ lines: [{ proposalId: draftId, productId: 'P-OIL', quantity: 24 }] }, 'rq-a02');
    expect(rq.status).toBe(201);
    expect(rq.body).toMatchObject({ requisition: { lines: [{ productId: 'P-OIL', quantity: 24 }], raisedBy: P3.BUYER, source: { kind: 'a02_draft', proposalIds: [draftId] } } });
    // Nothing was ordered by the agent or by the requisition.
    expect(((await call('GET', '/v1/purchase/orders', P3.OWNER)).body as { count: number }).count).toBe(0);
  }, 120_000);
});
