import { describe, it, expect } from 'vitest';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import { apiHarness } from '../support/api-harness';

// §28 / M33-FR-01 / SEC-03 — the platform administrator runs the platform and posts no money.
//
// M33-FR-01 requires, in as many words, that "an admin cannot post a business transaction". Until
// now that could not be *shown*: the product had no distinct platform-administration role, so the
// only holder of `platform.*` authority was the owner — who also holds every business-transaction
// permission there is. A control you can only describe is a control an attacker reads as advice.
//
// This proves the separation two independent ways over the REAL role catalogue and the REAL
// request pipeline:
//   1. the catalogue invariant — the platform_admin role is *confined* to the platform namespace,
//      and holds none of the committing codes (money, stock, price, purchase, orders, role grants);
//   2. the kernel enforcement — a person who holds ONLY platform_admin is refused (403) at every
//      business-transaction route, while still being allowed the platform work the role exists for,
//      and while the owner is NOT refused on the same routes (so the refusal is the role, not a
//      route that happens to be broken).

const platformAdmin = ROLE_CATALOGUE.find((r) => r.id === 'platform_admin');

/**
 * A representative set of the product's *committing* permissions — posting money, moving stock,
 * changing a price, approving a purchase, issuing stored value, or granting a role. Not exhaustive
 * (the confinement invariant below is the exhaustive half); this is the belt to the invariant's
 * braces, naming the codes a platform administrator must never silently acquire.
 */
const BUSINESS_TRANSACTION_PERMISSIONS = [
  'pos.sale.sync', 'pos.return.record',
  'cash.movement.record', 'till.shift.close',
  'finance.journal.post', 'finance.period.close', 'finance.creditnote.issue',
  'price.change.propose', 'price.change.approve',
  'purchase.order.approve', 'purchase.invoice.capture', 'purchase.supplier.bank',
  'loyalty.value.issue', 'loyalty.value.redeem', 'loyalty.coupon.issue',
  'scrap.sale.record', 'concession.sale.record',
  'settlement.batch.import', 'b2b.receivable.record',
  'order.promise', 'inventory.movement.append',
  'identity.role.grant',
] as const;

describe('the platform_admin role is confined to the platform, by construction', () => {
  it('exists in the product role catalogue', () => {
    expect(platformAdmin, 'a distinct platform-administration role must exist (M33-FR-01 §28)').toBeDefined();
  });

  it('holds nothing outside the platform namespace (bar the universal self-read)', () => {
    // The exhaustive half: whatever else is added to this role later, it can only ever be a
    // `platform.*` code. The day someone slips `finance.journal.post` in, this line goes red.
    const escapees = (platformAdmin?.permissions ?? []).filter(
      (p) => p !== 'identity.self.read' && !p.startsWith('platform.'),
    );
    expect(escapees, 'a platform administrator may hold only platform.* authority').toEqual([]);
  });

  it('holds NONE of the business-transaction permissions', () => {
    const held = new Set(platformAdmin?.permissions ?? []);
    const leaked = BUSINESS_TRANSACTION_PERMISSIONS.filter((p) => held.has(p));
    expect(leaked, 'a platform administrator must not hold any committing permission').toEqual([]);
  });

  it('does hold the platform authority the role exists for — it is not an empty shell', () => {
    // Without this, a role stripped of everything would pass the two negatives above and be
    // useless — the separation has to leave a real, usable administrator behind.
    const held = new Set(platformAdmin?.permissions ?? []);
    for (const code of [
      'platform.health.read', 'platform.device.manage', 'platform.flag.write',
      'platform.setup.write', 'platform.support.grant', 'platform.entitlement.manage',
    ]) {
      expect(held.has(code), `platform_admin should hold ${code}`).toBe(true);
    }
  });
});

const TENANT = 't-sre';

/** One row per business-transaction route a platform administrator must be refused at the door. */
const BUSINESS_ROUTES: readonly {
  readonly what: string; readonly method: 'POST'; readonly path: string; readonly key: string;
}[] = [
  { what: 'bank a till sale', method: 'POST', path: '/v1/sales', key: 'ba-1' },
  { what: 'post a finance journal', method: 'POST', path: '/v1/finance/journals', key: 'ba-2' },
  { what: 'issue a credit note', method: 'POST', path: '/v1/finance/credit-notes', key: 'ba-3' },
  { what: 'close an accounting period', method: 'POST', path: '/v1/finance/periods/2026-08/close', key: 'ba-4' },
  { what: 'approve a purchase order', method: 'POST', path: '/v1/purchase/orders/po-1/approval', key: 'ba-5' },
  { what: 'record a scrap sale', method: 'POST', path: '/v1/scrap/sales', key: 'ba-6' },
  { what: 'issue a stored-value instrument', method: 'POST', path: '/v1/stored-value/instruments', key: 'ba-7' },
];

describe('the kernel enforces it — a platform administrator is refused every business transaction', () => {
  it('refuses (403) a platform_admin at every business-transaction route', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await h.provisionRole(TENANT, 'u-admin', 'platform_admin');

    const leaks: string[] = [];
    for (const route of BUSINESS_ROUTES) {
      const res = await h.request({
        method: route.method, path: route.path, userId: 'u-admin', tenantId: TENANT,
        idempotencyKey: route.key, body: {},
      });
      if (res.status !== 403) leaks.push(`${route.what} (${route.method} ${route.path}) returned ${res.status}, expected 403`);
    }
    expect(leaks, 'a platform administrator must be refused every one of these').toEqual([]);
  });

  it('still lets the platform_admin do the platform work the role is for', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await h.provisionRole(TENANT, 'u-admin', 'platform_admin');

    // A platform read (holds platform.health.read).
    const policy = await h.request({ method: 'GET', path: '/v1/platform/version-policy', userId: 'u-admin', tenantId: TENANT });
    expect(policy.status).toBe(200);

    // A platform write (holds platform.device.manage): register a till.
    const register = await h.request({
      method: 'POST', path: '/v1/platform/devices/till-9/register', userId: 'u-admin', tenantId: TENANT,
      idempotencyKey: 'reg-1', body: { branchId: 'b-main', kind: 'pos_lane', label: 'Lane 9', appVersion: '2.1.0' },
    });
    expect(register.status).toBeLessThan(300);
    expect(register.status).toBeGreaterThanOrEqual(200);
  });

  it('proves the refusal is the ROLE, not a broken route — the owner is NOT refused there', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');

    // The owner holds finance.journal.post, so the SAME journal route reaches the handler. It may
    // reject the empty body (400/422), but it must not 403 — that difference is the whole control.
    const res = await h.request({
      method: 'POST', path: '/v1/finance/journals', userId: 'u-owner', tenantId: TENANT,
      idempotencyKey: 'own-1', body: {},
    });
    expect(res.status).not.toBe(403);
  });
});
