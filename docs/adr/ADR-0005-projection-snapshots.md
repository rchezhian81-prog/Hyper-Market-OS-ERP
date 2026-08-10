# ADR 0005 — Projection snapshots (bounding full-fold reads)

- **Status:** Accepted. Introduced by CORE-03 inc1.
- **Date:** 10 August 2026
- **Context:** A read model in this system is derived by folding the append-only
  event ledger — there is no separate source table (see `packages/persistence`
  `projection.ts`, and the reporting/§29 note). A fold that always starts at
  sequence 0 grows without bound as the shop trades: the busiest read (the
  owner's daily figures, a per-invoice cumulative, a running balance) re-reads
  every event of its kind ever written. FND-01 and the performance work already
  bounded the hottest paths per-adapter — `readStream` gained `sinceSeq`/`type`
  narrowed **at the store**, `latestOfType` avoids reading a whole stream for its
  tail, and inventory folds availability from an in-ledger `InventorySnapshotTaken`
  opening balance. What did not exist was a **reusable** way for any projection to
  resume from a persisted fold, rather than each adapter hand-rolling its own.

## Decision

Add a general **snapshot facility** in `packages/persistence` (`snapshot.ts`):

- A `Snapshot<S>` is the folded `ProjectionResult<S>` at a watermark, for one
  `(tenantId, stream, projection)`. The projection identity **carries a version**
  (e.g. `credited-per-invoice@1`); a changed reducer bumps the version, so old
  snapshots are ignored and rebuilt, never misread into the wrong shape.
- A `SnapshotStore` port (`load`/`save`) with an `InMemorySnapshotStore`. The
  durable SQL store is a later increment; because a snapshot is disposable, an
  empty store is always a correct start.
- `projectFromSnapshot(...)` loads the snapshot, reads only the events **after**
  its watermark (`sinceSeq`, optionally filtered by `type`) — narrowed at the
  store, not in memory — folds that tail onto the snapshot's state, and writes a
  fresh snapshot once enough events have accrued so the next read's tail stays
  bounded.

**A snapshot is derived and disposable, never a source of truth.** It is
equivalent to a full fold by construction (`runProjection(tail, projection,
snapshot.result)` applies exactly the events, once each in seq order, that a
from-scratch fold would apply after the watermark); the equivalence and the
disposability (delete every snapshot → the next read rebuilds the identical
model from the ledger) are pinned by test. This changes only the **cost** of
reading the truth, never the truth — hard rule #2 is about the ledger, which a
snapshot never replaces, and hard rule #10 is untouched because nothing here
resolves anything.

First running consumer: the finance cumulative-credit read
(`financeNotesAdapter.alreadyCredited`), the s.34 cap that must hold across every
credit note ever issued against an invoice — now folded through the facility with
a process-local, disposable snapshot cache, instead of re-summing the whole
credit-note history on each issuance.

## Consequences

- **Bounded reads for any projection**, not just the ones with a bespoke
  mechanism — the reusable substrate CORE-03 called for.
- **Two snapshot styles now coexist, deliberately.** Inventory keeps its
  in-ledger `InventorySnapshotTaken` (a snapshot written on the *write* path,
  where a handheld can afford the extra fold and a lookup cannot). The new
  facility is an out-of-band, disposable *read* cache. Neither is wrong; a future
  increment may migrate the bespoke one onto the facility once the SQL snapshot
  store exists, but not before, because the inventory path is hot and already
  proven.
- **The SQL `SnapshotStore` is deferred.** Until it lands, snapshots are
  process-local (rebuilt from the ledger on a cold start) — correct, just not
  shared across instances. Because snapshots are disposable this is safe, only
  less efficient.
- **A versioned projection name is mandatory discipline**: resuming a changed
  reducer from an old shape would be a silent corruption, so the version in the
  name is the guard.
