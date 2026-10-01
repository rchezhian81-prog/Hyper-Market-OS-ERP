# Runbook — installing a working till on one shop PC (the one-lane pilot)

**Who this is for:** a technician setting up the pilot lane's computer — someone comfortable
following commands, not necessarily a programmer.
**What it does:** turns one back-office PC into a **working till**: the till screen that takes a
sale and saves it on this PC's own disk, the office screens, and — when you are ready — the sync to
the books. One command installs it; one script starts it.
**How long:** about 10 minutes, most of it waiting for the build.

> **Why one PC.** For a single-lane pilot this is the simplest safe layout (see the pilot plan). The
> "cloud" can be this same machine, the purchased server, or nothing at all to begin with — the till
> sells and queues either way (P-01).

> **Why the till runs as a plain program, not in a container.** The till screen saves each sale to a
> small service on **this machine's own loopback** (`127.0.0.1`) — a deliberate security control:
> nothing on the shop network can write a sale (ADR-0004). A browser can only reach that service if
> it runs on the machine itself, not inside a container whose loopback is private. So the **till's
> edge runs as a program on the PC**; the database and cloud API run in containers, here or on the
> server. This exact arrangement is proven end to end in a real browser
> (`tests/e2e/the-served-till-takes-a-sale.e2e.ts`), and the installer's own test starts a till from
> the very settings file it writes (`tests/integration/the-installed-till-starts.test.ts`).

---

## What you need

1. A PC with **8 GB RAM** and a few GB free — a normal office PC.
2. **Node.js 22** (LTS) and **pnpm** installed. (Docker is needed only if the cloud runs on this PC —
   Step 3.)
3. A copy of this repository on that machine, with `pnpm install` run once.
4. The PC's **clock right and set to the shop's time zone** (Asia/Kolkata). The till dates every sale by this clock
   and the shop's cut-off; head office dates "today" on the dashboard by the time zone you answer in store setup
   (`locale.time_zone`, default Asia/Kolkata — SP-9-i-c). If the PC keeps a different zone, the two will disagree
   about which day a late sale belongs to.

---

## Step 1 — Install the till (one command)

From the repository folder:

```
pnpm run till:install -- --tenant <your tenant id> --lane <this till's lane, e.g. lane-1>
```

**`--lane` names which lane THIS PC is** (SP-4b). Every sale the till rings carries that lane, and the cashier signs in
with their staff code before the first sale, so every sale names who rang it and where. Give each till PC its own lane
name; a re-run keeps the lane an earlier install wrote.

**If the cloud runs on this PC** and you have already filled `infra/compose/.env` (see
`pilot-deployment.md`), leave `--tenant` out — the installer reads the tenant id and the pack signing
key from that file, so the till trades on the packs your cloud signs.

**If there is no cloud yet** (an offline-only till to start with), add `--generate-key`. The installer
says plainly that the key was generated and that the cloud must be given the same key before this
till can take a cloud pack.

What the command does, and says as it goes:

- checks the machine (Node 22 or newer);
- writes `till/till.env` — this till's settings, readable by a person, **kept on this PC only** (it
  holds the signing key; it is git-ignored, and the installer never prints the key);
- creates `till/edge-data/` — where every sale, refund and queue lives on disk;
- builds the till screen, the office screens and the store edge;
- writes `till/start-till.sh` (Mac/Linux), `till/start-till.cmd` (Windows) and an optional
  `till/sre-till.service` (Linux start-at-login);
- prints the next steps.

Re-running it is safe: it rebuilds, and **keeps** a settings file that already exists (an install
never rotates the key that signed the packs this till holds). Pass `--force` to rewrite the file on
purpose. Every problem is named at once — a missing tenant, no key to sign with, a bad port — and
nothing is written until they are all fixed.

## Step 2 — Start the till

- **Windows:** double-click `till\start-till.cmd`.
- **Mac/Linux:** run `till/start-till.sh`.

