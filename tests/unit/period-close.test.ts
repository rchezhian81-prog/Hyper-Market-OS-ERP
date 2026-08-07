import { describe, it, expect } from 'vitest';
import {
  drainToTally,
  deadLetters,
  requeueCorrected,
  backoffSeconds,
  type QueuedPosting,
  type TallyConnector,
  type TallyOutcome,
} from '../../packages/period-close/src/tally-connector';
import {
  validateControlTotals,
  closePeriod,
  reopenPeriod,
  routeCorrection,
  buildEvidencePack,
  type ControlTotal,
} from '../../packages/period-close/src/period';

// M23-FR-04 acceptance: "a failed Tally posting retries and, if it fails, is VISIBLE IN
// A DEAD-LETTER QUEUE (NOT LOST); period cannot close with unvalidated control totals;
// A CA CAN SIGN THE CONTROL TOTALS."

const queued = (over: Partial<QueuedPosting> = {}): QueuedPosting => ({
  postingId: 'P-1',
  idempotencyKey: 'jv:2026-07:001',
  period: '2026-07',
  journalRef: 'JV-001',
  debitMinor: 100_000,
  creditMinor: 100_000,
  state: 'queued',
  attempts: 0,
  queuedAt: '2026-08-01T02:00:00Z',
  ...over,
});

function connectorReturning(...outcomes: TallyOutcome[]): TallyConnector & { calls: number } {
  const c = {
    version: '1.0.0',
    calls: 0,
    post(): TallyOutcome {
      const outcome = outcomes[Math.min(c.calls, outcomes.length - 1)]!;
      c.calls += 1;
      return outcome;
    },
  };
  return c;
}

describe('Tally is a destination, not the book of record (M23-FR-04)', () => {
  it('posts and records the voucher reference', () => {
    const result = drainToTally([queued()], connectorReturning({ result: 'accepted', voucherRef: 'V-9001' }), '2026-08-01T03:00:00Z');
    expect(result.posted).toBe(1);
    expect(result.postings[0]?.state).toBe('posted');
    expect(result.postings[0]?.voucherRef).toBe('V-9001');
  });

  it('treats a DUPLICATE as done — the payoff of idempotency after a timeout', () => {
    // The classic case: we timed out, retried, and Tally already had it.
    const result = drainToTally([queued({ attempts: 1 })], connectorReturning({ result: 'duplicate', voucherRef: 'V-9001' }), '2026-08-01T03:00:00Z');
    expect(result.posted).toBe(1);
    expect(result.postings[0]?.state).toBe('posted');
    expect(result.postings[0]?.voucherRef).toBe('V-9001');
    // Not a second voucher, and not still trying.
    expect(result.stillQueued).toBe(0);
  });

  it('retries a temporary failure and keeps the item queued, never lost', () => {
    const connector = connectorReturning({ result: 'retryable', reason: 'Tally not responding' });
    const first = drainToTally([queued()], connector, '2026-08-01T03:00:00Z');
    expect(first.posted).toBe(0);
    expect(first.stillQueued).toBe(1);
    expect(first.postings[0]?.attempts).toBe(1);
    expect(first.postings[0]?.lastFailure).toBe('Tally not responding');
    expect(first.deadLettered).toBe(0);
  });

  it('DEAD-LETTERS A REJECTION IMMEDIATELY — it will not become acceptable on the fifth try', () => {
    const connector = connectorReturning({ result: 'rejected', reason: 'ledger "Sundry Debtors - Cafe" does not exist' });
    const result = drainToTally([queued()], connector, '2026-08-01T03:00:00Z');
    expect(result.deadLettered).toBe(1);
    expect(result.postings[0]?.state).toBe('dead_lettered');
    expect(result.postings[0]?.attempts).toBe(1); // not five
    expect(result.postings[0]?.lastFailure).toContain('does not exist');
    // And it only asked once — retrying a permanent rejection buries the real item.
    expect(connector.calls).toBe(1);
  });

  it('dead-letters a retryable failure only after the attempt budget is spent', () => {
    const connector = connectorReturning({ result: 'retryable', reason: 'timeout' });
    let postings: readonly QueuedPosting[] = [queued()];
    for (let i = 0; i < 3; i += 1) {
      postings = drainToTally(postings, connector, '2026-08-01T03:00:00Z', { maxAttempts: 3 }).postings;
    }
    expect(postings[0]?.state).toBe('dead_lettered');
    expect(postings[0]?.lastFailure).toContain('3 attempts');
  });

  it('leaves already-posted and already-dead-lettered items alone', () => {
    const connector = connectorReturning({ result: 'accepted', voucherRef: 'V-1' });
    const result = drainToTally(
      [queued({ postingId: 'P-done', state: 'posted' }), queued({ postingId: 'P-dead', state: 'dead_lettered' })],
      connector,
      '2026-08-01T03:00:00Z',
    );
    expect(connector.calls).toBe(0);
    expect(result.posted).toBe(0);
  });

  it('backs off exponentially, computed rather than slept, and caps', () => {
    expect(backoffSeconds(1)).toBe(30);
    expect(backoffSeconds(2)).toBe(60);
    expect(backoffSeconds(5)).toBe(480);
    expect(backoffSeconds(20)).toBe(3_600);
    expect(backoffSeconds(20, { maxBackoffSeconds: 120 })).toBe(120);
  });
});

