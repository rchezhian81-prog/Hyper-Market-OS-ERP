import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';

/**
 * **W3 (M16-FR-03 · M20-FR-04 · §28 · hard rule #6): the Customer data requests page, on the store computer, over head
 * office's own data-rights routes. Demo customers only — erasing a real customer's data waits for OB-49.**
 *   • the manager records a demo customer's request for a copy, checks who is asking, and hands the copy over: head office
 *     holds the request as done, and the page offers the file;
 *   • an erasure: checked, the held data shown with what the law keeps, approved by the OWNER (the second person); the owner
 *     cannot also carry it out (head office refuses, in its words); the manager carries it out, the customer statement says
 *     what was kept and why, and head office's sealed record of the erasure stands;
 *   • a cashier the box lets open the page is refused by head office, in its words, and offered no form.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash';
const WORDS = ['privacy.request.manage', 'privacy.erasure.approve', 'privacy.erasure.execute', 'customer.profile.read'];

describe.skipIf(!HAVE_BROWSER)('Customer data requests (W3 · M16-FR-03)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'data-requests',
      people: [{ userId: OWNER, permissions: WORDS }, { userId: MGR, permissions: WORDS }, { userId: CASH, permissions: ['privacy.request.manage'] }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        await ho.provisionRole(T, CASH, 'cashier', [store]);
        // The demo customer's located personal data: contact details (no law keeps them) and two tax invoices (GST law does).
        const pii = async (category: string, body: Record<string, unknown>) => {
          const r = await ho.request({ method: 'POST', path: `/v1/privacy/pii/demo-c-erase/${category}`, userId: OWNER, tenantId: T, idempotencyKey: `pii-${category}`, body });
          expect(r.status).toBe(201);
        };
        await pii('contact', { recordCount: 1 });
        await pii('tax-invoices', { recordCount: 2, retentionBasis: 'tax_invoice', retainUntil: '2034-03-31' });
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('a copy: recorded, checked, handed over — head office holds it as done and the page offers the file', async () => {
    const m = await shop.open(MGR, '/data-requests/');
    await says(m.page, '#rows', /No request is waiting\./);
    expect(m.writes, 'nothing is written on open').toEqual([]);
    await m.page.fill('#r-customer', 'demo-c-copy'); await m.page.selectOption('#r-kind', 'export');
    await m.page.click('#r-record');
    await says(m.page, '#record-status', /^Recorded\./);
    await says(m.page, '#rows li[data-kind="export"]', /demo-c-copy — a copy of their data · not yet checked/);
    await m.page.click('#rows li[data-kind="export"] button.verify');
    await says(m.page, '#rows li[data-kind="export"] .status', /^Say how they proved who they are\.$/);
    await m.page.fill('#rows li[data-kind="export"] input.how', 'showed the shop app signed in on her own phone');
    await m.page.click('#rows li[data-kind="export"] button.verify');
    await says(m.page, '#rows li[data-kind="export"]', /· checked/);
    await m.page.click('#rows li[data-kind="export"] button.export');
    await says(m.page, '#rows li[data-kind="export"] .status', /^Handed over\./);
    expect(await m.page.getAttribute('#rows li[data-kind="export"] a.save', 'download')).toMatch(/^data-request-dsr-.+\.json$/);
    const all = (await shop.call('GET', '/v1/privacy/data-requests?state=all', OWNER)).body as { queue: { customerRef: string; state: string; verifiedBy?: string }[] };
    expect(all.queue.find((r) => r.customerRef === 'demo-c-copy')).toMatchObject({ state: 'fulfilled', verifiedBy: 'showed the shop app signed in on her own phone' });
    expect(m.errors).toEqual([]);
    await m.close();
  });

  it('an erasure: the owner approves, cannot also carry it out; the manager does — the law\'s records kept, the sealed record stands', async () => {
    const o = await shop.open(OWNER, '/data-requests/');
    await says(o.page, '#list-status', /^$/);
    await o.page.fill('#r-customer', 'demo-c-erase'); await o.page.selectOption('#r-kind', 'erasure');
    await o.page.click('#r-record');
    await says(o.page, '#rows li[data-kind="erasure"]', /demo-c-erase — erase their data · not yet checked/);
    await o.page.fill('#rows li[data-kind="erasure"] input.how', 'came to the desk with the phone the account is on');
    await o.page.click('#rows li[data-kind="erasure"] button.verify');
    await says(o.page, '#rows li[data-kind="erasure"]', /· checked/);
    await o.page.click('#rows li[data-kind="erasure"] button.show-held');
    await says(o.page, '#rows li[data-kind="erasure"] li[data-category="contact"]', /will be erased/);
    await says(o.page, '#rows li[data-kind="erasure"] li[data-category="tax-invoices"]', /kept by law \(tax_invoice, 2034-03-31\)/);
    await o.page.click('#rows li[data-kind="erasure"] button.approve');
    await says(o.page, '#rows li[data-kind="erasure"] .status', /^Approved\./);
    await o.page.click('#rows li[data-kind="erasure"] button.execute');
    await says(o.page, '#rows li[data-kind="erasure"] .status', /^Head office refused:/);
    expect(o.errors).toEqual([]);
    await o.close();

    const m = await shop.open(MGR, '/data-requests/');
    await says(m.page, '#rows li[data-kind="erasure"]', /demo-c-erase/);
    await m.page.click('#rows li[data-kind="erasure"] button.execute');
    await says(m.page, '#rows li[data-kind="erasure"] .status', /^Erased\./);
    await says(m.page, '#rows li[data-kind="erasure"] .statement', /kept/);
    const held = (await shop.call('GET', '/v1/privacy/pii/demo-c-erase', OWNER)).body as { categories: { category: string; state: string }[] };
    expect(held.categories.map((c) => [c.category, c.state])).toEqual(expect.arrayContaining([['contact', 'erased'], ['tax-invoices', 'held']]));
    const all = (await shop.call('GET', '/v1/privacy/data-requests?state=all', OWNER)).body as { queue: { requestId: string; customerRef: string; state: string }[] };
    const req = all.queue.find((r) => r.customerRef === 'demo-c-erase')!;
    expect(req.state).toBe('partially_fulfilled');
    expect((await shop.call('GET', `/v1/privacy/data-requests/${req.requestId}/tombstone`, OWNER)).status).toBe(200);
    await m.page.click('#lang');
    await says(m.page, '#queue-h', /^செய்ய வேண்டிய கோரிக்கைகள்$/);
    expect(m.errors).toEqual([]);
    await m.close();
  });

  it('a cashier is refused by head office, in its words', async () => {
    const c = await shop.open(CASH, '/data-requests/');
    await says(c.page, '#list-status', /^Head office refused:/);
    await c.close();
  });
});
