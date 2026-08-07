import { describe, it, expect } from 'vitest';
import {
  createExpirySession, START_REFUSAL_KINDS, CLOSE_REFUSAL_KINDS,
  type ExpiryConfig, type ExpiryPorts, type RecallRecord,
} from '../../apps/web-erp/src/expiry-session';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { makeEvent } from '../../packages/contracts/src/event';
import type { Batch } from '../../packages/fefo/src/index';

/**
 * **Expiry and recall (M10-FR-01…04).**
 *
 * `allocateFefo`, `expiryActions` and `traceBatch` were written and tested and called by nothing.
 * The controls under test are the ones somebody under pressure would want to skip:
 *
 *   • the oldest stock goes out first, and expired stock goes out to nobody;
 *   • a recall says how much is **still in customers' homes**, not just how much is on the shelf;
 *   • a recall cannot be closed without evidence, and cannot be quietly closed with stock missing;
 *   • the shop is told how many buyers it can actually contact, and how many it cannot.
 */

const NOW = '2026-08-06T14:00:00.000Z';

const BATCHES: Batch[] = [
  { batchId: 'B-OLD', productId: 'p1', qty: 10, expiry: '2026-08-04' },   // expired
  { batchId: 'B-SOON', productId: 'p1', qty: 20, expiry: '2026-08-09' },  // 3 days
  { batchId: 'B-FAR', productId: 'p1', qty: 30, expiry: '2026-12-01' },   // far off
  { batchId: 'B-HELD', productId: 'p2', qty: 5, expiry: '2026-08-07', state: 'quarantine' },
];

/** A ledger carrying one batch in and three sales out, one of them to a named customer. */
function ledgerWithTrace(): Ledger {
  const ledger = new Ledger(new InMemoryLedgerStore());
  ledger.append(makeEvent({
    id: 'e-in', type: 'GoodsReceived', occurredAt: '2026-08-01T09:00:00.000Z',
    idempotencyKey: 'k-in', source: 'grn-1',
    payload: { batchId: 'B-SOON', deltaMinor: 20, grnId: 'GRN-1' },
  }));
  ledger.append(makeEvent({
    id: 'e-s1', type: 'StockMoved', occurredAt: '2026-08-03T10:00:00.000Z',
    idempotencyKey: 'k-s1', source: 'lane-1',
    payload: { batchId: 'B-SOON', deltaMinor: -3, saleId: 'S-1', customerId: 'cust-1' },
  }));
  ledger.append(makeEvent({
    id: 'e-s2', type: 'StockMoved', occurredAt: '2026-08-04T10:00:00.000Z',
    idempotencyKey: 'k-s2', source: 'lane-1',
    payload: { batchId: 'B-SOON', deltaMinor: -5, saleId: 'S-2' },
  }));
  ledger.append(makeEvent({
    id: 'e-s3', type: 'StockMoved', occurredAt: '2026-08-05T10:00:00.000Z',
    idempotencyKey: 'k-s3', source: 'lane-1',
    payload: { batchId: 'B-SOON', deltaMinor: -2, saleId: 'S-3' },
  }));
  return ledger;
}

const CONFIG: ExpiryConfig = {
  tenantId: 't1', storeId: 'store-1', userId: 'u-qc', now: NOW, nearExpiryDays: 7,
};

function ports(over: Partial<ExpiryPorts> = {}): ExpiryPorts {
  const ledger = ledgerWithTrace();
  return {
    batches: () => BATCHES,
    ledger: () => ledger,
    recalls: () => [],
    productNames: () => ({ p1: 'Toor dal 1kg', p2: 'Milk 1L' }),
    ...over,
  };
}

const desk = (over: Partial<ExpiryPorts> = {}, config: Partial<ExpiryConfig> = {}) =>
  createExpirySession({ ...CONFIG, ...config }, ports(over));

const STARTED: RecallRecord = {
  recallId: 'RC-1', batchId: 'B-SOON', productId: 'p1', reason: 'supplier notice: glass',
  startedBy: 'u-qc', startedAt: '2026-08-06T09:00:00.000Z',
};

// ── Expiry ──────────────────────────────────────────────────────────────────

