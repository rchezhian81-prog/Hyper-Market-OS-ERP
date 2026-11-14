import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness } from '../support/api-harness';
import { seedOnlineShop, callsFor, CUSTOMER, MANAGER } from '../support/online-shop';

/**
 * U7 (OB-726) · M17-FR-01 "tiers, expiry": the customer's own points card says their TIER and when points EXPIRE, the
 * same standing the desk reads (`/v1/loyalty/members/:ref/standing`), as a customer-facing slice of it. With no tiers or
 * no expiry set by the owner, each is SAID as not set — never a made-up ladder, never "no expiry" when the owner simply
 * has not decided. Nothing here moves a point.
 */
const MOBILE = '9876500012';

describe('U7 · my tier and my points expiry in the app', () => {
  it('not set is said; once the owner sets tiers and expiry, the member reads their tier, the next one and the expiry rule', async () => {
    const h = apiHarness();
    const T = randomUUID();
    const c = callsFor(() => h, T);
    await seedOnlineShop(h, T, c);
    await c.ok(c.req('POST', '/v1/loyalty/members', { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' }, MANAGER), 'enrol');
    await c.ok(c.req('POST', '/v1/loyalty/members/app-link', { mobile: MOBILE, appCustomerRef: CUSTOMER, verifiedHow: 'seen_on_phone' }, MANAGER), 'link');
    const me = async () => (await c.req('GET', '/v1/me/loyalty', undefined, CUSTOMER)).body as {
      tier: { state: string; name?: string | null; nameTa?: string; next?: { name: string; moreSpendMinor: number } };
      expiry: { state: string; months?: number; next?: { expiresAt: string; points: number } | null };
    };

    const before = await me();
    expect(before.tier.state).toBe('not_set');
    expect(before.expiry.state).toBe('not_set');

    await c.ok(c.req('PUT', '/v1/loyalty/programme/tiers', { tiers: [
      { tierId: 'silver', name: 'Silver', nameTa: 'வெள்ளி', minSpend12mMinor: 100_000, multiplierBps: 12_500 },
    ], reason: 'the owner set the ladder' }), 'tiers');
    await c.ok(c.req('PUT', '/v1/loyalty/programme/expiry', { months: 12, reason: 'the owner set the expiry' }), 'expiry');

    const after = await me();
    expect(after.tier.state).toBe('set');
    expect(after.tier.name ?? null).toBeNull(); // no spend yet: no tier reached, said as none
    expect(after.tier.next).toMatchObject({ name: 'Silver', moreSpendMinor: 100_000 });
    expect(after.expiry).toMatchObject({ state: 'set', months: 12 });
  });
});
