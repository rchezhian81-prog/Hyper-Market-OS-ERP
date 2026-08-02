# SRE Retail OS — Infrastructure & deployment design (Stage 4→5)

- **Roadmap:** §19 (baseline), §20 (delivery/CI-CD), §31 (offline/edge), §35 (security), NFR. **Decisions:** D3 (**₹20,000/month** cloud ceiling), OD-09 (SRE owns everything), AID-02/06/08 (branches / env separation / signed releases). **ADR:** `../adr/0002-hosting-and-deployment.md`.
- **Purpose:** How the system is hosted, deployed and operated — sized to the **₹20,000/month cloud running-cost ceiling (D3)** — while the store keeps trading offline (P-01) and the whole stack stays portable and owned (P-06, OD-09).

> Design only. The infrastructure-as-code that implements this lands in `../../infra/` from
> Stage 5. The **specific cloud vendor is a Proposed recommendation** pending owner
> commercial validation against real quotes (ADR-0002; D3 note in the decision register).

## 1. Two tiers: store edge (on-prem) + cloud (central)
- **Store edge — on-prem hardware in the store (capex, NOT part of the ₹20k/month cloud
  ceiling):** a small fanless mini-server on a UPS, running the containerised edge stack +
  local PostgreSQL. This keeps the till trading with the internet cut (P-01, hard rule #1).
  Spec confirmed against the store's hardware inventory (`⟳ AVR-06`).
- **Cloud — the central services, data, broker, AI gateway and admin/web app (the
  ₹20k/month tier).** Hosted in an **India region** for data residency (DPDP Act 2023) and
  GST/tax-evidence locality (`⟳ AVR-14 / AVR-20` confirm region & support model).

## 2. Monthly cloud cost model (to D3 = ₹20,000/month)
Single-store scale (one store; 300–600 online SKUs at launch, D6). **Indicative envelope,
not a quote:**

| Component | Indicative /month | Note |
| --- | --- | --- |
| Managed PostgreSQL (small, backups) | ₹6,000–8,000 | primary system of record |
| Container compute (domain services + web/admin) | ₹4,000–6,000 | small; scales with load |
| Redis (cache / queue support) | ₹1,500–2,000 | small managed or co-hosted |
| Object storage + off-site backups | ₹1,000–2,000 | documents, backups (M35) |
| Network / DNS / TLS / monitoring | ₹1,000–2,000 | |
| **Subtotal** | **~₹14,000–20,000** | headroom retained |
| AI model-gateway usage | metered, **capped** | separate; Store-Core (R2) AI is light (owner narrative A01); budget caps (AI-NFR); revisit at R7 |

The **store edge hardware** and the **customer-app store/push** costs are separate from this
cloud ceiling. Validate against **real vendor quotes** before any commitment (D3).

## 3. Environments (AID-06 / hard rule #7)
Four separated environments — **dev · test · staging · production**. Production data is
**never** touched from dev/test (hard rule #7); non-prod is smaller/ephemeral to fit budget;
secrets isolated per environment in a vault (hard rule #4).

## 4. Delivery pipeline (§20 / AID-02/03/08)
- **Source:** GitHub, protected branches, PRs, independent review (AID-02; **never push to
  main** — hard rule #8).
- **CI (GitHub Actions, already set up):** typecheck, lint, unit/integration/e2e/contract/
  migration/security tests, secret scan, guardrails, SBOM (AID-03/04/05) — all green before merge.
- **CD:** build immutable containers → IaC provisions/updates infra → deploy to staging →
  **approved, signed** release to production with staged rollout and **proven rollback**
  (AID-08). No auto-deploy of unapproved changes.

## 5. Portability & ownership (P-06 / OD-09)
- Everything containerised; infra defined as **code** (IaC) in `infra/`; managed
  Postgres/Redis are standard, portable engines (no proprietary data lock-in).
- SRE owns repos, databases, IaC, backups and credentials (OD-09); the **second custodian
  (D4, Mr Sivakumar)** holds custody and demonstrates a **quarterly rebuild/deploy**
  (AID-10) — the pipeline + IaC + runbooks make that a repeatable exercise, not tribal
  knowledge.

## 6. Store-edge deployment
- The edge stack ships as containers with a local Postgres; provisioned by IaC/scripts onto
  the store's mini-server; auto-starts; syncs to cloud via the sync agent (`offline-sync.md`).
- Health, sync-lag and version are reported to the platform (M35); an edge **keeps trading
  if the cloud/admin plane is unreachable** (P-01).

## 7. Security & compliance (§35)
TLS everywhere; encryption at rest for data + backups; secrets in a vault; signed
config/software updates; **India data residency** for PII/financial data (DPDP/GST). Full
model in `../security/threat-privacy-model.md`.

## 8. Backup & DR (M35 / NFR)
Encrypted, immutable, off-site backups with **tested restores**; RPO/RTO targets;
store↔cloud recovery runbooks. The quarterly rebuild (AID-10) doubles as a DR rehearsal.

## 9. What lands in `infra/` (Stage 5)
IaC modules (network, database, compute, storage, secrets), environment definitions
(dev/test/staging/prod), CI/CD workflow extensions, and edge-provisioning scripts —
implemented from Stage 5, reviewed manually (AID-07).

## 10. Open items
`⟳ AVR-06` (store hardware for the edge spec), `⟳ AVR-14 / AVR-20` (hosting/region
preference, support operating model). **Owner:** commercial validation of D3 against real
vendor quotes; choice of the specific cloud vendor (ADR-0002, pending).
