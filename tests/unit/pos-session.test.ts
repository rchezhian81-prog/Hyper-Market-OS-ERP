import { describe, it, expect } from 'vitest';
import {
  PosSession,
  taxRateFromPercent,
  EmptyBasketError,
  VoidReasonRequiredError,
  NoSuchLineError,
  SessionStateError,
  LocalCommitRefusedError,
} from '../../apps/pos/src/index';
import { createPosView } from '../../apps/pos/src/view-adapter';
import type { CommitOutcome } from '../../edge/store-edge/src/durability';
import { money } from '../../packages/contracts/src/money';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import type { Tender } from '../../packages/tender/src/tender';
import type { Promotion } from '../../packages/promotions/src/promotions';

// The POS session is the Sale screen's model: scan → total → tender → commit, all
// LOCAL (hard rule #1), with voids kept visible and the sync badge honest.

const AT = '2026-08-02T12:00:00Z';

function newSession() {
  const ledger = new Ledger(new InMemoryLedgerStore());
  const outbox = new SyncOutbox();
  const session = new PosSession(
    {
      laneId: 'lane-1',
      cashierId: 'clerk-1',
      tradingDay: '2026-08-02',
      currency: 'INR',
      defaultTaxRate: taxRateFromPercent(18),
    },
    ledger,
    outbox,
      // A session with nowhere to write is a lane that must not take payment.
      () => Promise.resolve({
        committed: true as const, durable: true as const,
        detail: 'test double', laneMessage: 'Sale complete.',
      }),
    );
  session.setNow(AT);
  return { session, ledger, outbox };
}

function scanItem(session: PosSession, over: Partial<Parameters<PosSession['scan']>[0]> = {}) {
  return session.scan({
    productId: 'p1',
    description: 'Rice 1kg',
    unitPrice: money(100_00, 'INR'),
    quantityMinor: 1,
    uom: 'ea',
    ...over,
  });
}

const cash = (minor: number): Tender => ({
  kind: 'cash',
  amount: money(minor, 'INR'),
  status: 'settled',
});

