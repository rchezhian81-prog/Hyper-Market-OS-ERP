import { describe, it, expect } from 'vitest';
import { bootPos } from '../../apps/pos/src/browser-entry';
import {
  AgeCheckNotDoneError, AgeCheckRequiredError, NoOperatorError, PosSession, taxRateFromPercent, type BasketEntry,
} from '../../apps/pos/src/session';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { money } from '../../packages/contracts/src/money';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

/**
 * **The age answer lives in the basket and is enforced at commit (M12-FR-04 · Wave 2b · audit PF-03, CRITICAL).**
 *
 * The audit booted the REAL till (`bootPos`) with a product flagged 18+: the scan said `requiresAgeCheck: true`, the
 * served scan handler threw that answer away, nothing at the commit looked, and the sale went through with no question
 * asked. These cases invert that reproduction on the same boot path:
 *
 *   • a restricted item does not join the bill until a confirmed answer for at least its age is in the basket;
 *   • the answer is given by the SIGNED-IN person — nobody signed in, no answer;
 *   • an answer for 18 does not cover a 21+ item; a refusal adds nothing and is kept as evidence;
 *   • the commit checks every restricted line AGAIN before the disk — a line that reached the bill any other way is refused;
 *   • the record carries, per restricted line, what age it needed and who confirmed it when, plus every answer;
 *   • a quantity change keeps the answer (same customer); hold and recall keep it; a new basket starts with none.
 */

const AT = '2026-10-05T11:00:00.000Z';
const CATALOGUE: CatalogueSnapshot = {
  tenantId: 't1', version: 4, builtAt: '2026-10-05T06:00:00Z',
  products: [
    { productId: 'p-rice', sku: 'RICE', name: 'Rice 1kg', baseUom: 'ea', unitPriceMinor: 100_00, taxBps: 500, status: 'active' },
    { productId: 'p-cig', sku: 'CIG', name: 'Cigarettes 10s', baseUom: 'ea', unitPriceMinor: 180_00, taxBps: 2800, status: 'active', regulatedFlags: { minimumAge: 18 } },
    { productId: 'p-beer', sku: 'BEER', name: 'Beer 650ml', baseUom: 'ea', unitPriceMinor: 220_00, taxBps: 2800, status: 'active', regulatedFlags: { minimumAge: 21 } },
  ],
  barcodes: [
    { code: '8900000000011', productId: 'p-rice', kind: 'standard' },
    { code: '8900000000028', productId: 'p-cig', kind: 'standard' },
    { code: '8900000000035', productId: 'p-beer', kind: 'standard' },
  ],
};
const RICE = '8900000000011';
const CIG = '8900000000028';
const BEER = '8900000000035';

function lane(signedIn: string | null = 'u-meena') {
  const written: Record<string, unknown>[] = [];
  const durable = async (_id: string, record: string) => {
    written.push(JSON.parse(record) as Record<string, unknown>);
    return { committed: true as const, durable: true as const, detail: 'test', laneMessage: 'saved' };
  };
  const view = bootPos({ laneId: 'lane-3', tradingDay: '2026-10-05', catalogue: CATALOGUE, durable });
  if (signedIn !== null) view.signIn(signedIn);
  return { view, written };
}
type Line = { productId: string; quantityMinor: number; ageCheck?: Record<string, unknown> };
const linesOf = (record: Record<string, unknown> | undefined): Line[] => (record?.['lines'] ?? []) as Line[];

describe('the audit reproduction, inverted on the real boot path', () => {
  it('an 18+ item scanned with no answer is NOT on the bill, and there is nothing to take payment for', async () => {
    const { view, written } = lane();
    expect(() => view.scanBarcode(CIG)).toThrow(AgeCheckRequiredError);
    expect(() => view.scanBarcode(CIG)).toThrow(expect.objectContaining({ minimumAge: 18, productId: 'p-cig', laneMessage: expect.stringContaining('18 or over') }));
    expect(view.basket()).toHaveLength(0);
    await expect(view.tenderCash('S-1', 'R-1', AT)).rejects.toThrow(); // an empty basket is not a sale
    expect(written).toHaveLength(0);
  });

  it('the line added by product id asks too — no way onto the bill skips the question', () => {
    const { view } = lane();
    expect(() => view.scan({ productId: 'p-cig', description: 'Cigarettes 10s', unitPriceMinor: 180_00, qty: 1 })).toThrow(AgeCheckRequiredError);
    expect(view.basket()).toHaveLength(0);
  });
});

