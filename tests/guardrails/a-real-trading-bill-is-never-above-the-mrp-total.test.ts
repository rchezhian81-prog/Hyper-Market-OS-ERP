import { describe, it, expect } from 'vitest';
import { buildTaxInvoice, invoiceRoundOff, taxInvoiceRows, invoiceRenderProblems, type TaxInvoiceInput } from '../../packages/receipt/src/tax-invoice';
import { roundToNearestRupeeMinor } from '../../packages/finance/src/inclusive-tax';
import { bootPos } from '../../apps/pos/src/browser-entry';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { realTradingSaleRefusal } from '../../edge/store-edge/src/real-trading';
import { toCloudSale } from '../../edge/store-edge/src/cloud-sale';
import { buildDayBook } from '../../packages/finance/src/day-book';

/**
 * **OB-285 · roadmap B1 · Legal Metrology — no real-trading bill is EVER above the exact MRP total of its lines.** OB-279
 * rounds the bill's CGST and SGST each to the nearest rupee; when that would put the bill above what the lines were charged
 * (to the paisa, what the till charges off real trading), the round off goes down instead, so the customer never pays more.
 *
 * Like every guardrail this asserts two things: (1) across thousands of baskets — every single price from 1 paisa to ₹200
 * at every GST rate, random baskets, and real sessions on the till — the payable is never above the lines; and (2) the
 * detector FIRES on a known-bad sample: the plain nearest-rupee rule (OB-279 alone) is caught charging ₹106 for ₹105 of
 * dal, and the store computer, the cloud copy and the day book each refuse a bill above its lines. Synthetic data only.
 */

const RATES = [0, 500, 1_200, 1_800, 2_800, 300, 4_000] as const;
const SHOP = { legalName: 'SRE Hyper Market Private Limited', gstin: '33ABCDE1234F1Z5', placeOfBusiness: ['12 Main Road', 'Tiruppur 641601'] };
const NOW = '2026-10-21T05:00:00.000Z';

/** A small seeded generator — the same baskets on every run, so a failure can be replayed. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** THE DETECTOR: what a bill is above the exact total of its lines, in paise (0 when it is not above). */
function aboveMrpBy(totalMinor: number, lines: readonly { readonly lineTotalMinor: number }[]): number {
  return Math.max(0, totalMinor - lines.reduce((s, l) => s + l.lineTotalMinor, 0));
}

/** The known-bad rule — OB-279 alone: the rounded CGST + rounded SGST + the values, with nothing to hold it to the MRP. */
function nearestRupeeOnlyTotal(lines: readonly { readonly lineTotalMinor: number; readonly taxRateBps: number }[]): number {
  const r = invoiceRoundOff(lines);
  const goods = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
  return goods - r.cgstExactMinor - r.sgstExactMinor + roundToNearestRupeeMinor(r.cgstExactMinor) + roundToNearestRupeeMinor(r.sgstExactMinor);
}

const invoiceLine = (lineTotalMinor: number, taxRateBps: number, i = 0): TaxInvoiceInput['lines'][number] => ({
  description: `Item ${i + 1}`, hsnCode: '190531', quantityMinor: 1, uom: 'ea', unitPriceMinor: lineTotalMinor, lineTotalMinor, taxRateBps,
});

describe('OB-285 guardrail — the detector fires on a known-bad sample', () => {
  it('the nearest-rupee rule alone charges ₹106 for ₹105 of dal — the detector catches it', () => {
    const dal = [{ lineTotalMinor: 10_500, taxRateBps: 500 }];
    expect(nearestRupeeOnlyTotal(dal)).toBe(10_600);
    expect(aboveMrpBy(nearestRupeeOnlyTotal(dal), dal)).toBe(100);
    expect(aboveMrpBy(10_500, dal)).toBe(0);
  });

  it('and over the same single prices the shipped rule is checked on below, the bad rule is above the MRP thousands of times', () => {
    let above = 0;
    for (let p = 1; p <= 20_000; p++) for (const r of RATES) if (aboveMrpBy(nearestRupeeOnlyTotal([{ lineTotalMinor: p, taxRateBps: r }]), [{ lineTotalMinor: p }]) > 0) above++;
    expect(above).toBeGreaterThan(1_000);
  });

  it('a bill above its lines is refused by the store computer, left out of the cloud copy\'s round off, and refused by the day book', () => {
    const record = {
      id: 'S-G1', number: 'L1-0901', committedAt: NOW, laneId: 'lane-1', cashierId: 'u-cashier', tradingDay: '2026-10-21',
      lines: [{ productId: 'P-DAL', quantityMinor: 1, uom: 'ea', unitPriceMinor: 10_500, lineTotalMinor: 10_500, taxRateBps: 500, hsnCode: '071360' }],
      tenders: [{ kind: 'cash', amount: { minor: 10_600, currency: 'INR' }, status: 'settled' }],
      total: 10_600, netMinor: 10_000, taxMinor: 500, roundOffMinor: 100, currency: 'INR',
    };
    expect(realTradingSaleRefusal(record, SHOP)).toMatchObject({ refusedBecause: 'tax_invoice_incomplete' });
    expect(toCloudSale(record, 1)).not.toHaveProperty('roundOffMinor');
    const book = buildDayBook({
      tradingDay: '2026-10-21', returns: [], originalSales: new Map(), taxRateOf: () => undefined, alreadyPosted: new Map(),
      sales: [{ saleId: 'S-G1', tradingDay: '2026-10-21', totalMinor: 10_600, lines: [{ productId: 'P-DAL', quantityMinor: 1, lineTotalMinor: 10_500, taxRateBps: 500 }], tenders: [{ kind: 'cash', amountMinor: 10_600 }], roundOffMinor: 100 }],
    });
    expect(book.exceptions.map((e) => e.reason)).toEqual(['lines_do_not_sum_to_total']);
  });
});

