# Runbook — installing a working till on one shop PC (the one-lane pilot)

**Who this is for:** a technician setting up the pilot lane's computer — someone comfortable
following commands, not necessarily a programmer.
**What it does:** turns one back-office PC into a **working till** for the pilot: the database, the
cloud services, the owner screen, and the till screen that actually takes a sale — all on one
machine.
**How long:** about 30 minutes, most of it waiting for downloads and builds.

> **Why one PC.** For a single-lane pilot this is the simplest safe layout (see the pilot plan). The
> "cloud" is this same machine for now; you move it to a separate box when you go wider.

> **Why the till runs OUTSIDE the containers.** The till screen saves each sale to a small service on
> **this machine's own loopback** (`127.0.0.1`) — a deliberate security control: nothing on the shop
> network can write a sale (ADR-0004). A browser can only reach that service if it runs on the
> machine itself, not inside a container whose loopback is private. So the database and cloud API run
> in containers, and the **till's edge runs as a plain program on the PC**. This exact arrangement is
> proven end to end in a real browser (`tests/e2e/the-served-till-takes-a-sale.e2e.ts`).

---

## What you need

1. A PC with **8 GB RAM** and a few GB free — a normal office PC.
2. **Docker Desktop** (Windows/Mac) or **Docker Engine** (Linux), installed and running.
3. **Node.js 22** and **pnpm** installed.
4. A copy of this repository on that machine.

---

## Step 1 — Settings

From the repository folder, set up the configuration (this is the same file the container stand-up
uses — see `pilot-deployment.md` Step 1 for the detail):

```
cd infra/compose
cp .env.example .env
```

Open `.env` and fill in every placeholder: a database password, `DATABASE_URL`, `PACK_SIGNING_KEY`,
the three `IDP_*` values, and `EDGE_TENANT_ID`. Generate each secret with `openssl rand` as the file
explains. **Nothing starts until they are all real values** — that is deliberate.

## Step 2 — Start the database and cloud services (containers)

Start just the database, the schema migration, and the cloud API — not the container edge or web
server (the till edge runs on the host instead, next):

```
docker compose up -d db migrate api
```

Give it a minute on first run. Check the cloud API answered:

```
curl http://127.0.0.1:8081/readyz
```

You want `"ready": true`.

## Step 3 — Build the till and the edge

From the repository root:

```
cd ..\..            # back to the repository root (use ../.. on Mac/Linux)
pnpm install
pnpm build:pos      # the till screen
pnpm build:edge     # the store edge (the till's own save-service)
```

## Step 4 — Start the till's edge (on the PC, not in a container)

This one program serves the till screen **and** owns the save-socket, both on this machine's
loopback. Set its settings and run it. On **Mac/Linux**:

```
EDGE_DATA_DIR=./edge-data \
EDGE_TENANT_ID=<the same tenant id you put in .env> \
PACK_SIGNING_KEY=<the same signing key you put in .env> \
EDGE_CAPACITY_BYTES=10737418240 \
EDGE_LANE_PORT=8090 \
EDGE_SCREEN_PORT=8091 \
EDGE_APPS_DIR=apps \
node edge/store-edge/dist/start.js
```

On **Windows (PowerShell)**, set each with `$env:EDGE_LANE_PORT="8090"` (and so on) before
`node edge/store-edge/dist/start.js`.

- **`EDGE_LANE_PORT=8090` must stay 8090** — it is the port the till screen posts sales to.
- Leave `CLOUD_API_URL` / `CLOUD_API_TOKEN` **unset for now**. The till then runs **offline-first**:
  it sells, saves every sale to disk, and queues them, telling you plainly nothing is syncing yet.
  That is a safe state to start a pilot in. (Turning sync on is Step 7.)

The program prints `lane socket on 127.0.0.1:8090` and `screens on 127.0.0.1:8091`. Leave it running.

## Step 5 — Open the till

In a browser on this PC:

- **Till:** http://127.0.0.1:8091/pos/

The Sale screen opens. Scanning is keyboard-driven, exactly as a real hand scanner behaves.

## Step 6 — Prove it before the pilot

Two checks, both worth doing in front of staff:

1. **A sale saves.** Ring an item, take cash, complete the sale. It completes and the receipt number
   appears — the sale is now durably on this PC's disk. (This is the exact path the automated browser
   test proves; here you are seeing it on the real machine.)
2. **It keeps selling with no internet.** Disconnect the network and ring another sale. It still
   completes and the **unsent counter** goes up — nothing is lost. That is the whole promise.

Then run the readiness gate for a plain-English GREEN/RED on the pieces:

```
pnpm run standup:check
```

## Step 7 — Turn on sync to the books (when you're ready)

So far the till sells and queues; to also send those sales up to the books and the owner dashboard on
this same PC, stop the edge (Ctrl-C), then start it again (Step 4) with two more settings:

```
CLOUD_API_URL=http://127.0.0.1:8081 \
CLOUD_API_TOKEN=<a store token — see below> \
```

**The store token is the one remaining set-up piece.** It is a login token this store's edge uses to
send its sales to the cloud API, and issuing it is part of provisioning the store's logins
(go-live checklist UAT-05). Until a token is issued, run offline-first (Step 4) — the shop still
trades and loses nothing; the sales wait in the queue. Tooling to issue a store token is the next
increment of this work.

---

## Stopping and starting

- **The containers:** `docker compose stop` / `docker compose start` (keeps all data).
- **The till edge:** Ctrl-C in its window to stop; re-run the Step 4 command to start.

## Backing up

Even in a pilot, take a backup before anything you care about — see `backup-and-recovery.md`.

---

## What this does NOT yet include

Being straight about the boundaries:

- **A store token for live sync** (Step 7) — the tooling to issue one is the next increment; until
  then the till runs offline-first.
- **Your real products and prices** — loading them is a data step (the catalogue), on the go-live
  checklist.
- **A receipt printer** — receipt building is built and tested; attaching a physical printer is a
  device step.
- **A separate back-office box** — a one-lane pilot runs everything on this PC; a wider rollout moves
  the database and cloud services to their own machine (no rewrite — the same pieces move).

**Related:** `pilot-deployment.md` (the all-container quick stand-up) · `store-go-live-checklist.md`
(the in-store human sign-offs) · `pilot-run-sheet.md` (the day-by-day plan) · `backup-and-recovery.md`.