describe('the answer is the signed-in person\'s, kept in the basket, and covers what it says', () => {
  it('nobody signed in: the answer itself is refused, in the cashier\'s words', () => {
    const { view } = lane(null);
    expect(() => view.confirmAge(18, AT, 'p-cig')).toThrow(NoOperatorError);
    expect(view.ageConfirmedAtLeast()).toBe(0);
  });

  it('a confirmed 18+ lets the item on; the sale record names who checked, when, and for what age', async () => {
    const { view, written } = lane();
    view.scanBarcode(RICE); // an unrestricted item is never asked about
    const answer = view.confirmAge(18, AT, 'p-cig');
    expect(answer).toMatchObject({ minimumAge: 18, outcome: 'confirmed', by: 'u-meena', at: AT, productId: 'p-cig' });
    expect(view.scanBarcode(CIG)).toMatchObject({ requiresAgeCheck: true, minimumAge: 18 });
    expect(await view.tenderCash('S-1', 'R-1', AT)).toBe('R-1');
    const [rice, cig] = linesOf(written[0]);
    expect(rice?.ageCheck).toBeUndefined();
    expect(cig?.ageCheck).toEqual({ minimumAge: 18, confirmedAtLeast: 18, confirmedBy: 'u-meena', confirmedAt: AT });
    expect(written[0]?.['ageAnswers']).toEqual([{ minimumAge: 18, outcome: 'confirmed', by: 'u-meena', at: AT, productId: 'p-cig' }]);
  });

  it('a customer confirmed 18+ is not thereby confirmed 21+ — the beer is asked separately; a 21+ answer covers both', () => {
    const { view } = lane();
    view.confirmAge(18, AT);
    view.scanBarcode(CIG);
    expect(() => view.scanBarcode(BEER)).toThrow(expect.objectContaining({ minimumAge: 21 }));
    view.confirmAge(21, AT, 'p-beer');
    view.scanBarcode(BEER);
    expect(view.ageConfirmedAtLeast()).toBe(21);
    expect(view.basket().map((l) => l.productId)).toEqual(['p-cig', 'p-beer']);
  });

  it('a refusal adds nothing — and is kept, so the bill that DID go through shows the customer was refused (M15 evidence)', async () => {
    const { view, written } = lane();
    expect(view.refuseAge(21, AT, 'p-beer')).toMatchObject({ outcome: 'refused', by: 'u-meena' });
    expect(() => view.scanBarcode(BEER)).toThrow(AgeCheckRequiredError); // a refusal is not a yes
    view.scanBarcode(RICE);
    await view.tenderCash('S-2', 'R-2', AT);
    expect(linesOf(written[0]).map((l) => l.productId)).toEqual(['p-rice']);
    expect(written[0]?.['ageAnswers']).toEqual([{ minimumAge: 21, outcome: 'refused', by: 'u-meena', at: AT, productId: 'p-beer' }]);
  });

  it('a quantity change keeps the answer (the same customer); hold and recall keep it; a NEW basket is a new customer', async () => {
    const { view, written } = lane();
    view.confirmAge(18, AT);
    const line = view.scanBarcode(CIG);
    view.setQuantity(line.lineId, 3);
    view.suspend();
    view.recall();
    expect(view.ageConfirmedAtLeast()).toBe(18);
    await view.tenderCash('S-3', 'R-3', AT);
    expect(linesOf(written[0])[0]).toMatchObject({ productId: 'p-cig', quantityMinor: 3, ageCheck: { confirmedBy: 'u-meena' } });
    view.newSale();
    expect(view.ageConfirmedAtLeast()).toBe(0);
    expect(() => view.scanBarcode(CIG)).toThrow(AgeCheckRequiredError);
  });
});

describe('the commit checks again, before the disk', () => {
  /** A restricted line that reached the bill some OTHER way — the new door the second gate exists for. */
  function sessionWithAnUncheckedLine() {
    const written: string[] = [];
    const session = new PosSession(
      { laneId: 'lane-3', cashierId: 'u-meena', tradingDay: '2026-10-05', currency: 'INR', defaultTaxRate: taxRateFromPercent(5) },
      new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
      async (_id, record) => { written.push(record); return { committed: true, durable: true, detail: 'test', laneMessage: 'saved' }; },
    );
    const smuggled: BasketEntry = {
      lineId: 'L99', productId: 'p-beer', description: 'Beer 650ml', unitPrice: money(220_00, 'INR'),
      quantityMinor: 1, uom: 'ea', taxRate: taxRateFromPercent(28), minimumAge: 21, voided: false,
    };
    (session as unknown as { lines: BasketEntry[] }).lines.push(smuggled);
    return { session, written };
  }

  it('an unanswered restricted line is refused at commit, with nothing written and words for the cashier', async () => {
    const { session, written } = sessionWithAnUncheckedLine();
    const tenders = [{ kind: 'cash' as const, amount: money(220_00, 'INR'), status: 'settled' as const }];
    await expect(session.commit('S-9', 'R-9', AT, tenders)).rejects.toBeInstanceOf(AgeCheckNotDoneError);
    await expect(session.commit('S-9', 'R-9', AT, tenders)).rejects.toMatchObject({
      laneMessage: expect.stringContaining('Do not take payment'),
      unchecked: [{ productId: 'p-beer', description: 'Beer 650ml', minimumAge: 21 }],
    });
    expect(written).toHaveLength(0);
    // An answer for a LOWER age still does not cover it.
    session.confirmAge(18, AT);
    await expect(session.commit('S-9', 'R-9', AT, tenders)).rejects.toBeInstanceOf(AgeCheckNotDoneError);
    // The right answer does — and the record carries it.
    session.confirmAge(21, AT);
    await session.commit('S-9', 'R-9', AT, tenders);
    expect(JSON.parse(written[0]!).lines[0].ageCheck).toEqual({ minimumAge: 21, confirmedAtLeast: 21, confirmedBy: 'u-meena', confirmedAt: AT });
  });

  it('a voided restricted line does not block the sale — it is not being sold', async () => {
    const { session, written } = sessionWithAnUncheckedLine();
    session.voidLine('L99', 'customer changed their mind');
    session.scan({ productId: 'p-rice', description: 'Rice 1kg', unitPrice: money(100_00, 'INR'), quantityMinor: 1, uom: 'ea' });
    await session.commit('S-10', 'R-10', AT, [{ kind: 'cash', amount: money(100_00, 'INR'), status: 'settled' }]);
    expect(written).toHaveLength(1);
  });

  it('a malformed age is not an answer', () => {
    const { session } = sessionWithAnUncheckedLine();
    expect(() => session.confirmAge(0, AT)).toThrow(RangeError);
    expect(() => session.confirmAge(17.5, AT)).toThrow(RangeError);
  });
});
