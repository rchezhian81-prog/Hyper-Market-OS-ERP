import { describe, it, expect } from 'vitest';
import {
  PosSession,
  taxRateFromPercent,
  EmptyBasketError,
  VoidReasonRequiredError,
  NoSuchLineError,
  SessionStateError,
} from '../../apps/pos/src/index';
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

  it('commits a cash sale locally and queues it for sync — no network', () => {
    const { session, ledger, outbox } = newSession();
    scanItem(session);
    session.goToTender();
    const sale = session.commit('sale-1', 'S-0001', AT, [cash(118_00)]);

    expect(sale.total).toEqual(money(118_00, 'INR'));
    expect(session.currentState()).toBe('committed');
    expect(ledger.entries()).toHaveLength(1); // stock moved locally
    expect(outbox.unsentCount()).toBe(1); // queued for the cloud
  });

  it('keeps billing with the cable out and shows the unsent count', () => {
    const { session, outbox } = newSession();
    session.setConnection('offline');
    scanItem(session);
    session.commit('sale-1', 'S-0001', AT, [cash(118_00)]);

    const badge = session.syncBadge();
    expect(badge.connection).toBe('offline');
    expect(badge.unsentCount).toBe(1); // lag is visible (P-08)
    expect(outbox.pending()[0]?.event.type).toBe('SaleCommitted');
  });

  it('suspends and recalls a basket', () => {
    const { session } = newSession();
    scanItem(session);
    session.suspend();
    expect(session.currentState()).toBe('suspended');
    expect(() => scanItem(session)).toThrow(SessionStateError);
    session.recall();
    expect(session.currentState()).toBe('selling');
    expect(session.totals().lineCount).toBe(1);
  });

  it('starts a fresh basket after a commit', () => {
    const { session } = newSession();
    scanItem(session);
    session.commit('sale-1', 'S-0001', AT, [cash(118_00)]);
    session.newSale();
    expect(session.currentState()).toBe('idle');
    expect(session.basket()).toHaveLength(0);
    expect(session.totals().payable).toEqual(money(0, 'INR'));
  });

  it('refuses a double-tap commit and never double-bills', () => {
    const { session, ledger, outbox } = newSession();
    scanItem(session);
    session.commit('sale-1', 'S-0001', AT, [cash(118_00)]);
    // a second tap on Tender is refused with a clear state error, not a second sale
    expect(() => session.commit('sale-1', 'S-0001', AT, [cash(118_00)])).toThrow(SessionStateError);
    expect(ledger.entries()).toHaveLength(1);
    expect(outbox.unsentCount()).toBe(1);
  });
});
