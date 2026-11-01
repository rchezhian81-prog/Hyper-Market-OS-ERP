import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';

/**
 * **Round 4c (M34-FR-01/02 · NFR-15): the Audit log page, served by the store computer, reads head office's STORED domain
 * trail** — in a real browser, over head office's real routes:
 *   • the owner sees the role the manager asked for and the owner approved, newest first, who and when, before and after;
 *   • a search by what was done narrows it; checking the chain says every seal holds; rebuilding the person from the record
 *     shows the change that made it;
 *   • the store manager (no audit word at head office) is refused by head office in its words; nothing is written, ever.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const NEW = 'u-new';

describe.skipIf(!HAVE_BROWSER)('the Audit log page (Round 4c)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'audit',
      people: [{ userId: OWNER, permissions: ['audit.retention.read'] }, { userId: MGR, permissions: ['audit.retention.read'] }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        const ask = await ho.request({ method: 'POST', path: '/v1/identity/grants', userId: MGR, tenantId: T, branchId: store, idempotencyKey: 'ask', body: { grantId: 'g-new', userId: NEW, roleId: 'cashier', branchScope: [store], reason: 'new cashier' } });
        if (ask.status !== 202) throw new Error(JSON.stringify(ask.body));
        const ok = await ho.request({ method: 'POST', path: '/v1/identity/grants/g-new/approve', userId: OWNER, tenantId: T, idempotencyKey: 'ok', body: {} });
        if (ok.status !== 201) throw new Error(JSON.stringify(ok.body));
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the owner reads who did what, checks the chain and rebuilds the person from the record; nothing is written', async () => {
    const o = await shop.open(OWNER, '/audit-log/');
    await o.page.waitForSelector('#rows li[data-action="role.grant"]');
    expect(await o.page.$$eval('#rows li[data-object]', (ls) => ls.map((l) => (l as unknown as { dataset: { action: string } }).dataset.action).slice(0, 2))).toEqual(['role.grant', 'role.grant.request']);
    await says(o.page, '#rows li[data-action="role.grant"]', /role\.grant — user u-new.*by u-owner.*After: roleId: cashier/);
    await o.page.fill('#q-action', 'role.grant.request');
    await o.page.click('#q-find');
    await says(o.page, '#search-status', /^1 changes found$/);
    await says(o.page, '#rows li', /by u-mgr/);
    await o.page.click('#v-check');
    await says(o.page, '#verify-status', /^✓ The chain holds: \d+ records checked/);
    await o.page.fill('#r-type', 'user'); await o.page.fill('#r-id', NEW);
    await o.page.click('#r-go');
    await says(o.page, '#rebuild-status', /^2 changes made it$/);
    await says(o.page, '#rebuilt-state', /roleId: cashier/);
    await o.page.click('#lang');
    await says(o.page, '#search-h', /^மாற்றங்களைத் தேடு$/);
    expect(o.writes).toEqual([]);
    expect(o.errors).toEqual([]);
    await o.close();
  });

  it('the store manager is refused by head office, in its words', async () => {
    const m = await shop.open(MGR, '/audit-log/');
    await says(m.page, '#search-status', /^Head office refused:/);
    expect(m.writes).toEqual([]);
    await m.close();
  });
});
