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
| SEC-02 | Zero-trust identities for users, devices and services | M01/M02; `packages/rbac` (default-deny, tables COPIED at construction so a held reference cannot widen a grant); `tests/security/access-control-sweep.test.ts` — the full 240-combination deny matrix against an independent oracle |
| SEC-03 | Least privilege, MFA, privileged access, separation of duties | `packages/rbac` (default-deny), `packages/approvals` (§28); `shared-login` guardrail; M33; `tests/security/separation-of-duties.test.ts` — every place in the product where one person could self-authorise, swept in one list, each proven to ALLOW with two people and REFUSE with one |
| SEC-04 | Encryption in transit & at rest; centralized secrets & key rotation | Threat model §5; ADR-0002 (infra); `secrets` guardrail |
| SEC-05 | Signed apps/updates, dependency scanning, SBOM, patch SLAs | AID-04/05; CI; ADR-0002 |
| SEC-06 | API gateway, rate limits, WAF, mobile hardening, secure local storage | `docs/api/catalogue.md` conventions; ADR-0002 |
| SEC-07 | Tamper-evident audit logs & centralized security monitoring | M34 (append-only audit); `ledger-append-only` guardrail; NFR-09 |
| SEC-08 | Immutable/off-site backup, restore proof, ransomware isolation | M35; ADR-0002; hard rule #6 |
| SEC-09 | Secure SDLC, code review, automated tests, penetration testing | AID-02/03/07; QG-06; the test suite |
| SEC-10 | Incident response, breach assessment, communication, evidence preservation | `docs/runbooks/security-incident.md` — the six-hour CERT-In clock starts at NOTICE not at understanding; contain without destroying evidence; ransomware handled before containment; evidence retained permanently (#6); M34-FR-04 registers |
| SEC-11 | Production access approval, session recording/logging, time limits | M33 support access (time-bound, audited); hard rule #7 |
| SEC-12 | PCI-scope minimization; never store prohibited card data | **hard rule #3**; `card-data` guardrail; `packages/tender` (tokens only); `tests/security/data-protection.test.ts` — `PERMITTED_PAYMENT_RETENTION` is a closed allowlist and the tender surface has nowhere to put a card number |

## PRV — Privacy (§9.2)

| ID | Requirement | Addressed by |
| --- | --- | --- |
| PRV-01 | Data inventory, purpose & lawful-processing register | Threat model data classification; M16; register (to record) |
| PRV-02 | Clear multilingual notices & consent evidence | M16-FR-02; customer-app privacy centre; NFR-08 (En/Ta) |
| PRV-03 | Purpose limitation & collection minimization | M16; threat model (PII minimized); `packages/ai/src/safety.ts` `minimisePii` — **default-deny**: business fields are opt-in and anything else is removed, so a field added to a customer record next year (aadhaar, PAN, bank account) is minimised by default. `tests/security/data-protection.test.ts` |
| PRV-04 | Consent withdrawal as easy as giving it | M16-FR-02; M21 respects consent |
| PRV-05 | Access, correction, erasure & grievance workflows | M16-FR-03; customer-app; `packages/customer/src/data-rights.ts` `planErasure` — per category, with the actual statute named, honest about being partial; erases fully where nothing is legally held; deletes nothing itself |
| PRV-06 | Processor/subprocessor register & contractual controls | To record; M32 connectors / M36 partners |
| PRV-07 | Children/minor handling policy | Owner policy; M16 |
| PRV-08 | Retention schedule & defensible deletion (statutory exceptions) | M16-FR-03; `packages/config`; hard rule #6 (never delete audit); `planErasure` MINIMISES where a record must survive but the person need not — the resolution of the erasure/retention tension |
| PRV-09 | Breach detection, notification readiness, remediation | SEC-10; `docs/runbooks/security-incident.md` — DPDP breach notification and the customer-notification decision reserved to the owner, with the words approved by them |
| PRV-10 | Cross-border/data-location decisions recorded & configurable | ADR-0003 (India residency default; per-tenant); ADR-0002 |

## NFR — Non-functional (§10)

| ID | Requirement | Addressed by |
| --- | --- | --- |
| NFR-01 | Availability ≥99.9% cloud; store core independent of cloud | P-01; `packages/sale` offline commit; ADR-0002 |
| NFR-02 | POS p95 targets; no blocking network round-trip for local sale | `tests/performance/pos-hot-path.test.ts` — scan is O(1) in catalogue size (proven flat at 100× data, with a tripwire that FIRES on a deliberate linear scan); commit runs with `fetch`/XHR/WebSocket removed from the runtime. Wall-clock measured with 50× headroom; **certification needs EX-09** |
| NFR-03 | Durability: acknowledged txns survive restart; sync once | `packages/sync` + `packages/ledger` (idempotent); `tests/performance/sync-and-endurance.test.ts` — enqueue and dedupe flat at 100× queue depth, 72h of trading held, backlog drains in order exactly once; §4.2 |
| NFR-04 | Scalability sized on stores/lanes/SKUs/peak after audit | ADR-0002 sizing; Stage-1 volumes (AVR-04) |
| NFR-05 | Security: OWASP, zero open critical/high at go-live, SLAs | SEC set; QG-06 |
| NFR-06 | Privacy: minimization, purpose, rights, retention | PRV set; M16 |
| NFR-07 | Accessibility: WCAG 2.2 AA (customer/web); staff paths | `packages/a11y/` — WCAG 2.2 AA contrast (one implementation for the product; fixed a rounding defect that passed a failing 4.48:1 grey), colour never the only signal (label + icon + announcement returned together), touch targets, focus order |
| NFR-08 | Localization: English & Tamil first; Unicode/locale framework | `packages/contracts` enums; tenant `LANGUAGES` setting; design system |
| NFR-09 | Observability: metrics, logs, traces, freshness, queue indicators | M35; sync unsent-count; DLQ visibility |
| NFR-10 | Recoverability: audited RPO/RTO; restore & failover drills | M35; ADR-0002; the quarterly rebuild (AID-10) |
| NFR-11 | Maintainability: modular domains, versioned contracts, tests | `packages/` (one concern each); `packages/contracts`; the suite |
| NFR-12 | Portability: documented exports/APIs/backup; no lock-in | P-06; `docs/api/catalogue.md`; ADR-0002/0003; `tests/contract/` — a v1 envelope written out literally and read by today's code (the till offline for three days), unknown fields carried not rejected, money as integer minor units on the wire, catalogue and code agreeing on event types |
| NFR-13 | Usability: role task-completion targets; minimal cashier clicks | `packages/a11y/src/signals.ts` `checkInteractionBudget` — the ≤3-interaction bar as an assertable number, with the steps named rather than counted |
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
| MG-01 | Discovery: inventory every DB/file/report/volume/owner/retention | `packages/migration/src/discovery.ts` `inventorySources` — an unowned source stays named in the inventory; estimated volume is a gap. **Stage 11 rehearsal**. **OB-06:** `extraction.ts` ranks the four self-extraction routes by what they structurally lose; `completeness.ts` refuses the paginated export that reconciles perfectly at a tenth of the shop |
| MG-02 | Preservation: verified source backups, immutable raw extracts + hashes | `discovery.ts` `sealExtract`/`verifyExtract` — sealed at extraction, verified at load; refused without a *verified* backup restore; digest AND row count. No edit/delete function exists (test-asserted) |
| MG-03 | Mapping: approve field/code/UOM/tax/branch/account/identity mappings | `packages/migration/src/mapping.ts` `approveMapping`/`mapValue`/`assessCoverage` — no fallback parameter; one legacy value → two targets refused at approval; coverage measured against the extract |
| MG-04 | Cleaning: dedupe products/barcodes/suppliers/customers; fix tax/stock/batches | `packages/migration/src/cleaning.ts` `detectExceptions`/`resolveException`/`buildMergeMap` — proposes only, merge is a redirection, every finding kept (#6). All ten planted fault kinds found by identity |
| MG-05 | Trial loads: repeatable full-volume in non-production | `packages/migration/src/trial.ts` `assertNonProduction`/`runTrialLoad` — production refused first, before every other check (#7); full volume; timing projected. **OB-06:** `report-parser.ts` and `render-report.ts` prove the parser against a known dataset rendered back into a printed page, so it is measured on ground truth rather than plausibility |
| MG-06 | Reconciliation: prove counts/quantities/values/balances/taxes/loyalty | `packages/migration/src/reconcile.ts` `recordControlTotal`/`assessReconciliation`/`signControlTotal` — identical derivations refused; `explained` closes to the rupee; loader cannot sign; CA signs finance/tax; **QG-07**. **Expanded by OB-06** (we extract ourselves, so nothing may be checked against the incumbent): six external checks — `count-verification.ts` (shelves), `supplier-reconciliation.ts` (their statement), `banking-verification.ts` (the bank), `tax-verification.ts` (filed returns), `books-verification.ts` (the CA's signed accounts), `loyalty-verification.ts` (the customers) — with `extraction.ts` holding the route/verification rules, `verification-report.ts` producing the page that gets signed, and `tests/integration/every-figure-has-a-witness.test.ts` gating that every domain has a witness with a module behind it |
| MG-07 | History: migrate usable history; exclusions need owner approval | `packages/migration/src/history.ts` `proposeExclusion`/`approveExclusion` — age alone refused; owner-only approval (OD-05); only approved exclusions explain a total |
| MG-08 | Opening state: load & sign off stock/orders/outstanding/balances | `reconcile.ts` `buildOpeningEvents` — opening EVENTS, never balances (#2); refused before QG-07; every figure traces to a signature. Banked in real PostgreSQL |
| MG-09 | Delta: capture changes after final extract; load once | `trial.ts` `applyDelta` — applied exactly once (§31.1); a re-send is a success; pre-cutoff changes refused as already loaded |
| MG-10 | Parallel run: operate old & new, reconcile daily | `packages/migration/src/cutover.ts` `compareParallelDay`/`ownDifference`/`parallelRunPosition` — same-day owner, last-write-wins phrasings refused (#10), clean days consecutive (§34.1) |
| MG-11 | Cutover: rehearsed checklist, go/no-go, rollback, named team | `cutover.ts` `decideCutover`/`performRollback` — GO refused on a *designed* rollback; all eight failures named at once; rollback needs no committee; `shopKeepsTrading: true` (P-01) |
| MG-12 | Archive/retire: legacy read-only until retention met, then retire | `history.ts` `assessRetirement` — retention from the latest record; untested restore blocks; `dataIsNeverDeleted: true`; no delete function exists (#6, test-asserted) |

> Full verification is per item at its build stage / quality gate (QG-01…12). Where a
> guardrail or foundation package already enforces an item, that is noted above so the
> control is real today, not just planned.
