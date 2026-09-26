# Demo-pilot deployment plan (Option 1, hosted)

_Non-production. Synthetic data only. This is the concrete deployment package the owner asked for before
any hosting purchase. It confirms the target, sizes the host from measured demo usage, prices it, and
lists the exact deployment steps. **Nothing here has been purchased or provisioned.**_

Status recorded accurately: **Demo verification completed in a temporary environment; persistent hosted
demo, host-specific recovery evidence and human UAT pending.**

---

## 1. Deployment-target confirmation

I inspected the approved infrastructure and the repository configuration:

- **No approved, safely-isolated, non-production host is available without new expenditure.** The
  environment the synthetic-data rehearsal ran in is an **ephemeral build container** — no container
  runtime, not persistent — a verification harness, not a host (`DEMO-PILOT-VERIFICATION.md` §1).
- There is an **existing MilesWeb relationship**, but per the owner's instruction I do **not** assume its
  production servers have spare capacity or are approved for this application. A demo pilot must be a
  **separate, isolated** server — not a shared production box.
- The repository is deploy-ready as a four-container stack (`infra/compose/docker-compose.yml` +
  `docker-compose.pilot.yml`), which needs a host with a Docker/container runtime.

Therefore a host must be procured. Below is **one recommended plan and one alternative**, both sized from
measured demo usage, both India-region (DPDP Act 2023 data residency, ADR-0003).

## 2. Sizing justification (from measured demo usage)

Measured footprint of the stack (from `docker-compose.pilot.yml` resource limits and the rehearsal):

| Service | Memory limit | CPU | Notes |
|---|---|---|---|
| `db` (PostgreSQL 16) | 1.0 GB | 1.0 | demo dataset is tiny (8 tables, synthetic rows) |
| `api` (cloud) | 768 MB | 1.0 | |
| `edge` (store) | 512 MB | 0.5 | `EDGE_CAPACITY_BYTES` default 10 GB disk |
| `web` (PWA shell) | 128 MB | 0.5 | static + light |
| **Stack total (ceilings)** | **~2.4 GB** | **~3.0 (bursty)** | steady-state demo load is well under the ceilings |

Disk: OS (~10 GB) + Docker images/build (~5 GB) + edge capacity (10 GB) + DB + backups staging → **~40 GB
comfortable, 100 GB generous.** Concurrent-till demo load is a handful of sessions, not production volume.

**Conclusion:** a **2 vCPU / 8 GB RAM / ~100 GB NVMe** VPS covers the whole demo stack with headroom (RAM
ceilings sum to ~2.4 GB; 8 GB leaves room for OS, Docker and burst). This is a demo-sized host, deliberately
smaller than the eventual production pilot sizing in `../registers/cost-forecast.md` (Shape B, 4 vCPU/8–16 GB).

## 3. Recommended plan

| Field | Value |
|---|---|
| Provider | **MilesWeb** (existing relationship; INR billing + GST invoice; UPI/NetBanking/card) |
| Product | **Linux VPS — unmanaged, full root** (we run the containers; keeps us portable, P-06/OD-09) |
| Plan size | **2 vCPU / 8 GB RAM / 100 GB NVMe SSD / ~8 TB bandwidth / 1 Gbps** |
| Region | **India** (Mumbai / Pune Tier-4 DC) — data residency |
| OS | Ubuntu LTS (Docker + compose) |
| Managed? | Unmanaged — we own patching/restore (D4, the 2nd custodian; consistent with cost-forecast Shape B) |
| Indicative price | **~₹949–1,149 / month** at renewal (promo entry lower); **+18% GST** → ~₹1,120–1,357/mo incl tax |
| First payment | one month or one term up front (term discounts common) — **confirm live on the MilesWeb dashboard** |
| Backups / off-site | encrypted `db:backup` artifacts pushed to **separate off-site object storage** (S3-compatible bucket in an India region), **never on the same VM** (M35, SEC-08). Indicative object-storage ~₹100–300/mo |

## 4. Alternative plan

| Field | Value |
|---|---|
| Provider | **MilesWeb** |
| Product | **Managed Linux VPS** (provider patches the OS/stack) |
| Plan size | 2 vCPU / 8 GB / 100 GB NVMe (same), **managed** |
| Indicative price | higher than unmanaged (management premium) — **confirm live**; +18% GST |
| Trade | lower ops burden (provider patches) vs. higher monthly cost and slightly less portability |

A second alternative, if the owner prefers the eventual-pilot shape now, is the all-managed cloud path
(`cost-forecast.md` Shape A) — more expensive, breaches the ₹15k ceiling at its upper bound, not recommended
for a demo.

## 5. Pricing verification note (important, honest)

**The figures above are indicative, from public search results (Sept 2026); they are NOT verified live.**
The demo environment's network policy **blocks outbound access to the provider's website**, so I could not
open the MilesWeb pricing page to confirm the exact current plan/price. Before any purchase, the exact plan,
term, promo, renewal price and GST must be **confirmed on the MilesWeb dashboard/quote**. Per the owner's
instruction, the indicative range here and the ₹15,000 D3 figure are **not** an approved budget.

## 6. Access requirements

To deploy, I (or the developer/2nd custodian) will need, from the owner:
- Purchase approval for the chosen plan (the one decision requested — §9).
- SSH access to the new VPS (key-based; no password login), and DNS for a demo hostname to point at it.
- An object-storage bucket + credentials for off-site encrypted backups (kept out of the repo).
- Confirmation to use the **local/test IdP** for the demo (production IdP stays deferred, OA-4).

## 7. Deployment steps (runbook, executed once the host exists)

1. Provision the VPS (Ubuntu LTS, India region); harden SSH (key-only), enable the firewall (expose 443 only).
2. Install Docker + compose; clone the repo at tag `pilot-rc-1` (runtime = RC).
3. `cp infra/compose/.env.pilot.example .env.pilot`; generate fresh secrets (`openssl rand`) — never commit.
4. Terminate **HTTPS/TLS in front** (reverse proxy / nginx TLS block); bind DB to localhost only.
5. `docker compose -p sre-pilot -f docker-compose.yml -f docker-compose.pilot.yml --env-file .env.pilot up -d`.
6. Run migrations on the fresh pilot DB (`db:migrate`); confirm `standup:check` → GREEN.
7. Seed the demo dataset (`db/seed/pilot/`) against the running API + test IdP.
8. Turn on the **DEMO / PILOT — NOT PRODUCTION** banner (`PILOT_DEMO_BANNER=1`).
9. Run the host-specific verification checklist (`DEMO-PILOT-VERIFICATION.md` §6 items marked ⛔-live):
   authenticated browser workflows, RBAC/isolation, restart+persistence, offline/reconnect, concurrent
   tills, monitoring + **test-alert delivery**, encrypted backup + restore into a separate clean DB,
   deployment rollback with DB-compat checks.
10. Hand over the demo URL + secure access instructions + the role-based staff walkthrough (human UAT).

## 8. What stays OFF on the hosted demo

Live payment, GST/e-invoice, Tally, payroll/bank-file, production messaging, production/autonomous AI,
production "delete my data", irreversible migration, and **all real data** (Option 2 is unapproved). Only
simulators/sandbox adapters and the synthetic demo dataset.

## 9. The one decision requested

**Approve procurement of the recommended plan (§3), after confirming the exact live price on the MilesWeb
dashboard.** That is the single blocker. Everything else in the deployment package (the GAP-SEC-06 fix, the
demo banner, the seed, the verification checklist, the human-UAT walkthrough) is prepared and does not need
a purchase. I will not buy anything or take access without this approval, and I will not import real data or
begin store operation.
