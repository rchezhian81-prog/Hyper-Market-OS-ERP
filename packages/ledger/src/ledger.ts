// Append-only ledger — the engine behind hard rule #2 (ledgers are append-only;
// balances are PROJECTED from events, never overwritten) and §31.1 idempotency
// (a replayed event collapses to one effect; conflicts surface as exceptions,
// never last-write-wins). It is storage-agnostic: callers provide a LedgerStore
// (in-memory here, for tests and the store-edge cache; a database-backed store
// lands with the persistence layer). This module never changes or removes an
// entry — a correction is a new compensating entry (M08-FR-01 / M08-FR-03).

import type { DomainEvent } from '../../contracts/src/event';

/** An appended, immutable ledger record: a domain event plus its sequence. */
export interface LedgerRecord<TType extends string = string, TPayload = unknown> {
  /** Monotonic append sequence (1-based), assigned by the store. */
  readonly seq: number;
  /** The immutable domain event (§30.2). */
  readonly event: DomainEvent<TType, TPayload>;
}

/**
 * Storage for an append-only ledger. Implementations MUST be append-only: there
 * is deliberately no operation to change or remove a stored record.
 */
export interface LedgerStore<TType extends string = string, TPayload = unknown> {
  append(event: DomainEvent<TType, TPayload>): LedgerRecord<TType, TPayload>;
  findByIdempotencyKey(key: string): LedgerRecord<TType, TPayload> | undefined;
  all(): readonly LedgerRecord<TType, TPayload>[];
}

/** Result of an append: the stored record, and whether it was a replay (deduped). */
export interface AppendResult<TType extends string = string, TPayload = unknown> {
  readonly record: LedgerRecord<TType, TPayload>;
  readonly deduped: boolean;
}

/**
 * The append-only ledger. Appends are idempotent on the event's idempotencyKey,
 * so replaying the same event during offline sync yields exactly one effect.
 * A balance is obtained only by PROJECTING over the events — never stored.
 */
export class Ledger<TType extends string = string, TPayload = unknown> {
  constructor(private readonly store: LedgerStore<TType, TPayload>) {}

  /** Append an event; a replay of the same idempotencyKey is a no-op (deduped). */
  append(event: DomainEvent<TType, TPayload>): AppendResult<TType, TPayload> {
    const existing = this.store.findByIdempotencyKey(event.idempotencyKey);
    if (existing) {
      return { record: existing, deduped: true };
    }
    return { record: this.store.append(event), deduped: false };
  }

  /** All records in append order. */
  entries(): readonly LedgerRecord<TType, TPayload>[] {
    return this.store.all();
  }

  /** Project the events into a state/balance — the only way to read a total. */
  project<S>(initial: S, reducer: (state: S, event: DomainEvent<TType, TPayload>) => S): S {
    return this.store.all().reduce((state, record) => reducer(state, record.event), initial);
  }
}

/** An in-memory, append-only LedgerStore for tests and the store-edge cache. */
export class InMemoryLedgerStore<TType extends string = string, TPayload = unknown>
  implements LedgerStore<TType, TPayload>
{
  private readonly records: LedgerRecord<TType, TPayload>[] = [];
  private readonly byKey = new Map<string, LedgerRecord<TType, TPayload>>();

  append(event: DomainEvent<TType, TPayload>): LedgerRecord<TType, TPayload> {
    if (this.byKey.has(event.idempotencyKey)) {
      throw new Error(`Duplicate append for idempotency key "${event.idempotencyKey}".`);
    }
    const record: LedgerRecord<TType, TPayload> = Object.freeze({
      seq: this.records.length + 1,
      event,
    });
    this.records.push(record);
    this.byKey.set(event.idempotencyKey, record);
    return record;
  }

  findByIdempotencyKey(key: string): LedgerRecord<TType, TPayload> | undefined {
    return this.byKey.get(key);
  }

  all(): readonly LedgerRecord<TType, TPayload>[] {
    return this.records.slice();
  }
}
