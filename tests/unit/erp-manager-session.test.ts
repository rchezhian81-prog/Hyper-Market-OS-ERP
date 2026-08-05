import { describe, it, expect } from 'vitest';
import {
  createManagerSession,
  disconnectedPorts,
  notKnown,
  unsentFromOutbox,
  blockerSentence,
  reasonsFor,
  APPROVE_REASONS,
  REJECT_REASONS,
  type ManagerConfig,
  type ManagerPorts,
  type ManagerSession,
  type RegisterItem,
} from '../../apps/web-erp/src/manager-session';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { requestApproval, type ApprovalRequest } from '../../packages/approvals/src/index';
import { makeTradingDayRule } from '../../packages/calendar/src/trading-day';
import { money } from '../../packages/contracts/src/money';

// The store manager's surface (docs/design/screens/store-manager.md · M02 · M07 · M09 · M14-FR-04
// · M15). The rules live in `packages/`; what is tested here is the composition — and above all
// the two properties the screen exists to hold: a day close that reports a LIST, and a register
// that is allowed to say it does not know.

const CONFIG: ManagerConfig = {
  storeId: 'store-1',
  branchId: 'b1',
  tradingDay: '2026-08-04',
  tradingDayRule: makeTradingDayRule('02:00'), // the store's day ends at 2 am
  manager: { userId: 'u-mgr', branchScope: ['b1'], authorityLimit: money(500_000, 'INR') },
  currency: 'INR',
  warehouseId: 'wh-store',
  countApprovalThresholdMinor: 100_000, // ₹1,000
};

/** After the 2 am cut-off on the 5th, so the trading day of the 4th has ended. */
const AFTER_CUTOFF = '2026-08-05T02:30';
const BEFORE_CUTOFF = '2026-08-05T01:30';
const AT = '2026-08-05T02:30:00Z';

/** Ports that can see everything, and see nothing open. The clean-store case. */
function clearPorts(overrides: Partial<ManagerPorts> = {}): ManagerPorts {
  return {
    approvals: () => ({ known: true, requests: [] }),
    openExceptions: () => ({ known: true, items: [] }),
    unsentItems: () => ({ known: true, items: [] }),
    tasks: () => ({ known: true, items: [] }),
    productValue: () => ({ known: true, valuePerUnitMinor: 2_500 }), // ₹25.00 each
    ...overrides,
  };
}

function newSession(ports: ManagerPorts = clearPorts()): {
  session: ManagerSession;
  outbox: SyncOutbox;
  stock: Ledger;
} {
  const outbox = new SyncOutbox();
  const stock = new Ledger(new InMemoryLedgerStore());
  return { session: createManagerSession(CONFIG, ports, stock, outbox), outbox, stock };
}

const items = (...what: string[]): RegisterItem[] =>
  what.map((text, i) => ({ id: `x-${i}`, what: text }));

