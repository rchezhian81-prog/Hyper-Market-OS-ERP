# Owner Action Register

**Purpose.** One consolidated list of the decisions and actions only the owner can take — legal
authorizations, paid vendor selections, production credentials, and irreversible GO decisions. The
build does **not** stop waiting for these; each row names exactly what is blocked and what continues
without it. Recommended defaults are given so a decision is a yes/no, not an open question.

**Last updated:** 7 August 2026 (created during the project-recovery kickoff, after the read-only
audit and the Phase 1 RBAC repair).

| # | Decision required | Recommended default | Alternatives | Cost / risk if delayed | Required-by | Work BLOCKED until decided | Work that CONTINUES regardless |
|---|---|---|---|---|---|---|---|
| **OA-1** | **Provide the controlling roadmap file `v2.1` ("Final Audit-Closed Developer-Ready Baseline").** The repo currently holds only `roadmap-v2.0.docx`. | Upload the v2.1 `.docx` to `docs/roadmap/`; we record it as controlling and keep v2.0 as superseded. | Confirm in writing that v2.0 **is** the controlling baseline and v2.1 is a naming difference. | Low today — v2.0 and v2.1 are described as the same scope. Risk is auditing/building against a stale baseline if v2.1 added requirements. | Before the next release gate | Any requirement that v2.1 adds or changes beyond v2.0 | All Phase 1–3 assembly (v2.0 scope is unchanged and sufficient) |
| **OA-2** | **EX-02 — lawful export access to the incumbent ERP** (credentials or a signed data extract). | Request full read-only export + a signed extract from the current vendor now. | Owner-supervised on-site extraction; or vendor-provided backup. | High and time-sensitive: real migration cannot be verified until real data is seen; unknown data faults stay invisible until cutover. | Before any cutover / go-live | Real full-history migration; parallel run; final cutover | Migration tooling, reconciliation, trials against synthetic/anonymized fixtures (Phase 8) |
| **OA-3** | **AI model provider** selection + terms + API keys. | Defer until the governed runtime is ready for live evaluation; keep the simulator. | Pick a provider now for early evaluation. | Low — AI is advisory-only and off by design; no trading depends on it. | Before enabling live AI | Live-model AI evaluation and any real agent output | Full governed AI runtime against the simulator (Phase 9) |
| **OA-4** | **Payment tokenization provider** + **production identity provider (IdP)**. | Select an India-market payment provider and an OIDC/SAML IdP; provision `IDP_*` secrets. | Continue with the standards-compliant local/test IdP adapter for the pilot. | Medium — real tender and real login need these; the pilot can run in tender test-mode + test IdP. | Before production; test-IdP suffices for pilot | Real card/UPI settlement; production single-sign-on | POS pilot (test IdP + tender test-mode), all wiring behind ports/adapters (Phase 7) |
| **OA-5** | **Hosting region + production credentials + spend approval** (India-region deployment). | Approve an India-region managed host + budget; issue production secrets to a secrets manager. | Self-hosted on owner infrastructure. | Medium — no production deploy without it; DR/residency depend on region. | Before production | Production deployment, DR drills against production topology | Infra-as-code, staging, and all readiness proofs (Phase 10) |
| **OA-6** | **Genesis owner identity per tenant** — the userId (from the IdP) who becomes each store's first owner/administrator. | Provide the owner's IdP subject id; we seed it once via `BOOTSTRAP_OWNER_*` config. | Provision the initial admin set through an operator runbook. | Low but blocking for that tenant: authorization is now real and fail-closed, so an unprovisioned tenant can do nothing (by design). | Before that tenant's first use | First login/authority for a specific tenant | The RBAC mechanism itself (shipped and tested); other tenants |
| **OA-7** | **Trading-day cut-off time (A-13)** and other open AVR/owner decisions in the roadmap control table. | Confirm the store's cut-off (e.g. `00:00` default or a small-hours value). | Leave default `00:00` for the pilot. | Low — default is safe; wrong cut-off dates late-night sales to the wrong business day. | Before finance go-live | Correct trading-day dating in finance/reports | Everything else (default applies meanwhile) |
| **OA-8** | **Final pilot GO** and, separately, **production GO**. | Give pilot GO once the Phase 11 pilot conditions are green; production GO later against the full checklist. | — | — | At each gate | Pilot start; production start | All build work up to each gate |

## Notes

- **These are the only things the build waits on.** Everything else proceeds autonomously per the
  execution plan (Phases 0–11).
- **OA-1** is a document-control gap, not a licence to invent content: no requirement will be added,
  removed, or altered on the basis of a v2.1 we have not seen. If v2.1 changes scope, those deltas
  become new tracked requirements once the file is provided.
- Owner decisions are recorded here and, when they change scope or release, also in
  `docs/registers/changes.md` per the roadmap's change-control rule.
