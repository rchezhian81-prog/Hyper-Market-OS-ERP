import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { platformAdapter, STREAM } from '../../services/api/src/adapters';

// White-label branding, end to end through the real API (M36-FR-02, API-11). One codebase, one
// deployment, many brands. A tenant sets its branding as configuration (no code fork); an unset
// field resolves to a NEUTRAL default, never to another tenant's — a missing logo showing the
// previous tenant's mark is a retailer invoicing under a competitor's name. Validation refuses at
// publish what cannot be shipped: a legal term renamed (a "tax invoice" called a "bill" is not a
// tax invoice), an unreadable colour pair, an invalid hex. Branding is the caller's tenant only,
// set server-side, so a rebrand can never be aimed at another retailer (§35). This proves the
// wired `services/platform` branding surface against the real pipeline and real per-tenant RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface Resolved { tenantId: string; productName: string; legalName: string; colours: { primary: string; onPrimary: string }; fromTenant: string[]; detail: string }
const getBrand = async (h: ApiHarness, tenant: string, user: string): Promise<Resolved> =>
  (await h.request({ method: 'GET', path: '/v1/platform/branding', userId: user, tenantId: tenant })).body as Resolved;
const putBrand = (h: ApiHarness, tenant: string, user: string, body: unknown, key = 'br') =>
  h.request({ method: 'PUT', path: '/v1/platform/branding', userId: user, tenantId: tenant, idempotencyKey: `${key}-${tenant}`, body });

const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code: string } }).error?.code;

describe('white-label branding, end to end (M36-FR-02, API-11)', () => {
  it('resolves neutral before anything is set, and the tenant\'s brand after', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // Nothing set → the neutral fallback, and it says so.
    const before = await getBrand(h, A, 'u-owner');
    expect(before).toMatchObject({ tenantId: A, productName: 'Retail OS', fromTenant: [] });
    expect(before.detail).toContain('neutral');

    // Set a brand.
    const set = await putBrand(h, A, 'u-owner', {
      productName: 'SRE Hyper Market', legalName: 'SRE Hyper Market Pvt Ltd',
      colours: { primary: '#1a4d2e', onPrimary: '#ffffff' },
      terminology: { branch: 'showroom' },
    });
    expect(set.status).toBe(200);

    // Now the tenant's brand resolves, with the neutral fields it did not set left neutral.
    const after = await getBrand(h, A, 'u-owner');
    expect(after.productName).toBe('SRE Hyper Market');
    expect(after.colours).toEqual({ primary: '#1a4d2e', onPrimary: '#ffffff' });
    expect(after.fromTenant).toContain('productName');
    expect(after.fromTenant).toContain('colours');
  });

  it('refuses a renamed legal term and an unreadable colour pair, storing nothing (statutory + a11y)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await putBrand(h, A, 'u-owner', { productName: 'SRE Hyper Market' }, 'valid');

    // "tax invoice" carries a legal meaning and cannot be renamed.
    const protectedTerm = await putBrand(h, A, 'u-owner', { terminology: { 'tax invoice': 'bill' } }, 'protected');
    expect(protectedTerm.status).toBe(422);
    expect(codeOf(protectedTerm)).toBe('branding_refused');

    // A colour pair a cashier cannot read at 8pm is blocked at publish (WCAG AA).
    const lowContrast = await putBrand(h, A, 'u-owner', { colours: { primary: '#777777', onPrimary: '#ffffff' } }, 'contrast');
    expect(lowContrast.status).toBe(422);
    expect(codeOf(lowContrast)).toBe('branding_refused');

    // Neither refusal changed the stored brand — the earlier valid name still resolves.
    expect((await getBrand(h, A, 'u-owner')).productName).toBe('SRE Hyper Market');
  });

  it('never crosses a tenant: another tenant sees neutral, and the client cannot aim a rebrand elsewhere (§35)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.seedOwner(B, 'u-owner-b');
    await putBrand(h, A, 'u-owner', { productName: 'SRE Hyper Market' });

    // B has set nothing → neutral, NEVER A's brand.
    const bBrand = await getBrand(h, B, 'u-owner-b');
    expect(bBrand.productName).toBe('Retail OS');
    expect(bBrand.productName).not.toBe('SRE Hyper Market');

    // A client that tries to set branding for another tenant cannot: the tenant is the caller's,
    // set server-side, so this stores under A and never touches B.
    await putBrand(h, A, 'u-owner', { tenantId: B, productName: 'Injected' }, 'evil');
    expect((await getBrand(h, A, 'u-owner')).productName).toBe('Injected'); // stored under the caller (A)
    expect((await getBrand(h, B, 'u-owner-b')).productName).toBe('Retail OS'); // B untouched
  });

  it('is gated: a cashier can neither read nor set branding (403)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await h.request({ method: 'GET', path: '/v1/platform/branding', userId: 'u-cash', tenantId: A })).status).toBe(403);
    expect((await putBrand(h, A, 'u-cash', { productName: 'X' }, 'cash')).status).toBe(403);
  });

  it('keeps two brand sets made in the same instant as two facts — a change is never silently dropped (P-08, hard rule #2)', async () => {
    // A brand versioned only by the wall-clock millisecond loses a change: two DIFFERENT sets inside
    // the same millisecond carried the same `branding-${tenant}-${ms}` key, so the store took the
    // second for a retry and dropped it — a rebrand vanishing with no error. Forced deterministically
    // here with a FIXED clock (the harness's real clock only hits the same millisecond under load,
    // which is why this surfaced as a flake). The version is the count of prior sets, so both land.
    const store = new InMemoryEventStore();
    const adapter = platformAdapter({ store, now: () => '2026-08-07T12:00:00.000Z', probes: async () => [] });
    await adapter.setBranding(A, { tenantId: A, productName: 'First' });
    await adapter.setBranding(A, { tenantId: A, productName: 'Second' });

    // Both facts are kept — the second did not silently collide with the first…
    const sets = (await store.readStream(A, STREAM.platform)).filter((e) => e.event.type === 'TenantBrandingSet');
    expect(sets).toHaveLength(2);
    // …and "current" is the LATEST set, a fold over the two, never an overwritten field.
    expect((await adapter.branding(A))?.productName).toBe('Second');
  });
});
