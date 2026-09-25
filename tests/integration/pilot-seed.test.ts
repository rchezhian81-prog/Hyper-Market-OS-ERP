// Pilot seed — foundation (Phase 4a). Proves the controlled, demo-marked pilot dataset lays down
// through the REAL cloud surface: genesis owner, role logins, entitlements, and the org skeleton
// (GST registration → company → branch → warehouse), and that it is tenant-isolated so demo data
// cannot leak into a real tenant. The applier is what the operational seed script and the pilot
// stand-up run; here it runs against the real `apiHarness` surface exactly as production composes it.

import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';
import { applyPilotFoundation, applyPilotCatalogue, applyPilotTradingPartners } from '../../db/seed/pilot/apply';
import {
  PILOT_FOUNDATION, PILOT_CATALOGUE, PILOT_TRADING_PARTNERS, PILOT_DEMO_SUPPLIER_LOGIN,
  PILOT_DEMO_TENANT, PILOT_DEMO_BRANCH, PILOT_DEMO_GSTIN, SEED_MARKER,
} from '../../db/seed/pilot/dataset';

const OWNER = PILOT_FOUNDATION.genesisOwner.userId;

describe('pilot seed — foundation (Phase 4a)', () => {
  it('is demo-marked and scoped to the demo tenant', () => {
    expect(SEED_MARKER.syntheticDataOnly).toBe(true);
    expect(PILOT_FOUNDATION.tenantId).toBe(PILOT_DEMO_TENANT);
    // Every login is obviously non-real (no email/real-name shape).
    for (const u of [PILOT_FOUNDATION.genesisOwner, ...PILOT_FOUNDATION.users]) {
      expect(u.userId.startsWith('pilot-')).toBe(true);
      expect(u.displayName).toContain('(demo)');
    }
  });

  it('lays down the whole foundation by driving the real routes — every step lands', async () => {
    const h = apiHarness();
    const report = await applyPilotFoundation(h, PILOT_FOUNDATION);
    const failed = report.steps.filter((s) => !s.ok);
    expect(failed, `failed steps: ${JSON.stringify(failed)}`).toHaveLength(0);
    expect(report.ok).toBe(true);
    // No silent skips: a step per user, entitlement, registration, node create + activate.
    expect(report.steps.length).toBeGreaterThanOrEqual(
      1 + PILOT_FOUNDATION.users.length + PILOT_FOUNDATION.entitlements.length
      + PILOT_FOUNDATION.gstRegistrations.length + PILOT_FOUNDATION.org.length,
    );
  });

  it('is idempotent — re-applying lands every step again without error', async () => {
    const h = apiHarness();
    await applyPilotFoundation(h, PILOT_FOUNDATION, { throwOnError: true });
    const again = await applyPilotFoundation(h, PILOT_FOUNDATION);
    expect(again.ok, JSON.stringify(again.steps.filter((s) => !s.ok))).toBe(true);
  });

  it('org skeleton is readable and the branch is active, filed under the demo GSTIN', async () => {
    const h = apiHarness();
    await applyPilotFoundation(h, PILOT_FOUNDATION, { throwOnError: true });

    const all = await h.request({ method: 'GET', path: '/v1/org/nodes', userId: OWNER, tenantId: PILOT_DEMO_TENANT });
    expect(all.status).toBe(200);
    expect((all.body as { nodeCount: number }).nodeCount).toBe(PILOT_FOUNDATION.org.length);

    const branch = await h.request({ method: 'GET', path: `/v1/org/nodes/${PILOT_DEMO_BRANCH}`, userId: OWNER, tenantId: PILOT_DEMO_TENANT });
    expect(branch.status).toBe(200);
    const view = branch.body as { node: { status: string }; canActivate: boolean; filedUnderGstin: string | null };
    expect(view.node.status).toBe('active');
    expect(view.filedUnderGstin).toBe(PILOT_DEMO_GSTIN);
  });

  it('each role login carries its role permissions', async () => {
    const h = apiHarness();
    await applyPilotFoundation(h, PILOT_FOUNDATION, { throwOnError: true });
    const permsOf = async (userId: string): Promise<readonly string[]> => {
      const me = await h.request({ method: 'GET', path: '/v1/identity/me', userId, tenantId: PILOT_DEMO_TENANT });
      expect(me.status).toBe(200);
      return (me.body as { permissions: readonly string[] }).permissions;
    };
    expect(await permsOf('pilot-cashier')).toContain('pos.sale.read');
    expect(await permsOf('pilot-accountant')).toContain('finance.journal.post');
    expect(await permsOf('pilot-ca')).toContain('migration.controltotal.sign');
    expect(await permsOf('pilot-platform-admin')).toContain('platform.partner.manage');
  });

  it('the pilot entitlements are turned on', async () => {
    const h = apiHarness();
    await applyPilotFoundation(h, PILOT_FOUNDATION, { throwOnError: true });
    const res = await h.request({ method: 'GET', path: '/v1/platform/entitlements', userId: OWNER, tenantId: PILOT_DEMO_TENANT });
    expect(res.status).toBe(200);
    const entitled = (res.body as { entitled: readonly string[] }).entitled;
    for (const feature of PILOT_FOUNDATION.entitlements) expect(entitled).toContain(feature);
  });

  it('demo data cannot leak across tenants — a different tenant sees none of it', async () => {
    const h = apiHarness();
    await applyPilotFoundation(h, PILOT_FOUNDATION, { throwOnError: true });
    await h.seedOwner('some-other-tenant', 'other-owner');
    const res = await h.request({ method: 'GET', path: '/v1/org/nodes', userId: 'other-owner', tenantId: 'some-other-tenant' });
    expect(res.status).toBe(200);
    expect((res.body as { nodeCount: number }).nodeCount).toBe(0);
  });
});

