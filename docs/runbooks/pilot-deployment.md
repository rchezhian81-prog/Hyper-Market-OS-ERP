# Runbook — standing up a pilot (one machine)

**Who this is for:** the owner, or the second custodian (Mr Sivakumar, D4).
**What it does:** brings the whole system up on **one computer** — the database, the schema,
and the till/owner screens — so you can try it before committing to any cloud vendor.
**How long:** about 15 minutes, most of it waiting for downloads.

> This is deliberately **vendor-neutral**. It runs on a shop back-office PC, a laptop, or any
> cloud machine, so doing this does **not** commit you to a cloud provider. The vendor choice
> (ADR-0002) stays open, and the same containers run there later.

---

## What you need

1. A computer with **8 GB RAM** and a few GB of free disk — a normal office PC is fine.
2. **Docker Desktop** (Windows/Mac) or **Docker Engine** (Linux) installed. It is free for a
   business of your size. Install it from docker.com and confirm it is running.
3. A copy of this repository on that machine.

Nothing else. No cloud account, no payment, no vendor.

---

## Step 1 — Set the database password

In a terminal, from the repository folder:

```
cd infra/compose
cp .env.example .env
```

Open `.env` in a text editor and do two things:

1. Replace `REPLACE_WITH_A_GENERATED_VALUE` with a long random password. On Mac/Linux generate
   one with `openssl rand -base64 24`; on Windows, any long random string of letters and
   numbers is fine.
2. Fill in `DATABASE_URL` on one line, joining the values you just set — the postgres scheme,
   then `://`, your user, `:`, your password, then `@db:5432/` and the database name. The file
   itself spells out the shape.

**Keep this file on the machine only.** It is already excluded from the code repository, so the
password can never be committed by accident — the automated secret scan enforces that.

## Step 2 — Start everything

```
docker compose up -d
```

The first run downloads the database and web server images (a few minutes). It then:

- starts **PostgreSQL** (the database),
- runs the **migrations** — creating the tables for the event ledger, the sync outbox and the
  versioned settings,
- starts the **web server** with the till and owner screens.

## Step 3 — Check it worked

```
docker compose ps
```

You should see `db` and `web` running, and `migrate` **exited (0)** — that means the schema was
created successfully. `migrate` finishing and stopping is correct, not an error.

To see what the migrations did:

```
docker compose logs migrate
```

You should see each migration either `apply`ed or `skip`ped, ending with *"Done — N
migration(s) checked"*. Running it again applies nothing new — it is safe to re-run.

## Step 4 — Open the screens

In a browser on that machine:

- **Till:** http://localhost:8080/pos/
- **Owner brief:** http://localhost:8080/owner/

The till opens on the Sale screen. To see it work end to end, first build the app logic once:

```
cd ../..        # back to the repository root
pnpm install
pnpm build:pos
pnpm build:owner
```

Then reload the browser. Scanning is keyboard-driven, exactly as a real hand scanner behaves.

## Step 5 — Prove the offline promise

This is the test worth doing in front of staff:

1. Ring up a sale on the till.
2. **Disconnect the network** (unplug the cable / turn off Wi-Fi).
3. Ring up another sale, take cash, and complete it.

The sale still completes and the **unsent counter** goes up. Nothing is lost. That is hard
rule #1 working, and it is the single most important thing to demonstrate.

---

## Stopping and restarting

```
docker compose stop     # stop, keeping all data
docker compose start    # start again
docker compose down     # stop and remove the containers (data is kept in the volume)
```

**To delete the data as well** (only for a clean test restart):

```
docker compose down -v
```

That removes the database volume. Do **not** run it on anything real — it is irreversible.

---

## Backing up the database

Even in a pilot, take a backup before anything you care about:

```
docker compose exec db pg_dump -U sre_app sre_retail_os > backup-$(date +%F).sql
```

Keep a copy **off the machine** (M35 requires an immutable off-site copy, and a restore that
has actually been tested — not assumed).

---

## What this pilot does *not* include

Being straight about the boundaries:

- **No cloud sync yet.** The sync agent is built and tested, but the cloud endpoint it uploads
  to needs the hosted tier — that is the vendor decision (ADR-0002).
- **No real product data.** The catalogue snapshot builder is ready; feeding it your actual
  products and prices is a data step (M30 import).
- **No printer attached.** Receipt building and ESC/POS output are built and tested; connecting
  a physical printer is a device step.
- **The ERP screens** need a server-rendered app, whose framework choice is tied to the hosting
  decision (see `apps/web-erp/README.md`).

## When you are ready for the cloud tier

The same containers move there — nothing is rewritten. What changes is: a **managed PostgreSQL**
replaces the `db` service, the app containers run on the provider's container service, and
`DATABASE_URL` points at the managed database. That is ADR-0002 item 4, and it needs your
commercial choice on real quotes against the ₹20,000/month ceiling (D3).

---

**Related:** `infra/compose/` (the stack itself) · `docs/adr/0002-hosting-and-deployment.md` ·
`docs/architecture/infrastructure.md` · `docs/runbooks/how-to-check-tests.md`.
