import { describe, it, expect } from 'vitest';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { loyaltyMemberKey, memberRefFor } from '../../packages/loyalty/src/index';

/**
 * **PF-11 (audit, HIGH · M21-FR-03 · §28): a granted compensation is carried out through the value records, once, and
 * where it stands is kept.**
 *
 * The audit found a goodwill grant recorded on the case and nowhere a customer could spend it. Now the grant (its
 * authority and second-person approval unchanged) is followed by its execution: goodwill credit becomes a spendable
 * store-credit instrument for the case's customer; loyalty points land on the customer's points at the owner's point
 * value; a money refund or a replacement is PENDING — paid or handed over at the desk, never marked done by this system.
 * A failed one (the point value not set) is carried out again later and nothing is given twice.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0f11';
const MEMBER = memberRefFor(loyaltyMemberKey(TEST_PACK_KEY), '98400 11111')!;

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  expect((await h.request({ method: 'POST', path: '/v1/service/cases/k1', userId: 'u-mgr', tenantId: A, idempotencyKey: 'open-k1', body: { kind: 'complaint', customerRef: MEMBER, priority: 'normal', summary: 'wrong item delivered', assignedTo: 'u-mgr' } })).status).toBeLessThan(300);
  return h;
}
const grant = (h: ApiHarness, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: '/v1/service/cases/k1/compensation', userId: 'u-mgr', tenantId: A, idempotencyKey: key, body });
const list = async (h: ApiHarness) =>
  ((await h.request({ method: 'GET', path: '/v1/service/cases/k1/compensations', userId: 'u-owner', tenantId: A })).body as { compensations: { compensationId: string; kind: string; fulfilment?: { status: string; ref?: string; detail: string } }[] }).compensations;

describe('PF-11: a granted compensation becomes value the customer can use — once', () => {
  it('goodwill credit is issued as spendable store credit to the case\'s customer; carrying it out again issues nothing twice', async () => {
    const h = await cast();
    const res = await grant(h, { kind: 'goodwill_credit', amountMinor: 20_000, reason: 'late delivery, apology' }, 'g1');
    expect(res.status).toBe(201);
    const body = res.body as { compensationId: string; fulfilment: { status: string; ref: string } };
    expect(body.fulfilment).toMatchObject({ status: 'completed' });
    const household = async () => ((await h.request({ method: 'GET', path: `/v1/stored-value/households/${MEMBER}/balance`, userId: 'u-owner', tenantId: A })).body as { balanceMinor: number }).balanceMinor;
    expect(await household()).toBe(20_000);
    const again = await h.request({ method: 'POST', path: `/v1/service/cases/k1/compensations/${body.compensationId}/fulfil`, userId: 'u-mgr', tenantId: A, idempotencyKey: 'again' });
    expect(again.status).toBe(200);
    expect(await household()).toBe(20_000);
    expect((await list(h))[0]).toMatchObject({ compensationId: body.compensationId, fulfilment: { status: 'completed', ref: body.fulfilment.ref } });
  });

  it('points fail plainly while the point value is unset, then are carried out once it is set — once', async () => {
    const h = await cast();
    const res = await grant(h, { kind: 'loyalty_points', amountMinor: 5_000, reason: 'goodwill points' }, 'p1');
    const body = res.body as { compensationId: string; fulfilment: { status: string; detail: string } };
    expect(body.fulfilment).toMatchObject({ status: 'failed' });
    expect(body.fulfilment.detail).toMatch(/not set what a point is worth/);
    expect((await h.request({ method: 'PUT', path: '/v1/platform/setup/loyalty.point_value_paise', userId: 'u-owner', tenantId: A, idempotencyKey: 'pv', body: { value: 100 } })).status).toBeLessThan(300);
    for (const key of ['retry-1', 'retry-2']) {
      const r = await h.request({ method: 'POST', path: `/v1/service/cases/k1/compensations/${body.compensationId}/fulfil`, userId: 'u-mgr', tenantId: A, idempotencyKey: key });
      expect((r.body as { fulfilment: { status: string } }).fulfilment.status).toBe('completed');
    }
    const points = ((await h.request({ method: 'GET', path: `/v1/customers/${MEMBER}/points`, userId: 'u-owner', tenantId: A })).body as { pointsBalance?: number }).pointsBalance;
    expect(points).toBe(50); // ₹50 at ₹1 a point — once, though carried out twice
  });

  it('a money refund and a replacement are pending at the desk — never marked paid by this system', async () => {
    const h = await cast();
    const refund = await grant(h, { kind: 'refund', amountMinor: 10_000, reason: 'charged twice' }, 'r1');
    expect((refund.body as { fulfilment: { status: string; detail: string } }).fulfilment).toMatchObject({ status: 'pending' });
    expect((refund.body as { fulfilment: { detail: string } }).fulfilment.detail).toMatch(/does not mark it paid/);
    const replacement = await grant(h, { kind: 'replacement', amountMinor: 5_000, reason: 'broken jar' }, 'x1');
    expect((replacement.body as { fulfilment: { status: string } }).fulfilment).toMatchObject({ status: 'pending' });
  });
});
