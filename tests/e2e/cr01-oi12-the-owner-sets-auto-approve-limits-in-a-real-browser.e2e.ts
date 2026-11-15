import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import type { Page } from 'playwright-core';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';

/**
 * **CR-01 OI-12 · OB-712: the Auto-approve limits page, served by the store computer, over head office's own routes, in a
 * real browser. Synthetic data only.**
 *   • the owner opens it: auto-approval is stopped, no limit is set, and the three acts that can NEVER be auto-approved are
 *     listed; a limit that is not money is refused before anything is sent;
 *   • the owner ASKS for a ₹5,000 reorder limit — the page says a different person must confirm; he has no confirm button;
 *   • the accountant CONFIRMS it through the confirm sheet — the limit shows, naming both people; then the same for starting;
 *   • a synthetic ₹4,200 reorder draft is approved BY THE RULE — and, since step 6b, PLACED by it through the ordinary
 *     purchase-order routes — and the page lists it so;
 *   • the store manager sees no way to ask or confirm, and STOPS all auto-approval with a reason;
 *   • the page follows the language toggle into Tamil.
 */
const OWNER = 'u-owner'; const ACCOUNTANT = 'u-accountant'; const MGR = 'u-mgr';

async function confirmSheet(page: Page): Promise<void> {
  await page.waitForSelector('#sre-confirm', { timeout: 10_000 });
  await page.click('#sre-confirm-go');
  await page.waitForSelector('#sre-confirm', { state: 'detached', timeout: 10_000 });
}

