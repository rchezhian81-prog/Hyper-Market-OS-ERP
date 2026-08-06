import { describe, it, expect } from 'vitest';
import {
  createFinanceSession, CLOSE_REFUSAL_KINDS, REOPEN_REFUSAL_KINDS,
  type FinanceConfig, type FinancePorts,
} from '../../apps/web-erp/src/finance-session';
import { buildControlTotals, postedSide, type QueuedPosting } from '../../packages/period-close/src/index';

/**
 * **Finance: control totals, the Tally queue, and the month close (M23-FR-04 / QG-07).**
 *
 * The roadmap's acceptance is one sentence: *a CA can sign the control totals.* `closePeriod` and
 * `validateControlTotals` have enforced that since they were written — and were **never given a
 * control total**, because nothing in this system built one.
 *
 * The controls under test are the ones that would let a month close on nothing:
 *
 *   • no ledger side means no comparison, and no comparison is not "everything agrees";
 *   • only a posting the accounts ACCEPTED counts as received;
 *   • a dead-lettered posting blocks the close and is never discarded;
 *   • every blocker is reported at once, not one per attempt;
 *   • a closed month is append-only, and reopening needs somebody else.
 */

const NOW = '2026-08-01T10:00:00.000Z';

const posting = (over: Partial<QueuedPosting> = {}): QueuedPosting => ({
  postingId: 'P-1', idempotencyKey: 'k-1', period: '2026-07', journalRef: 'SALES-001',
  debitMinor: 100_000_00, creditMinor: 100_000_00, state: 'posted', attempts: 1,
  queuedAt: '2026-07-31T23:00:00.000Z',
  ...over,
});

const PREFIXES = { takings: 'SALES', tax: 'GST', refunds: 'REFUND' } as const;

/** Both sides agree exactly: the shop took ₹1,00,000 and the accounts received ₹1,00,000. */
const CLEAN: QueuedPosting[] = [
  posting({ postingId: 'P-1', journalRef: 'SALES-001', debitMinor: 100_000_00 }),
  posting({ postingId: 'P-2', journalRef: 'GST-001', debitMinor: 5_000_00 }),
  posting({ postingId: 'P-3', journalRef: 'REFUND-001', debitMinor: 2_000_00 }),
];

const LEDGER = { takingsMinor: 100_000_00, taxMinor: 5_000_00, refundsMinor: 2_000_00, billCount: 412 };

const CONFIG: FinanceConfig = {
  tenantId: 't1', period: '2026-07', userId: 'u-finance', now: NOW,
  tradingDayCutoff: '02:00', journalPrefixes: PREFIXES,
};

function ports(over: Partial<FinancePorts> = {}): FinancePorts {
  return {
    ledger: () => LEDGER,
    postings: () => CLEAN,
    periodState: () => ({ closed: false }),
    unsentSyncCount: () => 0,
    openExceptionCount: () => 0,
    ...over,
  };
}

const finance = (over: Partial<FinancePorts> = {}, config: Partial<FinanceConfig> = {}) =>
  createFinanceSession({ ...CONFIG, ...config }, ports(over));

// ── The producer that never existed ─────────────────────────────────────────