describe('the day close answers with a list, not a refusal', () => {
  it('closes a clean day and locks it', () => {
    const { session, outbox } = newSession();
    const attempt = session.closeTheDay({
      dayCloseId: 'dc-1', closedAtLocal: AFTER_CUTOFF, closedAt: AT,
    });
    expect(attempt.closed).toBe(true);
    if (!attempt.closed) return;
    expect(attempt.result.locked).toBe(true);
    expect(attempt.result.closedBy).toBe('u-mgr');
    // The close itself is queued for cloud like everything else (§31).
    expect(outbox.pending().map((i) => i.event.type)).toContain('PeriodClosed');
  });

  it('names every open exception, not just how many', () => {
    // "Cannot close" is useless at eleven at night. "2 exceptions open — here they are" is
    // something a manager can act on without hunting through another screen.
    const { session } = newSession(clearPorts({
      openExceptions: () => ({ known: true, items: items('Till 3 short by ₹420', 'Void spike — cashier Meena') }),
    }));
    const attempt = session.closeTheDay({ dayCloseId: 'dc-2', closedAtLocal: AFTER_CUTOFF, closedAt: AT });

    expect(attempt.closed).toBe(false);
    if (attempt.closed) return;
    const blocker = attempt.blockers.find((b) => b.kind === 'exceptions_open');
    expect(blocker?.count).toBe(2);
    expect(blocker?.items.map((i) => i.what)).toEqual([
      'Till 3 short by ₹420', 'Void spike — cashier Meena',
    ]);
  });

  it('reports every blocker at once rather than one per attempt', () => {
    // Clearing an exception only to be told about unsent sales is two trips to the same screen.
    const { session } = newSession(clearPorts({
      openExceptions: () => ({ known: true, items: items('Till 3 short') }),
      unsentItems: () => ({ known: true, items: items('SaleCommitted', 'SaleCommitted') }),
    }));
    const attempt = session.closeTheDay({ dayCloseId: 'dc-3', closedAtLocal: BEFORE_CUTOFF, closedAt: AT });

    expect(attempt.closed).toBe(false);
    if (attempt.closed) return;
    expect(attempt.blockers.map((b) => b.kind).sort())
      .toEqual(['day_not_ended', 'exceptions_open', 'items_unsent']);
  });

  it('never truncates the list it reports, however long it is', () => {
    // The view shortens for display and says how many more. A model that shortened would produce a
    // list that looks complete, which is how a manager clears three of eleven and goes home.
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `e-${i}`, what: `exception ${i}` }));
    const { session } = newSession(clearPorts({ openExceptions: () => ({ known: true, items: many }) }));
    const attempt = session.closeTheDay({ dayCloseId: 'dc-4', closedAtLocal: AFTER_CUTOFF, closedAt: AT });

    expect(attempt.closed).toBe(false);
    if (attempt.closed) return;
    expect(attempt.blockers[0]?.items).toHaveLength(40);
    expect(attempt.blockers[0]?.count).toBe(40);
  });

  it('does not queue a close it refused', () => {
    const { session, outbox } = newSession(clearPorts({
      unsentItems: () => ({ known: true, items: items('SaleCommitted') }),
    }));
    session.closeTheDay({ dayCloseId: 'dc-5', closedAtLocal: AFTER_CUTOFF, closedAt: AT });
    expect(outbox.pending()).toHaveLength(0);
  });
});

describe('a register that cannot be read stops the day closing', () => {
  // The whole reason this session reads registers instead of counts. `closeDay` takes two numbers;
  // a screen that could not reach the exception register would pass 0 for exactly the same reason
  // a clean store does, and the day would lock on an assumption.

  it('refuses to close when the exception register is unreadable', () => {
    const { session } = newSession(clearPorts({
      openExceptions: () => notKnown('the store box did not answer'),
    }));
    const attempt = session.closeTheDay({ dayCloseId: 'dc-6', closedAtLocal: AFTER_CUTOFF, closedAt: AT });

    expect(attempt.closed).toBe(false);
    if (attempt.closed) return;
    const blocker = attempt.blockers.find((b) => b.kind === 'cannot_see');
    expect(blocker?.source).toBe('exceptions');
    expect(blocker?.why).toBe('the store box did not answer');
  });

  it('refuses to close when the unsent register is unreadable', () => {
    const { session } = newSession(clearPorts({
      unsentItems: () => notKnown('no reply from the edge'),
    }));
    const attempt = session.closeTheDay({ dayCloseId: 'dc-7', closedAtLocal: AFTER_CUTOFF, closedAt: AT });
    expect(attempt.closed).toBe(false);
    if (attempt.closed) return;
    expect(attempt.blockers.map((b) => b.source)).toContain('unsent');
  });

  it('refuses to close a screen that has never been connected at all', () => {
    // The default for an unwired screen. Not a degraded mode to tidy up later — the correct answer.
    const { session } = newSession(disconnectedPorts('not connected to the store'));
    const attempt = session.closeTheDay({ dayCloseId: 'dc-8', closedAtLocal: AFTER_CUTOFF, closedAt: AT });
    expect(attempt.closed).toBe(false);
    if (attempt.closed) return;
    expect(attempt.blockers.every((b) => b.kind === 'cannot_see')).toBe(true);
  });

  it('does not treat an unreadable register as an empty one', () => {
    // The difference between the two facts, stated as a test because it is the entire design.
    const seen = newSession(clearPorts()).session.blockersForClose(AFTER_CUTOFF);
    const unseen = newSession(clearPorts({ openExceptions: () => notKnown('down') }))
      .session.blockersForClose(AFTER_CUTOFF);
    expect(seen).toEqual([]);
    expect(unseen).toHaveLength(1);
  });

  it('says which register it could not read, so somebody can go and fix that one', () => {
    const { session } = newSession({
      approvals: () => notKnown('a'),
      openExceptions: () => notKnown('b'),
      unsentItems: () => notKnown('c'),
      tasks: () => notKnown('d'),
      productValue: () => notKnown('e'),
    });
    expect(session.blockersForClose(AFTER_CUTOFF).map((b) => b.source).sort())
      .toEqual(['exceptions', 'unsent']);
  });
});

