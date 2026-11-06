import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';

/**
 * **Wave 2 · Round 4a part 2 (M04-FR-02/03/04 · SCREEN-GAP Round D): the shelf places, a planogram and the floor plan are set
 * up on "Set up shelves and floor plan", and the Floor heat map and Shelf compliance by bay then read them — no longer a
 * dead end.** In a real browser, served by the store computer, over head office's real routes:
 *   • before anything is set up, the summary cards say 0 places and no planogram in force, the registers say "nothing yet"
 *     (never "all clear"), and Shelf compliance sends the reader to the setup page;
 *   • the manager adds one bay of two shelves (two places), makes a planogram with one facing, and publishes a floor plan
 *     with one area; head office holds each as version 1, and the trail keeps who did it;
 *   • taking a place off makes shelf map version 2 and the planogram is shown as made on an older map;
 *   • the Floor heat map draws the area; Shelf compliance by bay lists the bay against the planogram in force;
 *   • a clerk the box lets open the page is refused by head office, in its words, and offered no publish; Tamil words.
 * Synthetic data only.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CLERK = 'u-clerk';
const WORDS = ['planogram.compliance.read', 'planogram.publish', 'merchandising.space.read', 'merchandising.range.read', 'shelf.count.record'];

describe.skipIf(!HAVE_BROWSER)('Shelf and floor setup feeds the shelf pages (Wave 2)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'space',
      people: [{ userId: MGR, permissions: WORDS }, { userId: CLERK, permissions: ['planogram.compliance.read'] }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        await ho.provisionRole(T, CLERK, 'cashier', [store]);
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the manager sets up places, a planogram and the floor plan; the heat map and the bays read them', async () => {
    const m = await shop.open(MGR, '/space-setup/');
    // Nothing set up yet: real noughts and "nothing yet", never "all clear".
    await says(m.page, '#cards', /Shelf places\s*0/);
    await says(m.page, '#cards', /Planogram in force today\s*None in force/);
    await says(m.page, '#map-register', /No shelf places yet/);
    await says(m.page, '#floor-register', /No floor plan yet/);

    await m.page.fill('#p-aisle', '1'); await m.page.fill('#p-rack', '1'); await m.page.fill('#p-bay', '1'); await m.page.fill('#p-shelves', '2');
    await m.page.fill('#p-label', 'Rice');
    await m.page.click('#add-places-go');
    await says(m.page, '#map-status', /^Added 2 place\(s\)\. Shelf map version 1 is now in force\.$/);
    await says(m.page, '#place-rows', /A1-R1-B1-S1-P1/);
    await says(m.page, '#cards', /Shelf places\s*2/);

    await m.page.fill('#g-id', 'grocery');
    await m.page.fill('#f-product', 'RICE'); await m.page.selectOption('#f-place', 'A1-R1-B1-S1-P1'); await m.page.fill('#f-cap', '24');
    await m.page.click('#f-add');
    await says(m.page, '#facings', /RICE on A1-R1-B1-S1-P1, holds 24 — main place/);
    await m.page.click('#plan-go');
    await says(m.page, '#plan-status', /^Planogram grocery version 1 published/);
    await says(m.page, '#plan-rows', /grocery.*In force today/);
    await says(m.page, '#cards', /Planogram in force today\s*grocery v1/);

    await m.page.fill('#fl-w', '100'); await m.page.fill('#fl-d', '80');
    await m.page.fill('#a-id', 'rice'); await m.page.fill('#a-name', 'Rice aisle'); await m.page.fill('#a-nameta', 'அரிசி');
    await m.page.fill('#a-x', '0'); await m.page.fill('#a-y', '0'); await m.page.fill('#a-w', '20'); await m.page.fill('#a-d', '10');
    await m.page.fill('#a-places', 'A1-R1-B1-S1-P1, A1-R1-B1-S2-P1');
    await m.page.click('#a-add');
    await m.page.click('#floor-go');
    await says(m.page, '#floor-status', /^Floor plan version 1 published with 1 area\(s\)\.$/);
    await says(m.page, '#area-rows', /rice.*Rice aisle.*200/);

    const held = (await shop.call('GET', `/v1/merchandising/stores/${shop.store}/planograms`, OWNER)).body as { inForce: { planogramId: string; version: number; createdBy: string } };
    expect(held.inForce).toMatchObject({ planogramId: 'grocery', version: 1, createdBy: MGR });

    // The heat map and the bays now read what was set up.
    const h = await shop.open(MGR, '/floor-heat-map/');
    expect(await h.page.inputValue('#store')).toBe(shop.store);
    // OB-620: the page is named plainly, in the menu and on the page alike.
    await says(h.page, '#page-h', /^Which areas earn most$/);
    await h.page.click('#show');
    await h.page.waitForSelector('#floor [data-area="rice"]');
    await says(h.page, '#areas', /Rice aisle/);
    expect(h.errors).toEqual([]);
    await h.close();
    const b = await shop.open(MGR, '/planogram-compliance/');
    await says(b.page, '#page-h', /^Shelves against the plan$/);
    await b.page.click('#show');
    await says(b.page, '#bays', /1/);
    await says(b.page, '#bays-h', /grocery/);
    expect(b.errors).toEqual([]);
    await b.close();

    // Taking a place off is a new shelf-map version; the planogram is then flagged as made on the older map.
    await m.page.click('#place-rows tr[data-place="A1-R1-B1-S2-P1"] button');
    await m.page.click('[data-action="take-off"]');
    await says(m.page, '#map-status', /^Taken off\. Head office kept the earlier version\.$/);
    await says(m.page, '#cards', /Shelf map version\s*2/);
    await says(m.page, '#plan-rows', /Made on an older shelf map/);

    await m.page.click('#lang');
    await says(m.page, '#page-h', /^அலமாரிகளையும் தளத் திட்டத்தையும் அமை$/);
    expect(m.errors).toEqual([]);
    expect(m.writes.filter((w) => w.startsWith('PUT') || w.startsWith('POST'))).toEqual([
      `PUT /v1/merchandising/stores/${shop.store}/shelf-map`, `PUT /v1/merchandising/stores/${shop.store}/planograms/grocery`,
      `POST /v1/merchandising/stores/${shop.store}/floor-plan`, `PUT /v1/merchandising/stores/${shop.store}/shelf-map`,
    ]);
    await m.close();
  });

  it('before anything is set up, Shelf compliance by bay sends the reader to the setup page', async () => {
    const other = await shop.open(MGR, '/planogram-compliance/');
    await other.page.fill('#store', 'store-unset');
    await other.page.click('#show');
    await says(other.page, '#page-status', /Set them up on the page "Set up shelves and floor plan"/);
    await other.close();
  });

  it('a clerk is refused by head office, in its words, and offered no publish', async () => {
    const c = await shop.open(CLERK, '/space-setup/');
    await says(c.page, '#page-status', /^Head office refused:/);
    expect(await c.page.isVisible('#add-places')).toBe(false);
    expect(await c.page.isVisible('#plan-form')).toBe(false);
    expect(c.writes).toEqual([]);
    await c.close();
  });
});
