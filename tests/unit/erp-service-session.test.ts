import { describe, it, expect } from 'vitest';
import {
  createServiceSession, ageInDays, tellTheCustomer,
  LOOKUP_REFUSAL_KINDS, REFUND_REFUSAL_KINDS,
  type ServiceConfig, type ServicePorts,
} from '../../apps/web-erp/src/service-session';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import type { OriginalSale, RecordedReturn } from '../../packages/returns/src/index';
import type { ServiceCase } from '../../packages/service-desk/src/index';

/**
 * **The customer service and returns desk (M13-FR-01…04 · M21-FR-03/04).**
 *
 * The till has been sending people here for as long as it has had a refund button, and there was
 * no here. The controls under test are the ones a later change would remove because they look like
 * friction to somebody standing in front of an angry customer:
 *
 *   • the same goods cannot come back twice, and the same money cannot go out twice;
 *   • a card refund is PENDING and the customer is told so, never shown a completed refund for
 *     money that has not moved;
 *   • damaged goods do not re-enter sellable stock;
 *   • the person giving a refund is not the person approving it;
 *   • compensation on a case is money leaving the business, decided by the person being shouted at.
 */

const NOW = '2026-08-06T14:00:00.000Z';

const SALE: OriginalSale = {
  saleId: 'S-1', number: 'R-1001', tradingDay: '2026-08-04',
  committedAt: '2026-08-04T10:00:00.000Z', totalMinor: 500_00,
  lines: [
    { productId: 'p1', uom: 'ea', quantityMinor: 3 },
    { productId: 'p2', uom: 'kg', quantityMinor: 1_500 },
  ],
  tenders: [{ kind: 'card', amountMinor: 500_00 }],
};

const OLD_SALE: OriginalSale = {
  ...SALE, saleId: 'S-OLD', number: 'R-0900', tradingDay: '2026-06-01',
  committedAt: '2026-06-01T10:00:00.000Z',
};

const CASE: ServiceCase = {
  caseId: 'C-1', tenantId: 't1', kind: 'complaint', customerRef: 'cust-1',
  openedAt: '2026-08-06T09:00:00.000Z', assignedTo: 'u-desk', priority: 'high',
  state: 'open', summary: 'Milk was sour',
};

const CONFIG: ServiceConfig = {
  tenantId: 't1', storeId: 'store-1', laneId: 'desk-1', userId: 'u-desk',
  now: NOW, tradingDay: '2026-08-06',
  returnWindowDays: 30,
  approvalThresholdMinor: 200_00,
  noReceiptCapMinor: 100_00,
  agentAuthorityMinor: 50_00,
  compensationCapMinor: 500_00,
};

function ports(over: Partial<ServicePorts> = {}): ServicePorts {
  const stock = new Ledger(new InMemoryLedgerStore());
  const out = new SyncOutbox();
  return {
    sales: () => [SALE, OLD_SALE],
    returns: () => [],
    refunds: () => [],
    cases: () => [CASE],
    slaPolicy: () => ({ resolutionMinutes: { high: 240 }, firstResponseMinutes: { high: 60 } }),
    satisfaction: () => [],
    stockLedger: () => stock,
    outbox: () => out,
    ...over,
  };
}

const desk = (over: Partial<ServicePorts> = {}, config: Partial<ServiceConfig> = {}) =>
  createServiceSession({ ...CONFIG, ...config }, ports(over));

const REFUND = {
  returnId: 'RT-1', number: 'RTN-1', receiptNumber: 'R-1001', reasonCode: 'damaged',
  lines: [{ productId: 'p1', quantityMinor: 1, disposition: 'resell' as const }],
  refundMinor: 100_00, refundTender: 'cash' as const,
};

// ── Finding the bill ────────────────────────────────────────────────────────

