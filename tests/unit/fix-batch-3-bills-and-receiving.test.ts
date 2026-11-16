import { describe, it, expect } from 'vitest';
import { billsToCheckOf, typedLinesFromOrder, createSupplierBillsSession, type HeadOfficeCall } from '../../apps/web-erp/src/supplier-bills-session';
import { openBillsOf, createSupplierPaymentSession, supplierPaymentWords } from '../../apps/web-erp/src/supplier-payment-session';
import { cataloguePayload, notOnTheTills, warehousePayload, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { readPack } from '../../edge/store-edge/src/store-pack';

/**
 * Fix batch 3 (bills and receiving) — the pure parts behind D-045, D-047, D-043, D-005 and D-031. Each is proved in a real
 * browser too (tests/e2e/d045-d047-d043-…, d005-…, warehouse-handheld-syncs-through-the-box); these pin the rules.
 */

describe('D-045: the bills waiting to be checked against their order', () => {
  const register = { invoices: [
    { invoice: { invoiceId: 'inv-new', supplierId: 'sup-1', poId: 'po-1', totalMinor: 50_000 }, match: null },
    { invoice: { invoiceId: 'inv-held', supplierId: 'sup-1', poId: null, totalMinor: 9_000 }, match: { blocked: true } },
    { invoice: { invoiceId: 'inv-ok', supplierId: 'sup-1', poId: 'po-2', totalMinor: 30_000 }, match: { blocked: false } },
  ] };

  it('never checked and held back are waiting; agreed is not', () => {
    expect(billsToCheckOf(register)).toEqual([
      { invoiceId: 'inv-new', supplierId: 'sup-1', poId: 'po-1', totalMinor: 50_000, state: 'not_checked' },
      { invoiceId: 'inv-held', supplierId: 'sup-1', poId: null, totalMinor: 9_000, state: 'held_back' },
    ]);
    expect(billsToCheckOf(null)).toEqual([]);
  });

  it('the accountant (match + read, no capture) reads head office\'s invoice register — never the capture register', async () => {
    const asked: string[] = [];
    const call: HeadOfficeCall = async (req) => { asked.push(`${req.method} ${req.path}`); return { status: 200, body: register }; };
    const s = createSupplierBillsSession(call, { permissions: ['purchase.invoice.match', 'purchase.commitment.read'] });
    expect([s.mayCapture, s.mayMatch, s.mayReadBills]).toEqual([false, true, true]);
    const out = await s.billsToCheck();
    expect(out.ok && out.value.map((b) => b.invoiceId)).toEqual(['inv-new', 'inv-held']);
    expect(asked).toEqual(['GET /v1/purchase/invoices']);
  });
});

describe('D-043: a paper bill\'s lines filled from its order', () => {
  it('each product\'s quantity received at the agreed price; what cannot be filled exactly is left to the person', () => {
    const order = {
      lines: [
        { productId: 'rice', orderedQty: 10, unitCost: { minor: 5_000, currency: 'INR' } },
        { productId: 'dal', orderedQty: 4, unitCost: { minor: 10_050, currency: 'INR' }, uom: 'ea' },
        { productId: 'sugar', orderedQty: 5_000, unitCost: { minor: 4_500, currency: 'INR' }, uom: 'kg' },
        { productId: 'soap', orderedQty: 48, unitCost: { minor: 24_000, currency: 'INR', per: 12 } },
        { productId: 'oil', orderedQty: 6, unitCost: { minor: 16_000, currency: 'INR' } },
      ],
      receivedByProduct: { rice: 8, dal: 4, sugar: 5_000, soap: 48 },
    };
    expect(typedLinesFromOrder(order)).toEqual({
      lines: [
        { productId: 'rice', quantity: '8', unitPrice: '50.00', amount: '400.00' },
        { productId: 'dal', quantity: '4', unitPrice: '100.50', amount: '402.00' },
      ],
      left: ['sugar', 'soap', 'oil'],
    });
    expect(typedLinesFromOrder(undefined)).toEqual({ lines: [], left: [] });
  });
});

describe('D-047: the bills a payment may tick', () => {
  const account = {
    invoices: [
      { invoiceId: 'inv-a', poId: 'po-a', matched: true, blocked: false, payableMinor: 50_000 },
      { invoiceId: 'inv-paid', poId: 'po-p', matched: true, blocked: false, payableMinor: 20_000 },
      { invoiceId: 'inv-held', poId: 'po-h', matched: true, blocked: true, payableMinor: 0 },
      { invoiceId: 'inv-new', poId: 'po-n', matched: false, blocked: false, payableMinor: 0 },
    ],
    payments: [{ paymentId: 'pay-1', settles: ['inv-paid'] }, { paymentId: 'pay-2' }],
  };

  it('matched, agreed, something payable and not named by a recorded payment', () => {
    expect(openBillsOf(account)).toEqual([{ invoiceId: 'inv-a', poId: 'po-a', payableMinor: 50_000 }]);
    expect(openBillsOf(undefined)).toEqual([]);
  });

  it('reads head office\'s statement of the supplier; a supplier head office has no record of has none', async () => {
    const fetched: string[] = [];
    const fetchFn = (async (url: string) => {
      fetched.push(url);
      return url.endsWith('/sup-x/account')
        ? new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 })
        : new Response(JSON.stringify(account), { status: 200 });
    }) as unknown as typeof fetch;
    const s = createSupplierPaymentSession({ viewer: { userId: 'u-acct', permissions: ['purchase.supplier.pay', 'purchase.commitment.read'] }, fetch: fetchFn });
    expect(await s.openBills('sup-1')).toEqual({ result: 'ok', value: [{ invoiceId: 'inv-a', poId: 'po-a', payableMinor: 50_000 }] });
    expect(await s.openBills('sup-x')).toEqual({ result: 'ok', value: [] });
    expect(fetched).toEqual(['/v1/purchase/suppliers/sup-1/account', '/v1/purchase/suppliers/sup-x/account']);
  });

  it('the words are English and Tamil', () => {
    for (const k of ['billsPick', 'billsNone', 'billLine', 'billsTotal', 'billsNoneTicked', 'billsReading']) {
      expect(supplierPaymentWords('en', k)).not.toBe(k);
      expect(supplierPaymentWords('ta', k)).not.toBe(supplierPaymentWords('en', k));
    }
    expect(supplierPaymentWords('en', 'billsTotal', { n: 2, total: '₹800.00' })).toBe('Ticked: 2 bill(s), ₹800.00 in all');
  });
});

