# Architecture Decision Register

_Deep architecture audit, 2026-08-09. Consolidates the repo's existing ADRs (`docs/adr/`) and records the new
decisions this audit recommends. New decisions are **Proposed** — they are recommendations, not commitments, and
several depend on the owner decisions in EXECUTIVE_ARCHITECTURE_AUDIT.md. Format per decision: Decision · Reason
· Alternatives · Benefits · Costs · Risks · Migration impact · Reconsider-when._

> **Update (18 August 2026, Phase 2 architecture closure).** `docs/adr/` now holds **twelve** ADRs, not
> four. ADR-0005 (projection snapshots) and ADR-0006 (batch-on-sale attribution) were added during the
> build; ADRs **0007–0011** were added to discharge the CLAUDE.md §19 mandate that every technology-baseline
> substitution carry a covering ADR (ERP no-framework shell, Postgres-outbox messaging, Redis deferred,
> documents-as-events, edge file-log). **ADR-A01** below (modular monolith) is promoted as **ADR-0012**, and
> **ADR-A02** (the single-`pg.Client` SPOF) is resolved in code (`services/api/src/main.ts` now uses a
> `pg.Pool`). The remaining A03–A12 stay as recommendations for later phases; the table below is the
> original 2026-08-09 snapshot, kept for the record.

## Existing ADRs (verified in `docs/adr/`)
| ID | Title | Status (verified) | Note |
|---|---|---|---|
| ADR-0001 | Baseline decisions | Accepted | Monorepo, TS, event-sourcing, ports & adapters. |
| ADR-0002 | Hosting and deployment | **Proposed (not Accepted)** | The hosting decision is open — blocks all cloud IaC/CD. Owner decision OB-02/OA-5. |
| ADR-0003 | Multi-tenant configurable product | Accepted | Per-tenant entitlements/config; single-tenant today, multi-tenant-capable. |
| ADR-0004 | The disk lives on the lane | Accepted | Durable local commit (fsync) before receipt — the basis of the offline guarantee. |

**Finding:** the ADR discipline exists but is thin (4 ADRs) relative to the number of load-bearing decisions
already made in code (event store shape, no-transactions, single-client DB access, LWW-visible-conflict,
provider-neutral AI). Several *de-facto* decisions were never written down. The new ADRs below both propose
target changes and **retroactively document** the most consequential implicit ones.

## New / recommended ADRs (Proposed)

### ADR-A01 — Keep the modular monolith; do not adopt microservices
- **Decision:** Retain one deployable cloud API assembling the 13 domain APIs; scale by running multiple
  instances behind a load balancer, not by splitting services.
- **Reason:** One store's load does not justify a service fleet; the bounded contexts already exist as
  packages/modules, giving the modularity benefit without the operational tax. Research §(scale) confirms.
- **Alternatives:** microservices per API (rejected: ops weight, distributed-txn pain); serverless (rejected:
  offline-first + stateful ledger fold fit long-lived processes better).
- **Benefits:** simplest ops; one migration/deploy; in-process calls; easy local run. **Costs:** must guard
  module boundaries by discipline (guardrails already do). **Risks:** a single process is a blast radius — see
  ADR-A02. **Reconsider-when:** multi-region or a single domain's load/scaling profile diverges sharply.

### ADR-A02 — Introduce a Postgres connection **pool** and remove the shared single `pg.Client`
- **Decision:** Replace the one shared `pg.Client` (`services/api/src/main.ts:323`) with a `pg.Pool`; run ≥2
  API instances.
- **Reason:** Every query across all 13 APIs currently serializes over one TCP connection and a dropped
  connection disables all persistence — a verified SPOF and throughput ceiling (GAP-DATA-09).
- **Alternatives:** keep single client (rejected: SPOF); external pgbouncer (viable later). **Benefits:**
  concurrency, resilience. **Costs:** minor. **Risks:** none material. **Reconsider-when:** never — this is a
  straight fix. **Priority: P0.**

### ADR-A03 — Add explicit **transaction boundaries / unit-of-work** for multi-event commands
- **Decision:** Wrap any command that appends more than one event in a single DB transaction (BEGIN/COMMIT);
  keep single-event appends autocommitted.
- **Reason:** Persistence has **no transaction boundaries anywhere** (GAP-DATA-01); a crash mid-command can
  persist a partial event set, silently violating "one commerce truth."
- **Alternatives:** saga/compensation per partial (rejected: complexity for a monolith on one DB); outbox-in-
  same-txn (adopt jointly). **Benefits:** atomic commands; correctness. **Costs:** modest refactor of the
  event-store `append` to accept a txn scope. **Risks:** must not re-introduce long-held locks. **Reconsider-
  when:** never. **Priority: P0.**

### ADR-A04 — Add **Postgres Row-Level Security** and a `tenants` table/FK (defense-in-depth)
- **Decision:** Enable RLS keyed on `tenant_id` on tenant-scoped tables; create a `tenants` table and FK.
- **Reason:** Isolation is application-level `WHERE tenant_id` only, backed by a single egress scan; one missed
  filter leaks cross-tenant (GAP-DATA-02). RLS is the cheap pooled-tenant defense (Research §4).
