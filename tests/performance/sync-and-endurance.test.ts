import { describe, it, expect } from 'vitest';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { makeEvent } from '../../packages/contracts/src/event';
import { measure, measureComplexity, certifiedHardwareGate, TARGETS } from './harness';

// §32 — sync backlog and offline endurance. NFR-01, NFR-03, P-01, P-08, hard rules #1, #10.
//
// Two targets here have a property the POS ones do not: **their arithmetic can be settled
// without the hardware, even though their wall-clock cannot.**
//
//   • *"Clear a 24-hour peak backlog within 2 hours"* is a ratio. Whether the store's real uplink
//     sustains it needs the store (EX-09), but whether the queue can even be **drained** in
//     backlog order without re-reading itself is ours, and it is the half that fails in code.
//   • *"72 hours offline"* is bounded by the till's real disk. What is not hardware-dependent is
//     whether the outbox stays usable at three days of trading — a queue whose enqueue cost
//     grows with its own depth degrades exactly when the shop most needs it to work, which is on
//     the third day of an outage with nobody watching.
//
// The failure this guards against is specific and quiet: an outbox that reads its whole backlog
// to answer *"how many are unsent?"* is fine at 40 items and unusable at 40,000, and the badge
// that shows it is on the cashier's screen (§27.1, P-08).

const event = (i: number) => makeEvent({
  id: `e-${i}`, type: 'SaleCommitted', occurredAt: '2026-08-05T09:00:00Z',
  idempotencyKey: `sale:${i}`, source: 'lane-1',
  payload: { saleId: `s-${i}`, totalMinor: 2_500 + i, currency: 'INR' },
});

/** A day of trading at this shop's audited rate — replaced by the real figure at AVR-04. */
const BASKETS_PER_DAY = 2_400;

describe('the outbox stays usable at three days of backlog (P-01, 72h)', () => {
  it('enqueues at a cost independent of how deep the queue already is', () => {
    // The quiet failure: an enqueue that walks the queue is fine on day one of an outage and
    // unusable on day three, which is precisely when nobody is watching and the shop is busiest.
    const r = measureComplexity({
      label: 'enqueue-into-a-deep-backlog',
      sizes: [100, 10_000],
      setup: (n) => {
        const outbox = new SyncOutbox();
        for (let i = 0; i < n; i += 1) outbox.enqueue(event(i));
        return { outbox, n };
      },
      operation: (fixture, i) => {
        const { outbox, n } = fixture as { outbox: SyncOutbox; n: number };
        outbox.enqueue(event(n + i + 1));
      },
      runsPerSize: 2_000,
    });
    expect(r.verdict, r.detail).toBe('flat');
  });

  it('deduplicates a replayed event at the same cost, however deep the queue (§31.1)', () => {
    const r = measureComplexity({
      label: 'dedupe-in-a-deep-backlog',
      sizes: [100, 10_000],
      setup: (n) => {
        const outbox = new SyncOutbox();
        for (let i = 0; i < n; i += 1) outbox.enqueue(event(i));
        return { outbox, n };
      },
      operation: (fixture, i) => {
        const { outbox, n } = fixture as { outbox: SyncOutbox; n: number };
        // A re-send of something already queued. This is the common case on a flaky link, not
        // the rare one, so it must not be the expensive one.
        outbox.enqueue(event(i % n));
      },
      runsPerSize: 2_000,
    });
    expect(r.verdict, r.detail).toBe('flat');
  });

  it('holds 72 hours of this shop\'s trading without the queue degrading', () => {
    const threeDays = BASKETS_PER_DAY * 3;
    const outbox = new SyncOutbox();

    const early = measure({
      label: 'enqueue-hour-1', runs: 500, warmup: 50,
      operation: (i) => { outbox.enqueue(event(i)); },
    });
    for (let i = 1_000; i < threeDays; i += 1) outbox.enqueue(event(i));
    const late = measure({
      label: 'enqueue-hour-72', runs: 500, warmup: 50,
      operation: (i) => { outbox.enqueue(event(threeDays + i)); },
    });

    expect(outbox.unsentCount()).toBeGreaterThanOrEqual(threeDays);
    // Day three must not cost meaningfully more per sale than day one. The bar is loose because
    // this is wall-clock on a shared container; what it catches is degradation by an order of
    // magnitude, which is what a linear enqueue looks like at 7,200 items.
    expect(late.p50Ms, `hour 1: ${early.p50Ms}ms, hour 72: ${late.p50Ms}ms`)
      .toBeLessThan(Math.max(early.p50Ms, 1e-4) * 10);
  });

  it('answers the cashier\'s unsent badge without re-reading the whole backlog twice', () => {
    // `unsentCount()` is on the lane's screen (§27.1, P-08) and is called on a timer. Reading the
    // queue to answer it is acceptable; reading it repeatedly per render is not.
    const outbox = new SyncOutbox();
    for (let i = 0; i < 20_000; i += 1) outbox.enqueue(event(i));

    const once = measure({ label: 'unsent-badge', runs: 200, operation: () => { outbox.unsentCount(); } });
    const tenTimes = measure({
      label: 'unsent-badge-x10', runs: 20,
      operation: () => { for (let i = 0; i < 10; i += 1) outbox.unsentCount(); },
    });
    // Ten calls should cost about ten calls — no hidden per-call rebuild of something worse.
    expect(tenTimes.p50Ms).toBeLessThan(Math.max(once.p50Ms, 1e-4) * 20);
  });
});