The window prints `lane socket on 127.0.0.1:8090` and `screens on 127.0.0.1:8091`. **Leave it
running** — it is the till. (Linux: to start it at login without a window, copy
`till/sre-till.service` to `~/.config/systemd/user/` and run
`systemctl --user enable --now sre-till`.)

Then, in a browser **on this PC**:

- **Till:** http://127.0.0.1:8091/pos/

The Sale screen opens. Scanning is keyboard-driven, exactly as a real hand scanner behaves.

## Step 3 — Prove it before the pilot

Two checks, both worth doing in front of staff:

1. **A sale saves.** Ring an item, take cash, complete the sale. It completes and the receipt number
   appears — the sale is now durably on this PC's disk.
2. **It keeps selling with no internet.** Disconnect the network and ring another sale. It still
   completes and the **unsent counter** goes up — nothing is lost. That is the whole promise.

Then run the readiness gate for a plain-English GREEN/RED on the pieces:

```
pnpm run standup:check
```

It reads `till/till.env`, checks the till's save socket and the served till screen are answering on
this PC, and says whether the till is syncing to the books or (safely) selling-and-queuing only. When
`infra/compose/.env` is also present it checks the cloud pieces on this PC as before.

## Step 4 — The cloud (containers) — if it runs on this PC

If the books live on this same PC rather than the purchased server, stand them up once
(`pilot-deployment.md` Steps 1–3): fill `infra/compose/.env`, then

```
cd infra/compose
docker compose up -d db migrate api
```

and check `curl http://127.0.0.1:8081/readyz` says `"ready": true`. If you did this BEFORE Step 1,
the installer already copied the tenant id and the signing key from that file.

## Step 5 — Turn on sync to the books (when you're ready)

So far the till sells and queues. To also send those sales up to the books and the owner dashboard,
issue a **store token** and give the till two settings.

```
pnpm run token:store --tenant <your tenant id> --user store-edge --ttl-hours 720
```

