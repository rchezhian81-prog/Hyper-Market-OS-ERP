# SRE Retail OS — Threat & privacy model (Stage 4)

- **Roadmap:** §35 (security & privacy), §28 (separation of duties), the **SEC-01…12** and **PRV-01…10** requirement sets, AI-NFR (§7.1). Principle **P-04** (secure by design). **Hard rules #3** (no card data), **#4** (no shared logins / no secrets in code), **#6** (never delete audit), **#7** (never touch prod from dev/test).
- **Purpose:** The secure-by-design model — trust boundaries, data classification, the threats we design against, and the privacy controls — set **before** code. **QG-06** (zero open critical/high at go-live; independent penetration test before customer launch) verifies it.

> Stage 4 model. SEC/PRV requirements are traced row-by-row during their build stages;
> the guardrail tripwires in `tests/guardrails/` already enforce the hard rules in CI.

## 1. Trust boundaries
| Boundary | Control |
| --- | --- |
| Client ↔ edge (LAN) | Device-authenticated; individual named users; **no shared logins** (#4) |
| Edge ↔ cloud (internet) | Authenticated/encrypted sync; **signed config packs** |
| Cloud service ↔ data | Least-privilege service identities |
| System ↔ external providers (payment, Tally, GST, WhatsApp, logistics) | Via connector SDK; secrets in a **vault**, never in code (#4) |
| Human ↔ system | RBAC + maker-checker (§28); **time-bound, audited** support access |
| AI gateway ↔ domains | **Scoped tools only; no DB writes** (#5) |

## 2. Data classification & handling
| Class | Examples | Handling |
| --- | --- | --- |
| **Payment** | provider token, last-4 | Tokens only; **no PAN/CVV/expiry** stored or logged (#3); PCI scope kept at the provider |
| **PII** | customer name/phone/address, consent | Minimized, encrypted, access-controlled, consent-scoped, **erasable** (PRV) |
| **Financial** | ledgers, journals, reconciliation | Append-only; integrity; retention |
| **Audit** | who/what/when/where/before/after | Immutable; **never deleted** (#6); legal hold |
| **Operational** | product, stock, price | Branch-scoped; integrity |
| **Secrets** | keys, provider credentials | Vault; rotation; **never in code/config/images/logs** (#4) |

## 3. Threats we design against (STRIDE)
| Threat | Design response |
| --- | --- |
| **Spoofing** | OIDC auth, device identity, no shared/generic logins |
| **Tampering** | Append-only ledgers, signed config packs, integrity checks |
| **Repudiation** | Immutable audit (M34), traceable approvals (§28) |
| **Information disclosure** | Encryption in transit & at rest, PII minimization, tokenized payments, least privilege |
| **Denial of service** | **Offline-first keeps the store trading** (P-01); rate limits; edge autonomy |
| **Elevation of privilege** | Least-privilege RBAC; maker-checker; a privilege change is itself approved & audited; **AI cannot change privileges** (#5) |

## 4. Identity & access (SEC / §28)
- Individual, named users; **no shared or generic logins**, no default `admin`/`admin`
  (`shared-login.test.ts`).
- Least-privilege roles scoped to company/branch; **separation of duties** — the maker
  cannot approve their own material change.
- Support / remote access is **time-bound, least-privilege and fully audited** (M33).

## 5. Encryption & key management
- TLS in transit; encryption at rest for data **and backups** (encrypted / immutable /
  off-site — M35).
- Secrets in a managed vault with rotation; **signed** software and config updates (§35).

## 6. Privacy (PRV)
- **Consent** purpose/preference/withdrawal recorded and enforced; marketing respects
  consent **and** frequency caps (CRM/Service spec).
- **Data-subject rights** — access / correction / export / **erasure** — self-service
  (customer-app spec).
- PII **minimized on mobile/edge** (picking/delivery); data retention/archive/closure per
  policy.

## 7. AI-specific security (AI-NFR)
Prompt-injection resistance and evaluation; scoped tools; **budget caps**; evidence +
confidence; **kill switch**; **AI never commits a critical change and never writes the DB**
(#5, `ai-agent-db-write.test.ts`). Detailed on the AI-control surface.

## 8. Environment isolation (hard rule #7)
Dev/test **never** touch production data; migration trials run in non-production only;
production secrets are isolated from all lower environments.

## 9. Verification (QG-06)
- Guardrail tripwires run in CI: `card-data`, `secrets` (+ repo-wide scan),
  `shared-login`, `ai-agent-db-write`, `ledger-append-only`, `pos-offline`.
- **Zero open critical/high at go-live**; an **independent penetration test before customer
  launch** (QG-06).
- SEC-01…12 and PRV-01…10 traced during their build stages.
