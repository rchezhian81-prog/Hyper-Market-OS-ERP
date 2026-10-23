import { describe, it, expect } from 'vitest';
import { splitInclusiveWithCess, cessRateOn, readCessRate, InvalidCessInput, type CessRate } from '../../packages/finance/src/cess';
import { extractInclusiveGst } from '../../packages/finance/src/inclusive-tax';
import { buildCatalogueSnapshot } from '../../packages/catalogue/src/snapshot-builder';
import { canonicalise } from '../../services/catalogue/src/pack';
import { buildTaxInvoice, taxInvoiceRows, invoiceRenderProblems, taxInvoiceText } from '../../packages/receipt/src/tax-invoice';
import { salesToOutwardSupplies, netTable12, toGstnB2cFromSales } from '../../packages/finance/src/outward-from-sales';
import { PosSession } from '../../apps/pos/src/session';
import { billReceipt } from '../../apps/pos/src/bill-receipt';
import { realTradingSaleRefusal } from '../../edge/store-edge/src/real-trading';
import { acceptSale, type IncomingSale, type IntakeContext } from '../../services/pos/src/index';
import { money } from '../../packages/contracts/src/money';
import { rate } from '../../packages/contracts/src/rate';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

/**
 * **A7 (roadmap v2.1 · GST Compensation Cess, activated 11 Aug: tobacco is stocked) — the cess is carried in the signed pack
 * per HSN, charged by the till INSIDE the MRP beside the GST, printed on the bill, frozen on the sale line, and filed on
 * GSTR-1 (`csamt`).** The rates here are synthetic stand-ins: the CA confirms the real ones (they are data, never code).
 */

const CIG: CessRate = { advaloremBps: 500, specificPerQuantityMinor: 417_000, perQuantity: 1000 }; // 5% + ₹4,170 per 1000 sticks
const PAN: CessRate = { advaloremBps: 6_000, specificPerQuantityMinor: 0, perQuantity: 1 };         // 60%
const SHOP = { legalName: 'SRE Hyper Market Private Limited', gstin: '33AABCS1429B1Z1', placeOfBusiness: ['12 Main Road', 'Tiruppur 641601, Tamil Nadu'] };

describe('A7 — the cess comes out of the MRP beside the GST, to the paisa', () => {
  it('a 20-stick pack at ₹350, 28% GST + 5% + ₹4,170/1000: taxable + GST + cess = ₹350 exactly', () => {
    const s = splitInclusiveWithCess({ grossMinor: 35_000, gstRateBps: 2_800, cess: CIG, quantity: 20 });
    expect(s).toEqual({ grossMinor: 35_000, taxableMinor: 20_045, gstMinor: 5_613, advaloremCessMinor: 1_002, specificCessMinor: 8_340, cessMinor: 9_342 });
    expect(s.taxableMinor + s.gstMinor + s.cessMinor).toBe(35_000);
  });
  it('with no cess it is exactly the ordinary inclusive split (no line changes)', () => {
    for (const [gross, bps] of [[10_500, 500], [9_999, 1_800], [1, 2_800], [123_457, 1_200], [5_000, 0]] as const) {
      const s = splitInclusiveWithCess({ grossMinor: gross, gstRateBps: bps, quantity: 1 });
      const g = extractInclusiveGst({ mrpMinor: gross, rateBps: bps, placeOfSupply: 'inter_state' });
      expect([s.taxableMinor, s.gstMinor, s.cessMinor]).toEqual([g.taxableMinor, g.totalTaxMinor, 0]);
    }
  });
  it('reconciles on 2,000 random lines; refuses a specific cess above the price', () => {
    let seed = 7;
    const rnd = (n: number): number => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % n; };
    for (let i = 0; i < 2_000; i += 1) {
      const gross = 1 + rnd(500_000);
      const cess: CessRate = { advaloremBps: rnd(7_000), specificPerQuantityMinor: rnd(3) === 0 ? 0 : rnd(5_000), perQuantity: 1 + rnd(1_000) };
      const quantity = 1 + rnd(20);
      try {
        const s = splitInclusiveWithCess({ grossMinor: gross, gstRateBps: [0, 500, 1_200, 1_800, 2_800][rnd(5)]!, cess, quantity });
        expect(s.taxableMinor + s.gstMinor + s.cessMinor).toBe(gross);
        expect(Math.min(s.taxableMinor, s.gstMinor, s.cessMinor)).toBeGreaterThanOrEqual(0);
      } catch (e) { expect(e).toBeInstanceOf(InvalidCessInput); }
    }
    expect(() => splitInclusiveWithCess({ grossMinor: 1_000, gstRateBps: 2_800, cess: CIG, quantity: 20 })).toThrow(/above the price/);
  });
  it('the schedule: the latest period on or before the day; a 0/0 period ends the cess; unreadable rates are none', () => {
    const schedule = [
      { effectiveFrom: '2017-07-01', advaloremBps: 6_000, specificPerQuantityMinor: 0, perQuantity: 1 },
      { effectiveFrom: '2030-01-01', advaloremBps: 0, specificPerQuantityMinor: 0, perQuantity: 1 },
    ];
    expect(cessRateOn(schedule, '2016-12-31')).toBeUndefined();
    expect(cessRateOn(schedule, '2026-10-23')).toEqual(PAN);
    expect(cessRateOn(schedule, '2030-06-01')).toBeUndefined();
    expect(readCessRate({ advaloremBps: 1.5, specificPerQuantityMinor: 0 })).toBeUndefined();
    expect(readCessRate({ advaloremBps: 0, specificPerQuantityMinor: 10 })).toBeUndefined(); // a specific rate needs its block
  });
});

