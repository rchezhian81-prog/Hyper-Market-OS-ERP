// Demo UAT execution (Option 1) — the role-based access matrix and tenant isolation, executed against
// the REAL cloud surface on the fully-seeded, demo-marked pilot tenant.
//
// The connected business flows (purchase-to-stock, catalogue through the compliance gate, customers,
// till + shift close, serviceability, concession, coupons, OMS order, payroll draft, sandbox e-invoice)
// are executed and read back in `pilot-seed.test.ts`. This file adds the piece the owner's Option-1
// demo UAT names directly and that a per-flow test does not, in one authoritative place:
//
//   • authentication works for every pilot role (a valid login is accepted, self-read returns the role);
//   • role restrictions hold — each role is REFUSED (403) an action outside its authority, and the two
//     routes that refuse the wrong role ALLOW the right one on the very same address; and
//   • tenant isolation holds — a demo user carries no authority into a tenant they were not granted.
//
// It runs on the same seed the operational stand-up uses, so the matrix is executed against the exact
// permissions a real pilot login would carry — not a fixture invented for the test.

import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';
import {
  applyPilotFoundation, applyPilotCatalogue, applyPilotTradingPartners, applyPilotTransactions,
} from '../../db/seed/pilot/apply';
import {
  PILOT_FOUNDATION, PILOT_CATALOGUE, PILOT_TRADING_PARTNERS, PILOT_TRANSACTIONS,
  PILOT_DEMO_TENANT, PILOT_DEMO_SUPPLIER_LOGIN,
} from '../../db/seed/pilot/dataset';

const T = PILOT_DEMO_TENANT;
const OWNER = PILOT_FOUNDATION.genesisOwner.userId;

type Harness = ReturnType<typeof apiHarness>;

/** Lay the whole demo tenant down through the real routes — foundation, catalogue, trading partners
 *  and transactions — exactly as the operational seed does. Fails loud on any step. */
async function seedFullDemoTenant(): Promise<Harness> {
  const h = apiHarness();
  await applyPilotFoundation(h, PILOT_FOUNDATION, { throwOnError: true });
  await applyPilotCatalogue(h, PILOT_CATALOGUE, OWNER, { throwOnError: true });
  await applyPilotTradingPartners(h, PILOT_TRADING_PARTNERS, OWNER, { throwOnError: true });
  await applyPilotTransactions(h, PILOT_TRANSACTIONS, OWNER, { throwOnError: true });
  return h;
}

// The twelve UAT personas the owner listed map onto the seven permission-bearing roles the product
// enforces: administrator→platform_admin; store manager→store_manager; cashier→cashier; purchase user,
// online-order picker, delivery supervisor and retail-customer-service→store_manager scope; finance
// user→accountant; HR/payroll→owner/accountant scope; B2B customer→b2b entitlement on a login;
// retail customer→customer app (no back-office login). RBAC is enforced at the seven roles below, which
// is where "role restrictions" is a testable claim rather than a UI convention.
const DENY_PRICE = { method: 'POST' as const, path: '/v1/prices/changes', idem: 'uat-deny-price' };
const DENY_PARTNER = { method: 'POST' as const, path: '/v1/platform/partners/access-check', idem: 'uat-deny-partner' };

interface RoleCase {
  readonly persona: string;
  readonly userId: string;
  readonly deny: { method: 'POST'; path: string; idem: string };
  readonly why: string;
}

const ROLE_MATRIX: readonly RoleCase[] = [
  { persona: 'Owner / administrator authority', userId: 'pilot-owner', deny: DENY_PARTNER, why: 'the owner holds no platform.partner.* — partner administration is separated from ownership' },
  { persona: 'Store manager', userId: 'pilot-manager', deny: DENY_PARTNER, why: 'the store manager runs the shop, not the platform partner registry' },
  { persona: 'Cashier', userId: 'pilot-cashier', deny: DENY_PRICE, why: 'a cashier cannot set a price (no price.change.propose)' },
  { persona: 'Accountant / finance user', userId: 'pilot-accountant', deny: DENY_PRICE, why: 'finance posts journals; it does not set retail prices' },
  { persona: 'Chartered accountant', userId: 'pilot-ca', deny: DENY_PRICE, why: 'the CA may only read the reconciliation and sign a control total' },
  { persona: 'Supplier (portal login)', userId: PILOT_DEMO_SUPPLIER_LOGIN, deny: DENY_PRICE, why: 'an external supplier can see only its own portal data' },
  { persona: 'Platform administrator', userId: 'pilot-platform-admin', deny: DENY_PRICE, why: 'the platform admin posts NO business transaction (SoD, §28)' },
];

