# Security & Privacy Threat Model

_Deep architecture audit, 2026-08-09. Verified against `services/identity`, `services/kernel`, `services/api`
(roles/access/pipeline), `packages/rbac`, `packages/ai`, `packages/audit`, `packages/customer`,
`db/migrations`, and the security/guardrail suites. Complements the project's own
`docs/security/threat-privacy-model.md`, which this audit finds **broadly sound but overstated in two places**
(DSR self-service; rate limiting)._

## Overall posture
The **code-level** security design is strong and, in several places, better than typical for a product at this
stage: a hardened JWT verifier, registration-time route validation forcing a permission on every endpoint,
default-deny RBAC rebuilt per request from the ledger, maker-checker that blocks approver-privilege-escalation,
a cross-tenant/PAN **egress backstop that 500s rather than redacts**, boot-time refusal of placeholder/short
secrets, closed AI forbidden-tool list, and a comprehensive guardrail suite encoding each Hard Rule as a CI
tripwire. **However, nothing is production-verified** (the system is pre-pilot; QG-06 — zero critical/high plus
an independent pentest — is a documented gate not yet met), and there are **five real, verified control gaps**
(DSR-not-on-API, audit hash-chain not cryptographically wired, no rate limiting, no token revocation,
support-expiry not enforced at the API tier).

## Trust boundaries (as-built)

```mermaid
flowchart TB
  subgraph Untrusted["Untrusted"]
    C[POS/ERP/customer clients]
    EXT[External providers\npayment / Tally / messaging / webhooks]
    SUP[Supplier docs & inbound messages\n= AI tool inputs]
  end
  subgraph Edge["Store-edge (loopback only)"]
    SE[served screens 127.0.0.1\nGET, no-store, X-Frame DENY]
  end
  subgraph Cloud["Cloud control + data plane"]
    K[Kernel pipeline\nauthenticate -> authorize -> body]
    K --> RBAC[default-deny RBAC\nper-request from ledger]
    RBAC --> DOM[13 domain APIs]
    DOM --> DB[(event_ledger append-only\ntenant-scoped)]
    K --> EG[scanOutbound\ncross-tenant / card-shape -> 500]
    AIG[AI gateway\nadmission-before-transport\nforbidden-tool subtraction] --> DOM
    SUP --> AIG
  end
  C -->|HS256 bearer, tenant from signed claim| K
  EXT -->|HMAC-signed webhooks, vault:// keys| DOM
  classDef gap fill:#fee,stroke:#c00;
  RL[[no rate limiting / lockout]]:::gap --> K
  REV[[no token revocation]]:::gap --> K
```

## STRIDE-style summary (verified controls vs. gaps)

| Threat | Control in place (evidence) | Status | Gap |
|---|---|---|---|
| **Spoofing** (forged token, alg-confusion) | Verifier pins HS256, verifies signature before claims, timing-safe compare, `exp/iss/aud` required (`services/identity/src/token.ts:106-190`) | Implemented | No **token revocation/denylist**; leaked token valid to `exp` (`token.ts:31-32`) — GAP-SEC-05 |
| **Tampering** (edit ledger/audit) | DB triggers refuse UPDATE/DELETE on `event_ledger`/`config_versions`/`audit_log` (`0004`,`0008`); code guardrail `ledger-append-only` | Implemented | Hash-chain (`packages/audit`) **defaults to FNV-1a (non-crypto) and is not wired to `audit_log`**; no proof SHA-256 injected in `main.ts` — GAP-SEC-03 |
| **Repudiation** | Audit on every write and refusal (`pipeline.ts:274-290,386-388`); `SqlAuditSink` wired (`main.ts:411`) | Implemented | audit_log has no hash-chain columns → durable table is append-only but not tamper-*evident* by itself |
| **Information disclosure** (cross-tenant, PAN, error leakage) | `scanOutbound` 500s on foreign tenantId or card-shaped body (`pipeline.ts:144-180`); flat `unauthenticated`; three-part error, no stack (`errors.ts`) | Implemented (strong) | Isolation is **application-level only — no Postgres RLS, no `tenants` FK** (defense rests on the one backstop) — GAP-DATA-02 |
| **Denial of service** | — | **Missing** | **No rate limiting / throttling / 429 / auth-attempt lockout** in the kernel (only the AI budget 429). Documented in threat model, not enforced (OWASP API4:2023) — GAP-SEC-04 |
| **Elevation of privilege** | RBAC default-deny, no wildcards; maker-checker blocks granting a permission the approver lacks (`identity/src/index.ts:94-100`); SoD baked into role table | Implemented (strong) | Support-access **expiry enforced in web-erp session, not the API request tier** (`admin-session.ts` vs `services/api`) — GAP-SEC-06 |
| **AI-specific** (prompt injection, excessive agency, unsafe tool use) | Closed `FORBIDDEN_TOOLS`, gateway drops ungranted tools, admission-before-transport, untrusted evidence fenced not concatenated, provider-neutral guardrail (`packages/ai/src/authority.ts`,`gateway.ts`,`safety.ts`) | Implemented (structurally strong) | Injection detection is **advisory (`blocks:false`)**; **no standing red-team battery**; **never run against a real model** — GAP-AI-01 |

## Privacy / DPDP 2023