It reads the identity settings from `infra/compose/.env`, prints a token **once** (it is a secret —
put it straight into the file below, never a chat or a message), and it is valid for 30 days. The token
carries its own id and issue time; **if the PC or the token is ever lost, the owner revokes it at once**
(`POST /v1/identity/token-revocations` with the token's id, or the `store-edge` user with no id) and it
stops working on the next request — no need to wait 30 days or rotate the signing key. **The
account it names (`store-edge`) must hold the sync permissions** — provision that login with the
cashier role as part of setting up the store's logins (go-live checklist UAT-05): it carries the
sale / refund sync, the catalogue-pack read, the migration register read, the concession docket
relay and the published-template read, and none of them grants a decision.

Open `till/till.env` and fill in:

```
CLOUD_API_URL=http://127.0.0.1:8081        (or the server's address)
CLOUD_API_TOKEN=<the token you were shown>
```

Stop the till (Ctrl-C, or close the window) and start it again (Step 2). It now drains its queue to
the books whenever there is a line, and keeps selling when there is not.

> **Pilot stand-in.** The token tool is the pilot's stand-in for a proper identity provider — the
> same job that provider's admin console does at go-live. Choosing the production identity provider
> is a later decision (ADR OA-4); when it lands, tokens come from it and this script is retired.

---

## Step 6 — Enrolling a handheld (the warehouse phone or scanner) — SP-3a

The warehouse handheld does not use a login. It is **enrolled once** with a code head office issues for THAT device,
and from then on the store computer knows it by a credential it holds itself (ADR-0019). Nothing on the handheld's
screen is served to a device that has not enrolled.

1. **Open the handheld door on the store computer.** In the till's environment file add

   ```
   EDGE_DEVICE_PORT=8092
   EDGE_DEVICE_HOST=<the store computer's address on the STAFF wifi, e.g. 192.168.10.5>
   ```

   and restart the till (Step 2). The boot log says `handhelds: enrolled handhelds on the shop network can reach
   this box at http://<address>:8092/`. Leave `EDGE_DEVICE_HOST` out and the door opens on the computer itself only
   (nothing on the network can reach it) — useful for a rehearsal, useless for a phone.
2. **Register the device at head office** (the fleet register, `POST /v1/platform/devices/<deviceId>/register`,
   kind `handheld` or `mobile`) — the same step every till goes through. The store pack the box pulls carries the
   fleet's `devices` list; until the pack section feed is built (SP-9) the operator copies that list into the
   pack file (`store-pack.json` → `devices`) — never a code, only what head office returns.
3. **Issue the code** — `POST /v1/platform/devices/<deviceId>/enrolment` by a person holding
   `platform.device.manage`. The answer holds the code ONCE (twenty letters and digits in four groups); head office
   keeps only its fingerprint and the expiry (a day by default). Put the returned `enrolment` block on the device's
   pack entry and let the box pull the pack (or restart it against the file).
4. **On the handheld**, open `http://<address>:8092/` in the browser. It shows **Enrol this handheld**: type the
   device id and the code, press Enrol. A wrong code says so and counts (five wrong per device per fifteen minutes,
   then a wait); an expired code says so — issue a new one; a code already used says so — it never works twice.
   On success the warehouse screen opens as the named worker with the served assignment.
5. **Check it took:** the boot log line `handheld <deviceId> (warehouse) handed over N record(s)` appears after the
   first scan; on the handheld the list **"Sent from this handheld"** shows each scan and where it is —
   *saved on this handheld* → *with the store computer* → *posted at head office* (or *refused*, with the reason).
   Closing the browser or restarting the phone loses nothing: the list is the same when it reopens.
6. **A lost or leaving handheld:** at head office set its status to `blocked` (or `retired`); the next pack pull
   refuses it at its next request and sends it to the enrolment page. A new code for the same device supersedes the
   old one.

> **The shop-network leg is plain HTTP for now.** Until TLS is added at the device socket (a Stage E follow-up),
> the handhelds must be on a **staff-only WPA2/WPA3 wifi, separate from any guest wifi** (owner action register
> OA-16). The till's and manager's screens are not on this door at all — it serves the handheld screens only.

---

## Stopping and starting

- **The till:** Ctrl-C in its window (or close it) to stop; run the start script again to start.
  Nothing is lost by stopping — a sale not yet sent stays in the queue on disk.
- **The containers (if on this PC):** `docker compose stop` / `docker compose start` (keeps all data).

## Backing up

Even in a pilot, take a backup before anything you care about — `till/edge-data/` is the till's
disk; see `backup-and-recovery.md`.

---

## What this does NOT yet include

Being straight about the boundaries:

- **The production identity provider** — the store token (Step 5) is issued by a **pilot stand-in**
  tool; the real credential source is the identity-provider decision (ADR OA-4), still open.
- **Provisioning the `store-edge` login** with the cashier role — a store-setup step (UAT-05); the
  token only works once that account holds it.
- **Your real products and prices** — loading them is a data step (the catalogue), on the go-live
  checklist. Until a pack is published and pulled, the till has no price list and says so.
- **A receipt printer** — receipt building is built and tested; attaching a physical printer is a
  device step (EX-09).
- **TLS on the handheld door** — the device socket (Step 6) speaks plain HTTP on the staff wifi until the Stage E
  follow-up; the picker's and the driver's phones reach head office through the door since SP-3c (1 Oct 2026).
- **A Windows service** — on Windows the till runs in a window you leave open (or a Task Scheduler
  entry you create for `start-till.cmd`); the Linux start-at-login unit is provided.

**Related:** `pilot-deployment.md` (the all-container quick stand-up) · `store-go-live-checklist.md`
(the in-store human sign-offs) · `pilot-run-sheet.md` (the day-by-day plan) · `backup-and-recovery.md`.