describe('the 24-hour backlog drains in backlog order, without re-reading itself', () => {
  const peakDay = BASKETS_PER_DAY;

  it('drains a full day of trading, every item exactly once and in order', () => {
    const outbox = new SyncOutbox();
    for (let i = 0; i < peakDay; i += 1) outbox.enqueue(event(i));

    const drained: string[] = [];
    let guard = 0;
    while (outbox.unsentCount() > 0) {
      guard += 1;
      if (guard > peakDay * 2) throw new Error('drain did not converge — the queue is re-reading itself');
      // A realistic batch over a store uplink.
      for (const item of outbox.pending().slice(0, 100)) {
        drained.push(item.key);
        outbox.acknowledge(item.key);
      }
    }

    expect(drained).toHaveLength(peakDay);
    expect(new Set(drained).size).toBe(peakDay);
    // Backlog order, oldest first — a drain that reorders puts a 7am sale behind a 7pm one and
    // makes the cloud's view of the day briefly wrong in a way nobody can reconstruct.
    expect(drained[0]).toBe('sale:0');
    expect(drained[peakDay - 1]).toBe(`sale:${peakDay - 1}`);
    // Batches of 100 over 2,400 items: 24 rounds, not 2,400.
    expect(guard).toBe(Math.ceil(peakDay / 100));
  });

  it('states the drain rate §32 actually requires, rather than implying CI proved it', () => {
    // The arithmetic is ours; the uplink is the store's. Both belong in the record.
    const requiredPerSecond = peakDay / (TARGETS.syncBacklogDrainHours * 3_600);
    expect(requiredPerSecond).toBeCloseTo(0.333, 2);

    const outbox = new SyncOutbox();
    for (let i = 0; i < peakDay; i += 1) outbox.enqueue(event(i));
    const sample = measure({
      label: 'drain-batch-of-100', runs: 20,
      operation: () => { outbox.pending().slice(0, 100); },
    });
    const localPerSecond = 100 / (sample.p50Ms / 1_000);

    // Local queue handling is thousands of times faster than the 0.33/s §32 asks for, so the
    // constraint is the uplink and nothing else. That is a genuinely useful thing to know before
    // buying a connection — and it is NOT the same as having proved the target.
    expect(localPerSecond).toBeGreaterThan(requiredPerSecond * 1_000);
    expect(certifiedHardwareGate().some((g) => g.what.includes('24h peak'))).toBe(true);
  });

  it('does not lose a dead-lettered item from the count of what still needs a person', () => {
    // Hard rule #6 and P-08: a backlog that shrinks because items failed is worse than one that
    // does not shrink, because the badge goes green while the sales are still not in the cloud.
    const outbox = new SyncOutbox();
    for (let i = 0; i < 500; i += 1) outbox.enqueue(event(i));

    for (const item of outbox.pending().slice(0, 10)) {
      for (let attempt = 0; attempt < 5; attempt += 1) outbox.recordFailure(item.key);
      outbox.deadLetter(item.key, 'the cloud rejected this payload five times running');
    }

    const stillPending = outbox.unsentCount();
    const dead = outbox.deadLetters().length;
    expect(dead).toBeGreaterThan(0);
    // Nothing evaporated: everything is either still queued or visibly dead-lettered.
    expect(stillPending + dead).toBe(500);
  });
});