describe('A7 — the pack carries the cess per HSN, signed; a cess on the 40% demerit slab is never shipped', () => {
  const build = (taxClasses: Record<string, number>) => buildCatalogueSnapshot({
    scope: { tenantId: 't', storeId: 's1' }, version: 1, asOf: '2026-10-23T00:00:00.000Z',
    products: [
      { productId: 'p-pan', sku: 'PAN', name: 'Pan masala 10g', baseUom: 'ea', taxClassId: '21069020', status: 'active' },
      { productId: 'p-dal', sku: 'DAL', name: 'Toor dal', baseUom: 'ea', taxClassId: '071360', status: 'active' },
    ],
    barcodes: [],
    priceEntries: ['p-pan', 'p-dal'].map((productId) => ({ id: `e-${productId}`, productId, scope: 'store' as const, scopeRef: 's1', price: money(1_000, 'INR'), effectiveFrom: '2026-01-01', status: 'active' as const, version: 1 })),
    taxClasses, taxClassCess: { '21069020': PAN },
  });
  it('the cess-liable product carries its cess; the other does not; the signature covers it', () => {
    const { snapshot, excluded } = build({ '21069020': 2_800, '071360': 500 });
    expect(excluded).toEqual([]);
    expect(snapshot.products.find((p) => p.productId === 'p-pan')?.cess).toEqual(PAN);
    expect(snapshot.products.find((p) => p.productId === 'p-dal')?.cess).toBeUndefined();
    const edited: CatalogueSnapshot = { ...snapshot, products: snapshot.products.map((p) => (p.cess === undefined ? p : { ...p, cess: { ...p.cess, advaloremBps: 0 } })) };
    expect(canonicalise(edited)).not.toBe(canonicalise(snapshot));
    const plain: CatalogueSnapshot = { ...snapshot, products: snapshot.products.filter((p) => p.cess === undefined) };
    expect(canonicalise(plain)).not.toContain('--cess');
  });
  it('a cess-liable HSN put on the 40% slab would be taxed twice: left out, and said', () => {
    expect(build({ '21069020': 4_000, '071360': 500 }).excluded).toEqual([{ productId: 'p-pan', sku: 'PAN', reason: 'cess_on_demerit_slab' }]);
  });
});

const session = (cess: CessRate | undefined, realTrading = false) => {
  const written: Record<string, unknown>[] = [];
  const s = new PosSession(
    { laneId: 'lane-1', cashierId: 'u-meena', currency: 'INR', defaultTaxRate: rate(2_800), clock: () => '2026-10-23T09:00:00.000Z', cessOf: (id) => (id === 'p-pan' ? cess : undefined), ...(realTrading ? { realTrading: { identity: SHOP } } : {}) },
    new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
    async (_id, record) => { written.push(JSON.parse(record) as Record<string, unknown>); return { committed: true } as never; },
  );
  return { s, written };
};

