# ADR 0009 — Redis deferred for the single-instance pilot (§19 substitution)

- **Status:** Accepted
- **Date:** 18 August 2026
- **Context:** Roadmap §19 lists cloud data as "PostgreSQL + Redis; object storage for documents." Redis
  is **not built**. Its two intended jobs are covered by simpler single-instance mechanisms: rate
  limiting uses an in-process `TokenBucketRateLimiter` (`services/api/src/main.ts`, with the comment that
  "a multi-instance cloud swaps these ports for a shared Redis-backed limiter"), and hot-read caching
  uses the Postgres projection-snapshot facility (ADR-0005), not a Redis cache. There is no Redis client
  in `pnpm-lock.yaml`. (Document storage — the other half of the §19 cloud-data row — is covered
  separately by ADR-0010.)

## Decision

Run the pilot as a **single cloud instance with no Redis**: an in-process token-bucket rate limiter and
Postgres-backed projection snapshots stand in for Redis's rate-limit-coordination and cache roles. Keep
both behind ports so a shared Redis-backed implementation can be dropped in when a second instance
appears. **Do not** add Redis now.

## §19-substitution impact

- **Offline:** Neutral for the store (Redis is a cloud-side concern; the store trades from its own edge).
  No offline guarantee depends on Redis.
- **Support:** Lower — one datastore (Postgres) to run and back up instead of two; no Redis persistence,
  eviction or failover to operate.
- **Security:** Smaller surface — no additional in-memory datastore endpoint to secure or isolate per
  tenant.
- **Cost:** Lower — no Redis instance. The trade is that the in-process limiter's state is per-instance,
  which is correct only while there is exactly one instance.
- **Portability (P-06):** High — the rate-limit and cache ports are plain interfaces; nothing serialises
  a Redis-specific format. A Redis-backed adapter is an additive implementation.
- **Maintainability:** Good at single-instance scale. The explicit risk, already noted in code: an
  in-process limiter and a process-local cache are **correct only for one instance** — running a second
  instance without the Redis-backed swap would split rate-limit state and duplicate cache work.

## Consequences

- The pilot needs no Redis and no second datastore to operate.
- Horizontal scale (>1 instance) is **gated on** providing the shared Redis-backed limiter (and, if
  wanted, a shared cache) — this is a known precondition, not a surprise.
- Hot reads stay bounded via ADR-0005 snapshots on Postgres, so "no Redis cache" does not mean "unbounded
  folds."

## Reconsider-when

The cloud runs more than one API instance behind a load balancer (per ADR-0012's scale path), or a
workload needs cross-instance shared state — that is the point Redis (or an equivalent) is introduced.
