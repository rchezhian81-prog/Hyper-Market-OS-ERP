import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';

/**
 * **Round 4d (M26-FR-01/02/03 · D-6 · Screen D): the Facilities set-up page, on the store computer, over head office's
 * facilities engines.**
 *   • the store manager registers the dairy chiller, a spare fan motor that fits it, receives two, logs a breakdown repair
 *     that used one (head office takes it off the register), sets the chiller's range, a pest-control schedule with its
 *     first task, and a temperature check — each then held by head office;
 *   • a cashier the box lets open the page is refused by head office, in its words, and offered no form.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash';
const WORDS = ['facilities.asset.read', 'facilities.asset.manage', 'facilities.overdue.read', 'facilities.schedule.manage', 'facilities.task.record'];

describe.skipIf(!HAVE_BROWSER)('Facilities set-up (Round 4d)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'facilities-setup',
      people: [{ userId: MGR, permissions: WORDS }, { userId: CASH, permissions: ['facilities.asset.read'] }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        await ho.provisionRole(T, CASH, 'cashier', [store]);
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the manager sets up an asset, a spare, a service that used it, a room, a schedule and a check', async () => {
    const m = await shop.open(MGR, '/facilities-setup');
    await says(m.page, '#assets-register', /No asset registered for this store yet/);
    // an asset
    await m.page.fill('#a-name', 'Dairy chiller');
    await m.page.selectOption('#a-kind', 'refrigeration');
    await m.page.selectOption('#a-criticality', 'critical');
    await m.page.click('#a-save');
    await says(m.page, '#a-installed-msg', /Fill in/);
    await m.page.fill('#a-installed', '2025-01-10');
    await m.page.click('#a-save');
    await says(m.page, '#asset-status', /^Asset saved\.$/);
    await says(m.page, '#asset-rows', /Dairy chiller/);
    // a spare part that fits it, and two received
    await m.page.click('#tab-spares');
    await m.page.fill('#p-name', 'Condenser fan motor');
    await m.page.fill('#p-minimum', '2');
    await m.page.check('#p-fits input');
    await m.page.click('#p-save');
    await says(m.page, '#spare-status', /^Spare part saved\.$/);
    await says(m.page, '#spare-rows', /Condenser fan motor/);
    await m.page.click('#spare-rows tr .sre-row-open');
    await m.page.fill('#received-qty', '2');
    await m.page.click('#received-save');
    await says(m.page, '#received-status', /^Stock received recorded\.$/);
    await says(m.page, '#spare-rows', /2 each/);
    await m.page.keyboard.press('Escape');
    // a service that used one
    await m.page.click('#tab-assets');
    await m.page.click('#asset-rows tr .sre-row-open');
    await m.page.fill('#sv-by', 'Cool Air AMC');
    await m.page.selectOption('#sv-kind', 'breakdown');
    await m.page.fill('#sv-spare-' + (await m.page.$eval('[id^="sv-spare-"]', (e) => (e as unknown as { id: string }).id.slice('sv-spare-'.length))), '1');
    await m.page.click('#log-service');
    await says(m.page, '#service-status', /^Service logged/);
    await m.page.keyboard.press('Escape');
    await m.page.click('#tab-spares');
    await says(m.page, '#spare-rows', /1 each.*running low/);
    // the chiller's range
    await m.page.click('#tab-rooms');
    await m.page.fill('#r-name', 'Dairy chiller');
    await m.page.fill('#r-min', '0');
    await m.page.fill('#r-max', 'warm');
    await m.page.click('#r-save');
    await says(m.page, '#room-status', /Type the temperature in °C/);
    await m.page.fill('#r-max', '4.5');
    await m.page.click('#r-save');
    await says(m.page, '#room-status', /^Range saved\.$/);
    await says(m.page, '#room-rows', /0\.0 … 4\.5/);
    // a schedule and its first task
    await m.page.click('#tab-schedules');
    await m.page.fill('#s-title', 'Pest control');
    await m.page.selectOption('#s-category', 'pest_control');
    await m.page.selectOption('#s-frequency', 'monthly');
    await m.page.fill('#s-escalates', OWNER);
    await m.page.check('#s-evidence');
    await m.page.click('#s-save');
    await says(m.page, '#schedule-status', /^Schedule saved\.$/);
    await m.page.click('#schedule-rows tr .sre-row-open');
    await m.page.fill('#raise-due', '2026-11-05');
    await m.page.click('#raise-task');
    await says(m.page, '#raise-status', /^Task raised/);
    await m.page.keyboard.press('Escape');
    await says(m.page, '#schedule-rows', /2026-11-05/);
    // a temperature check
    await m.page.click('#tab-checks');
    await m.page.fill('#c-title', 'Dairy chiller temperature');
    await m.page.selectOption('#c-kind', 'temperature');
    await m.page.fill('#c-starts', '2026-11-01T08:00');
    await m.page.fill('#c-min', '0');
    await m.page.fill('#c-max', '5');
    await m.page.fill('#c-escalates', MGR);
    await m.page.click('#c-save');
    await says(m.page, '#check-status', /^Check saved\./);
    await says(m.page, '#check-rows', /Dairy chiller temperature/);

    const office = (await shop.call('GET', `/v1/facilities/office?branchId=${shop.store}`, MGR)).body as { assets: { name: string; lastServicedOn: string | null }[]; equipment: { name: string; range: { maxTenthsC: number } }[]; spares: { low: { name: string; onHand: number }[] } };
    expect(office.assets.map((a) => a.name)).toEqual(['Dairy chiller']);
    expect(office.assets[0]!.lastServicedOn).not.toBeNull();
    expect(office.equipment[0]!.range.maxTenthsC).toBe(45);
    expect(office.spares.low).toEqual([expect.objectContaining({ name: 'Condenser fan motor', onHand: 1 })]);
    const status = (await shop.call('GET', `/v1/facilities/food-safety/status?branchId=${shop.store}`, MGR)).body as { checks: { title: string; maxTenthsC: number }[] };
    expect(status.checks).toEqual([expect.objectContaining({ title: 'Dairy chiller temperature', maxTenthsC: 50 })]);
    await m.page.click('#lang');
    await says(m.page, '#checks-h', /^உணவுப் பாதுகாப்புச் சோதனைகள்$/);
    expect(m.errors).toEqual([]);
    await m.close();
  });

  it('a cashier is refused by head office, in its words, and offered no form', async () => {
    const c = await shop.open(CASH, '/facilities-setup');
    await says(c.page, '#assets-register', /Head office refused:|cannot/);
    expect(await c.page.isVisible('#asset-form')).toBe(false);
    expect(c.writes).toEqual([]);
    await c.close();
  });
});
