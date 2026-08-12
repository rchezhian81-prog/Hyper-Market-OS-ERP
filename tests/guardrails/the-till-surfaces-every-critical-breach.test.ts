import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { acceptSale, type IncomingSale, type IntakeContext } from '../../services/pos/src/index';
import type { CatalogueProduct } from '../../packages/catalogue/src/catalogue';

/**
 * **The till surfaces every critical breach, and never quietly downgrades one.**
 *
 * Three things a sale can do are not variances to reconcile at leisure — they are breaches that put a
 * customer at risk or the shop in front of a regulator, and each was added in its own increment:
 *
 *   1. **a recalled product sold** — it is in a customer's hands (M10-FR-04);
 *   2. **a charge above MRP** — a legal ceiling in India, a prosecution risk (B1 / M03·M12);
 *   3. **an expired batch sold** — past-use-by food, an FSSAI breach (B8 / M10·M12).
 *
 * Each is banked (the money is in the drawer, hard rule #1) but must be surfaced **critical** and ranked
 * **ahead of** any money-variance finding, because a customer outranks a number. This guardrail locks that
 * in behaviourally: three independent unit tests could each be weakened one at a time and nobody would
 * notice the *contract* eroding. Here the contract is one assertion — and a tripwire proves it bites.
 */

const product = (id: string, over: Partial<CatalogueProduct> = {}): CatalogueProduct => ({
  productId: id, sku: `SKU-${id}`, name: id, baseUom: 'each',
  unitPriceMinor: 5_000, taxBps: 0, mrpMinor: 9_000, status: 'active', ...over,
});
const CATALOGUE = new Map<string, CatalogueProduct>([
  ['RECALLED', product('RECALLED', { recallBlock: true })],
  ['NORMAL', product('NORMAL')],
]);
const AT = '2026-08-07';
const ctx = (): IntakeContext => ({
  catalogue: CATALOGUE, currentPackVersion: 10, saleHoldingThisReceipt: undefined,
  alreadyBanked: false, now: `${AT}T12:00:00Z`,
});
const sale = (over: Partial<IncomingSale>): IncomingSale => ({
  saleId: 'S1', receiptNumber: 'R1', laneId: 'l1', cashierId: 'u', tradingDay: AT, committedAt: `${AT}T10:00:00Z`,
  totalMinor: 5_000, currency: 'INR', packVersion: 10,
  lines: [], tenders: [{ kind: 'cash', amountMinor: 5_000 }], ...over,
});
const line = (over: Record<string, unknown>) => ({ productId: 'NORMAL', quantityMinor: 1, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 5_000, ...over });

// The three breaches, each as a one-line sale.
const BREACHES: Readonly<Record<string, IncomingSale>> = {
  sold_a_recalled_product: sale({ lines: [line({ productId: 'RECALLED' })] }),
  sold_above_mrp: sale({ totalMinor: 9_500, lines: [line({ unitPriceMinor: 9_500, lineTotalMinor: 9_500 })], tenders: [{ kind: 'cash', amountMinor: 9_500 }] }),
  sold_expired_batch: sale({ lines: [line({ batchId: 'LOT-1', batchExpiry: '2026-08-01' })] }),
};

describe('the till surfaces every critical breach', () => {
  it('flags each of the three as CRITICAL, and banks the sale', () => {
    for (const [kind, s] of Object.entries(BREACHES)) {
      const r = acceptSale(s, ctx());
      expect(r.banked, `${kind} was not banked`).toBe(true);
      const found = r.exceptions.find((e) => e.kind === kind);
      expect(found, `${kind} was not raised`).toBeDefined();
      expect(found!.severity, `${kind} is not critical`).toBe('critical');
    }
  });

  it('ranks each breach FIRST, above a money variance on the same sale', () => {
    for (const [kind, s] of Object.entries(BREACHES)) {
      // Add a tender that is out by ₹1 — a material finding that must NOT outrank the breach.
      const withVariance: IncomingSale = { ...s, tenders: [{ kind: 'cash', amountMinor: s.totalMinor - 100 }] };
      const r = acceptSale(withVariance, ctx());
      expect(r.exceptions[0]?.kind, `a variance outranked ${kind}`).toBe(kind);
      expect(r.exceptions[0]?.severity).toBe('critical');
    }
  });

  it('TRIPWIRE — a clean sale raises none of the three (the guard is not passing vacuously)', () => {
    const r = acceptSale(sale({ lines: [line({ batchId: 'LOT-9', batchExpiry: '2026-12-31' })] }), ctx());
    const criticalKinds = r.exceptions.filter((e) => e.severity === 'critical').map((e) => e.kind);
    expect(criticalKinds).toEqual([]);
  });

  it('the three breach kinds are all declared critical in the source (a downgrade fails here)', () => {
    // A behavioural test can be deleted; this reads the module so a silent severity change is caught too.
    const src = readFileSync(new URL('../../services/pos/src/sale-intake.ts', import.meta.url).pathname, 'utf8');
    for (const kind of Object.keys(BREACHES)) {
      const call = new RegExp(`add\\(\\s*'${kind}'\\s*,\\s*'critical'`);
      expect(call.test(src), `${kind} is no longer added as 'critical' in sale-intake.ts`).toBe(true);
    }
  });
});
