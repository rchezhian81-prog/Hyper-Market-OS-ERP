// CR-01 OI-12 step 6b · OB-760 A · P-05 · hard rules 2, 5, 10 · §28 — a rule's approval PLACES the act through its ORDINARY
// route, as the rule's own non-human identity, at most once, and a refusal makes the draft wait for a person.
//
// What these tests pin, in the owner's words:
//   • a reorder inside the limit is RAISED by `rule:auto-approve` and ISSUED by the rule itself (`rule:<ruleId>`) through the
//     ordinary purchase-order routes; the issue reason names the two people who set the limit;
//   • a markdown goes through the ordinary price-change route; a transfer through the ordinary transfer route (raised only:
//     a person dispatches it and another receives it);
//   • when a route refuses, nothing more is called, the route's own reason is kept, and the draft waits for a person — the
//     rule never tries it again; an order raised but refused at issue is said by name ("raised but NOT issued");
//   • the rule may call ONLY its routes, with ONLY its permissions — a route needing anything else is refused before it runs;
//   • the rule's purchase-order authority is the limit the two people set, and ONLY while it is placing;
//   • a stop pulled after the rule decided, but before it placed, stops it too.
// Synthetic data only.
import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { apiError, type Route, type RequestContext } from '../../services/kernel/src/index';
import { foldAutoApprove, type AutoApproveRequest, type AutoApproveStop, type DraftAct } from '../../packages/ai/src/index';
import { sweepDrafts, type AutoApproveStore, type AutoApprovedDecision, type OpenDraft } from '../../services/ai/src/auto-approve';
import {
  autoApprovePlacer, ruleAwareAuthority, placements, referenceFor, RULE_IDENTITY, AUTO_APPROVE_RULE_ROLE, RULE_ROUTES,
} from '../../services/api/src/ai-auto-approve-executor';

const T = 'tenant-synthetic';
const NOW = '2026-11-14T06:00:00.000Z';

interface Call { readonly path: string; readonly userId: string; readonly params: Record<string, string>; readonly body: unknown }

