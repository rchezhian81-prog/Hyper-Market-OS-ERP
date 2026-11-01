import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';

/**
 * **Round 4c: Users & roles in a real browser, served by the store computer, over head office's real routes.**
 *   • the store manager asks for the cashier role for a new person; the request waits, and the manager is offered no approve;
 *   • the owner approves it on the page; the new person then holds the role;
 *   • the manager asks to take one of two roles back from a person; the owner approves on head office (the Approvals page's
 *     route); the manager applies it on the page; the person keeps only the other role;
 *   • the four roadmap §28 roles show as waiting for the owner, with their permissions (OB-615);
 *   • a cashier the box lets open the page is refused by head office, in its words; nothing is written.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash'; const NEW = 'u-new';
const ROLE_WORDS = ['identity.role.read', 'identity.role.request', 'identity.role.grant'];
const MGR_WORDS = ['identity.role.request'];

describe.skipIf(!HAVE_BROWSER)('Users & roles: give and take back a role, two people each time (Round 4c)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'users',
      people: [{ userId: OWNER, permissions: ROLE_WORDS }, { userId: MGR, permissions: MGR_WORDS }, { userId: CASH, permissions: ['identity.role.read'] }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        await ho.provisionRole(T, CASH, 'cashier', [store]);
        await ho.provisionRole(T, CASH, 'security_reviewer', [store]);
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the manager asks, the owner approves, the role is held; the manager takes one back with the owner\'s approval', async () => {
    const m = await shop.open(MGR, '/users/');
    await m.page.waitForSelector(`#holder-rows li[data-person="${CASH}"]`);
    expect(await m.page.$$eval(`#holder-rows li[data-person="${CASH}"] [data-role]`, (rows) => rows.map((r) => (r as unknown as { dataset: { role: string } }).dataset.role).sort())).toEqual(['cashier', 'security_reviewer']);
    await m.page.waitForSelector('#g-role option[value="cashier"]', { state: 'attached' });
    await m.page.fill('#g-person', NEW);
    await m.page.selectOption('#g-role', 'cashier');
    await m.page.fill('#g-stores', shop.store);
    await m.page.fill('#g-reason', 'new cashier from Monday');
    await m.page.click('#g-ask');
    await says(m.page, '#give-status', /once the owner approves it/);
    // The manager asks; deciding is the owner's — the manager is shown no list of decisions to make.
    expect(await m.page.isVisible('#pending')).toBe(false);
    // OB-615: no waiting role is offered to give.
    expect(await m.page.$$('#g-role option[value="purchase_user"]')).toHaveLength(0);

    const o = await shop.open(OWNER, '/users/');
    await o.page.waitForSelector('#pending-rows li[data-grant] button');
    await o.page.click('#pending-rows li[data-grant] button:has-text("Approve")');
    await o.page.waitForSelector(`#holder-rows li[data-person="${NEW}"] [data-role="cashier"]`);
    // OB-615: the four roles wait for the owner, each with its permissions and why.
    expect(await o.page.$$eval('#waiting-rows > li', (ls) => ls.map((l) => (l as unknown as { dataset: { role: string } }).dataset.role))).toEqual(['purchase_user', 'purchase_approver', 'receiver_qc', 'warehouse_user']);
    await says(o.page, '#waiting-rows li[data-role="receiver_qc"]', /Receive\/count\/QC\/quarantine.*purchase\.order\.receive — Record the goods received/);
    expect(o.errors).toEqual([]);

    // Take back the security reviewer role from the cashier (they keep the cashier role).
    await m.page.reload({ waitUntil: 'load' });
    const row = `#holder-rows li[data-person="${CASH}"]`;
    await m.page.waitForSelector(`${row} [data-role="security_reviewer"] button`);
    await m.page.fill(`${row} input`, 'no longer the reviewer');
    await m.page.click(`${row} [data-role="security_reviewer"] button`);
    await says(m.page, `${row} .status`, /The owner approves it on the Approvals page/);
    await m.page.waitForSelector('#mine-rows li[data-status="waiting"]');
    const requestId = await m.page.getAttribute('#mine-rows li[data-status="waiting"]', 'data-request');
    // The owner approves on head office (what the Approvals page sends).
    const decided = await shop.call('POST', `/v1/approvals/requests/${requestId!}/decide`, OWNER, { decision: 'approved', reason: 'agreed' });
    expect(decided.status, JSON.stringify(decided.body)).toBe(201);
    await m.page.reload({ waitUntil: 'load' });
    await m.page.waitForSelector(`#mine-rows li[data-request="${requestId!}"][data-status="approved"] button`);
    await m.page.click(`#mine-rows li[data-request="${requestId!}"] button`);
    // Applied: the page reads head office again and the change shows as done.
    await m.page.waitForSelector(`#mine-rows li[data-request="${requestId!}"][data-status="used"]`);
    const grants = (await shop.call('GET', '/v1/identity/grants', OWNER)).body as { grants: { userId: string; roleId: string }[] };
    expect(grants.grants.filter((g) => g.userId === CASH).map((g) => g.roleId)).toEqual(['cashier']);
    // The page is in Tamil on the toggle.
    await m.page.click('#lang');
    await says(m.page, '#holders-h', /^யார் எந்தப் பங்கை வகிக்கிறார்$/);
    expect(m.errors).toEqual([]);
    expect(m.writes.sort()).toEqual(['POST /v1/access/lifecycle/' + (m.writes.find((w) => w.includes('lifecycle'))?.split('/').pop() ?? ''), 'POST /v1/approvals/requests', 'POST /v1/identity/grants'].sort());
    await m.close(); await o.close();
  });

  it('M02-FR-02: the manager limits a person\'s role to a department; the owner approves; applied, it stands — never one\'s own', async () => {
    const dept = await shop.call('POST', '/v1/org/nodes/D-dairy', OWNER, { kind: 'department', name: 'Dairy', parentId: shop.store });
    expect(dept.status, JSON.stringify(dept.body)).toBeLessThan(300);
    const m = await shop.open(MGR, '/users/');
    await m.page.waitForSelector('#l-role option[value="cashier"]', { state: 'attached' });
    // Never one's own reach — refused on the page before anything is sent.
    await m.page.fill('#l-person', MGR); await m.page.selectOption('#l-role', 'store_manager'); await m.page.selectOption('#l-dimension', 'departments');
    await m.page.fill('#l-values', 'D-dairy'); await m.page.fill('#l-reason', 'dairy only');
    await m.page.click('#l-ask');
    await says(m.page, '#limit-status', /^Nobody asks for a change to their own access/);
    await m.page.fill('#l-person', CASH); await m.page.selectOption('#l-role', 'cashier');
    await m.page.click('#l-ask');
    await says(m.page, '#limit-status', /The owner approves it on the Approvals page/);
    await m.page.waitForSelector('#mine-rows li[data-status="waiting"]');
    const requestId = await m.page.getAttribute('#mine-rows li[data-status="waiting"]', 'data-request');
    // The manager cannot approve their own ask; the owner does.
    expect((await shop.call('POST', `/v1/approvals/requests/${requestId!}/decide`, MGR, { decision: 'approved', reason: 'mine' })).status).toBeGreaterThanOrEqual(400);
    expect((await shop.call('POST', `/v1/approvals/requests/${requestId!}/decide`, OWNER, { decision: 'approved', reason: 'agreed' })).status).toBe(201);
    await m.page.reload({ waitUntil: 'load' });
    await m.page.click(`#mine-rows li[data-request="${requestId!}"] button`);
    // Applied: the page reads head office again and the change shows as done.
    await m.page.waitForSelector(`#mine-rows li[data-request="${requestId!}"][data-status="used"]`);
    const scopes = (await shop.call('GET', '/v1/identity/department-scopes', OWNER)).body as { scopes: { userId: string; roleId: string; departments: string[] }[] };
    expect(scopes.scopes).toEqual([expect.objectContaining({ userId: CASH, roleId: 'cashier', departments: ['D-dairy'], requestedBy: MGR, approvedBy: OWNER })]);
    expect(m.errors).toEqual([]);
    await m.close();
  });

  it('a cashier the box lets open the page is refused by head office, in its words; nothing is written', async () => {
    const c = await shop.open(CASH, '/users/');
    await says(c.page, '#pending-status', /^Head office refused:/);
    expect(await c.page.isVisible('#give')).toBe(false);
    expect(c.writes).toEqual([]);
    expect(c.errors).toEqual([]);
    await c.close();
  });
});