describe('demo UAT — connected flows execute on one fresh tenant (synthetic data)', () => {
  it('the full demo tenant seeds through the real routes — foundation, catalogue, stock and transactions', async () => {
    const h = apiHarness();
    const foundation = await applyPilotFoundation(h, PILOT_FOUNDATION);
    const catalogue = await applyPilotCatalogue(h, PILOT_CATALOGUE, OWNER);
    const partners = await applyPilotTradingPartners(h, PILOT_TRADING_PARTNERS, OWNER);
    const txns = await applyPilotTransactions(h, PILOT_TRANSACTIONS, OWNER);

    for (const [name, report] of [
      ['foundation', foundation], ['catalogue', catalogue], ['trading-partners', partners], ['transactions', txns],
    ] as const) {
      const failed = report.steps.filter((s) => !s.ok);
      expect(failed, `${name} failed steps: ${JSON.stringify(failed)}`).toHaveLength(0);
      expect(report.ok, name).toBe(true);
    }

    // Read-back proof that the connected flow actually moved: received stock is sellable on-hand.
    const avail = await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: OWNER, tenantId: T, query: { productId: 'prod-rice' } });
    expect(avail.status).toBe(200);
    expect((avail.body as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
  });
});

describe('demo UAT — role-access matrix (authentication + role restrictions)', () => {
  it('every pilot role authenticates and reads back its own identity', async () => {
    const h = await seedFullDemoTenant();
    const summary: string[] = [];
    for (const role of ROLE_MATRIX) {
      const me = await h.request({ method: 'GET', path: '/v1/identity/me', userId: role.userId, tenantId: T });
      expect(me.status, `${role.persona} self-read`).toBe(200);
      const perms = (me.body as { permissions: readonly string[] }).permissions;
      expect(Array.isArray(perms) && perms.length > 0, `${role.persona} has permissions`).toBe(true);
      summary.push(`  auth OK   ${role.persona} (${role.userId}) — ${perms.length} permission(s)`);
    }
    // eslint-disable-next-line no-console
    console.log(['', 'Demo UAT — authentication', ...summary].join('\n'));
  });

  it('each role is REFUSED (403) an action outside its authority — least privilege holds', async () => {
    const h = await seedFullDemoTenant();
    const summary: string[] = [];
    for (const role of ROLE_MATRIX) {
      const res = await h.request({
        method: role.deny.method, path: role.deny.path, userId: role.userId, tenantId: T,
        body: {}, idempotencyKey: `${role.deny.idem}-${role.userId}`,
      });
      expect(res.status, `${role.persona} must be refused ${role.deny.path} (${role.why})`).toBe(403);
      summary.push(`  403 DENY  ${role.persona} → ${role.deny.path}`);
    }
    // eslint-disable-next-line no-console
    console.log(['', 'Demo UAT — role restrictions (all 403)', ...summary].join('\n'));
  });

  it('the same route that refuses the wrong role ALLOWS the right one', async () => {
    const h = await seedFullDemoTenant();

    // Price change: the owner may set a governed price; the cashier may not — same route, different role.
    const ownerPrice = await h.request({
      method: 'POST', path: '/v1/prices/changes', userId: OWNER, tenantId: T,
      body: { productId: 'prod-rice', priceMinor: 4800, mrpMinor: 6000, costMinor: 4000, currency: 'INR', marginFloorBps: 500 },
      idempotencyKey: 'uat-owner-price',
    });
    expect(ownerPrice.status, 'owner is authorised on the price route').not.toBe(403);
    expect(ownerPrice.status).not.toBe(401);

    const cashierPrice = await h.request({
      method: 'POST', path: '/v1/prices/changes', userId: 'pilot-cashier', tenantId: T,
      body: { productId: 'prod-rice', priceMinor: 4800, mrpMinor: 6000, costMinor: 4000, currency: 'INR', marginFloorBps: 500 },
      idempotencyKey: 'uat-cashier-price',
    });
    expect(cashierPrice.status, 'cashier is refused on the price route').toBe(403);

    // Partner administration: the platform admin may reach it; the owner may not — same route, different role.
    const adminPartner = await h.request({
      method: 'POST', path: '/v1/platform/partners/access-check', userId: 'pilot-platform-admin', tenantId: T,
      body: {}, idempotencyKey: 'uat-admin-partner',
    });
    expect(adminPartner.status, 'platform admin is authorised on the partner route').not.toBe(403);
    expect(adminPartner.status).not.toBe(401);

    const ownerPartner = await h.request({
      method: 'POST', path: '/v1/platform/partners/access-check', userId: OWNER, tenantId: T,
      body: {}, idempotencyKey: 'uat-owner-partner',
    });
    expect(ownerPartner.status, 'the owner is refused on the partner route').toBe(403);
  });
});

describe('demo UAT — tenant isolation', () => {
  it('a demo login carries no authority into a tenant it was not granted', async () => {
    const h = await seedFullDemoTenant();
    // The owner of the demo tenant, calling a DIFFERENT tenant where no grant exists, is refused —
    // default-deny at the tenant boundary, not a filtered-empty read.
    const foreign = await h.request({ method: 'GET', path: '/v1/identity/me', userId: OWNER, tenantId: 'demo-uat-foreign-tenant' });
    expect(foreign.status).toBe(403);
  });
});
