# Demo-pilot host — managed VPS purchase specification (for approval)

_Non-production, synthetic-data demo. Owner direction (26 Sep 2026): prefer a **separate India-region
managed VPS**; MilesWeb **VM4** (4 vCPU / 8 GB / 160 GB NVMe) is the candidate, subject to confirming
suitability and the **final** cost. **Nothing is purchased.** This is the exact specification to approve.
Existing production servers stay separate._

**Important:** the demo environment's network policy **blocks outbound access to the provider's website**,
so every value marked **[CONFIRM]** must be read off your MilesWeb dashboard / a support reply before
purchase. The advertised monthly rate is **not assumed** to be the actual billing option (§ Billing).

## Concluded recommendation

**Spec:** proceed with **MilesWeb Managed VPS VM4 — 4 vCPU / 8 GB RAM / 160 GB NVMe, Ubuntu LTS 24.04,
India datacentre**, HTTPS in front, plus a **separate encrypted off-site backup** bucket. VM4 runs the demo
with generous headroom (§A) **and** matches the eventual real-pilot sizing (`cost-forecast.md` Shape B,
4 vCPU / 8–16 GB) — so the same box can carry the real pilot later with no migration. (If this were strictly
a short throwaway demo and cost were the only priority, the one-tier-smaller **2 vCPU / 8 GB / 100 GB**
managed plan would also suffice — the email asks for both prices so the choice is on real numbers.)

**Vendor:** **MilesWeb is a sound, economical choice for this** — it is India-region (DPDP data residency),
**managed** (owner-preferred: they patch the OS), Docker-capable, billed in **INR with a GST invoice**, and
it is an **existing relationship** (one vendor, one bill, familiar support). The realistic ways to go
"cheaper" trade money for operational burden: a **self-managed** VPS (Hostinger India, or DigitalOcean
Bangalore) is cheaper per-spec but puts OS patching, monitoring and recovery back on us (the exact burden the
cost model flagged) — not worth it for a managed demo. A genuine India managed-cloud alternative to
**benchmark** against is **E2E Networks** (Indian, INR), but there is no existing relationship and less
hand-holding. Providers **without an India datacentre (e.g. Contabo) are ruled out** by data residency.
**Net: proceed with MilesWeb VM4-managed; use the quoted price to sanity-check, and only switch if the quote
is materially worse than a benchmark.**

## A. Suitability — VM4 validated against measured application usage

Measured footprint of the four-service stack (from `docker-compose.pilot.yml` limits + the rehearsal):

| Resource | Stack needs (measured ceilings) | VM4 offers | Headroom |
|---|---|---|---|
| RAM | ~2.4 GB (db 1 GB + api 768 MB + edge 512 MB + web 128 MB), steady-state well under | **8 GB** | ~3× — room for OS, Docker, burst, monitoring |
| vCPU | ~3 bursty (db 1 + api 1 + edge 0.5 + web 0.5), demo load is a few sessions | **4 vCPU** | covers burst + headroom for concurrent-till demo |
| Disk | ~40 GB (OS ~10 + images/build ~5 + edge 10 + DB + backup staging) | **160 GB NVMe** | ~4× — ample for logs, snapshots, backup staging |

**Verdict: VM4 is suitable, with comfortable headroom** for the synthetic-data demo, concurrent-till tests,
monitoring and local backup staging. (It is larger than the demo strictly needs — which is fine for a
managed plan and leaves room to also exercise near-production load during UAT.)

## B. Exact purchase specification

| Item | Specification |
|---|---|
| Provider | **MilesWeb** (existing relationship) |
| Product | **Managed VPS — VM4** (owner-preferred: provider handles OS/patching) |
| Compute | **4 vCPU / 8 GB RAM / 160 GB NVMe** · bandwidth **[CONFIRM]** (VM4 listing) · 1 Gbps |
| Region / datacentre | **India** — **[CONFIRM]** exact DC (Mumbai / Pune); data residency (DPDP Act 2023) |
| Managed? | **Yes** (managed) — see the responsibility matrix (§D) |
| Operating system | **Ubuntu LTS (22.04 or 24.04)** — **[CONFIRM]** VM4-managed supports it; our runtime is in **containers** (Node 22 inside Docker), not on the host |
| Dedicated IP + TLS | dedicated IP; **HTTPS/TLS** terminated in front (reverse proxy / nginx TLS); plain HTTP refused |

## C. Billing (do NOT assume the advertised monthly rate)

| Field | Value |
|---|---|
| Billing period(s) available | **[CONFIRM]** — is a true **monthly** option offered for VM4-managed, or only quarterly / annual? |
| Advertised rate | **[CONFIRM]** the current VM4-managed rate (promo vs renewal differ) |
| **Upfront total** at purchase | **[CONFIRM]** (period × rate; annual terms are usually discounted but paid upfront) |
| Taxes | **+18% GST** (India); GST invoice available (for input credit) |
| Renewal price | **[CONFIRM]** — the renewal rate, which is typically higher than the promo/first-term |
| Management fee / extras | **[CONFIRM]** — is management included in VM4-managed, or a separate line? (§E) |

**Fit note:** the ₹15,000/month D3 platform ceiling (`cost-forecast.md`) is a reference, **not** an approved
budget. Approve against the **actual** confirmed VM4-managed total incl. GST and any management extra.

## D. Responsibility matrix (managed VPS)

