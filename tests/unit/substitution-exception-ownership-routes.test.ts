import { describe, it, expect } from 'vitest';
import {
  exceptionOwnershipRoutes, queuesStaffedBy, exceptionIdFor, presentWorklist, ownedWorklist,
  type ExceptionOwnershipDeps,
} from '../../services/orders/src/exception-ownership';
import type { OrdersDeps, StoredSubstitution } from '../../services/orders/src/index';
import { DEFAULT_SLA, type OwnedException } from '../../packages/orders/src/substitution-exception-ownership';
import type { RequestContext, Route } from '../../services/kernel/src/index';

// M19-FR-01 / Item 2 (owner decision) — the ownership engine on the API. The engine's rules are proven in
// `orders-substitution-exception-ownership.test.ts`; what is proven here is the wiring: the worklist carries
// ownership, an untouched exception is routed on the fly and KEPT only once a person acts, who may work which
// queue, the moves, the sweep, and that every kept state is append-only and re-attaches by exception id.

const T = 't-sre';
const AT = '2026-10-10T09:00:00.000Z';
let NOW = '2026-10-10T09:10:00.000Z';

const swap = (over: Partial<StoredSubstitution> = {}): StoredSubstitution => ({
  orderId: 'ord-a', lineId: 'l1', decision: 'confirmed', outcome: 'substituted', pickProductId: 'MILK-ALT', pickQuantityMinor: 2,
  chargeMinor: 8_000, refundMinor: 2_000, at: AT, tender: 'prepaid', settlementKind: 'prepaid_refund', settlementMinor: 2_000, aboveCap: false, ...over,
} as StoredSubstitution);

function stub(subs: readonly StoredSubstitution[], roles: Record<string, readonly string[]>) {
  const kept: OwnedException[] = [];
  const deps = {
    now: () => NOW, allSubstitutions: () => subs,
    ownedExceptions: () => {
      // latest per exception id — exactly what the adapter folds
      const m = new Map<string, OwnedException>();
      for (const o of kept) m.set(o.exceptionId, o);
      return [...m.values()];
    },
    recordOwnedException: (_t: string, o: OwnedException) => { kept.push(o); },
    rolesOf: (_t: string, u: string) => roles[u] ?? [],
  } as unknown as OrdersDeps & ExceptionOwnershipDeps;
  return { kept, deps, routes: exceptionOwnershipRoutes(deps) };
}
const ctx = (over: Partial<RequestContext> = {}): RequestContext =>
  ({ tenantId: T, userId: 'u-mgr', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over });
const routeFor = (routes: readonly Route[], method: string, path: string): Route => {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (r === undefined) throw new Error(`no route ${method} ${path}`);
  return r;
};
interface Thrown { readonly status: number; readonly body: { readonly code: string; readonly whatHappened: string } }
const thrown = async (fn: () => unknown): Promise<Thrown> => {
  try { await fn(); } catch (e) { return e as Thrown; }
  throw new Error('expected a refusal');
};
const ROLES = { 'u-mgr': ['store_manager'], 'u-acct': ['accountant'], 'u-cash': ['cashier'], 'u-nobody': ['supplier'] };
// ord-a: cheaper prepaid swap → refund_due 2000 (finance); ord-b: above-cap COD → above_cap_charge 8000 (finance);
// ord-c: policy-refused → policy_short_pick 0 (customer-service desk).
const SUBS: StoredSubstitution[] = [
  swap(),
  swap({ orderId: 'ord-b', refundMinor: 0, chargeMinor: 18_000, tender: 'cod', settlementKind: 'collect_more', settlementMinor: 8_000, aboveCap: true }),
  swap({ orderId: 'ord-c', outcome: 'short_picked', pickProductId: null, pickQuantityMinor: 0, chargeMinor: 0, refundMinor: 0, eligibility: 'refused', tender: undefined, settlementKind: undefined, settlementMinor: undefined, aboveCap: undefined }),
];
const ID_A = exceptionIdFor({ orderId: 'ord-a', lineId: 'l1', kind: 'refund_due' });
const ID_B = exceptionIdFor({ orderId: 'ord-b', lineId: 'l1', kind: 'above_cap_charge' });
const ID_C = exceptionIdFor({ orderId: 'ord-c', lineId: 'l1', kind: 'policy_short_pick' });

