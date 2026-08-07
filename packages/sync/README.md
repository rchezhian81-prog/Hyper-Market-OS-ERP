# `packages/sync/`

Offline-first sync primitives — **P-01** (the store trades offline) and **§31** (durable
outbox, idempotent drain, a visible unsent count, and dead-letter). See
`docs/architecture/offline-sync.md` for the full design.

- **`src/outbox.ts`** — `SyncOutbox`: `enqueue` (idempotent on the event's idempotency key),
  `pending`/`unsentCount` (the §27.1 badge), `acknowledge` (advance the watermark),
  `recordFailure` (attempt count), and `deadLetter`/`deadLetters` — a poison item moves to a
  **visible** dead-letter queue and is **never dropped** (hard rule #6). In-memory now; a
  durable store-edge implementation slots in later. Tested in `tests/unit/outbox.test.ts`.

> Pairs with `packages/ledger` (the domain event log) and the `DomainEvent` envelope
> (`packages/contracts`). Part of the repository layout in `CLAUDE.md`.
