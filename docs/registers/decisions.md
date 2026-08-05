# Decisions register

Every significant decision, its status and who owns it. IDs are stable.
`OD-##` = owner decisions (roadmap §14) · `D#` = decision fields (roadmap §25) ·
`AID-##` = AI-assisted development governance (roadmap §18).

Source: `docs/roadmap/roadmap-v2.0.docx`, now the single source of truth in the repo.

Status legend: **Accepted** · **Open — blocking** (holds coding / a gate) ·
**Open**.

## Owner decisions — OD-01 to OD-10 (roadmap §14)

| ID | Decision | Binding requirement | Status |
| --- | --- | --- | --- |
| OD-01 | Product | Build a completely new, independently owned SRE Retail OS. | Accepted |
| OD-02 | Scope | All approved modules, channels, controls and AI agents remain in final scope; nothing is silently removed. | Accepted |
| OD-03 | Hybrid | Store operations and POS continue safely without internet; cloud provides central truth, control and omnichannel services. | Accepted |
| OD-04 | POS | Build the new SRE standalone POS as an independent product. **This architecture decision is final.** | Accepted |
| OD-05 | Migration | All usable previous-system data is migrated, reconciled and evidenced. Exceptions require owner approval. | Accepted |
| OD-06 | Legacy | Any legacy adapter is temporary, preferably read-only, and retired after accepted cutover. | Accepted |
| OD-07 | Commerce | Customer Android/iOS app, web store, online payment, pickup and delivery are committed scope. | Accepted |
| OD-08 | AI | AI assists development and product operation; critical business actions remain governed and auditable. | Accepted |
| OD-09 | Ownership | SRE owns source code, repositories, databases, documentation, deployment assets, backups and credentials. | Accepted |
| OD-10 | Sequence | Phasing controls risk and adoption; it never reduces final scope. | Accepted |

## Decision fields — D1 to D8 (roadmap §25 / §39)

| ID | Decision | Owner value | Status |
| --- | --- | --- | --- |
| D1 | Indicative programme budget | ₹5–10 lakh | Recorded; commercial validation required |
| D2 | Owner review capacity | ≥ 30 hours/week | Recorded |
| OB-06 | Incumbent-vendor data export | **We migrate ourselves. Do not wait for the vendor** (owner, 7 Aug 2026): *"no one will be ready to, because they don't want to lose a customer."* Extraction is by direct database read, the system's own export, or its printed reports — our own data, our own machine, the access we already have. Their software is not touched. | EX-02 closed. The critical consequence is **verification**: with no vendor file, nothing can be checked against the incumbent except the incumbent, so every control total is proved against evidence from OUTSIDE it — bank, filed returns, supplier statements, physical count. Stronger than a vendor export, not weaker. `docs/runbooks/legacy-self-extraction.md` |
| D3 | Monthly post-go-live running-cost ceiling | **₹15,000 / month — PLATFORM RUNTIME ONLY** (owner, 4 Aug 2026, superseding the ₹20,000 of 2 Aug). Covers hosting, storage, backups, communication infrastructure, monitoring and normal AI usage. **External developer/support retainers are shown SEPARATELY and are never folded into this figure.** Every AI agent carries its own configurable monthly ceiling; customer-facing AI defaults to the smallest model that passes the approved evaluation; higher-cost models only for explicitly approved, low-volume complex tasks; customer-facing AI independently switchable; the system fails SAFE when a budget is exhausted; no unexpected overage permitted. | If the complete production platform cannot hold within ₹15,000/month, development does NOT stop — the forecast is recorded and ONE consolidated cost decision is presented at the hosting/procurement gate (owner, 4 Aug 2026) |
| D4 | Second technical custodian | **Mr Sivakumar** (owner, 2 Aug 2026) | Recorded. Must hold custody (OD-09) and demonstrate a quarterly rebuild/deploy (AID-10); onboarding + runbooks/training to be produced before production |
| D5 | Formal GO date | **2 August 2026** — owner GO given in session | Recorded; a signed GO record to be filed for the audit trail |
| D6 | Initial online catalogue | 300–600 fast-moving products | Recorded; SKU list required |
| D7 | Migration history | Full usable history | Recorded; exceptions only by owner approval |
| D8 | Cutover targets | Store Core **1 April 2027** (confirmed, 2 Aug 2026); full-product completion **phased release-by-release** — each later release's date set as it approaches | Recorded |

> The budget (D1) is a planning envelope, not permission to weaken scope,
> security, migration, testing, documentation or ownership (roadmap §25).