describe('PosSession — the Sale screen', () => {
  it('scans an item and shows a running total with tax', () => {
    const { session } = newSession();
    scanItem(session);
    const totals = session.totals();
    expect(totals.lineCount).toBe(1);
    expect(totals.net).toEqual(money(100_00, 'INR'));
    expect(totals.tax).toEqual(money(18_00, 'INR')); // 18%
    expect(totals.payable).toEqual(money(118_00, 'INR'));
    expect(session.currentState()).toBe('selling');
  });

  it('changes a line quantity and reprices', () => {
    const { session } = newSession();
    const line = scanItem(session);
    session.setQuantity(line.lineId, 3);
    expect(session.totals().payable).toEqual(money(354_00, 'INR')); // 3 × 118
  });

  it('prices a weighed item exactly', () => {
    const { session } = newSession();
    // 1.234 kg at ₹80/kg = ₹98.72 net → +18% = ₹116.49 (half-up)
    scanItem(session, { unitPrice: money(80_00, 'INR'), quantityMinor: 1234, uom: 'kg' });
    const totals = session.totals();
    expect(totals.net).toEqual(money(98_72, 'INR'));
    expect(totals.payable).toEqual(money(116_49, 'INR'));
  });

  it('keeps a voided line visible with its reason and excludes it from the total', () => {
    const { session } = newSession();
    const a = scanItem(session);
    scanItem(session, { productId: 'p2', description: 'Dal 1kg' });
    session.voidLine(a.lineId, 'customer changed mind');

    const voided = session.basket().find((l) => l.lineId === a.lineId);
    expect(voided?.voided).toBe(true);
    expect(voided?.voidReason).toBe('customer changed mind');
    expect(session.basket()).toHaveLength(2); // never erased — visible to loss prevention
    expect(session.totals().lineCount).toBe(1);
    expect(session.totals().payable).toEqual(money(118_00, 'INR'));
  });

  it('requires a reason to void a line (M15)', () => {
    const { session } = newSession();
    const line = scanItem(session);
    expect(() => session.voidLine(line.lineId, '  ')).toThrow(VoidReasonRequiredError);
    expect(() => session.voidLine('nope', 'reason')).toThrow(NoSuchLineError);
  });

  it('applies a promotion to the payable amount', () => {
    const { session } = newSession();
    session.loadPromotions([
      {
        id: 'promo-10',
        kind: 'percent_off',
        startsAt: '2026-08-01T00:00:00Z',
        endsAt: '2026-08-31T23:59:59Z',
        status: 'active',
        productIds: ['p1'],
        percentBps: 1000,
      } as Promotion,
    ]);
    scanItem(session);
    const totals = session.totals();
    expect(totals.promotionDiscount).toEqual(money(10_00, 'INR')); // 10% of ₹100 unit price
    expect(totals.payable).toEqual(money(108_00, 'INR')); // 118 − 10
  });

  it('refuses to tender an empty basket', () => {
    const { session } = newSession();
    expect(() => session.goToTender()).toThrow(EmptyBasketError);
  });

  it('shows a pending card tender honestly — never as paid', () => {
    const { session } = newSession();
    scanItem(session);
    const settlement = session.previewSettlement([
      { kind: 'card', amount: money(118_00, 'INR'), status: 'pending' },
    ]);
    expect(settlement.fullyPaid).toBe(false);
    expect(settlement.pending).toEqual(money(118_00, 'INR'));
    expect(settlement.settled).toEqual(money(0, 'INR'));
  });

  it('commits a cash sale locally and queues it for sync — no network', async () => {
    const { session, ledger, outbox } = newSession();
    scanItem(session);
    session.goToTender();
    const sale = await session.commit('sale-1', 'S-0001', AT, [cash(118_00)]);

    expect(sale.total).toEqual(money(118_00, 'INR'));
    expect(session.currentState()).toBe('committed');
    expect(ledger.entries()).toHaveLength(1); // stock moved locally
    expect(outbox.unsentCount()).toBe(1); // queued for the cloud
  });

  it('stamps each sale line the cloud sees with its price and the FROZEN HSN + rate (A5)', async () => {
    // The record the edge posts to the cloud carries the rich lines: unit price, the tax-inclusive
    // line total, and the HSN + rate frozen at the moment of sale — read off the pack, a record only.
    let record = '';
    const ledger = new Ledger(new InMemoryLedgerStore());
    const session = new PosSession(
      { laneId: 'lane-1', cashierId: 'clerk-1', tradingDay: '2026-08-02', currency: 'INR', defaultTaxRate: taxRateFromPercent(18) },
      ledger, new SyncOutbox(),
      (_id, r) => { record = r; return Promise.resolve({ committed: true as const, durable: true as const, detail: 'ok', laneMessage: 'Sale complete.' }); },
    );
    session.setNow(AT);
    // ₹100 ex-tax at 18% → line total ₹118 (tax added); HSN frozen from the pack.
    session.scan({ productId: 'p1', description: 'Rice 1kg', unitPrice: money(100_00, 'INR'), quantityMinor: 1, uom: 'ea', taxRate: taxRateFromPercent(18), hsnCode: '1006' });
    await session.commit('sale-1', 'S-0001', AT, [cash(118_00)]);

    const line = (JSON.parse(record) as { lines: Array<Record<string, unknown>> }).lines[0]!;
    expect(line).toMatchObject({
      productId: 'p1', quantityMinor: 1, uom: 'ea',
      unitPriceMinor: 100_00,   // ex-tax unit price (for the MRP / price-difference checks)
      lineTotalMinor: 118_00,   // tax-inclusive line total (sums to the sale total; GST pulled from it)
      taxRateBps: 1800,         // the rate frozen at supply
      hsnCode: '1006',          // the HSN frozen at supply
    });
  });

  it('subtracts a targeted promotion from its OWN line, so the record lines sum to what was paid (A5)', async () => {
    let record = '';
    const session = new PosSession(
      { laneId: 'lane-1', cashierId: 'clerk-1', tradingDay: '2026-08-02', currency: 'INR', defaultTaxRate: taxRateFromPercent(18) },
      new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
      (_id, r) => { record = r; return Promise.resolve({ committed: true as const, durable: true as const, detail: 'ok', laneMessage: 'Sale complete.' }); },
    );
    session.setNow(AT);
    // 10% off p1 only. p1 ₹100 @18% → line ₹118; p2 ₹200 @18% → line ₹236. Promo = ₹10 off p1's gross.
    session.loadPromotions([
      { id: 'p1-10', kind: 'percent_off', startsAt: '2026-08-01T00:00:00Z', endsAt: '2026-08-31T23:59:59Z', status: 'active', productIds: ['p1'], percentBps: 1000 } as Promotion,
    ]);
    session.scan({ productId: 'p1', description: 'A', unitPrice: money(100_00, 'INR'), quantityMinor: 1, uom: 'ea', taxRate: taxRateFromPercent(18), hsnCode: '1001' });
    session.scan({ productId: 'p2', description: 'B', unitPrice: money(200_00, 'INR'), quantityMinor: 1, uom: 'ea', taxRate: taxRateFromPercent(18), hsnCode: '1002' });
    const payable = session.totals().payable.minor; // (118 + 236) − 10 = 344_00
    await session.commit('sale-1', 'S-0001', AT, [cash(payable)]);

    const parsed = JSON.parse(record) as { total: number; lines: Array<{ productId: string; lineTotalMinor: number }> };
    const byProduct = Object.fromEntries(parsed.lines.map((l) => [l.productId, l.lineTotalMinor]));
    expect(byProduct['p1']).toBe(108_00); // ₹118 − ₹10 (the promo came off p1)
    expect(byProduct['p2']).toBe(236_00); // p2 untouched
    // The line totals sum to exactly what the customer paid — no line-sum exception on the cloud.
    expect(parsed.lines.reduce((s, l) => s + l.lineTotalMinor, 0)).toBe(payable);
    expect(parsed.total).toBe(payable);
  });

  it('omits the HSN on a line whose pack carried none — the return falls back, never guesses', async () => {
    let record = '';
    const session = new PosSession(
      { laneId: 'lane-1', cashierId: 'clerk-1', tradingDay: '2026-08-02', currency: 'INR', defaultTaxRate: taxRateFromPercent(18) },
      new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
      (_id, r) => { record = r; return Promise.resolve({ committed: true as const, durable: true as const, detail: 'ok', laneMessage: 'Sale complete.' }); },
    );
    session.setNow(AT);
    session.scan({ productId: 'p1', description: 'Rice 1kg', unitPrice: money(100_00, 'INR'), quantityMinor: 1, uom: 'ea', taxRate: taxRateFromPercent(18) }); // no hsnCode
    await session.commit('sale-1', 'S-0001', AT, [cash(118_00)]);

    const line = (JSON.parse(record) as { lines: Array<Record<string, unknown>> }).lines[0]!;
    expect(line['taxRateBps']).toBe(1800);       // the rate is still frozen
    expect('hsnCode' in line).toBe(false);        // but no HSN was carried — surfaces on the return, not guessed
  });

  it('keeps billing with the cable out and shows the unsent count', async () => {
    const { session, outbox } = newSession();
    session.setConnection('offline');
    scanItem(session);
    await session.commit('sale-1', 'S-0001', AT, [cash(118_00)]);

    const badge = session.syncBadge();
    expect(badge.connection).toBe('offline');
    expect(badge.unsentCount).toBe(1); // lag is visible (P-08)
    expect(outbox.pending()[0]?.event.type).toBe('SaleCommitted');
  });

  it('suspends and recalls a basket', async () => {
    const { session } = newSession();
    scanItem(session);
    session.suspend();
    expect(session.currentState()).toBe('suspended');
    expect(() => scanItem(session)).toThrow(SessionStateError);
    session.recall();
    expect(session.currentState()).toBe('selling');
    expect(session.totals().lineCount).toBe(1);
  });

  it('starts a fresh basket after a commit', async () => {
    const { session } = newSession();
    scanItem(session);
    await session.commit('sale-1', 'S-0001', AT, [cash(118_00)]);
    session.newSale();
    expect(session.currentState()).toBe('idle');
    expect(session.basket()).toHaveLength(0);
    expect(session.totals().payable).toEqual(money(0, 'INR'));
  });

  it('refuses a double-tap commit and never double-bills', async () => {
    const { session, ledger, outbox } = newSession();
    scanItem(session);
    await session.commit('sale-1', 'S-0001', AT, [cash(118_00)]);
    // A second tap on Tender is refused with a clear state error, not a second sale.
    await expect(session.commit('sale-1', 'S-0001', AT, [cash(118_00)])).rejects.toThrow(SessionStateError);
    expect(ledger.entries()).toHaveLength(1);
    expect(outbox.unsentCount()).toBe(1);
  });
});