describe.skipIf(!HAVE_BROWSER)('CR-01 OI-12: the owner sets auto-approve limits, in a real browser', () => {
  let shop: BoxPageShop;
  const store = new InMemoryEventStore();
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'auto-approve',
      harness: { store },
      people: [
        { userId: OWNER, permissions: ['ai.autoapprove.read', 'ai.autoapprove.propose', 'ai.autoapprove.confirm', 'ai.autoapprove.stop'] },
        { userId: ACCOUNTANT, permissions: ['ai.autoapprove.read', 'ai.autoapprove.confirm'] },
        { userId: MGR, permissions: ['ai.autoapprove.read', 'ai.autoapprove.stop'] },
      ],
      seed: async (ho, T) => {
        await ho.seedOwner(T, OWNER);
        await ho.provisionRole(T, ACCOUNTANT, 'accountant');
        await ho.provisionRole(T, MGR, 'store_manager');
        await deliveryPlaces(ho, T, 'S1'); // step 6b: the order is really placed, so it needs a store and an approved supplier
        await approvedSuppliers(ho, T, 'sup-synthetic-01');
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('asked by one, confirmed by another, applied by the rule, stopped by the manager', async () => {
    // ── The owner: nothing set; the never-list; a limit that is not money refused on the page; he asks for ₹5,000.
    const o = await shop.open(OWNER, '/auto-approve/');
    await o.page.waitForFunction("document.body.dataset.autoApprove === 'ok'", undefined, { timeout: 15_000 });
    await says(o.page, '#switch-state', /^Stopped — every draft waits for a person\.$/);
    await says(o.page, '#kind-list li[data-kind="reorder_from_approved_supplier"] .limit', /^No limit/);
    await says(o.page, '#never-list', /A refund/);
    await says(o.page, '#never-list', /A payment to a new payee/);
    await says(o.page, '#never-list', /permissions/);
    expect(o.writes, 'nothing is written on open').toEqual([]);
    const row = '#kind-list li[data-kind="reorder_from_approved_supplier"]';
    await o.page.fill(`${row} .limit-in`, 'five thousand');
    await o.page.fill(`${row} .reason-in`, 'small reorders from our regular suppliers');
    await o.page.click(`${row} .ask-limit`);
    await says(o.page, '#limits-status', /^A limit is an amount in rupees/);
    expect(o.writes).toEqual([]);
    await o.page.fill(`${row} .limit-in`, '5000');
    await o.page.fill(`${row} .reason-in`, 'small reorders from our regular suppliers');
    await o.page.click(`${row} .ask-limit`);
    await says(o.page, '#limits-status', /^Asked\. Nothing changes until a different person confirms it\.$/);
    await says(o.page, '#pending-list', /You asked for this — a different person must confirm it\./);
    expect(await o.page.locator('#pending-list button.confirm').count(), 'the asker has no confirm button').toBe(0);
    await says(o.page, `${row} .limit`, /^No limit/);
    expect(o.errors).toEqual([]);
    await o.close();

    // ── The accountant confirms it, through the confirm sheet.
    const a = await shop.open(ACCOUNTANT, '/auto-approve/');
    await a.page.waitForFunction("document.body.dataset.autoApprove === 'ok'", undefined, { timeout: 15_000 });
    expect(await a.page.isVisible(`${row} form.ask`), 'the accountant asks for nothing').toBe(false);
    await a.page.click('#pending-list button.confirm');
    await confirmSheet(a.page);
    await says(a.page, '#pending-status', /^Confirmed\. It is in force now\.$/);
    await says(a.page, `${row} .limit`, /^Limit: ₹5,000\.00$/);
    await says(a.page, row, /Asked by u-owner, confirmed by u-accountant/);
    await a.close();

    // ── Starting auto-approval: asked by the owner, confirmed by the accountant.
    const o2 = await shop.open(OWNER, '/auto-approve/');
    await o2.page.waitForFunction("document.body.dataset.autoApprove === 'ok'", undefined, { timeout: 15_000 });
    await o2.page.fill('#start-reason', 'start with the reorder limit');
    await o2.page.click('#start');
    await says(o2.page, '#switch-status', /^Asked\. A different person must confirm before it starts\.$/);
    await o2.close();
    const a2 = await shop.open(ACCOUNTANT, '/auto-approve/');
    await a2.page.waitForFunction("document.body.dataset.autoApprove === 'ok'", undefined, { timeout: 15_000 });
    await a2.page.click('#pending-list button.confirm');
    await confirmSheet(a2.page);
    await says(a2.page, '#switch-state', /^Running/);
    await a2.close();

    // ── A synthetic ₹4,200 reorder draft from an approved supplier; the AI master switch lifted as the owner would.
    expect((await shop.call('PUT', '/v1/ai/kill-switch', OWNER, { on: false, reason: 'browser trial' })).status).toBe(200);
    const at = new Date().toISOString();
    const p = { proposalId: 'a02-synth-browser', agent: 'A02', summary: 'synthetic reorder', wouldRequire: 'POST /v1/purchase/orders/:poId', evidence: [{ source: 'synthetic', reference: 'r', summary: 's' }], createdAt: at, committed: false,
      act: { kind: 'reorder_from_approved_supplier', supplierId: 'sup-synthetic-01', supplierApproved: true, valueMinor: 420_000, lines: [{ productId: 'p-synthetic', qty: 10, unitCostMinor: 42_000, uom: 'ea' }], deliverToLocationId: 'S1' } };
    await store.append(shop.tenantId, STREAM.ai, makeEvent({ id: 'ai-proposal-a02-synth-browser', type: 'AiProposalRaised', occurredAt: at, idempotencyKey: `ai-proposal-${shop.tenantId}-a02-synth-browser`, source: 'test/synthetic', payload: p }));
    expect(((await shop.call('POST', '/v1/ai/auto-approve/sweep', OWNER, {})).body as { autoApproved: number }).autoApproved).toBe(1);

    // ── The manager: sees the rule's approval; cannot ask or confirm; stops it all with a reason.
    const m = await shop.open(MGR, '/auto-approve/');
    await m.page.waitForFunction("document.body.dataset.autoApprove === 'ok'", undefined, { timeout: 15_000 });
    await says(m.page, '#decision-list li[data-proposal="a02-synth-browser"]', /Placed by the rule/);
    await says(m.page, '#decision-list li[data-proposal="a02-synth-browser"]', /set by u-owner and confirmed by u-accountant/);
    await says(m.page, '#page-status', /Only the owner asks for a change/);
    expect(await m.page.locator('form.ask').count()).toBe(0);
    expect(await m.page.isVisible('#start-form')).toBe(false);
    await m.page.click('#stop');
    await says(m.page, '#switch-status', /^Write a short reason first\.$/);
    await m.page.fill('#stop-reason', 'checking a delivery');
    await m.page.click('#stop');
    await says(m.page, '#switch-status', /^Stopped\. Every draft now waits for a person\.$/);
    await says(m.page, '#switch-who', /Stopped by u-mgr/);
    expect(((await shop.call('GET', '/v1/ai/auto-approve', OWNER)).body as { running: boolean }).running).toBe(false);

    // ── Tamil.
    await m.page.click('#lang');
    await says(m.page, '#limits-h', /^வரம்புகள்$/);
    await says(m.page, '#switch-state', /^நிறுத்தப்பட்டது/);
    expect(m.errors).toEqual([]);
    await m.close();
  });
});
