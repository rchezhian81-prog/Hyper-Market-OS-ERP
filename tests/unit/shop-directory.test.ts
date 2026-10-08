import { describe, it, expect } from 'vitest';
import { shopLine, renderShopList, planFeatureChange, type FeatureChangeRequest } from '../../services/platform/src/shop-directory';

/**
 * The shops, read and changed on the server (OB-15-d-3 · owner decision OB-21 "A"): one line per shop from its own
 * record; a change of ONE shop's features checked first and said by name.
 */

const ROW = { tenantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', registeredAt: '2026-10-08T05:00:00.000Z', registeredBy: 'operator:Chezhian' };
const ev = (type: string, payload: Record<string, unknown>, occurredAt = '2026-10-08T06:00:00.000Z') => ({ type, payload, occurredAt });

describe('a shop\'s line on the list', () => {
  it('its name, area and address from the new-shop record; plan and features folded forward', () => {
    const line = shopLine(ROW, [
      ev('ShopRegistered', { name: 'SRE Anna Nagar', realm: 'sre-anna', webOrigin: 'https://anna.example', createdBy: 'Chezhian' }),
      ev('TenantEntitlementSet', { feature: 'loyalty', enabled: true }),
      ev('TenantEntitlementSet', { feature: 'delivery', enabled: true }),
      ev('TenantEntitlementSet', { feature: 'delivery', enabled: false }),
      ev('BillingSubscriptionStarted', { planId: 'standard' }),
    ]);
    expect(line).toEqual({
      tenantId: ROW.tenantId, name: 'SRE Anna Nagar', realm: 'sre-anna', webOrigin: 'https://anna.example',
      createdBy: 'Chezhian', registeredAt: ROW.registeredAt, plan: 'standard', featuresOn: ['loyalty'],
    });
  });

  it('a shop made before the new-shop command: no name recorded — said so, never invented; a cancelled plan is none', () => {
    const line = shopLine(ROW, [ev('BillingSubscriptionStarted', { planId: 'starter' }), ev('BillingSubscriptionCancelled', {})]);
    expect(line).toEqual({ tenantId: ROW.tenantId, createdBy: 'operator:Chezhian', registeredAt: ROW.registeredAt, featuresOn: [] });
    expect(renderShopList([line]).join('\n')).toMatch(/\(no name recorded\)[\s\S]*sign-in area: not recorded[\s\S]*plan: none · features on: none/);
    expect(renderShopList([])).toEqual(['No shop is registered on this server.']);
  });
});

describe('changing one shop\'s features', () => {
  const req = (over: Partial<FeatureChangeRequest> = {}): FeatureChangeRequest => ({
    tenantId: ROW.tenantId, on: ['loyalty'], off: [], operator: 'Chezhian', targetKind: 'rehearsal',
    knownShops: [ROW.tenantId], currentlyOn: [], ...over,
  });

  it('only what changes is recorded; what is already so is said', () => {
    expect(planFeatureChange(req({ on: ['loyalty', 'delivery'], off: ['b2b', 'customer_app'], currentlyOn: ['delivery', 'b2b'] }))).toEqual({
      ok: true, changes: [{ feature: 'loyalty', enabled: true }, { feature: 'b2b', enabled: false }], unchanged: ['delivery', 'customer_app'],
    });
  });

  it.each([
    [{ targetKind: 'production' }, /production box/],
    [{ operator: ' ' }, /--operator/],
    [{ tenantId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }, /There is no shop/],
    [{ on: [], off: [] }, /at least one feature/],
    [{ on: ['teleport'] }, /"teleport" is not a feature/],
    [{ on: ['loyalty'], off: ['loyalty'] }, /both on and off/],
  ])('%j → not changed, said by name', (over, words) => {
    const plan = planFeatureChange(req(over as Partial<FeatureChangeRequest>));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.problems.join(' ')).toMatch(words);
  });

  it('a feature named twice is reported once', () => {
    const plan = planFeatureChange(req({ on: ['teleport'], off: ['teleport'] }));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.problems.filter((p) => p.includes('is not a feature'))).toHaveLength(1);
  });
});
