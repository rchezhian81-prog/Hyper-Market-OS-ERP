# ADR 0011 — Edge durability via an append-only file-log, not a local relational DB (§19 substitution)

- **Status:** Accepted
- **Date:** 18 August 2026
- **Context:** Roadmap §19 mandates the store edge as "containerised local services + a local **relational**
  database." The edge is containerised (`infra/docker/edge.Dockerfile`), but its durable store is a
  **file-based append-only log** (`edge/store-edge/src/file-log.ts` with `durability.ts` fsync-per-append),
  and the read model is folded in memory (`edge/store-edge/src/read-model.ts`); there is no local
  Postgres on the edge (the edge container mounts a file volume, no database). ADR-0004 ("the disk lives
  on the lane") justified the per-lane durable-commit topology but did not analyse the relational→file
  substitution on the six §19 axes; this ADR closes that.

## Decision

Keep the store edge's durable store as an **append-only file-log with fsync-before-acknowledge**, with an
in-memory folded read model, rather than a local relational database. This is the same event-sourced
shape the cloud uses, minus the SQL engine. **Do not** add a local relational DB to the edge for the
pilot.

## §19-substitution impact

- **Offline:** Strongly positive — this is the mechanism of the offline guarantee. A sale is durably
  committed by an fsync'd append to the local file **before** the receipt prints (ADR-0004, hard rule
  #1); no database process needs to be healthy on the lane for the store to keep trading.
- **Support:** Lower — no database engine to install, tune, migrate or recover on shop-floor hardware; a
  lane's durable state is a file that copies and restores trivially, which suits sites with no on-site DBA.
- **Security:** Smaller surface — no local DB listener; file permissions plus the container boundary. The
  log is append-only by construction, matching hard rule #2 at the edge.
- **Cost:** Lower — no per-lane database license or footprint; runs on low-spec hardware.
- **Portability (P-06):** High — the log is a plain append-only file with the same event shape as the
  cloud ledger; it replays into any consumer. The risk is the inverse of SQL: ad-hoc relational queries
  on the edge are not available (by design — the edge folds, it does not query).
- **Maintainability:** Good for the edge's bounded, sequential workload (append sales, fold a read model,
  drain an outbox). A relational DB would add operational weight the edge's access pattern does not need.
  The ceiling is any future edge workload that genuinely needs relational querying at the store.

## Consequences

- The offline-first guarantee rests on a mechanism with no moving database — the simplest thing that is
  durable — which is a feature, not a shortfall, for shop-floor hardware.
- The edge's read model is a fold, not a query surface; anything needing relational query runs in the
  cloud against Postgres.
- The edge and cloud share one event-sourced mental model, differing only in the storage engine.

## Reconsider-when

An edge workload needs true on-store relational querying, or the folded read model outgrows memory on
target hardware — then a local embedded relational/columnar store on the edge is revisited.
