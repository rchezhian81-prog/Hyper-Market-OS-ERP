# Gap Register & Risk Register (with Scoring)

_Deep architecture audit, 2026-08-09. Evidence-based, deliberately non-inflated. Scores reflect the whole
product's readiness to become a production-grade hybrid platform, NOT the quality of the domain engines in
isolation (which is far higher)._

## The two-number truth (verified, from the repo's own guardrail-enforced traceability)
- **Domain logic built (unit-proven engines):** ~140/144 FR rows "built" ≈ **97%** (`docs/backlog.md:13`).
- **System assembly (can a user actually do this, end-to-end?):** WIRED+ ≈ **25%** (9/36 modules), INTEGRATION-TESTED+ ≈ **8%** (3/36), E2E ≈ **3%** (1/36 — M12 POS), UAT/PRODUCTION-VERIFIED = **0%**.
- **Self-disclosed structural gap** (`docs/traceability.md:135-139`): *"The services are thin. Six of the seven
  domain services (finance, orders, inventory, customer, fulfilment, reporting) are kernel-only
  re-implementations that do not import the rich, tested domain engines in `packages/`… 35 of 77 packages are
  imported only by their own tests."* (Recent work has begun importing real engines into `services/inventory`
  — the M08 analytics — but the pattern holds across most services.)

This gap between "97% built" and "25% wired / 0% verified" is the entire story of the audit.

## Scorecard (0–10, with evidence)

| # | Dimension | Score | Evidence / why points lost | To reach 9 | To reach 10 |
|---|---|---|---|---|---|
| 1 | Requirements | **9** | 41 requirement files, M01–M36 × 4 FRs, full Appendix-B records + NFRs; guardrail-enforced traceability. −1: service layer diverges from the proven engines; M23/M29 "thin". | Reconcile services↔engines; close M23/M29 requirement→wire. | Every FR wired + acceptance-tested. |
| 2 | Product completeness | **4** | Rich engine library; only ~25% wired, 0% production; owner's core surfaces (finance/reporting) thin. | Wire the top ~15 modules end-to-end incl. finance/reporting. | Full module coverage, pilot-proven. |
| 3 | Architecture | **7** | Clean modular monolith, ports&adapters, ledger-scoped event sourcing, executable guardrails. −: thin-service duplication (drift), no txn boundaries, single shared `pg.Client`. | ADR-A02/A03 (pool, transactions); collapse thin services onto engines. | Sustained under load + multi-instance. |
| 4 | Hybrid / offline | **7** | Offline *trading* excellent + integration-tested (best part). −: no inbound sync, offline numbering unwired, conflict UI thin, single-box SPOF. | SYNC-01/02/03 (numbering, inbound pack, conflict UI). | Multi-lane offline proven end-to-end + edge redundancy. |
| 5 | Data integrity | **5** | Append-only ledger + dedup + gap-free numbering + restore-reconcile. −: **no transactions**, no optimistic concurrency, money-in-jsonb, no snapshots, idempotency_keys unguarded, no FKs/CHECKs. | ADR-A03 transactions; typed money; guard idempotency_keys; snapshots. | Concurrency + partial-failure proven under fault injection. |
| 6 | Security & privacy | **6** | Strong code design (JWT verifier, RBAC, egress 500 backstop, secrets, AI forbidden-tools). −: DSR not on API, hash-chain not crypto-wired, no rate limiting, no token revocation, no RLS, nothing pentested. | SEC-01..07. | QG-06 independent pentest, zero critical/high in production. |
| 7 | Multi-tenancy | **5** | Pervasive tenant scoping + egress backstop + tenant-scoped idempotency. −: application-level only (no RLS), no `tenants` FK, weak branch isolation. | ADR-A04 (RLS + tenants FK); first-class `branch_id`. | Proven cross-tenant isolation matrix + silo option. |
| 8 | Scalability & performance | **4** | Perf tests are complexity-budget (good design). −: single `pg.Client`, no pool, no load/concurrency tests, no HA, single process/box. | Pool + multi-instance + real load tests. | Proven at target volume with headroom + autoscale. |
| 9 | Integrations | **4** | Rich ports/adapters w/ safety/idempotency/retry/dead-letter. −: every integration test-mode; none against a real vendor; no vendor contract tests. | One real provider per category in sandbox + contract tests. | Live providers in production with reconciliation. |
| 10 | Automation | **5** | Governance skeleton + exception surfacing + approvals + candidate engines. −: `owner-control` alerts-inbox unwired, no workflow/rules engine, no L2+ automation running. | Wire alerts-inbox + reorder-draft (L2), add rules engine + approval inbox. | Policy-controlled L4 where safe, audited. |
| 11 | AI readiness & governance | **6** | Governance genuinely strong & rare (forbidden-tools, admission-before-transport, drafter/actor, evaluation, provider-neutral). −: no live model, no RAG, no prompt-versioning, AI audit not first-class, red-team thin. | Live provider behind ports + AI audit route + red-team battery. | Evaluated, cost-controlled, monitored L2/L3 in production. |
| 12 | UI / UX | **6** | Real served PWA screens, owner exception command-centre, best-in-class offline UX, role-based IA. −: **0 browser/e2e**, no real render/tap/screen-reader test, translation quality unverified. | Playwright e2e + a11y sweep + native-Tamil review (OA-10). | Usability-tested with real staff on real devices. |
| 13 | Accessibility & multilingual | **5** | Real a11y engine (WCAG 4.5:1, never-colour-alone) + bilingual completeness enforced. −: contrast enforced only on branding+POS, no axe/WCAG sweep, Tamil quality unverified, no low-spec-device test. | Full axe sweep + native-Tamil pass + low-spec device test. | WCAG 2.2 AA verified across all screens. |
| 14 | Testing | **6** | ~4,879 tests, 31 guardrails, 240-combo permission matrix, DR-in-CI. −: 0 e2e, no load/chaos/fault-injection, no tenant-isolation matrix, thin AI red-team, no vendor contract tests. | Add e2e + load + fault-injection + isolation matrix. | Full pyramid incl. chaos + red-team in CI. |
| 15 | DevOps / SRE | **5** | Exceptional CI controls (secret-scan, config-refusal, migrate-idempotency, restore-reconcile, container refuse/drain). −: no staging/prod, no IaC, no CD, no automated rollback, 1/3 jobs required, branch-protection unverified. | ADR-A11 (hosting, IaC, CD, rollback); make all 3 jobs required. | Full SLO/error-budget ops in production. |
| 16 | Backup / DR | **7** | Real backup→drop→restore→reconcile in CI + evidence doc; RPO/RTO stated. −: encryption-at-rest/offsite flag-only, no HA/replication, single DB. | Exercise encryption+offsite; add DB replica. | Warm-standby DR drills meeting RPO/RTO in production. |
| 17 | Observability | **3** | Structured logging + livez/readyz + health/alert library (good design). −: metrics no exporter, no tracing backend, no dashboards, alerts reach no channel. | ADR-A08 (exporter, tracing, alert delivery). | Four golden signals + SLO dashboards + paging in production. |
| 18 | Maintainability | **8** | Guardrails, honest traceability, ports&adapters, plain-text-source, small reviewable diffs. −: thin-service duplication, 35/77 packages test-only. | Collapse duplication; retire/wire dead packages. | Sustained low-defect velocity post-refactor. |
| 19 | Documentation | **8** | Exceptional: 41 requirements, 13 runbooks, threat model, ADRs, evidence, honest STATUS/traceability. −: some docs overstate (DSR self-service, bidirectional sync, hash-chain); only 4 ADRs. | Correct the 3 overstatements; expand ADRs. | Docs continuously match a production system. |
| 20 | Production readiness | **2** | 0% production-verified, no deployed environment, test-mode everything, QG-06/cutover never passed. | Controlled pilot on real hosting with real providers. | Unsupervised public launch after pilot + pentest. |

