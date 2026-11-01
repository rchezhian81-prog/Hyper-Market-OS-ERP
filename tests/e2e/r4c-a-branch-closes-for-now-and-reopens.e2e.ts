import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { approvedActivationBody } from '../support/approved-org-change';

/**
 * **Round 4c (M01-FR-04): the Open and close branches page, on the store computer, over head office's governed lifecycle.**
 *   • the store manager checks what stands in the way of closing B1 for now — head office's measured figures, and only the
 *     owner's approval needed; asks the owner; pressing "make the change" before he approves says it is still waiting;
 *     once he approves, B1 is closed for now, with the day it reopens;
 *   • reopening needs no approval: the manager reopens it; the history names who asked and who approved each change;
 *   • a cashier the box lets press it is refused by head office, in its words.
 */

const OWNER = 'u-owner'; const IT = 'u-it'; const MGR = 'u-mgr'; const CASH = 'u-cash';
const G1 = '33AABCS1429B1Z1';
const WORDS = ['branch.transition.evaluate', 'branch.transition.execute'];

describe.skipIf(!HAVE_BROWSER)('Open and close branches (Round 4c)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'branches', store: 'B1',
      people: [{ userId: MGR, permissions: WORDS }, { userId: CASH, permissions: WORDS }],
      seed: async (ho, T) => {
        await ho.seedOwner(T, OWNER);
        await ho.provisionRole(T, IT, 'platform_admin');
        await ho.provisionRole(T, MGR, 'store_manager', ['B1']);
        await ho.provisionRole(T, CASH, 'cashier', ['B1']);
        const post = async (path: string, body: unknown, who = IT) => {
          const r = await ho.request({ method: 'POST', path, userId: who, tenantId: T, idempotencyKey: `k-${path}`, body });
          if (r.status >= 300) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`);
        };
        await post('/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' });
        await post(`/v1/org/gst-registrations/${G1}`, { companyId: 'C1', legalName: 'SRE Retail Pvt Ltd' });
        await post('/v1/org/nodes/B1', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1', gstin: G1 });
        await post('/v1/org/nodes/B1/activation', await approvedActivationBody(ho, T, IT, OWNER, 'B1'));
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('closes for now with the owner\'s approval, reopens without one; the history names each person', async () => {
    const m = await shop.open(MGR, '/branches/');
    const b1 = '#rows li[data-branch="B1"]';
    await says(m.page, '#list-status', /^$/).catch(async () => { throw new Error(`list-status: ${await m.page.textContent('#list-status')} / page: ${await m.page.textContent('#page-status')}`); });
    await says(m.page, b1, /Main store \(B1\)open/);
    const close = `${b1} .change[data-transition="temporarily_close"]`;
    await m.page.click(`${close} button:has-text("Check what stands in the way")`);
    await says(m.page, `${close} .status`, /^Nothing stands in the way except the approval it needs\.$/);
    await says(m.page, close, /Measured at the branch: Stock held ₹0\.00 · Cash in tills and the safe ₹0\.00/);
    await m.page.fill(`${close} input[id^="why-"]`, 'painting the floor');
    await m.page.click(`${close} button:has-text("Ask the owner to approve")`);
    await says(m.page, `${close} .status`, /Give the day it reopens/);
    await m.page.fill(`${close} input[type="date"]`, '2026-11-20');
    await m.page.click(`${close} button:has-text("Ask the owner to approve")`);
    await says(m.page, `${close} .status`, /^Asked\./);
    await m.page.click(`${close} button:has-text("Make the change now")`);
    await says(m.page, `${close} .status`, /Still waiting/);
    const mine = (await shop.call('GET', '/v1/approvals/requests', MGR)).body as { mine: { requestId: string; kind: string }[] };
    const ask = mine.mine.find((r) => r.kind === 'branch_transition')!;
    expect((await shop.call('POST', `/v1/approvals/requests/${ask.requestId}/decide`, OWNER, { decision: 'approved', reason: 'fine' })).status).toBe(201);
    await m.page.click(`${close} button:has-text("Make the change now")`);
    await says(m.page, b1, /closed for now/);

    const reopen = `${b1} .change[data-transition="reopen"]`;
    await m.page.fill(`${reopen} input[id^="why-"]`, 'floor is dry');
    await m.page.click(`${reopen} button:has-text("Reopen it")`);
    await says(m.page, b1, /Main store \(B1\)open/);
    await m.page.click(`${b1} button:has-text("Show its history")`);
    await says(m.page, b1, /Reopen it · asked by u-mgr · no approval needed · floor is dry/);
    await says(m.page, b1, /Close it for now · asked by u-mgr · approved by u-owner · painting the floor/);
    expect(m.errors).toEqual([]);
    await m.close();
  });

  it('a cashier is refused by head office, in its words', async () => {
    const c = await shop.open(CASH, '/branches/');
    await says(c.page, '#list-status', /^Head office refused:/);
    expect(await c.page.$$('#rows li[data-branch]')).toHaveLength(0);
    expect(c.writes).toEqual([]);
    await c.close();
  });
});
