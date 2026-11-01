import { describe, it, expect } from 'vitest';
import {
  createOpenOrdersSession, amendmentBody, cancellationBody, editableQty, editablePrice, lineQty, openOrdersWords, openOrdersOutcomeWords, OPEN_ORDERS_COPY,
  type IssuedOrder,
} from '../../apps/web-erp/src/open-orders-session';

/**
 * The Buying page's Open orders tab (M06-FR-04 · OB-289 · OB-31): the open-commitment report read as head office keeps it,
 * and an issued order amended or part-cancelled with every typed quantity read in the line's OWN unit ("2.5" of a kg line
 * is 2500 g, never 2.5 g or 2500 kg). The connected proof is tests/e2e/open-orders-are-amended-and-cancelled-on-the-buying-page.e2e.ts.
 */

const ORDER: IssuedOrder = {
  poId: 'po-1', number: 'PO-0001', supplierId: 'sup-1', deliverTo: 'br-1', status: 'issued', currency: 'INR', amendmentCount: 0, totalMinor: 0,
  lines: [
    { productId: 'RICE', orderedQty: 25_000, uom: 'kg', unitCost: { minor: 6_000, currency: 'INR' } },
    { productId: 'SOAP', orderedQty: 12, unitCost: { minor: 4_000, currency: 'INR', per: 12 } },
  ],
  receivedByProduct: {}, cancelledByProduct: {},
};

function fakeFetch(answers: Record<string, unknown> = {}) {
  const sent: { method: string; path: string; body?: unknown; key?: string }[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string; headers: Record<string, string> }) => {
    sent.push({ method: init.method, path, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }), ...(init.headers['idempotency-key'] === undefined ? {} : { key: init.headers['idempotency-key'] }) });
    const body = answers[`${init.method} ${path.split('?')[0]}`] ?? {};
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

