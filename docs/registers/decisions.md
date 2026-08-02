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
| D3 | Monthly post-go-live running-cost ceiling | **OWNER VALUE REQUIRED** | **Open — blocking** before hosting/vendor commitment |
| D4 | Second technical custodian | **NAME REQUIRED** | **Open — blocking** before production. Still blank in the roadmap — fill first. |
| D5 | Formal GO date | **DATE/SIGNATURE REQUIRED** | **Open — blocking** before coding |
| D6 | Initial online catalogue | 300–600 fast-moving products | Recorded; SKU list required |
| D7 | Migration history | Full usable history | Recorded; exceptions only by owner approval |
| D8 | Cutover targets | Store Core **1 April 2027** target; full-product completion date **OWNER VALUE REQUIRED** | Store Core scope & final date must be signed |

> The budget (D1) is a planning envelope, not permission to weaken scope,
> security, migration, testing, documentation or ownership (roadmap §25).

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
| Second technical custodian | Name required (= D4) |
| Store operations lead | Name required |
| Finance/CA reviewer | Name required |
| Security/architecture reviewer | Name required |
| Developer/implementation lead | Acknowledgement pending |