describe('the dead-letter queue is read, never drained by deletion (hard rule #6)', () => {
  it('lists failures worst first', () => {
    const list = deadLetters([
      queued({ postingId: 'P-small', state: 'dead_lettered', debitMinor: 1_000 }),
      queued({ postingId: 'P-big', state: 'dead_lettered', debitMinor: 900_000 }),
      queued({ postingId: 'P-ok', state: 'posted' }),
    ]);
    expect(list.map((p) => p.postingId)).toEqual(['P-big', 'P-small']);
  });

  it('requeues a correction as a NEW posting and KEEPS the failure on file', () => {
    const original = queued({ state: 'dead_lettered', lastFailure: 'rejected by Tally: bad ledger name' });
    const result = requeueCorrected({
      original,
      correctedPostingId: 'P-1b',
      correctedIdempotencyKey: 'jv:2026-07:001r',
      fixedBy: 'u-finance',
      reason: 'created the missing ledger in Tally',
      at: '2026-08-02T09:00:00Z',
    });
    expect(result.requeued).toBe(true);
    expect(result.postings).toHaveLength(2);
    // The failure is untouched — evidence that the month was once wrong.
    expect(result.postings[0]).toEqual(original);
    expect(result.postings[1]?.state).toBe('queued');
    expect(result.postings[1]?.attempts).toBe(0);
  });

  it('refuses a "correction" that reuses the old idempotency key', () => {
    const result = requeueCorrected({
      original: queued({ state: 'dead_lettered' }),
      correctedPostingId: 'P-1b',
      correctedIdempotencyKey: 'jv:2026-07:001',
      fixedBy: 'u-finance',
      reason: 'trying again',
      at: '2026-08-02T09:00:00Z',
    });
    expect(result.requeued).toBe(false);
    expect(result.detail).toContain('rejected identically');
  });

  it('refuses a requeue with no reason, and one that is not dead-lettered', () => {
    expect(
      requeueCorrected({ original: queued({ state: 'dead_lettered' }), correctedPostingId: 'x', correctedIdempotencyKey: 'y', fixedBy: 'u', reason: '  ', at: 'z' }).requeued,
    ).toBe(false);
    expect(
      requeueCorrected({ original: queued({ state: 'queued' }), correctedPostingId: 'x', correctedIdempotencyKey: 'y', fixedBy: 'u', reason: 'r', at: 'z' }).requeued,
    ).toBe(false);
  });
});

