import { describe, it, expect } from 'vitest';
import { bootPos, type PosReceiptTemplate } from '../../apps/pos/src/browser-entry';
import { billReceipt } from '../../apps/pos/src/bill-receipt';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import type { LaneScales } from '../../packages/restricted-sales/src/till-gate';
import { quantityLabel } from '../../packages/contracts/src/quantity';
import { buildReceipt, renderReceipt, ReceiptTotalsError } from '../../packages/receipt/src/index';

/**
 * **B13 (signed R3): "The HUID sold is printed on the bill."** The till's bill now goes through `@sre/receipt`
 * (`buildReceipt` + `renderReceipt`) — read off the sale record just saved — so a gold line prints "HUID: <code>" under
 * it, a weighed line prints in its unit, the GST inside the bill balances, and head office's template header, footer,
 * paper and version are used. A bill that cannot be made is said, never thrown into the (already saved) sale.
 * And the till's lines read in their unit (look only). Synthetic data only.
 */

const NOW = new Date().toISOString();
const day = (o: number): string => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);
const SCALES: LaneScales = { known: true, scales: [{ assetId: 'SCALE-L1', reverificationDueOn: day(200) }] };
const RING = '8900000000901';
const BANANA_1234G = '2000123012340';
const CARDAMOM_500G = '2000456005000';

