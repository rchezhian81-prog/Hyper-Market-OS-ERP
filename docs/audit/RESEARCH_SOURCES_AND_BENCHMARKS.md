# Research Sources & Benchmarks

_Deep architecture audit, 2026-08-09. External research to benchmark SRE Retail OS against authoritative
patterns. Every external claim is sourced; access date for all sources is **2026-08-09**. Recommendations
derived from these sources are marked **[REC]** and are the auditor's, not the source's._

## Reading frame
SRE Retail OS is a hybrid (cloud + offline-first edge) retail ERP/POS for **one** hypermarket in Tamil
Nadu, India — a few lanes, a few thousand SKUs, low-spec Android, a non-programmer owner. The recurring
finding: for **every** pattern below there is a "big-company" implementation and a "one-store" implementation.
The roadmap's own technology mandate ("the simplest architecture capable of meeting the verified
requirements") is **correct and confirmed by the sources** — CRDTs, Kafka, Kubernetes, a microservice fleet,
and vector databases are **not** justified at this scale.

## 1. Offline-first / local-first
- Ink & Switch — *Local-first software: you own your data, in spite of the cloud* — https://www.inkandswitch.com/essay/local-first/
- PowerSync — *Local-First Software: Origins and Evolution* — https://powersync.com/blog/local-first-software-origins-and-evolution

Local-first defines seven ideals (fast local reads/writes, multi-device, offline read+write, collaboration,
longevity, privacy, user control) and positions **CRDTs as one enabling technology, not a mandate**. CRDTs
solve *automatic concurrent-edit merging for many simultaneous writers on one document*. A single-store POS
has **one authoritative writer per record at a time** (a lane commits locally, then syncs).
**[REC]** Adopt the *ideals*; keep the existing **event-log + last-write-wins with visible conflict** model
(already the shape of Hard Rules #1/#2/#10). CRDTs are overkill and add metadata cost a low-spec Android does
not need.

## 2. Transactional outbox / inbox + idempotent consumers
- Chris Richardson — *Transactional outbox* — https://microservices.io/patterns/data/transactional-outbox.html
- Chris Richardson — *Idempotent Consumer* — https://microservices.io/patterns/communication-style/idempotent-consumer.html
- AWS Prescriptive Guidance — *Transactional outbox pattern* — https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html

Write the business change and the outbox row in the **same local transaction**; a relay publishes and may
publish more than once, so consumers must be idempotent (an "inbox"/processed table keyed by message id).
**[REC]** Directly serves Hard Rule #1. The edge already implements the outbox side (durable file-log +
idempotency keys). The gap the codebase has vs. this pattern: the local commit + outbox enqueue are **not
wrapped in one DB transaction** on the cloud side (persistence has no transaction boundaries — see GAP-DATA-01),
and there is **no cloud-side inbox/apply loop** for a return path. A plain outbox table + polling relay is
sufficient — **no Kafka/Debezium**.

## 3. Store-and-forward edge sync & conflict resolution
- OneUptime — *How to Create Edge-Cloud Sync* — https://oneuptime.com/blog/post/2026-01-30-edge-cloud-sync/view
- (conflict taxonomy) Ink & Switch local-first essay, §CRDTs and sync — https://www.inkandswitch.com/essay/local-first/

Conflict strategies, cheapest→costliest: **LWW** (simple, silently loses data if used blindly) → field-level
merge → **vector clocks** (distinguish causal vs concurrent) → **CRDTs** (auto-merge, highest overhead). Safe
retail compromise: LWW for the write, but **surface any detected concurrent write as a visible reconciliation
exception**. **[REC]** Exactly Hard Rules #1/#10. Use monotonic per-record versions + server timestamps; route
concurrency to an exception queue. Vector clocks/CRDTs unjustified for per-record single ownership.

## 4. Multi-tenant SaaS isolation (pooled vs siloed; RLS)
- AWS Well-Architected SaaS Lens — *Silo isolation* — https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/silo-isolation.html
- AWS Well-Architected SaaS Lens (whitepaper PDF) — https://docs.aws.amazon.com/pdfs/wellarchitected/latest/saas-lens/wellarchitected-saas-lens.pdf

