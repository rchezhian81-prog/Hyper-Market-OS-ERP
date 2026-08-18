# ADR 0008 — Durable messaging via a Postgres outbox, not a broker (§19 substitution)

- **Status:** Accepted
- **Date:** 18 August 2026
- **Context:** Roadmap §19 mandates messaging as "a durable broker with idempotency, retry and dead
  letter." What is built is a **Postgres-backed durable outbox**: `SqlOutboxStore`
  (`packages/persistence/src/outbox-store.ts`) over the `sync_outbox` table
  (`db/migrations/0002_sync_outbox.sql`), carrying an idempotency key, an `attempts`/`maxAttempts` retry
  counter, and a visible `dead_letter` terminal state; nothing is ever silently dropped. There is no
  message broker (no Kafka/RabbitMQ/NATS/SQS client in `pnpm-lock.yaml`). The broker is described as "a
  thin adapter" left for later in `docs/STATUS.md` and `docs/audit/TARGET_HYBRID_ARCHITECTURE.md`.

## Decision

Use the **transactional outbox pattern on Postgres** as the durable messaging substrate for the pilot:
domain effects are recorded as rows the sync agent drains idempotently, with bounded retry and an
explicit dead-letter state a human can inspect. **Do not** introduce a message broker now. Keep the
outbox behind a port so a broker publish can be added later as an adapter without changing callers.

## §19-substitution impact

- **Offline:** Strongly positive and the core reason for the substitution. The outbox is exactly how an
  offline-first store defers work: the store commits locally, and the outbox row is drained when
  connectivity returns (P-01, hard rule #1). A broker requires the broker to be reachable — the opposite
  of the offline guarantee.
- **Support:** Much lower — no broker cluster to run, monitor, upgrade or secure. The dead-letter state
  is a Postgres query, not a separate DLQ console. Same database to back up.
- **Security:** Smaller surface — no broker network endpoint, no separate broker auth/ACL model; the
  outbox inherits the database's tenant isolation and access controls.
- **Cost:** Substantially lower — no broker infrastructure or license; reuses the Postgres already in the
  baseline.
- **Portability (P-06):** High — the outbox is plain SQL rows; the port boundary means a future broker is
  an adapter swap, not a rewrite. Idempotency keys make either transport replay-safe.
- **Maintainability:** Good at pilot scale — one storage technology, one transaction model, delivery
  semantics that are easy to reason about and test. The known ceiling is throughput/fan-out at large
  scale, where a broker's push and consumer-group model would outperform outbox polling.

## Consequences

- Idempotency, retry and dead-letter — the three properties §19 names — are all present, backed by the
  database rather than a broker.
- Delivery is poll-driven, not push; latency and fan-out are bounded by the poller, which is acceptable
  for a single store's volume.
- A future broker is an additive adapter behind the existing port; the outbox remains the durable record
  of intent regardless.

## Reconsider-when

Fan-out to many independent consumers, cross-service event streaming, or throughput that makes outbox
polling a bottleneck — i.e. a multi-store / multi-service cloud, not a single pilot store.
