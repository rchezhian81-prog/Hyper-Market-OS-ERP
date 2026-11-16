import { describe, it, expect } from 'vitest';
import { suggestedSettingsFromSales, bigChanges, SUGGESTION_RULE, JUMP_FACTOR } from '../../packages/replenishment/src/suggested-settings';
import { usualSupplierPlan, usualSuppliers } from '../../packages/purchasing/src/usual-supplier';
import { orderGstSummary, gstOn, ratePercent } from '../../apps/web-erp/src/order-gst';
import { createReplenishmentSession, REPLENISHMENT_COPY, type StoredProposal, type ProposeOrder } from '../../apps/web-erp/src/replenishment-session';

/**
 * Fix batch 4b (OB-800 THE PLAN) on the Buying page — the pure rules and the session behind the screen. The connected proof is
 * tests/e2e/fix-batch4b-buying-suggests-warns-orders-from-the-usual-supplier-and-shows-gst.e2e.ts.
 *   D-038 suggested reorder figures for every item from recent sales — suggestions only, saved by a person;
 *   D-039 a figure more than 5 times what it is now is asked about again (48200 typed for 48);
 *   D-040 "Order these from the usual supplier" — one PROPOSED order per supplier at the last agreed price;
 *   D-041 the GST and the total with GST at the item's held rate, never a guessed one.
 */

describe('D-038 suggested reorder figures from recent sales', () => {
  it('suggests 7 days of sales to reorder at and 14 to hold, rounded up to a whole step, for every item that sold', () => {
    const r = suggestedSettingsFromSales({
      history: { windowDays: 28, products: [{ productId: 'SOAP', totalQtyMinor: 56 }, { productId: 'RICE', totalQtyMinor: 28_000 }, { productId: 'SLOW', totalQtyMinor: 1 }, { productId: 'GHEE', totalQtyMinor: 4 }] },
      uomOf: (id) => ({ SOAP: 'ea', RICE: 'kg', SLOW: 'ea' } as Record<string, string>)[id],
      current: new Map([['SOAP', { maxLevel: 48, reorderPoint: 12 }]]),
      allProductIds: ['SOAP', 'RICE', 'SLOW', 'GHEE', 'SALT'],
    });
    expect(SUGGESTION_RULE).toEqual({ reorderDays: 7, holdDays: 14 });
    expect(r.windowDays).toBe(28);
    expect(r.suggestions.map((s) => [s.productId, s.reorderPointMinor, s.maxLevelMinor])).toEqual([
      ['RICE', 7_000, 14_000], // 1 kg a day: 7 kg / 14 kg, in grams
      ['SLOW', 1, 2], // 1 in 28 days: rounded up to one, and the most to hold stays above it
      ['SOAP', 14, 28], // 2 a day
    ]);
    expect(r.suggestions.find((s) => s.productId === 'SOAP')?.current, 'the figures in force are shown beside').toEqual({ maxLevel: 48, reorderPoint: 12 });
    expect(r.leftOut).toEqual([{ productId: 'GHEE', why: 'unit_unknown' }, { productId: 'SALT', why: 'no_sales' }]);
  });

  it('a window of no days suggests nothing', () => {
    expect(suggestedSettingsFromSales({ history: { windowDays: 0, products: [{ productId: 'A', totalQtyMinor: 5 }] }, uomOf: () => 'ea' }).suggestions).toEqual([]);
  });
});

describe('D-039 a figure more than 5 times what it is now is asked about again', () => {
  it('names each figure that moves more than 5 times, up or down, and nothing else', () => {
    expect(JUMP_FACTOR).toBe(5);
    expect(bigChanges({ maxLevel: 48, reorderPoint: 12 }, { maxLevel: 48_200, reorderPoint: 12 })).toEqual([{ field: 'maxLevel', from: 48, to: 48_200 }]);
    expect(bigChanges({ maxLevel: 48 }, { maxLevel: 240 }), 'exactly 5 times is not asked about').toEqual([]);
    expect(bigChanges({ maxLevel: 50 }, { maxLevel: 9 })).toEqual([{ field: 'maxLevel', from: 50, to: 9 }]);
    expect(bigChanges(undefined, { maxLevel: 48_200 }), 'a first figure has nothing to compare with').toEqual([]);
    expect(bigChanges({ maxLevel: 0 }, { maxLevel: 10 })).toEqual([]);
  });
});

