import { describe, it, expect } from 'vitest';
import { PosSession, PackDateCheckRequiredError, PackDateCheckNotDoneError, NoOperatorError } from '../../apps/pos/src/session';
import { money } from '../../packages/contracts/src/money';
import { rate } from '../../packages/contracts/src/rate';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { acceptSale, type IncomingSale, type IntakeContext } from '../../services/pos/src/index';
import type { CatalogueProduct } from '../../packages/catalogue/src/catalogue';

/**
 * **B8 · OB-298 (owner, 23 Oct 2026): "for flagged perishables, the cashier confirms the printed date on the pack with one
 * tap before the line is added." A plain barcode carries no batch, so the till cannot know the date — a person looks.**
 * The confirmation is ONE tap for ONE line, in the signed-in cashier's name, kept on the line; "out of date" is kept as
 * evidence and the item is not sold; a barcode that carried its own date needs no tap; the commit checks every perishable
 * line again; head office flags one that arrives unchecked.
 */

const AT = '2026-10-23T09:00:00.000Z';
const MILK = { productId: 'p-milk', description: 'Milk 500ml', unitPrice: money(3_000, 'INR'), quantityMinor: 1, uom: 'ea' as const, regulatedFlags: { perishable: true } };
const cash = (minor: number) => [{ kind: 'cash' as const, amount: money(minor, 'INR'), status: 'settled' as const }];

const tillWith = (cashierId: string | null = 'u-meena') => {
  const written: Record<string, unknown>[] = [];
  const s = new PosSession(
    { laneId: 'lane-1', ...(cashierId === null ? {} : { cashierId }), currency: 'INR', defaultTaxRate: rate(500), clock: () => AT, regulatedFlagsOf: (id) => (id === 'p-milk' ? { perishable: true } : undefined) },
    new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
    async (_id, record) => { written.push(JSON.parse(record) as Record<string, unknown>); return { committed: true } as never; },
  );
  return { s, written };
};

describe('B8 — the till asks for the date on the pack, one tap per line', () => {
  it('a perishable with a plain barcode is NOT added until the date is confirmed; then the line carries who and when', () => {
    const { s } = tillWith();
    expect(() => s.scan(MILK)).toThrow(PackDateCheckRequiredError);
    try { s.scan(MILK); } catch (e) { expect((e as PackDateCheckRequiredError).laneMessage).toMatch(/Look at the date printed on the pack/); }
    expect(s.basket()).toHaveLength(0);
    s.confirmPackDate('p-milk', AT);
    const line = s.scan(MILK);
    expect(line.packDateCheck).toEqual({ confirmedBy: 'u-meena', confirmedAt: AT });
    // One tap is one line: the next pack is looked at too.
    expect(() => s.scan(MILK)).toThrow(PackDateCheckRequiredError);
  });

  it('"out of date" adds nothing and is kept as evidence on the bill; a non-perishable is never asked', async () => {
    const { s, written } = tillWith();
    s.refusePackDate('p-milk', AT);
    expect(() => s.scan(MILK)).toThrow(PackDateCheckRequiredError);
    s.scan({ ...MILK, productId: 'p-rice', description: 'Rice 1kg', regulatedFlags: {} });
    await s.commit('S-1', 'N-1', AT, cash(3_000));
    expect(written[0]?.['packDateAnswers']).toEqual([{ productId: 'p-milk', outcome: 'out_of_date', by: 'u-meena', at: AT }]);
  });

  it('a barcode that CARRIED its date (a GS1 code) was judged by the catalogue: no tap', () => {
    const { s } = tillWith();
    const line = s.scan({ ...MILK, batchId: 'LOT-9', batchExpiry: '2026-10-30' });
    expect(line.packDateCheck).toBeUndefined();
  });

  it('nobody signed in: the answer is refused — an answer in nobody\'s name is no answer', () => {
    const { s } = tillWith(null);
    expect(() => s.confirmPackDate('p-milk', AT)).toThrow(NoOperatorError);
  });

  it('the sale record carries the check on the line; a held basket recalled without one is refused at payment, before the disk', async () => {
    const { s, written } = tillWith();
    s.confirmPackDate('p-milk', AT);
    s.scan(MILK);
    await s.commit('S-2', 'N-2', AT, cash(3_000));
    expect((written[0]?.['lines'] as Record<string, unknown>[])[0]?.['packDateCheck']).toEqual({ confirmedBy: 'u-meena', confirmedAt: AT });

    const next = tillWith();
    next.s.restoreHeld([{ lineId: 'L1', productId: 'p-milk', description: 'Milk 500ml', unitPriceMinor: 3_000, quantityMinor: 1, uom: 'ea', taxBps: 500, voided: false }]);
    await expect(next.s.commit('S-3', 'N-3', AT, cash(3_000))).rejects.toBeInstanceOf(PackDateCheckNotDoneError);
    expect(next.written).toHaveLength(0);
    // Held WITH its check, it comes back with it and sells.
    const kept = tillWith();
    kept.s.restoreHeld([{ lineId: 'L1', productId: 'p-milk', description: 'Milk 500ml', unitPriceMinor: 3_000, quantityMinor: 1, uom: 'ea', taxBps: 500, voided: false, packDateCheck: { confirmedBy: 'u-meena', confirmedAt: AT } }]);
    await kept.s.commit('S-4', 'N-4', AT, cash(3_000));
    expect(kept.written).toHaveLength(1);
  });
});

describe('B8 — head office\'s backstop for an older till', () => {
  const product = (over: Partial<CatalogueProduct> = {}): CatalogueProduct => ({
    productId: 'p-milk', sku: 'MILK', name: 'Milk', baseUom: 'ea', unitPriceMinor: 3_000, taxBps: 500, mrpMinor: 3_000, status: 'active', regulatedFlags: { perishable: true }, ...over,
  });
  const ctx = (): IntakeContext => ({ catalogue: new Map([['p-milk', product()]]), currentPackVersion: 1, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: AT });
  const sale = (line: Record<string, unknown>): IncomingSale => ({
    saleId: 'S1', receiptNumber: 'R1', laneId: 'l1', cashierId: 'u', tradingDay: '2026-10-23', committedAt: AT, totalMinor: 3_000, currency: 'INR', packVersion: 1,
    lines: [{ productId: 'p-milk', quantityMinor: 1, uom: 'ea', unitPriceMinor: 3_000, lineTotalMinor: 3_000, ...line }], tenders: [{ kind: 'cash', amountMinor: 3_000 }],
  });
  const kinds = (s: IncomingSale): string[] => acceptSale(s, ctx()).exceptions.map((e) => e.kind);
  it('unchecked → a material finding; checked, or dated by its barcode → none', () => {
    expect(kinds(sale({}))).toContain('perishable_sold_without_date_check');
    expect(kinds(sale({ packDateCheck: { confirmedBy: 'u-meena', confirmedAt: AT } }))).not.toContain('perishable_sold_without_date_check');
    expect(kinds(sale({ batchId: 'L', batchExpiry: '2026-10-30' }))).not.toContain('perishable_sold_without_date_check');
  });
});
