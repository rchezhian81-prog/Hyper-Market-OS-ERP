// R3 · A17 — a synthetic shop for the GSTR-2B / ITC journeys (integration on memory and PostgreSQL, and the browser page).
//
// Everything is laid down THE WAY THE SHOP DOES IT, through the real routes: two suppliers with their GSTINs put in the
// master by one person and approved by another; for each bill an issued purchase order, a goods receipt of everything,
// the bill captured as the paper says it (with the supplier's own invoice number and date) and three-way matched by a
// second person. Synthetic data only.
//
// October 2026, as the books hold it:
//   A/101  Synthetic Foods (SUP_A)  5 Oct  ₹10,000 + CGST ₹900 + SGST ₹900   → in the 2B exactly        → MATCHED
//   A/102  Synthetic Foods (SUP_A)  6 Oct  ₹5,000  + CGST ₹450 + SGST ₹440   → the 2B says SGST ₹450    → DIFFERS
//   B-77   Synthetic Oils  (SUP_B)  9 Oct  ₹2,000  + IGST ₹240               → in the 2B exactly        → MATCHED
//   B-90   Synthetic Oils  (SUP_B) 20 Oct  ₹500    + IGST ₹60                → not in the 2B            → MISSING FROM 2B
// and the 2B carries one more, B-78 (₹1,000 + IGST ₹120), that the shop never booked → NOT IN BOOKS.

export const SHOP_GSTIN = '33BBBBB2222B1Z6';
export const SUP_A = '33AAAAA1111A1Z5';
export const SUP_B = '29CCCCC3333C1Z7';
export const ITC_PERIOD = '2026-10';

/** The people: the accountant uploads and acts (OB-145 "A"); a buyer and a second checker run the purchase side. */
export const ACCOUNTANT = 'u-acct';
export const BUYER = 'u-buyer';

type Reply = { readonly status: number; readonly body: unknown };
export type Call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, idempotencyKey?: string) => Promise<Reply>;

const must = async (p: Promise<Reply>, what: string): Promise<Reply> => {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
};

/** The October GSTR-2B in the portal's own JSON shape, as the accountant downloads it. */
export function october2b(): unknown {
  return {
    data: {
      rtnprd: '102026', gstin: SHOP_GSTIN,
      docdata: {
        b2b: [
          { ctin: SUP_A, trdnm: 'Synthetic Foods', inv: [
            { inum: 'A/101', dt: '05-10-2026', val: '11800.00', txval: '10000.00', igst: 0, cgst: '900.00', sgst: '900.00', cess: 0, itcavl: 'Y', rev: 'N' },
            { inum: 'A/102', dt: '06-10-2026', val: '5900.00', txval: '5000.00', igst: 0, cgst: '450.00', sgst: '450.00', cess: 0, itcavl: 'Y', rev: 'N' },
          ] },
          { ctin: SUP_B, trdnm: 'Synthetic Oils', inv: [
            { inum: 'B-77', dt: '09-10-2026', val: '2240.00', txval: '2000.00', igst: '240.00', cgst: 0, sgst: 0, cess: 0, itcavl: 'Y', rev: 'N' },
            { inum: 'B-78', dt: '10-10-2026', val: '1120.00', txval: '1000.00', igst: '120.00', cgst: 0, sgst: 0, cess: 0, itcavl: 'Y', rev: 'N' },
          ] },
        ],
      },
    },
  };
}

interface Bill {
  readonly id: string; readonly supplierId: string; readonly no: string; readonly date: string; readonly productId: string;
  readonly qty: number; readonly unitMinor: number; readonly cgst?: number; readonly sgst?: number; readonly igst?: number;
}
const BILLS: readonly Bill[] = [
  { id: 'inv-a101', supplierId: 's-foods', no: 'A/101', date: '2026-10-05', productId: 'p-rice', qty: 10, unitMinor: 100_000, cgst: 90_000, sgst: 90_000 },
  { id: 'inv-a102', supplierId: 's-foods', no: 'A/102', date: '2026-10-06', productId: 'p-dal', qty: 5, unitMinor: 100_000, cgst: 45_000, sgst: 44_000 },
  { id: 'inv-b77', supplierId: 's-oils', no: 'B-77', date: '2026-10-09', productId: 'p-oil', qty: 2, unitMinor: 100_000, igst: 24_000 },
  { id: 'inv-b90', supplierId: 's-oils', no: 'B-90', date: '2026-10-20', productId: 'p-oil', qty: 1, unitMinor: 50_000, igst: 6_000 },
];

