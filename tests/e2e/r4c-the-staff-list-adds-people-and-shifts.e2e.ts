import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **Round 4c (M25-FR-01): the Staff list and shifts page, served by the store computer, over head office's roster store.**
 *   • the store manager adds Anu as a cashier and creates tomorrow's 09:00–17:00 shift needing one cashier, on the shop's
 *     clock; head office's roster then has her and the shift, and the Rota's gap list names the shift as short;
 *   • the manager marks her as left: she stays on the list, marked left, and is no longer cover; each change is in the trail;
 *   • a cashier the box lets open the page is refused by head office, in its words, and offered no change.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash';
const TOMORROW = shopDateIn(new Date(Date.now() + 24 * 3_600_000).toISOString());

describe.skipIf(!HAVE_BROWSER)('the Staff list and shifts page (Round 4c)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'staff',
      people: [{ userId: MGR, permissions: ['workforce.roster.read', 'workforce.roster.manage'] }, { userId: CASH, permissions: ['workforce.roster.read'] }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        await ho.provisionRole(T, CASH, 'cashier', [store]);
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the manager adds a person and a shift; the rota sees the gap; marking her left keeps her, not as cover', async () => {
    const m = await shop.open(MGR, '/staff/');
    await says(m.page, '#staff-rows', /Nobody is on the staff list yet\./);
    expect(await m.page.inputValue('#a-store')).toBe(shop.store);
    await m.page.fill('#a-id', 'u-anu'); await m.page.fill('#a-name', 'Anu R'); await m.page.fill('#a-roles', 'Cashier');
    await m.page.click('#a-save');
    await m.page.waitForSelector('#staff-rows li[data-person="u-anu"][data-active="true"]');
    await says(m.page, '#staff-rows li[data-person="u-anu"]', /Anu R \(u-anu\).*works as: cashier/);
    // A shift with no needs is refused on the page; then tomorrow 09:00–17:00 needing one cashier.
    await m.page.fill('#s-starts', `${TOMORROW}T09:00`); await m.page.fill('#s-ends', `${TOMORROW}T17:00`);
    await m.page.click('#s-create');
    await says(m.page, '#shift-status', /Say which roles the shift needs/);
    await m.page.fill('#s-needs', 'cashier 1');
    await m.page.click('#s-create');
    await says(m.page, '#shift-status', /^Shift created\.$/);
    await says(m.page, '#shift-rows li', new RegExp(`${TOMORROW} 09:00 – 17:00.*cashier 1`));
    const roster = (await shop.call('GET', '/v1/hr/workforce/roster', MGR)).body as { employees: { employeeId: string }[]; shifts: { startsAt: string; requiredRoles: unknown[] }[] };
    expect(roster.employees.map((e) => e.employeeId)).toEqual(['u-anu']);
    expect(roster.shifts[0]).toMatchObject({ requiredRoles: [{ role: 'cashier', count: 1 }] });
    expect(new Date(roster.shifts[0]!.startsAt).toISOString()).toBe(new Date(`${TOMORROW}T09:00:00+05:30`).toISOString());
    const gaps = (await shop.call('GET', '/v1/hr/workforce/roster-gaps', MGR)).body as { gapCount: number; unstaffed: number };
    expect(gaps).toMatchObject({ gapCount: 1, unstaffed: 1 });

    await m.page.click('#staff-rows li[data-person="u-anu"] button:has-text("Mark as left")');
    await m.page.waitForSelector('#staff-rows li[data-person="u-anu"][data-active="false"]');
    await says(m.page, '#staff-rows li[data-person="u-anu"]', /left — kept on record, not cover/);
    const trail = (await shop.call('GET', '/v1/audit/trail?objectType=employee', OWNER)).body as { matches: { action: string; actorId: string }[] };
    expect(trail.matches.map((r) => [r.action, r.actorId])).toEqual([['staff.add', MGR], ['staff.leave', MGR]]);
    await m.page.click('#lang');
    await says(m.page, '#list-h', /^பணியாளர் பட்டியல்$/);
    expect(m.errors).toEqual([]);
    await m.close();
  });

  it('a cashier is refused by head office in its words, and offered no change', async () => {
    const c = await shop.open(CASH, '/staff/');
    await says(c.page, '#list-status', /^Head office refused:/);
    expect(await c.page.isVisible('#add')).toBe(false);
    expect(c.writes).toEqual([]);
    await c.close();
  });
});