## Owner decisions made during the build (post-roadmap, dated)

| ID | Decision | Consequence | Status |
| --- | --- | --- | --- |
| OB-01 | **Commercial, multi-tenant product** (owner, 2 Aug 2026): SRE Retail OS is built to be **sold to other retailers**, not only for SRE's own use. **"Make everything choose-able"** — no store-specific value is hard-coded; all are per-tenant configuration. **SRE Hyper Market is the first tenant / pilot.** | Elevates the roadmap's tenant/white-label readiness (M33/D12/M36) to first-class from the start. `tenant` becomes the top isolation boundary; onboarding is configuration, not code. Full SaaS billing/white-label stays M36 (R8) unless prioritised sooner. See **ADR-0003**. | Accepted |
| OB-02 | **Infrastructure, live database, hosting and environment setup are deferred** (owner, 2 Aug 2026): "we will plan later". | Do **not** treat these as an active ask or a blocker on design/foundation work; keep building everything that does not require them. When the owner is ready, the DB-backed persistence layer + deployment proceed on the tenant-ready foundation (ADR-0002/0003). | Accepted |

| OB-03 | **Age-restricted sales: minimum age 18; no licence-hour restriction** (owner, 3 Aug 2026). | The tenant default `pos.age_restricted.minimum_age` is **18**, and `pos.licence_hours.enabled` is **false** for SRE. Both remain per-tenant settings (OB-01), so a tenant in a state with different rules changes a setting, not code. The till still **blocks** rather than warns on a flagged item (M12-FR-04). | Accepted |
| OB-04 | **Fresh/production departments: SRE operates a cafe** (owner, 3 Aug 2026) — closes **AVR-12** for tenant #1. | **SRE's own enablement** is `production.departments = ['cafe']`. See **OB-05** for what this means for the product: every department the roadmap names is **built**; each tenant **enables** only its own. Cold-chain (M10) and FSSAI obligations (M34-FR-03) are sized per tenant from that setting, so SRE's are sized to a cafe. | Accepted |
| OB-05 | **Product scope is never narrowed to SRE's own footprint** (owner, 3 Aug 2026): *"everything will be there, remember this software is not only for us, it's for multi tenant — so think for that."* | Corrects an over-narrow reading of roadmap §2.2. That rule governs **tenant enablement**, not **product scope**: the product **builds every capability**, and a tenant sees only what it switches on — so a shop with no meat counter never meets one, and a tenant with three counters is not told to wait for a release. Concretely: all M11 production departments (cafe, bakery, deli, meat/fish, central kitchen) are built, **including catch-weight costing and scale labels**, even though SRE runs none of the weighed ones. This applies to **every** module from here on — an SRE answer configures SRE, it never trims the build (reinforces OB-01, OD-02). | Accepted |

## AI-assisted development governance — AID-01 to AID-10 (roadmap §18)

| ID | Developer SHALL | Developer SHALL NOT |
| --- | --- | --- |
| AID-01 | Use SRE-owned repositories and named identities | Keep sole or private copies of code/configuration |
| AID-02 | Use protected branches, pull requests and independent review | Allow AI or a person to push directly to production branches |
| AID-03 | Run unit, integration, E2E, migration, security and regression gates | Treat generated code as correct because it compiles |
| AID-04 | Scan secrets, dependencies, licences, SAST, DAST and containers | Upload secrets or production personal data to coding models |
| AID-05 | Pin dependencies, record provenance and generate SBOM | Use unreviewed packages or copy proprietary source/designs |
| AID-06 | Separate development, test, staging and production | Develop or test directly against live production data |
| AID-07 | Review architecture, data model, auth, payments, sync and migrations manually | Rely on automated tests as the only assurance |
| AID-08 | Sign releases, stage rollout and prove rollback | Auto-deploy unapproved generated changes |
| AID-09 | Maintain ADRs, API/schema docs, runbooks and change log | Leave decisions only inside AI chats |
| AID-10 | Demonstrate quarterly rebuild/deploy by the second custodian | Make the original builder indispensable |

## Named approvals (roadmap §24 / §36)

| Role | Name / status |
| --- | --- |
| Business owner — final scope | Mr. Elanchezhian |
| Product owner | Name required |
| Second technical custodian | **Mr Sivakumar** (= D4, recorded 2 Aug 2026) |
| Store operations lead | Name required |
| Finance/CA reviewer | Name required |
| Security/architecture reviewer | Name required |
| Developer/implementation lead | Acknowledgement pending |