describe('the Open orders tab session (M06-FR-04)', () => {
  it('words each quantity in its own unit, and offers the editable figure the person types', () => {
    expect(lineQty(25_000, 'kg')).toBe('25.000 kg');
    expect(lineQty(12, 'ea')).toBe('12');
    expect(editableQty(25_000, 'kg')).toBe('25.000');
    expect(editableQty(12, 'ea')).toBe('12');
    expect(editablePrice(ORDER.lines[0]!)).toBe('60.00');
    expect(editablePrice(ORDER.lines[1]!), 'a case-priced line asks for the unit price').toBe('');
  });

  it('an amendment carries the full line set in each line\'s own unit, the reason, and an over-budget reason only when given', () => {
    const made = amendmentBody(ORDER, { lines: [{ productId: 'RICE', qtyText: '2.5', priceText: '58' }, { productId: 'SOAP', qtyText: '10', priceText: '3.50' }], reason: ' supplier short ', overBudgetReason: '' }, 'amd-1');
    expect(made).toEqual({ body: { amendmentId: 'amd-1', reason: 'supplier short', lines: [
      { productId: 'RICE', orderedQty: 2_500, uom: 'kg', unitCost: { minor: 5_800, currency: 'INR' } },
      { productId: 'SOAP', orderedQty: 10, unitCost: { minor: 350, currency: 'INR' } },
    ] } });
    expect(amendmentBody(ORDER, { lines: [{ productId: 'RICE', qtyText: '2.5', priceText: '58' }], reason: 'x', overBudgetReason: ' festival ' }, 'a')).toMatchObject({ body: { overBudgetReason: 'festival' } });
    expect(amendmentBody(ORDER, { lines: [{ productId: 'RICE', qtyText: '2.5', priceText: '58' }], reason: ' ', overBudgetReason: '' }, 'a')).toEqual({ why: 'needReason' });
    expect(amendmentBody(ORDER, { lines: [{ productId: 'RICE', qtyText: '2.5555', priceText: '58' }], reason: 'x', overBudgetReason: '' }, 'a')).toEqual({ why: 'needLines' });
    expect(amendmentBody(ORDER, { lines: [{ productId: 'SOAP', qtyText: '1.5', priceText: '3' }], reason: 'x', overBudgetReason: '' }, 'a'), 'half a bar is refused').toEqual({ why: 'needLines' });
    expect(amendmentBody(ORDER, { lines: [{ productId: 'SOAP', qtyText: '10', priceText: '' }], reason: 'x', overBudgetReason: '' }, 'a')).toEqual({ why: 'needLines' });
    expect(amendmentBody({ ...ORDER, lines: [{ productId: 'X', orderedQty: 1, uom: 'crate', unitCost: { minor: 1, currency: 'INR' } }] }, { lines: [{ productId: 'X', qtyText: '1', priceText: '1' }], reason: 'x', overBudgetReason: '' }, 'a')).toEqual({ why: 'unitUnknown' });
  });

  it('a cancellation names only the items given a quantity, in their own unit', () => {
    expect(cancellationBody(ORDER, { lines: [{ productId: 'RICE', qtyText: '5' }, { productId: 'SOAP', qtyText: ' ' }], reason: 'over-ordered' }, 'cxl-1'))
      .toEqual({ body: { cancellationId: 'cxl-1', cancelledByProduct: { RICE: 5_000 }, reason: 'over-ordered' } });
    expect(cancellationBody(ORDER, { lines: [{ productId: 'RICE', qtyText: '' }], reason: 'x' }, 'c')).toEqual({ why: 'needCancel' });
    expect(cancellationBody(ORDER, { lines: [{ productId: 'RICE', qtyText: '5' }], reason: '' }, 'c')).toEqual({ why: 'needReason' });
    expect(cancellationBody(ORDER, { lines: [{ productId: 'RICE', qtyText: '-1' }], reason: 'x' }, 'c')).toEqual({ why: 'needCancel' });
  });

  it('reads the report with its filters and the issued orders beside it; changes go to head office once each; a reader is offered no change', async () => {
    const report = { lines: [{ poId: 'po-1', productId: 'RICE' }], byScope: [], bySupplier: [], byStore: [], totalOpenMinor: 0, issuedOrders: 1, overReceived: [], receiptsDisagree: [], asAt: 'now' };
    const { fetch, sent } = fakeFetch({ 'GET /v1/purchase/commitments/report': report, 'GET /v1/purchase/orders': { orders: [ORDER, { ...ORDER, poId: 'po-2' }, { ...ORDER, poId: 'po-3', status: 'proposed' }] } });
    let n = 0;
    const s = createOpenOrdersSession({ viewer: { userId: 'u-owner', permissions: ['purchase.commitment.read', 'purchase.order.approve'] }, fetch, newKey: () => `k-${n++}`, newId: (p) => `${p}-1` });
    const out = await s.read({ buyingScope: 'local', supplierId: ' sup-1 ', storeId: '' });
    expect(out.result === 'ok' && out.value.orders.map((o) => o.poId)).toEqual(['po-1']);
    await s.read({ buyingScope: '', supplierId: '', storeId: '' });
    await s.amend(ORDER, { lines: [{ productId: 'RICE', qtyText: '20', priceText: '60' }], reason: 'less', overBudgetReason: '' });
    await s.cancel(ORDER, { lines: [{ productId: 'RICE', qtyText: '1.25' }], reason: 'short shelf life' });
    expect(sent.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /v1/purchase/commitments/report?buyingScope=local&supplierId=sup-1', 'GET /v1/purchase/orders',
      'GET /v1/purchase/commitments/report', 'GET /v1/purchase/orders',
      'POST /v1/purchase/orders/po-1/amendments', 'POST /v1/purchase/orders/po-1/cancellations',
    ]);
    expect(sent[4]).toMatchObject({ key: 'k-0', body: { amendmentId: 'amd-1', lines: [{ productId: 'RICE', orderedQty: 20_000, uom: 'kg' }] } });
    expect(sent[5]).toMatchObject({ key: 'k-1', body: { cancellationId: 'cxl-1', cancelledByProduct: { RICE: 1_250 } } });

    const reader = createOpenOrdersSession({ viewer: { userId: 'u-mgr', permissions: ['purchase.commitment.read'] }, fetch });
    expect(reader.may).toEqual({ named: true, read: true, change: false });
    expect(await reader.amend(ORDER, { lines: [], reason: 'x', overBudgetReason: '' })).toEqual({ result: 'invalid', why: 'cannotChange' });
    const cashier = createOpenOrdersSession({ viewer: { userId: 'u-c', permissions: [] }, fetch });
    expect(await cashier.read({ buyingScope: '', supplierId: '', storeId: '' })).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await createOpenOrdersSession({ viewer: undefined, fetch }).read({ buyingScope: '', supplierId: '', storeId: '' })).toEqual({ result: 'invalid', why: 'nobody' });
  });

  it('says head office\'s refusal in its own words, and every word has a Tamil twin', () => {
    expect(openOrdersOutcomeWords('en', { result: 'refused', status: 422, code: 'above_your_limit_goes_to_owner', whatHappened: 'Order po-1 would be ₹9,000.00 …' })).toBe('Head office refused: Order po-1 would be ₹9,000.00 …');
    expect(openOrdersOutcomeWords('en', { result: 'ok', value: {} }, 'cancelledNow')).toBe('Cancelled — what is still on order went down by that.');
    for (const k of Object.keys(OPEN_ORDERS_COPY.en)) expect(openOrdersWords('ta', k), k).not.toBe(openOrdersWords('en', k));
  });
});
