import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M16-FR-02 — the per-tenant segmentation POLICY store. The audience/value-ranking engines were stateless
// what-ifs: every call had to carry the boundaries (what counts as loyal/lapsing). This persists a tenant's
// policy ONCE so every query reads the shop's own definition — and an explicit body policy still overrides
// it, so a one-off "what if loyal meant 10 orders?" is still possible. Deepens M16 (the customer-profile
// fact persistence remains); no completion-% change.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const setPolicy = (h: ApiHarness, u: string, body: unknown, key = 'p1') =>
  h.request({ method: 'POST', path: '/v1/customer/segments/policy', userId: u, tenantId: A, idempotencyKey: key, body });
const getPolicy = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/customer/segments/policy', userId: u, tenantId: A });
const audience = (h: ApiHarness, u: string, body: unknown) =>
  h.request({ method: 'POST', path: '/v1/customer/segments/audience', userId: u, tenantId: A, idempotencyKey: `aud-${Math.random()}`, body });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code ?? (res.body as { code?: string }).code;

// A customer with three recent orders: 'loyal' when the tenant sets loyalAtOrders:3, 'regular' under the default 10.
const threeOrders = (ref: string) => [
  { orderId: `${ref}-1`, customerRef: ref, at: '2026-09-05T10:00:00.000Z', netMinor: 20000, marginMinor: 6000, channel: 'store' },
  { orderId: `${ref}-2`, customerRef: ref, at: '2026-09-09T10:00:00.000Z', netMinor: 20000, marginMinor: 6000, channel: 'store' },
  { orderId: `${ref}-3`, customerRef: ref, at: '2026-09-13T10:00:00.000Z', netMinor: 20000, marginMinor: 6000, channel: 'store' },
];
const consentProfiling = (ref: string) => [{ customerRef: ref, granted: ['profiling'] }];

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                     // holds customer.segment.manage + read
  await h.provisionRole(A, 'u-mgr', 'store_manager');  // holds manage + read too
  await h.provisionRole(A, 'u-cash', 'cashier');       // holds NEITHER
  return h;
}

describe('per-tenant segmentation policy store (M16-FR-02)', () => {
  it('a stored policy is read back, and defaults read as an unset {} (not a silent zero)', async () => {
    const h = await cast();
    expect((await getPolicy(h, 'u-owner')).body).toMatchObject({ policy: {}, set: false });

    expect((await setPolicy(h, 'u-owner', { loyalAtOrders: 3 })).status).toBe(201);
    expect((await getPolicy(h, 'u-owner')).body).toMatchObject({ policy: { loyalAtOrders: 3 }, set: true });
  });

  it('an audience with NO body policy reads the tenant\'s stored one', async () => {
    const h = await cast();
    await setPolicy(h, 'u-mgr', { loyalAtOrders: 3 }); // a store_manager may set it too

    // No policy in the body → the stored loyalAtOrders:3 applies, so C (3 orders) is "loyal".
    const res = (await audience(h, 'u-owner', { segment: 'loyal', purpose: 'profiling', orders: threeOrders('C'), consents: consentProfiling('C') })).body as { customerRefs: string[] };
    expect(res.customerRefs).toEqual(['C']);
  });

  it('an explicit body policy still overrides the stored one', async () => {
    const h = await cast();
    await setPolicy(h, 'u-owner', { loyalAtOrders: 3 });

    // Body says loyal means 10 orders → C (3 orders) is "regular", not "loyal".
    const res = (await audience(h, 'u-owner', { segment: 'loyal', purpose: 'profiling', orders: threeOrders('C'), consents: consentProfiling('C'), policy: { loyalAtOrders: 10 } })).body as { customerRefs: string[] };
    expect(res.customerRefs).toEqual([]);
  });

  it('setting the policy is manager-gated, and a bad boundary is refused', async () => {
    const h = await cast();
    expect((await setPolicy(h, 'u-cash', { loyalAtOrders: 3 })).status).toBe(403); // no customer.segment.manage
    expect((await getPolicy(h, 'u-cash')).status).toBe(403);                       // no customer.segment.read
    expect(codeOf(await setPolicy(h, 'u-owner', { loyalAtOrders: -1 }))).toBe('not_readable_as_a_segment_policy');
  });
});
