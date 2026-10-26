import { describe, it, expect } from 'vitest';
import { createVmiDeskSession, itemWords, paiseOf, vmiDeskWords, VMI_DESK_COPY } from '../../apps/web-erp/src/vmi-desk-session';

// FG-4 · D03-FR-04: the buyer's supplier-managed stock desk. It reads with purchase.commitment.read, sets limits and
// decides with purchase.order.propose, refuses the cheap things before a request (no supplier, a backwards limit, no
// reason, no price for an item), prices an accepted top-up in the BUYER's rupees, and has a Tamil twin for every word.

const recorder = () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
    return new Response(JSON.stringify({ items: [], proposals: [] }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};
const buyer = { userId: 'u-buyer', permissions: ['purchase.commitment.read', 'purchase.order.propose'] };
const proposal = { proposalId: 'vp-1', supplierId: 'sup-1', storeId: 'store-1', lines: [{ productId: 'p-rice', quantity: 30 }], note: '', proposedAt: '2026-10-26T05:00:00Z', status: 'awaiting_buyer' };

describe('VMI desk session (D03-FR-04)', () => {
  it('reads and sets limits only with the right permissions, refusing the cheap things first', async () => {
    const r = recorder();
    const s = createVmiDeskSession({ viewer: buyer, fetch: r.fetch, newKey: () => 'k' });
    expect(await s.items(' ')).toEqual({ result: 'invalid', why: 'needSupplier' });
    expect((await s.items('sup 1')).result).toBe('ok');
    const lim = { supplierId: 'sup-1', storeId: 'store-1', productId: 'p-rice', min: '20', max: '50', uom: 'ea' };
    expect(await s.setLimit({ ...lim, min: '60' })).toEqual({ result: 'invalid', why: 'badLimit' });
    expect(await s.setLimit({ ...lim, max: '2.5' })).toEqual({ result: 'invalid', why: 'badLimit' });
    expect(await s.setLimit({ ...lim, uom: ' ' })).toEqual({ result: 'invalid', why: 'needAll' });
    expect((await s.setLimit(lim)).result).toBe('ok');
    expect(r.calls).toEqual([
      { url: '/v1/purchase/vmi/sup%201', method: 'GET' },
      { url: '/v1/purchase/vmi/limits/sup-1/store-1/p-rice', method: 'POST', body: { minQty: 20, maxQty: 50, uom: 'ea' } },
    ]);
    const reader = createVmiDeskSession({ viewer: { userId: 'u', permissions: ['purchase.commitment.read'] }, fetch: r.fetch });
    expect(await reader.setLimit(lim)).toEqual({ result: 'invalid', why: 'cannotDecide' });
    expect(await createVmiDeskSession({ viewer: { userId: 'u', permissions: [] }, fetch: r.fetch }).queue()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await createVmiDeskSession({ viewer: undefined, fetch: r.fetch }).queue()).toEqual({ result: 'invalid', why: 'nobody' });
  });

  it('an acceptance needs a reason and the buyer\'s price for every item; a rejection only the reason', async () => {
    const r = recorder();
    const s = createVmiDeskSession({ viewer: buyer, fetch: r.fetch, newKey: () => 'k' });
    expect(await s.decide(proposal, 'accept', ' ', 'po-1', { 'p-rice': '40' })).toEqual({ result: 'invalid', why: 'needReason' });
    expect(await s.decide(proposal, 'accept', 'low', 'po-1', { 'p-rice': 'forty' })).toEqual({ result: 'invalid', why: 'needCost' });
    expect(await s.decide(proposal, 'accept', 'low', 'po-1', {})).toEqual({ result: 'invalid', why: 'needCost' });
    expect((await s.decide(proposal, 'accept', 'low', 'po-1', { 'p-rice': '40.50' })).result).toBe('ok');
    expect((await s.decide(proposal, 'reject', 'too much')).result).toBe('ok');
    expect(r.calls.map((c) => c.body)).toEqual([
      { decision: 'accept', reason: 'low', poId: 'po-1', lines: [{ productId: 'p-rice', unitCost: { minor: 4_050, currency: 'INR' } }] },
      { decision: 'reject', reason: 'too much' },
    ]);
  });

  it('says an item in words; reads rupees strictly; a Tamil twin for every word', () => {
    expect(itemWords('en', { storeId: 'store-1', productId: 'p-rice', minQty: 20, maxQty: 50, uom: 'ea', onHand: 15, onOrder: 0, room: 35, belowMinimum: true }))
      .toBe('p-rice · Store store-1 · Minimum 20 / Maximum 50 ea · on hand 15 · on order 0 · room 35 · below the minimum');
    expect([paiseOf('40'), paiseOf('40.5'), paiseOf('40.505'), paiseOf('-1'), paiseOf('')]).toEqual([4_000, 4_050, undefined, undefined, undefined]);
    expect(vmiDeskWords('ta', 'vmiH')).toBe('சப்ளையர் நிர்வகிக்கும் சரக்கு (VMI)');
    expect(Object.keys(VMI_DESK_COPY.ta).sort()).toEqual(Object.keys(VMI_DESK_COPY.en).sort());
  });
});