describe('who staffs which queue', () => {
  it('management staffs every queue; the accountant the finance queue; the service desk the customer-service queue; a supplier none', () => {
    expect(queuesStaffedBy(['store_manager'])).toEqual(['fulfilment_supervisor', 'customer_service_desk', 'finance_recon_queue', 'duty_manager']);
    expect(queuesStaffedBy(['accountant'])).toEqual(['finance_recon_queue']);
    expect(queuesStaffedBy(['cashier'])).toEqual(['customer_service_desk']);
    expect(queuesStaffedBy(['supplier'])).toEqual([]);
    expect(queuesStaffedBy(['cashier', 'accountant'])).toEqual(['customer_service_desk', 'finance_recon_queue']);
  });
});

describe('the worklist carries ownership', () => {
  it('routes every derived exception to its queue on the fly, keeps the engine\'s totals, and adds open totals + queue counts', async () => {
    const s = stub(SUBS, ROLES);
    const res = await routeFor(s.routes, 'GET', '/v1/orders/substitution-exceptions').handler(ctx());
    const body = res.body as ReturnType<typeof presentWorklist>;
    expect(body.count).toBe(3);
    expect(body.atRiskMinor).toBe(10_000);
    expect(body.exceptions.map((e) => [e.exceptionId, e.owner, e.state, e.sla.breached])).toEqual([
      [ID_B, 'finance_recon_queue', 'open', false],
      [ID_A, 'finance_recon_queue', 'open', false],
      [ID_C, 'customer_service_desk', 'open', false],
    ]);
    expect(body.exceptions[0]!.raisedAt).toBe(AT); // as old as the swap that caused it
    expect(body.exceptions[0]!.history).toEqual([{ op: 'routed', at: AT, by: 'system', toOwner: 'finance_recon_queue', reasonCode: 'SUB-ABOVE-CAP', detail: expect.any(String) }]);
    expect(body.open).toEqual({ count: 3, atRiskMinor: 10_000, breached: 0 });
    expect(body.queues).toEqual({ fulfilment_supervisor: 0, customer_service_desk: 1, finance_recon_queue: 2, duty_manager: 0 });
    expect(s.kept).toHaveLength(0); // a read writes nothing
  });

  it('one role\'s queue is worst-first and open-only; an unknown queue is refused by name', async () => {
    const s = stub(SUBS, ROLES);
    const q = await routeFor(s.routes, 'GET', '/v1/orders/substitution-exceptions/queue/:owner').handler(ctx({ params: { owner: 'finance_recon_queue' } }));
    expect(q.body).toMatchObject({ owner: 'finance_recon_queue', count: 2, atRiskMinor: 10_000, breached: 0 });
    const bad = await thrown(() => routeFor(s.routes, 'GET', '/v1/orders/substitution-exceptions/queue/:owner').handler(ctx({ params: { owner: 'pickers' } })));
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('unknown_queue');
  });
});

