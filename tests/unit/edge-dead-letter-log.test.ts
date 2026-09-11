import { describe, it, expect } from 'vitest';
import {
  serialiseDeadLetter, parseDeadLetter, foldDeadLetters, unresolvedKeys,
  type DeadLetterEntry,
} from '../../edge/store-edge/src/dead-letter-log';
import { makeEvent } from '../../packages/contracts/src/event';

// RR-F06 — the durable failed-sync store, folded from an append-only sequence of facts. This is the
// piece that keeps a dead-lettered sale or refund — its payload, reason, attempts and full history —
// across a restart, instead of losing it with the in-memory outbox (hard rule #6).

const event = (id: string) => makeEvent({
  id, type: 'SaleCommitted', occurredAt: '2026-09-11T10:00:00Z',
  idempotencyKey: `edge-t-${id}`, source: 'edge/lane', payload: { saleId: id, totalMinor: 10_000 },
});

const entry = (over: Partial<DeadLetterEntry> & { key: string; at: string }): DeadLetterEntry => ({
  kind: 'dead_lettered', event: event(over.key), reason: 'the cloud answered 400', attempts: 1,
  ...over,
});

describe('the durable dead-letter store folds its facts (RR-F06)', () => {
  it('round-trips one fact through serialise and parse', () => {
    const e = entry({ key: 'edge-t-S1', at: '2026-09-11T10:01:00Z' });
    const parsed = parseDeadLetter(serialiseDeadLetter(e));
    expect(parsed).toEqual(e);
  });

  it('keeps payload, reason, attempts and the first-failed time', () => {
    const state = foldDeadLetters([
      serialiseDeadLetter(entry({ key: 'edge-t-S1', at: '2026-09-11T10:01:00Z', attempts: 3, reason: 'retry limit reached: the cloud answered 500' })),
    ]);
    const s = state.get('edge-t-S1')!;
    expect(s.attempts).toBe(3);
    expect(s.reason).toContain('retry limit');
    expect(s.firstFailedAt).toBe('2026-09-11T10:01:00Z');
    expect(s.status).toBe('dead_lettered');
    expect((s.event.payload as { saleId: string }).saleId).toBe('edge-t-S1');
  });

  it('keeps the WHOLE history when a key is written more than once, and the latest state wins', () => {
    // A failure, then a re-failure with a higher attempt count, then a person resolving it. All three
    // facts are kept (the resolution history); the visible status is the latest.
    const state = foldDeadLetters([
      serialiseDeadLetter(entry({ key: 'edge-t-S1', at: '2026-09-11T10:01:00Z', attempts: 1 })),
      serialiseDeadLetter(entry({ key: 'edge-t-S1', at: '2026-09-11T10:05:00Z', attempts: 5, reason: 'retry limit reached' })),
      serialiseDeadLetter(entry({ key: 'edge-t-S1', at: '2026-09-11T11:00:00Z', kind: 'resolved', reason: 'manager re-keyed it by hand' })),
    ]);
    const s = state.get('edge-t-S1')!;
    expect(s.history).toHaveLength(3);
    expect(s.firstFailedAt).toBe('2026-09-11T10:01:00Z');
    expect(s.lastUpdatedAt).toBe('2026-09-11T11:00:00Z');
    expect(s.attempts).toBe(5); // the high-water attempt count, never reset downward
    expect(s.status).toBe('resolved');
    expect(s.reason).toBe('manager re-keyed it by hand');
  });

  it('lists only the keys still needing a person', () => {
    const state = foldDeadLetters([
      serialiseDeadLetter(entry({ key: 'edge-t-A', at: '2026-09-11T10:00:00Z' })),
      serialiseDeadLetter(entry({ key: 'edge-t-B', at: '2026-09-11T10:00:00Z' })),
      serialiseDeadLetter(entry({ key: 'edge-t-B', at: '2026-09-11T12:00:00Z', kind: 'resolved', reason: 'done' })),
    ]);
    expect([...unresolvedKeys(state)].sort()).toEqual(['edge-t-A']);
  });

  it('skips an unreadable or truncated fact rather than guessing it (hard rule #6)', () => {
    expect(parseDeadLetter('{ not json')).toBeUndefined();
    expect(parseDeadLetter('{"key":"k"}')).toBeUndefined(); // missing kind/event/at
    const state = foldDeadLetters([
      '{ half a record',
      serialiseDeadLetter(entry({ key: 'edge-t-S1', at: '2026-09-11T10:00:00Z' })),
    ]);
    expect([...state.keys()]).toEqual(['edge-t-S1']); // the good one is kept; the bad one is dropped, not guessed
  });
});