describe('the receipt waits for the disk (hard rule #1)', () => {
  /** Records the order things happened in, so "before" can be asserted rather than assumed. */
  const withRecorder = () => {
    const order: string[] = [];
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const realAppend = ledger.append.bind(ledger);
    ledger.append = ((e: Parameters<typeof realAppend>[0]) => { order.push('ledger'); return realAppend(e); }) as typeof realAppend;
    const realEnqueue = outbox.enqueue.bind(outbox);
    outbox.enqueue = ((e: Parameters<typeof realEnqueue>[0]) => { order.push('outbox'); return realEnqueue(e); }) as typeof realEnqueue;

    const session = new PosSession(
      { laneId: 'lane-1', cashierId: 'c-1', tradingDay: '2026-08-05', currency: 'INR', defaultTaxRate: taxRateFromPercent(18) },
      ledger, outbox,
      (_id, record) => {
        order.push('disk');
        order.push(`bytes:${record.length}`);
        return Promise.resolve({ committed: true as const, durable: true as const, detail: 'ok', laneMessage: 'Sale complete.' });
      },
    );
    return { session, ledger, outbox, order };
  };

  it('writes to the DISK before the ledger or the outbox sees anything', () => {
    // The order is the rule. Doing it the other way round produces the worst failure this product
    // has: a sale the cashier saw succeed, that the customer paid for and walked away from, which
    // was never written anywhere.
    const { session, order } = withRecorder();
    scanItem(session);
    return session.commit('sale-1', 'S-0001', AT, [cash(118_00)]).then(() => {
      expect(order[0]).toBe('disk');
      expect(order.indexOf('disk')).toBeLessThan(order.indexOf('ledger'));
      expect(order.indexOf('disk')).toBeLessThan(order.indexOf('outbox'));
    });
  });

  it('writes the sale itself, not an empty placeholder', async () => {
    const { session, order } = withRecorder();
    scanItem(session);
    await session.commit('sale-1', 'S-0001', AT, [cash(118_00)]);
    const bytes = Number(order.find((o) => o.startsWith('bytes:'))!.slice(6));
    expect(bytes).toBeGreaterThan(100);
  });

  it('REFUSES the sale when the disk refuses, and changes nothing', async () => {
    // Before the receipt, before payment, with the customer still standing there — the one place
    // in the product where refusing a sale is the right answer.
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const session = new PosSession(
      { laneId: 'lane-1', cashierId: 'c-1', tradingDay: '2026-08-05', currency: 'INR', defaultTaxRate: taxRateFromPercent(18) },
      ledger, outbox,
      () => Promise.resolve({
        committed: false as const, refusedBecause: 'no_room_left' as const,
        detail: 'the disk is full',
        laneMessage: 'This lane cannot record any more sales until it syncs. Do not take payment.',
      }),
    );
    scanItem(session);

    await expect(session.commit('sale-1', 'S-0001', AT, [cash(118_00)])).rejects.toThrow(LocalCommitRefusedError);
    // Nothing moved. Not the stock, not the queue, not the state.
    expect(ledger.entries()).toHaveLength(0);
    expect(outbox.unsentCount()).toBe(0);
    expect(session.currentState()).not.toBe('committed');
  });

  it('gives the cashier the lane\'s words, not a code', async () => {
    const session = new PosSession(
      { laneId: 'lane-1', cashierId: 'c-1', tradingDay: '2026-08-05', currency: 'INR', defaultTaxRate: taxRateFromPercent(18) },
      new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
      () => Promise.resolve({
        committed: false as const, refusedBecause: 'could_not_write_durably' as const,
        detail: 'the local write failed',
        laneMessage: 'This lane could not save the sale. Do not take payment and do not hand over the goods.',
      }),
    );
    scanItem(session);
    await session.commit('sale-1', 'S-0001', AT, [cash(118_00)]).catch((e: unknown) => {
      expect((e as LocalCommitRefusedError).laneMessage).toContain('Do not take payment');
    });
  });

  it('takes the durable write as a CONSTRUCTOR argument, so it cannot be forgotten', () => {
    // An optional durable write is one a deployment can forget, and forgetting it is invisible:
    // the lane sells, the screen says "Sale complete", and the sales are in memory.
    expect(PosSession.length).toBe(4);
  });
});