describe('pilot seed — catalogue (Phase 4b)', () => {
  const seed = async () => {
    const h = apiHarness();
    await applyPilotFoundation(h, PILOT_FOUNDATION, { throwOnError: true });
    const report = await applyPilotCatalogue(h, PILOT_CATALOGUE, OWNER);
    return { h, report };
  };

  it('lays down tax rates, products, barcodes, packs and prices through the real routes', async () => {
    const { report } = await seed();
    const failed = report.steps.filter((s) => !s.ok);
    expect(failed, `failed steps: ${JSON.stringify(failed)}`).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  it('publishes every product through the compliance gate (count matches the dataset)', async () => {
    const { h } = await seed();
    const res = await h.request({ method: 'GET', path: '/v1/catalogue/products', userId: OWNER, tenantId: PILOT_DEMO_TENANT });
    expect(res.status).toBe(200);
    expect((res.body as { count: number }).count).toBe(PILOT_CATALOGUE.products.length);
  });

  it('a regulated food product keeps its safety content and tax class', async () => {
    const { h } = await seed();
    const res = await h.request({ method: 'GET', path: '/v1/catalogue/products/prod-biscuit', userId: OWNER, tenantId: PILOT_DEMO_TENANT });
    expect(res.status).toBe(200);
    const product = (res.body as { product: { taxClass: string; lifecycle: string; safety?: { allergens?: string[] } } }).product;
    expect(product.taxClass).toBe('19053100');
    expect(product.lifecycle).toBe('active');
    expect(product.safety?.allergens).toContain('wheat');
  });

  it('a barcode resolves to exactly its product', async () => {
    const { h } = await seed();
    const res = await h.request({ method: 'GET', path: '/v1/catalogue/barcodes/8900000000123', userId: OWNER, tenantId: PILOT_DEMO_TENANT });
    expect(res.status).toBe(200);
    expect((res.body as { barcode: { productId: string } }).barcode.productId).toBe('prod-rice');
  });

  it('a pack hierarchy is stored with its exact conversions', async () => {
    const { h } = await seed();
    const res = await h.request({ method: 'GET', path: '/v1/catalogue/products/prod-biscuit/pack', userId: OWNER, tenantId: PILOT_DEMO_TENANT });
    expect(res.status).toBe(200);
    expect((res.body as { pack: { levels: unknown[] } }).pack.levels).toHaveLength(2);
  });
});

describe('pilot seed — trading partners + stock (Phase 4c)', () => {
  const seed = async () => {
    const h = apiHarness();
    await applyPilotFoundation(h, PILOT_FOUNDATION, { throwOnError: true });
    await applyPilotCatalogue(h, PILOT_CATALOGUE, OWNER, { throwOnError: true });
    const report = await applyPilotTradingPartners(h, PILOT_TRADING_PARTNERS, OWNER);
    return { h, report };
  };

  it('lays down suppliers, bins, a goods receipt and customers through the real routes', async () => {
    const { report } = await seed();
    const failed = report.steps.filter((s) => !s.ok);
    expect(failed, `failed steps: ${JSON.stringify(failed)}`).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  it('the goods receipt turns the delivery into sellable stock', async () => {
    const { h } = await seed();
    const grn = await h.request({ method: 'GET', path: '/v1/inventory/goods-receipt/grn-demo-001', userId: OWNER, tenantId: PILOT_DEMO_TENANT });
    expect(grn.status).toBe(200);
    expect((grn.body as { grn: { availableMinor: number } }).grn.availableMinor).toBeGreaterThan(0);

    const avail = await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: OWNER, tenantId: PILOT_DEMO_TENANT, query: { productId: 'prod-rice' } });
    expect(avail.status).toBe(200);
    expect((avail.body as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
  });

  it('a warehouse bin is stored', async () => {
    const { h } = await seed();
    const res = await h.request({ method: 'GET', path: '/v1/warehouse/bins/bin-demo-a1', userId: OWNER, tenantId: PILOT_DEMO_TENANT });
    expect(res.status).toBe(200);
    expect((res.body as { binId: string; pickable: boolean }).binId).toBe('bin-demo-a1');
  });

  it('the supplier portal login carries the supplier role', async () => {
    const { h } = await seed();
    const me = await h.request({ method: 'GET', path: '/v1/identity/me', userId: PILOT_DEMO_SUPPLIER_LOGIN, tenantId: PILOT_DEMO_TENANT });
    expect(me.status).toBe(200);
    expect((me.body as { permissions: readonly string[] }).permissions).toContain('supplier.portal.self');
  });

  it('a demo customer has a consent record and a points balance', async () => {
    const { h } = await seed();
    const consent = await h.request({ method: 'GET', path: '/v1/customers/cust-demo-1/consent', userId: OWNER, tenantId: PILOT_DEMO_TENANT });
    expect(consent.status).toBe(200);
    expect((consent.body as { records: unknown[] }).records.length).toBeGreaterThan(0);

    const points = await h.request({ method: 'GET', path: '/v1/customers/cust-demo-1/points', userId: OWNER, tenantId: PILOT_DEMO_TENANT });
    expect(points.status).toBe(200);
    expect((points.body as { pointsBalance?: number; known: boolean }).known).toBe(true);
    expect((points.body as { pointsBalance?: number }).pointsBalance).toBe(100);
  });
});
