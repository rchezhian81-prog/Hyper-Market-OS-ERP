import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';
import { approvedRequestId } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';

/**
 * **Round 4c (M01-FR-03 · "Settings duplicates Store setup"): Settings is its own page — every setting's history and going
 * back one step — on the store computer, over head office's real routes.**
 *   • the IT administrator reads the delivery radius's three versions (who, why) and puts version 1 back: a NEW version 3,
 *     the earlier two kept;
 *   • the shop's time zone is high-impact: going back is refused by head office until the owner approves exactly that; the
 *     page asks, the owner approves, the same press puts it back;
 *   • a store manager the box lets open the page is refused by head office, in its words.
 */

const OWNER = 'u-owner'; const IT = 'u-it'; const MGR = 'u-mgr';
const SETUP = ['platform.setup.read', 'platform.setup.write'];

describe.skipIf(!HAVE_BROWSER)('Settings and their history (Round 4c)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'settings',
      people: [{ userId: IT, permissions: SETUP }, { userId: MGR, permissions: SETUP }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, IT, 'platform_admin');
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        const put = async (key: string, body: Record<string, unknown>) => {
          const r = await ho.request({ method: 'PUT', path: `/v1/platform/setup/${key}`, userId: IT, tenantId: T, idempotencyKey: `k-${key}-${String(body['value'])}`, body });
          if (r.status !== 200) throw new Error(`${key}: ${r.status} ${JSON.stringify(r.body)}`);
        };
        await put('delivery.radius_km', { value: 5, ifVersion: 0 });
        await put('delivery.radius_km', { value: 8, ifVersion: 1 });
        for (const [value, ifVersion] of [['Asia/Kolkata', 0], ['Asia/Dubai', 1]] as const) {
          const body = { value, ifVersion };
          const approvalId = await approvedRequestId(ho, T, IT, OWNER, { kind: 'config_change', subjectRef: 'setting:locale.time_zone', details: actionDetails(body, { key: 'locale.time_zone' }) });
          await put('locale.time_zone', { ...body, approvalId });
        }
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('reads every version and puts an earlier one back as a new version; a high-impact one only with the owner', async () => {
    const p = await shop.open(IT, '/settings/');
    const radius = '#rows li[data-key="delivery.radius_km"]';
    await says(p.page, radius, /In force: 8 · version 2/);
    await p.page.click(`${radius} button:has-text("Show its history")`);
    await p.page.waitForSelector(`${radius} li[data-version="1"]`);
    await says(p.page, `${radius} li[data-version="1"]`, /version 1: 5.*by u-it/);
    await p.page.fill(`${radius} li[data-version="1"] input`, 'the van broke down');
    await p.page.click(`${radius} li[data-version="1"] button:has-text("Put this value back")`);
    await says(p.page, `${radius} li[data-version="1"] .status`, /now version 3/);
    await says(p.page, radius, /In force: 5 · version 3/);
    const history = (await shop.call('GET', '/v1/platform/config/delivery.radius_km/history', OWNER)).body as { versions: { version: number; rolledBackFrom: number | null }[] };
    expect(history.versions.map((v) => [v.version, v.rolledBackFrom])).toEqual([[1, null], [2, null], [3, 1]]);

    const zone = '#rows li[data-key="locale.time_zone"]';
    await p.page.click(`${zone} button:has-text("Show its history")`);
    await p.page.waitForSelector(`${zone} li[data-version="1"] input`);
    await p.page.fill(`${zone} li[data-version="1"] input`, 'we are in Tamil Nadu');
    await p.page.click(`${zone} li[data-version="1"] button:has-text("Put this value back")`);
    await says(p.page, `${zone} li[data-version="1"] .status`, /the owner approves going back first/);
    await p.page.click(`${zone} li[data-version="1"] button:has-text("Ask the owner to approve")`);
    await says(p.page, `${zone} li[data-version="1"] .status`, /^Asked\./);
    await p.page.click(`${zone} li[data-version="1"] button:has-text("Put it back now (approved)")`);
    await says(p.page, `${zone} li[data-version="1"] .status`, /Still waiting/);
    const mine = (await shop.call('GET', '/v1/approvals/requests', IT)).body as { mine: { requestId: string; kind: string; status: string }[] };
    const ask = mine.mine.find((r) => r.kind === 'config_change' && r.status === 'waiting')!;
    expect((await shop.call('POST', `/v1/approvals/requests/${ask.requestId}/decide`, OWNER, { decision: 'approved', reason: 'right' })).status).toBe(201);
    await p.page.click(`${zone} li[data-version="1"] button:has-text("Put it back now (approved)")`);
    await says(p.page, zone, /In force: Asia\/Kolkata · version 3/);
    expect(p.errors).toEqual([]);
    await p.close();
  });

  it('Sign out is inside the product: behind the hosted front the menu offers it under the person, posting to the front\'s door', async () => {
    const p = await shop.open(IT, '/settings/');
    await p.page.waitForSelector('#sre-menu #sre-sign-out button', { state: 'attached' });
    expect(await p.page.getAttribute('#sre-sign-out', 'action')).toBe('/login/logout');
    expect(await p.page.getAttribute('#sre-sign-out', 'method')).toBe('post');
    expect((await p.page.textContent('#sre-sign-out button'))?.trim()).toBe('Sign out');
    // The box drew no Sign out bar of its own here (the front signed the person in), so there is exactly one.
    expect(await p.page.$$('#sre-office-bar')).toHaveLength(0);
    await p.page.click('#lang');
    await p.page.waitForFunction(() => (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector('#sre-sign-out button')?.textContent?.trim() === 'வெளியேறு');
    await p.close();
  });

  it('a store manager is refused by head office, in its words', async () => {
    const m = await shop.open(MGR, '/settings/');
    await says(m.page, '#list-status', /^Head office refused:/);
    expect(m.writes).toEqual([]);
    await m.close();
  });
});
