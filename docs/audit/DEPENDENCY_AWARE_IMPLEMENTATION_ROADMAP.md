# Dependency-Aware Implementation Roadmap

_Deep architecture audit, 2026-08-09. One controlled active sequence, with explicit gates. Do **not** run several
risky streams in parallel. Each item: ID · outcome · scope · deps · priority · risk · effort · phase · role ·
tests · acceptance · evidence · rollback/kill-switch · "do-not-start-before" gate._

## Sequencing principle
Security/data-integrity foundations **before** hybrid hardening **before** core wiring **before** integrations
**before** automation **before** AI **before** pilot **before** launch. Autonomy is deliberately near the end,
gated behind a pilot. Effort scale: S ≤ 3 days · M ≤ 2 weeks · L ≤ 6 weeks.

## Phase 0 — Immediate stabilization (quick wins, no owner decision needed)
| ID | Outcome | Deps | Pri | Risk | Effort | Role | Acceptance / evidence | Rollback |
|---|---|---|---|---|---|---|---|---|
| STAB-01 | **pg.Pool** replaces shared single client; ≥2 API instances runnable | — | P0 | Low | S | Backend | concurrency test green; no shared-client SPOF | revert to client |
| STAB-02 | **Offline receipt numbering** wired to POS (reserved ranges) | — | P0 | Med | M | Backend+Edge | TEST-01: two lanes offline → no dup numbers (QG-04) | feature-flag off → timestamp |
| STAB-03 | Wire **owner-control alerts-inbox** into owner/erp (read-only L1/L2) | — | P0 | Low | S | Full-stack | owner sees grouped exception alerts; integration test | flag off |
| STAB-04 | Make **`integration`+`deploy` CI jobs required**; run `test:perf` (non-blocking) | — | P0 | Low | S | DevOps | branch ruleset shows 3 required checks | n/a |
| STAB-05 | Correct 3 doc overstatements (DSR self-service, bidirectional sync, hash-chain wired) | — | P1 | Low | S | Docs | docs match code | n/a |

**Gate G0:** STAB-01/02 green before any further data work.

## Phase 1 — Security & data-integrity foundations
| ID | Outcome | Deps | Pri | Risk | Effort | Role | Acceptance | Rollback |
|---|---|---|---|---|---|---|---|---|
| FND-01 | **Transaction boundaries** for multi-event commands (ADR-A03) | STAB-01 | P0 | Med | M | Backend | TEST-04: crash mid-command → no partial event set | revert append API |
| FND-02 | **SHA-256 audit hash-chain** injected + `audit_log` chain-linked (ADR-A05) | — | P0 | Low | M | Security | verify tool detects any edit; SHA-256 in prod wiring | keep triggers |
| FND-03 | **Rate limiting + auth-attempt lockout** in kernel (SEC-03) | — | P0 | Low | S | Backend | 429 under flood; lockout after N fails | flag off |
| FND-04 | **Postgres RLS + `tenants` FK** (ADR-A04) | STAB-01 | P1 | Med | M | DB | TEST-03 tenant-isolation matrix green with RLS on | disable policies |
| FND-05 | **DSR API + audited erasure/anonymization** vs append-only store (ADR-A10) | FND-02 | P1 | Med | L | Backend | access/export/erasure over API; PII pseudonymised in projections; legal-hold intact | flag off |
| FND-06 | **Typed money** columns / guards for jsonb money; guard `idempotency_keys` | FND-01 | P2 | Low | M | DB | no JS-safe-int risk; idempotency immutable | additive |

**Gate G1 (Security foundation):** FND-01/02/03 green; TEST-03/04 exist. No integration or automation work
starts before G1.