describe('what is going out of date, earliest first', () => {
  it('lists expired stock to dispose and near-expiry stock to mark down', () => {
    const list = desk().actionList();
    expect(list.map((l) => l.batchId)).toEqual(['B-OLD', 'B-SOON']);
    expect(list[0]?.action).toBe('dispose');
    expect(list[0]?.status).toBe('expired');
    expect(list[1]?.action).toBe('markdown');
    expect(list[1]?.daysToExpiry).toBe(3);
  });

  it('shows the product’s name, not its code — this is a screen about food', () => {
    expect(desk().actionList()[0]?.name).toBe('Toor dal 1kg');
  });

  it('falls back to the code rather than hiding a batch it cannot name', () => {
    expect(desk({ productNames: () => undefined }).actionList()[0]?.name).toBe('p1');
  });

  it('leaves out stock that is already held for another reason', () => {
    // Quarantined stock is not sellable anyway; listing it here would send somebody to mark down
    // something they cannot sell.
    expect(desk().actionList().some((l) => l.batchId === 'B-HELD')).toBe(false);
  });

  it('uses the SHOP’s own near-expiry window, not a constant', () => {
    // A shop taking a delivery daily and one taking it twice a week need different numbers.
    expect(desk({}, { nearExpiryDays: 1 }).actionList().map((l) => l.batchId)).toEqual(['B-OLD']);
    expect(desk({}, { nearExpiryDays: 200 }).actionList().map((l) => l.batchId))
      .toEqual(['B-OLD', 'B-SOON', 'B-FAR']);
  });

  it('draws the earliest expiry first, and never draws expired stock', () => {
    const result = desk().wouldAllocate('p1', 25);
    expect(result.allocated.map((a) => a.batchId)).toEqual(['B-SOON', 'B-FAR']);
    expect(result.allocated.some((a) => a.batchId === 'B-OLD'), 'expired stock was allocated').toBe(false);
    expect(result.fullyAllocated).toBe(true);
  });

  it('reports a shortfall rather than over-promising', () => {
    const result = desk().wouldAllocate('p1', 100);
    expect(result.shortfallQty).toBe(50);
    expect(result.fullyAllocated).toBe(false);
  });
});

// ── Starting a recall ───────────────────────────────────────────────────────

