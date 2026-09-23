import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// API-07 M18-FR-02 — the backorder write path, end to end through the real API. A promise reserves
// what the shelf allows and tells the customer before they pay; the un-promised remainder must NOT
// silently vanish (P-08 no silent failure). This records that remainder append-only as a backorder,
// computed as ORDERED minus what is actually RESERVED for the order — a fact already on the ledger,
// so recording it can never oversell. A fully-held order has nothing to backorder (200, records
// nothing); a partly- or un-held one records the exact shortfall (201) and can be read back. A
// backorder on a finished order is refused, the shortfall is recorded once (append-only), and the
// write is gated on order.backorder.manage. Proves the wired services/orders surface against the
// real pipeline, real per-tenant RBAC and stock projected from the real inventory ledger.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-08-07T10:00:00.000Z';
const base = { locationId: 'L1', uom: 'each', occurredAt: AT, enteredBy: 'u-owner' };

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const move = (h: ApiHarness, user: string, m: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/inventory/movements', userId: user, tenantId: A, idempotencyKey: `mv-${String(m['movementId'])}`, body: m });

interface Line { productId: string; quantityMinor: number }
const promise = (h: ApiHarness, user: string, orderId: string, lines: Line[]) =>
  h.request({ method: 'POST', path: `/v1/orders/${orderId}/promise`, userId: user, tenantId: A, idempotencyKey: `pr-${orderId}`, body: { lines, locationId: 'L1' } });

const backorder = (h: ApiHarness, user: string, orderId: string, key = `bo-${orderId}`) =>
  h.request({ method: 'POST', path: `/v1/orders/${orderId}/backorder`, userId: user, tenantId: A, idempotencyKey: key, body: {} });

const readBackorders = (h: ApiHarness, user: string, orderId: string) =>
  h.request({ method: 'GET', path: `/v1/orders/${orderId}/backorders`, userId: user, tenantId: A });

const transition = (h: ApiHarness, user: string, orderId: string, event: string) =>
  h.request({ method: 'POST', path: `/v1/orders/${orderId}/transition`, userId: user, tenantId: A, idempotencyKey: `tx-${orderId}-${event}`, body: { event } });

interface BackorderLine { productId: string; requestedMinor: number; reservedMinor: number; shortfallMinor: number }
interface BackorderBody { orderId: string; outcome: string; lines: BackorderLine[]; at?: string }

describe('order backorder write path (M18-FR-02)', () => {
  it('records the exact shortfall of a partial promise, and can read it back', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, 'u-owner', { movementId: 'r1', productId: 'RICE', kind: 'received', quantityMinor: 3, ...base });

    // Ordered 5, only 3 on the shelf → promised 3, short 2.
    const promised = (await promise(h, 'u-owner', 'o1', [{ productId: 'RICE', quantityMinor: 5 }])).body as { outcome: string };
    expect(promised.outcome).toBe('partially_promised');

    const res = await backorder(h, 'u-owner', 'o1');
    expect(res.status).toBe(201);
    const body = res.body as BackorderBody;
    expect(body.outcome).toBe('backordered');
    expect(body.lines).toEqual([{ productId: 'RICE', requestedMinor: 5, reservedMinor: 3, shortfallMinor: 2 }]);
    expect(body.at).toBeDefined();

    // The exception is visible, not buried — the read route returns exactly what was recorded.
    const read = await readBackorders(h, 'u-owner', 'o1');
    expect(read.status).toBe(200);
    expect((read.body as { backorders: BackorderBody[] }).backorders).toHaveLength(1);
    expect((read.body as { backorders: BackorderBody[] }).backorders[0]?.lines).toEqual(body.lines);
  });

  it('backorders the whole order when nothing could be reserved', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // No stock at all: the promise reserves nothing but still records the order.
    const promised = (await promise(h, 'u-owner', 'o2', [{ productId: 'RICE', quantityMinor: 4 }])).body as { outcome: string };
    expect(promised.outcome).toBe('cannot_promise');

    const res = await backorder(h, 'u-owner', 'o2');
    expect(res.status).toBe(201);
    expect((res.body as BackorderBody).lines).toEqual([{ productId: 'RICE', requestedMinor: 4, reservedMinor: 0, shortfallMinor: 4 }]);
  });

  it('records nothing — and errors nothing — when the whole order is held', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, 'u-owner', { movementId: 'r3', productId: 'RICE', kind: 'received', quantityMinor: 10, ...base });
    const promised = (await promise(h, 'u-owner', 'o3', [{ productId: 'RICE', quantityMinor: 5 }])).body as { outcome: string };
    expect(promised.outcome).toBe('promised');

    const res = await backorder(h, 'u-owner', 'o3');
    expect(res.status).toBe(200);
    expect((res.body as BackorderBody).outcome).toBe('nothing_to_backorder');
    // Nothing was recorded, so there is nothing to read.
    expect((await readBackorders(h, 'u-owner', 'o3')).status).toBe(200);
    expect(((await readBackorders(h, 'u-owner', 'o3')).body as { backorders: BackorderBody[] }).backorders).toEqual([]);
  });

  it('records the shortfall once — a second backorder on the same order is refused (append-only)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, 'u-owner', { movementId: 'r4', productId: 'RICE', kind: 'received', quantityMinor: 1, ...base });
    await promise(h, 'u-owner', 'o4', [{ productId: 'RICE', quantityMinor: 5 }]);

    expect((await backorder(h, 'u-owner', 'o4', 'bo-4a')).status).toBe(201);
    const again = await backorder(h, 'u-owner', 'o4', 'bo-4b');
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('already_backordered');
  });

  it('refuses a backorder on an unknown order and on a finished (cancelled) one', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const unknown = await backorder(h, 'u-owner', 'ghost');
    expect(unknown.status).toBe(404);
    expect(codeOf(unknown)).toBe('order_unknown');

    await promise(h, 'u-owner', 'o5', [{ productId: 'RICE', quantityMinor: 5 }]);
    await transition(h, 'u-owner', 'o5', 'cancel');
    const finished = await backorder(h, 'u-owner', 'o5');
    expect(finished.status).toBe(409);
    expect(codeOf(finished)).toBe('order_finished');
  });

  it('gates the write on order.backorder.manage and the read on order.read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await move(h, 'u-owner', { movementId: 'r6', productId: 'RICE', kind: 'received', quantityMinor: 1, ...base });
    await promise(h, 'u-owner', 'o6', [{ productId: 'RICE', quantityMinor: 5 }]);

    // A cashier holds no order authority: cannot record a backorder, cannot read one.
    expect((await backorder(h, 'u-cash', 'o6', 'bo-cash')).status).toBe(403);
    expect((await readBackorders(h, 'u-cash', 'o6')).status).toBe(403);
  });
});