describe('card and UPI — silence is never success (M12-FR-03)', () => {
  const ACCEPTS = (): Promise<CommitOutcome> => Promise.resolve({
    committed: true, durable: true, detail: 'ok', laneMessage: 'Sale complete.',
  });
  const viewFor = (durable: (saleId: string, record: string) => Promise<CommitOutcome> = ACCEPTS) => {
    const session = new PosSession(
      { laneId: 'lane-1', cashierId: 'c-1', tradingDay: '2026-08-05', currency: 'INR', defaultTaxRate: taxRateFromPercent(18) },
      new Ledger(new InMemoryLedgerStore()), new SyncOutbox(), durable,
    );
    return { session, view: createPosView(session, 'INR') };
  };

  const basket = (view: ReturnType<typeof viewFor>['view']) => {
    view.scan({ productId: 'P1', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 });
  };

  const take = (view: ReturnType<typeof viewFor>['view'], outcome: 'approved' | 'declined' | 'no_answer') =>
    view.tenderCardOrUpi({
      saleId: 'S-1', receiptNumber: 'R-0001', atIsoUtc: '2026-08-05T10:00:00Z',
      kind: 'card', outcome,
    });

  it('completes the sale when the machine approved it', async () => {
    const { view } = viewFor();
    basket(view);
    await expect(take(view, 'approved')).resolves.toBe('R-0001');
  });

  it('does NOT complete the sale when the machine declined', async () => {
    const { view, session } = viewFor();
    basket(view);
    await expect(take(view, 'declined')).rejects.toThrow();
    expect(session.currentState()).not.toBe('committed');
  });

  it('does NOT complete the sale when the machine has not answered', async () => {
    // The one that loses money. The terminal has not come back, the customer is waiting, and the
    // temptation is to treat silence as success. A tender the model marks `uncertain` does not
    // count as paid, so the sale cannot complete and the goods stay on the counter.
    const { view, session } = viewFor();
    basket(view);
    await expect(take(view, 'no_answer')).rejects.toThrow();
    expect(session.currentState()).not.toBe('committed');
  });

  it('writes NOTHING to the disk on an unanswered payment', async () => {
    // Not merely "does not say paid" — nothing is committed at all. A record of a sale that was
    // never paid for is a figure somebody reconciles against later.
    const written: string[] = [];
    const { view } = viewFor((saleId) => { written.push(saleId); return ACCEPTS(); });
    basket(view);
    await expect(take(view, 'no_answer')).rejects.toThrow();
    expect(written).toEqual([]);
  });

  it('offers no way to mark an unanswered payment as paid', async () => {
    // Absence as a control. The moment a "force complete" exists, it is used at 7pm on a Saturday.
    const module = await import('../../apps/pos/src/index');
    for (const name of Object.keys(module)) {
      expect(name).not.toMatch(/forceComplete|markPaid|overrideTender|assumeApproved/i);
    }
  });
});

describe('a held basket is not a lost basket', () => {
  const viewFor = () => {
    const session = new PosSession(
      { laneId: 'lane-1', cashierId: 'c-1', tradingDay: '2026-08-05', currency: 'INR', defaultTaxRate: taxRateFromPercent(18) },
      new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
      () => Promise.resolve({ committed: true as const, durable: true as const, detail: 'ok', laneMessage: 'Sale complete.' }),
    );
    return createPosView(session, 'INR');
  };

  it('holds and recalls, and the lines survive both', () => {
    // The customer forgot the milk. The basket is parked and comes back whole — a screen that
    // silently emptied would have the same items rung up twice.
    const view = viewFor();
    view.scan({ productId: 'P1', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 });
    view.suspend();
    expect(view.state()).toBe('suspended');
    expect(view.basket()).toHaveLength(1);

    view.recall();
    expect(view.state()).toBe('selling');
    expect(view.payableMinor()).toBeGreaterThan(0);
  });

  it('says which state it is in, so the screen can say so too', () => {
    const view = viewFor();
    expect(view.state()).toBe('idle');
  });
});