describe('D-040 one proposed order per usual supplier at the last agreed price', () => {
  const ORDERS = {
    orders: [
      { poId: 'po-1', number: 'PO-1', supplierId: 'sup-foods', status: 'issued', issuedAt: '2026-11-01T10:00:00Z', currency: 'INR', lines: [{ productId: 'BISCUIT', orderedQty: 48, unitCost: { minor: 2_500, currency: 'INR' } }, { productId: 'RICE', orderedQty: 50_000, unitCost: { minor: 4_500, currency: 'INR' } }] },
      { poId: 'po-2', number: 'PO-2', supplierId: 'sup-other', status: 'issued', issuedAt: '2026-11-10T10:00:00Z', currency: 'INR', lines: [{ productId: 'BISCUIT', orderedQty: 24, unitCost: { minor: 2_400, currency: 'INR' } }] },
      { poId: 'po-3', number: 'PO-3', supplierId: 'sup-new', status: 'proposed', at: '2026-11-15T10:00:00Z', currency: 'INR', lines: [{ productId: 'BISCUIT', orderedQty: 24, unitCost: { minor: 1_000, currency: 'INR' } }] },
      { poId: 'po-4', number: 'PO-4', supplierId: 'sup-case', status: 'issued', issuedAt: '2026-11-02T10:00:00Z', currency: 'INR', lines: [{ productId: 'OIL', orderedQty: 12, unitCost: { minor: 1_000, currency: 'INR', per: 3 } }, { productId: 'TEA', orderedQty: 12, unitCost: { minor: 1_200, currency: 'INR', per: 12 } }] },
    ],
  };

  it('the usual supplier is the latest ISSUED order\'s; a proposed one does not count; a case price that does not divide is named', () => {
    const usual = usualSuppliers(ORDERS);
    expect(usual.get('BISCUIT')).toMatchObject({ supplierId: 'sup-other', unitCostMinor: 2_400, poId: 'po-2' });
    expect(usual.get('TEA')).toMatchObject({ supplierId: 'sup-case', unitCostMinor: 100 });
    expect(usual.get('OIL')?.unitCostMinor).toBeUndefined();
    const plan = usualSupplierPlan(ORDERS, [{ productId: 'RICE', quantity: 20_000 }, { productId: 'BISCUIT', quantity: 36 }, { productId: 'SOAP', quantity: 10 }, { productId: 'OIL', quantity: 6 }, { productId: 'TEA', quantity: 24 }, { productId: 'SALT', quantity: 1.5 }]);
    expect(plan.orders).toEqual([
      { supplierId: 'sup-case', lines: [{ productId: 'TEA', orderedQty: 24, unitCostMinor: 100, fromPoId: 'po-4', fromNumber: 'PO-4' }] },
      { supplierId: 'sup-foods', lines: [{ productId: 'RICE', orderedQty: 20_000, unitCostMinor: 4_500, fromPoId: 'po-1', fromNumber: 'PO-1' }] },
      { supplierId: 'sup-other', lines: [{ productId: 'BISCUIT', orderedQty: 36, unitCostMinor: 2_400, fromPoId: 'po-2', fromNumber: 'PO-2' }] },
    ]);
    expect(plan.leftOut).toEqual([{ productId: 'SOAP', why: 'no_earlier_order' }, { productId: 'OIL', why: 'price_not_per_unit' }, { productId: 'SALT', why: 'quantity_not_whole' }]);
    expect(usualSupplierPlan(null, [{ productId: 'RICE', quantity: 1 }]).leftOut).toEqual([{ productId: 'RICE', why: 'no_earlier_order' }]);
  });
});

