# Lane C — store PC install, memory sizing, physical set-up and people (OB-247)

Auditor: lane C, read-only. Repo state: branch `claude/new-session-lw91i4` at `6bd9028e`, working tree clean before and after.
Database used: `sre_audit_c` (from template `sre_core3`), **dropped at the end**. Synthetic data only. Nothing in the repo
was edited; every lab file lives in the build session's lab files (not kept in the repo).

---

## 0. The memory measurement (OB-247 "measure it")

### What the store PC would run

| Piece | Where it runs | Started by | Memory limit in the file used |
|---|---|---|---|
| `db` (postgres:16-alpine) | Docker, inside the WSL 2 VM | `store-computer up` (`docker compose -p sre-real -f docker-compose.yml --env-file .env.real up -d db migrate api`) | **none** (`mem_limit` only in `docker-compose.pilot.yml`: db 1g — the owner is told not to use that overlay) |
| `migrate` (one-shot, exits) | Docker | same | none |
| `api` (all 13 services, one Node process) | Docker | same | **none** (overlay: 768m) |
| store edge = **the till's own box** (lane socket 127.0.0.1:8090, screens 127.0.0.1:8091) | **plain Node on Windows**, in a console window (`till\start-till.cmd`) — not in Docker, because the till page must reach it on loopback (ADR-0004, `in-store-install.md`) | `till:install` + double-click — **not in the owner's Windows guide** | none |
| Browser: the till page + an office page | Windows (Edge/Chrome) | by hand | — |
| Image builds (pnpm install + esbuild) | Docker, inside the VM | `up` (first time), `drill --run` (twice) | — |
| Not started on the store PC: `edge` container, `web`, `proxy` (Caddy), `idp` (Keycloak) and `sign-in` (profile `identity`) | — | — | only `sign-in` has `mem_limit: 96m` |
| Overheads | Windows 11; Docker Desktop host processes; the WSL 2 VM (kernel, dockerd, containerd, page cache) | — | WSL default cap = 50% of RAM (≈3.9 GB on 8 GB), swap 25% |

### How it was measured (commands)

1. `CREATE DATABASE sre_audit_c TEMPLATE sre_core3` on 127.0.0.1:5432 (PostgreSQL 16, `shared_buffers` 128 MB = the docker image default).
2. `node the build session's lab folderbuild.mjs` — esbuild-bundles the **real production entry points** `services/api/src/start.ts`
   and `edge/store-edge/src/start.ts` with the same options as `scripts/build-service.mjs`, into the build-session lab.
3. `node out/prep.js` — migrations, the non-superuser role `sre_app_connected`, two initial admins (as `tests/support/real-store.ts`).
4. `node out/driver.js` — starts the API and the edge as **two separate Node processes** (API on PostgreSQL as the app role;
   edge with `EDGE_STORE_PACK_SOURCE=head-office`, a store-computer token), sets a store up through the API (two-person
   grants, N products with price and barcode, a signed catalogue pack), opens the **served till page** plus the owner and
   manager pages in headless Chromium, signs a cashier in with a till PIN, rings sales through `posSession.scanBarcode` +
   `tenderCash`, and lets the edge drain to head office. Every second it reads `VmRSS` (`/proc/<pid>/status`) and `Pss`
   (`/proc/<pid>/smaps_rollup`) of the API, the edge, the PostgreSQL postmaster + this database's backends + auxiliaries,
   and the whole Chromium tree.
   - Run A: 200 products, **400 sales** (1–6 lines each). Run B: 1,000 products, **3,000 sales**.
5. PostgreSQL private memory: `Private_Clean+Private_Dirty` from `smaps_rollup` for the same pids.
6. Peak RSS of the API bundle build (esbuild) sampled every 0.1 s.
7. `npx vitest run` on the six store-computer/installer test files (below): **106 passed**.
8. `DROP DATABASE sre_audit_c`; temporary edge folders removed.

Machine: Linux x86-64, 4 vCPU, 16 GB, Node v22.22.2. **Not Windows, not Docker** — so the numbers below are the
application's own needs; the Windows and Docker overheads are added from documentation and marked as such.

### Results (measured)