| Area | Provider (managed) | Us (application) |
|---|---|---|
| OS updates / kernel patching | **Provider** — **[CONFIRM]** cadence + reboot policy | — |
| Base firewall / network | **Provider** base + **[CONFIRM]** | We restrict to 443 (+ SSH key-only); DB bound to localhost |
| Infra monitoring (host up/CPU/disk) | **Provider** — **[CONFIRM]** what + alerting | We run app health (`/livez` `/readyz`, `standup:check`) + trading-integrity watch-list; wire the alert channel to the named incident owner |
| Backups | **Provider** VM snapshot — **[CONFIRM]** frequency/retention | We run **application** `db:backup` → **encrypted off-site** (§ below) + tested restore |
| Recovery (VM/infra) | **Provider** — **[CONFIRM]** RTO/RPO | We rehearse app restore-into-clean-DB + deployment rollback |
| Application incidents | — | **Us** — named incident owner (G10); provider ticket for infra only |

## E. Encrypted off-site backup

| Field | Value |
|---|---|
| What | `db:backup` artefacts (custom-format dump + checksummed manifest) + edge/object data |
| Destination | **Separate** India-region S3-compatible object storage — **never on the VM** (M35, SEC-08). Candidate: MilesWeb object storage **[CONFIRM available]**, or an independent S3-compatible bucket |
| Encryption | at rest (storage-layer) + in transit (TLS); `BACKUP_ENCRYPTED` posture |
| Retention | per `docs/registers` retention schedule — **[CONFIRM]** demo retention (e.g. 7–30 days rolling for a demo) |
| Indicative cost | ~₹100–300 / month **[CONFIRM live]** |

## F. Compulsory licences / management extras — **[CONFIRM]**

- Control-panel licence (cPanel/Plesk): **not required** for a Docker/CLI VPS — confirm it is **not** force-bundled/charged.
- Any **mandatory** management add-on, backup add-on, or monitoring add-on and its price.
- OS licence: none for Ubuntu LTS (free).

## G. What is NOT in scope of this purchase

Real product/price data (**Option 2, unapproved**), any live provider (payment/GST/Tally/messaging/payroll),
and any change to the existing **production servers** (which stay separate). The demo runs synthetic data
only, with the DEMO/PILOT banner on and live integrations off.

## H. The one message to send the provider / check on the account

See the consolidated question list in the report accompanying this file (also reproduced here):

1. For **Managed VPS VM4 (4 vCPU / 8 GB / 160 GB NVMe)**, what is the **current price**, and is a **monthly**
   billing option available or only quarterly/annual? What is the **upfront total** for the shortest term,
   and the **renewal** rate? Is **18% GST** added, with a GST invoice?
2. Which **India datacentre(s)** is VM4 available in, and what **bandwidth** does it include?
3. Is **Ubuntu LTS (22.04/24.04)** supported, and is **Docker / container runtime** permitted on VM4-managed?
4. On the **managed** plan, exactly what do you manage — **OS patching (cadence + reboots), firewall,
   monitoring + alerting, backups (frequency + retention), and recovery (RTO/RPO)** — and what stays with us?
5. Do you offer **encrypted off-site object storage** in India (S3-compatible) for our own backups — price
   and retention options? If not, we will use an independent bucket.
6. Are there any **compulsory licences or management extras** (control panel, backup/monitoring add-ons)
   and their cost, or is everything included in the VM4-managed price?

**Decision requested:** approve purchasing **VM4-managed** once the **[CONFIRM]** values above are filled in
and the final total (incl. GST + any extras) is acceptable. Then, under the existing Option 1 authorization,
I deploy synthetic data, verify HTTPS + authentication, run the host-specific restart/restore/rollback
tests, and hand over the demo URL + staff UAT walkthrough — reported **separately** from the temporary-machine
results already completed.

## I. Copyable email to MilesWeb

> **Subject:** Managed VPS VM4 — pre-purchase questions (India, Docker, managed scope)
>
> Hello MilesWeb team,
>
> I'm setting up a separate, non-production server for an internal project and am looking at the
> **Managed VPS VM4 (4 vCPU / 8 GB RAM / 160 GB NVMe)**. Before I order, could you confirm the following:
>
> 1. **Price & billing** — the current price of **VM4 (managed)**; is a **monthly** billing option available
>    or only quarterly/annual? Please give the **upfront total** for the shortest available term and the
>    **renewal** price. Is **18% GST** added, and will I get a **GST invoice**? For comparison, please also
>    quote the next-smaller managed plan (**2 vCPU / 8 GB / 100 GB**).
> 2. **Datacentre & bandwidth** — which **India** datacentre(s) is VM4 available in, and how much
>    **bandwidth** is included?
> 3. **OS & Docker** — is **Ubuntu LTS (22.04 / 24.04)** supported, and is **Docker / container runtime**
>    allowed on the managed VM4?
> 4. **Managed scope** — on the managed plan, exactly what do you handle: **OS patching (cadence + reboot
>    policy), firewall, monitoring + alerting, backups (frequency + retention), and recovery (RTO/RPO)** —
>    and what remains my responsibility?
> 5. **Off-site backups** — do you offer **encrypted, S3-compatible object storage in India** for my own
>    backups? Please share pricing and retention options. (If not, I'll use a separate bucket.)
> 6. **Compulsory extras** — are there any **mandatory licences or add-ons** (control panel, backup or
>    monitoring add-ons) with a separate charge, or is everything included in the managed VM4 price?
>
> Thank you — once I have these I can place the order.
>
> Best regards,
> [your name]
