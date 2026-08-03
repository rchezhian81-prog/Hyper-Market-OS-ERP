# Cross-cutting requirement sets (SEC · PRV · NFR · AI-NFR · MG)

- **Roadmap:** §9.1 (SEC), §9.2 (PRV), §10 (NFR), §7.1 (AI-NFR), §17 (MG). Verbatim from the
  roadmap — nothing invented.
- **Purpose:** the standards every module inherits. Each item below is mapped to **where it is
  already addressed** (a guardrail, a foundation package, an ADR, a design doc) or where it
  will be. Full row-level verification happens at each item's build stage / quality gate; this
  doc is the map.

## SEC — Security (§9.1)

| ID | Requirement | Addressed by |
| --- | --- | --- |
| SEC-01 | Threat modelling before build and material architecture changes | `docs/security/threat-privacy-model.md`; ADR-0001/0003; re-run per change |
| SEC-02 | Zero-trust identities for users, devices and services | M01/M02; `packages/rbac`; §35 trust boundaries |
| SEC-03 | Least privilege, MFA, privileged access, separation of duties | `packages/rbac` (default-deny), `packages/approvals` (§28); `shared-login` guardrail; M33 |
| SEC-04 | Encryption in transit & at rest; centralized secrets & key rotation | Threat model §5; ADR-0002 (infra); `secrets` guardrail |
| SEC-05 | Signed apps/updates, dependency scanning, SBOM, patch SLAs | AID-04/05; CI; ADR-0002 |
| SEC-06 | API gateway, rate limits, WAF, mobile hardening, secure local storage | `docs/api/catalogue.md` conventions; ADR-0002 |
| SEC-07 | Tamper-evident audit logs & centralized security monitoring | M34 (append-only audit); `ledger-append-only` guardrail; NFR-09 |
| SEC-08 | Immutable/off-site backup, restore proof, ransomware isolation | M35; ADR-0002; hard rule #6 |
| SEC-09 | Secure SDLC, code review, automated tests, penetration testing | AID-02/03/07; QG-06; the test suite |
| SEC-10 | Incident response, breach assessment, communication, evidence preservation | Runbook (to write, `docs/runbooks/`); M34 |
| SEC-11 | Production access approval, session recording/logging, time limits | M33 support access (time-bound, audited); hard rule #7 |
| SEC-12 | PCI-scope minimization; never store prohibited card data | **hard rule #3**; `card-data` guardrail; `packages/tender` (tokens only) |

## PRV — Privacy (§9.2)

| ID | Requirement | Addressed by |
| --- | --- | --- |
| PRV-01 | Data inventory, purpose & lawful-processing register | Threat model data classification; M16; register (to record) |
| PRV-02 | Clear multilingual notices & consent evidence | M16-FR-02; customer-app privacy centre; NFR-08 (En/Ta) |
| PRV-03 | Purpose limitation & collection minimization | M16; threat model (PII minimized) |
| PRV-04 | Consent withdrawal as easy as giving it | M16-FR-02; M21 respects consent |
| PRV-05 | Access, correction, erasure & grievance workflows | M16-FR-03; customer-app |
| PRV-06 | Processor/subprocessor register & contractual controls | To record; M32 connectors / M36 partners |
| PRV-07 | Children/minor handling policy | Owner policy; M16 |
| PRV-08 | Retention schedule & defensible deletion (statutory exceptions) | M16-FR-03; `packages/config`; hard rule #6 (never delete audit) |
| PRV-09 | Breach detection, notification readiness, remediation | SEC-10; incident runbook |
| PRV-10 | Cross-border/data-location decisions recorded & configurable | ADR-0003 (India residency default; per-tenant); ADR-0002 |

## NFR — Non-functional (§10)