describe('the moves — and who may make them', () => {
  it('claim → in_progress under the claimant, KEPT; release → back to the queue; the worklist re-attaches the kept state by id', async () => {
    const s = stub(SUBS, ROLES);
    const claimed = await routeFor(s.routes, 'POST', '/v1/orders/substitution-exceptions/:exceptionId/claim').handler(ctx({ userId: 'u-acct', params: { exceptionId: ID_A } }));
    expect(claimed.body).toMatchObject({ exception: { exceptionId: ID_A, state: 'in_progress', assignedTo: 'u-acct', owner: 'finance_recon_queue' } });
    expect(s.kept).toHaveLength(1);
    const list = (await routeFor(s.routes, 'GET', '/v1/orders/substitution-exceptions').handler(ctx())).body as ReturnType<typeof presentWorklist>;
    expect(list.exceptions.find((e) => e.exceptionId === ID_A)).toMatchObject({ state: 'in_progress', assignedTo: 'u-acct' });
    const released = await routeFor(s.routes, 'POST', '/v1/orders/substitution-exceptions/:exceptionId/release').handler(ctx({ userId: 'u-acct', params: { exceptionId: ID_A }, body: { reasonCode: 'shift_end' } }));
    expect(released.body).toMatchObject({ exception: { state: 'open', owner: 'finance_recon_queue' } });
    expect((released.body as { exception: OwnedException }).exception.assignedTo).toBeUndefined();
    expect((released.body as { exception: OwnedException }).exception.history.map((h) => h.op)).toEqual(['routed', 'claimed', 'released']);
    expect(s.kept).toHaveLength(2); // append-only: two kept states, never an edit
  });

  it('a caller may work only a queue their role staffs — the service desk cannot claim a finance item, management can claim anything, a supplier nothing', async () => {
    const s = stub(SUBS, ROLES);
    const claimRoute = routeFor(s.routes, 'POST', '/v1/orders/substitution-exceptions/:exceptionId/claim');
    const wrong = await thrown(() => claimRoute.handler(ctx({ userId: 'u-cash', params: { exceptionId: ID_A } })));
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('not_your_queue');
    expect(wrong.body.whatHappened).toMatch(/finance recon queue/);
    expect((await claimRoute.handler(ctx({ userId: 'u-cash', params: { exceptionId: ID_C } }))).body).toMatchObject({ exception: { state: 'in_progress', assignedTo: 'u-cash' } });
    expect((await claimRoute.handler(ctx({ userId: 'u-mgr', params: { exceptionId: ID_B } }))).body).toMatchObject({ exception: { state: 'in_progress', assignedTo: 'u-mgr' } });
    const none = await thrown(() => claimRoute.handler(ctx({ userId: 'u-nobody', params: { exceptionId: ID_C } })));
    expect(none.body.whatHappened).toMatch(/staffs no exception queue/);
    expect(s.kept).toHaveLength(2);
  });

  it('reassign moves the item to another queue with a reason (management only by permission; unreadable body refused); resolve records the outcome; twice is 409', async () => {
    const s = stub(SUBS, ROLES);
    const reassign = routeFor(s.routes, 'POST', '/v1/orders/substitution-exceptions/:exceptionId/reassign');
    const bad = await thrown(() => reassign.handler(ctx({ params: { exceptionId: ID_C }, body: { toOwner: 'finance_recon_queue' } })));
    expect(bad.status).toBe(400);
    const moved = await reassign.handler(ctx({ params: { exceptionId: ID_C }, body: { toOwner: 'fulfilment_supervisor', reasonCode: 'needs_repick' } }));
    expect(moved.body).toMatchObject({ exception: { owner: 'fulfilment_supervisor', state: 'open' } });
    // The service desk no longer staffs it.
    const gone = await thrown(() => routeFor(s.routes, 'POST', '/v1/orders/substitution-exceptions/:exceptionId/claim').handler(ctx({ userId: 'u-cash', params: { exceptionId: ID_C } })));
    expect(gone.body.code).toBe('not_your_queue');
    const resolve = routeFor(s.routes, 'POST', '/v1/orders/substitution-exceptions/:exceptionId/resolve');
    const done = await resolve.handler(ctx({ params: { exceptionId: ID_C }, body: { reasonCode: 'repicked', detail: 'line repicked from the back store' } }));
    expect(done.body).toMatchObject({ exception: { state: 'resolved' } });
    expect((done.body as { exception: OwnedException }).exception.history.at(-1)).toMatchObject({ op: 'resolved', by: 'u-mgr', reasonCode: 'repicked' });
    const again = await thrown(() => resolve.handler(ctx({ params: { exceptionId: ID_C } })));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_resolved');
    // A resolved item leaves the open totals but stays visible.
    const list = (await routeFor(s.routes, 'GET', '/v1/orders/substitution-exceptions').handler(ctx())).body as ReturnType<typeof presentWorklist>;
    expect(list.count).toBe(3);
    expect(list.open).toEqual({ count: 2, atRiskMinor: 10_000, breached: 0 });
    expect(list.exceptions.find((e) => e.exceptionId === ID_C)).toMatchObject({ state: 'resolved' });
    // And cannot be claimed or reassigned any more.
    expect((await thrown(() => routeFor(s.routes, 'POST', '/v1/orders/substitution-exceptions/:exceptionId/claim').handler(ctx({ params: { exceptionId: ID_C } })))).status).toBe(409);
    expect((await thrown(() => reassign.handler(ctx({ params: { exceptionId: ID_C }, body: { toOwner: 'duty_manager', reasonCode: 'x' } })))).status).toBe(409);
  });

  it('an unknown exception is a plain 404', async () => {
    const s = stub(SUBS, ROLES);
    const r = await thrown(() => routeFor(s.routes, 'POST', '/v1/orders/substitution-exceptions/:exceptionId/claim').handler(ctx({ params: { exceptionId: 'ord-z:l9:refund_due' } })));
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('exception_unknown');
  });
});

