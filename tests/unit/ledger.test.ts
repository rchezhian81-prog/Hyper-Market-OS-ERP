import { describe, it, expect } from 'vitest';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { makeEvent } from '../../packages/contracts/src/event';

// The append-only ledger is the engine behind hard rule #2 (balances are
// projected from events, never overwritten) and §31.1 (idempotent replay,
// corrections are compensating entries). Modelled here on a stock balance
// (M08-FR-01): each event carries a signed delta in minor units.

interface Move {
  deltaMinor: number;
}

function moveEvent(id: string, key: string, deltaMinor: number) {
  return makeEvent<'InventoryMoved', Move>({
    id,
    type: 'InventoryMoved',
    occurredAt: '2026-08-02T09:30:00Z',
    idempotencyKey: key,
    source: 'store-edge',
    payload: { deltaMinor },
  });
}

const sumDeltas = (state: number, event: { payload: Move }): number =>
  state + event.payload.deltaMinor;

describe('append-only ledger', () => {
  it('projects a balance from the events (a balance is never stored)', () => {
    const ledger = new Ledger<'InventoryMoved', Move>(new InMemoryLedgerStore());
    ledger.append(moveEvent('e1', 'recv-1', 1000));
    ledger.append(moveEvent('e2', 'sale-1', -250));
    expect(ledger.project(0, sumDeltas)).toBe(750);
    expect(ledger.entries().map((r) => r.seq)).toEqual([1, 2]);
  });

  it('is idempotent: replaying an event collapses to one effect (§31.1)', () => {
    const ledger = new Ledger<'InventoryMoved', Move>(new InMemoryLedgerStore());
    ledger.append(moveEvent('e1', 'sale-1', -250));
    const replay = ledger.append(moveEvent('e1', 'sale-1', -250));
    expect(replay.deduped).toBe(true);
    expect(ledger.entries()).toHaveLength(1);
    expect(ledger.project(0, sumDeltas)).toBe(-250);
  });

  it('corrects via a new compensating entry, never by editing history', () => {
    const ledger = new Ledger<'InventoryMoved', Move>(new InMemoryLedgerStore());
    ledger.append(moveEvent('e1', 'adj-1', 1000));
    ledger.append(moveEvent('e2', 'adj-1-correction', -100));
    expect(ledger.entries()).toHaveLength(2);
    expect(ledger.project(0, sumDeltas)).toBe(900);
  });

  it('records are immutable and reads do not expose the internal store', () => {
    const ledger = new Ledger<'InventoryMoved', Move>(new InMemoryLedgerStore());
    ledger.append(moveEvent('e1', 'k1', 5));
    const first = ledger.entries()[0];
    if (!first) throw new Error('expected a record');
    expect(Object.isFrozen(first)).toBe(true);
    // each read returns a fresh copy, so a caller cannot mutate the ledger
    expect(ledger.entries()).not.toBe(ledger.entries());
  });

  it('the store rejects a duplicate append defensively', () => {
    const store = new InMemoryLedgerStore<'InventoryMoved', Move>();
    store.append(moveEvent('e1', 'k1', 5));
    expect(() => store.append(moveEvent('e2', 'k1', 5))).toThrow();
  });
});
