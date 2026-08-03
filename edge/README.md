# `edge/`

Store-edge services and the sync agent. This is what keeps the shop trading when the internet
is down — and what carries the work to the cloud once it is back.

## `sync-agent/`

The store-edge → cloud sync agent (**P-01 / §31 / hard rules #6 and #10**). It **never touches
the sale path**: the POS commits locally and enqueues (hard rule #1); this agent drains that
queue afterwards.

- **`src/transport.ts`** — `SyncTransport`, the port the agent depends on (never a concrete
  client), so the agent is fully testable offline and the real transport (HTTPS to the ingest
  API, or a durable broker publish) is a thin adapter at deployment. Its outcome distinguishes
  **accepted** / **retryable** / **rejected**, because each demands different behaviour.
- **`src/agent.ts`** — `SyncAgent.drain(options)`:
  - **Order** — pending items drain in enqueue order, so cause precedes effect.
  - **Idempotent** — delivery is keyed on the event's idempotency key, so a retry after an
    ambiguous failure collapses to **one effect** in the cloud (§31.1).
  - **Never dropped** — a **transient** failure keeps the item queued with its attempt count; a
    **permanent** rejection, or exhausting the attempt budget, moves it to the **visible
    dead-letter queue** (hard rule #6). A **cloud conflict is a rejection**, so it becomes an
    exception rather than a last-write-wins overwrite (hard rule #10). An unexpected transport
    error is treated as transient, so an exception can never lose work.
  - **Stops early when offline** — consecutive transient failures end the pass instead of
    hammering a dead link; the caller retries later using `nextDelayMs` (exponential backoff,
    1 s → capped at 5 min).
  - **Honest** — every pass returns exactly what happened, and `health()` exposes the
    **unsent count**, **dead-letter count** and **last success**, so sync lag is visible on every
    surface (P-08).
  - **Deterministic and clock-free** — `at` is injected and backoff is a pure function, so the
    whole agent is tested without timers or a network.

Tested in `tests/unit/sync-agent.test.ts` (12 tests). Part of the repository layout in
`CLAUDE.md`.
