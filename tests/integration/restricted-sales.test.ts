import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// B14 (COTPA 2003 s.6 & s.7 / M12): the till's restricted-sale gate on the live API. A tobacco line
// demands age-18 confirmation and refuses a below-pack (loose single-stick) quantity. The gate is a
// decision, not a write — it commits nothing — and the cashier who runs the till holds the permission.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const tobaccoPack = { lineId: 'l1', productId: 'cig-20s', quantityMinor: 1000, uom: 'pack', ageRestricted: true, restrictionKind: 'tobacco', minSaleQuantityMinor: 1000 };
const bread = { lineId: 'l2', productId: 'bread', quantityMinor: 1000, uom: 'each' };

const check = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/pos/restricted-sale/check', userId: u, tenantId: A, idempotencyKey: key, body });

type Verdict = { allowed: boolean; blocks: { lineId: string; reason: string }[] };

describe('restricted-sale gate on the live API (B14 / COTPA 2003)', () => {
  it('lets a cashier clear a tobacco pack once age is confirmed 18+', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');

    const r = (await check(h, 'u-cash', { lines: [tobaccoPack, bread], ageVerification: { verified: true, ageYears: 25 } }, 'rs-ok')).body as Verdict;
    expect(r.allowed).toBe(true);
    expect(r.blocks).toHaveLength(0);
  });

  it('blocks a tobacco line when age is not confirmed, and when the customer is under age', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const noAge = (await check(h, 'u-owner', { lines: [tobaccoPack] }, 'rs-noage')).body as Verdict;
    expect(noAge.allowed).toBe(false);
    expect(noAge.blocks[0]!.reason).toBe('age_not_verified');

    const under = (await check(h, 'u-owner', { lines: [tobaccoPack], ageVerification: { verified: true, ageYears: 16 } }, 'rs-under')).body as Verdict;
    expect(under.blocks[0]!.reason).toBe('underage');
  });

  it('refuses a below-pack (loose single-stick) tobacco quantity', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const r = (await check(h, 'u-owner', { lines: [{ ...tobaccoPack, quantityMinor: 50 }], ageVerification: { verified: true, ageYears: 40 } }, 'rs-loose')).body as Verdict;
    expect(r.allowed).toBe(false);
    expect(r.blocks.map((b) => b.reason)).toContain('below_pack_minimum');
  });

  it('rejects a malformed request (no lines[]) and gates on the permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant'); // an accountant has no till permission

    expect((await check(h, 'u-owner', { ageVerification: { verified: true } }, 'rs-bad')).status).toBe(400);
    expect((await check(h, 'u-acct', { lines: [tobaccoPack], ageVerification: { verified: true, ageYears: 30 } }, 'rs-rbac')).status).toBe(403);
  });
});

const plastic = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/pos/single-use-plastic/check', userId: u, tenantId: A, idempotencyKey: key, body });

const goodBag = { lineId: 'b1', productId: 'carry-bag', unitPriceMinor: 500, isCarryBag: true, material: 'plastic', plasticThicknessMicrons: 120 };
const rice = { lineId: 'g1', productId: 'rice-5kg', unitPriceMinor: 45000 };

describe('single-use-plastic gate on the live API (B19 / Plastic Waste Management Rules)', () => {
  it('clears a compliant 120 µm priced bag and blocks a thin bag, a free bag, and a banned SUP item', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // holds pos.restricted.check

    const ok = (await plastic(h, 'u-cash', { lines: [goodBag, rice] }, 'sup-ok')).body as Verdict;
    expect(ok.allowed).toBe(true);

    const thin = (await plastic(h, 'u-owner', { lines: [{ ...goodBag, plasticThicknessMicrons: 40 }] }, 'sup-thin')).body as Verdict;
    expect(thin.blocks.map((b) => b.reason)).toContain('carry_bag_below_min_thickness');

    const free = (await plastic(h, 'u-owner', { lines: [{ ...goodBag, unitPriceMinor: 0 }] }, 'sup-free')).body as Verdict;
    expect(free.blocks.map((b) => b.reason)).toContain('carry_bag_not_priced');

    const banned = (await plastic(h, 'u-owner', { lines: [{ lineId: 's1', productId: 'plastic-straw', unitPriceMinor: 200, bannedSingleUsePlastic: true }] }, 'sup-ban')).body as Verdict;
    expect(banned.allowed).toBe(false);
    expect(banned.blocks[0]!.reason).toBe('banned_single_use_plastic');
  });

  it('rejects a malformed request and gates on the same till permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant'); // no till permission

    expect((await plastic(h, 'u-owner', { minCarryBagMicrons: 120 }, 'sup-bad')).status).toBe(400); // no lines[]
    expect((await plastic(h, 'u-owner', { lines: [goodBag], minCarryBagMicrons: -5 }, 'sup-micron')).status).toBe(400); // bad microns
    expect((await plastic(h, 'u-acct', { lines: [goodBag] }, 'sup-rbac')).status).toBe(403);
  });
});
