import { describe, it, expect } from 'vitest';
import { createReplenishmentSession, parametersBody, qtyIn, editable, replenishmentWords, REPLENISHMENT_COPY, type StoredProposal } from '../../apps/web-erp/src/replenishment-session';

/**
 * The Buying page's Reorder tab (M09-FR-02 · WF-03 · OB-31): reorder settings typed in the item's OWN unit become the
 * smallest-step figures head office stores; the proposal is head office's, on its stored settings; a requisition is raised
 * from the ticked lines with exactly the settings head office proposed on; an A02 draft needs the buyer's quantity. An item
 * whose unit the screen was not told is refused, never guessed. The connected proof is
 * tests/e2e/reorder-settings-drive-the-proposal-and-raise-a-requisition-on-the-buying-page.e2e.ts.
 */

const FORM = { productId: 'RICE', maxLevel: '50', reorderPoint: '10', safetyStock: '2.5', leadTimeDays: '3', minOrderQty: '', orderMultiple: '', avgDailyDemand: '', reason: ' festival ' };
function fakeFetch() {
  const sent: { method: string; path: string; body?: unknown }[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string }) => {
    sent.push({ method: init.method, path, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }) });
    return { ok: true, status: 201, json: async () => ({}) };
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const BUYER = { userId: 'u-buyer', permissions: ['inventory.availability.read', 'purchase.order.propose'] };
const UOMS = { RICE: 'kg', SOAP: 'ea' };

describe('the Reorder tab session (M09-FR-02)', () => {
  it('reads settings typed in the item\'s unit into grams for a kg item, items for an each item', () => {
    expect(parametersBody(FORM, 'kg')).toEqual({ productId: 'RICE', body: { maxLevel: 50_000, reorderPoint: 10_000, safetyStock: 2_500, leadTimeDays: 3, reason: 'festival' } });
    expect(parametersBody({ ...FORM, productId: 'SOAP', safetyStock: '0' }, 'ea')).toEqual({ productId: 'SOAP', body: { maxLevel: 50, reorderPoint: 10, safetyStock: 0, leadTimeDays: 3, reason: 'festival' } });
    expect(parametersBody({ ...FORM, safetyStock: '2.5' }, 'ea'), 'half a soap is refused').toEqual({ why: 'needParams' });
    expect(parametersBody({ ...FORM, maxLevel: '' }, 'kg')).toEqual({ why: 'needParams' });
    expect(parametersBody({ ...FORM, maxLevel: '0' }, 'kg')).toEqual({ why: 'needParams' });
    expect(parametersBody({ ...FORM, leadTimeDays: '1.5' }, 'kg')).toEqual({ why: 'needParams' });
    expect(parametersBody({ ...FORM, reason: '' }, 'kg')).toEqual({ why: 'needParams' });
    expect(parametersBody(FORM, undefined)).toEqual({ why: 'unitUnknown' });
    expect([qtyIn(48_000, 'kg'), qtyIn(12, 'ea'), editable(2_500, 'kg'), editable(undefined, 'kg')]).toEqual(['48.000 kg', '12', '2.500', '']);
  });

  it('sets, reads and proposes for one store, and raises with exactly the settings head office proposed on', async () => {
    const { fetch, sent } = fakeFetch();
    const s = createReplenishmentSession({ viewer: BUYER, productUoms: UOMS, fetch, newId: (p) => `${p}-1` });
    expect(await s.setParameters(' ', FORM)).toEqual({ result: 'invalid', why: 'needStore' });
    await s.setParameters('br-1', FORM);
    await s.parameters('br-1');
    await s.proposal('br-1');
    const proposal: StoredProposal = { storeId: 'br-1', proposals: [{ productId: 'RICE', position: 2_000, reorderPoint: 10_000, suggestedQty: 48_000, reason: 'below_reorder_point' }], items: [{ productId: 'RICE', maxLevel: 50_000, reorderPoint: 10_000 }], parametersNotSet: false, asAt: 'now' };
    expect(await s.raise(null, [{ productId: 'RICE', qtyText: '' }])).toEqual({ result: 'invalid', why: 'proposalFirst' });
    expect(await s.raise(proposal, [])).toEqual({ result: 'invalid', why: 'needTick' });
    await s.raise(proposal, [{ productId: 'RICE', qtyText: '45.5' }]);
    await s.raiseFromDraft({ proposalId: ' prop-a02-1 ', productId: 'SOAP', qtyText: '24' });
    expect(await s.raiseFromDraft({ proposalId: 'p', productId: 'GHEE', qtyText: '1' })).toEqual({ result: 'invalid', why: 'unitUnknown' });
    expect(sent).toEqual([
      { method: 'POST', path: '/v1/replenishment/parameters/br-1/RICE', body: { maxLevel: 50_000, reorderPoint: 10_000, safetyStock: 2_500, leadTimeDays: 3, reason: 'festival' } },
      { method: 'GET', path: '/v1/replenishment/parameters?storeId=br-1' },
      { method: 'POST', path: '/v1/replenishment/stored-proposal?storeId=br-1', body: {} },
      { method: 'POST', path: '/v1/purchase/requisitions/rq-1/from-replenishment', body: { storeId: 'br-1', currency: 'INR', items: proposal.items, accept: [{ productId: 'RICE', quantity: 45_500 }] } },
      { method: 'POST', path: '/v1/purchase/requisitions/rq-1/from-drafts', body: { currency: 'INR', lines: [{ proposalId: 'prop-a02-1', productId: 'SOAP', quantity: 24 }] } },
    ]);
  });

  it('a stock reader may read but not set or raise; a nobody sends nothing; every word has a Tamil twin', async () => {
    const { fetch, sent } = fakeFetch();
    const reader = createReplenishmentSession({ viewer: { userId: 'u-r', permissions: ['inventory.availability.read'] }, productUoms: UOMS, fetch });
    expect(reader.may).toEqual({ named: true, read: true, set: false });
    expect(await reader.setParameters('br-1', FORM)).toEqual({ result: 'invalid', why: 'cannotSet' });
    expect(await createReplenishmentSession({ viewer: undefined, fetch }).proposal('br-1')).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await createReplenishmentSession({ viewer: { userId: 'u-c', permissions: [] }, fetch }).parameters('br-1')).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(sent).toEqual([]);
    for (const k of Object.keys(REPLENISHMENT_COPY.en)) expect(replenishmentWords('ta', k), k).not.toBe(replenishmentWords('en', k));
  });
});
