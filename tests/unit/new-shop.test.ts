import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { planNewShop, nextSteps, type NewShopRequest } from '../../services/platform/src/new-shop';
import { OWNER_ROLE_ID, ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * A new shop is planned in full before anything is written (OB-15-d-2 · owner decision OB-20 "A"): the tested tenant
 * bootstrap rules and the shop's realm file (OB-19), every problem said at once, and the next steps in order.
 */

const TEMPLATE = JSON.parse(readFileSync('infra/keycloak/realm-sre-store.json', 'utf8')) as Record<string, unknown>;
const SHOP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEMO = '00000000-0000-4000-8000-00000000d3e0';
const req = (over: Partial<NewShopRequest> = {}): NewShopRequest => ({
  tenantId: SHOP, name: ' SRE  Anna Nagar ', owner: 'u-anna-owner', admins: [], operator: 'Chezhian-admin',
  realm: 'sre-anna', webOrigin: 'https://anna.example.test/', audience: 'sre-retail-os-api',
  targetKind: 'rehearsal', demoTenantIds: [DEMO], knownRoleIds: ROLE_CATALOGUE.map((r) => r.id), ownerRoleId: OWNER_ROLE_ID,
  realmTemplate: TEMPLATE, ...over,
});

describe('planning a new shop', () => {
  it('a good request: the owner first, the shop\'s record, and its realm file for THIS shop', () => {
    const plan = planNewShop(req({ admins: [{ userId: 'u-anna-manager', roleId: 'store_manager' }] }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.bootstrap.admins).toEqual([{ userId: 'u-anna-owner', roleId: OWNER_ROLE_ID }, { userId: 'u-anna-manager', roleId: 'store_manager' }]);
    expect(plan.shop).toEqual({ tenantId: SHOP, name: 'SRE Anna Nagar', realm: 'sre-anna', webOrigin: 'https://anna.example.test', createdBy: 'Chezhian-admin' });
    expect(plan.realmFile).toMatchObject({ realm: 'sre-anna', displayName: 'SRE Anna Nagar' });
    expect(JSON.stringify(plan.realmFile)).toContain(SHOP);
    expect(JSON.stringify(plan.realmFile)).not.toMatch(/\$\{SRE_/);
  });

  it.each([
    [{ targetKind: 'production' }, /production/],
    [{ tenantId: DEMO }, /demo tenant/],
    [{ operator: ' ' }, /nobody's name/],
    [{ admins: [{ userId: 'u-x', roleId: 'emperor' }] }, /not in the role catalogue/],
    [{ realm: 'sre-store' }, /first shop's realm/],
    [{ webOrigin: 'http://anna.example.test' }, /must be https/],
  ])('%j → not created, said by name', (over, words) => {
    const plan = planNewShop(req(over as Partial<NewShopRequest>));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.problems.join(' ')).toMatch(words);
  });

  it('every problem is said at once — name, id, realm and address together, each once', () => {
    const plan = planNewShop(req({ name: 'X', tenantId: 'nope', realm: 'Anna', webOrigin: 'http://x/y' }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.problems).toHaveLength(4);
    expect(plan.problems.join(' ')).toMatch(/2 to 80[\s\S]*not a UUID[\s\S]*sre-<shop>[\s\S]*no path/);
  });

  it('the next steps: load the area, tell head office, the owner\'s sign-in in person, the address with the domain', () => {
    const plan = planNewShop(req());
    if (!plan.ok) throw new Error('expected a plan');
    const steps = nextSteps(plan.shop, 'u-anna-owner', '/srv/realm-sre-anna.json');
    expect(steps).toHaveLength(4);
    expect(steps[0]).toContain('/srv/realm-sre-anna.json');
    expect(steps[1]).toContain(`sre-anna=${SHOP}`);
    expect(steps[2]).toMatch(/in their presence[\s\S]*sre_user_id = u-anna-owner[\s\S]*sre-privileged/);
    expect(steps[3]).toMatch(/domain name/);
  });
});