/** The ordinary routes, as stand-ins that record who called them with what — and refuse when told to. */
function fakeRoutes(refuse: Partial<Record<string, { status: number; code: string; words: string }>> = {}, extra: Route[] = []) {
  const calls: Call[] = [];
  const mk = (method: 'POST', path: string, permission: string, reply: (ctx: RequestContext) => unknown): Route => ({
    api: 'API-03', method, path, permission: permission as never, idempotent: true,
    handler: async (ctx) => {
      calls.push({ path, userId: ctx.userId, params: { ...ctx.params }, body: ctx.body });
      const r = refuse[path];
      if (r !== undefined) throw apiError(r.status, { code: r.code, whatHappened: r.words, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was recorded.' });
      return { status: 201, body: reply(ctx) };
    },
  });
  const routes: Route[] = [
    mk('POST', '/v1/purchase/orders/:poId', 'purchase.order.propose', () => ({ order: { status: 'proposed', totalMinor: 288_000 } })),
    mk('POST', '/v1/purchase/orders/:poId/approval', 'purchase.order.approve', () => ({ order: { status: 'issued' } })),
    mk('POST', '/v1/prices/changes', 'price.change.propose', () => ({ change: { verdict: 'ok' } })),
    mk('POST', '/v1/warehouse/transfers/:transferId', 'inventory.movement.append', () => ({ state: 'proposed' })),
    ...extra,
  ];
  return { routes, calls };
}

const decided = (over: Partial<AutoApprovedDecision> = {}): AutoApprovedDecision => ({
  outcome: 'auto_approved', proposalId: 'a02-stockout-RICE-br-1-2026-11-14', kind: 'reorder_from_approved_supplier',
  approvedBy: 'rule:reorder_from_approved_supplier-v1', ruleId: 'reorder_from_approved_supplier-v1', ruleVersion: 1,
  ruleSetBy: { askedBy: 'u-owner', confirmedBy: 'u-accountant' }, limit: 500_000, measured: 288_000, measure: 'value_minor',
  draftedBy: 'A02', ordinaryRoute: 'POST /v1/purchase/orders/:poId', at: NOW, detail: 'within the limit', ...over,
});
const reorder: DraftAct = {
  kind: 'reorder_from_approved_supplier', supplierId: 'sup-synthetic-01', supplierApproved: true, valueMinor: 288_000,
  lines: [{ productId: 'RICE', qty: 48_000, unitCostMinor: 6_000, uom: 'kg' }], deliverToLocationId: 'br-1',
};
const markdown: DraftAct = {
  kind: 'markdown_short_dated', productId: 'CURD', batchId: 'b-curd-1', percentOffBps: 2_500, daysToExpiry: 3,
  storeId: 'br-1', currentPriceMinor: 4_000, newPriceMinor: 3_000, mrpMinor: 4_500, costMinor: 2_600, surplusQty: 12,
};
const transfer: DraftAct = { kind: 'stock_transfer', productId: 'SOAP', fromLocationId: 'wh-1', toLocationId: 'br-1', qty: 24, valueMinor: 72_000, uom: 'ea' };

describe('the rule places a reorder through the ordinary purchase-order routes (OB-760 A, OB-761 A)', () => {
  it('raises it as rule:auto-approve and issues it as the rule itself, naming the two people', async () => {
    const store = new InMemoryEventStore();
    const { routes, calls } = fakeRoutes();
    const r = await autoApprovePlacer({ store, now: () => NOW, routes: () => routes })(T, decided(), reorder);
    const poId = referenceFor('a02-stockout-RICE-br-1-2026-11-14', 'po-auto');
    expect(r).toMatchObject({ placed: true, reference: poId });
    expect(calls.map((c) => [c.path, c.userId, c.params['poId']])).toEqual([
      ['/v1/purchase/orders/:poId', RULE_IDENTITY, poId],
      ['/v1/purchase/orders/:poId/approval', 'rule:reorder_from_approved_supplier-v1', poId],
    ]);
    expect(calls[0]!.body).toEqual({ supplierId: 'sup-synthetic-01', deliverToLocationId: 'br-1', lines: [{ productId: 'RICE', orderedQty: 48_000, unitCost: { minor: 6_000, currency: 'INR' } }] });
    expect((calls[1]!.body as { reason: string }).reason).toMatch(/u-owner.*u-accountant/);
  });

  it('is placed at most once: a second sweep of the same draft calls no route again', async () => {
    const store = new InMemoryEventStore();
    const { routes, calls } = fakeRoutes();
    const place = autoApprovePlacer({ store, now: () => NOW, routes: () => routes });
    const [a, b] = await Promise.all([place(T, decided(), reorder), place(T, decided(), reorder)]);
    const c = await place(T, decided(), reorder);
    expect([a, b, c].every((x) => x.placed)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(await placements(store, T)).toHaveLength(1);
  });

  it('a refusal at raising stops there, keeps the route reason, and is never tried again', async () => {
    const store = new InMemoryEventStore();
    const { routes, calls } = fakeRoutes({ '/v1/purchase/orders/:poId': { status: 422, code: 'supplier_not_approved', words: 'Supplier is still waiting for finance.' } });
    const place = autoApprovePlacer({ store, now: () => NOW, routes: () => routes });
    expect(await place(T, decided(), reorder)).toMatchObject({ placed: false, code: 'supplier_not_approved', reason: 'Supplier is still waiting for finance.' });
    expect(await place(T, decided(), reorder)).toMatchObject({ placed: false, code: 'supplier_not_approved' });
    expect(calls).toHaveLength(1);
  });

  it('a refusal at issue says the order was raised but NOT issued', async () => {
    const store = new InMemoryEventStore();
    const { routes } = fakeRoutes({ '/v1/purchase/orders/:poId/approval': { status: 422, code: 'over_open_to_buy', words: 'Over this month\'s budget.' } });
    const r = await autoApprovePlacer({ store, now: () => NOW, routes: () => routes })(T, decided(), reorder);
    expect(r).toMatchObject({ placed: false, code: 'over_open_to_buy', route: 'POST /v1/purchase/orders/:poId/approval' });
    expect(!r.placed && r.reason).toMatch(/raised but NOT issued/);
  });

  it('an order the route values above what the rule measured is never issued', async () => {
    const store = new InMemoryEventStore();
    const { routes, calls } = fakeRoutes();
    const r = await autoApprovePlacer({ store, now: () => NOW, routes: () => routes })(T, decided({ measured: 100_000 }), { ...reorder, valueMinor: 100_000 });
    expect(r).toMatchObject({ placed: false, code: 'value_moved' });
    expect(calls).toHaveLength(1);
  });
});

describe('the markdown and the transfer go through their own ordinary routes (OB-762 A)', () => {
  it('a markdown is a price change at the ladder\'s new price, with the MRP and cost head office holds', async () => {
    const { routes, calls } = fakeRoutes();
    const r = await autoApprovePlacer({ store: new InMemoryEventStore(), now: () => NOW, routes: () => routes })(T,
      decided({ proposalId: 'inv-markdown:b-curd-1', kind: 'markdown_short_dated', approvedBy: 'rule:markdown_short_dated-v1', ruleId: 'markdown_short_dated-v1', measured: 2_500, limit: 3_000, measure: 'percent_bps', draftedBy: 'A03' }), markdown);
    expect(r.placed).toBe(true);
    expect(calls).toEqual([{ path: '/v1/prices/changes', userId: RULE_IDENTITY, params: {}, body: { productId: 'CURD', priceMinor: 3_000, currency: 'INR', mrpMinor: 4_500, costMinor: 2_600, storeId: 'br-1' } }]);
  });

  it('the price guard\'s refusal (a second person needed) makes it wait, with that reason', async () => {
    const { routes } = fakeRoutes({ '/v1/prices/changes': { status: 422, code: 'price_change_needs_second_person', words: 'A cut of 25% is above the 10% one person may make.' } });
    const r = await autoApprovePlacer({ store: new InMemoryEventStore(), now: () => NOW, routes: () => routes })(T, decided({ proposalId: 'inv-markdown:b-curd-1', kind: 'markdown_short_dated' }), markdown);
    expect(r).toMatchObject({ placed: false, code: 'price_change_needs_second_person' });
  });

  it('a transfer is raised only — a person dispatches it, another receives it', async () => {
    const { routes, calls } = fakeRoutes();
    const r = await autoApprovePlacer({ store: new InMemoryEventStore(), now: () => NOW, routes: () => routes })(T, decided({ proposalId: 'a03-transfer-SOAP', kind: 'stock_transfer' }), transfer);
    expect(r).toMatchObject({ placed: true, reference: referenceFor('a03-transfer-SOAP', 'tr-auto') });
    expect(calls).toEqual([{ path: '/v1/warehouse/transfers/:transferId', userId: RULE_IDENTITY, params: { transferId: referenceFor('a03-transfer-SOAP', 'tr-auto') }, body: { fromLocationId: 'wh-1', toLocationId: 'br-1', lines: [{ productId: 'SOAP', quantityMinor: 24, uom: 'ea' }] } }]);
  });

  it('an act that does not say exactly what to do is never placed', async () => {
    const { routes, calls } = fakeRoutes();
    const place = autoApprovePlacer({ store: new InMemoryEventStore(), now: () => NOW, routes: () => routes });
    expect(await place(T, decided({ proposalId: 'p-1' }), { ...reorder, deliverToLocationId: undefined } as DraftAct)).toMatchObject({ placed: false, code: 'act_not_exact' });
    expect(await place(T, decided({ proposalId: 'p-2' }), { ...markdown, mrpMinor: undefined } as DraftAct)).toMatchObject({ placed: false, code: 'act_not_exact' });
    expect(calls).toEqual([]);
  });
});

describe('the rule identity is fenced in', () => {
  it('holds only the four permissions of its routes, and may call only those routes', () => {
    expect([...AUTO_APPROVE_RULE_ROLE.permissions].sort()).toEqual(['inventory.movement.append', 'price.change.propose', 'purchase.order.approve', 'purchase.order.propose']);
    expect(RULE_ROUTES.map((r) => r.path)).toEqual(['/v1/purchase/orders/:poId', '/v1/purchase/orders/:poId/approval', '/v1/prices/changes', '/v1/warehouse/transfers/:transferId']);
  });

  it('a route that asks for a permission the rule does not hold is refused before it runs', async () => {
    const { routes, calls } = fakeRoutes();
    const swapped = routes.map((r) => (r.path === '/v1/prices/changes' ? { ...r, permission: 'refund.issue' as never } : r));
    const r = await autoApprovePlacer({ store: new InMemoryEventStore(), now: () => NOW, routes: () => swapped })(T, decided({ proposalId: 'p-3', kind: 'markdown_short_dated' }), markdown);
    expect(r).toMatchObject({ placed: false, code: 'rule_lacks_permission' });
    expect(calls).toEqual([]);
  });

  it('a route that needs a fresh sign-in is never called by the rule', async () => {
    const { routes, calls } = fakeRoutes();
    const stepUp = routes.map((r) => (r.path === '/v1/warehouse/transfers/:transferId' ? { ...r, reauth: { maxAgeSeconds: 300 } as never } : r));
    const r = await autoApprovePlacer({ store: new InMemoryEventStore(), now: () => NOW, routes: () => stepUp })(T, decided({ proposalId: 'p-4', kind: 'stock_transfer' }), transfer);
    expect(r).toMatchObject({ placed: false, code: 'needs_a_person_to_sign_in_again' });
    expect(calls).toEqual([]);
  });

  it('the rule\'s purchase-order authority is its limit — only while it is placing', async () => {
    const base = async (_t: string, userId: string, subjectType: string) => ({ userId, subjectType, limitedAs: 'purchase_order' as const, state: 'not_set' as const, limitMinor: null, fromRole: null, rulesVersion: 0 });
    const authorityOf = ruleAwareAuthority(base)!;
    // Outside a placement — even a token that CALLS itself the rule — the ordinary answer.
    expect((await authorityOf(T, RULE_IDENTITY, 'purchase_order')).state).toBe('not_set');
    const seen: unknown[] = [];
    const watch: Route = {
      api: 'API-03', method: 'POST', path: '/v1/purchase/orders/:poId', permission: 'purchase.order.propose' as never, idempotent: true,
      handler: async (ctx) => { seen.push(await authorityOf(ctx.tenantId, ctx.userId, 'purchase_order')); return { status: 201, body: { order: { status: 'issued' } } }; },
    };
    const { routes } = fakeRoutes();
    await autoApprovePlacer({ store: new InMemoryEventStore(), now: () => NOW, routes: () => [watch, ...routes.slice(1)] })(T, decided({ proposalId: 'p-5' }), reorder);
    expect(seen[0]).toMatchObject({ state: 'limit', limitMinor: 500_000 });
    expect((await authorityOf(T, RULE_IDENTITY, 'purchase_order')).state).toBe('not_set');
  });
});

describe('the sweep records the rule\'s approval only once the route placed it', () => {
  function memoryStore(): AutoApproveStore & { decided: unknown[] } {
    const requests: AutoApproveRequest[] = [
      { requestId: 'r1', action: 'set_limit', kind: 'reorder_from_approved_supplier', limit: 500_000, basedOnVersion: 0, reason: 'small reorders', requestedBy: 'u-owner', requestedAt: '2026-11-14T04:00:00.000Z' },
      { requestId: 'r2', action: 'resume', basedOnVersion: 0, reason: 'start', requestedBy: 'u-owner', requestedAt: '2026-11-14T04:00:00.000Z' },
    ];
    const confirmations = requests.map((r) => ({ requestId: r.requestId, decision: 'confirmed' as const, by: 'u-accountant', at: '2026-11-14T04:01:00.000Z' }));
    const stops: AutoApproveStop[] = [];
    const decided: unknown[] = [];
    return {
      decided,
      requests: async () => requests, confirmations: async () => confirmations, stops: async () => stops,
      recordRequest: async () => {}, recordConfirmation: async () => {}, recordStop: async (_t, s) => { stops.push(s); },
      decisions: async () => decided as never, recordDecision: async (_t, d) => { decided.push(d); },
    };
  }
  const open: OpenDraft = { proposalId: 'a02-x', agent: 'A02', act: reorder, evidence: [{}], createdAt: '2026-11-14T05:59:00.000Z' };
  const base = (store: AutoApproveStore, place: Parameters<typeof sweepDrafts>[0]['place']) => ({
    store, openProposals: () => [open], decidedProposalIds: async () => new Set<string>(), aiStopped: () => false,
    now: () => NOW, newId: () => 'id', ...(place === undefined ? {} : { place }),
  });

  it('placed → approved by the rule, with what was placed', async () => {
    const store = memoryStore();
    const [d] = await sweepDrafts(base(store, async () => ({ placed: true, route: 'POST /v1/purchase/orders/:poId', reference: 'po-auto-1', by: RULE_IDENTITY, detail: 'raised and issued' })), T);
    expect(d).toMatchObject({ outcome: 'auto_approved', placed: { reference: 'po-auto-1' } });
    expect(store.decided).toEqual([d]);
  });

  it('refused by the route → waits for a person, with the route\'s reason', async () => {
    const store = memoryStore();
    const [d] = await sweepDrafts(base(store, async () => ({ placed: false, route: 'POST /v1/purchase/orders/:poId', code: 'supplier_blocked', reason: 'The supplier is on hold.' })), T);
    expect(d).toMatchObject({ outcome: 'waits_for_a_person', because: 'refused_by_route', refusedBy: { code: 'supplier_blocked', ruleId: 'reorder_from_approved_supplier-v1' } });
    expect(d!.detail).toMatch(/The supplier is on hold/);
    expect(store.decided).toEqual([d]);
  });

  it('a stop pulled before the act is placed stops it: nothing is placed', async () => {
    const store = memoryStore();
    let placed = 0;
    const stopFirst: AutoApproveStore = { ...store, stops: async () => [{ stopId: 's', by: 'u-manager', at: '2026-11-14T05:00:00.000Z', reason: 'checking' }] };
    // The first read (the sweep's) sees it running; the read just before placing sees the stop.
    let reads = 0;
    const flipping: AutoApproveStore = { ...store, stops: async (t) => (reads++ === 0 ? store.stops(t) : stopFirst.stops(t)) };
    const [d] = await sweepDrafts(base(flipping, async () => { placed += 1; return { placed: true, route: 'x', reference: 'y', by: RULE_IDENTITY, detail: '' }; }), T);
    expect(placed).toBe(0);
    expect(d).toMatchObject({ outcome: 'waits_for_a_person', because: 'auto_approval_stopped' });
  });

  it('without a placer (step 6a) the approval is only recorded, as before', async () => {
    const store = memoryStore();
    const [d] = await sweepDrafts(base(store, undefined), T);
    expect(d).toMatchObject({ outcome: 'auto_approved' });
    expect((d as { placed?: unknown }).placed).toBeUndefined();
    // foldAutoApprove still the one source of the rules.
    expect(foldAutoApprove({ requests: await store.requests(T), confirmations: await store.confirmations(T), stops: [] }).running).toBe(true);
  });
});