| Process | Run A (400 sales) peak | Run B (3,000 sales) peak | Idle after |
|---|---|---|---|
| API (Node) RSS | 154 MB | **254 MB** (while receiving the backlog) | 167 MB |
| Store edge (Node) RSS | 96 MB | **136 MB** (92 MB at start → 104 MB at 2,000 sales → 130 MB) | 112 MB |
| PostgreSQL PSS (postmaster + this DB's backends + aux) | 188 MB | 188 MB (RSS sum 380–620 MB counts shared buffers many times) | 174 MB |
| PostgreSQL private memory only | 38 MB (+ shared memory ≈ 128–150 MB) | — | — |
| Chromium, 3 tabs (till, owner, manager), headless — PSS / RSS | 426 MB / 1.09 GB | 573 MB / 1.25 GB | 430 MB / 1.11 GB |
| **Store system (API + edge + PG)** | **433 MB** | **550 MB** | — |
| Store system + browser (PSS) | 825 MB | 1,027 MB | — |
| esbuild bundle of the API (part of every image build) | 293 MB peak | | |

Other facts from the runs: every sale committed (0 failed); one whole sale through the served page (scans + receipt
number + cash tender) p50 **13 ms**, p95 **22 ms** on this machine; the edge drains ~100 sales per 15–18 s pass
(≈ 5–6 sales/s; a 3,000-sale backlog needs ~9 min); database 80 MB after run A, 104 MB after run B.

### The 8 GB budget (measured + documented)

| Item | Steady trading | During an image build (`up` first time, each `drill --run`) | Source |
|---|---|---|---|
| Windows 11 Pro + Defender + services | 3.0–3.5 GB | 3.0–3.5 GB | documented typical (brief: ~3–4 GB) |
| Docker Desktop host processes (UI, backend) | 0.3–0.5 GB | 0.3–0.5 GB | documented / typical |
| WSL 2 VM: kernel + dockerd + containerd | 0.4–0.6 GB | | documented / typical |
| …PostgreSQL + API containers | **0.45 GB** (measured) | | measured |
| …VM page cache (grows after builds, given back slowly) | 0.5 GB+ | **up to the cap: ≈3.9 GB** by default | WSL default cap 50% |
| Store edge (Node on Windows) | **0.14 GB** (measured) | 0.14 GB | measured |
| Browser with till + one office tab (headful Edge/Chrome) | 0.6–1.0 GB (measured headless 0.43–0.57 GB PSS) | same | measured + allowance |
| Old ERP client, if it runs on this PC | unknown (0.3–1 GB) | | **ask the owner** |
| **Total** | **≈ 5.9–6.3 GB** without the old ERP | **≈ 8.3–8.9 GB** → paging | usable RAM on an "8 GB" PC ≈ 7.7 GB |

### Verdict: **8 GB is TIGHT.**

- **Enough** for quiet-hours trading on **one lane**, if the WSL VM is capped and the old ERP does not also run on this
  PC: the shop's own software needs about **0.55 GB** in total at 3,000 sales; Windows, Docker Desktop and the browser are
  the big costs.
- **Not enough** during an image build (first `up`, every rollback drill, every rollback) while trading: the VM fills to
  its 3.9 GB default cap and Windows starts paging. Builds and drills must happen outside trading hours (the guide
  already says "a quiet time" for the drill).
- **Not enough** if the old ERP client, Tally or many browser tabs share the PC — not measured, because we do not know
  what else runs there.

**`.wslconfig` tuning that helps** (file `C:\Users\<owner>\.wslconfig`, then `wsl --shutdown` and reopen Docker Desktop):

```
[wsl2]
memory=3GB
swap=4GB

[experimental]
autoMemoryReclaim=dropCache
```

3 GB covers the measured containers (≈0.45 GB) + VM base + an image build (pnpm install + 0.3 GB esbuild) with room; it
gives Windows ~1 GB back at the peak. Also: Docker Desktop → Settings → Resources → Resource Saver on. Caution for a
non-programmer: Notepad saves `.wslconfig.txt` unless "All files" is chosen — the guide must say this, or `doctor` must
write the file.

**What 16 GB would change:** steady ≈6 GB of ~15.7 GB; builds and drills fit while trading; the old ERP and more tabs
fit; the VM can keep a 4 GB cap. It also meets the roadmap's own **§33 POS-terminal baseline (16 GB)** — 8 GB is below
it, and §33's store-edge server baseline is 32–64 GB ECC + UPS. **Do not buy yet**: first measure on the real PC (Q1).

---

## 1. Findings table

| # | Area | Item | Status | Severity | Evidence (paths) | Source of requirement | What closes it (size) |
|---|---|---|---|---|---|---|---|
| C-01 | Memory | Application footprint measured: API ≤254 MB, edge ≤136 MB, PostgreSQL ≈188 MB PSS; ≤0.55 GB total at 3,000 sales | BUILT-ONLY (measured here on Linux, plain Node; never on Windows/Docker) | P2 | the build session's lab files (not kept in the repo), `runB.txt`, `samples*.json` | OB-247 "measure it" | Measure on the real PC in a practice day: Task Manager → Memory "In use"/"Committed" and `VmmemWSL` (S) |
| C-02 | Memory | Whole-PC budget on 8 GB: ≈5.9–6.3 GB steady; ≈8.3–8.9 GB during an image build → paging | MISSING (unmeasured on Windows) | P2 | §0 above | OB-247; roadmap §32 "Capacity: 2× expected peak, 12-month headroom" | `.wslconfig` cap + build only outside trading + the real-PC measurement (S); 16 GB only if the measurement says so |
| C-03 | Memory | Base compose (the one the real copy uses) has no `mem_limit` on `db`/`api`; the overlay's limits (1g/768m) are not applied; `doctor` checks only total RAM ≥7.5 GiB, not the WSL cap or ports 8090/8091 | BUILT-ONLY | P3 | `infra/compose/docker-compose.yml`, `docker-compose.pilot.yml:26,31`, `scripts/lib/store-computer.mjs` `doctorRows`, THRESHOLDS | roadmap §32 capacity | Limits in a real-copy file or `.wslconfig`; a doctor row for the WSL cap (S) |
| C-04 | Hardware | One 8 GB Windows PC does three roadmap jobs at once — POS terminal (§33: 16 GB, TPM, SSD), store-edge server (§33: ECC, 32–64 GB, UPS, monitored backup) and head-office "cloud" | NEEDS-OWNER | P2 | roadmap §33, §33.1 ("run power, LAN loss, prolonged-offline, performance and recovery tests" before buying) | roadmap §33; §32 "any relaxed target requires written owner approval and risk acceptance" | Owner's written acceptance for the pilot, naming the target release for §33 hardware (S) |
| C-05 | Topology | The till runs on **this same PC**: the served page always posts to `127.0.0.1:8090` and the edge listens on loopback only; the edge runs as plain Node in a window | TESTED on Linux (`tests/e2e/the-served-till-takes-a-sale.e2e.ts`, `tests/integration/the-installed-till-starts.test.ts`, `tests/unit/install-till.test.ts`); BUILT-ONLY on Windows (`start-till.cmd` never executed) | P1 | `apps/pos/src/browser-entry.ts:147` (`DEFAULT_LANE_PORT = 8090`), `edge/store-edge/src/main.ts:1614`, `scripts/install-till.mjs` `renderStartScript` | ADR-0004; hard rule #1 | First real run on the PC (M) |
| C-06 | Install | The owner's Windows guide installs **no till**: it ends at the G9 drill; `store-computer up` starts only `db migrate api`; no Windows steps for `till:install --settings .env.real`, `start-till.cmd`, `till-pin`, `token:store`, `tenant:bootstrap`, staff grants, the department load or publishing the catalogue pack. "READY — this copy is up" can read to the owner as "the shop system is ready" | MISSING | P1 | `docs/runbooks/store-computer-owner-guide-windows.md` (Parts 1–11), `scripts/lib/store-computer.mjs` `up()`; Linux/technician steps in `store-computer-real-data-environment.md` Steps 3 & 5, `in-store-install.md` 2b & 5 | Roadmap stage 12 "named lanes/departments, trained users"; OB-244 (owner does every step) | Guide Parts 12+ on Windows, with photos expected at each step (M) |
| C-07 | Topology | **Tills for one department:** the pilot plan says start on 1 lane, add a 2nd after Day 1 (owner, 24 Sep). Each lane needs its own edge and PC (ADR-0004; page hard-wired to 8090), and the API is published on `127.0.0.1` only, so a 2nd till PC could sell but **never sync**; G4 check 4 also refuses a non-local `CLOUD_API_URL`. UAT-14 ("refused on a second lane") cannot run | MISSING | P2 (workaround: a 1-lane pilot) | `infra/compose/docker-compose.yml` api `ports: 127.0.0.1:…`, `scripts/lib/store-computer.mjs` check 4, `docs/runbooks/pilot-plan-narrow-deep.md` §1 B | Owner choice B (24 Sep); UAT-14; roadmap §31 "single POS failure: other lanes continue" | Owner defers the 2nd lane in writing, or a design + ADR for a LAN-reachable head-office port with TLS (M) |
| C-08 | Network | With one lane on this PC, the sale path is loopback only: no LAN or Wi-Fi is involved in a sale; internet is needed only for setup downloads, the fingerprint copy and image builds. The real-data runbook's "wired network to the tills" applies only to a 2nd lane or handhelds (plain HTTP, staff-only WPA2 Wi-Fi per OA-16) | BUILT-ONLY on Windows (loopback design TESTED on Linux, same tests as C-05) | P3 | `store-computer-real-data-environment.md` "What you need" 1; `in-store-install.md` Step 6 | roadmap §33 Network ("no core POS over guest Wi-Fi") | Say so in the guide; if handhelds are used for receiving, a Windows step for `EDGE_DEVICE_HOST` + staff Wi-Fi (S) |
| C-09 | Continuity | **Single point of failure:** if this PC is off or crashes, the new system stops completely (till, edge, books, backups). Internet loss does **not** stop it (P-01 holds: no network on the sale path, and the till keeps selling if Docker/API is down). The only continuity is the old ERP in the parallel run — no written staff procedure for switching to it | MISSING (procedure) | P2 | `docs/pilot/PILOT-READINESS-PACKAGE.md:37-39` (rollback trigger), `docs/cutover/parallel-run.md` | roadmap §31 table: "Store server failure — failover or documented controlled continuity — recovery drill" | One-page bilingual "the new till has stopped" card + one drill (S) |
| C-10 | Power | **No UPS is named** for this PC or the router. The roadmap needs an online UPS for server/network and a UPS/power-cut test. PostgreSQL lives in the WSL 2 virtual disk, which is at risk on a hard power cut; the edge's fsync file log protects committed sales on NTFS, but only on Linux is it tested (`tests/unit/edge-file-log.test.ts` "a crash mid-write is visible"). UAT-14 (pull the power) not run | NEEDS-OWNER / MISSING | P1 | roadmap §33 Power; `docs/runbooks/pilot-plan-narrow-deep.md` UAT-14 | roadmap §33 "Online UPS for server/network; graceful shutdown"; §31 "Power loss: committed sale preserved; safe restart — UPS/power-cut test" | Confirm or buy a UPS (owner); run UAT-14 on the PC (S) |
| C-11 | Start-up | After any restart (power cut, overnight Windows Update, sleep) Docker Desktop starts only **after someone signs in to Windows**, and the till has **no auto-start** (a window opened by hand; "A Windows service — not yet"). The guide says nothing about sleep ("Never"), Windows Update active hours, or starting the till each morning | MISSING | P2 | `in-store-install.md` "What this does NOT yet include"; KL-08; guide Part 2 step 1 (Docker "start when you sign in" only) | P-01; roadmap §31 "safe restart" | Task Scheduler entry for the till + guide steps for power/sleep/update settings (S) |
| C-12 | Updates | **No procedure for installing a new release.** The till's data (`C:\SRE\till\edge-data`, `edge-witness`) and `.env.real` sit **inside** `C:\SRE`; the guide's model is "download a ZIP and extract". Replacing the folder would delete unsent sales, the bill-number witness and this copy's secrets. `up` does not rebuild images after a new ZIP (STATUS follow-up) | MISSING | P1 (a sale could be lost) | `scripts/install-till.mjs` (default `--dir <repo>/till`), `scripts/lib/store-computer.mjs` `layout()` (settings in `infra/compose`), `docs/STATUS.md` "Follow-up: up does not rebuild images" | Hard rule #2/#6; P-08; roadmap §31 "Bad release: rollback without transaction loss" | Keep data and settings outside the release folder + a tested Windows update step (M) |
| C-13 | Backup | `store-computer backup` copies **PostgreSQL only** — not the till's `edge-data` (where unsent sales live); it is manual (no schedule), **not encrypted**, to one USB drive. Restore-check is good | BUILT-ONLY (TESTED with a stand-in Docker: `tests/unit/the-store-computer-backs-up-restores-and-drills.test.ts`; real PG 16: `tests/integration/the-store-computer-backup-restores-on-real-postgres.test.ts`) | P2 | `scripts/lib/store-computer-recovery.mjs` (`pg_dump` only; no encryption) | roadmap §33 "Encrypted automated local + immutable off-site copy; restore proof; no single-device backup"; M35-FR-01; P-04 | Add the till folder, a daily routine and a second drive (M) |
| C-14 | Licence | Docker Desktop is free only for businesses with **fewer than 250 employees and less than US$10 M yearly revenue**; `pilot-deployment.md` says "free for a business of your size" with no evidence; the guide just says "Accept its terms". No ADR covers Docker Desktop/WSL 2 on Windows | NEEDS-OWNER | P2 | `docs/runbooks/pilot-deployment.md:17`; `docs/adr/` (none) | CLAUDE.md technology baseline ("any substitution requires an ADR … cost, support"); Docker subscription terms | Owner confirms size; or a paid subscription / ADR for another engine (S) |
| C-15 | Install | **Nothing has run on real Windows or real Docker** (STATUS 20 Oct; G-RD-6/7/8 "not yet run"). Riskiest untested assumptions listed in §3 | BUILT-ONLY | P1 | `docs/STATUS.md` top entry; `store-computer-real-data-environment.md` gaps table | Definition of Done; G4, G9 | The first real run, with a photo per step (M) |
| C-16 | Install | Guide steps that would confuse or fail (list in §3) | MANUAL | P2 | `store-computer-owner-guide-windows.md` | OB-244; P-07 | Guide edits (S) |
| C-17 | Install | Code vs guide: every message the guide tells the owner to look for (`All OK.`, `Settings file written`, `READY —`, the G4 table + `Record written`, `BACKUP DONE —`, `restored_and_reconciled —`, `DRY RUN — … five steps`, `G9 PASSED —`, `SLOW`, `THIS COPY MAY NOT BE ON THIS RELEASE NOW`) exists in the code | TESTED with stand-ins — 106 tests passed: `tests/unit/the-store-computer-setup-guides-the-owner.test.ts` (39), `…-backs-up-restores-and-drills.test.ts` (33), `…-compares-secret-fingerprints.test.ts` (13), `tests/unit/install-till.test.ts` (9), `tests/guardrails/the-store-computer-setup-never-shows-a-secret.test.ts` (8), `tests/guardrails/the-package-tool-scripts-run-on-windows.test.ts` (4) | — | `scripts/lib/store-computer.mjs`, `scripts/lib/store-computer-recovery.mjs` | OB-244–246 | — |
| C-18 | Recovery | A real rollback (and each drill) runs `up -d --build` on the previous folder: the image build runs `pnpm install` from the internet. A rollback on a night with no internet may fail; the 30-minute target on this 8 GB PC is untested | BUILT-ONLY | P2 | `scripts/lib/store-computer-recovery.mjs:635`, `infra/docker/api.Dockerfile` (`pnpm install`) | roadmap §32 targets (service 30 min); §31 "Bad release"; P-01 | Keep the previous release's built images on the PC and roll back to them without a build (M) |
| C-19 | Monitoring | No health probe or alert on the store PC (the hosted demo's probe is a Linux systemd timer; G7 "wire the channel on the box"). P-08 is met on screen only (unsent counter, "not known") | MISSING | P2 | `docs/pilot/MONITORING-AND-ALERTS.md`, `infra/pilot/health-probe` | G7; P-08 | A Windows scheduled check that emails the incident owner (S–M) |
| C-20 | Performance | One sale end-to-end on the served page: p50 13 ms, p95 22 ms (Linux, 4 vCPU); never measured on this PC with a real scanner | BUILT-ONLY | P2 | this audit's run A/B | QG-05 "scan-to-line p95 ≤300 ms on certified pilot hardware" | Time it on the PC during UAT (S) |
| C-21 | People / G8 | **Staff UAT: 0 sessions, no device verified on real hardware.** The 12-role checklist is written for the hosted demo (`pilot-demo`, demo logins). Nobody has said which role sections block a one-department pilot (picker, driver, supplier, customer are parked by the narrow-deep plan) | MISSING / NEEDS-OWNER | P1 | `docs/registers/sp10-staff-uat.md` ("Sessions run 0"), `docs/pilot/UAT-ROLE-CHECKLIST.md`, `docs/runbooks/pilot-plan-narrow-deep.md` §2 | G8; roadmap stage 12; §11.2 "role-based end-to-end UAT" | Owner picks the blocking roles (Q8) and books sessions on the demo now; then a short store-PC session on real hardware (M) |
| C-22 | People / hardware | No UAT on the real scanner, receipt printer or cash drawer; paper printing waits for a printer adapter | MISSING | P1 | KL-10; `docs/STATUS.md` ("Paper printing waits for the printer") | roadmap §33 Printer "Tamil/GST output proof"; QG-05 | Hardware step EX-09 + one session (M) |
| C-23 | People / names | **Names pending (OB-243):** pilot department, incident owner (G10), daily reconciler (R-05). Also needed before the pilot: 2–3 cashiers + 1 manager (plan choice C), the owner's and the CA's logins for `tenant:bootstrap`, the load operator and a *different* person to sign control totals (MG-06), the person who accepts the exception list (MG-05), the backup-drive custodian (guide Part 8), the person who may approve role grants (two-person rule). The department was "ambient groceries" on 24 Sep but OB-243 lists it as pending | NEEDS-OWNER | P1 | `docs/registers/decisions.md` OB-243; `docs/registers/risks.md` R-05; `pilot-plan-narrow-deep.md` §1 A, C; `store-computer-real-data-environment.md` Step 3 | G10; MG-05, MG-06, MG-10; hard rule #4 (no shared logins) | Owner's written list (S) |
| C-24 | People / training | **No training material in Tamil** (or English) for cashiers: `docs/sop/` is empty ("intentionally empty"), the owner guide is English only ("A Tamil version can come later"); the screens themselves show Tamil labels | MISSING | P1 | `docs/sop/README.md`; guide header | Roadmap stage 12 "trained users"; QG-09 "role curriculum, competency, floor support and SOP acknowledgements"; §23 "cashier … SOPs, user training materials, competency assessments and floor-support plan"; §2 target "training success ≥90%"; P-07 (OB-65 deferred the training *module* D11-FR-04, not the pilot's training) | A one-page Tamil/English cashier card per task (sign in, sell, cash, refund, unsent counter, "till stopped") + a 10-question check (M) |
| C-25 | People / parallel run | "Store staff ring both systems" — no cashier procedure: which system prints the customer's bill, what to do when the two disagree, how long double keying takes per bill (staffing in quiet hours) | MISSING | P1 | `docs/pilot/STEP-1-REAL-DATA-PLAN.md` §2.10; `docs/cutover/parallel-run.md` | MG-10; CGST Rules 2017 rule 46 (one tax invoice per supply, unique serial per year) — the roadmap covers GST invoice output (§33 "Tamil/GST output proof") but not two bills for one sale | Owner chooses the bill of record (Q9) + a desk procedure (S) |
| C-26 | People / support | **No support plan.** The incident owner is the owner; the build session cannot touch the PC and works from photos; remote help is forbidden by the guide (rule 2); no out-of-hours path; no "till won't sell" card. At 7 pm the owner has nothing written to follow | MISSING | P1 | guide "If a step fails"; `docs/pilot/MONITORING-AND-ALERTS.md` "Escalation" (P0/P1 → incident owner) | Roadmap §23 "floor-support plan"; QG-08 "incident escalation rehearsed"; G10; D4 (second technical custodian Mr Sivakumar) | A 7 pm card (below) + a named second line (Q7) (S) |
| C-27 | People / security | The cashier will sit at the Windows session that holds `.env.real`, Docker and PowerShell. On this copy the sign-in is the stand-in IdP (KL-01/G-RD-4): whoever reads `IDP_SIGNING_KEY` can act as any login, including the owner | NEEDS-OWNER | P1 | `store-computer-real-data-environment.md` G-RD-4; guide rule 1 | Hard rule #4 (no shared logins, no secrets exposed); P-04 least privilege | A separate standard Windows account for the till (owner's session keeps Docker and the edge running; the cashier session uses only the browser), or written risk acceptance (S) |

---

## 2. Top 5 blockers, in plain English

1. **The setup guide stops before there is a till.** After all eleven parts the PC has a database and the head-office
   program running, but no till, no staff, no PINs and no products. The steps for those exist only for a technician on
   Linux, and the till program has never been started on Windows. (C-05, C-06, C-15)
2. **People are not ready.** The pilot department, the incident owner and the daily reconciler are not named; no staff
   practice session has been held (0 of 12 roles); there is no cashier training sheet in Tamil; and nobody has written
   down how a cashier rings the same sale on both the old and the new system, or which bill the customer gets.
   (C-21, C-23, C-24, C-25)
3. **When something breaks, there is no plan.** One PC does everything, with no UPS named, no automatic start after a
   power cut or Windows Update, no alert, and no written "the new till stopped" card. You are the only support; the
   build session cannot touch the PC. (C-09, C-10, C-11, C-19, C-26)
4. **Installing a new version could delete sales.** The till's saved sales and this copy's secret settings sit inside
   the `C:\SRE` folder, and there is no written way to update it. Replacing the folder would lose them. (C-12)
5. **8 GB is tight, and the cashier sits at the PC that holds every key.** The shop's software needs only about half a
   gigabyte, but Windows, Docker and the browser use most of the rest, and a rebuild during trading will slow the PC.
   The cashier's Windows session is also the one that holds the master keys. (C-02, C-27)

---

## 3. The install path a non-programmer follows (guide walk-through)

Checked step by step against `scripts/lib/store-computer.mjs` and `store-computer-recovery.mjs`. The code's messages
match the guide (C-17). Steps that would confuse or fail:

- **Part 1.1** "Installed RAM 8.00 GB" — `doctor` checks *usable* RAM ≥ 7.5 GiB. A PC whose graphics reserve more than
  ~0.5 GB passes Part 1 but fails `doctor` (P3).
- **Part 1 (missing):** where the PC must stand (it *is* the till: counter, scanner, drawer, printer); UPS; sleep =
  Never; Windows Update active hours; that the owner's Windows account must be an administrator.
- **Part 2.1 Docker Desktop:** needs administrator approval (UAC), and on a fresh Windows 11 it often asks for WSL to be
  installed (`wsl --install` needs an *administrator* PowerShell; the guide only shows `wsl --update` in a normal one)
  and a **second reboot**. "Accept its terms" hides the licence question (C-14). No `.wslconfig` step (C-02).
- **Part 2.4** execution policy: handled well (`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`).
- **Part 3:** fine (no git needed; the ZIP is ~44 MB; longest path ~140 characters, under Windows' 260 limit).
- **Part 4 `pnpm install`:** needs internet; pnpm 10 may print "Ignored build scripts" in yellow (fine); Windows
  Defender or another antivirus may make it very slow or block it.
- **Part 5 `up`:** the first build downloads base images and runs `pnpm install` inside the container — 10–30 min on
  an 8 GB PC is plausible (guide says "several minutes"). `READY — this copy is up` does not mean a till exists (C-06).
  If the old ERP uses PostgreSQL on port 5432 on this PC, `up` says "restart the computer", which will not help.
- **Part 7:** unplugging the cable while Docker Desktop runs — WSL 2 localhost forwarding with no network has never
  been tried here.
- **Part 8:** the backup drive is never cleaned ("nothing is deleted, ever") — it will fill eventually; no schedule.
- **Part 9:** needs your SSH login to the demo box and `sudo` to the deploy user, and the demo box must already run a
  release that has `fingerprints` (STATUS says it does not yet).
- **Part 11:** the drill rebuilds two releases (internet needed, high memory) — do it outside trading hours (C-18).
- **Missing parts:** the till, staff and PINs, products, auto-start, the daily backup routine, how to update, and what
  to do when the till stops (C-06, C-11, C-12, C-26).

**Riskiest untested assumptions, most dangerous first**

1. Docker Desktop + WSL 2 install and the first `up` image build on this PC (pnpm install in the container, the
   Windows-path bind mount of `db-init`, named volumes). If this fails, nothing else runs.
2. The till's edge as a plain Node program on Windows via `start-till.cmd` (the `for /f` settings loader, Windows paths
   for the data and witness folders, fsync on NTFS, ports 8090/8091) — not even in the owner's guide.
3. 8 GB with Windows + the Docker VM + a browser + possibly the old ERP (C-02).
4. A hard power cut with PostgreSQL inside the WSL 2 virtual disk and no UPS (C-10).
5. Rollback on this PC: a rebuild that needs internet and must finish inside 30 minutes (C-18).
6. Offline operation with the cable out while Docker Desktop's networking runs.
7. Restarts: Docker Desktop only after sign-in; the till only by hand; sleep and Windows Update (C-11).
8. Third-party antivirus common on shop PCs blocking WSL, Docker or Node listening on a port.
9. pnpm 10 / Node 22 behaviour on Windows (package-manager switch, ignored build scripts, PowerShell policy).
10. `ssh`/`scp` from Windows to the demo box for fingerprints, and the demo box's release.
11. The USB drive's format and letter; the read-only flag on the backup files.

---

## 4. People and UAT (G8, G10)

- **Staff UAT needed before the pilot:** G8 needs the role-based blocking cases passed with real people. The checklist
  has 12 roles (cashier, store manager, owner, accountant, CA, warehouse, picker, driver, buyer, supplier, customer,
  platform admin); the narrow-deep plan's spine needs at least cashier, manager, owner, accountant, CA,
  receiving/warehouse and buyer. **Done: none** (`sp10-staff-uat.md`: 0 sessions, no device verified).
- **Roles that must be named** (C-23): pilot department; incident owner; daily reconciler; 2–3 cashiers and a manager;
  owner's and CA's logins; load operator and a different control-total signer; exception-list acceptor; backup
  custodian; second person for role grants. Note the parallel-run rule that only the named reconciler (or the owner)
  may record a day.
- **Tamil training:** does not exist (C-24).
- **Support at 7 pm with a till that won't sell** — nothing is written. What a card would need to say (to be written
  and tested, not invented here as a requirement):
  1. Keep selling on the old ERP. The parallel run means it never stopped. Write down the time the new till stopped.
  2. Do **not** re-enter bills on the new till later, and do not "fix" anything in PowerShell at night.
  3. One try: if the black till window is closed, double-click `C:\SRE\till\start-till.cmd`; if Docker Desktop is
     closed, open it and run `pnpm run store-computer -- up`. Nothing else.
  4. The next morning, send photos of the till window and the `up` output. The daily reconciler records the gap with
     its reason ("new till down 19:05–close"), so it is a visible difference, not a silent one (P-08, hard rule #10).

---

## 5. Questions only the owner can answer

**Q1 — Memory (OB-247).**
- A. Keep 8 GB for now. I add the `.wslconfig` step to the guide, and you send one Task Manager photo during a practice
  hour with the till open. Buy only if "In use" stays above ~6.5 GB. *Consequence:* no spend now; builds and drills only
  out of hours.
- B. Add a second 8 GB memory stick now (16 GB). *Consequence:* a small cost; comfortable margin; matches roadmap §33's
  till baseline.
- C. Use a different PC that already has 16 GB for the store system. *Consequence:* no purchase; this PC stays for other
  work.

**Q2 — Where the till stands, and how many lanes.**
- A. This PC goes to the counter and is the pilot's only till (one lane). *Consequence:* works with what is built; the
  2nd-lane step and UAT-14's second-lane check are deferred in writing to a named release.
- B. This PC stays in the office; a second PC at the counter is the till. *Consequence:* needs a build change so the
  second PC can reach the books (C-07), plus an ADR, before the pilot.
- C. One lane for the pilot, and the second lane built before the wider rollout. *Consequence:* the same as A, with the
  date written down now.

**Q3 — Power.**
- A. Buy an online UPS for this PC and the router before the pilot (roadmap §33). *Consequence:* a cost; the power-cut
  test can be passed.
- B. An existing UPS already covers this PC — send its model and how long it lasts. *Consequence:* no cost if it is big
  enough.
- C. Run the pilot without a UPS and accept the risk in writing. *Consequence:* a power cut can stop the new till and may
  damage its database; recovery is from your USB backup.

**Q4 — Does the old ERP (or Tally) run on this same PC?**
- A. No, it runs on another PC. *Consequence:* the 8 GB budget above holds.
- B. Yes. *Consequence:* we must measure both together before deciding on memory.
- C. Not sure — send a photo of Task Manager → Processes.

**Q5 — Docker Desktop licence.**
- A. SRE has fewer than 250 staff and under US$10 million (about ₹85 crore) yearly turnover — free use is allowed; you
  confirm in writing. *Consequence:* no cost.
- B. Above either limit — buy a Docker subscription. *Consequence:* a monthly cost per user.
- C. Ask the build session for an ADR on another container engine. *Consequence:* more build work before the pilot.

**Q6 — Names for the pilot (OB-243 and the extras in C-23).**
- A. Name them all now in writing. *Consequence:* staff accounts, PINs and UAT can be planned.
- B. You are the incident owner and the daily reconciler for the pilot yourself; name only the cashiers, the manager
  and the CA now. *Consequence:* fastest start, but every evening's check depends on you.
- C. Hold the pilot until all names are given. *Consequence:* nothing starts; the build session works on the guide
  meanwhile.

**Q7 — Who helps when it breaks.**
- A. You are first line; Mr Sivakumar (the named second technical custodian, D4) is second line during pilot hours.
  *Consequence:* he needs a short hand-over session.
- B. Hire local IT help for the pilot weeks only. *Consequence:* a cost, and they must follow guide rule 2 (no remote
  control).
- C. Trade on the new till only while you are in the shop; at other times staff use only the old ERP. *Consequence:*
  fewer pilot hours, but always someone on hand.

**Q8 — Which UAT roles block G8 for a one-department pilot.**
- A. Cashier, store manager, owner, accountant, CA, warehouse/receiving and buyer block; picker, driver, supplier,
  customer and platform admin are deferred in writing. *Consequence:* about 7 sessions before GO.
- B. All 12 roles block. *Consequence:* more sessions, including roles the pilot does not use.

**Q9 — Which bill does the customer get during the parallel run.**
- A. The old ERP prints the customer's bill; the new till records the same sale with no paper bill. *Consequence:* no
  printer needed on day one; the GST bill stays on the system you file from today.
- B. The new till prints the bill; the old ERP is keyed afterwards. *Consequence:* needs the printer step and the
  GST-output proof first.
- C. Ask the CA before deciding. *Consequence:* the pilot waits for the CA's answer.

**Q10 — The cashier's Windows login.**
- A. A separate standard Windows account for the till; you sign in first to start Docker and the till, then switch user.
  *Consequence:* the cashier cannot open the settings file or PowerShell; it needs one guide section.
- B. One Windows login for everyone during the pilot, with your written risk acceptance. *Consequence:* breaks hard
  rule #4's "no shared logins" spirit; anyone at the counter could read the master keys.

---

## Plain-English summary for the owner

We ran the new shop software for real on a test computer and rang 400, then 3,000, practice sales through the actual
till screen. The shop's own programs need only about **half a gigabyte** of memory. On your 8 GB PC, most of the memory
goes to Windows, Docker and the web browser, so **8 GB is tight but can work for one till in quiet hours**, provided we
limit Docker's share and do updates outside trading hours. Before you buy anything, send one photo of Task Manager while
the till is open.

The bigger gaps are not memory. The current guide stops before there is a working till. Nobody is named for the pilot
yet, no staff practice has been done, there is no Tamil training sheet, and there is no written plan for a power cut or
for "the till stopped at 7 pm".

**What to check in the store:** (1) Task Manager → Performance → Memory with the till open — read "In use";
(2) whether a UPS powers this PC and the router; (3) whether the old ERP runs on this same PC; (4) where this PC
stands — it must be at the counter if it is the till.