describe('A7 — the till charges the cess inside the MRP; the record, the bill and the tax invoice carry it', () => {
  it('a ₹10 pan masala at 28% + 60% cess: the line freezes the cess; net + GST + cess = the bill; the bill prints the cess', async () => {
    const { s, written } = session(PAN);
    s.scan({ productId: 'p-pan', description: 'Pan masala 10g', unitPrice: money(1_000, 'INR'), quantityMinor: 3, uom: 'ea', taxRate: rate(2_800), hsnCode: '21069020' });
    s.scan({ productId: 'p-dal', description: 'Toor dal', unitPrice: money(10_500, 'INR'), quantityMinor: 1, uom: 'ea', taxRate: rate(500), hsnCode: '071360' });
    await s.commit('S-1', 'N-000001', '2026-10-23T09:00:00.000Z', [{ kind: 'cash', amount: money(13_500, 'INR'), status: 'settled' }]);
    const rec = written[0] as { lines: { productId: string; cess?: CessRate; cessMinor?: number }[]; netMinor: number; taxMinor: number; cessMinor: number; total: number };
    const pan = splitInclusiveWithCess({ grossMinor: 3_000, gstRateBps: 2_800, cess: PAN, quantity: 3 });
    expect(rec.lines[0]).toMatchObject({ productId: 'p-pan', cess: PAN, cessMinor: pan.cessMinor });
    expect(rec.lines[1]?.cess).toBeUndefined();
    expect(rec.cessMinor).toBe(pan.cessMinor);
    expect(rec.netMinor + rec.taxMinor + rec.cessMinor).toBe(rec.total);
    const printed = billReceipt(s.lastBill());
    if (!printed.ok) throw new Error(printed.why);
    expect(printed.lines.join('\n')).toContain('Compensation cess');
  });

  it('in real trading the tax invoice has the cess per line and in total (rounded to the rupee, A10), the paper is complete, and never above the MRP', async () => {
    const { s, written } = session(PAN, true);
    s.scan({ productId: 'p-pan', description: 'Pan masala 10g', unitPrice: money(1_000, 'INR'), quantityMinor: 3, uom: 'ea', taxRate: rate(2_800), hsnCode: '21069020' });
    const payable = s.totals().payable.minor;
    expect(payable).toBeLessThanOrEqual(3_000);
    await s.commit('S-2', 'N-000002', '2026-10-23T09:00:00.000Z', [{ kind: 'cash', amount: money(payable, 'INR'), status: 'settled' }]);
    const inv = s.lastBill()?.taxInvoice;
    if (inv === undefined) throw new Error('no invoice');
    expect(inv.lines[0]?.cessMinor).toBeGreaterThan(0);
    expect(inv.cessExactMinor).toBe(inv.lines[0]!.cessMinor);
    expect(inv.cessMinor % 100).toBe(0);
    const rows = taxInvoiceRows(inv);
    expect(invoiceRenderProblems(rows, inv)).toEqual([]);
    expect(taxInvoiceText(rows).join('\n')).toMatch(/Compensation cess/);
    expect(inv.totalMinor).toBe(written[0]?.['total']);
    // The store computer judges the cess from ITS pack: a record that dropped it is refused before the disk.
    const dropped = { ...written[0], lines: (written[0]!['lines'] as Record<string, unknown>[]).map((l) => Object.fromEntries(Object.entries(l).filter(([k]) => k !== 'cess' && k !== 'cessMinor'))) };
    expect(realTradingSaleRefusal(written[0]!, SHOP, () => PAN)).toBeUndefined();
    expect(realTradingSaleRefusal(dropped, SHOP, () => PAN)?.laneMessage).toMatch(/compensation cess on the bill is not the cess the price list gives/);
  });

  it('the invoice refuses a line whose cess cannot come out of its price', () => {
    const built = buildTaxInvoice({ identity: SHOP, number: 'N-1', committedAt: '2026-10-23T09:00:00.000Z', laneId: 'l', cashierId: 'c',
      lines: [{ description: 'Cigarettes', hsnCode: '240220', quantityMinor: 20, uom: 'ea', unitPriceMinor: 50, lineTotalMinor: 1_000, taxRateBps: 2_800, cess: CIG }] });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.problems.map((p) => p.code)).toContain('line_cess');
  });
});

