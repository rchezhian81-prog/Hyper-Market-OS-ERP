import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';

/**
 * M19-FR-01 / Item 2 (owner decision) — delivery-substitution exception OWNERSHIP on the real API.
 *
 * The engine's rules live in the unit suites. What is proven here: the shop-wide worklist now carries who owns each
 * exception, by when and its history; a person's moves are KEPT and re-attach after a cold restart; who may work
 * which queue is decided from the caller's grants; the sweep answers; and the permissions hold (a customer sees
 * none of it, the service desk cannot reassign).
 */
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19';
const LOC = 'store-1';
const OWNER = 'u-owner'; const ACCT = 'u-acct'; const CASH = 'u-cash'; const CUST = 'u-cust';

const place = (h: ApiHarness, u: string, orderId: string) =>
  h.request({ method: 'POST', path: `/v1/orders/${orderId}/promise`, userId: u, tenantId: A, idempotencyKey: `place-${orderId}`, body: { lines: [{ productId: 'MILK', quantityMinor: 2 }], locationId: LOC } });
const offer = (over: Record<string, unknown> = {}) => ({
  lineId: 'l1', orderedProductId: 'MILK', orderedName: 'Milk 1L', orderedUnitPriceMinor: 5_000, orderedQuantityMinor: 2,
  substituteProductId: 'MILK-ALT', substituteName: 'Milk 1L alt', substituteUnitPriceMinor: 4_000, substituteQuantityMinor: 2,
  offeredAt: '2026-09-24T10:00:00.000Z', ...over,
});
const orderedAttrs = { productId: 'MILK', name: 'Milk 1L', brand: 'aavin', categoryId: 'dairy' };
const attrs = (over: Record<string, unknown> = {}) => ({ productId: 'MILK-ALT', name: 'Milk 1L alt', brand: 'arokya', categoryId: 'dairy', ...over });
const sub = (h: ApiHarness, u: string, orderId: string, body: unknown) =>
  h.request({ method: 'POST', path: `/v1/orders/${orderId}/substitute`, userId: u, tenantId: A, idempotencyKey: `sub-${orderId}`, body });
const get = (h: ApiHarness, path: string, u: string) => h.request({ method: 'GET', path, userId: u, tenantId: A });
const post = (h: ApiHarness, path: string, u: string, key: string, body?: unknown) =>
  h.request({ method: 'POST', path, userId: u, tenantId: A, idempotencyKey: key, ...(body === undefined ? {} : { body }) });

interface Item { exceptionId: string; owner: string; state: string; assignedTo?: string; sla: { breached: boolean; dueAt: string }; history: { op: string; by: string }[]; amountMinor: number }
interface Worklist { exceptions: Item[]; count: number; atRiskMinor: number; open: { count: number; atRiskMinor: number; breached: number }; queues: Record<string, number> }

async function seeded(store = new InMemoryEventStore()): Promise<ApiHarness> {
  const h = apiHarness({ store });
  await h.seedOwner(A, OWNER);
  await h.provisionRole(A, ACCT, 'accountant');
  await h.provisionRole(A, CASH, 'cashier');
  await h.provisionRole(A, CUST, 'customer');
  await place(h, OWNER, 'ord-a'); // cheaper prepaid swap → refund_due 2000 → finance queue
  await sub(h, OWNER, 'ord-a', { offer: offer(), decision: 'confirmed', rules: { preference: 'best_match' }, orderedAttrs, substituteAttrs: attrs(), tender: 'prepaid' });
  await place(h, OWNER, 'ord-c'); // policy-refused controlled item → policy_short_pick → customer-service desk
  await sub(h, OWNER, 'ord-c', { offer: offer(), decision: 'confirmed', rules: { preference: 'best_match' }, orderedAttrs, substituteAttrs: attrs({ ageRestricted: true }) });
  return h;
}
const ID_A = 'ord-a:l1:refund_due';
const ID_C = 'ord-c:l1:policy_short_pick';

