import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **Round 4c (M35-FR-04): CERT-In reports and capacity, on the store computer, over head office's real routes.**
 *   • the owner decides an open incident must be reported to CERT-In (noticed an hour ago, shop time): its clock shows
 *     "report due" by noticed + 6 hours; he records the report as made, and it reads "reported in time";
 *   • the capacity report shows each measure "not known" or "not set" until the plan is entered — never a made-up zero; the
 *     owner enters the growth and what is provisioned; the plan is version 1;
 *   • the store manager sees the clock but is offered no decision; a decision forced through is refused by head office.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr';
const WORDS = ['platform.health.read', 'platform.certin.manage', 'platform.service.manage'];
const hourAgo = new Date(Date.now() - 3_600_000);
const shopLocal = (d: Date): string => {
  const day = shopDateIn(d.toISOString());
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return `${day}T${time}`;
};

describe.skipIf(!HAVE_BROWSER)('CERT-In reports and capacity (Round 4c)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'certin',
      people: [{ userId: OWNER, permissions: WORDS }, { userId: MGR, permissions: ['platform.health.read'] }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        const r = await ho.request({ method: 'POST', path: '/v1/platform/incidents/inc-1', userId: OWNER, tenantId: T, idempotencyKey: 'inc-1', body: { title: 'Phishing mail opened at the office PC', severity: 'sev2', summary: 'A staff member opened a phishing link.' } });
        if (r.status >= 300) throw new Error(JSON.stringify(r.body));
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the owner classifies, reports in time, and enters the capacity plan', async () => {
    const o = await shop.open(OWNER, '/cert-in/');
    await says(o.page, '#clocks', /No incident has been classified for CERT-In\./);
    await o.page.waitForSelector('#c-incident option[value="inc-1"]', { state: 'attached' });
    await o.page.selectOption('#c-reportable', 'yes');
    await o.page.fill('#c-category', 'phishing'); await o.page.fill('#c-noticed', shopLocal(hourAgo)); await o.page.fill('#c-reason', 'a credential may have been taken');
    await o.page.click('#c-save');
    await says(o.page, '#classify-status', /^Recorded\.$/);
    await says(o.page, '#clocks li[data-incident="inc-1"]', /report due.*report by .*minutes left/);
    await o.page.fill('#r-at', shopLocal(new Date(Date.now() - 60_000))); await o.page.fill('#r-reference', 'CERTIN-2026-1101-07'); await o.page.fill('#r-channel', 'email to incident@cert-in.org.in');
    await o.page.click('#r-save');
    await says(o.page, '#clocks li[data-incident="inc-1"]', /reported in time.*CERTIN-2026-1101-07/);

    await says(o.page, '#cap-rows li[data-measure="bills_per_day"]', /not known/);
    expect(await o.page.$$eval('#cap-rows li', (ls) => ls.map((l) => (l as unknown as { dataset: { verdict: string } }).dataset.verdict))).toEqual(Array(6).fill('not_known'));
    await o.page.fill('#p-growth', 'ten');
    await o.page.click('#p-save');
    await says(o.page, '#plan-status', /Write whole numbers/);
    await o.page.fill('#p-growth', '10'); await o.page.fill('#p-products', '50000'); await o.page.fill('#p-lanes', '12');
    await o.page.click('#p-save');
    await says(o.page, '#plan-status', /plan is now version 1/);
    await says(o.page, '#cap-rows li[data-measure="products"]', /Provisioned for: 50000/);
    expect(o.errors).toEqual([]);
    await o.close();
  });

  it('the store manager reads the clock and is offered no decision; head office refuses one forced through', async () => {
    const m = await shop.open(MGR, '/cert-in/');
    await m.page.waitForSelector('#clocks li[data-incident="inc-1"]');
    expect(await m.page.isVisible('#classify')).toBe(false);
    expect(await m.page.isVisible('#plan')).toBe(false);
    expect(m.writes).toEqual([]);
    const forced = await shop.call('POST', '/v1/platform/incidents/inc-1/cert-in', MGR, { reportable: false, category: 'x', reason: 'x', noticedAt: hourAgo.toISOString() });
    expect(forced.status).toBe(403);
    await m.close();
  });
});