describe('the desk finds the bill the lane could not', () => {
  it('finds a receipt in this box’s own log, with no network at all', () => {
    const found = desk().lookUp('R-1001');
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.receipt.sale.saleId).toBe('S-1');
    expect(found.receipt.ageDays).toBe(2);
    expect(found.receipt.lines.find((l) => l.productId === 'p1')?.returnableMinor).toBe(3);
  });

  it('says plainly when there is no such receipt, and what to do instead', () => {
    const found = desk().lookUp('R-9999');
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.refusal).toBe('no_such_receipt');
    expect(found.detail).toContain('no-receipt return');
  });

  it('refuses a bill outside the shop’s own return window, and says how far outside', () => {
    // "Computer says no" is not something a person can say to a customer.
    const found = desk().lookUp('R-0900');
    if (found.ok) return;
    expect(found.refusal).toBe('outside_the_return_window');
    expect(found.detail).toContain('66 days old');
    expect(found.detail).toContain('30 days');
  });

  it('honours a DIFFERENT shop’s window, because it is not a constant', () => {
    expect(desk({}, { returnWindowDays: 90 }).lookUp('R-0900').ok).toBe(true);
  });

  it('counts the window in whole days, so the last day is still inside it', () => {
    expect(ageInDays('2026-08-04T10:00:00.000Z', '2026-08-04T09:00:00.000Z')).toBe(-1);
    // 29 days and 23 hours is 29 days, not 30 — the customer gets the day they were promised.
    expect(ageInDays('2026-07-08T15:00:00.000Z', '2026-08-06T14:00:00.000Z')).toBe(28);
  });

  it('says when the whole bill has already come back', () => {
    const returns: RecordedReturn[] = [{
      returnId: 'RT-OLD', originalSaleId: 'S-1', processedAt: '2026-08-05T10:00:00.000Z',
      lines: [
        { productId: 'p1', uom: 'ea', quantityMinor: 3 },
        { productId: 'p2', uom: 'kg', quantityMinor: 1_500 },
      ],
    }];
    const found = desk({ returns: () => returns }).lookUp('R-1001');
    if (found.ok) return;
    expect(found.refusal).toBe('nothing_left_to_return');
    expect(found.detail).toContain('second refund for the same goods');
    expect(LOOKUP_REFUSAL_KINDS).toHaveLength(3);
  });

  it('shows what is LEFT of the bill in money, not the bill’s total', () => {
    const found = desk({ refunds: () => [{ returnId: 'RT-1', originalSaleId: 'S-1', refundMinor: 120_00 }] })
      .lookUp('R-1001');
    if (!found.ok) return;
    expect(found.receipt.alreadyRefundedMinor).toBe(120_00);
    expect(found.receipt.refundableMinor).toBe(380_00);
  });

  it('surfaces a bill where more has come back than went out', () => {
    const returns: RecordedReturn[] = [{
      returnId: 'RT-BAD', originalSaleId: 'S-1', processedAt: '2026-08-05T10:00:00.000Z',
      lines: [{ productId: 'p1', uom: 'ea', quantityMinor: 5 }],
    }];
    const found = desk({ returns: () => returns }).lookUp('R-1001');
    if (!found.ok) return;
    expect(found.receipt.overReturned).toEqual([{ productId: 'p1', soldMinor: 3, returnedMinor: 5 }]);
  });
});

// ── The rule that had never been fed ────────────────────────────────────────