describe('starting a recall', () => {
  it('starts one and immediately says how much is still out there', () => {
    const outcome = desk().start({ recallId: 'RC-1', batchId: 'B-SOON', reason: 'supplier notice' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 10 units sold off this batch and none recovered yet.
    expect(outcome.view.stillOutThere).toBe(10);
    expect(outcome.view.trace.receivedQty).toBe(20);
    expect(outcome.recall.startedBy).toBe('u-qc');
  });

  it('says how many buyers can be contacted and how many cannot', () => {
    // A shop that can contact one of three buyers needs to know it is one of three — the other
    // two are the reason for a notice on the door.
    const outcome = desk().start({ recallId: 'RC-1', batchId: 'B-SOON', reason: 'glass' });
    if (!outcome.ok) return;
    expect(outcome.view.identifiedCustomers).toBe(1);
    expect(outcome.view.anonymousSales).toBe(2);
    expect(outcome.view.soldOn).toHaveLength(3);
  });

  it('needs a reason, because it is the first thing anybody asks afterwards', () => {
    const outcome = desk().start({ recallId: 'RC-1', batchId: 'B-SOON', reason: '   ' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('needs_a_reason');
    expect(outcome.detail).toContain('inspector');
  });

  it('refuses a batch this box has never heard of', () => {
    const outcome = desk().start({ recallId: 'RC-1', batchId: 'B-NOPE', reason: 'glass' });
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('no_such_batch');
    expect(outcome.detail).toContain('code on the packaging');
  });

  it('refuses to start the same recall twice, which would split the evidence', () => {
    const outcome = desk({ recalls: () => [STARTED] })
      .start({ recallId: 'RC-2', batchId: 'B-SOON', reason: 'glass' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('already_recalled');
    expect(outcome.detail).toContain('u-qc');
  });

  it('allows a NEW recall on a batch whose earlier one is closed', () => {
    const closed: RecallRecord = {
      ...STARTED,
      closure: { closedBy: 'u-qc', closedAt: NOW, evidence: 'destroyed', recoveredQty: 10, disposedQty: 0 },
    };
    expect(desk({ recalls: () => [closed] })
      .start({ recallId: 'RC-2', batchId: 'B-SOON', reason: 'second notice' }).ok).toBe(true);
  });

  it('starts nothing when the box does not know who is asking', () => {
    const outcome = desk({}, { userId: null })
      .start({ recallId: 'RC-1', batchId: 'B-SOON', reason: 'glass' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('nobody_is_named_at_this_desk');
    expect(START_REFUSAL_KINDS).toHaveLength(4);
  });
});

// ── Closing one ─────────────────────────────────────────────────────────────

describe('a recall is not finished when it is started', () => {
  const withOpen = (over: Partial<ExpiryPorts> = {}) => desk({ recalls: () => [STARTED], ...over });

  it('closes when the stock is accounted for and there is evidence', () => {
    const outcome = withOpen().close({
      recallId: 'RC-1', evidence: 'collected by supplier, note 4471', recoveredQty: 6, disposedQty: 4,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.recall.closure?.closedBy).toBe('u-qc');
    expect(outcome.recall.closure?.evidence).toContain('note 4471');
  });

  it('refuses to close with no evidence — that is a recall nobody did', () => {
    const outcome = withOpen().close({ recallId: 'RC-1', evidence: '  ', recoveredQty: 10, disposedQty: 0 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('needs_evidence');
    expect(outcome.detail).toContain('what was actually done');
  });

  it('refuses to close quietly while stock is unaccounted for', () => {
    // Blocking the till is the easy half. This is the half that gets skipped.
    const outcome = withOpen().close({
      recallId: 'RC-1', evidence: 'collected what we could', recoveredQty: 2, disposedQty: 0,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('stock_not_accounted_for');
    expect(outcome.detail).toContain('8 of this batch');
    expect(outcome.detail).toContain("customers' homes");
  });

  it('allows it WITH a reason, because in a real recall some of it is eaten', () => {
    const outcome = withOpen().close({
      recallId: 'RC-1', evidence: 'collected what we could', recoveredQty: 2, disposedQty: 0,
      acceptUnrecovered: 'notice placed on the door and in the paper; 8 not traceable',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The reason goes INTO the record, because the record is all that exists afterwards.
    expect(outcome.recall.closure?.evidence).toContain('8 unaccounted for');
    expect(outcome.recall.closure?.evidence).toContain('notice placed on the door');
  });

  it('refuses to close one that is already closed, rather than editing it', () => {
    const closed: RecallRecord = {
      ...STARTED,
      closure: { closedBy: 'u-boss', closedAt: '2026-08-06T10:00:00.000Z', evidence: 'done', recoveredQty: 10, disposedQty: 0 },
    };
    const outcome = desk({ recalls: () => [closed] })
      .close({ recallId: 'RC-1', evidence: 'again', recoveredQty: 0, disposedQty: 0 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('already_closed');
    expect(outcome.detail).toContain('never an edit');
  });

  it('refuses a recall that does not exist', () => {
    const outcome = withOpen().close({ recallId: 'RC-NOPE', evidence: 'x', recoveredQty: 0, disposedQty: 0 });
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('no_such_recall');
  });

  it('closes nothing when the box does not know who is asking', () => {
    const outcome = withOpen().close({ recallId: 'RC-1', evidence: 'x', recoveredQty: 10, disposedQty: 0 });
    expect(outcome.ok).toBe(true);
    const anonymous = desk({ recalls: () => [STARTED] }, { userId: null })
      .close({ recallId: 'RC-1', evidence: 'x', recoveredQty: 10, disposedQty: 0 });
    expect(anonymous.ok).toBe(false);
    if (anonymous.ok) return;
    expect(anonymous.refusal).toBe('nobody_is_named_at_this_desk');
    expect(CLOSE_REFUSAL_KINDS).toHaveLength(5);
  });

  it('puts open recalls at the top, because nothing on any screen is more urgent', () => {
    const closed: RecallRecord = {
      ...STARTED, recallId: 'RC-0', startedAt: '2026-08-07T09:00:00.000Z',
      closure: { closedBy: 'u-qc', closedAt: NOW, evidence: 'done', recoveredQty: 10, disposedQty: 0 },
    };
    const list = desk({ recalls: () => [closed, STARTED] }).recalls();
    expect(list[0]?.recall.recallId).toBe('RC-1');
    expect(list[0]?.open).toBe(true);
  });
});
