import { describe, it, expect } from 'vitest';
import { ORDER_WARN_ABOVE_MINOR, orderNeedsSecondLook } from '../../packages/purchasing/src/order-value-warning';
import { createReplenishmentSession, REPLENISHMENT_COPY, type StoredProposal, type ProposeOrder } from '../../apps/web-erp/src/replenishment-session';

/**
 * OB-821 B (owner, 16 Nov 2026, in writing) · daily-work defect D-039 — "warn and ask again before raising an order worth more
 * than ₹1,00,000". The value is the order's total BEFORE GST. A warning only: the order is still raised on a second yes, and a
 * second person still issues it. The connected proof is tests/e2e/ob821-a-large-order-is-asked-about-again.e2e.ts.
 */

describe('OB-821 B: the owner\'s limit', () => {
  it('is ₹1,00,000 in paise, in one place', () => {
    expect(ORDER_WARN_ABOVE_MINOR).toBe(10_000_000);
  });
  it('below and exactly at the limit go ahead; one paisa above is asked about again', () => {
    expect(orderNeedsSecondLook(0)).toBe(false);
    expect(orderNeedsSecondLook(9_999_999)).toBe(false);
    expect(orderNeedsSecondLook(10_000_000), 'exactly ₹1,00,000 is not over').toBe(false);
    expect(orderNeedsSecondLook(10_000_001)).toBe(true);
    expect(orderNeedsSecondLook(Number.NaN), 'not a figure is not a warning').toBe(false);
  });
});

type Sent = { method: string; path: string };
function scriptedFetch(answers: Record<string, unknown>) {
  const sent: Sent[] = [];
  const fetch = (async (path: string, init: { method: string }) => {
    sent.push({ method: init.method, path });
    return { ok: true, status: 200, json: async () => answers[`${init.method} ${path.split('?')[0]}`] ?? {} };
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const BUYER = { userId: 'u-buyer', permissions: ['inventory.availability.read', 'purchase.order.propose'] };
const UOMS = { BISCUIT: 'ea', RICE: 'kg', SOAP: 'ea' };
const ORDERS = { orders: [
  { poId: 'po-1', number: 'PO-1', supplierId: 'sup-foods', status: 'issued', issuedAt: '2026-11-01T10:00:00Z', currency: 'INR', lines: [{ productId: 'BISCUIT', orderedQty: 48, unitCost: { minor: 2_500, currency: 'INR' } }] },
  // ₹45.00 a kg — the rice price is per kg; the quantity is in grams.
  { poId: 'po-2', number: 'PO-2', supplierId: 'sup-grain', status: 'issued', issuedAt: '2026-11-01T10:00:00Z', currency: 'INR', lines: [{ productId: 'RICE', orderedQty: 50_000, unitCost: { minor: 4_500, currency: 'INR' } }] },
  { poId: 'po-3', number: 'PO-3', supplierId: 'sup-home', status: 'issued', issuedAt: '2026-11-01T10:00:00Z', currency: 'INR', lines: [{ productId: 'SOAP', orderedQty: 10, unitCost: { minor: 3_000, currency: 'INR' } }] },
] };
const PROPOSAL: StoredProposal = { storeId: 'br-1', proposals: [], items: [], parametersNotSet: false, asAt: 'now' };

describe('OB-821 B on "Order these from the usual supplier" (D-040)', () => {
  it('an order over the limit is held and named; the others go ahead; the second press proposes exactly the held one', async () => {
    const { fetch, sent } = scriptedFetch({ 'GET /v1/purchase/orders': ORDERS });
    const s = createReplenishmentSession({ viewer: BUYER, productUoms: UOMS, fetch, newId: (p) => `${p}-n${sent.length}` });
    const asked: Parameters<ProposeOrder>[0][] = [];
    const propose: ProposeOrder = async (input) => { asked.push(input); return { proposed: true, totalMinor: 1 }; };
    // Rice 2,500 kg × ₹45 = ₹1,12,500 (over, weighed in grams); biscuits 4,000 × ₹25 = ₹1,00,000 (exactly at — not over);
    // soap 10 × ₹30 = ₹300 (well under).
    const ticks = [{ productId: 'RICE', qtyText: '2500' }, { productId: 'BISCUIT', qtyText: '4000' }, { productId: 'SOAP', qtyText: '10' }];
    const first = await s.orderFromUsualSuppliers(PROPOSAL, ticks, propose);
    expect(first.result).toBe('ok');
    if (first.result !== 'ok') return;
    expect(asked.map((a) => a.supplierId), 'the orders at or under the limit go ahead').toEqual(['sup-foods', 'sup-home']);
    expect(first.value.held).toEqual([{ supplierId: 'sup-grain', totalMinor: 11_250_000, lines: 1 }]);
    expect(first.value.proposed.map((p) => p.supplierId)).toEqual(['sup-foods', 'sup-home']);

    const second = await s.orderFromUsualSuppliers(PROPOSAL, ticks, propose, true);
    expect(second.result).toBe('ok');
    if (second.result !== 'ok') return;
    expect(asked.map((a) => a.supplierId), 'only the held order is proposed on yes — nothing twice').toEqual(['sup-foods', 'sup-home', 'sup-grain']);
    expect(asked[2]?.lines).toEqual([{ productId: 'RICE', orderedQty: 2_500_000, unitCostMinor: 4_500 }]);
    expect(second.value.held).toEqual([]);
    expect(second.value.proposed.map((p) => p.supplierId)).toEqual(['sup-grain']);
    expect(sent.filter((x) => x.method === 'POST'), 'the session itself posts nothing — no issue, no approval').toEqual([]);
  });

  it('with nothing over the limit, a single press proposes everything and holds nothing', async () => {
    const { fetch } = scriptedFetch({ 'GET /v1/purchase/orders': ORDERS });
    const s = createReplenishmentSession({ viewer: BUYER, productUoms: UOMS, fetch });
    const asked: string[] = [];
    const out = await s.orderFromUsualSuppliers(PROPOSAL, [{ productId: 'SOAP', qtyText: '10' }], async (i) => { asked.push(i.supplierId); return { proposed: true, totalMinor: 30_000 }; });
    expect(out.result === 'ok' && out.value.held).toEqual([]);
    expect(asked).toEqual(['sup-home']);
  });

  it('the words are in English and Tamil', () => {
    for (const k of ['bigOrder', 'bigOrderRow', 'raiseBigOrders'] as const) {
      expect(REPLENISHMENT_COPY.en[k], k).toBeTruthy();
      expect(REPLENISHMENT_COPY.ta[k], k).toBeTruthy();
    }
  });
});