describe('D-005 and D-031: what the store computer tells the Products page and the warehouse handheld', () => {
  const at = '2026-11-15T09:00:00.000Z';
  const masterOf = (productId: string, extra: Record<string, unknown> = {}) => ({ productId, tenantId: 't', sku: productId, name: productId, primaryCategoryId: null, baseUom: 'ea', taxClass: '0401', lifecycle: 'active', ...extra });
  const pack = readPack({
    version: 1, lossPreventionRules: [],
    policies: { tradingDayCutoff: '00:00', storeId: 'S1', branchId: 'S1' },
    pricingPolicy: { userId: 'u-mgr', approvers: ['u-owner'], marginFloorBps: 2_000 },
    products: [{ productId: 'OIL', name: 'Oil', categoryId: 'g', unitPriceMinor: 16_500, uom: 'ea', taxBps: 500, status: 'active', recallBlock: false, barcodes: ['890OIL'], availableMinor: 1 }],
    productMaster: [masterOf('OIL'), masterOf('MILK'), masterOf('SALT', { taxClass: null }), masterOf('DRAFT', { lifecycle: 'draft' })],
    warehouse: {
      assignmentId: 'w-S1', workerId: '', storeId: 'S1', bins: [],
      openDeliveries: [{ poId: 'po-1', number: 'PO-1', supplierId: 'sup-1', deliverToLocationId: 'S1', grnId: 'grn-po-1-1', ordered: [] }],
    },
  }, at);
  const input = { pack, now: at, tradingDay: '2026-11-15' } as unknown as ScreenInput;

  it('D-005: an item on sale in the master but not in the till catalogue is named, with why; a draft is not', () => {
    expect(notOnTheTills(input)).toEqual([{ productId: 'MILK', why: 'no_price' }, { productId: 'SALT', why: 'no_tax_class' }]);
    expect(cataloguePayload(input)!['notOnTills']).toEqual([{ productId: 'MILK', why: 'no_price' }, { productId: 'SALT', why: 'no_tax_class' }]);
  });

  it('D-031: the handheld is told when the box took its list of waiting deliveries', () => {
    expect(warehousePayload(input)).toMatchObject({ deliveriesAsAt: at, openDeliveries: [{ poId: 'po-1' }] });
  });
});