describe('control totals are computed twice, from two independent sides (QG-07)', () => {
  const totals: ControlTotal[] = [
    { name: 'Net sales', ledgerMinor: 4_820_000, postedMinor: 4_820_000, method: 'sum of SaleCommitted totals vs sum of sales-account credits' },
    { name: 'GST output', ledgerMinor: 241_000, postedMinor: 241_000, method: 'sum of tax components vs sum of tax-account credits' },
    { name: 'Cash banked', ledgerMinor: 1_105_000, postedMinor: 1_105_000, method: 'till declarations vs bank-account debits' },
  ];

  it('reconciles when both sides agree exactly', () => {
    const { results, allReconcile } = validateControlTotals(totals);
    expect(allReconcile).toBe(true);
    expect(results[0]?.detail).toBe('Net sales: 4820000 on both sides');
  });

  it('names the difference and says it must be explained', () => {
    const { results, allReconcile } = validateControlTotals([
      ...totals.slice(0, 2),
      { ...totals[2]!, postedMinor: 1_104_900 },
    ]);
    expect(allReconcile).toBe(false);
    expect(results[2]?.differenceMinor).toBe(-100);
    expect(results[2]?.detail).toContain('must be explained before anyone signs');
  });
});

describe('the period cannot close on unfinished work', () => {
  const totals: ControlTotal[] = [
    { name: 'Net sales', ledgerMinor: 4_820_000, postedMinor: 4_820_000, method: 'ledger vs accounts' },
  ];
  const clean = {
    period: '2026-07',
    tenantId: 't-1',
    totals,
    deadLetteredCount: 0,
    unsentSyncCount: 0,
    openExceptionCount: 0,
    tradingDayCutoff: '23:00 IST',
    closedBy: 'u-finance',
    at: '2026-08-05T10:00:00Z',
  };

  it('closes when everything reconciles and nothing is outstanding', () => {
    const result = closePeriod(clean);
    expect(result.closed).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.detail).toContain('every control total reconciles exactly');
  });

  it('REFUSES on an unreconciled control total', () => {
    const result = closePeriod({ ...clean, totals: [{ ...totals[0]!, postedMinor: 4_819_999 }] });
    expect(result.closed).toBe(false);
    expect(result.blockers[0]?.kind).toBe('control_totals_do_not_reconcile');
    expect(result.blockers[0]?.detail).toContain('tolerates any difference');
  });

  it('REFUSES over a dead-lettered posting — money the accounts never saw', () => {
    const result = closePeriod({ ...clean, deadLetteredCount: 2 });
    expect(result.blockers[0]?.kind).toBe('dead_lettered_postings');
    expect(result.blockers[0]?.detail).toContain('the books have not seen');
  });

  it('REFUSES over unsent sales — they would arrive into a closed period', () => {
    const result = closePeriod({ ...clean, unsentSyncCount: 3 });
    expect(result.blockers[0]?.kind).toBe('unsent_sync_items');
  });

  it('REFUSES over unexplained exceptions', () => {
    const result = closePeriod({ ...clean, openExceptionCount: 1 });
    expect(result.blockers[0]?.detail).toContain('closed by the calendar is not an exception explained');
  });

  it('returns EVERY blocker at once, so finance can plan one day of work', () => {
    const result = closePeriod({
      ...clean,
      totals: [{ ...totals[0]!, postedMinor: 1 }],
      deadLetteredCount: 1,
      unsentSyncCount: 1,
      openExceptionCount: 1,
    });
    expect(result.blockers.map((b) => b.kind)).toEqual([
      'control_totals_do_not_reconcile',
      'dead_lettered_postings',
      'unsent_sync_items',
      'open_exceptions',
    ]);
  });

  it('refuses to close an already-closed period', () => {
    expect(closePeriod(clean, 'closed').blockers[0]?.kind).toBe('already_closed');
  });
});