describe('the same goods cannot come back twice', () => {
  it('takes a first return against a bill', () => {
    const outcome = desk().refund(REFUND);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.committed.originalSaleId).toBe('S-1');
    expect(outcome.committed.restockedLines).toBe(1);
  });

  it('REFUSES the second return of the same unit — the fault this desk exists to stop', () => {
    // Before the register existed, `alreadyReturnedMinor` was never supplied, so every return was
    // judged against nothing already returned. The same receipt could be refunded every day.
    const returns: RecordedReturn[] = [{
      returnId: 'RT-YESTERDAY', originalSaleId: 'S-1', processedAt: '2026-08-05T10:00:00.000Z',
      lines: [{ productId: 'p1', uom: 'ea', quantityMinor: 3 }],
    }];
    const outcome = desk({ returns: () => returns }).refund(REFUND);
    expect(outcome.ok, 'the same goods were refunded twice').toBe(false);
    if (outcome.ok) return;
    expect(outcome.detail).toContain('already come back');
  });

  it('still allows what is genuinely left of a part-returned line', () => {
    const returns: RecordedReturn[] = [{
      returnId: 'RT-1', originalSaleId: 'S-1', processedAt: '2026-08-05T10:00:00.000Z',
      lines: [{ productId: 'p1', uom: 'ea', quantityMinor: 2 }],
    }];
    const session = desk({ returns: () => returns });
    expect(session.refund({ ...REFUND, returnId: 'RT-2' }).ok).toBe(true);
    expect(session.refund({ ...REFUND, returnId: 'RT-3', lines: [{ productId: 'p1', quantityMinor: 2, disposition: 'resell' }] }).ok)
      .toBe(false);
  });

  it('refuses more money than is LEFT of the bill, even when the goods are fine', () => {
    // The line rule and the money rule catch different breaches. A discounted bill can pass the
    // first and fail the second: two ₹400 refunds against a ₹500 bill are two different units.
    const outcome = desk({ refunds: () => [{ returnId: 'RT-1', originalSaleId: 'S-1', refundMinor: 450_00 }] })
      .refund({ ...REFUND, returnId: 'RT-2', refundMinor: 100_00 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('more_than_was_paid');
    expect(outcome.detail).toContain('never exceed what was paid');
  });
});

// ── Money, and telling the truth about it ───────────────────────────────────

describe('the customer is told the true state of their money', () => {
  it('settles a cash refund at the desk, now', () => {
    const outcome = desk().refund(REFUND);
    if (!outcome.ok) return;
    expect(outcome.committed.refundStatus).toBe('settled');
    expect(outcome.tellTheCustomer).toContain('from the drawer');
  });

  it('leaves a card refund PENDING and never calls it refunded', () => {
    // The provider has to move it, and offline nobody has even asked yet. "Refunded" makes the
    // shop responsible for a promise it has not kept, and they come back angry in three days.
    const outcome = desk().refund({ ...REFUND, refundTender: 'card' });
    if (!outcome.ok) return;
    expect(outcome.committed.refundStatus).toBe('pending');
    expect(outcome.tellTheCustomer).toContain('NOT back on the card yet');
    expect(outcome.tellTheCustomer.toLowerCase()).not.toContain('has been refunded');
  });

  it('says the same for UPI, which is also somebody else moving the money', () => {
    const outcome = desk().refund({ ...REFUND, refundTender: 'upi' });
    if (!outcome.ok) return;
    expect(outcome.committed.refundStatus).toBe('pending');
  });

  it('settles store credit, which the shop can give immediately', () => {
    const outcome = desk().refund({ ...REFUND, refundTender: 'store_credit' });
    if (!outcome.ok) return;
    expect(outcome.committed.refundStatus).toBe('settled');
    expect(tellTheCustomer(outcome.committed)).toContain('usable now');
  });
});

// ── Where the goods go ──────────────────────────────────────────────────────

describe('damaged goods do not go back on the shelf', () => {
  it('restocks a resellable return', () => {
    const outcome = desk().refund(REFUND);
    if (!outcome.ok) return;
    expect(outcome.committed.restockedLines).toBe(1);
  });

  it('does NOT restock a damaged one', () => {
    const outcome = desk().refund({
      ...REFUND, lines: [{ productId: 'p1', quantityMinor: 1, disposition: 'damaged' }],
    });
    if (!outcome.ok) return;
    expect(outcome.committed.restockedLines).toBe(0);
  });

  it('does not restock quarantined or scrapped goods either', () => {
    for (const disposition of ['quarantine', 'scrap'] as const) {
      const outcome = desk().refund({
        ...REFUND, returnId: `RT-${disposition}`,
        lines: [{ productId: 'p1', quantityMinor: 1, disposition }],
      });
      if (!outcome.ok) continue;
      expect(outcome.committed.restockedLines, disposition).toBe(0);
    }
  });
});

// ── Who may do it ───────────────────────────────────────────────────────────

describe('a refund carries a name, and a big one carries two', () => {
  it('commits nothing when the box does not know who is on the desk', () => {
    const outcome = desk({}, { userId: null }).refund(REFUND);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('nobody_is_named_at_this_desk');
  });

  it('needs a second person above the shop’s own threshold', () => {
    const outcome = desk().refund({ ...REFUND, refundMinor: 300_00 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('needs_a_second_person');
    expect(outcome.detail).toContain('cannot be the one approving it');
  });

  it('takes it with a real approval from somebody else', () => {
    const outcome = desk().refund({
      ...REFUND, refundMinor: 300_00,
      approval: {
        id: 'a1', subjectType: 'refund', subjectRef: 'RT-1', requestedBy: 'u-desk',
        status: 'approved', decidedBy: 'u-manager', decidedAt: NOW, reason: 'goods faulty',
      } as never,
    });
    expect(outcome.ok).toBe(true);
  });

  it('needs a reason, always', () => {
    const outcome = desk().refund({ ...REFUND, reasonCode: '  ' });
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('needs_a_reason');
    expect(outcome.detail).toContain('three months later');
  });

  it('refuses a return with nothing selected', () => {
    const outcome = desk().refund({ ...REFUND, lines: [] });
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('nothing_selected');
  });

  it('caps a no-receipt return at the shop’s own ceiling', () => {
    const outcome = desk().refund({
      ...REFUND, receiptNumber: undefined, refundMinor: 150_00,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('no_receipt_over_the_cap');
    expect(REFUND_REFUSAL_KINDS).toHaveLength(9);
  });

  it('always needs a second person for a no-receipt return, however small', () => {
    // Under the approval threshold, so only the no-receipt rule can be stopping it.
    const outcome = desk().refund({ ...REFUND, receiptNumber: undefined, refundMinor: 50_00 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('needs_a_second_person');
    expect(outcome.detail).toContain('no receipt always needs one');
  });
});

// ── The other half of the desk ──────────────────────────────────────────────

describe('cases, their clock, and the money that settles them', () => {
  it('puts the worst SLA at the top, because this is a work queue', () => {
    const late: ServiceCase = { ...CASE, caseId: 'C-LATE', openedAt: '2026-08-01T09:00:00.000Z' };
    const list = desk({ cases: () => [CASE, late] }).caseList();
    expect(list[0]?.serviceCase.caseId).toBe('C-LATE');
    expect(list[0]?.resolution.status).toBe('breached');
  });

  it('says out loud when the shop has never set its own targets', () => {
    // A desk running on the product's defaults believes it has agreed targets it never agreed,
    // and finds out when one is quoted back at it.
    expect(desk({ slaPolicy: () => undefined }).caseList()[0]?.targetsAreDefaults).toBe(true);
    expect(desk().caseList()[0]?.targetsAreDefaults).toBe(false);
  });

  it('reports a case nobody has answered separately from one resolved late', () => {
    // A desk that resolves everything inside target while nobody replies for two days is failing
    // in the way people actually notice, and one "SLA met" figure hides exactly that.
    // Opened two hours ago: an hour past the 60-minute first-response promise, and half way
    // through the four-hour resolution one.
    const list = desk({ cases: () => [{ ...CASE, openedAt: '2026-08-06T12:00:00.000Z' }] }).caseList();
    expect(list[0]?.firstResponse.status).toBe('breached');
    expect(list[0]?.resolution.status).toBe('within');
  });

  it('grants compensation inside the agent’s own authority', () => {
    const result = desk().compensate({
      caseId: 'C-1', kind: 'goodwill_credit', amountMinor: 20_00, reason: 'sour milk, regular customer',
    });
    expect(result.granted).toBe(true);
  });

  it('needs a second signature above it — the person being shouted at does not decide alone', () => {
    const result = desk().compensate({
      caseId: 'C-1', kind: 'goodwill_credit', amountMinor: 100_00, reason: 'sour milk',
    });
    expect(result.granted).toBe(false);
    expect(result.outcome).toBe('needs_approval');
  });

  it('refuses above the desk’s ceiling whoever signs', () => {
    const result = desk().compensate({
      caseId: 'C-1', kind: 'refund', amountMinor: 900_00, reason: 'sour milk',
    });
    expect(result.outcome).toBe('exceeds_policy_cap');
  });

  it('needs a reason for compensation, because "goodwill" explains nothing', () => {
    const result = desk().compensate({ caseId: 'C-1', kind: 'goodwill_credit', amountMinor: 20_00, reason: '' });
    expect(result.outcome).toBe('no_reason');
  });

  it('gives nothing away when the box does not know who is at the desk', () => {
    const result = desk({}, { userId: null }).compensate({
      caseId: 'C-1', kind: 'goodwill_credit', amountMinor: 20_00, reason: 'sour milk',
    });
    expect(result.granted).toBe(false);
    expect(result.outcome).toBe('nobody_is_named_at_this_desk');
  });

  it('refuses compensation on a case that does not exist', () => {
    const result = desk().compensate({ caseId: 'C-NOPE', kind: 'refund', amountMinor: 10_00, reason: 'x' });
    expect(result.outcome).toBe('no_such_case');
  });

  it('reports the desk from the SAME views its queue is sorted by', () => {
    // Two assessments of one case is how a manager's report and the screen in front of the agent
    // come to disagree about whether a case was late.
    const late: ServiceCase = { ...CASE, caseId: 'C-LATE', openedAt: '2026-08-01T09:00:00.000Z' };
    const session = desk({ cases: () => [CASE, late] });
    expect(session.report().breached).toBe(session.caseList().filter((v) => v.resolution.status === 'breached').length);
    expect(session.report().breachedValue).toContain('C-LATE');
  });

  it('reports no satisfaction score rather than a flattering nought', () => {
    expect(desk().report().csatHundredths).toBe('no_responses');
  });
});