describe('both sides of every figure, computed independently', () => {
  it('states each total twice and says how each side was derived', () => {
    const totals = buildControlTotals({ period: '2026-07', ledger: LEDGER, postings: CLEAN, journalPrefixes: PREFIXES });
    const takings = totals.find((t) => t.name === 'Takings')!;
    expect(takings.ledgerMinor).toBe(100_000_00);
    expect(takings.postedMinor).toBe(100_000_00);
    // A CA has to be able to re-derive it without asking anybody.
    expect(takings.method).toContain('412 bill(s)');
    expect(takings.method).toContain('SALES');
  });

  it('counts ONLY what the accounts accepted — not what is queued', () => {
    // The failure this whole file exists to prevent: counting a queued posting as received makes
    // both sides the same number computed twice, and the month closes with the accounts empty.
    const queued = CLEAN.map((p) => ({ ...p, state: 'queued' as const }));
    const totals = buildControlTotals({ period: '2026-07', ledger: LEDGER, postings: queued, journalPrefixes: PREFIXES });
    expect(totals.find((t) => t.name === 'Takings')?.postedMinor).toBe(0);
  });

  it('does not count a dead-lettered posting as received either', () => {
    const dead = CLEAN.map((p) => ({ ...p, state: 'dead_lettered' as const }));
    const totals = buildControlTotals({ period: '2026-07', ledger: LEDGER, postings: dead, journalPrefixes: PREFIXES });
    expect(totals.find((t) => t.name === 'Takings')?.postedMinor).toBe(0);
  });

  it('splits the queue into accepted, pending and refused', () => {
    const mixed = [
      posting({ postingId: 'A', state: 'posted', debitMinor: 10_00 }),
      posting({ postingId: 'B', state: 'queued', debitMinor: 20_00 }),
      posting({ postingId: 'C', state: 'dead_lettered', debitMinor: 30_00 }),
    ];
    expect(postedSide(mixed)).toEqual({
      acceptedMinor: 10_00, acceptedCount: 1,
      pendingMinor: 20_00, pendingCount: 1,
      deadLetteredMinor: 30_00, deadLetteredCount: 1,
    });
  });

  it('raises a posting nobody can classify as a total of its own', () => {
    // Leaving it out would make the other totals agree while the accounts hold more than the shop
    // can explain. Its ledger side is nought because the shop's record has nothing matching it.
    const odd = [...CLEAN, posting({ postingId: 'P-X', journalRef: 'MISC-999', debitMinor: 7_00 })];
    const totals = buildControlTotals({ period: '2026-07', ledger: LEDGER, postings: odd, journalPrefixes: PREFIXES });
    const stray = totals.find((t) => t.name === 'Postings nobody can classify')!;
    expect(stray.postedMinor).toBe(7_00);
    expect(stray.ledgerMinor).toBe(0);
    expect(stray.method).toContain('MISC-999');
  });

  it('uses the SHOP’s own headings, not headings chosen here', () => {
    const totals = buildControlTotals({
      period: '2026-07', ledger: LEDGER, postings: CLEAN,
      journalPrefixes: { takings: 'NOPE', tax: 'NOPE2', refunds: 'NOPE3' },
    });
    expect(totals.find((t) => t.name === 'Takings')?.postedMinor).toBe(0);
    expect(totals.find((t) => t.name === 'Postings nobody can classify')?.postedMinor).toBe(107_000_00);
  });
});

// ── The month, as finance sees it ───────────────────────────────────────────

describe('the month on the screen', () => {
  it('shows both sides reconciling when they do', () => {
    const view = finance().period();
    expect(view.allReconcile).toBe(true);
    expect(view.totals).toHaveLength(3);
    expect(view.deadLettered).toEqual([]);
  });

  it('has NO totals at all when the shop has not said what it took', () => {
    // Not an empty list. An empty list reconciles vacuously — nothing disagreed because nothing
    // was compared — and that is exactly how a month closes on nothing.
    const view = finance({ ledger: () => undefined }).period();
    expect(view.totals).toBeUndefined();
    expect(view.allReconcile, 'nothing compared was reported as everything agreeing').toBe(false);
    expect(view.whyNoTotals).toContain('one side of a comparison');
  });

  it('reports the queue BESIDE the totals, never inside them', () => {
    const view = finance({
      postings: () => [...CLEAN, posting({ postingId: 'P-Q', journalRef: 'SALES-002', state: 'queued', debitMinor: 9_00 })],
    }).period();
    expect(view.posted.pendingMinor).toBe(9_00);
    // The takings total is unmoved by a posting the accounts have not accepted.
    expect(view.totals?.find((t) => t.name === 'Takings')?.postedMinor).toBe(100_000_00);
  });

  it('lists every dead-lettered posting in full, never summarised away', () => {
    const view = finance({
      postings: () => [...CLEAN, posting({ postingId: 'P-D', journalRef: 'SALES-003', state: 'dead_lettered', lastFailure: 'ledger not found' })],
    }).period();
    expect(view.deadLettered).toHaveLength(1);
    expect(view.deadLettered[0]?.lastFailure).toBe('ledger not found');
  });
});

// ── Closing ─────────────────────────────────────────────────────────────────