describe('a closed period is append-only (hard rule #2 / §28)', () => {
  it('will not reopen without an approval', () => {
    const result = reopenPeriod({ period: '2026-07', requestedBy: 'u-finance', at: '2026-08-06T09:00:00Z' });
    expect(result.reopened).toBe(false);
    expect(result.detail).toContain("does not change on one person's say-so");
  });

  it('will not let the requester approve their own reopen', () => {
    const result = reopenPeriod({
      period: '2026-07',
      requestedBy: 'u-finance',
      approval: { subjectRef: '2026-07', status: 'approved', decidedBy: 'u-finance', reason: 'missed an invoice' },
      at: '2026-08-06T09:00:00Z',
    });
    expect(result.reopened).toBe(false);
    expect(result.detail).toContain('cannot be the one who approves it');
  });

  it('reopens with a separate approver and a written reason', () => {
    const result = reopenPeriod({
      period: '2026-07',
      requestedBy: 'u-finance',
      approval: { subjectRef: '2026-07', status: 'approved', decidedBy: 'u-owner', reason: 'supplier credit note received late' },
      at: '2026-08-06T09:00:00Z',
    });
    expect(result.reopened).toBe(true);
    expect(result.state).toBe('open');
    expect(result.detail).toContain('approved by u-owner');
  });

  it('ROUTES A CORRECTION FOR A CLOSED PERIOD INTO THE OPEN ONE', () => {
    const closed = routeCorrection({ forPeriod: '2026-07', forPeriodState: 'closed', openPeriod: '2026-08' });
    expect(closed.postToPeriod).toBe('2026-08');
    expect(closed.detail).toContain('a signed period is never edited');

    const open = routeCorrection({ forPeriod: '2026-08', forPeriodState: 'open', openPeriod: '2026-08' });
    expect(open.postToPeriod).toBe('2026-08');
  });
});

describe('the pack the CA actually signs', () => {
  const totals: ControlTotal[] = [
    { name: 'Net sales', ledgerMinor: 4_820_000, postedMinor: 4_820_000, method: 'sum of SaleCommitted totals vs sales-account credits' },
    { name: 'GST output', ledgerMinor: 241_000, postedMinor: 241_000, method: 'tax components vs tax-account credits' },
  ];

  it('states both sides and where each came from, and is signable', () => {
    const pack = buildEvidencePack({
      period: '2026-07', tenantId: 't-1', totals, tradingDayCutoff: '23:00 IST',
      preparedBy: 'u-finance', at: '2026-08-05T10:00:00Z',
    });
    expect(pack.signable).toBe(true);
    expect(pack.verdict).toContain('signable');
    expect(pack.statement.join(' ')).toContain('computed independently and must agree exactly');
    expect(pack.statement.join(' ')).toContain('sales-account credits');
    expect(pack.statement[pack.statement.length - 1]).toContain('complete for the period');
  });

  it('is STILL PRODUCED when it does not reconcile, and says do not sign it', () => {
    const pack = buildEvidencePack({
      period: '2026-07', tenantId: 't-1',
      totals: [{ ...totals[0]!, postedMinor: 4_800_000 }, totals[1]!],
      tradingDayCutoff: '23:00 IST', preparedBy: 'u-finance', at: '2026-08-05T10:00:00Z',
    });
    expect(pack.signable).toBe(false);
    expect(pack.verdict).toContain('NOT signable');
    expect(pack.statement[pack.statement.length - 1]).toContain('Do not sign them');
  });

  it('is not signable while a posting never reached the accounts, even if the totals agree', () => {
    const pack = buildEvidencePack({
      period: '2026-07', tenantId: 't-1', totals, tradingDayCutoff: '23:00 IST',
      preparedBy: 'u-finance', at: '2026-08-05T10:00:00Z', deadLetteredCount: 1,
    });
    expect(pack.reconciles).toBe(true);
    expect(pack.signable).toBe(false);
    expect(pack.statement.join(' ')).toContain('none has been discarded');
  });
});
