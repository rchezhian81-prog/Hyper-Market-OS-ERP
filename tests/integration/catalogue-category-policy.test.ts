import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

const A = 'tenant-a';

const GROCERY = {
  traceability: 'none', quantityMode: 'each', valuation: 'retail_mrp',
  shelfLife: { perishable: false, blockSaleAfterExpiry: false },
  returns: { returnable: true, windowDays: 7 },
  controlledSale: {}, approvals: [], enabledByDefault: true,
};
const GOLD = {
  traceability: 'serial', quantityMode: 'catch_weight', valuation: 'rate_per_unit_weight',
  shelfLife: { perishable: false, blockSaleAfterExpiry: false },
  returns: { returnable: false },
  controlledSale: { requires: ['kyc', 'serial_capture'] },
  approvals: ['rate_override', 'price_override'], enabledByDefault: false,
};

const resolve = (h: ApiHarness, userId: string, body: unknown) =>
  h.request({ method: 'POST', path: '/v1/catalogue/category-policy/resolve', userId, tenantId: A, idempotencyKey: `cp-${Math.random()}`, body });

describe('POST /v1/catalogue/category-policy/resolve — category rules as effective-dated config', () => {
  it('resolves the rules in force and previews a grocery sale as allowed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const history = [{ effectiveFrom: '2026-01-01', value: GROCERY }];
    const body = (await resolve(h, 'u-owner', { history, onDate: '2026-08-12', sale: {}, returnAfterDays: 3 })).body as {
      inForce: boolean; summary: string; sale: { allowed: boolean }; return: { allowed: boolean };
    };
    expect(body.inForce).toBe(true);
    expect(body.sale.allowed).toBe(true);
    expect(body.return.allowed).toBe(true);
    expect(body.summary).toContain('returnable within 7 days');
  });

  it('keeps a controlled vertical (gold) off until the store enables it', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const history = [{ effectiveFrom: '2026-01-01', value: GOLD }];

    const off = (await resolve(h, 'u-owner', { history, onDate: '2026-08-12', sale: { kycOnFile: true, serialCaptured: true } })).body as { sale: { allowed: boolean; refusals: { reason: string }[] } };
    expect(off.sale.allowed).toBe(false);
    expect(off.sale.refusals.map((r) => r.reason)).toContain('category_not_enabled');

    const on = (await resolve(h, 'u-owner', { history, onDate: '2026-08-12', sale: { categoryEnabled: true, kycOnFile: true, serialCaptured: true } })).body as { sale: { allowed: boolean } };
    expect(on.sale.allowed).toBe(true);
  });

  it('reports no policy in force before the earliest effective date', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const history = [{ effectiveFrom: '2026-06-01', value: GROCERY }];
    const body = (await resolve(h, 'u-owner', { history, onDate: '2026-01-01' })).body as { inForce: boolean };
    expect(body.inForce).toBe(false);
  });

  it('previews a shipped preset by kind — gold is off until enabled, an unknown kind is refused', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const gold = (await resolve(h, 'u-owner', { kind: 'gold_jewellery', onDate: '2026-08-12', sale: { kycOnFile: true, serialCaptured: true } })).body as {
      inForce: boolean; rules: { enabledByDefault: boolean; traceability: string }; sale: { allowed: boolean; refusals: { reason: string }[] };
    };
    expect(gold.inForce).toBe(true);
    expect(gold.rules.enabledByDefault).toBe(false);
    expect(gold.rules.traceability).toBe('serial');
    expect(gold.sale.allowed).toBe(false);
    expect(gold.sale.refusals.map((r) => r.reason)).toContain('category_not_enabled');

    // A grocery preset sells clean.
    const grocery = (await resolve(h, 'u-owner', { kind: 'grocery_fmcg', onDate: '2026-08-12', sale: {} })).body as { sale: { allowed: boolean } };
    expect(grocery.sale.allowed).toBe(true);

    // An unknown kind is a 400.
    expect((await resolve(h, 'u-owner', { kind: 'diamonds', onDate: '2026-08-12' })).status).toBe(400);
  });

  it('rejects a missing date, a missing history/kind, and a bad date; and gates on the catalogue read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant'); // no catalogue.pack.read
    const history = [{ effectiveFrom: '2026-01-01', value: GROCERY }];

    expect((await resolve(h, 'u-owner', { history })).status).toBe(400); // no onDate
    expect((await resolve(h, 'u-owner', { onDate: '2026-08-12' })).status).toBe(400); // no history
    expect((await resolve(h, 'u-owner', { history: [{ effectiveFrom: 'nope', value: GROCERY }], onDate: '2026-08-12' })).status).toBe(400); // bad date
    expect((await resolve(h, 'u-acct', { history, onDate: '2026-08-12' })).status).toBe(403); // permission
  });
});
