import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';

/**
 * **W3 (D07-FR-05 · M16-FR-04 · M16-FR-01): the Customer value page and the Customers page's household, on the store
 * computer, over head office's own segmentation and identity routes. Synthetic customers only.**
 *   • the store manager ranks the customers by the profit their bills bring: the fresh-food customer (₹20,000 at 30%) is
 *     above the cigarette customer (₹50,000 at 4%), both figures shown; a customer who never agreed to be analysed is not
 *     ranked;
 *   • the group rules show head office's standard numbers until the shop sets its own; the manager sets "loyal from 6
 *     bills" and head office holds exactly that; a cashier the box lets open the page cannot change them;
 *   • on the Customers page the manager links a customer to a household and takes them out again: head office's record
 *     shows the household and then none, and the identity history says the record was never merged.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash';
const READ = ['customer.segment.read', 'customer.profile.read'];
const MANAGE = [...READ, 'customer.segment.manage', 'customer.identity.manage'];

describe.skipIf(!HAVE_BROWSER)('Customer value and the household (W3 · D07-FR-05 · M16-FR-01)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'customer-value',
      people: [{ userId: MGR, permissions: MANAGE }, { userId: CASH, permissions: READ }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        await ho.provisionRole(T, CASH, 'cashier', [store]);
        const ok = async (path: string, body: unknown, key: string) => {
          const r = await ho.request({ method: 'POST', path, userId: OWNER, tenantId: T, idempotencyKey: key, body });
          expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
        };
        const at = '2026-10-20T06:30:00.000Z'; const shopDay = '2026-10-20'; // noon in the shop
        await ok('/v1/customer/facts/orders/o-fresh', { customerRef: 'demo-fresh', at, netMinor: 2_000_000, marginMinor: 600_000, channel: 'store' }, 'o1');
        await ok('/v1/customer/facts/orders/o-cig', { customerRef: 'demo-cigarettes', at, netMinor: 5_000_000, marginMinor: 200_000, channel: 'store' }, 'o2');
        await ok('/v1/customer/facts/orders/o-quiet', { customerRef: 'demo-no-consent', at, netMinor: 9_000_000, marginMinor: 3_000_000, channel: 'store' }, 'o3');
        // One bill on head office for the household customer, so the Customers page has a record to open.
        await ho.provisionRole(T, 'u-box', 'store_computer', [store]);
        const sale = await ho.request({ method: 'POST', path: '/v1/sales', userId: 'u-box', tenantId: T, branchId: store, idempotencyKey: 'bill-1', body: {
          saleId: 'S-demo-1', receiptNumber: 'R-demo-1', laneId: 'lane-1', cashierId: CASH, tradingDay: shopDay, committedAt: at,
          totalMinor: 50_000, currency: 'INR', packVersion: 1, customerRef: 'demo-household',
          lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 50_000, lineTotalMinor: 50_000 }], tenders: [{ kind: 'cash', amountMinor: 50_000 }],
        } });
        expect(sale.status, JSON.stringify(sale.body)).toBe(202);
        for (const c of ['demo-fresh', 'demo-cigarettes']) await ok(`/v1/customers/${c}/consent`, { purpose: 'profiling', channel: 'email', given: true, evidence: 'demo consent' }, `c-${c}`);
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the ranking is by profit, not spend; a customer who did not agree to be analysed is not ranked', async () => {
    const m = await shop.open(MGR, '/customer-value/');
    await says(m.page, '#rules-state', /The shop uses the standard numbers\./);
    expect(m.writes, 'nothing is written on open').toEqual([]);
    await m.page.click('#k-show');
    await says(m.page, '#ranked li[data-rank="1"]', /1\. demo-fresh/);
    await says(m.page, '#ranked li[data-rank="1"]', /profit brought ₹6,000\.00 · spent ₹20,000\.00 · profit rate 30\.00%/);
    await says(m.page, '#ranked li[data-rank="2"]', /2\. demo-cigarettes.*profit rate 4\.00%/);
    expect(await m.page.$('#ranked li[data-customer="demo-no-consent"]')).toBeNull();
    expect(m.errors).toEqual([]);
    await m.close();
  });

  it('the group rules: the standard until the manager sets "loyal from 6 bills"; head office holds exactly that; a cashier cannot change them', async () => {
    const m = await shop.open(MGR, '/customer-value/');
    await says(m.page, '#rules-form', /Loyal from this many bills \(standard: 10\)/);
    await m.page.fill('#rule-loyalAtOrders', 'six');
    await m.page.click('#rules-save');
    await says(m.page, '#rules-status', /^Each rule is a whole number, 0 or more\.$/);
    await m.page.fill('#rule-loyalAtOrders', '6');
    await m.page.click('#rules-save');
    await says(m.page, '#rules-status', /^Saved\./);
    await says(m.page, '#rules-form', /Loyal from this many bills \(set by the shop: 6\)/);
    expect(((await shop.call('GET', '/v1/customer/segments/policy', OWNER)).body as { policy: unknown }).policy).toEqual({ loyalAtOrders: 6 });
    await m.page.click('#lang');
    await says(m.page, '#rules-h', /^குழு விதிகள்$/);
    await m.close();
    const c = await shop.open(CASH, '/customer-value/');
    await says(c.page, '#page-status', /changing them needs the manager's permission/);
    await says(c.page, '#rules-state', /^Head office refused:/);
    expect(await c.page.isVisible('#rules-save')).toBe(false);
    await c.close();
  });

  it('the Customers page links a customer to a household and takes them out again; the identity history is shown', async () => {
    const m = await shop.open(MGR, '/customers/');
    await m.page.fill('#record-ref', 'demo-household');
    await m.page.click('#record-open');
    await says(m.page, '#record-household', /^Not linked to a household\.$/);
    await says(m.page, '#record-history', /This record has never been merged\./);
    await m.page.click('#household-link');
    await says(m.page, '#household-status', /^Type the household name or code\./);
    await m.page.fill('#household-id', 'demo-kumar-family');
    await m.page.click('#household-link');
    await says(m.page, '#household-status', /^Linked\./);
    await says(m.page, '#record-household', /In household demo-kumar-family — 1 members: demo-household/);
    const profile = (await shop.call('GET', '/v1/customers/demo-household/profile', OWNER)).body as { household: { householdId: string } | null };
    expect(profile.household?.householdId).toBe('demo-kumar-family');
    await m.page.click('#household-unlink');
    await says(m.page, '#household-status', /^Taken out of the household/);
    await says(m.page, '#record-household', /^Not linked to a household\.$/);
    expect(((await shop.call('GET', '/v1/customers/demo-household/profile', OWNER)).body as { household: unknown }).household).toBeNull();
    expect(m.errors).toEqual([]);
    await m.close();
  });
});