describe('the escalation sweep', () => {
  it('moves every breached, unresolved exception to the next owner, keeps each move, names what is stuck at the duty manager, and is quiet when nothing is late', async () => {
    const s = stub(SUBS, ROLES);
    const sweep = routeFor(s.routes, 'POST', '/v1/orders/substitution-exceptions/escalate');
    NOW = '2026-10-10T09:10:00.000Z';
    expect((await sweep.handler(ctx())).body).toMatchObject({ escalatedIds: [], breachedAtDutyManager: [], detail: 'nothing is past its SLA' });
    expect(s.kept).toHaveLength(0);
    // 45 minutes on: the 30-minute customer-service SLA is breached, finance's 120 is not.
    NOW = '2026-10-10T09:45:00.000Z';
    const first = await sweep.handler(ctx());
    expect(first.body).toMatchObject({ escalatedIds: [ID_C], escalated: [{ exceptionId: ID_C, toOwner: 'fulfilment_supervisor', amountMinor: 0 }] });
    expect(s.kept).toHaveLength(1);
    // 3 hours on: finance items (120m) breach → duty manager; the supervisor item (60m from its ORIGINAL raise) breaches too → duty manager.
    NOW = '2026-10-10T12:05:00.000Z';
    const second = await sweep.handler(ctx());
    expect((second.body as { escalatedIds: string[] }).escalatedIds.sort()).toEqual([ID_A, ID_B, ID_C].sort());
    const list = (await routeFor(s.routes, 'GET', '/v1/orders/substitution-exceptions').handler(ctx())).body as ReturnType<typeof presentWorklist>;
    expect(list.queues).toEqual({ fulfilment_supervisor: 0, customer_service_desk: 0, finance_recon_queue: 0, duty_manager: 3 });
    // The duty manager's 240-minute SLA runs from the ORIGINAL raise (09:00), so at 12:05 nothing is breached yet.
    expect(list.open.breached).toBe(0);
    expect(list.exceptions.every((e) => e.sla.dueAt === '2026-10-10T13:00:00.000Z')).toBe(true);
    // 8 hours on: everything sits breached at the terminal owner — reported, not moved, not dropped.
    NOW = '2026-10-10T17:05:00.000Z';
    const third = await sweep.handler(ctx());
    expect(third.body).toMatchObject({ escalatedIds: [] });
    expect((third.body as { breachedAtDutyManager: string[] }).breachedAtDutyManager.sort()).toEqual([ID_A, ID_B, ID_C].sort());
    NOW = '2026-10-10T09:10:00.000Z';
  });

  it('a resolved item is never swept, and the kept state keeps its whole history', async () => {
    const s = stub(SUBS, ROLES);
    await routeFor(s.routes, 'POST', '/v1/orders/substitution-exceptions/:exceptionId/resolve').handler(ctx({ params: { exceptionId: ID_C } }));
    NOW = '2026-10-10T17:05:00.000Z';
    const swept = await routeFor(s.routes, 'POST', '/v1/orders/substitution-exceptions/escalate').handler(ctx());
    expect((swept.body as { escalatedIds: string[] }).escalatedIds.sort()).toEqual([ID_A, ID_B]);
    const { items } = await ownedWorklist(s.deps, T, NOW);
    expect(items.find((o) => o.exceptionId === ID_C)).toMatchObject({ state: 'resolved', owner: 'customer_service_desk' });
    expect(items.find((o) => o.exceptionId === ID_A)!.history.map((h) => h.op)).toEqual(['routed', 'escalated']);
    NOW = '2026-10-10T09:10:00.000Z';
  });
});

describe('the presentation is a pure function of kept + derived', () => {
  it('a kept item whose swap is gone from the derived list is not shown (nothing at stake any more)', () => {
    const w = presentWorklist([], { exceptions: [], count: 0, atRiskMinor: 0 }, DEFAULT_SLA, NOW);
    expect(w).toEqual({ exceptions: [], count: 0, atRiskMinor: 0, open: { count: 0, atRiskMinor: 0, breached: 0 }, queues: { fulfilment_supervisor: 0, customer_service_desk: 0, finance_recon_queue: 0, duty_manager: 0 } });
  });
});