describe('substitution exception ownership on the API (M19-FR-01, Item 2)', () => {
  it('the worklist carries each exception\'s queue, state, SLA and history; totals as before plus the open figures and queue counts', async () => {
    const h = await seeded();
    const res = await get(h, '/v1/orders/substitution-exceptions', OWNER);
    expect(res.status).toBe(200);
    const w = res.body as Worklist;
    expect(w.count).toBe(2);
    expect(w.atRiskMinor).toBe(2_000);
    expect(w.exceptions.map((e) => [e.exceptionId, e.owner, e.state, e.sla.breached])).toEqual([
      [ID_A, 'finance_recon_queue', 'open', false],
      [ID_C, 'customer_service_desk', 'open', false],
    ]);
    expect(w.exceptions[0]!.history).toEqual([expect.objectContaining({ op: 'routed', by: 'system', toOwner: 'finance_recon_queue' })]);
    expect(w.open).toEqual({ count: 2, atRiskMinor: 2_000, breached: 0 });
    expect(w.queues).toEqual({ fulfilment_supervisor: 0, customer_service_desk: 1, finance_recon_queue: 1, duty_manager: 0 });
  });

  it('a person\'s moves are KEPT, append-only, and re-attach to the worklist after a cold restart', async () => {
    const store = new InMemoryEventStore();
    const h = await seeded(store);
    const claimed = await post(h, `/v1/orders/substitution-exceptions/${ID_A}/claim`, ACCT, 'claim-a');
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({ exception: { exceptionId: ID_A, state: 'in_progress', assignedTo: ACCT, owner: 'finance_recon_queue' } });
    const released = await post(h, `/v1/orders/substitution-exceptions/${ID_A}/release`, ACCT, 'rel-a', { reasonCode: 'shift_end' });
    expect(released.body).toMatchObject({ exception: { state: 'open' } });
    const again = await post(h, `/v1/orders/substitution-exceptions/${ID_A}/claim`, OWNER, 'claim-a2');
    expect(again.body).toMatchObject({ exception: { state: 'in_progress', assignedTo: OWNER } });

    // Cold restart over the same store: the surface rebuilds and the kept state is exactly where it was left.
    const h2 = apiHarness({ store });
    const w = (await get(h2, '/v1/orders/substitution-exceptions', OWNER)).body as Worklist;
    const a = w.exceptions.find((e) => e.exceptionId === ID_A)!;
    expect(a).toMatchObject({ state: 'in_progress', assignedTo: OWNER });
    expect(a.history.map((x) => [x.op, x.by])).toEqual([['routed', 'system'], ['claimed', ACCT], ['released', ACCT], ['claimed', OWNER]]);
    // The finance queue view shows it too, and the desk queue does not.
    expect(((await get(h2, '/v1/orders/substitution-exceptions/queue/finance_recon_queue', ACCT)).body as { count: number }).count).toBe(1);
    expect(((await get(h2, '/v1/orders/substitution-exceptions/queue/customer_service_desk', CASH)).body as { exceptions: Item[] }).exceptions.map((e) => e.exceptionId)).toEqual([ID_C]);
  });

  it('who may work which queue is decided from the caller\'s grants: the desk cannot touch a finance item, the accountant cannot touch a desk item, management can touch anything', async () => {
    const h = await seeded();
    const wrong = await post(h, `/v1/orders/substitution-exceptions/${ID_A}/claim`, CASH, 'c1');
    expect(wrong.status).toBe(422);
    expect((wrong.body as { error: { code: string } }).error.code).toBe('not_your_queue');
    const wrong2 = await post(h, `/v1/orders/substitution-exceptions/${ID_C}/resolve`, ACCT, 'r1', { reasonCode: 'x' });
    expect(wrong2.status).toBe(422);
    expect((await post(h, `/v1/orders/substitution-exceptions/${ID_C}/claim`, CASH, 'c2')).status).toBe(200);
    expect((await post(h, `/v1/orders/substitution-exceptions/${ID_A}/claim`, OWNER, 'c3')).status).toBe(200);
  });

  it('resolve records the outcome under the resolver\'s name and takes the item out of the open figures; resolving twice is refused', async () => {
    const h = await seeded();
    const done = await post(h, `/v1/orders/substitution-exceptions/${ID_A}/resolve`, ACCT, 'res-a', { reasonCode: 'refund_issued', detail: 'refund issued on the refund surface' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ exception: { state: 'resolved' } });
    expect((done.body as { exception: Item }).exception.history.at(-1)).toMatchObject({ op: 'resolved', by: ACCT });
    const twice = await post(h, `/v1/orders/substitution-exceptions/${ID_A}/resolve`, OWNER, 'res-a2');
    expect(twice.status).toBe(409);
    const w = (await get(h, '/v1/orders/substitution-exceptions', OWNER)).body as Worklist;
    expect(w.count).toBe(2); // still visible
    expect(w.open).toEqual({ count: 1, atRiskMinor: 0, breached: 0 }); // but no longer at risk
    expect(w.exceptions.find((e) => e.exceptionId === ID_A)).toMatchObject({ state: 'resolved' });
  });

  it('reassign and the escalation sweep are management moves; the sweep answers honestly when nothing is late', async () => {
    const h = await seeded();
    const desk = await post(h, `/v1/orders/substitution-exceptions/${ID_C}/reassign`, CASH, 'ra1', { toOwner: 'fulfilment_supervisor', reasonCode: 'needs_repick' });
    expect(desk.status).toBe(403);
    const moved = await post(h, `/v1/orders/substitution-exceptions/${ID_C}/reassign`, OWNER, 'ra2', { toOwner: 'fulfilment_supervisor', reasonCode: 'needs_repick' });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ exception: { owner: 'fulfilment_supervisor', state: 'open' } });
    expect((await post(h, '/v1/orders/substitution-exceptions/escalate', CASH, 'sw1')).status).toBe(403);
    const swept = await post(h, '/v1/orders/substitution-exceptions/escalate', OWNER, 'sw2');
    expect(swept.status).toBe(200);
    expect(swept.body).toMatchObject({ escalatedIds: [], breachedAtDutyManager: [], detail: 'nothing is past its SLA' });
    const w = (await get(h, '/v1/orders/substitution-exceptions', OWNER)).body as Worklist;
    expect(w.queues).toEqual({ fulfilment_supervisor: 1, customer_service_desk: 0, finance_recon_queue: 1, duty_manager: 0 });
  });

  it('a customer reaches none of it, an unknown exception is a plain 404, and an unreadable reassignment is refused', async () => {
    const h = await seeded();
    expect((await get(h, '/v1/orders/substitution-exceptions', CUST)).status).toBe(403);
    expect((await get(h, '/v1/orders/substitution-exceptions/queue/finance_recon_queue', CUST)).status).toBe(403);
    expect((await post(h, `/v1/orders/substitution-exceptions/${ID_A}/claim`, CUST, 'x1')).status).toBe(403);
    const missing = await post(h, '/v1/orders/substitution-exceptions/ord-z:l9:refund_due/claim', OWNER, 'x2');
    expect(missing.status).toBe(404);
    const bad = await post(h, `/v1/orders/substitution-exceptions/${ID_A}/reassign`, OWNER, 'x3', { toOwner: 'pickers' });
    expect(bad.status).toBe(400);
  });
});