**Silo** (per-tenant infra — strongest, costliest), **Pool** (shared tables, tenant enforced logically e.g.
Postgres **Row-Level Security** on `tenant_id`), **Bridge** (silo the sensitive, pool the rest). A hard line
separates the shared **control plane** from the tenant **application plane**. **[REC]** SRE is effectively
single-tenant today; build **pooled + Postgres RLS + a mandatory `tenant_id`** so multi-store is possible
later without re-architecture, and do **not** pay for silo infra now. The codebase's isolation is currently
**application-level `WHERE tenant_id` only, with no RLS and no `tenants` table/FK** (GAP-DATA-02) — RLS is the
cheap defense-in-depth that closes it.

## 5. Event-driven architecture & event sourcing trade-offs
- Martin Fowler — *Event Sourcing* — https://martinfowler.com/eaaDev/EventSourcing.html
- Martin Fowler — *CQRS* — https://martinfowler.com/bliki/CQRS.html
- Microsoft Azure Architecture Center — *Event Sourcing pattern* — https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing

State changes as an ordered immutable log; current state is a fold (natural audit, temporal queries,
rebuildable read models). Trade-offs: eventual consistency between write/read models, schema-versioning
difficulty, high migration cost. CQRS is optional. **[REC]** SRE already applies this **narrowly and correctly**
to ledgers (stock/cash/loyalty) where append-only + compensating events is mandated. Keep it ledger-scoped;
**do not event-source the whole system**; skip full CQRS until read-load proves it necessary. Add **snapshots**
(currently missing — GAP-DATA-05) before event volumes make full-fold reads slow.

## 6. Human-in-the-loop AI governance, autonomy, kill switches
- NIST — *AI Risk Management Framework (AI RMF 1.0)*, AI 100-1 — https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-1.pdf · hub https://www.nist.gov/itl/ai-risk-management-framework
- OWASP — *Top 10 for LLM Applications 2025* (PDF) — https://owasp.org/www-project-top-10-for-large-language-model-applications/assets/PDF/OWASP-Top-10-for-LLMs-v2025.pdf

NIST AI RMF: **Govern / Map / Measure / Manage**, Govern cross-cutting. OWASP LLM Top 10 (2025) keeps **Prompt
Injection (LLM01) at #1**, adds **Excessive Agency** and **System Prompt Leakage**; prescribes least-privilege
tooling, I/O filtering, **human approval for high-risk actions**, adversarial testing. **[REC]** This is exactly
principle P-05 / Hard Rule #5, and the codebase's AI authority layer already implements the posture
structurally (closed `FORBIDDEN_TOOLS`, gateway drops ungranted tools, admission-before-transport, human
commits). The gaps vs. the framework: **treat all AI tool inputs as untrusted** (it will read supplier
docs/messages), and add a **standing adversarial red-team battery** and a **first-class AI action audit** (both
currently thin — GAP-AI-01/02).

## 7. Zero-trust, secrets/key management, tamper-evident audit
- NIST — *SP 800-207: Zero Trust Architecture* — https://nvlpubs.nist.gov/nistpubs/specialpublications/NIST.SP.800-207.pdf
- (tamper-evident logging overview) DesignGurus — *tamper-evident audit logs (Merkle trees, hashing)* — https://www.designgurus.io/answers/detail/how-do-you-design-tamperevident-audit-logs-merkle-trees-hashing

Zero-trust's seven tenets: treat everything as a resource, secure all comms regardless of network location,
per-request least-privilege from dynamic context, assume breach, monitor. Tamper-evident logs = append-only +
**hash-chained** records (each entry hashes the prior), optionally Merkle-anchored. **[REC]** Serves P-04 /
Hard Rules #4/#6. A **hash-chained append-only audit table + a managed secrets store with rotation** is
proportionate — no ZTNA mesh needed. The codebase has the hash-chain **engine** (`packages/audit`) but it is
**not wired to the durable `audit_log`**, and its default hasher is **non-cryptographic FNV-1a** with no
evidence SHA-256 is injected in production (GAP-SEC-03). Apply the tenets to the ~dozen services (per-request
auth already done; add rate limiting, GAP-SEC-04).

## 8. India DPDP Act 2023 (customer/loyalty PII)
- MeitY / PIB — *Digital Personal Data Protection (DPDP) Rules, 2025* — https://www.pib.gov.in/PressReleasePage.aspx?PRID=2190655
- EY — *Decoding the DPDP Act, 2023* — https://www.ey.com/en_in/insights/cybersecurity/decoding-the-digital-personal-data-protection-act-2023
- Primary Act text — MeitY — https://www.meity.gov.in/ (verify final gazette PDF)