## Phase 2 — Hybrid / offline hardening
| ID | Outcome | Deps | Pri | Risk | Effort | Role | Acceptance | Rollback |
|---|---|---|---|---|---|---|---|---|
| SYNC-01 | **Inbound pack sync** (signed pull + atomic swap + pack-age on screens) (ADR-A06) | G1 | P0 | Med | L | Edge+Backend | fresh prices/recalls reach the box; age surfaced | fall back to file drop |
| SYNC-03 | **Structured conflict object + operator dead-letter/resolution UI** | SYNC-01 | P1 | Med | M | Full-stack | manager can retry/resolve a dead-letter; two-sided conflict shown | read-only view |
| SYNC-06 | **Headless-offline e2e** (Playwright, network cut) (TEST-02) | — | P1 | Low | M | QA | screens open with network down | n/a |
| SYNC-04 | **Clock-drift detection** (flag skewed box) | — | P2 | Low | S | Edge | skew > threshold → visible exception | n/a |

**Gate G2 (Offline hardening):** SYNC-01 + SYNC-06 green.

## Phase 3 — Core product gap closure (collapse thin services onto engines)
| ID | Outcome | Deps | Pri | Risk | Effort | Role | Acceptance | Rollback |
|---|---|---|---|---|---|---|---|---|
| CORE-01 | **Collapse thin services onto tested engines** (finance, orders, inventory, customer, fulfilment, reporting); add `wired_via` to traceability (RTM-01) | G1 | P0 | High | L | Backend | services import the proven engines; drift guardrail green | per-service flag |
| CORE-02 | **Finance (M23) + Reporting (M29)** wired end-to-end (owner's core surfaces) | CORE-01 | P0 | Med | L | Backend | period-close + owner reports on real read-models; integration-tested | flag off |
| CORE-03 | **Snapshots** for projections (ADR-A03-adjacent) | FND-01 | P1 | Med | M | Backend | full-fold reads bounded; perf budget holds at volume | additive |
| CORE-04 | Remaining PARTIALLY-WIRED modules to WIRED+INTEGRATION-TESTED as prioritised | CORE-01 | P1 | Med | L | Backend | ladder advances with evidence | per-module |

**Gate G3 (Core):** CORE-01/02 green; ≥15 modules INTEGRATION-TESTED+.

## Phase 4 — Integration framework (one real provider per category, sandbox)
| ID | Outcome | Deps | Pri | Risk | Effort | Role | Acceptance | Rollback |
|---|---|---|---|---|---|---|---|---|
| INT-01 | **Payment/UPI tokenizing PSP** (test→sandbox); SAQ-A posture | G3, OA-4 | P0 | Med | L | Integrations | sandbox round-trip + settlement reconcile; no PAN | test-mode |
| INT-02 | **Tally connector** live sandbox | G3 | P1 | Med | M | Integrations | posting idempotent, dead-letter, reconcile | test-mode |
| INT-03 | **Messaging/notifications** live (consent+budget) | G3 | P1 | Low | M | Integrations | consent-gated send; suppression | test-mode |
| INT-04 | **Vendor contract tests** (TEST-08) | INT-01..03 | P1 | Low | M | QA | sandbox contract fidelity green | n/a |
| INT-05 | **OpenAPI** published + surface-contract cross-check (ADR-A09) | — | P2 | Low | S | Backend | OpenAPI matches catalogue | n/a |

**Gate G4 (Integration):** INT-01 + INT-04 green. Real IdP integrated (OA-4).

## Phase 5 — Deployment & operational readiness
| ID | Outcome | Deps | Pri | Risk | Effort | Role | Acceptance | Rollback |
|---|---|---|---|---|---|---|---|---|
| OPS-01 | **Hosting chosen; staging + IaC + CD + automated rollback** (ADR-A11) | OA-5 | P0 | High | L | DevOps | staging mirrors prod; one-click rollback; migrate forward+guarded | CD rollback |
| OPS-02 | **Observability delivery**: metrics exporter + tracing + alert channel (4 golden signals) (ADR-A08) | OPS-01 | P0 | Med | M | SRE | dashboards live; alerts page a human | n/a |
| OPS-03 | **TLS everywhere + managed secret store + backup encryption exercised** | OPS-01 | P0 | Med | M | SRE | TLS on all ingress; secrets in store; encrypted offsite restore proven | n/a |
| OPS-04 | **DB read replica + failover drill; SLO/RTO/RPO instrumented** | OPS-01 | P1 | Med | M | SRE | failover drill meets RTO/RPO | n/a |
| OPS-05 | **Load / chaos / fault-injection suites** in staging (TEST-05/06) | OPS-01 | P1 | Med | L | QA/SRE | target volume + injected faults pass | n/a |

**Gate G5 (Ops):** OPS-01/02/03 green; SLOs defined.

## Phase 6 — Governed automation (AI-assisted → approval-gated)
| ID | Outcome | Deps | Pri | Risk | Effort | Role | Acceptance | Kill-switch |
|---|---|---|---|---|---|---|---|---|
| AUTO-01 | **Deterministic rules/workflow engine + unified approval inbox** (ADR-A12) | G3 | P1 | Med | L | Backend | rules execute L4 housekeeping; inbox commits L3 | global disable |
| AUTO-02 | **L2 drafts**: reorder-PO + markdown/transfer suggestions (read+draft only) | AUTO-01 | P1 | Low | M | Backend | drafts appear with evidence; human commits | flag off |
| AUTO-03 | **L3 approval-gated execution** via inbox for the above | AUTO-02, pilot | P2 | Med | M | Backend | executes only on human approval; fully audited/reversible | flag off |
| AI-01 | **Live model behind governed ports** + **AI audit route** + **red-team battery** (TEST-07) + eval-as-CI-gate + prompt/model versioning | AUTO-01, G5 | P1 | High | L | AI | eval gate green; red-team cannot obtain forbidden tool; kill-switch default-on | kill switch |

**Gate G6 (Automation):** AUTO-01/02 green; AI-01 only after a pilot is running and the eval gate + red-team
exist. **Never** enable any commit-capable automation.

## Phase 7 — Controlled pilot → public launch
| ID | Outcome | Deps | Pri | Acceptance / evidence |
|---|---|---|---|---|
| PILOT-01 | **Single-store pilot** on real hosting, test-mode payments (OA-4 pilot posture), real staff/devices | G5 | P0 | pilot run-sheet green; owner sign-off; cutover-gate rehearsed |
| PILOT-02 | **a11y sweep + native-Tamil review (OA-10) + low-spec device test** (TEST-09) | G5 | P1 | WCAG 2.2 AA; Tamil confirmed by a native speaker |
| LAUNCH-01 | **Independent penetration test (QG-06)**; zero critical/high | PILOT-01 | P0 | pentest report; findings closed |
| LAUNCH-02 | **Real payment/IdP providers** to production; production-verify the top modules | OA-4, PILOT-01 | P0 | UAT/production evidence per module |
| LAUNCH-03 | **Public launch** (supervised → unsupervised) | LAUNCH-01/02 | P0 | SLOs held through pilot; DR drill passed |

## Critical path (single active sequence)
`STAB-01/02 → G0 → FND-01/02/03 → G1 → SYNC-01/06 → G2 → CORE-01/02 → G3 → INT-01/04 (+OA-4 IdP) → G4 →
OPS-01/02/03 → G5 → AUTO-01/02 → PILOT-01 → LAUNCH-01/02 → LAUNCH-03.`
Do not begin a phase before its predecessor's gate is green. AI live-model (AI-01) and L3 execution (AUTO-03)
run **only** after the pilot is live.

## Owner decisions that gate the roadmap (see EXECUTIVE_ARCHITECTURE_AUDIT.md for the table)
- **OA-5 (hosting)** gates all of Phase 5. **OA-4 (payment + IdP providers)** gates Phase 4/launch. **OA-10
  (native-Tamil review)** gates PILOT-02. **OA-12 (plans/pricing)** gates only multi-tenant commercialisation.
