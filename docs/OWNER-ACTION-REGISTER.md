# Owner Action Register

**Purpose.** One consolidated list of the decisions and actions only the owner can take — legal
authorizations, paid vendor selections, production credentials, and irreversible GO decisions. The
build does **not** stop waiting for these; each row names exactly what is blocked and what continues
without it. Recommended defaults are given so a decision is a yes/no, not an open question.

**Last updated:** 8 August 2026 (**OA-9 CLOSED** — the owner approved the standard **dual-interface
warehouse** design: an offline-first, scanner-first **Warehouse PWA** for execution and a **Web ERP**
supervisory/admin surface, both on the same authoritative warehouse/inventory services with no
duplicated business logic. Build backend integration first, then the two surfaces. See the OA-9 note
below. Earlier: added OA-9 as an open decision; created during the project-recovery kickoff after the
read-only audit and the Phase 1 RBAC repair).

## OA-9 decision (owner-approved, 8 August 2026) — dual-interface warehouse

The owner closed OA-9 with the standard dual-interface warehouse design (this settles the offline-pack
vs cloud-screen question in favour of BOTH, cleanly separated):

1. **Warehouse execution is a dedicated, offline-capable Warehouse PWA (mobile/scanner-first):** barcode/QR
   scanning; receiving & GRN; put-away suggest & confirm; bin-to-bin & warehouse transfers; replenishment;
   cycle counts & stocktake; damaged/expired/recalled/quarantined handling; exception capture & supervisor
   escalation.
2. **Web ERP provides supervisory/administrative functions:** warehouse/bin configuration; stock
   visibility; transfer planning; task assignment; approvals; exception queues; discrepancy investigation;
   reports/KPIs/audit history.

**Both surfaces use the SAME authoritative warehouse/inventory services and controls — no duplicated
business logic.** Cross-cutting requirements: English + Tamil; role-based access + tenant isolation;
offline queue + safe synchronization; large touch targets, minimal typing; scan confirmation with
visual/sound/vibration feedback where supported; prevention of wrong-bin / wrong-SKU / duplicate-scan /
unavailable-stock movements; FEFO/expiry/recall/quarantine enforcement; reason codes + approval for
adjustments; complete audit trail + idempotency; accessibility + responsive-design verification.

**Execution order (owner-directed):** finish the M09 **backend** first (FR-02 replenishment, FR-03
transfers, FR-04 counts — the authoritative services the two surfaces will share), then build the
**Warehouse PWA** and the **Web ERP** supervisory surfaces against those services. Proceed autonomously;
no further technical approval required.

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
| **OA-9** ✅ **CLOSED 8 Aug 2026** | **First on-screen (office) increment — where the new back-office screens live.** Dozens of back-office jobs are now built and tested on the cloud (customer credit, collections/ageing/dunning, salesperson commission, supplier statements, facilities & compliance, waste, integration health). **None yet has a screen.** The store's 16 existing screens are all *offline-first* — they keep working with no internet because they are fed from a data pack kept **inside the store**. The question is where the *new* office data belongs. | **Keep the in-store pack for what the shop floor needs to trade; put pure office data (a compliance report, a supplier statement, integration health) on a separate office screen that runs from the cloud.** Start with one office screen over a job already built (e.g. the supplier statement, or B2B collections). This is the smallest honest first screen and it respects *why* offline-first exists — the till must trade with no internet, and a compliance report is not a trading input. | **(a)** Improve an existing offline screen with a figure it is already fed — smallest of all, but it does not answer where office data goes. **(b)** Build cloud→store sync for one office dataset and show it on an existing offline screen — largest; it makes that data available with no internet, at the cost of a new sync path and a heavier in-store pack. | **Low.** The cloud jobs work now; the only thing waiting is which screen pattern to start with. Guessing risks building the first screen the wrong way and redoing it. | Before the first on-screen increment | The **first office screen** (which pattern, and whether office data enters the offline pack) | All remaining cloud wiring, engines and tests (this decision changes the *screen*, not the data or the rules underneath it) |

## Notes

- **These are the only things the build waits on.** Everything else proceeds autonomously per the
  execution plan (Phases 0–11).
- **OA-1** is a document-control gap, not a licence to invent content: no requirement will be added,
  removed, or altered on the basis of a v2.1 we have not seen. If v2.1 changes scope, those deltas
  become new tracked requirements once the file is provided.
- Owner decisions are recorded here and, when they change scope or release, also in
  `docs/registers/changes.md` per the roadmap's change-control rule.