describe('a month closes only when it should', () => {
  it('closes when both sides agree and nothing is outstanding', () => {
    const outcome = finance().close();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.closed).toBe(true);
  });

  it('REFUSES when the shop has not said what it took', () => {
    // The refusal an empty list of totals would have hidden.
    const outcome = finance({ ledger: () => undefined }).close();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('the_shop_has_not_told_us_what_it_took');
  });

  it('refuses when the two sides differ, to the paisa', () => {
    const outcome = finance({ ledger: () => ({ ...LEDGER, takingsMinor: 100_000_01 }) }).close();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.result?.blockers.some((b) => b.kind === 'control_totals_do_not_reconcile')).toBe(true);
  });

  it('refuses over a dead-lettered posting — money the accounts have never seen', () => {
    const outcome = finance({
      postings: () => [...CLEAN, posting({ postingId: 'P-D', journalRef: 'SALES-003', state: 'dead_lettered' })],
    }).close();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.result?.blockers.some((b) => b.kind === 'dead_lettered_postings')).toBe(true);
  });

  it('reports EVERY blocker at once, not one per attempt', () => {
    // A finance team meeting obstacles one at a time on the last day of the month starts looking
    // for a way round the system, and finds one.
    const outcome = finance({
      ledger: () => ({ ...LEDGER, takingsMinor: 1 }),
      postings: () => [...CLEAN, posting({ postingId: 'P-D', journalRef: 'SALES-003', state: 'dead_lettered' })],
      unsentSyncCount: () => 3,
      openExceptionCount: () => 2,
    }).close();
    if (outcome.ok) return;
    expect(outcome.result?.blockers.map((b) => b.kind).sort()).toEqual([
      'control_totals_do_not_reconcile', 'dead_lettered_postings', 'open_exceptions', 'unsent_sync_items',
    ]);
  });

  it('closes nothing when the box does not know who is asking', () => {
    const outcome = finance({}, { userId: null }).close();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('nobody_is_named_at_this_desk');
    expect(CLOSE_REFUSAL_KINDS).toHaveLength(3);
  });

  it('refuses to close a month that is already closed', () => {
    const outcome = finance({ periodState: () => ({ closed: true, closedBy: 'u-other' }) }).close();
    if (outcome.ok) return;
    expect(outcome.result?.blockers.some((b) => b.kind === 'already_closed')).toBe(true);
  });
});

// ── The pack a CA signs ─────────────────────────────────────────────────────

describe('the pack somebody puts their name to', () => {
  it('is signable when everything reconciles, and states both sides of every figure', () => {
    const pack = finance().evidence();
    expect(pack.signable).toBe(true);
    if (!('statement' in pack)) return;
    expect(pack.statement.join(' ')).toContain('computed independently and must agree exactly');
    expect(pack.verdict).toContain('signable');
  });

  it('is still produced when it does NOT reconcile, and says do not sign', () => {
    // Hiding it would only mean the conversation happens later.
    const pack = finance({ ledger: () => ({ ...LEDGER, taxMinor: 1 }) }).evidence();
    expect(pack.signable).toBe(false);
    if (!('statement' in pack)) return;
    expect(pack.statement.join(' ')).toContain('Do not sign them');
  });

  it('is not signable while a posting is dead-lettered, and says how many', () => {
    const pack = finance({
      postings: () => [...CLEAN, posting({ postingId: 'P-D', journalRef: 'SALES-003', state: 'dead_lettered' })],
    }).evidence();
    expect(pack.signable).toBe(false);
    if (!('statement' in pack)) return;
    expect(pack.statement.join(' ')).toContain('never reached the accounts');
    expect(pack.statement.join(' ')).toContain('none has been discarded');
  });

  it('refuses to produce a pack at all with nothing to compare', () => {
    const pack = finance({ ledger: () => undefined }).evidence();
    expect(pack.signable).toBe(false);
    if ('statement' in pack) return;
    expect(pack.why).toContain('one side of a comparison');
  });
});

// ── Reopening ───────────────────────────────────────────────────────────────

describe('a closed month is append-only', () => {
  const closed = (over: Partial<FinancePorts> = {}) =>
    finance({ periodState: () => ({ closed: true, closedBy: 'u-other', closedAt: NOW }), ...over });

  it('reopens with a reason and somebody else’s approval', () => {
    const outcome = closed().reopen({ reason: 'supplier credit note arrived late', approvedBy: 'u-boss' });
    expect(outcome.ok).toBe(true);
  });

  it('refuses when the person reopening is the one approving it', () => {
    const outcome = closed().reopen({ reason: 'late note', approvedBy: 'u-finance' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('needs_a_different_person');
    expect(outcome.detail).toContain('§28');
  });

  it('needs a reason — it is the first thing an auditor asks', () => {
    const outcome = closed().reopen({ reason: '  ', approvedBy: 'u-boss' });
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('needs_a_reason');
  });

  it('refuses to reopen a month that is not closed', () => {
    const outcome = finance().reopen({ reason: 'x', approvedBy: 'u-boss' });
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('not_closed');
    expect(REOPEN_REFUSAL_KINDS).toHaveLength(4);
  });

  it('reopens nothing when the box does not know who is asking', () => {
    const outcome = closed().reopen({ reason: 'x', approvedBy: 'u-boss' });
    expect(outcome.ok).toBe(true);
    const anonymous = finance(
      { periodState: () => ({ closed: true }) }, { userId: null },
    ).reopen({ reason: 'x', approvedBy: 'u-boss' });
    expect(anonymous.ok).toBe(false);
    if (anonymous.ok) return;
    expect(anonymous.refusal).toBe('nobody_is_named_at_this_desk');
  });
});
