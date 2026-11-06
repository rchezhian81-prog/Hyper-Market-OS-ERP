import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **Round 4c (C20 · POSH Act · OB-157): the Internal Committee's own page makes the year's annual report from its register,
 * on the store computer, over head office's real routes — counts only.**
 *   • only the committee's role opens it from the menu;
 *   • last year is due; the committee member makes its report: one received, none disposed, one still open — and no
 *     complaint's words appear anywhere on the page;
 *   • the owner (who files the report, but never sees the register) is refused making it, by head office in its words.
 */

const OWNER = 'u-owner'; const IC = 'u-ic';
const LAST_YEAR = new Date().getUTCFullYear() - 1;
const WORDS = ['posh.report.generate', 'posh.report.read'];

describe('the committee page is on the committee\'s menu only', () => {
  it('opens with the committee\'s own word, which no other role holds', () => {
    const item = ERP_NAVIGATION.find((i) => i.id === 'posh-committee')!;
    expect(item).toMatchObject({ path: '/posh-committee', requires: 'posh.report.generate', group: 'People' });
    expect(ROLE_CATALOGUE.filter((r) => r.permissions.includes(item.requires)).map((r) => r.id)).toEqual(['internal_committee']);
  });
});

describe.skipIf(!HAVE_BROWSER)('the Internal Committee makes its annual report (Round 4c)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'posh',
      people: [{ userId: IC, permissions: WORDS }, { userId: OWNER, permissions: WORDS }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, IC, 'internal_committee');
        const r = await ho.request({ method: 'POST', path: '/v1/hr/posh/complaints', userId: IC, tenantId: T, idempotencyKey: 'c-1', body: { receivedOn: `${LAST_YEAR}-06-10`, complainantRef: 'C-REF-1', respondentRef: 'R-REF-1', summary: 'CONFIDENTIAL WORDS' } });
        if (r.status >= 300) throw new Error(JSON.stringify(r.body));
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the committee member makes last year\'s report — counts only', async () => {
    const p = await shop.open(IC, '/posh-committee/');
    const row = `#rows li[data-year="${LAST_YEAR}"]`;
    await says(p.page, row, /not made yet/);
    await p.page.click(`${row} button:has-text("Make the report")`);
    await p.page.waitForSelector(`${row} .report`);
    await says(p.page, `${row} .report`, /Received in the year1.*Disposed of in the year0.*Still open on 31 December1/);
    await says(p.page, row, / · made/);
    expect(await p.page.content()).not.toContain('CONFIDENTIAL WORDS');
    expect(await p.page.content()).not.toContain('C-REF-1');
    expect(p.writes).toEqual([`POST /v1/hr/posh/annual-reports/${LAST_YEAR}`]);
    await p.page.click('#lang');
    await says(p.page, '#years-h', /^அறிக்கையிட வேண்டிய ஆண்டுகள்$/);
    expect(p.errors).toEqual([]);
    await p.close();
  });

  it('the owner is refused making the report, by head office in its words', async () => {
    const o = await shop.open(OWNER, '/posh-committee/');
    await o.page.waitForSelector(`#rows li[data-year="${LAST_YEAR}"] button`);
    await o.page.click(`#rows li[data-year="${LAST_YEAR}"] button:has-text("Make it again")`);
    await says(o.page, `#rows li[data-year="${LAST_YEAR}"] .status`, /^Head office refused:/);
    await o.close();
  });
});