- **Alternatives:** per-tenant schema/DB silo (rejected: cost at this scale). **Benefits:** database-enforced
  isolation, orphan-tenant prevention. **Costs:** set session `tenant_id` per request; migration. **Risks:**
  policy mistakes lock out legit reads — test thoroughly. **Reconsider-when:** moving to per-tenant silos.
  **Priority: P1.**

### ADR-A05 — Wire a **cryptographic (SHA-256) audit hash-chain** into the durable `audit_log`
- **Decision:** Inject SHA-256 into `AuditTrail`; add prev-hash/hash columns to `audit_log`; ship a verify tool.
- **Reason:** The hash-chain engine exists but defaults to non-crypto FNV-1a and is not connected to the durable
  table; production wiring of SHA-256 is unverified (GAP-SEC-03). Research §7.
- **Alternatives:** rely on DB triggers alone (rejected: superuser-droppable). **Benefits:** true tamper-
  evidence. **Costs:** low. **Reconsider-when:** never. **Priority: P0.**

### ADR-A06 — Implement a **real inbound pack-sync** path (cloud→edge), keep LWW-with-visible-conflict
- **Decision:** Add a pull/poll (or push-with-ack) that fetches the signed pack and atomically swaps the local
  file; surface pack age on every screen. **Do not** adopt CRDTs/vector clocks.
- **Reason:** Inbound sync is a manually-placed file today (GAP-SYNC-01); the documented bidirectional agent is
  unimplemented. Per-record single ownership makes CRDTs unjustified (Research §1/§3).
- **Alternatives:** CRDT sync engine (rejected: overkill/overhead); manual file drops (status quo, unsafe for
  recalls/prices). **Benefits:** fresh prices/recalls/entitlements offline. **Costs:** a small sync endpoint +
  edge poller. **Risks:** must stay idempotent and signature-verified. **Reconsider-when:** true multi-writer
  collaboration appears. **Priority: P0.**

### ADR-A07 — Wire **offline document numbering** (reserved ranges) into the POS
- **Decision:** Replace `R-${timestamp}` with the existing `ReservedRangeAllocator`; provision each lane a
  reserved range via its pack.
- **Reason:** The allocator is unit-tested but unused; the till mints timestamps, risking receipt-number
  collisions across offline lanes (GAP-SYNC-02); QG-04 not demonstrated end-to-end.
- **Alternatives:** central allocation (rejected: needs network). **Benefits:** gap-free, collision-free
  numbering offline. **Costs:** wire + pack field + integration test. **Reconsider-when:** never. **Priority: P0.**

### ADR-A08 — Emit **four-golden-signal metrics** + structured tracing; deliver alerts to a channel
- **Decision:** Add a Prometheus/OTel exporter behind the existing `/metricz` seam; wire the `packages/ops`
  health/alert library to a real channel (email/webhook); add request tracing propagation.
- **Reason:** Observability *computes* health but delivers it nowhere; metrics have no exporter, no tracing
  backend, no dashboards/alert delivery (GAP-OPS-02). Research §10.
- **Alternatives:** full APM suite (rejected: heavy). **Benefits:** incidents actually surface. **Costs:** an
  exporter + a channel. **Reconsider-when:** multi-service scale demands distributed tracing depth. **Priority: P1.**

### ADR-A09 — Publish **OpenAPI** contracts + adopt **SemVer** for the 13 APIs
- **Decision:** Generate/commit OpenAPI docs; version the API package with SemVer; contract-test the edge
  against them.
- **Reason:** Paths are versioned `/v1/...` but no machine-readable contract is emitted; the offline edge
  depends on stable contracts (Research §10, P-06). **Benefits:** portability, edge-safety, integrator clarity.
  **Costs:** low. **Priority: P2.**

### ADR-A10 — Add **DSR (data-subject rights) API** + audited erasure/anonymization against the append-only store
- **Decision:** Expose access/export/erasure over the audited API with a `privacy.dsr.*` permission; fulfilment
  pseudonymises PII in projections while preserving the append-only ledger + legal holds (tombstone/redaction
  strategy for jsonb PII).
- **Reason:** DSR engine exists but is not on the API surface; erasure against the append-only store is
  structurally unaddressed (GAP-SEC-02, GAP-DATA-06); DPDP-relevant (Research §8). **Priority: P1.**

### ADR-A11 — Choose hosting and stand up **staging + IaC + CD + automated rollback** (supersedes ADR-0002 once decided)
- **Decision:** Accept a hosting target (managed Postgres w/ HA, container host, secret store, TLS); express it
  as IaC; add a CD pipeline with automated rollback; make `integration` and `deploy` **required** merge checks.
- **Reason:** No production/staging environment, no cloud IaC, no CD, no automated rollback exist; forward-only
  migrations have no scripted reverse (GAP-OPS-01/05). **Blocked on owner decision OA-5/OB-02.** **Priority: P1
  (post owner-decision).**

### ADR-A12 — Add a **deterministic workflow/rules engine + approval inbox** as the automation substrate (before any AI autonomy)
- **Decision:** Introduce a small rules/workflow engine and a first-class approval inbox that the AI *drafts
  into* and humans *commit from*; the AI never gains a commit path.
- **Reason:** Safe autonomy (P-05) needs a deterministic policy layer + human-approval queue; today approvals
  are per-domain (§28) with no unified inbox and no rules engine (see AUTONOMOUS_PRODUCT_BLUEPRINT.md).
  **Priority: P1 (automation foundation).**