| ID | Requirement | Addressed by |
| --- | --- | --- |
| NFR-01 | Availability ≥99.9% cloud; store core independent of cloud | P-01; `packages/sale` offline commit; ADR-0002 |
| NFR-02 | POS p95 targets; no blocking network round-trip for local sale | §32; `pos-offline` guardrail; `packages/sale` |
| NFR-03 | Durability: acknowledged txns survive restart; sync once | `packages/sync` + `packages/ledger` (idempotent); §4.2 |
| NFR-04 | Scalability sized on stores/lanes/SKUs/peak after audit | ADR-0002 sizing; Stage-1 volumes (AVR-04) |
| NFR-05 | Security: OWASP, zero open critical/high at go-live, SLAs | SEC set; QG-06 |
| NFR-06 | Privacy: minimization, purpose, rights, retention | PRV set; M16 |
| NFR-07 | Accessibility: WCAG 2.2 AA (customer/web); staff paths | `docs/design/design-system.md`; customer-app spec |
| NFR-08 | Localization: English & Tamil first; Unicode/locale framework | `packages/contracts` enums; tenant `LANGUAGES` setting; design system |
| NFR-09 | Observability: metrics, logs, traces, freshness, queue indicators | M35; sync unsent-count; DLQ visibility |
| NFR-10 | Recoverability: audited RPO/RTO; restore & failover drills | M35; ADR-0002; the quarterly rebuild (AID-10) |
| NFR-11 | Maintainability: modular domains, versioned contracts, tests | `packages/` (one concern each); `packages/contracts`; the suite |
| NFR-12 | Portability: documented exports/APIs/backup; no lock-in | P-06; `docs/api/catalogue.md`; ADR-0002/0003 |
| NFR-13 | Usability: role task-completion targets; minimal cashier clicks | Design system (≤3 interactions); Stage-3 screen specs |
| NFR-14 | Compatibility: certified OS/browser/device/peripheral matrix | ADR-0002; AVR-06; M33 device control |
| NFR-15 | Auditability: every sensitive mutation reconstructable from evidence | `packages/ledger` (projected balances); M34; append-only |

## AI-NFR — AI control (§7.1)

| ID | Requirement | Addressed by |
| --- | --- | --- |
| AI-NFR-01 | Central model gateway & approved-model registry | `docs/design/screens/ai-control.md`; API-13 |
| AI-NFR-02 | Role/branch/purpose/tool-scoped access | AI-control spec; `packages/rbac` |
| AI-NFR-03 | Read-only default; explicit action permissions | AI-control spec; hard rule #5 |
| AI-NFR-04 | Evidence citations, confidence & uncertainty display | AI-control + owner specs |
| AI-NFR-05 | Prompt-injection / malicious-document / exfiltration defences | Threat model §7; AI-control spec |
| AI-NFR-06 | Sensitive-data minimization & redaction | Threat model; PRV |
| AI-NFR-07 | Human approval, monetary/quantity limits, separation of duties | `packages/approvals`; §28 |
| AI-NFR-08 | Immutable prompt/context/tool/result/action audit | M34; append-only |
| AI-NFR-09 | Evaluation datasets, accuracy thresholds, regression tests | AI-control spec; test families |
| AI-NFR-10 | Token/cost budgets, rate limits, fallback & kill switch | AI-control spec; ADR-0002 (metered) |
| AI-NFR-11 | Customer disclosure/consent for AI interaction/personalization | M16 consent; customer-app |
| AI-NFR-12 | No autonomous payment/refund/purchase/price/stock/privilege change | **hard rule #5**; `ai-agent-db-write` guardrail; `packages/approvals` |

## MG — Migration controls (§17)

| ID | Requirement | Addressed by |
| --- | --- | --- |
| MG-01 | Discovery: inventory every DB/file/report/volume/owner/retention | `docs/architecture/migration-design.md`; Stage-1 (AVR-03/04) |
| MG-02 | Preservation: verified source backups, immutable raw extracts + hashes | migration-design; hard rule #6 |
| MG-03 | Mapping: approve field/code/UOM/tax/branch/account/identity mappings | migration-design |
| MG-04 | Cleaning: dedupe products/barcodes/suppliers/customers; fix tax/stock/batches | migration-design; kept exceptions (#6) |
| MG-05 | Trial loads: repeatable full-volume in non-production | migration-design; hard rule #7 |
| MG-06 | Reconciliation: prove counts/quantities/values/balances/taxes/loyalty | migration-design; QG-07 control totals |
| MG-07 | History: migrate usable history; exclusions need owner approval | migration-design; OD-05 |
| MG-08 | Opening state: load & sign off stock/orders/outstanding/balances | migration-design; `packages/ledger` opening events |
| MG-09 | Delta: capture changes after final extract; load once | migration-design; idempotency (§31.1) |
| MG-10 | Parallel run: operate old & new, reconcile daily | migration-design; §34.1 |
| MG-11 | Cutover: rehearsed checklist, go/no-go, rollback, named team | migration-design; `docs/cutover/` (Stage 13) |
| MG-12 | Archive/retire: legacy read-only until retention met, then retire | migration-design; OD-06; hard rule #6 |

> Full verification is per item at its build stage / quality gate (QG-01…12). Where a
> guardrail or foundation package already enforces an item, that is noted above so the
> control is real today, not just planned.
