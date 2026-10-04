# Runbook — the demo deployment pipeline and the store practice environment (Option 1, 1 October 2026)

_Owner direction (1 Oct 2026): connect the existing automatic deployment to the already-purchased demo VPS, deploy the
current tested `main`, verify it, prepare a complete store practice environment on synthetic data, prove the deployed
workflow, and record staff/device results under SP-10. **No new server. No rebuilt deployment system.** No private key,
secret value, server address or password appears in this document or anywhere in the repository (hard rule #4)._

Every step below is marked **EXECUTED** (done from the build session, with evidence in the repository) or **PREPARED**
(written and tested here; a person with access to the box or to GitHub settings performs it). The build session cannot
reach the box, GitHub's environment secrets, the store PC or a phone, so every step on those is PREPARED.

---

## 0. Where things stand (EXECUTED — confirmed on 1 October 2026)

| Fact | Evidence |
|---|---|
| `main` was at **`ed35952`** (PR #670, 1 Oct 2026) when this was confirmed; its pipeline run is green on all three verification jobs. This runbook and the smoke command merged after it as **`0bf098a`** (PR #671), so the release to deploy is `0bf098a` or later | GitHub Actions runs 36842090658 and the `main` run for `0bf098a` |
| The release job ran on that merge and its deploy step was **skipped**: "No demo box is configured" — the `demo` environment holds no `DEPLOY_*` secrets | the same run, job *Deploy the merged release to the demo box* |
| The demo box was stood up on **28 September** at commit **`e72b4ae`** (`docs/STATUS.md`, "demo stood up on VM3"); `main` is **78 commits** ahead of it | `git rev-list --count e72b4ae..main` |
| What the box lacks from those 78 commits that the first release will meet: the release script itself (`infra/deploy/release.sh`, 29 Sep), the compose **`proxy`** service on 443/80, migrations **0012** (row-level security) and **0013** (tenants register), the **application database role** (`APP_DB_USER`), and seven new settings in `.env.pilot` | `git diff e72b4ae main --stat -- infra db/migrations`; template diff in §2 step C |
| The work done on the box during the stand-up (demo sign-in page, demo data bridge, the fixed-UUID demo tenant, `HOSTED-DEMO-RESULTS.md`, ADR 0016) was **never pushed**: `origin` has no `claude/pilot-hosted-standup` branch and no `pilot-rc-1` tag | `git ls-remote --heads origin`; `git ls-remote --tags origin` |
| `main`'s pilot seed still names the demo tenant with the label `pilot-demo`; the ledger stores tenant ids as UUIDs, which is the bug fixed on the box and not here | `db/seed/pilot/dataset.ts` (`PILOT_DEMO_TENANT`), `packages/migration/src/tenant-bootstrap.ts` (the refusal text) |
| The deployed-workflow smoke test exists and passes against the production API assembly on real PostgreSQL | `scripts/demo-smoke.ts`, `tests/integration/the-demo-smoke-script-proves-the-loop.test.ts` |
| Automatic deployment is built, tested and documented | `docs/runbooks/automatic-deployment.md`, `tests/integration/the-release-script-deploys-and-rolls-back.test.ts` |

**Honest headline:** the demo box runs software from 28 September that predates every store-management fix of 30 Sep
to 1 Oct (including H-13, the "sale did not reduce stock" defect seen on that demo). Nothing deploys until the one-time
steps in §2 are done by the administrator. The pipeline, the release script with rollback, the smoke test and this
runbook are ready.

---

## 1. Reconcile the server work (EXECUTED 3 Oct 2026 — the branch was pushed by the administrator, reviewed and merged behind the public proxy, PR #678)

The box holds work the repository does not. It must be reviewed and merged **before** anything from `main` is re-seeded
onto the box, and before the first release (the release script checks out a commit and refuses a dirty checkout).

**On the box, as the administrator** (nothing here touches the running containers):

```bash
cd /opt/sre/app
git status                                   # see what the stand-up changed; .env.pilot must NOT be listed (it is git-ignored)
git switch -c claude/pilot-hosted-standup    # or the branch the on-server session already made
git add -A -n                                # DRY RUN: read the list; if any file under infra/compose/.env* or any key file appears, STOP and exclude it
git add -A
git commit -m "hosted stand-up work from the demo box (28 Sep 2026)"
git push -u origin claude/pilot-hosted-standup
```

Then tell the build session the branch is up. It will review the diff against `main`, keep what is useful (the UUID demo
tenant, the sign-in page, the hosted results and ADR 0016), exclude anything with an address or a secret, and merge it
through a pull request like any other change. Until that merge, **do not re-run the seed from `main` on the box**.

---

## 2. Connect automatic deployment (EXECUTED 3 Oct 2026 by the administrator — the pipeline deployed `2f9714c`, run 37125939387; evidence in `docs/evidence/demo-deployment-2026-10-03.md`; the ordered one-sheet version is `demo-deployment-handover.md`)

Follow `docs/runbooks/automatic-deployment.md`. The ordered list below adds what that runbook assumes but the box, as
stood up on 28 September, does not yet have. Secret **names** are exact; **values** are never written anywhere but the
place named.

**A. Save the server work first** — §1 above.

**B. Bring the checkout to `main`** (the running stack keeps running from its old build until the release job runs):

```bash
cd /opt/sre/app && git fetch origin main && git checkout main && git pull --ff-only
```

**C. Add the settings the new release needs to `infra/compose/.env.pilot`** (the template `infra/compose/.env.pilot.example`
at `main` shows each with a comment; names only here):

| Setting | What to put | Why |
|---|---|---|
| `APP_DB_USER` | a plain role name, e.g. `sre_pilot_app` | the API now refuses to run as the database superuser (row-level security, migration 0012) |
| `DATABASE_URL` | re-composed to connect as `APP_DB_USER` (same password as `POSTGRES_PASSWORD`), not as `POSTGRES_USER` | same reason |
| `SRE_PUBLIC_HOST`, `SRE_TLS`, `SRE_DEFAULT_SNI` | the box's domain and a certificate-notice email, or the box's public IP for a self-made certificate (demo only) | the stack now brings its own HTTPS front (the `proxy` service, ADR-0018) |
| `SRE_AUTH_ROUTE`, `SRE_AUTH_UPSTREAM`, `HTTPS_PORT`, `HTTP_PORT` | leave at the template defaults | customer sign-in answers 503 by name (KL-15); the proxy listens on 443/80 |
| `EDGE_TENANT_ID` | leave as it is — the demo tenant's fixed UUID the stand-up set | the store token and the smoke test read it |

**D. Inspect ports 443 and 80 FIRST, then choose.** The stand-up put HTTPS in front by hand (before the compose `proxy`
existed), and the VPS may serve other applications. `sudo ss -ltnp '( sport = :80 or sport = :443 )'` and the running
service list say what is there. **Configuration A** (nothing else, or only the hand-installed front for this demo): stop and
disable that front so the stack's proxy can bind 443/80. **Configuration B** (another application is served through the
existing front): keep it; set `HTTPS_PORT=127.0.0.1:8443` / `HTTP_PORT=127.0.0.1:8088` so the stack binds loopback only,
and add one site to the existing front forwarding the demo hostname to `https://127.0.0.1:8443` with the Host header kept
(limitation: the API's per-IP limits are then shared by every visitor). The exact commands, the two configurations and the
front snippets are in **`demo-deployment-handover.md`** steps C and F — the one sheet the administrator follows.

**E. Create the application database role on the EXISTING database** (a fresh volume would do this itself; yours was
initialised before the script existed). The three statements are in `docs/runbooks/pilot-deployment.md`, section
"Row-level security — one step for an EXISTING database": `CREATE ROLE … LOGIN NOSUPERUSER NOBYPASSRLS`, the two
`GRANT`s, and `REASSIGN OWNED BY <administrator> TO <app role>`. Use the compose project of the demo (`-p sre-pilot`
with the pilot compose files, as in the stand-up runbook). Type the password into the terminal only.

**F. Take a backup before the first upgrade** — `pnpm run db:backup` as the stand-up did (encrypted; the private key stays
off-server with the owner). Keep the backup file name. The release script never touches data and never runs
`down -v`; its rollback puts the **previous commit's containers** back on the **same** data, which the migration suite
proves is safe (every migration is additive and idempotent). The backup is for the case nobody expects.

**G. The deploy user, the forced-command key and `deploy.conf`** — `docs/runbooks/automatic-deployment.md` steps 1 to 6
(on the box: `deploy` user in the `docker` group, owner of `/opt/sre`; `deploy.conf` copied from
`infra/deploy/deploy.conf.example` with `SRE_BUILD_ENV="PILOT_DEMO_BANNER=1"`; on your own computer: the key pair
`sre-pipeline-key`; on the box again: the public key as the forced command line from `infra/deploy/authorized_keys.example`).

**H. GitHub → the repository → Settings → Environments → New environment `demo` → Environment secrets:**

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | the box's address |
| `DEPLOY_USER` | `deploy` (only if another name was used) |
| `DEPLOY_PORT` | the SSH port (only if not 22) |
| `DEPLOY_SSH_KEY` | the entire contents of the private key file `sre-pipeline-key` |
| `DEPLOY_HOST_KEY` | the one line `ssh-keyscan -t ed25519 -p <port> <the box's address>` printed |

Then delete `sre-pipeline-key` from your computer (step 8 of that runbook).

**I. Trigger the first release:** GitHub → Actions → the latest `main` run → *Re-run all jobs* (or merge the next pull
request). The job *Deploy the merged release to the demo box* must end **green** with the summary line
"Deployed <sha> to the demo box". A **red** job prints, in words, whether it was refused, rolled back, or needs a person
(the table in `automatic-deployment.md`, "When it goes red").

---

## 3. Verify the deployed release (EXECUTED 3 Oct 2026 — the administrator's output: commit, readyz, migrations, public 200 · 401 · 302 · 200; `docs/evidence/demo-deployment-2026-10-03.md`)

The commit to expect is the head of `main` at the time of the run — **`0bf098a`** (PR #671, 1 October 2026) or later;
it must not be older than `0bf098a`, which is where `pnpm run demo:smoke` first exists (full id in the Actions run; the
release log records the full 40 characters).

```bash
tail -3 /opt/sre/releases.log                         # last line: result=deployed sha=<main head> previous=<the old commit>
git -C /opt/sre/app rev-parse HEAD                    # the same sha
curl -s http://127.0.0.1:8081/readyz                  # {"ready":true,…}
cd /opt/sre/app/infra/compose && docker compose -p sre-pilot -f docker-compose.yml -f docker-compose.pilot.yml --env-file .env.pilot ps
docker compose -p sre-pilot -f docker-compose.yml -f docker-compose.pilot.yml --env-file .env.pilot logs migrate | tail -5   # 13 migrations applied once; a re-run applies 0
cd /opt/sre/app && STANDUP_ENV_FILE=infra/compose/.env.pilot pnpm run standup:check                                     # GREEN on every piece
curl -skI https://<the box's name or address>/customer/ | head -3                                                       # 200 on the public origin
curl -sk https://<the box's name or address>/v1/livez                                                                   # the API through the proxy
curl -skI https://<the box's name or address>/pos/ | head -1                                                            # 404 by name: staff screens are NOT public (KL-15)
```

Open `https://<the box>/customer/` in a browser: the **DEMO / PILOT — NOT PRODUCTION** banner must be visible.

**Rollback, if ever needed** (custodian, on the box): `sudo -u deploy /opt/sre/app/infra/deploy/release.sh <previous sha>`
— the same refusals and checks apply; data is untouched.

---

## 4. The store practice environment (PREPARED; physical steps named)

The staff screens are **not** served by the demo box. By design (ADR-0004, ADR-0018, KL-15) the till, the ERP screens
and the handhelds are served by a **store computer in the shop**, which keeps trading when the internet is down and sends
its records to the demo box. So the practice environment is: the demo box (head office) + one store PC + phones.

### 4.1 Physical steps still required (nobody can do these from a build session)

1. A PC in the shop with 8 GB RAM, Node 22 and pnpm, its clock set to Asia/Kolkata, on the shop network. A USB barcode
   scanner (keyboard-wedge) plugged in. Optionally a receipt printer (EX-09; printing is built, the printer is not attached).
2. A **staff-only WPA2/WPA3 wifi** (OA-16) that the store PC and the phones share; nothing else on it.
3. Two or three Android phones with Chrome (one each for the warehouse, picker and driver screens).
4. The demo box reachable from the store PC over HTTPS (the public origin: `/v1/*` is what the store PC talks to).

### 4.2 The store PC (follow `docs/runbooks/in-store-install.md`; the deltas for the practice environment are below)

```bash
git clone <the repository> sre && cd sre && git checkout <the deployed sha> && pnpm install   # the SAME commit as the demo box (from /opt/sre/releases.log)
```

Make a small settings file for the installer to copy from (it copies the tenant, the key and the cloud address — never
a token). The two values come from the box's `.env.pilot` and are typed in by the administrator, never sent in a chat:

```
# till/cloud.env — on the store PC only
EDGE_TENANT_ID=<the demo tenant's UUID, from the box's .env.pilot>
PACK_SIGNING_KEY=<the box's PACK_SIGNING_KEY — the till must trade on packs the box signs>
CLOUD_API_URL=https://<the box's name or address>
```

```bash
pnpm run till:install -- --lane lane-1 --from-compose-env till/cloud.env
```

Then **on the box** mint the store token (`pnpm run token:store -- --tenant <the demo tenant UUID> --user pilot-cashier --ttl-hours 720`)
and put it into the store PC's `till/till.env` as `CLOUD_API_TOKEN` by hand. For the demo the box signs in as the seeded
`pilot-cashier` account, which holds every sync hop (cashier role); a dedicated `store-edge` login is a go-live step
(UAT-05, `store-go-live-checklist.md`).

Add to `till/till.env`:

```
EDGE_PACK_FILE=till/store-pack.json
EDGE_DEVICE_PORT=8092
EDGE_DEVICE_HOST=<the store PC's address on the staff wifi>
```

### 4.3 The practice store pack (`till/store-pack.json` on the store PC) — BUILT since DF-2 (4 Oct 2026), not typed

The box pulls the **catalogue** (products, prices, barcodes) from the demo box's published pack. Everything else a
screen needs — which store this is, who is on which screen, the handheld assignment, the picker's wave, the driver's
route, the handheld fleet — comes from this file. **Since DF-2 (OB-12) a person builds it instead of typing it**, from
the seed dataset, the cloud's role catalogue and the cloud's own purchase orders, invoices, pending approvals and
count records (one commerce truth, P-02):

```
# on the demo box (writes /etc/sre-pilot/store-pack/store-pack.json, then restart the edge)
sudo -u deploy pnpm run demo:store-pack -- --operator "<your name>"
docker restart sre-pilot-edge-1
# on a store PC (writes the practice file the till reads at EDGE_PACK_FILE)
pnpm run demo:store-pack -- --operator "<your name>" --out till/store-pack.json
```

The runner says what it wrote (products, people, screens with a named viewer, approvals waiting, orders, receipts,
invoices, count records, the practice delivery / wave / route) and names any section it **left out because the cloud
read did not answer** — that screen then says it was not told, which is true; nothing is invented. The builder is
`db/seed/pilot/store-pack.ts`, proven through the box's own reader and screen payloads in
`tests/unit/demo-store-pack-builds-the-whole-practice-pack.test.ts`. The shape it writes, for the record (the values
below are the kind it fills in; the file on disk is the truth):

```json
{
  "version": 1,
  "policies": {
    "storeId": "pilot-demo-branch", "branchId": "pilot-demo-branch", "branchName": "SRE Pilot Demo Hypermarket (demo)",
    "warehouseId": "pilot-demo-wh", "tradingDayCutoff": "00:00", "staleAfterSeconds": 900,
    "countApprovalThresholdMinor": 100000, "handoverToleranceMinor": 10000, "privilegedActions": []
  },
  "lossPreventionRules": [],
  "managerPolicy": { "userId": "pilot-manager" },
  "warehouse": {
    "assignmentId": "practice-1", "workerId": "pilot-manager", "storeId": "pilot-demo-wh",
    "bins": [{ "binId": "bin-demo-a1", "storeId": "pilot-demo-wh", "capacityMinor": 1000000, "pickable": true, "zone": "ambient" }],
    "grnId": "practice-grn-1", "poId": null,
    "ordered": [{ "productId": "prod-rice", "quantityMinor": 20, "unitCostMinor": 5000, "currency": "INR" }],
    "barcodes": [{ "barcode": "8900000000123", "productId": "prod-rice", "level": "unit" }],
    "goodsIn": []
  },
  "wave": {
    "waveId": "practice-wave-1", "pickerId": "pilot-manager",
    "lines": [
      { "lineId": "l1", "orderRef": "ORD-practice-1", "productId": "prod-rice", "description": "Demo Ponni Rice 1kg (demo)", "bin": "bin-demo-a1", "requiredQty": 2, "uom": "ea", "unitPriceMinor": 6800 },
      { "lineId": "l2", "orderRef": "ORD-practice-1", "productId": "prod-soap", "description": "Demo Bath Soap 100g (demo)", "bin": "bin-demo-a1", "requiredQty": 1, "uom": "ea", "unitPriceMinor": 3500 }
    ]
  },
  "route": {
    "routeId": "practice-route-1", "driverId": "pilot-manager",
    "stops": [
      { "stopId": "s1", "orderRef": "ORD-practice-1", "area": "Anna Nagar (demo)", "codMinor": 25000 },
      { "stopId": "s2", "orderRef": "ORD-practice-2", "area": "Gandhipuram (demo)", "codMinor": 0 }
    ]
  },
  "devices": []
}
```

The ids above are the seeded demo tenant's (branch `pilot-demo-branch`, back store `pilot-demo-wh`, products
`prod-rice`, `prod-soap`, bin `bin-demo-a1`, from `db/seed/pilot/dataset.ts`). The builder also writes `roles` and
`roleAssignments` (the cloud's catalogue and the seeded people — what lets the store computer draw each person's
menu), `buyingPolicy` / `pricingPolicy` / every `<screen>Policy` with the practice script's cast (§7) and that
person's permissions, `approvals` (the cloud's pending ones), `purchaseOrders` / `receipts` / `supplierInvoices`
(the cloud's), `countsQueue`, a five-item day-close `checklist` and `lossPreventionRules`, all marked (demo). The ERP screens on this PC run **as the
person the pack names** (`managerPolicy.userId` — there is no interactive staff sign-in on the ERP screens in this
release, KL-01); the warehouse, picker and driver screens act as the named worker, picker and driver. `pilot-manager`
holds the store-manager role, which carries the rights each of those needs. Other per-screen policies (buying,
goods receipt, counts, cash office, …) take the same shape — `"<screen>Policy": { "userId": "pilot-manager" }` — and
`edge/store-edge/src/store-pack.ts` lists them all.

### 4.4 Enrolling the phones (handhelds)

Per `in-store-install.md` Step 6, performed by `pilot-platform-admin` or `pilot-owner` through the demo box's API
(these two hold `platform.device.manage`):

1. Register each phone: `POST /v1/platform/devices/<deviceId>/register` (kind `handheld`). Use ids like `hh-warehouse-1`,
   `hh-picker-1`, `hh-driver-1`.
2. Issue each phone's one-time code: `POST /v1/platform/devices/<deviceId>/enrolment`. The answer shows the code **once**;
   copy the returned `enrolment` block (it holds only the code's fingerprint and expiry) into the pack file's `devices`
   list with the device's `deviceId`, `kind: "handheld"`, `status: "registered"` and a `label`. Restart the till.
3. On the phone, on the staff wifi, open `http://<the store PC's address>:8092/warehouse/` (or `/picker/`, `/driver/`):
   it is sent to **Enrol this handheld**; type the device id and the code; it comes back on the screen it asked for.
4. The phone's list **Sent from this handheld / phone** shows each action as *saved here* → *with the store computer* →
   *posted at head office*, or *refused* with the reason.

### 4.5 What stays disabled (verified by the build, not by trust)

Live card/UPI capture, GST / e-invoice / e-way-bill filing, payroll bank-file release and payroll approve/lock, bulk and
sensitive-category product publish, customer SMS/WhatsApp/email, production AI, "delete my data" execution, and all
real data. `tests/integration/pilot-feature-safety.test.ts` and the step-up guards hold these off; the DEMO banner is
baked into every shell by `SRE_BUILD_ENV="PILOT_DEMO_BANNER=1"` in `deploy.conf`.

---

## 5. Prove the deployed workflow (EXECUTED 3 Oct 2026 on the box — smoke 16/16 on `2f9714c`, `EXIT=0`; the script was also EXECUTED here on the real stack)

```bash
cd /opt/sre/app && pnpm run demo:smoke -- --env-file infra/compose/.env.pilot --report /opt/sre/smoke-$(date +%F).json
```

It creates a **fresh synthetic tenant** through the same bootstrap the operator tool uses (refused on a production box,
refused on the demo tenant), then runs, through the real routes against the API the box is serving, with a real store
box started inside the command and the till's own session model:

supplier (proposed, approved by a second person) → purchase order (proposed, issued by a second person) → delivery at
the back store, 2 of 12 damaged and **quarantined** → QC returns them → floor indent → manager approval against real
stock → back-store issue (**in transit, not received**) → independent floor receipt → the till pulls head office's pack
and **sells one by barcode** → the sale banks and **the shelf falls by exactly one** → an eligible **resale return**,
manager-approved, **puts it back** → float, pickup, blind close → **cash office: 1,000 in the drawer, no over/short** →
invoice matched, debit note, payables and the day book **balanced**, ledger = register → the dashboard shows the day →
the same sale re-sent **banks once**.

Sixteen steps, each PASS / FAIL with what was seen, exit code 0 only when all pass, no token or key printed. The report
file holds the tenant id, the run label, the commit of the checkout it ran from and every step — send its contents back
(it contains no secret). Proven here: `tests/integration/the-demo-smoke-script-proves-the-loop.test.ts` runs the same
function against the production API assembly on real PostgreSQL (16/16 on 1 Oct 2026).

What the smoke does **not** cover and the practice must: the phones (enrolment, warehouse scan, pick, delivery) and
the screens in a browser — those are SP-10 (§7).

---

## 6. Access (PREPARED; no secret here by design)

| What | Where | Who / how |
|---|---|---|
| Public origin (customer app, guest; the API) | `https://<the box>` — the address is in the owner's own records and in the GitHub `demo` environment, never in the repository | anyone; browse as a guest; the DEMO banner shows |
| Till | `http://127.0.0.1:8091/pos/` on the store PC | the cashier signs in by **staff code** = the demo user id (`pilot-cashier`); the till identifies, it does not authenticate (GAP-POS-LOGIN-01) |
| ERP screens (manager, buying, goods receipt, indents, cash office, day book, suppliers, …) | `http://127.0.0.1:8091/<screen>/` on the store PC | run as the person the pack names (`pilot-manager`), see §4.3 |
| Handhelds | `http://<store PC>:8092/warehouse/`, `/picker/`, `/driver/` on the staff wifi | enrolled by device code, §4.4 |
| Demo accounts (synthetic) | `pilot-owner`, `pilot-manager`, `pilot-cashier`, `pilot-accountant`, `pilot-ca`, `pilot-platform-admin`, `pilot-supplier` | seeded by `db/seed/pilot`; roles as in `db/seed/pilot/dataset.ts` |

Role restrictions are enforced by head office on every write: a cashier cannot set a price, a buyer cannot approve
their own supplier, an issuer cannot receive their own issue. Those refusals are part of the practice.

---

## 7. Practice script, role by role (PREPARED)

Run each on a different day or in sequence; each row names what the person should see. Record every session in
`docs/registers/sp10-staff-uat.md` with the software version.

| # | Role (demo account) | Where | Do | What you should see |
|---|---|---|---|---|
| 1 | Buyer (`pilot-manager`) | ERP `/buying/` | Propose a supplier; try to approve it yourself; have the owner approve. Propose a purchase order for 12 of one product. | your own approval is refused; the owner's lands; the order shows "proposed" then "issued" with the commitment |
| 2 | Receiver (`pilot-manager`) | Warehouse phone | Receive the delivery by scanning the barcode; mark two damaged; tap "Delivery complete". Put away the good stock. | each scan "saved here" → "with the store computer" → "posted"; head office's goods receipt shows 10 sellable, 2 held |
| 3 | QC / checker (`pilot-manager` on a second screen, or the owner) | ERP `/goods-receipt/` | Decide the damaged line: return to supplier. Try as the receiver first. | the receiver's own decision is refused; the checker's is recorded once |
| 4 | Floor staff (`pilot-cashier`) + manager + back store | ERP `/indents/` and the warehouse phone | Raise an indent for the shelf; manager approves; back store issues by scanning bin and item; the floor counts it in. | requested / approved / issued (in transit) / received shown separately; the shelf stock appears only after the floor receipt |
| 5 | Cashier (`pilot-cashier`) | Till | Sign in by staff code; take the float; scan and sell; pull the network cable and sell again; reconnect. | both sales complete; the unsent counter rises then falls; stock at head office falls by two |
| 6 | Cashier + manager | Till | Return one item with the receipt (manager approves); try a return without a receipt; an exchange. | refund settled; stock back; the no-receipt and exchange flows follow the prompts |
| 7 | Cashier + cash office (`pilot-accountant`) | Till, ERP `/cash-office/` | Bank a pickup; close the till blind; sign off the over/short. | the count sheet shows no expected figure; the cash office sees the chain |
| 8 | Picker (`pilot-manager`) | Picker phone | Scan the bin, scan the item, confirm; flag a quality fail; pack the crate. | each line listed with its state; head office's wave shows the lines and the pack with no flags |
| 9 | Driver (`pilot-manager`) | Driver phone | Deliver one stop with proof and cash; fail the other back to the store; end of shift: count and hand over. | seven items listed "with the store computer"; the order's journey at head office matches |
| 10 | Accountant (`pilot-accountant`) | ERP `/finance/`, `/day-book/` | Post the payables and the day book. | every journal balances; the ledger agrees with the supplier register |
| 11 | Owner (`pilot-owner`) | Owner app on the store PC (`/owner/`) | Read the day. | "Sales today" equals what the till rang |

Cross-cutting, once per person: the DEMO banner is visible; a refused action says why; English and Tamil both render.

---

## 8. Recording (PREPARED)

- Every session: `docs/registers/sp10-staff-uat.md` — who, device, software version (box commit from `/opt/sre/releases.log`,
  store PC commit from `git rev-parse HEAD`), step results, defects. **A green pipeline and a passing smoke never fill a
  row there.**
- The smoke report files (`/opt/sre/smoke-<date>.json`) are the machine column; paste their contents into the pull
  request that records the session.

## 9. Known limitations of this practice environment

- The warehouse pack section's `ordered[].quantityMinor` is shown by the handheld as WHOLE UNITS, while the receiving
  service's quantities are in thousandths (the seeded receipt's `100_000` = 100 units). The DF-2 builder writes whole
  units for the handheld, as the hand-written file did. DF-3 must settle ONE scale for every pack section (found 4 Oct 2026).

- The demo box is still on the 28 September release until §2 is done; this document is written for the release at `0bf098a` (PR #671) or later.
- The ERP screens have no interactive staff sign-in: the pack names one person per screen (KL-01, OA-4). The till
  identifies the cashier by staff code without authenticating them (GAP-POS-LOGIN-01).
- The box signs in to head office as `pilot-cashier` for the demo; a dedicated `store-edge` login is a go-live step (UAT-05).
- Head office assigns waves and routes to phones since 3 Oct 2026 (HA-1: `POST /v1/fulfilment/waves/:waveId/assignment`, `POST /v1/delivery/routes/:routeId/assignment`; the box pulls the open ones). The pack file's `wave` / `route` sections below are the hand-written override and still work for a first practice session; the screen says which source it is holding. A head-office screen for assigning is not built yet — the two routes are called through the API.
- No TLS on the shop-network leg to the phones (OA-16: staff-only wifi is the control).
- Receipt printing, weighing scales and cash drawers are built but not attached (EX-09).
- The seed in `main` names the demo tenant with a label; the fixed-UUID fix lives on the box until §1 is merged.
