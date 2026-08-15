import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// API-07 M18-FR-04 — the substitution write path. While picking, the picker offers a substitute and the
// customer confirms / declines / does not answer. The engine's rules are enforced at the boundary and the
// decision is RECORDED append-only on the order: no_answer is NOT a yes (silence short-picks, charges
// nothing); the customer never pays more for our failure to stock the item; a cheaper substitute leaves a
// refund DUE (a fact recorded here, issued downstream); a line is substituted once; a finished order refuses.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOC = 'store-1';

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

/** Place an order so it exists in the system (a promise that reserves nothing still records the order). */
const place = (h: ApiHarness, u: string, orderId: string) =>
  h.request({ method: 'POST', path: `/v1/orders/${orderId}/promise`, userId: u, tenantId: A, idempotencyKey: `place-${orderId}`,
    body: { lines: [{ productId: 'MILK', quantityMinor: 2 }], locationId: LOC } });

const offer = (over: Record<string, unknown> = {}) => ({
  lineId: 'l1', orderedProductId: 'MILK', orderedName: 'Milk 1L', orderedUnitPriceMinor: 5_000, orderedQuantityMinor: 2,
  substituteProductId: 'MILK-ALT', substituteName: 'Milk 1L alt', substituteUnitPriceMinor: 4_000, substituteQuantityMinor: 2,
  offeredAt: '2026-08-14T10:00:00.000Z', ...over,
});

const sub = (h: ApiHarness, u: string, orderId: string, body: unknown, key = `sub-${orderId}`) =>
  h.request({ method: 'POST', path: `/v1/orders/${orderId}/substitute`, userId: u, tenantId: A, idempotencyKey: key, body });

const transition = (h: ApiHarness, u: string, orderId: string, event: string) =>
  h.request({ method: 'POST', path: `/v1/orders/${orderId}/transition`, userId: u, tenantId: A, idempotencyKey: `txn-${orderId}-${event}`, body: { event } });

describe('order substitution write path (M18-FR-04)', () => {
  it('records a confirmed cheaper substitute — charged at the lower price, refund DUE', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await place(h, 'u-owner', 'ord-1');
    const res = await sub(h, 'u-owner', 'ord-1', { offer: offer(), decision: 'confirmed' });
    expect(res.status).toBe(201);
    const body = res.body as { outcome: string; pickProductId: string | null; chargeMinor: number; refundMinor: number; refundDue: boolean };
    expect(body.outcome).toBe('substituted');
    expect(body.pickProductId).toBe('MILK-ALT');
    expect(body.chargeMinor).toBe(8_000);  // min(substitute 8000, ordered 10000)
    expect(body.refundMinor).toBe(2_000);  // ordered 10000 - substitute 8000
    expect(body.refundDue).toBe(true);
  });

  it('a dearer substitute is charged at the ORIGINAL price — the customer never pays for our shortfall', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await place(h, 'u-owner', 'ord-2');
    const res = await sub(h, 'u-owner', 'ord-2', { offer: offer({ substituteUnitPriceMinor: 6_000 }), decision: 'confirmed' });
    expect(res.status).toBe(201);
    const body = res.body as { chargeMinor: number; refundMinor: number; refundDue: boolean };
    expect(body.chargeMinor).toBe(10_000); // charged the original line, not the dearer substitute
    expect(body.refundMinor).toBe(0);
    expect(body.refundDue).toBe(false);
  });

  it('no_answer is NOT a yes — the line is short-picked and charged nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await place(h, 'u-owner', 'ord-3');
    const res = await sub(h, 'u-owner', 'ord-3', { offer: offer(), decision: 'no_answer' });
    expect(res.status).toBe(201);
    const body = res.body as { outcome: string; chargeMinor: number; pickQuantityMinor: number };
    expect(body.outcome).toBe('not_confirmed');
    expect(body.chargeMinor).toBe(0);
    expect(body.pickQuantityMinor).toBe(0);
  });

  it('a declined substitute short-picks the line', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await place(h, 'u-owner', 'ord-4');
    const res = await sub(h, 'u-owner', 'ord-4', { offer: offer(), decision: 'declined' });
    expect((res.body as { outcome: string }).outcome).toBe('short_picked');
  });

  it('a line is substituted once — a second decision on the same line is refused (append-only)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await place(h, 'u-owner', 'ord-5');
    expect((await sub(h, 'u-owner', 'ord-5', { offer: offer(), decision: 'confirmed' }, 'sub-5a')).status).toBe(201);
    const again = await sub(h, 'u-owner', 'ord-5', { offer: offer(), decision: 'declined' }, 'sub-5b');
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('line_already_substituted');
    // A DIFFERENT line on the same order is fine.
    expect((await sub(h, 'u-owner', 'ord-5', { offer: offer({ lineId: 'l2' }), decision: 'confirmed' }, 'sub-5c')).status).toBe(201);
  });

  it('refuses a substitution on an unknown order and on a finished (cancelled) one', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const unknown = await sub(h, 'u-owner', 'ord-nope', { offer: offer(), decision: 'confirmed' });
    expect(unknown.status).toBe(404);
    expect(codeOf(unknown)).toBe('order_unknown');
    await place(h, 'u-owner', 'ord-6');
    await transition(h, 'u-owner', 'ord-6', 'cancel');
    const finished = await sub(h, 'u-owner', 'ord-6', { offer: offer(), decision: 'confirmed' });
    expect(finished.status).toBe(409);
    expect(codeOf(finished)).toBe('order_finished');
  });

  it('refuses a malformed substitution and gates on order.lifecycle.manage', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await place(h, 'u-owner', 'ord-7');
    const bad = await sub(h, 'u-owner', 'ord-7', { decision: 'confirmed' }); // no offer
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_substitution');
    expect((await sub(h, 'u-cash', 'ord-7', { offer: offer(), decision: 'confirmed' }, 'sub-7c')).status).toBe(403);
  });
});