| Obligation | As-built | Status |
|---|---|---|
| Explicit, purpose-specific, **revocable** consent; withdrawal as easy as giving | `mayWeSend` per-purpose/channel/now; latest record wins so withdrawal overrides; absence ≠ consent; withdrawal is one symmetric function (`services/customer/src/index.ts:62-98`, `apps/customer-app/src/privacy-centre.ts:1-40`) | **Implemented & wired** |
| Consent checked at **point of use**, not collection | `services/customer/src/index.ts:1-10` | Implemented |
| Data-subject **access / export / erasure** | Engine `planErasure`/`fulfilRequest` classifies erase/minimise/**retain** with statute cited, never deletes audit (`packages/customer/src/data-rights.ts:100-241`) — **but referenced only by tests/app; NO `services/api` route, NO permission in `ROLE_CATALOGUE`**; the app only *raises* a request | **Engine tested, NOT on API surface** — GAP-SEC-02 (**highest privacy gap**) |
| **Erasure/anonymization against the append-only store** | No tombstone table, no field-level PII redaction of jsonb payloads; PII sits in `event_ledger.payload` | **Structurally unaddressed** — GAP-DATA-06 |
| PII minimisation | AI safety default-deny allowlist (`packages/ai/src/safety.ts:256-326`, fixed a real blocklist→allowlist bug that had leaked aadhaar/pan/gstin) | Implemented (AI path) |
| Breach notification to DPB "without delay" | Runbook `docs/runbooks/security-incident.md` exists | Documented (process only) |

The project's own threat model claim of "erasable, self-service" (`threat-privacy-model.md:24,54-58`) **overstates
the wired reality** and should be corrected to "erasure *plan* engine, back-office fulfilment pending an API
route." Note DPDP substantive enforcement phases toward ~2027 (see RESEARCH §8) — time exists, but the data
model and the DSR route belong on the roadmap now.

## Payment / PCI (Hard Rule #3)
Two independent controls: a **static field ban** (`card-data` guardrail — no `card_number/pan/cvv/card_expiry`
anywhere, one allowlisted log-redaction file) and a **runtime Luhn+prefix+length scan** that 500s any
card-shaped response (`pipeline.ts:100-142`). The payment-tokenization port encodes RBI-authorised retention
and refuses `stores_card_data`. **[REC]** Target **PCI SAQ A** via a tokenizing PSP so card data never touches
the system (RESEARCH §9). Status: **Implemented, not production-verified** (no live PSP).

## Prioritised risk register (security & privacy)
1. **Nothing production-verified / QG-06 unmet.** Controls are integration-tested, not pentested; treat all
   "green" as pre-pilot. *(SEC-risk #1)*
2. **DSR access/export/erasure not on the API surface** — highest privacy gap; DPDP-relevant. *(GAP-SEC-02)*
3. **Audit hash-chain not cryptographically wired** (FNV-1a default; SHA-256 injection unverified; not connected
   to `audit_log`). Tamper-evidence weaker than documented; mitigated only by droppable DB triggers. *(GAP-SEC-03)*
4. **No rate limiting / DoS control / auth-attempt lockout.** *(GAP-SEC-04)*
5. **No token revocation / short-TTL strategy** — dependent on the (unchosen) IdP. *(GAP-SEC-05)*
6. **Support-access expiry not enforced at the API tier.** *(GAP-SEC-06)*
7. **Tenant isolation is application-level only — add Postgres RLS + `tenants` FK** as defense-in-depth. *(GAP-DATA-02)*
8. **AI never exercised against a real model**; injection detection advisory; no standing red-team. *(GAP-AI-01)*
9. **TLS / secret-store / key-rotation are deployment-layer with no in-repo evidence** (no TLS in nginx; `.env`
   files only; no KMS/vault integration). *(GAP-OPS-03)*
10. **Encryption at rest for backups is flag-only, unexercised.** *(GAP-OPS-04)*

## Recommended controls (target; roadmap IDs in the roadmap doc)
- **SEC-01 (P0):** wire DSR access/export/erasure onto the audited API + a `privacy.dsr.*` permission + fulfilment
  that pseudonymises PII in projections while keeping the append-only ledger + legal-hold intact (tombstone/
  redaction strategy for jsonb PII).
- **SEC-02 (P0):** inject a **cryptographic SHA-256 hasher** into `AuditTrail` in production and **chain-link the
  durable `audit_log`** (add prev-hash/hash columns); publish the verify tool.
- **SEC-03 (P0):** add **rate limiting + auth-attempt backoff/lockout** in the kernel pipeline (per-tenant + per-IP).
- **SEC-04 (P1):** define token TTL + rotation + a revocation/denylist path with the chosen IdP; short access
  tokens + refresh.
- **SEC-05 (P1):** enforce **support-session liveness at the API tier** (middleware that revokes a live request
  when the support clock expires), not only in web-erp.
- **SEC-06 (P1):** **Postgres RLS** on `tenant_id` + a `tenants` table/FK as defense-in-depth behind the egress
  backstop.
- **SEC-07 (P1):** **TLS everywhere** + a **managed secret store with rotation** (deployment) + backup
  encryption-at-rest actually exercised.
- **SEC-08 (P1):** a **standing AI red-team battery** (jailbreak/data-exfil/prompt-injection corpus) and, once a
  provider is chosen, a live-model adversarial pass; keep injection detection defense-in-depth alongside the
  structural controls.
- **SEC-09 (P2, gate):** independent **penetration test** to satisfy QG-06 before public launch.