DPDP requires **explicit, informed, revocable consent** via purpose-specific notice; rights of access,
correction, erasure, grievance; **purpose limitation and deletion on withdrawal/purpose-end** (barring legal
retention); **breach notification to the Data Protection Board without delay**; penalties up to ₹250 crore.
Timeline: **Rules 2025 notified, Board operational Nov 2025, substantive obligations phasing toward ~2027**.
**[REC]** Highly relevant — the shop holds loyalty PII. The codebase has consent capture (wired) and a tested
erasure **plan engine**, but **data-subject rights are not on the API surface** and there is **no erasure/tombstone
fulfilment against the append-only ledger** (GAP-SEC-02/DATA-06). Build the DSR route + audited fulfilment +
retention timers + a breach runbook on the roadmap's schedule; the data model must not be deferred.

## 9. PCI-DSS (tokenized/no-PAN) & RBI card tokenization
- PCI SSC — *Self-Assessment Questionnaire (SAQ)* library — https://www.pcisecuritystandards.org/document_library/
- RBI Card-on-File / tokenization — bank summary: HDFC — https://www.hdfc.bank.in/blogs/credit-cards/what-are-the-rbi-guidelines-on-tokenisation-in-india (verify the primary RBI DPSS circular at rbi.org.in)

Never storing/processing/transmitting plaintext cardholder data (full outsourcing to a PCI-compliant PSP)
puts a merchant in the smallest scope — **SAQ A**. RBI CoF rules (eff. 01-Oct-2022) prohibit anyone but the
issuer/network storing card-on-file data; merchants keep only a **network token** + non-sensitive reference
(last four, issuer). UPI has no PAN. **[REC]** Perfectly aligned with Hard Rule #3; the codebase's
payment-tokenization port already encodes RBI-authorised retention and refuses `stores_card_data`. Target
**SAQ A** via a tokenizing PSP/UPI. *Verify current PCI DSS v4.0.1 SAQ-A eligibility text and the exact RBI
circular number/date against primary sources before a compliance filing.*

## 10. Backup/DR, observability, API versioning
- AWS Well-Architected Reliability — *REL13-BP01 Define recovery objectives (RTO/RPO)* — https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_planning_for_recovery_objective_defined_recovery.html
- Google SRE Book — *Monitoring Distributed Systems* (four golden signals) — https://sre.google/sre-book/monitoring-distributed-systems/
- Semantic Versioning 2.0.0 — https://semver.org/ · OpenAPI Specification — https://spec.openapis.org/oas/latest.html

DR governed by **RPO/RTO**; AWS DR ladder Backup&Restore → Pilot Light → Warm Standby → Multi-site.
Observability baseline = **four golden signals** (latency, traffic, errors, saturation). API surface =
**SemVer 2.0.0** + **OpenAPI** contracts. **[REC]** Serves P-08 / P-06. For one store the **Backup & Restore
tier** (tested restores; RPO minutes, RTO hours) is proportionate — and the codebase already proves a
restore-with-reconciliation in CI. Add the four golden signals as a small high-value metric set (currently the
metrics endpoint has **no exporter** — GAP-OPS-02), and publish **OpenAPI** for the 13 APIs to protect the
offline edge from breaking changes (the paths are versioned `/v1/...` but no OpenAPI doc is emitted).

## Cross-cutting verdict from the research
The lightweight variants — event-log + LWW-with-visible-conflict, plain outbox + durable queue, pooled
Postgres + RLS, ledger-only event sourcing, hash-chained audit + managed secrets, SAQ-A tokenization,
Backup-&-Restore DR, four golden signals, SemVer + OpenAPI — **fully satisfy** the roadmap's principles and
Hard Rules without the operational weight the codebase's own instructions warn against. The audit's target
architecture (TARGET_HYBRID_ARCHITECTURE.md) adopts exactly these.

## Sourcing caveats (flagged for compliance use)
- The **RBI tokenization circular number/date** and **PCI DSS v4.0.1 SAQ-A eligibility** should be confirmed
  against rbi.org.in and the PCI SSC library respectively before any compliance filing.
- The **DPDP enforcement timeline** (Rules notified late-2025; obligations phasing ~2027) is from PIB/EY
  secondary coverage; confirm final phase-in dates in the notified DPDP Rules 2025.
- Primary standards (NIST SP 800-207, NIST AI 100-1, OWASP LLM Top 10 2025, semver.org, sre.google, AWS docs,
  Fowler, microservices.io) are cited from authoritative origins.