describe('the trading-day rule is honoured, and an unreadable clock is not a pass', () => {
  it('blocks a day that has not reached its cut-off', () => {
    const { session } = newSession();
    const blockers = session.blockersForClose(BEFORE_CUTOFF);
    expect(blockers.map((b) => b.kind)).toEqual(['day_not_ended']);
  });

  it('treats a clock it cannot read as a blocker, never as an all-clear', () => {
    const { session } = newSession();
    const blockers = session.blockersForClose('yesterday evening');
    expect(blockers[0]?.kind).toBe('cannot_see');
    expect(blockers[0]?.source).toBe('trading-day');
  });
});

describe('a disagreement with the engine is shown, not thrown', () => {
  it('turns an unpredicted refusal into a visible blocker', () => {
    // If the engine refuses when this screen predicted nothing would, one of the two is wrong.
    // That is a real finding — so it is surfaced, and the day stays open either way. Here the
    // registers report clean while the day-close id has already been used with a different shape.
    const ports = clearPorts({
      // Reads clean for the blocker pass, then reports an open item to the engine call. A
      // contrived disagreement, but it is the shape a real one takes.
      openExceptions: (() => {
        let call = 0;
        return () => (++call === 1
          ? { known: true as const, items: [] }
          : { known: true as const, items: items('appeared late') });
      })(),
    });
    const { session, outbox } = newSession(ports);
    const attempt = session.closeTheDay({ dayCloseId: 'dc-9', closedAtLocal: AFTER_CUTOFF, closedAt: AT });

    expect(attempt.closed).toBe(false);
    if (attempt.closed) return;
    expect(attempt.blockers[0]?.kind).toBe('rules_refused');
    expect(attempt.blockers[0]?.why).toMatch(/unresolved exception/i);
    expect(outbox.pending()).toHaveLength(0);
  });
});

