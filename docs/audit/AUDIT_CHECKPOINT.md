# Audit Checkpoint — verified first-hand facts

_Working note for the deep architecture audit (2026-08-09). Facts here are verified by direct
inspection of code/config/CI, not from documentation claims. Deeper subsystem evidence is being
gathered by parallel read-only agents and will be merged into the final deliverables._

## Legend for status
`PV` Production-verified · `IV` Implemented, not production-verified · `PI` Partially implemented ·
`DO` Documented only · `PL` Planned only · `MI` Missing · `UN` Unclear, needs evidence.

## Repository shape (verified)
- Monorepo, pnpm workspaces, TypeScript (strict), vitest, esbuild. Node 22 in CI.
- `services/` = 17 folders incl. `kernel` + 16 domain services (ai, api, catalogue, customer, finance, fulfilment, identity, inventory, migration, orders, platform, pos, pricing, purchase, reporting). API-01..API-13 assembled into one surface.
- `packages/` = 78 shared domain/engine/contract packages (event-sourcing engines).
- `apps/` = 7: pos, web-erp, owner-app, customer-app, picker-app, delivery-app, warehouse-app.
- `edge/` = `store-edge` (served offline screens + pack) and `sync-agent` (store→cloud drain + HTTP transport).
- `db/migrations/` = 9 SQL migrations: event_ledger, sync_outbox, config_versions, append_only_guards, event_id_domain_scoped, stream_type_index, idempotency_keys, audit_log, number_series.
- `docs/` = requirements (41 files, M01–M36 + extensions), adr (4 ADRs), architecture (data-model, gap-analysis, infrastructure, migration-design, offline-sync), security (threat-privacy-model), 13 runbooks, 19 evidence files, roadmap, traceability.md, backlog.md.
- Git: 389 commits, every change via PR to a protected `main` (branch-protection runbook + CI on PR).

## Testing (verified counts)
- 332 test files, ~4929 `it/test` blocks (≈4858 pass + skips gated on Postgres).
- unit 212 · integration 80 · guardrails 31 · performance 3 (api-scales, pos-hot-path, sync-and-endurance + harness) · security 3 (access-control-sweep, data-protection, separation-of-duties) · contract 2 (api-surface-contract, event-and-api-contracts) · migration 1 · **e2e 0 (empty — no browser/UI e2e)**.
- 31 executable guardrails act as an anti-regression safety net (append-only ledger, card-data, secrets, shared-login, support-access-is-never-standing, ai-agent-db-write, kill-switch, offline-screen, no-test-idp-in-production, traceability-integrity, completion-ladder-has-evidence, screen-usability, etc.). This is a genuine strength.

## CI/CD (verified — `.github/workflows/ci.yml`)
Three required jobs, all must be green to merge:
1. **verify** — typecheck, lint, `secret-scan` (whole repo), full test suite, `pnpm audit --audit-level=high`, SBOM generation + drift check (`docs/evidence/sbom.json`).
2. **integration (real Postgres 16)** — migrate + re-migrate (idempotency proof), integration stage-gate suites, and a **backup→DROP DATABASE→restore reconciliation proof (QG-08) on every run**.
3. **deploy** — builds `infra/docker/api.Dockerfile`; proves the container REFUSES to start without config (exit 78 EX_CONFIG, names each missing setting incl. IDP), refuses the `.env.example` placeholder secret, brings up the whole `infra/compose` stack and polls `/readyz`, and proves graceful drain (SIGTERM → clean exit 0/143).
- This is strong production-readiness discipline **at the CI level**. Gap: there is no evidence of a real deployed staging/production cloud environment, live IdP, or real providers — everything runs in CI or in-memory/local Postgres.

## Offline / sync (verified — first-hand)
- `edge/sync-agent/src/agent.ts` `SyncAgent.drain()`: order-preserving, idempotent (keyed on the event's own idempotency key), never-drop (transient → retry with attempt count; poison/exhausted → **visible dead-letter**, never silent discard), stops-early-when-offline (consecutive-failure circuit breaker), `health()` exposes unsent/dead-letter/last-success. Pure/clock-free (backoff `nextDelayMs` = 1s→cap 5min).
- `edge/sync-agent/src/http-transport.ts`: a REAL transport. Deliberately **no generic `/v1/ingest`** — each event type routes through the SAME domain endpoint it would have used online (`EVENT_ROUTES`: SaleCommitted→/v1/sales, InventoryMoved→/v1/inventory/movements, …), so a late-synced sale gets the same price/receipt/exception checks. Careful outcome map (timeout/408/429/5xx/401 = retryable; 4xx/403 = permanent). Never puts the token in a message; never mints its own idempotency key.
- Backed by `packages/sync/src/outbox` (SyncOutbox) and DB `sync_outbox` (deliberately mutable table, per migration 0002). This is genuinely sophisticated store-and-forward engineering.
- Integration tests present: `the-shop-reaches-the-cloud`, `offline-sync-slice`, `it-remembers`, `the-key-survives-a-restart` (Postgres-gated).

## Event store & data (verified — first-hand, partial)
- Event-sourced. `packages/persistence/src/event-store.ts`: EventStore interface with InMemory + Sql implementations; append dedups on `(tenantId, idempotencyKey)`; `readStream(tenant, stream, {type,from,to,sinceSeq})` (exact-stream match, binary-search tail); `latestOfType`, `findByIdempotencyKey`, `exportTenant` (whole-tenant scan for M36 export). Balances/positions are PROJECTED (fold), never stored.
- DB append-only guards (migration 0004) refuse UPDATE/DELETE on `event_ledger` and `config_versions` at the database level (proven to survive restore). `sync_outbox` deliberately mutable.
- Per-tenant isolation is the pervasive pattern (every read/write scoped by tenantId; `§35`). Depth of enforcement being verified by the DB + security agents.

## Notable strengths (first-hand)
- Executable guardrails as living safety-spec; RTM + backlog kept honest by a guardrail.
- DR restore actually exercised in CI (not just documented).
- Offline-first is real, not a slogan: POS commits locally then drains; conflicts become dead-letter exceptions, never last-write-wins.
- Money in integer minor units; ledgers append-only + compensating events; number-series gap-free (migration 0009).
- Ports-&-adapters throughout; provider-neutral seams (test-mode payments, local IdP) behind ports.

## Notable gaps (first-hand, preliminary)
- **No production/staging deployment evidence** — CI-only; no live cloud, real IdP, or real payment/UPI/Tally providers wired (all test-mode/simulated by owner decision OA-4).
- **0 browser/e2e tests** — UI behaviour is asserted via guardrails + jsdom-style checks, not a real browser; no Playwright suite despite Chromium being available.
- **AI layer is governed-by-absence** — hard rule #5 enforced (no ai apply/commit/execute route; kill switch), but the positive AI capability (model gateway, RAG, evaluation framework, tool registry, agent identity, cost controls) is minimal/simulated — needs verification.
- **Mostly IV, not PV** — the vast majority of modules are "wired + integration-tested" against in-memory/local Postgres, not verified with real users, real data volume, or real providers. This is the single biggest honesty point for scoring.
- Load/soak/chaos/fault-injection testing is thin (3 perf files); no formal SLO/error-budget instrumentation verified yet.

_Next: merge the six agents' evidence packs (infra/DevOps, database, security, offline/sync, AI+integrations+testing, external research) and produce the 12 deliverables._