/**
 * Lay the shop down. `grant(userId, roleId)` gives a person a role the way the harness or the real cloud does it;
 * `store` is a branch head office already knows, or one this creates under a synthetic company.
 */
export async function seedItcShop(input: {
  readonly call: Call; readonly owner: string; readonly grant: (userId: string, roleId: string) => Promise<void>;
  readonly store: string; readonly createStore: boolean;
}): Promise<void> {
  const { call, owner, store } = input;
  await input.grant(ACCOUNTANT, 'accountant');
  await input.grant(BUYER, 'store_manager');
  if (input.createStore) {
    await must(call('POST', '/v1/org/nodes/C-ITC', owner, { kind: 'company', name: 'Synthetic Retail' }, 'itc-org-c'), 'company');
    await must(call('POST', `/v1/org/nodes/${store}`, owner, { kind: 'branch', name: `Store ${store}`, parentId: 'C-ITC', companyId: 'C-ITC' }, `itc-org-${store}`), 'store');
  }
  for (const [supplierId, name, gstin] of [['s-foods', 'Synthetic Foods', SUP_A], ['s-oils', 'Synthetic Oils', SUP_B]] as const) {
    await must(call('POST', `/v1/purchase/suppliers/${supplierId}`, BUYER, { name, gstin }, `itc-sup-${supplierId}`), `propose ${supplierId}`);
    await must(call('POST', `/v1/purchase/suppliers/${supplierId}/approval`, ACCOUNTANT, { reason: 'synthetic supplier, GST registration checked' }, `itc-sup-ok-${supplierId}`), `approve ${supplierId}`);
  }
  for (const b of BILLS) {
    const po = `po-${b.id}`;
    await must(call('POST', `/v1/purchase/orders/${po}`, BUYER, { supplierId: b.supplierId, deliverToLocationId: store, lines: [{ productId: b.productId, orderedQty: b.qty, unitCost: { minor: b.unitMinor, currency: 'INR' } }] }, `itc-${po}`), `order ${po}`);
    await must(call('POST', `/v1/purchase/orders/${po}/approval`, owner, { reason: 'synthetic order' }, `itc-${po}-ok`), `approve ${po}`);
    await must(call('POST', `/v1/inventory/goods-receipt/grn-${b.id}`, owner, {
      warehouseId: store, receivedOnDate: b.date, currency: 'INR', poId: po,
      lines: [{ lineId: 'L1', productId: b.productId, orderedMinor: b.qty, countedMinor: b.qty, uom: 'ea', unitCost: { minor: b.unitMinor, currency: 'INR' }, condition: 'good' }],
    }, `itc-grn-${b.id}`), `receive ${b.id}`);
    const line = {
      productId: b.productId, quantity: b.qty, unitPriceMinor: b.unitMinor, lineTotalMinor: b.qty * b.unitMinor,
      ...(b.cgst === undefined ? {} : { cgstMinor: b.cgst }), ...(b.sgst === undefined ? {} : { sgstMinor: b.sgst }), ...(b.igst === undefined ? {} : { igstMinor: b.igst }),
    };
    const total = line.lineTotalMinor + (b.cgst ?? 0) + (b.sgst ?? 0) + (b.igst ?? 0);
    await must(call('POST', `/v1/purchase/invoices/${b.id}/capture`, BUYER, { supplierId: b.supplierId, poId: po, declaredTotalMinor: total, lines: [line], supplierInvoiceNo: b.no, supplierInvoiceDate: b.date }, `itc-cap-${b.id}`), `capture ${b.id}`);
    const m = await must(call('POST', `/v1/purchase/invoices/${b.id}/match`, ACCOUNTANT, {}, `itc-match-${b.id}`), `match ${b.id}`);
    if ((m.body as { blocked?: boolean }).blocked !== false) throw new Error(`match ${b.id} is blocked: ${JSON.stringify(m.body)}`);
  }
}