describe('A7 — GSTR-1 from the till\'s sales carries the cess (csamt), and a return reverses it', () => {
  it('table 12, the net, and the GSTN file', () => {
    const sold = salesToOutwardSupplies({
      sales: [{ productId: 'p-pan', quantityMinor: 3, uom: 'ea', lineTotalMinor: 3_000, hsnCode: '21069020', rateBps: 2_800, cess: PAN }],
      taxTable: [], annualTurnoverMinor: 100_00_00_000_00,
    });
    const s = splitInclusiveWithCess({ grossMinor: 3_000, gstRateBps: 2_800, cess: PAN, quantity: 3 });
    expect(sold.table12.rows[0]).toMatchObject({ hsnCode: '21069020', taxableMinor: s.taxableMinor, cessMinor: s.cessMinor });
    expect(sold.table12.rows[0]!.cgstMinor + sold.table12.rows[0]!.sgstMinor).toBe(s.gstMinor);
    expect(sold.table12.totalCessMinor).toBe(s.cessMinor);
    const returned = salesToOutwardSupplies({
      sales: [{ productId: 'p-pan', quantityMinor: 1, uom: 'ea', lineTotalMinor: 1_000, hsnCode: '21069020', rateBps: 2_800, cess: PAN }],
      taxTable: [], annualTurnoverMinor: 100_00_00_000_00,
    });
    const net = netTable12(sold.table12, returned.table12);
    expect(net.rows[0]?.netCessMinor).toBe(s.cessMinor - splitInclusiveWithCess({ grossMinor: 1_000, gstRateBps: 2_800, cess: PAN, quantity: 1 }).cessMinor);
    const gstn = toGstnB2cFromSales(net, { gstin: SHOP.gstin, fp: '102026' });
    expect(gstn.b2cs[0]?.csamt).toBe(net.rows[0]!.netCessMinor! / 100);
    expect(gstn.hsn.data[0]?.csamt).toBe(net.rows[0]!.netCessMinor! / 100);
    // A line with no cess files as before: no csamt key at all.
    const plain = salesToOutwardSupplies({ sales: [{ productId: 'p-dal', quantityMinor: 1, uom: 'ea', lineTotalMinor: 10_500, hsnCode: '071360', rateBps: 500 }], taxTable: [], annualTurnoverMinor: 100_00_00_000_00 });
    const none = salesToOutwardSupplies({ sales: [], taxTable: [], annualTurnoverMinor: 100_00_00_000_00 });
    const plainFile = toGstnB2cFromSales(netTable12(plain.table12, none.table12), { gstin: SHOP.gstin, fp: '102026' });
    expect(plainFile.b2cs).toHaveLength(1);
    expect(plainFile.b2cs[0]).not.toHaveProperty('csamt');
    expect(plainFile.hsn.data[0]).not.toHaveProperty('csamt');
  });
});

describe('A7 — head office flags a cess-liable line that arrives without its cess (an older till)', () => {
  it('material finding; none when the cess is on the line', () => {
    const ctx = (): IntakeContext => ({
      catalogue: new Map([['p-pan', { productId: 'p-pan', sku: 'PAN', name: 'Pan masala', baseUom: 'ea', unitPriceMinor: 1_000, taxBps: 2_800, mrpMinor: 1_000, status: 'active' as const, cess: PAN }]]),
      currentPackVersion: 1, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: '2026-10-23T09:00:00.000Z',
    });
    const sale = (line: Record<string, unknown>): IncomingSale => ({
      saleId: 'S1', receiptNumber: 'R1', laneId: 'l1', cashierId: 'u', tradingDay: '2026-10-23', committedAt: '2026-10-23T09:00:00.000Z', totalMinor: 1_000, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'p-pan', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_000, lineTotalMinor: 1_000, ...line }], tenders: [{ kind: 'cash', amountMinor: 1_000 }],
    });
    expect(acceptSale(sale({}), ctx()).exceptions.map((e) => e.kind)).toContain('cess_not_on_the_line');
    expect(acceptSale(sale({ cess: PAN, cessMinor: 213 }), ctx()).exceptions.map((e) => e.kind)).not.toContain('cess_not_on_the_line');
  });
});
