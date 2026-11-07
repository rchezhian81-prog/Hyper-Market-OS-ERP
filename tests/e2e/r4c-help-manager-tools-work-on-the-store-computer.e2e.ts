import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';

/**
 * **Round 4c (M25-FR-04 · D11-FR-06): Help and procedures — the manager's tools work on the STORE COMPUTER** (they were
 * hidden there, apps/web-erp/src/help-session.ts). Through the box's own page, as the signed-in person, to head office:
 *   • the store manager writes a procedure in English and Tamil and records an emergency drill; head office holds both;
 *   • the owner sets the emergency contacts there too;
 *   • a cashier the box lets see the tools is refused by head office, in its words; nothing is stored.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash';
const TOOLS = ['workforce.help.read', 'workforce.roster.manage', 'workforce.training.manage', 'workforce.emergency.manage'];

describe.skipIf(!HAVE_BROWSER)('Help and procedures: the manager tools on the store computer (Round 4c)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'help',
      people: [{ userId: MGR, permissions: TOOLS }, { userId: OWNER, permissions: TOOLS }, { userId: CASH, permissions: TOOLS }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        await ho.provisionRole(T, CASH, 'cashier', [store]);
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the manager writes a procedure and records a drill; the owner sets the contacts — all reach head office', async () => {
    const m = await shop.open(MGR, '/help/');
    await m.page.waitForSelector('#manage:not([hidden])');
    await m.page.fill('#w-id', 'EM-FIRE'); await m.page.selectOption('#w-cat', 'emergency');
    await m.page.fill('#w-title', 'Fire'); await m.page.fill('#w-title-ta', 'தீ'); await m.page.fill('#w-roles', 'cashier, store_manager');
    await m.page.fill('#w-en', 'Leave by the nearest door.'); await m.page.fill('#w-ta', 'அருகிலுள்ள கதவு வழியாக வெளியேறவும்.');
    await m.page.click('#w-save');
    await says(m.page, '#w-status', /^Saved\.$/);
    await m.page.waitForSelector('#drills:not([hidden])');
    await m.page.fill('#d-sop', 'EM-FIRE'); await m.page.fill('#d-branch', shop.store); await m.page.fill('#d-on', '30/10/2026');
    await m.page.fill('#d-who', 'u-mgr, u-cash'); await m.page.fill('#d-found', 'The back door was blocked by crates.');
    await m.page.click('#d-save');
    await says(m.page, '#d-status', /^Saved\.$/);
    const lib = (await shop.call('GET', '/v1/hr/workforce/help', MGR)).body as { sops: { sopId: string; category: string }[] };
    expect(lib.sops.find((s) => s.sopId === 'EM-FIRE')).toMatchObject({ category: 'emergency' });
    const drills = (await shop.call('GET', '/v1/hr/workforce/emergency-drills', MGR)).body as { procedures: { sopId: string; lastHeldOn: string | null }[] };
    expect(drills.procedures.find((p) => p.sopId === 'EM-FIRE')?.lastHeldOn).toBe('2026-10-30');
    expect(m.errors).toEqual([]);
    await m.close();

    const o = await shop.open(OWNER, '/help/');
    await o.page.waitForSelector('#set-contacts:not([hidden])');
    await o.page.fill('#sc-lines', 'Fire service, 101\nAmbulance, 108');
    await o.page.click('#sc-save');
    await says(o.page, '#sc-status', /^Saved\.$/);
    await o.close();
  });

  it('a cashier is refused by head office, in its words; nothing is stored', async () => {
    const c = await shop.open(CASH, '/help/');
    await c.page.waitForSelector('#manage:not([hidden])');
    await c.page.fill('#w-id', 'EM-X'); await c.page.fill('#w-title', 'X'); await c.page.fill('#w-title-ta', 'எக்ஸ்'); await c.page.fill('#w-roles', 'cashier');
    await c.page.fill('#w-en', 'x'); await c.page.fill('#w-ta', 'எ');
    await c.page.click('#w-save');
    await says(c.page, '#w-status', /^Head office refused:/);
    const lib = (await shop.call('GET', '/v1/hr/workforce/help', MGR)).body as { sops: { sopId: string }[] };
    expect(lib.sops.map((s) => s.sopId)).not.toContain('EM-X');
    await c.close();
  });
});