### Overall
- **As a domain / correctness core: ~8.5/10** (rare engineering discipline, executable guardrails, honest self-assessment).
- **As a deployed, production-grade hybrid product: ~2.5/10** (pre-pilot; nothing production-verified).
- **Blended overall product readiness: ~5.5/10.** This is a mid-build product with a world-class core and an unbuilt operational/integration half. It is **not** a 10/10 and cannot be until real deployment, real providers, and independent verification exist.

## Consolidated Gap Register (verified)
| ID | Gap | Severity | Evidence |
|---|---|---|---|
| GAP-ARCH-01 | 6/7 services are thin re-implementations, not the tested engines; 35/77 packages test-only | High | `traceability.md:135-139` |
| GAP-DATA-01 | No transaction boundaries — multi-event commands not atomic | High | grep 0 BEGIN/COMMIT in `packages/persistence` |
| GAP-DATA-02 | No Postgres RLS; no `tenants` table/FK; isolation app-level only | High | `db/migrations/*` (0 FK/RLS) |
| GAP-DATA-03 | No optimistic-concurrency / stream-version on append | Medium | `event-store.ts` (seq is global IDENTITY) |
| GAP-DATA-04 | Money stored as JSON number in jsonb payload (JS safe-int bound) | Medium | `0001:29`, `backup.mjs:82` |
| GAP-DATA-05 | No snapshots — full-fold reads unbounded as volume grows | Medium | `event-store.ts` (no snapshot method) |
| GAP-DATA-06 | Erasure/anonymization against append-only store structurally unaddressed | High (DPDP) | `data-rights.ts:31` |
| GAP-DATA-09 | ~~Production shares one `pg.Client` (not a pool) across all stores — SPOF + bottleneck~~ **RESOLVED (STAB-01)** — now a `pg.Pool(max:10)`, verified booting against real PostgreSQL | ~~High~~ Closed | `services/api/src/main.ts` |
| GAP-SEC-02 | DSR access/export/erasure not on the API surface | High (DPDP) | no route/permission; `data-rights.ts` |
| GAP-SEC-03 | Audit hash-chain non-crypto (FNV-1a) & not wired to `audit_log`; SHA-256 injection unverified | High | `audit-trail.ts:105-124` |
| GAP-SEC-04 | No rate limiting / DoS control / auth-attempt lockout | High | `services/kernel` (only AI-budget 429) |
| GAP-SEC-05 | No token revocation / short-TTL strategy | Medium | `token.ts:31-32` |
| GAP-SEC-06 | Support-access expiry enforced in web-erp, not API tier | Medium | `admin-session.ts` vs `services/api` |
| GAP-SYNC-01 | No live inbound sync (pack arrives as locally-placed file) | High | `main.ts:190-204` |
| GAP-SYNC-02 | Offline document numbering (reserved ranges) not wired to POS | High | `app.js:450` vs `numbering.ts` |
| GAP-SYNC-03 | Structured conflict object + operator dead-letter/resolution UI missing | Medium | `agent.ts:136-142`; no `conflict.ts` |
| GAP-AI-01 | No live model, no RAG, no prompt-versioning, AI audit not first-class, red-team thin | High (for AI value) | `adapters.ts:3117` (`run()=>[]`) |
| GAP-OPS-01 | No hosting/IaC/CD/automated rollback; forward-only migrations | High | ADR-0002 Proposed; `ci.yml` only |
| GAP-OPS-02 | Observability computes health, delivers nowhere (no exporter/tracing/dashboards/alert channel) | High | `observability.ts:56-62` |
| GAP-OPS-03 | TLS absent in-repo; secrets `.env`-only (no KMS/vault) | High | `nginx.conf:3` |
| GAP-OPS-04 | Backup encryption-at-rest/offsite flag-only, unexercised | Medium | `backup.mjs:41-42` |
| GAP-OPS-05 | Only `verify` CI job is a required check; branch-protection unverified | Medium | `branch-protection.md:15-16` |
| GAP-TEST-01 | 0 e2e/browser tests; no load/chaos/fault-injection; no tenant-isolation matrix | High | `tests/e2e/` empty |
| GAP-AUTO-01 | `owner-control` alerts-inbox + no unified workflow/rules engine (best owner engine unwired) | Medium | imported only by tests |
| GAP-INT-01 | Every integration test-mode; none against a real vendor; no vendor contract tests | High | `packages/integration` (injected transport) |

