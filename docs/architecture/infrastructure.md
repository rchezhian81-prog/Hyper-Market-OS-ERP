# SRE Retail OS — Infrastructure & deployment design (Stage 4→5)

- **Roadmap:** §19 (baseline), §20 (delivery/CI-CD), §31 (offline/edge), §35 (security), NFR. **Decisions:** D3 (**₹15,000/month** platform runtime ceiling — owner, 4 Aug 2026, superseding the ₹20,000 of 2 Aug), OD-09 (SRE owns everything), AID-02/06/08 (branches / env separation / signed releases). **ADR:** `../adr/0002-hosting-and-deployment.md`.
- **Purpose:** How the system is hosted, deployed and operated — sized to the **₹15,000/month platform runtime ceiling (D3)** — while the store keeps trading offline (P-01) and the whole stack stays portable and owned (P-06, OD-09).

> Design only. The infrastructure-as-code that implements this lands in `../../infra/` from
> Stage 5. The **specific cloud vendor is a Proposed recommendation** pending owner
> commercial validation against real quotes (ADR-0002; D3 note in the decision register).

## 1. Two tiers: store edge (on-prem) + cloud (central)
- **Store edge — on-prem hardware in the store (capex, NOT part of the ₹15k/month runtime
  ceiling):** a small fanless mini-server on a UPS, running the containerised edge stack +
  local PostgreSQL. This keeps the till trading with the internet cut (P-01, hard rule #1).
  Spec confirmed against the store's hardware inventory (`⟳ AVR-06`).
- **Cloud — the central services, data, broker, AI gateway and admin/web app (the
  ₹15k/month tier).** Hosted in an **India region** for data residency (DPDP Act 2023) and
  GST/tax-evidence locality (`⟳ AVR-14 / AVR-20` confirm region & support model).

## 2. Monthly cost model (to D3 = ₹15,000/month)

**This section was re-based on 7 August 2026.** It was sized to the superseded ₹20,000, and its
upper bound was ₹20,000 — which **breaches the current ceiling outright**. That is a real
finding, not a rounding issue: the managed-service shape this design assumed does not fit
₹15,000/month at its upper bound, and pretending otherwise would surface at the first invoice.

The full consolidated forecast — every component, both shapes, against the ceiling, with the
external retainers shown separately as the owner required — is
**`../registers/cost-forecast.md`**. It is the single document to read at the procurement gate.
Summary of what it concludes:

| Shape | Indicative /month | Fits ₹15,000? |
| --- | --- | --- |
| **A — all-managed** (managed Postgres + managed Redis + container platform) | ₹14,000–20,500 | **Only at the bottom of the range.** Breaches at the top |
| **B — single VM, self-managed** (one India-region VM running Postgres, Redis and the containers; managed object storage and backups) | ₹6,300–9,200 | **Yes, with headroom** |

Shape B is the recommendation, and the trade is stated plainly rather than buried: it moves
database patching, failover and restore rehearsal onto us (D4, the second custodian) instead of
the provider. `../adr/0002-hosting-and-deployment.md` carries the decision.

The **store edge hardware** (capex), the **customer-app store/push** fees and any **external
developer or support retainer** are separate from this ceiling and are never folded into it
(owner, 4 Aug 2026). Validate against **real vendor quotes** before any commitment (D3).

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
