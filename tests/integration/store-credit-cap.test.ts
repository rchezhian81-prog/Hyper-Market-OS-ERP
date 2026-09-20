import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// The store-credit issuance cap (M13-FR-03 / M17) end to end through the real API + RBAC. Store credit
// is the shop taking on a liability, so how much a refund may create is the OWNER's per-tenant policy —
// server-sourced, owner-only, and fail-safe when unset (store-credit refunds stay unavailable until a cap
// exists, never a guessed default). This proves the config surface; issuing against it is a later slice.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const getCap = (h: ApiHarness, userId: string) =>
  h.request({ method: 'GET', path: '/v1/pos/store-credit-cap', userId, tenantId: A });
const setCap = (h: ApiHarness, userId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/pos/store-credit-cap', userId, tenantId: A, idempotencyKey: key, body });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  await h.provisionRole(A, 'u-cash', 'cashier');
  return h;
}

describe('the store-credit issuance cap is the owner\'s policy (M13-FR-03 / M17)', () => {
  it('is unset by default, and the desk reads that plainly (fail-safe)', async () => {
    const h = await cast();
    const r = await getCap(h, 'u-cash'); // a cashier may read the policy it works to
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ capMinor: null, isSet: false });
  });

  it('only the owner may set it; a cashier and a store manager cannot', async () => {
    const h = await cast();
    expect((await setCap(h, 'u-cash', { capMinor: 50_000 }, 'c-cash')).status).toBe(403);
    expect((await setCap(h, 'u-mgr', { capMinor: 50_000 }, 'c-mgr')).status).toBe(403);
    expect((await setCap(h, 'u-owner', { capMinor: 50_000 }, 'c-ok')).status).toBe(200);
    expect((await getCap(h, 'u-owner')).body).toMatchObject({ capMinor: 50_000, isSet: true });
  });

  it('latest-wins on a re-set, and 0 is a valid cap (store credit switched off)', async () => {
    const h = await cast();
    expect((await setCap(h, 'u-owner', { capMinor: 50_000 }, 'c1')).status).toBe(200);
    expect((await setCap(h, 'u-owner', { capMinor: 0 }, 'c2')).status).toBe(200);
    expect((await getCap(h, 'u-owner')).body).toMatchObject({ capMinor: 0, isSet: true });
  });

  it('rejects a malformed cap without saving', async () => {
    const h = await cast();
    expect((await setCap(h, 'u-owner', { capMinor: -1 }, 'c-neg')).status).toBe(400);
    expect((await setCap(h, 'u-owner', { capMinor: 2.5 }, 'c-frac')).status).toBe(400);
    expect((await setCap(h, 'u-owner', { capMinor: '500' }, 'c-str')).status).toBe(400);
    // Nothing was saved by the bad calls.
    expect((await getCap(h, 'u-owner')).body).toMatchObject({ isSet: false });
  });
});