describe('OB-285 guardrail — no real-trading payable is ever above the exact MRP total', () => {
  it('every single price from 1 paisa to ₹200, at every rate: the rounding never takes the bill above its line', () => {
    for (let p = 1; p <= 20_000; p++) {
      for (const r of RATES) {
        const o = invoiceRoundOff([{ lineTotalMinor: p, taxRateBps: r }]);
        if (o.totalLessGoodsMinor > 0 || o.roundOffMinor > 0 || o.roundOffMinor < -100 || o.totalLessGoodsMinor < -100) {
          throw new Error(`₹${p / 100} at ${r} bps: ${JSON.stringify(o)}`);
        }
      }
    }
  });

  it('3,000 random baskets of 1 to 12 lines: the invoice total is never above the lines, and its paper adds up', () => {
    const rnd = seeded(285);
    for (let n = 0; n < 3_000; n++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 12) }, (_, i) => invoiceLine(1 + Math.floor(rnd() * 400_000), RATES[Math.floor(rnd() * RATES.length)]!, i));
      const built = buildTaxInvoice({ identity: SHOP, number: `G-${n}`, committedAt: NOW, laneId: 'lane-1', cashierId: 'u-cashier', lines });
      if (!built.ok) {
        // Only the ₹50,000 rule (OB-280) may refuse one of these — and then nothing is charged at all.
        expect(built.problems.map((p) => p.code)).toEqual(['recipient_details']);
        continue;
      }
      const d = built.doc;
      expect(aboveMrpBy(d.totalMinor, lines)).toBe(0);
      expect(d.taxableMinor + d.untaxedMinor + d.cgstMinor + d.sgstMinor + d.roundOffMinor).toBe(d.totalMinor);
      expect(d.roundOffMinor).toBeLessThanOrEqual(0);
      expect(invoiceRenderProblems(taxInvoiceRows(d), d)).toEqual([]);
    }
  });

  it('300 real sessions on the till in real trading: what the customer is asked for, and what is saved, is never above the lines', async () => {
    const rnd = seeded(2_850);
    const products = Array.from({ length: 40 }, (_, i) => ({
      productId: `P-${i}`, sku: `SKU-${i}`, name: `Item ${i}`, baseUom: 'ea', unitPriceMinor: 1 + Math.floor(rnd() * 50_000),
      taxBps: RATES[Math.floor(rnd() * 5)]!, status: 'active' as const, hsnCode: '190531',
    }));
    const catalogue: CatalogueSnapshot = {
      tenantId: 't-guard', version: 1, builtAt: NOW, products,
      barcodes: products.map((p, i) => ({ code: `8900000${String(i).padStart(5, '0')}`, productId: p.productId, kind: 'standard' as const })),
    };
    let rounded = 0;
    for (let n = 0; n < 300; n++) {
      const writes: string[] = [];
      const pos = bootPos({
        laneId: 'lane-1', cashierId: 'u-cashier', tradingDay: NOW.slice(0, 10), catalogue, taxPercent: 5, realTrading: true, taxInvoice: SHOP,
        durable: async (_id, record) => { writes.push(record); return { committed: true, durable: true, detail: 'd', laneMessage: 'ok' }; },
      });
      const picks = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => Math.floor(rnd() * products.length));
      for (const i of picks) pos.scanBarcode(catalogue.barcodes[i]!.code);
      const mrpTotal = picks.reduce((s, i) => s + products[i]!.unitPriceMinor, 0);
      expect(pos.payableMinor()).toBeLessThanOrEqual(mrpTotal);
      await pos.tenderCash(`S-G${n}`, `L1-G${n}`, NOW);
      const record = JSON.parse(writes[0]!) as { total: number; lines: { lineTotalMinor: number }[]; roundOffMinor?: number };
      expect(aboveMrpBy(record.total, record.lines)).toBe(0);
      expect(record.lines.reduce((s, l) => s + l.lineTotalMinor, 0)).toBe(mrpTotal);
      if ((record.roundOffMinor ?? 0) !== 0) rounded++;
      const inv = pos.taxInvoice();
      if (!inv.ok) throw new Error(inv.why);
    }
    // The baskets do exercise the rounding (a round off below the lines on some of them), not only exact totals.
    expect(rounded).toBeGreaterThan(0);
  });
});