## Top-10 lists
**Top 10 launch blockers:** (1) no deployed environment/hosting (GAP-OPS-01); (2) TLS + secret store (GAP-OPS-03);
(3) observability delivery (GAP-OPS-02); (4) rate limiting/DoS (GAP-SEC-04); (5) DSR API + erasure for DPDP
(GAP-SEC-02/DATA-06); (6) audit crypto hash-chain (GAP-SEC-03); (7) offline numbering wired (GAP-SYNC-02);
(8) inbound sync (GAP-SYNC-01); (9) real payment/IdP providers (OA-4); (10) independent pentest QG-06.

**Top 10 architecture risks:** thin-service drift (GAP-ARCH-01); no transactions (GAP-DATA-01); single pg.Client
(GAP-DATA-09); no RLS (GAP-DATA-02); money-in-jsonb (GAP-DATA-04); no snapshots (GAP-DATA-05); single API/DB/box
SPOFs; no optimistic concurrency (GAP-DATA-03); no automated rollback / forward-only migrations (GAP-OPS-01);
no HA/replication.

**Top 10 data/security risks:** DSR-not-wired; erasure vs append-only; hash-chain not crypto; no RLS; no rate
limiting; no token revocation; support-expiry not at API; TLS/secret-store absent; backup encryption unexercised;
AI never run against a real model.

**Top 10 autonomy opportunities (wire, don't build):** reorder-PO drafting (A02+replenishment); owner
exception-alert feed (owner-control alerts-inbox); expiry/markdown/transfer suggestions (A03+fefo); duplicate/
anomaly flagging (A07/A08+loss-prevention); settlement/3-way-match exception routing; blind-count variance
routing; deterministic rules engine + unified approval inbox; AI drafting behind the governed ports; consent/
DSR back-office workflow; day-close pre-flight automation.

**Top 10 unnecessary complexities to AVOID (research-backed):** CRDTs/vector clocks; Kafka/Debezium; Kubernetes;
microservice fleet; vector DB/RAG-before-need; multi-agent AI swarms; per-tenant silos now; full CQRS; service
mesh/ZTNA mesh; multi-region active-active. None is justified at one-store scale.

**Quick wins (≤1 sprint each):** wire offline numbering (SYNC-01); pg.Pool (ADR-A02); wire owner-control
alerts-inbox; make all 3 CI jobs required; inject SHA-256 audit hasher; add rate limiting; publish OpenAPI.

**Structural improvements:** transaction boundaries; RLS + tenants FK; collapse thin services onto engines;
inbound sync; observability exporter/alert delivery; hosting/IaC/CD.

**Long-term differentiators:** the governed-autonomy layer (rare and safe); offline-first correctness; executable
guardrails as a living safety spec; honest exception-first owner control. These are genuine competitive moats
once wired and deployed.