describe('the approval inbox', () => {
  const REQUESTS: ApprovalRequest[] = [
    requestApproval({ id: 'a1', subjectType: 'price_change', subjectRef: 'p-1', requestedBy: 'u-buyer', branchId: 'b1', value: money(120_000, 'INR') }),
    requestApproval({ id: 'a2', subjectType: 'stock_adjustment', subjectRef: 's-1', requestedBy: 'u-mgr', branchId: 'b1', value: money(300_000, 'INR') }),
    requestApproval({ id: 'a3', subjectType: 'refund', subjectRef: 'r-1', requestedBy: 'u-cashier', branchId: 'b1', value: money(900_000, 'INR') }),
  ];
  const withRequests = () => newSession(clearPorts({ approvals: () => ({ known: true, requests: REQUESTS }) }));

  it('orders by value so the biggest exposure is cleared first', () => {
    const queue = withRequests().session.approvalQueue();
    expect(queue.known).toBe(true);
    if (!queue.known) return;
    expect(queue.rows.map((r) => r.request.id)).toEqual(['a3', 'a2', 'a1']);
  });

  it('shows the manager their own request as theirs, never as actionable (§28)', () => {
    const queue = withRequests().session.approvalQueue();
    if (!queue.known) return;
    const own = queue.rows.find((r) => r.request.id === 'a2');
    expect(own?.actionable).toBe(false);
    expect(own?.blockedReason).toBe('own_request');
  });

  it('records the reason CODE, so it can still be reported on a year later', () => {
    const outcome = withRequests().session.decideApproval({
      requestId: 'a1', decision: 'approved', reasonCode: 'checked_the_stock', decidedAt: AT,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.request.reason).toBe('checked_the_stock');
    expect(outcome.request.decidedBy).toBe('u-mgr');
  });

  it('refuses a reason that is not in the catalogue', () => {
    // A free-text reason is one nobody can report on. Refusing an invented code is what keeps the
    // vocabulary stable, and it is checked before the engine so nothing unusable is ever recorded.
    const outcome = withRequests().session.decideApproval({
      requestId: 'a1', decision: 'approved', reasonCode: 'ok fine', decidedAt: AT,
    });
    expect(outcome).toEqual({ ok: false, refusal: 'unknown_reason_code' });
  });

  it('will not let a manager APPROVE something "against policy"', () => {
    // The two catalogues do not overlap on purpose. Either sentence in the audit trail would look
    // like a considered decision forever.
    const outcome = withRequests().session.decideApproval({
      requestId: 'a1', decision: 'approved', reasonCode: 'against_policy', decidedAt: AT,
    });
    expect(outcome).toEqual({ ok: false, refusal: 'unknown_reason_code' });
    expect(reasonsFor('approved')).not.toContain('against_policy');
    expect(APPROVE_REASONS.some((r) => (REJECT_REASONS as readonly string[]).includes(r))).toBe(false);
  });

  it('refuses their own request at the engine, not only in the list', () => {
    const outcome = withRequests().session.decideApproval({
      requestId: 'a2', decision: 'approved', reasonCode: 'within_policy', decidedAt: AT,
    });
    expect(outcome).toEqual({ ok: false, refusal: 'self_approval_forbidden' });
  });

  it('refuses a value above the manager\'s limit rather than failing at submit', () => {
    const outcome = withRequests().session.decideApproval({
      requestId: 'a3', decision: 'approved', reasonCode: 'within_policy', decidedAt: AT,
    });
    expect(outcome).toEqual({ ok: false, refusal: 'exceeds_authority' });
    // ...but they can still say no. You do not need a budget to reject something.
    const rejected = withRequests().session.decideApproval({
      requestId: 'a3', decision: 'rejected', reasonCode: 'not_enough_evidence', decidedAt: AT,
    });
    expect(rejected.ok).toBe(true);
  });

  it('refuses a request that is no longer in the queue instead of crashing on a stale screen', () => {
    const outcome = withRequests().session.decideApproval({
      requestId: 'gone', decision: 'approved', reasonCode: 'within_policy', decidedAt: AT,
    });
    expect(outcome).toEqual({ ok: false, refusal: 'request_not_found' });
  });

  it('says it cannot see the queue rather than showing an empty one', () => {
    const { session } = newSession(clearPorts({ approvals: () => notKnown('the approvals service is unreachable') }));
    const queue = session.approvalQueue();
    expect(queue.known).toBe(false);
    if (queue.known) return;
    expect(queue.why).toMatch(/unreachable/);
  });
});

describe('receiving a delivery', () => {
  it('raises stock and queues the receipt, with no network call', () => {
    const { session, outbox, stock } = newSession();
    const received = session.receive({
      grnId: 'grn-1', number: 'GRN-0001', poId: 'po-9', receivedAt: AT,
      lines: [{ productId: 'p-1', quantityMinor: 24, uom: 'ea' }],
    });
    expect(received.receipt.lineCount).toBe(1);
    expect(received.unmatched).toBe(false);
    expect(stock.entries()).toHaveLength(1);
    expect(outbox.pending().map((i) => i.event.type)).toContain('GoodsReceived');
  });

  it('flags a delivery that arrived with no purchase order behind it', () => {
    // The goods are in the building, so stock goes up — pretending otherwise is how a shelf and a
    // system disagree. But nothing can three-way match it, and a screen that stays quiet about
    // that produces an invoice nobody can check (M06/M07).
    const { session } = newSession();
    const received = session.receive({
      grnId: 'grn-2', number: 'GRN-0002', poId: null, receivedAt: AT,
      lines: [{ productId: 'p-2', quantityMinor: 6, uom: 'ea' }],
    });
    expect(received.unmatched).toBe(true);
    expect(received.receipt.poId).toBeNull();
  });

  it('collapses a retried receipt to one effect', () => {
    const { session, stock } = newSession();
    const input = {
      grnId: 'grn-3', number: 'GRN-0003', poId: 'po-1', receivedAt: AT,
      lines: [{ productId: 'p-3', quantityMinor: 10, uom: 'ea' }],
    };
    session.receive(input);
    session.receive(input);
    expect(stock.entries()).toHaveLength(1);
  });
});

describe('the stock count stays blind', () => {
  it('offers no way to ask what the system expects', () => {
    // Structural, not a habit. There is nothing to call and nothing for a later change to render
    // early — the same control the till uses for the drawer.
    const { session } = newSession();
    const surface = Object.keys(session);
    expect(surface.filter((k) => /expect|onHand|shouldBe/i.test(k))).toEqual([]);
  });

  it('derives the expected quantity from the ledger and returns the variance after the count', () => {
    const { session } = newSession();
    session.receive({
      grnId: 'grn-4', number: 'GRN-0004', poId: 'po-2', receivedAt: AT,
      lines: [{ productId: 'p-4', quantityMinor: 100, uom: 'ea' }],
    });
    const attempt = session.countStock({
      countId: 'c-1', productId: 'p-4', locationId: 'aisle-3', uom: 'ea',
      countedMinor: 94, reasonCode: 'shrinkage', at: AT,
      approval: {
        id: 'ap-1', subjectType: 'stock_adjustment', subjectRef: 'c-1', requestedBy: 'u-mgr',
        branchId: 'b1', value: money(15_000, 'INR'), status: 'approved', decidedBy: 'u-owner',
        reason: 'checked_the_stock', decidedAt: AT,
      },
    });
    expect(attempt.counted).toBe(true);
    if (!attempt.counted) return;
    expect(attempt.result.expectedMinor).toBe(100);
    expect(attempt.result.varianceMinor).toBe(-6);
    expect(attempt.result.varianceValue).toEqual(money(15_000, 'INR')); // 6 × ₹25.00
    expect(attempt.result.adjusted).toBe(true);
  });

  it('refuses a count it cannot value, rather than valuing it at nothing', () => {
    // The dangerous version of "an empty answer is not an all-clear", because the empty answer is a
    // number and the number looks fine. Valued at ₹0 a shrinkage of any size sits below every
    // approval threshold there is, and the adjustment posts with nobody's approval at all.
    const { session, stock, outbox } = newSession(clearPorts({
      productValue: () => notKnown('no cost price for that item on this screen'),
    }));
    session.receive({
      grnId: 'grn-8', number: 'GRN-0008', poId: 'po-6', receivedAt: AT,
      lines: [{ productId: 'p-8', quantityMinor: 500, uom: 'ea' }],
    });
    const before = stock.entries().length;

    const attempt = session.countStock({
      countId: 'c-3', productId: 'p-8', locationId: 'aisle-1', uom: 'ea',
      countedMinor: 1, reasonCode: 'shrinkage', at: AT,
    });

    expect(attempt.counted).toBe(false);
    if (attempt.counted) return;
    expect(attempt.refusal).toBe('value_not_known');
    expect(attempt.why).toMatch(/cost price/);
    // And nothing was written: no adjustment on the ledger, nothing queued for cloud.
    expect(stock.entries()).toHaveLength(before);
    expect(outbox.pending().map((i) => i.event.type)).not.toContain('StockAdjusted');
  });

  it('will not let the manager who counted approve their own material variance (§28)', () => {
    const { session } = newSession();
    session.receive({
      grnId: 'grn-5', number: 'GRN-0005', poId: 'po-3', receivedAt: AT,
      lines: [{ productId: 'p-5', quantityMinor: 100, uom: 'ea' }],
    });
    expect(() => session.countStock({
      countId: 'c-2', productId: 'p-5', locationId: 'aisle-4', uom: 'ea',
      countedMinor: 40, reasonCode: 'shrinkage', at: AT,
      approval: {
        id: 'ap-2', subjectType: 'stock_adjustment', subjectRef: 'c-2', requestedBy: 'u-mgr',
        branchId: 'b1', value: money(150_000, 'INR'), status: 'approved',
        decidedBy: 'u-mgr', // the counter, approving themselves
        reason: 'checked_the_stock', decidedAt: AT,
      },
    })).toThrow();
  });
});

describe('the home screen tells the truth about what it cannot see', () => {
  it('reports each figure, and says which ones are unknown', () => {
    const { session } = newSession({
      approvals: () => ({ known: true, requests: [
        requestApproval({ id: 'a1', subjectType: 'refund', subjectRef: 'r', requestedBy: 'u-cashier', branchId: 'b1', value: money(1_000, 'INR') }),
        requestApproval({ id: 'a2', subjectType: 'refund', subjectRef: 'r2', requestedBy: 'u-mgr', branchId: 'b1', value: money(1_000, 'INR') }),
      ] }),
      openExceptions: () => ({ known: true, items: items('one') }),
      unsentItems: () => notKnown('the edge did not answer'),
      tasks: () => ({ known: true, items: items('a', 'b', 'c') }),
      productValue: () => ({ known: true, valuePerUnitMinor: 100 }),
    });
    const floor = session.floor();
    expect(floor.approvalsWaiting).toEqual({ known: true, count: 2 });
    // One of the two is this manager's own, so only one can actually be cleared here.
    expect(floor.approvalsIcanClear).toEqual({ known: true, count: 1 });
    expect(floor.exceptions).toEqual({ known: true, count: 1 });
    expect(floor.unsent).toEqual({ known: false, why: 'the edge did not answer' });
    expect(floor.tasks).toEqual({ known: true, count: 3 });
  });
});

describe('an outbox register only ever speaks for its own outbox', () => {
  it('lists what is actually pending', () => {
    const { session, outbox } = newSession();
    session.receive({
      grnId: 'grn-6', number: 'GRN-0006', poId: 'po-4', receivedAt: AT,
      lines: [{ productId: 'p-6', quantityMinor: 1, uom: 'ea' }],
    });
    const register = unsentFromOutbox(outbox);
    expect(register.known).toBe(true);
    if (!register.known) return;
    expect(register.items.map((i) => i.what)).toEqual(['GoodsReceived']);
  });

  it('drops an item from the list once it is acknowledged', () => {
    const outbox = new SyncOutbox();
    const stock = new Ledger(new InMemoryLedgerStore());
    const session = createManagerSession(CONFIG, clearPorts(), stock, outbox);
    session.receive({
      grnId: 'grn-7', number: 'GRN-0007', poId: 'po-5', receivedAt: AT,
      lines: [{ productId: 'p-7', quantityMinor: 1, uom: 'ea' }],
    });
    outbox.acknowledge('grn:grn-7');
    const register = unsentFromOutbox(outbox);
    expect(register.known && register.items).toEqual([]);
  });
});

describe('tasks are shown but do not gate the day close', () => {
  it('does not block a close on an unfinished task', () => {
    // M14-FR-04 names exceptions and unsent items. An unfinished shelf-replenishment task is not a
    // reason a day's takings cannot be locked, and adding gates the roadmap does not ask for is how
    // a close nobody can pass gets worked around instead.
    const { session } = newSession(clearPorts({
      tasks: () => ({ known: true, items: items('Aisle 4 not replenished') }),
    }));
    expect(session.blockersForClose(AFTER_CUTOFF)).toEqual([]);
    expect(session.tasks().known).toBe(true);
  });

  it('does not block a close when the task list is unreadable either', () => {
    const { session } = newSession(clearPorts({ tasks: () => notKnown('down') }));
    expect(session.blockersForClose(AFTER_CUTOFF)).toEqual([]);
  });
});

describe('a blocker can be written down in plain English', () => {
  it('has a sentence for every kind', () => {
    // Used by the audit trail and the logs; the SCREEN renders from `kind` in the manager's own
    // language, which is what lets the words be Tamil without the model holding two copies.
    const sentences = [
      blockerSentence({ kind: 'day_not_ended', count: 0, items: [], source: 'trading-day' }),
      blockerSentence({ kind: 'exceptions_open', count: 2, items: [], source: 'exceptions' }),
      blockerSentence({ kind: 'items_unsent', count: 3, items: [], source: 'unsent' }),
      blockerSentence({ kind: 'cannot_see', count: 0, items: [], source: 'exceptions', why: 'no reply' }),
      blockerSentence({ kind: 'rules_refused', count: 0, items: [], source: 'day-close', why: 'nope' }),
    ];
    expect(sentences.every((s) => s.length > 10)).toBe(true);
    expect(sentences[1]).toContain('2');
    expect(sentences[3]).toContain('no reply');
  });
});