const CAT: CatalogueSnapshot = {
  tenantId: 't-bill', version: 3, builtAt: NOW,
  products: [
    { productId: 'P-RING', sku: 'RING-22K', name: 'Gold ring 22K', baseUom: 'ea', unitPriceMinor: 45_000_00, taxBps: 300, status: 'active', regulatedFlags: { gold: true, huid: 'AB12CD' } },
    { productId: 'P-BAN', sku: '000123', name: 'Banana (loose)', baseUom: 'kg', unitPriceMinor: 80_00, taxBps: 0, status: 'active' },
    { productId: 'P-CARD', sku: '000456', name: 'Cardamom (loose)', baseUom: 'g', unitPriceMinor: 4_00, taxBps: 500, status: 'active' },
  ],
  barcodes: [{ code: RING, productId: 'P-RING', kind: 'standard' }],
  embeddedRules: [{ prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' }],
};

const TEMPLATE: PosReceiptTemplate = {
  version: 4, header: ['SRE HYPER MARKET', 'GSTIN: 33ABCDE1234F1Z5'], footer: ['Thank you — please visit again'], language: 'en',
  paperFormat: 'thermal-58', publishedAt: NOW, generatedAt: NOW, receivedAt: NOW, ageHours: 0,
};

function till(receiptTemplate?: PosReceiptTemplate) {
  return bootPos({
    laneId: 'lane-1', cashierId: 'u-cashier', tradingDay: day(0), catalogue: CAT, laneScales: SCALES,
    ...(receiptTemplate === undefined ? {} : { receiptTemplate }),
    durable: async () => ({ committed: true, durable: true, detail: 'd', laneMessage: 'ok' }),
  });
}

describe('B13: the bill a sale prints goes through the receipt renderer', () => {
  it('a gold sale\'s bill prints "HUID: AB12CD" under its line; weighed lines in their unit; GST inside balances', async () => {
    const pos = till();
    pos.scanBarcode(RING);
    pos.scanBarcode(BANANA_1234G);
    pos.scanBarcode(CARDAMOM_500G);
    await pos.tenderCash('S-1', 'R-0001', NOW);
    const bill = pos.receiptLines();
    if (!bill.ok) throw new Error(bill.why);
    const text = bill.lines.join('\n');
    const at = bill.lines.findIndex((l) => l === 'Gold ring 22K');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(bill.lines[at + 2]).toBe('  HUID: AB12CD'); // the line, its price row, then its HUID
    expect(text).toMatch(/^Bill: R-0001/m);
    expect(text).toMatch(/^ {2}1\.234 kg x 80\.00 +98\.72$/m); // 1234 g at ₹80/kg
    expect(text).toMatch(/^ {2}500 g x 4\.00 +2000\.00$/m);
    expect(text).toMatch(/^TOTAL +47098\.72$/m); // the lines add to the total (prices include GST)
    expect(text).toMatch(/^Taxable value /m);
    expect(text).toMatch(/^cash +47098\.72$/m);
    expect(bill.paper).toBe('thermal-80'); // no template → the 80 mm default, no header or store name invented
    expect(text).not.toMatch(/SRE HYPER MARKET/);
  });

  it('the published template\'s header, footer, paper width and version are used', async () => {
    const pos = till(TEMPLATE);
    pos.scanBarcode(RING);
    await pos.tenderCash('S-2', 'R-0002', NOW);
    const bill = pos.receiptLines();
    if (!bill.ok) throw new Error(bill.why);
    expect(bill.paper).toBe('thermal-58');
    expect(bill.lines.every((l) => l.length <= 32)).toBe(true);
    expect(bill.lines[0]!.trim()).toBe('SRE HYPER MARKET');
    expect(bill.lines).toContain('  HUID: AB12CD');
    expect(bill.lines.at(-1)!.trim()).toBe('template v4');
  });

  it('no bill before a sale, an unknown paper format, or a bill that does not balance → said, never thrown', async () => {
    expect(till().receiptLines()).toEqual({ ok: false, why: 'no sale has been committed on this till yet' });
    const pos = till({ ...TEMPLATE, paperFormat: 'thermal-99' });
    pos.scanBarcode(RING);
    await pos.tenderCash('S-3', 'R-0003', NOW); // the sale is saved whatever the bill makes of it
    expect(pos.receiptLines()).toMatchObject({ ok: false, why: expect.stringContaining('thermal-99') });
    const wrong = billReceipt({
      number: 'R-9', saleId: 'S-9', tradingDay: day(0), committedAt: NOW, laneId: 'lane-1', cashierId: 'u', currency: 'INR',
      lines: [{ description: 'X', quantityMinor: 1, uom: 'ea', unitPriceMinor: 100, lineTotalMinor: 100 }],
      taxBands: [], netMinor: 100, taxMinor: 0, totalMinor: 90, tenders: [{ kind: 'cash', amountMinor: 90 }],
    });
    expect(wrong).toMatchObject({ ok: false, why: expect.stringMatching(/do not balance/) });
  });

  it('a failed commit leaves no bill — the last sale\'s bill is never shown for a sale that did not save', async () => {
    let fail = false;
    const pos = bootPos({
      laneId: 'lane-1', cashierId: 'u-cashier', tradingDay: day(0), catalogue: CAT, laneScales: SCALES,
      durable: async () => (fail ? { committed: false, detail: 'disk', laneMessage: 'not saved' } : { committed: true, durable: true as const, detail: 'd', laneMessage: 'ok' }),
    });
    pos.scanBarcode(RING);
    await pos.tenderCash('S-4', 'R-0004', NOW);
    expect(pos.receiptLines().ok).toBe(true);
    pos.newSale();
    pos.scanBarcode(BANANA_1234G);
    fail = true;
    await expect(pos.tenderCash('S-5', 'R-0005', NOW)).rejects.toThrow();
    expect(pos.receiptLines()).toMatchObject({ ok: false });
  });
});

describe('a receipt with prices that include GST', () => {
  it('balances on the total, prints the net as the taxable value; a GST-on-top receipt is unchanged', () => {
    const base = {
      number: 'R-1', saleId: 'S-1', tradingDay: '2026-10-19', committedAt: NOW, laneId: 'lane-1', cashierId: 'u', currency: 'INR' as const,
      lines: [{ description: 'Ghee', quantityMinor: 1, uom: 'ea', unitPriceMinor: 105_00, lineTotalMinor: 105_00 }],
      taxBands: [{ rateBps: 500, netMinor: 100_00, taxMinor: 5_00 }], netMinor: 100_00, taxMinor: 5_00, totalMinor: 105_00,
      tenders: [{ kind: 'cash', amountMinor: 105_00 }], header: [], footer: [],
    };
    expect(() => buildReceipt(base)).toThrow(ReceiptTotalsError); // GST on top: the lines must add to the net
    const lines = renderReceipt(buildReceipt({ ...base, pricesIncludeTax: true }));
    expect(lines).toContain(`Taxable value${' '.repeat(48 - 13 - 6)}100.00`);
    expect(() => buildReceipt({ ...base, pricesIncludeTax: true, totalMinor: 104_00, netMinor: 99_00 })).toThrow(ReceiptTotalsError);
  });
});

describe('a quantity reads in its unit (look only)', () => {
  it('kg and L by the thousandth, g and ml as counted, ea bare; any spelling; an unknown unit raw', () => {
    expect(quantityLabel(1234, 'kg')).toBe('1.234 kg');
    expect(quantityLabel(500, 'kg')).toBe('0.500 kg');
    expect(quantityLabel(500, 'g')).toBe('500 g');
    expect(quantityLabel(1500, 'L')).toBe('1.500 L');
    expect(quantityLabel(1500, 'ltr')).toBe('1.500 L');
    expect(quantityLabel(250, 'ml')).toBe('250 ml');
    expect(quantityLabel(3, 'ea')).toBe('3');
    expect(quantityLabel(3, 'each')).toBe('3');
    expect(quantityLabel(2, 'case')).toBe('2 case');
  });

  it('the till\'s basket line carries the worded quantity beside the untouched integer', () => {
    const pos = till();
    pos.scanBarcode(BANANA_1234G);
    pos.scanBarcode(CARDAMOM_500G);
    pos.scanBarcode(RING);
    expect(pos.basket().map((l) => [l.qty, l.uom, l.qtyText])).toEqual([[1234, 'kg', '1.234 kg'], [500, 'g', '500 g'], [1, 'ea', '1']]);
    expect(pos.payableMinor()).toBe(98_72 + 2000_00 + 45_000_00);
  });
});