describe('D-041 GST on the order being raised', () => {
  it('works out each line\'s GST at the held rate, totals with GST, and names an item with no rate (its GST left out)', () => {
    const s = orderGstSummary([{ productId: 'BISCUIT', valueMinor: 120_000 }, { productId: 'RICE', valueMinor: 90_001 }, { productId: 'NEW', valueMinor: 5_000 }], (id) => ({ BISCUIT: 1_800, RICE: 500 } as Record<string, number>)[id]);
    expect(s.lines.map((l) => [l.productId, l.taxBps, l.gstMinor])).toEqual([['BISCUIT', 1_800, 21_600], ['RICE', 500, 4_500], ['NEW', undefined, undefined]]);
    expect([s.beforeGstMinor, s.gstMinor, s.withGstMinor]).toEqual([215_001, 26_100, 241_101]);
    expect(s.noRate).toEqual(['NEW']);
    expect([gstOn(1, 5_000), gstOn(3, 1_800)]).toEqual([1, 1]);
    expect([ratePercent(1_800), ratePercent(500), ratePercent(25), ratePercent(0)]).toEqual(['18%', '5%', '0.25%', '0%']);
    expect(orderGstSummary([{ productId: 'X', valueMinor: 100 }], () => -1).noRate, 'a negative rate is not a rate').toEqual(['X']);
  });
});

// ── The session the Reorder tab calls ───────────────────────────────────────

type Sent = { method: string; path: string; body?: unknown };
function scriptedFetch(answers: Record<string, unknown>) {
  const sent: Sent[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string }) => {
    sent.push({ method: init.method, path, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }) });
    const key = `${init.method} ${path.split('?')[0]}`;
    const body = answers[key] ?? {};
    return { ok: true, status: init.method === 'GET' ? 200 : 201, json: async () => body };
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const BUYER = { userId: 'u-buyer', permissions: ['inventory.availability.read', 'purchase.order.propose'] };
const UOMS = { BISCUIT: 'ea', RICE: 'kg', SALT: 'ea' };
const PARAMS = { storeId: 'br-1', products: [{ current: { storeId: 'br-1', productId: 'BISCUIT', version: 1, maxLevel: 48, reorderPoint: 12, safetyStock: 4, leadTimeDays: 2, reason: 'first', setBy: 'u', setAt: 'x' }, history: [] }] };
const FORM = { productId: 'BISCUIT', maxLevel: '48200', reorderPoint: '12', safetyStock: '', leadTimeDays: '', minOrderQty: '', orderMultiple: '', avgDailyDemand: '', reason: 'more' };

