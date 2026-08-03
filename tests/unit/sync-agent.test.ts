import { describe, it, expect } from 'vitest';
import { SyncAgent, nextDelayMs, type SyncTransport, type SendOutcome } from '../../edge/sync-agent/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { makeEvent } from '../../packages/contracts/src/event';

// The sync agent drains the offline queue in order, idempotently, and never drops
// work: transient failures stay queued, permanent ones become visible dead-letters
// (§31 / hard rules #6 and #10).

const AT = '2026-08-02T12:00:00Z';

function ev(id: string) {
  return makeEvent({
    id,
    type: 'SaleCommitted',
    occurredAt: AT,
    idempotencyKey: `sale:${id}`,
    source: 'lane-1',
    payload: { saleId: id },
  });
}

/** A transport programmed with an outcome per call, recording what it was sent. */
class FakeTransport implements SyncTransport {
  readonly sent: string[] = [];
  private readonly outcomes: SendOutcome[] = [];
  private fallback: SendOutcome = { status: 'accepted' };

  program(...outcomes: SendOutcome[]): this {
    this.outcomes.push(...outcomes);
    return this;
  }
  always(outcome: SendOutcome): this {
    this.fallback = outcome;
    return this;
  }
  send(event: { id: string }): Promise<SendOutcome> {
    this.sent.push(event.id);
    return Promise.resolve(this.outcomes.shift() ?? this.fallback);
  }
}

function queued(count: number): SyncOutbox {
  const outbox = new SyncOutbox();
  for (let i = 1; i <= count; i += 1) outbox.enqueue(ev(`e${i}`));
  return outbox;
}

describe('SyncAgent.drain', () => {
  it('delivers pending items in enqueue order and clears the queue', async () => {
    const outbox = queued(3);
    const transport = new FakeTransport();
    const agent = new SyncAgent(outbox, transport);

    const result = await agent.drain({ at: AT });
    expect(transport.sent).toEqual(['e1', 'e2', 'e3']); // cause precedes effect
    expect(result.acknowledged).toBe(3);
    expect(result.remaining).toBe(0);
    expect(outbox.unsentCount()).toBe(0);
  });

  it('keeps a transiently-failed item queued for a later pass', async () => {
    const outbox = queued(1);
    const transport = new FakeTransport().always({ status: 'retryable', reason: 'offline' });
    const agent = new SyncAgent(outbox, transport);

    const first = await agent.drain({ at: AT });
    expect(first.acknowledged).toBe(0);
    expect(first.retryable).toBe(1);
    expect(outbox.unsentCount()).toBe(1); // still queued — never dropped

    // when the link returns, the next pass delivers it
    const back = new SyncAgent(outbox, new FakeTransport());
    const second = await back.drain({ at: AT });
    expect(second.acknowledged).toBe(1);
    expect(outbox.unsentCount()).toBe(0);
  });

  it('dead-letters a permanently rejected item (visible, never discarded)', async () => {
    const outbox = queued(1);
    const transport = new FakeTransport().always({ status: 'rejected', reason: 'schema invalid' });
    const agent = new SyncAgent(outbox, transport);

    const result = await agent.drain({ at: AT });
    expect(result.deadLettered).toBe(1);
    expect(outbox.deadLetters()).toHaveLength(1);
    expect(outbox.deadLetters()[0]?.reason).toBe('schema invalid');
    expect(outbox.unsentCount()).toBe(0); // out of the queue, but retained
  });

  it('treats a cloud conflict as an exception, not a silent overwrite (#10)', async () => {
    const outbox = queued(1);
    const transport = new FakeTransport().always({ status: 'rejected', reason: 'conflict: version mismatch' });
    const agent = new SyncAgent(outbox, transport);

    await agent.drain({ at: AT });
    expect(outbox.deadLetters()[0]?.reason).toContain('conflict');
  });

  it('dead-letters an item that exhausts its attempt budget', async () => {
    const outbox = queued(1);
    const transport = new FakeTransport().always({ status: 'retryable', reason: 'timeout' });
    const agent = new SyncAgent(outbox, transport);

    // three passes with maxAttempts 3 → the third exhausts the budget
    await agent.drain({ at: AT, maxAttempts: 3 });
    await agent.drain({ at: AT, maxAttempts: 3 });
    expect(outbox.unsentCount()).toBe(1);
    const last = await agent.drain({ at: AT, maxAttempts: 3 });
    expect(last.deadLettered).toBe(1);
    expect(outbox.deadLetters()[0]?.reason).toContain('retry limit reached');
  });

  it('stops the pass early when the link looks down instead of hammering it', async () => {
    const outbox = queued(10);
    const transport = new FakeTransport().always({ status: 'retryable', reason: 'offline' });
    const agent = new SyncAgent(outbox, transport);

    const result = await agent.drain({ at: AT, stopAfterConsecutiveFailures: 2 });
    expect(result.stoppedEarly).toBe(true);
    expect(result.attempted).toBe(2); // gave up after 2 consecutive failures
    expect(outbox.unsentCount()).toBe(10); // nothing lost
  });

  it('treats an unexpected transport error as transient — work is never lost', async () => {
    const outbox = queued(1);
    const throwing: SyncTransport = {
      send: () => Promise.reject(new Error('socket closed')),
    };
    const agent = new SyncAgent(outbox, throwing);

    const result = await agent.drain({ at: AT });
    expect(result.retryable).toBe(1);
    expect(outbox.unsentCount()).toBe(1); // still queued
  });

  it('a duplicate delivery is accepted once — a replay collapses to one effect', async () => {
    const outbox = queued(1);
    // the cloud dedupes on the idempotency key and reports the replay as accepted
    const transport = new FakeTransport().program({ status: 'retryable', reason: 'timeout' }, { status: 'accepted' });
    const agent = new SyncAgent(outbox, transport);

    await agent.drain({ at: AT }); // ambiguous failure — may have landed
    await agent.drain({ at: AT }); // retry: accepted (deduped in the cloud)
    expect(transport.sent).toEqual(['e1', 'e1']);
    expect(outbox.unsentCount()).toBe(0);
    expect(outbox.deadLetters()).toHaveLength(0);
  });

  it('bounds a pass with the limit', async () => {
    const outbox = queued(5);
    const agent = new SyncAgent(outbox, new FakeTransport());
    const result = await agent.drain({ at: AT, limit: 2 });
    expect(result.attempted).toBe(2);
    expect(result.remaining).toBe(3);
  });

  it('reports honest sync health', async () => {
    const outbox = queued(2);
    const transport = new FakeTransport().program({ status: 'accepted' }, { status: 'rejected', reason: 'bad' });
    const agent = new SyncAgent(outbox, transport);

    expect(agent.health()).toEqual({ unsentCount: 2, deadLetterCount: 0, lastSuccessAt: null });
    await agent.drain({ at: AT });
    expect(agent.health()).toEqual({ unsentCount: 0, deadLetterCount: 1, lastSuccessAt: AT });
  });
});

describe('nextDelayMs', () => {
  it('backs off exponentially and caps', () => {
    expect(nextDelayMs(0)).toBe(1000);
    expect(nextDelayMs(1)).toBe(2000);
    expect(nextDelayMs(3)).toBe(8000);
    expect(nextDelayMs(100)).toBe(300_000); // capped at 5 minutes
  });

  it('rejects a negative attempt count', () => {
    expect(() => nextDelayMs(-1)).toThrow(RangeError);
  });
});