describe('the Reorder session (D-038, D-039, D-040)', () => {
  it('D-039: a figure 1,000 times what it is now is refused until the person says yes; then it is saved', async () => {
    const { fetch, sent } = scriptedFetch({ 'GET /v1/replenishment/parameters': PARAMS });
    const s = createReplenishmentSession({ viewer: BUYER, productUoms: UOMS, fetch });
    expect(await s.setParameters('br-1', FORM)).toEqual({ result: 'invalid', why: 'bigJump' });
    expect(sent.filter((x) => x.method === 'POST'), 'nothing was saved').toEqual([]);
    expect(s.jumpsIn('br-1', FORM)).toEqual([{ productId: 'BISCUIT', field: 'maxLevel', from: 48, to: 48_200 }]);
    expect(s.jumpsIn('br-1', { ...FORM, maxLevel: '60' })).toEqual([]);
    expect((await s.setParameters('br-1', FORM, true)).result).toBe('ok');
    expect(sent.filter((x) => x.method === 'POST')).toEqual([{ method: 'POST', path: '/v1/replenishment/parameters/br-1/BISCUIT', body: { maxLevel: 48_200, reorderPoint: 12, reason: 'more' } }]);
    expect((await s.setParameters('br-1', { ...FORM, maxLevel: '60' })).result, 'an ordinary change saves at once').toBe('ok');
  });

  it('D-038: suggests from head office\'s sales history, and saves only the ticked rows, keeping the other figures in force', async () => {
    const { fetch, sent } = scriptedFetch({
      'GET /v1/replenishment/parameters': PARAMS,
      'GET /v1/inventory/sales-history': { windowDays: 28, from: '2026-10-19', to: '2026-11-15', products: [{ productId: 'BISCUIT', totalQtyMinor: 56 }, { productId: 'RICE', totalQtyMinor: 28_000 }] },
    });
    const s = createReplenishmentSession({ viewer: BUYER, productUoms: UOMS, fetch });
    const out = await s.suggestFromSales('br-1');
    expect(out.result).toBe('ok');
    if (out.result !== 'ok') return;
    expect(out.value.suggestions.map((x) => [x.productId, x.reorderPointMinor, x.maxLevelMinor, x.current])).toEqual([['BISCUIT', 14, 28, { maxLevel: 48, reorderPoint: 12 }], ['RICE', 7_000, 14_000, undefined]]);
    expect(out.value.leftOut).toEqual([{ productId: 'SALT', why: 'no_sales' }]);
    expect(sent.every((x) => x.method === 'GET'), 'suggesting writes nothing').toBe(true);
    expect(await s.saveSuggested('br-1', [], 'why', false)).toEqual({ result: 'invalid', why: 'needSuggestionTick' });
    expect(await s.saveSuggested('br-1', [{ productId: 'RICE', maxLevelMinor: 14_000, reorderPointMinor: 7_000 }], ' ', false)).toEqual({ result: 'invalid', why: 'needSuggestionTick' });
    const saved = await s.saveSuggested('br-1', [{ productId: 'BISCUIT', maxLevelMinor: 28, reorderPointMinor: 14 }, { productId: 'RICE', maxLevelMinor: 14_000, reorderPointMinor: 7_000 }], ' Suggested from recent sales ', false);
    expect(saved).toEqual({ result: 'ok', value: { saved: ['BISCUIT', 'RICE'], notSaved: [] } });
    expect(sent.filter((x) => x.method === 'POST')).toEqual([
      { method: 'POST', path: '/v1/replenishment/parameters/br-1/BISCUIT', body: { safetyStock: 4, leadTimeDays: 2, maxLevel: 28, reorderPoint: 14, reason: 'Suggested from recent sales' } },
      { method: 'POST', path: '/v1/replenishment/parameters/br-1/RICE', body: { maxLevel: 14_000, reorderPoint: 7_000, reason: 'Suggested from recent sales' } },
    ]);
  });

  it('D-038 + D-039: a suggestion more than 5 times the figure in force is held for a yes', async () => {
    const { fetch, sent } = scriptedFetch({ 'GET /v1/replenishment/parameters': PARAMS });
    const s = createReplenishmentSession({ viewer: BUYER, productUoms: UOMS, fetch });
    const held = await s.saveSuggested('br-1', [{ productId: 'BISCUIT', maxLevelMinor: 480, reorderPointMinor: 12 }], 'why', false);
    expect(held).toEqual({ result: 'ok', value: { saved: [], notSaved: [], jumps: [{ productId: 'BISCUIT', field: 'maxLevel', from: 48, to: 480 }] } });
    expect(sent.some((x) => x.method === 'POST')).toBe(false);
    expect(await s.saveSuggested('br-1', [{ productId: 'BISCUIT', maxLevelMinor: 480, reorderPointMinor: 12 }], 'why', true)).toEqual({ result: 'ok', value: { saved: ['BISCUIT'], notSaved: [] } });
  });

  it('D-040: proposes one order per usual supplier through the Raise-an-order path, names what is left out, issues nothing', async () => {
    const { fetch, sent } = scriptedFetch({
      'GET /v1/purchase/orders': { orders: [
        { poId: 'po-1', number: 'PO-1', supplierId: 'sup-foods', status: 'issued', issuedAt: '2026-11-01T10:00:00Z', currency: 'INR', lines: [{ productId: 'BISCUIT', orderedQty: 48, unitCost: { minor: 2_500, currency: 'INR' } }] },
        { poId: 'po-2', number: 'PO-2', supplierId: 'sup-grain', status: 'issued', issuedAt: '2026-11-01T10:00:00Z', currency: 'INR', lines: [{ productId: 'RICE', orderedQty: 50_000, unitCost: { minor: 4_500, currency: 'INR' } }] },
      ] },
    });
    const s = createReplenishmentSession({ viewer: BUYER, productUoms: UOMS, fetch, newId: (p) => `${p}-n${sent.length}` });
    const proposal: StoredProposal = { storeId: 'br-1', proposals: [
      { productId: 'BISCUIT', position: 2, reorderPoint: 12, suggestedQty: 46, reason: 'below_reorder_point' },
      { productId: 'RICE', position: 0, reorderPoint: 7_000, suggestedQty: 14_000, reason: 'below_reorder_point' },
      { productId: 'SALT', position: 0, reorderPoint: 5, suggestedQty: 10, reason: 'below_reorder_point' },
    ], items: [], parametersNotSet: false, asAt: 'now' };
    const asked: Parameters<ProposeOrder>[0][] = [];
    const propose: ProposeOrder = async (input) => {
      asked.push(input);
      return input.supplierId === 'sup-grain' ? { proposed: false, reason: 'supplier sup-grain is on hold' } : { proposed: true, totalMinor: 120_000 };
    };
    expect(await s.orderFromUsualSuppliers(null, [{ productId: 'BISCUIT', qtyText: '' }], propose)).toEqual({ result: 'invalid', why: 'proposalFirst' });
    expect(await s.orderFromUsualSuppliers(proposal, [], propose)).toEqual({ result: 'invalid', why: 'needTick' });
    const out = await s.orderFromUsualSuppliers(proposal, [{ productId: 'BISCUIT', qtyText: '48' }, { productId: 'RICE', qtyText: '' }, { productId: 'SALT', qtyText: '' }], propose);
    expect(out.result).toBe('ok');
    if (out.result !== 'ok') return;
    expect(asked.map((a) => [a.supplierId, a.deliverToLocationId, a.lines])).toEqual([
      ['sup-foods', 'br-1', [{ productId: 'BISCUIT', orderedQty: 48, unitCostMinor: 2_500 }]],
      ['sup-grain', 'br-1', [{ productId: 'RICE', orderedQty: 14_000, unitCostMinor: 4_500 }]],
    ]);
    expect(out.value.proposed).toHaveLength(1);
    expect(out.value.proposed[0]).toMatchObject({ supplierId: 'sup-foods', totalMinor: 120_000, overBudget: false, lines: 1 });
    expect(out.value.failed).toEqual([{ supplierId: 'sup-grain', reason: 'supplier sup-grain is on hold' }]);
    expect(out.value.leftOut).toEqual([{ productId: 'SALT', why: 'no_earlier_order' }]);
    expect(sent.filter((x) => x.method === 'POST'), 'the session itself posts nothing — no issue, no approval').toEqual([]);
  });

  it('a stock reader cannot save suggestions or propose orders; every new word has a Tamil twin', async () => {
    const { fetch, sent } = scriptedFetch({});
    const reader = createReplenishmentSession({ viewer: { userId: 'u-r', permissions: ['inventory.availability.read'] }, productUoms: UOMS, fetch });
    expect(await reader.saveSuggested('br-1', [{ productId: 'RICE', maxLevelMinor: 2, reorderPointMinor: 1 }], 'w', true)).toEqual({ result: 'invalid', why: 'cannotSet' });
    expect(await reader.orderFromUsualSuppliers({ storeId: 'br-1', proposals: [], items: [], parametersNotSet: false, asAt: 'now' }, [{ productId: 'RICE', qtyText: '' }], async () => ({ proposed: false, reason: 'x' }))).toEqual({ result: 'invalid', why: 'cannotSet' });
    expect(sent).toEqual([]);
    for (const k of Object.keys(REPLENISHMENT_COPY.en)) expect(Object.keys(REPLENISHMENT_COPY.ta), k).toContain(k);
  });
});
