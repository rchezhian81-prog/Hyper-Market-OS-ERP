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
   about which day a late sale belongs to. Changing the time zone in store setup — like the trading-day cut-off, the
   currency, the till's loyalty spend cap and the bulk-publish threshold — needs **the owner's approval** of exactly
   that answer, asked by someone else (OB-336); the default needs nothing.

---

## Step 1 — Install the till (one command)

From the repository folder:

```
pnpm run till:install -- --tenant <your tenant id> --lane <this till's lane, e.g. lane-1>
```

**`--lane` names which lane THIS PC is** (SP-4b). Every sale the till rings carries that lane, and the cashier signs in
with their staff ID and their own till PIN before the first sale (Step 2b), so every sale names who rang it and where. Give each till PC its own lane
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

## Step 2b — Give each cashier a till PIN (ADR-0020)

Nobody can take money at a till until the store computer knows them. Two things must be true for each cashier:

1. **The store pack names them with till authority** — head office's people and role register (a person whose role
   holds `pos.sale.sync`, as every Cashier role does). A pack with no people register signs nobody in.
2. **They have a till PIN set on THIS store computer.** You, the administrator, run on the store computer, in your
   own terminal (never through a chat or a remote-support tool), with the person beside you:

   - **Mac/Linux:** `till/start-till.sh till-pin --user <their staff id> --by "<your name>"`
   - **Windows:** `till\start-till.cmd till-pin --user <their staff id> --by "<your name>"`
   - **The hosted copy's box (containers):** `docker compose exec edge node edge/store-edge/dist/start.js till-pin --user
     <staff id> --by "<your name>"` — only needed if that box ever asks for a PIN; the hosted copy normally signs the
     person in from their password sign-in.

   It then asks **the person** for their new six-digit PIN, twice, at this keyboard — hidden, a star per key (round 4):
   hand them the keyboard and look away. The PIN is never shown, printed or logged, so you never see it; if the two do
   not match (three tries) nothing is changed. A window that cannot hide what is typed (input piped from a file or a
   program) is refused. Only a fingerprint of the PIN is kept, in `till-credentials.json` beside the sales on disk, and
   that fingerprint is useless on any other computer.
   - `--generate-and-show` is the old way: the box makes the PIN and **shows it on the screen** to whoever is in front
     of it, with a warning. Use it only if the person cannot type their own PIN at this keyboard.

- **Reopening a closed day (2b-vi-c-4):** the person who approves a reopen keys their **own** till PIN on the Reopen a
  locked day screen, and so does the person reopening (unless they signed in on the internet copy). So the owner and the
  accountant each need a till PIN on this store computer too — issue them the same way. They do not need till
  authority to have a PIN for this; the store computer checks that the approver holds `till.dayclose.approve` and the
  reopener `till.dayclose.read`.
- **Forgotten PIN:** run the same command again and the person types a new one — it replaces the old one at once.
- **Someone leaves, or a PIN may be known to someone else:** add `--revoke`. Their next sign-in is refused; a till
  they are still signed in at refuses their next sale as soon as head office removes their role from the pack.
- **At the till:** tap **Sign in**, scan the badge (or key the staff ID), OK, then key the six-digit PIN and OK. The PIN
  shows as dots. Five wrong PINs lock that staff ID for fifteen minutes; twenty failed sign-ins lock that till's sign-in
  for fifteen minutes. A sign-in lasts the shift (twelve hours at most) or until **Sign out**; reloading the page keeps
  it, restarting the store computer keeps it.
- **Managers who approve refunds** need a till PIN too, issued the same way, and a role that may approve refunds
  (`pos.return.approve`, as the Store manager and Owner roles have). At the till the manager keys their own PIN after
  their badge; the store computer issues an approval for that one refund only, for five minutes (ADR-0021). On the
  hosted copy a manager who is to approve refunds needs a PIN issued on that box (the containers command above).
- **What the store computer keeps:** every sign-in, refusal and sign-out in `till-operators.log` (never a PIN); every
  manager approval given and used in `till-approvals.log`; and on every sale and refund the person it verified
  (`operatorVerified`) and, on a refund, the approval it spent (`approvalVerified`).

## Step 3 — Prove it before the pilot

Two checks, both worth doing in front of staff:

0. **Only a real cashier can sell.** Tap Sign in, key a staff ID and a WRONG PIN: it says the ID and PIN do not match,
   and nobody is signed in. Then sign in properly (Step 2b). For a refund, let the cashier try to approve it with their
   own badge and PIN: it says **Not approved**; then the manager approves it with theirs.
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
pnpm run token:store -- --tenant <your tenant id> --user store-edge --store <this store's id> --ttl-hours 720
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

> **When the screens say "this store computer's head-office login needs renewing" (OB-429).** Head office refused
> the token: it expired after its 30 days, or it was revoked. The store computer stopped contacting head office at the
> first refusal, so the shop's address is not locked and people can still sign in to head office on the store PC. It
> keeps selling and keeps every bill queued. Make a new token as above, put it in `till/till.env`, and restart the till.
> The queue then goes up by itself. A restart with the old token is refused once again and stops again.

> **Pilot stand-in.** The token tool is the pilot's stand-in for a proper identity provider — the
> same job that provider's admin console does at go-live. Choosing the production identity provider
> is a later decision (ADR OA-4); when it lands, tokens come from it and this script is retired.

### Step 5b — Register the store computer's own lanes (round 33, owner decision OB-121)

From round 33 head office believes a bill-number prefix in a store computer's health report only when head office
**issued** it to one of that store's tills (Receipt prefixes), or it is one of **that store computer's own lane prefixes**
(`R-<lane>-`, the numbering a one-store shop's till used before prefixes were issued) **registered at head office**. Anything
else the store computer names is refused at the door — never kept — and counted on the Health page
(`box_prefixes_refused:<store>`, one line per store computer per day).

- **A till with a head-office prefix** (the normal case, and every till of a business with more than one store): nothing to do.
- **A till that numbers `R-<lane>-`** (one store, a till that already had its own numbering): once, when the store
  computer is installed and granted its `store_computer` role for its store, the IT administrator (or the owner) registers
  its lanes — a named person's act, append-only, on the audit trail:

  ```
  POST /v1/store-computers/lane-prefixes
  { "computer": "<the store computer's sign-in>", "storeId": "<its store>", "lanes": ["lane-1"], "reason": "installed <date>" }
  ```

  It is refused by name when the sign-in is not a store computer of that store, a lane would make a prefix longer than 10
  characters, a lane is not a till registered at that store (when the store's tills are registered), or the computer would
  have more than 32. `GET /v1/store-computers/lane-prefixes` lists every registration (who, when, how) and the refused lines.
- **Existing store computers** that already reported `R-<lane>-` before round 33 keep working without this step: on their
  first report after the upgrade head office registers, once, by itself (`via: seen_before_registration`), the lanes that
  SAME computer reported in reports head office kept before the rule AND under which head office holds real bills (sales or
  refunds). An invented lane with no bill is never registered; at most 32. The demo seed registers the demo box's
  `lane-1` when it binds the box to the demo store.
- A `ZZ…` prefix is a store computer's own fallback for a till with no prefix issued: it is refused at the door too. The fix
  is to issue that till its prefix (Receipt prefixes), not to register anything.

---

## Step 6 — Enrolling a handheld (the warehouse phone or scanner) — SP-3a

The warehouse handheld does not use a login. It is **enrolled once** with a code head office issues for THAT device,
and from then on the store computer knows it by a credential it holds itself (ADR-0019). Nothing on the handheld's
screen is served to a device that has not enrolled.

1. **Open the handheld door on the store computer.** Run the till install again with the door's port and the store
   computer's address on the STAFF wifi (never the guest wifi):

   ```
   pnpm run till:install -- --lane <this till's lane> --device-port 8092 --device-host <e.g. 192.168.10.5>
   ```

   It writes `EDGE_DEVICE_PORT` and `EDGE_DEVICE_HOST` into `till.env` and **makes the store computer's own lock for
   the door** (OB-422 · ADR-0030): a signing authority that belongs to THIS computer and the door's certificate, in
   `till/edge-data-device-tls/`. It prints:

   ```
   handheld door: this store computer made its own signing authority (fingerprint AB:12:…, until …)
     The authority each handheld trusts (public — safe to copy): …/edge-data-device-tls/authority.crt
     Its fingerprint (check it on the handheld when you install it): AB:12:…
   ```

   **Write the fingerprint down** (or photograph that line) — you compare it on each handheld in step 4. Then restart
   the till (Step 2). Its window says `device socket on https://<address>:8092/ — reachable on the shop network` and
   `locked (OB-422): https only, plain http refused`. Leave `--device-host` out and the door opens on the computer itself
   only — useful for a rehearsal, useless for a phone. The address must be a private shop address (10.x, 172.16–31.x or
   192.168.x); any other is refused, and the till still sells.
   **The lock folder `edge-data-device-tls` never leaves this computer.** Never copy it, e-mail it, or put it on a USB
   stick; the backup leaves it out on purpose (its private key must never leave the box). Only the one file
   `authority.crt` inside it is public. If the folder is ever lost (a new PC, a dead disk), the computer makes a new lock
   at its next start and **every handheld must be set up again** (steps 4–4a).
2. **Register the device at head office** (the fleet register, `POST /v1/platform/devices/<deviceId>/register`,
   kind `handheld` or `mobile`) — the same step every till goes through. The store setup the box pulls from head office carries
   the store's phones (`devices`) from the fleet register — with a code's fingerprint and expiry only, never the code —
   so nothing is copied by hand (PA-06 3b, 10 Oct 2026).
3. **Issue the code** — `POST /v1/platform/devices/<deviceId>/enrolment` by a person holding
   `platform.device.manage`. The answer holds the code ONCE (twenty letters and digits in four groups); head office
   keeps only its fingerprint and the expiry (a day by default). The box has it after its next pull of the store setup.
4. **On the handheld, trust the store computer once (OB-422 · OB-424).** On the **store computer itself**, open
   **http://127.0.0.1:8091/handheld-seal/** (the store PC's own screen — signed in with your office PIN if the
   office PIN is on). The **Handheld seal · கைக்கருவி முத்திரை** page shows three things: a **QR code**, the **code to
   compare** (`AB:12:CD:34 … 9F:00:11:22` — the start and end of the fingerprint) and **Download authority.crt**. This page
   is only on the store PC's own screen; a phone on the wifi cannot open it, and the handheld door does not serve it.
   - **By QR (the way the owner chose, OB-424):** scan the QR code with a QR app on the handheld that saves what it reads
     as a file named `authority.crt`. The QR holds the whole certificate — no wifi is needed. (Android's own camera only
     shows it as text; that is not enough to install it.)
   - **By cable (the fallback):** press **Download authority.crt** on the store PC and copy that one file to the handheld
     by its USB cable or the shop's own file share.

   Then on Android: **Settings → Security → Encryption & credentials → Install a certificate → CA certificate**, choose
   `authority.crt`, open the installed certificate's details and check its **SHA-256 fingerprint starts and ends with the
   code on the store PC's screen** (it is also the one you wrote down in step 1). **If it differs, stop — remove it —**
   and tell the manager. If the page says there is no seal (no handheld door on this computer, or the door is shut), do
   not set up a handheld: run the doctor (`pnpm run store-computer -- doctor`) and fix what it says; the tills keep selling.
   Never press "proceed anyway" on a certificate warning in the browser: a handheld that trusts the
   store computer never sees one. Then, in the handheld's browser, open `https://<address>:8092/` (**https**, not http —
   plain http is refused: the page says *"It speaks https only (OB-422)"*). It shows **Enrol this handheld**: type the
   device id and the code, press Enrol. A wrong code says so and counts (five wrong per device per fifteen minutes,
   then a wait); an expired code says so — issue a new one; a code already used says so — it never works twice.
   On success the phone asks **who is holding it** (next step).
4a. **The person signs in on the phone (OB-30 "A", DF-3-c).** Each person keys their **staff ID** and the **same six-digit
   PIN as the till** — so everyone who uses a phone needs a till PIN issued on the store computer first
   (`till/start-till.sh till-pin --user <their id> --by <administrator>`, typed by the person themselves, never shown, kept nowhere), and a role in the
   store setup that gives them the job: warehouse `inventory.movement.append`, picking `fulfilment.pack.record`, delivery
   `delivery.attempt.record`. The screen then opens as THAT person and everything they do is recorded as them. The bar
   at the top says **Signed in: <name>** with a **Sign out** button, and under it how long the sign-in has left
   (*Sign-in ends in 3 h 12 min · உள்நுழைவு முடிய 3 மணி 12 நிமிடம்*).
   **Handing the phone over (OB-184 "A", owner, 17 Oct 2026): ALWAYS press Sign out · வெளியேறு before you hand the
   phone to anyone, or put it down at the end of your work.** Then the next person signs in with their own staff ID and
   PIN. Never work on a phone that shows somebody else's name — sign them out and sign in as yourself. (If the next
   person signs in without the first signing out, that still signs the first person out.)
   **Signing out needs the store computer.** Sign out is a message to the store computer, so it only works while the
   phone is on the shop wifi. **With the wifi down, a phone cannot be signed out — so never hand a signed-in phone to
   anyone while the wifi is down.** Keep it with you until the wifi is back and sign out then; if you cannot, the phone
   locks itself at the end of your sign-in (below), even offline, and nobody can carry on as you after that.
   **How long a phone sign-in lasts:** on the **warehouse** and **picker** screens, **four hours** (OB-184); on the
   **delivery driver's** screen, **twelve hours** — the whole shift, like a till — because the driver is away from the
   shop wifi for the route and can only sign in again at the shop (OB-187 "A", owner, 17 Oct 2026, "Driver gets 12
   hours"). A driver signs in at the shop before the route; a route longer than twelve hours needs the driver to sign
   in again at the shop first. **At the end of its sign-in the phone goes to the sign-in page by itself (OB-186 "A",
   owner, 17 Oct 2026, "Lock the screen")** — even with the wifi down — and says *Your sign-in has ended (4 hours). Sign
   in again — your saved work is kept · உங்கள் உள்நுழைவு முடிந்தது* (the driver's says *12 hours* and *Sign in again at
   the shop*). **Do not change a phone's date or time.** If the phone's clock is turned back, the phone ends the sign-in
   at once and says *This phone's clock was turned back, so your sign-in has ended* — sign in again (and tell the manager
   if nobody knows why the clock changed).
   Nobody can keep scanning on an ended sign-in. Sign in again with your staff ID and PIN (signing in needs the store
   computer, so if the wifi is down, wait for it to come back). Everything scanned before the end is still
   saved on the phone — nothing is lost — and is handed to the store computer, still recorded as the person who did it,
   once somebody signs in; do not scan those items again. Work done BEFORE the end that is still waiting on the phone
   stays the person's and is still taken for twelve hours after the sign-in it was made under ended (OB-185) — even if
   the same person has signed in again since; later than that it is refused with the reason on the phone (*more than 12
   hours later (OB-185)*), never silently lost. A wrong PIN counts toward the same lock as the till; a leaver (role
   removed, or PIN withdrawn) cannot sign in, and a phone signed in as them stops sending at once.
   *To check in the store:* sign in on a warehouse phone and see the bar say about four hours; on the driver's phone,
   about twelve. Press Sign out — the phone goes back to the sign-in page and nobody's name is shown. Switch the shop
   wifi off and press Sign out on a signed-in phone: it cannot sign out (that is why nobody hands a signed-in phone over
   offline). Leave a phone signed in for four hours (or scan one item, then switch the shop wifi off and wait): at four
   hours the screen changes to the sign-in page by itself with the red "sign-in has ended" message; sign in again and
   check the item appears under **"Sent from this handheld"** as sent. On a spare phone, scan one item and then turn the
   phone's clock back an hour in its settings: the screen goes to the sign-in page saying the clock was turned back.
5. **Check it took:** the boot log line `handheld <deviceId> (warehouse) handed over N record(s)` appears after the
   first scan; on the handheld the list **"Sent from this handheld"** shows each scan and where it is —
   *saved on this handheld* → *with the store computer* → *posted at head office* (or *refused*, with the reason).
   Closing the browser or restarting the phone loses nothing: the list is the same when it reopens.
6. **A lost or leaving handheld:** at head office set its status to `blocked` (or `retired`); the next pack pull
   refuses it at its next request and sends it to the enrolment page. A new code for the same device supersedes the
   old one.

### Step 6b — A handheld used as a queue till (D04-FR-05 · ADR-0028 · owner decisions OB-372 to OB-377)

A queue till is a handheld enrolled exactly as in Step 6 (it trusts the store computer once, step 4), then opened at
`https://<address>:8092/queue-pos/`.

1. **Enrol it to the PC of the till it serves (OB-377).** Each till PC is its own store computer (ADR-0004). A handheld
   hands its baskets to, and keeps its bills on, the ONE PC it is enrolled to. Use the enrolment page of the till PC whose
   till(s) will ring its hand-overs and print its bills. A till on another PC cannot bring the basket up (it says "no
   such basket") and cannot print the bill (it says the bill is on another store computer).
2. **Give its lane a bill-number prefix (OB-376).** At head office, on the store setup page under *Till bill-number
   prefixes*, the handheld is listed as `device:<deviceId>`. Issue it its own prefix (for example `S1Q1-`) exactly as for a
   till. Until then each bill it takes is numbered under its store computer's own `ZZ…` prefix and flagged.
3. **No cash, no printer (OB-372 · OB-373).** It takes card or UPI only (when `payments.mobile_pos` is on). Its paid
   screen says *"Ask at a till or the service desk to print this bill: bill number …"*. At a till on the SAME PC:
   **More → Print a copy of a bill by its number**, type the number, choose why. The copy prints marked as a copy
   (DUPLICATE), is recorded on the store computer first, and reaches head office (`GET /v1/bill-copies`). A service desk
   prints it the same way from a till on that PC.

> **The shop-network leg is encrypted (OB-422 · ADR-0030).** The handheld door speaks https only, under the store
> computer's own authority, which each handheld trusted once in Step 6 step 4; plain http on the shop network is
> refused. Keep the handhelds on a **staff-only WPA2/WPA3 wifi, separate from any guest wifi** (OA-16) as well — defence
> in depth. The till's and manager's screens are not on this door at all; they stay on the PC's own loopback.
>
> **The handheld door's lock renews itself.** Its certificate lasts 90 days and the store computer renews it, by
> itself, in its last 30 days — the handhelds keep working with nothing done to them, because they trust the authority,
> not the certificate. Its window says `certificate renewed … signed by the same authority, so enrolled handhelds keep
> working`. The authority lasts ten years; a year before its end the window and the doctor warn, and a new one is made
> on purpose, with every handheld set up again. The store computer **never** replaces a broken lock by itself: if its
> window says `handheld door NOT opened: … It was kept, not repaired`, the handhelds keep their work on the phone, the
> till keeps selling, and you send a photo of that window (never of the folder).
>
> *To check in the store:* on a phone that has NOT trusted the store computer, open `https://<address>:8092/` — the
> browser refuses it (a certificate error); press nothing. Open `http://<address>:8092/` — the page says it speaks
> https only. On an enrolled handheld, open `https://<address>:8092/` — no warning, the padlock shows, the screen opens.
> On the store computer, run `pnpm run store-computer -- doctor`: the **Handheld door** line says OK with the date the
> certificate runs to.

---

## Stopping and starting

- **The till:** Ctrl-C in its window (or close it) to stop; run the start script again to start.
  Nothing is lost by stopping — a sale not yet sent stays in the queue on disk.
- **The containers (if on this PC):** `docker compose stop` / `docker compose start` (keeps all data).

## Backing up

Even in a pilot, take a backup before anything you care about — `till/edge-data/` is the till's
disk; see `backup-and-recovery.md`.

**Back up `till/edge-data/` only — never `till/edge-witness/`.** The witness folder sits beside the
data folder on purpose (owner decision OB-87 "A"). Every bill number the till gives is written in
both places. If `edge-data/` is ever restored from an older backup, the witness still holds the
numbers given after that backup, and the till sees the difference by itself — nobody has to
remember to tell it.

### Restoring a till from a backup

1. Stop the till. Copy the backup over `till/edge-data/`. **Leave `till/edge-witness/` as it is**
   (on a new computer there is none — that is fine).
2. Start the till. It compares its data with the witness and, if the data is older than the
   numbers it gave (or there is no witness for it), it says so in its window:
   `this store computer's data looks restored from a backup … it numbers bills under a brand-new
   prefix until head office's latest setup arrives.`
3. **Keep selling.** Until head office answers, bills print under a brand-new temporary prefix
   that starts `ZZ` and has never been used — so no customer's bill number is ever given twice,
   even with no internet. Numbers the till gave after the backup are kept as "issued, not used"
   on its status read, never given again.
4. As soon as the till reaches head office, it takes head office's latest setup and goes back to
   its own prefix, **above** the last bill head office holds. Ring one test bill and check the
   printed number starts with the till's own prefix and is higher than the last bill you know of.
5. At head office, the `ZZ…` bills show as "numbered without an issued prefix" findings — expected
   after a restore. If any bill number did reach head office twice (for example, a restore onto a
   new computer whose old one had unsent bills), head office lists it as a **receipt number reused**
   finding and on the idempotency-conflicts register (`GET /v1/idempotency-conflicts`) — it is
   never silently dropped.
6. About an hour after the restore, open head office's health page. If the till gave bills after
   the backup and never sent them, `box_bill_numbers:<store>` names them: **"bills issued but never
   received: …"** with the prefix and the numbers. Those sales are lost from head office's books —
   find the paper bills and enter them, or write them off with the reason.
   **Since r20 this is said only when the till has said it no longer holds those bills to send:**
   while the till still has bills waiting (its status badge shows a number waiting to send, and
   head office's `box_queue:<store>` says so), head office raises nothing for them, however long the
   catch-up takes after an outage. **Never re-enter paper bills while the till still shows bills
   waiting to send** — wait until it says nothing is waiting, then look again.

### The witness check at every start (verifier r19)

The till checks its witness folder each time it starts and says what it found:

- Nothing said — the witness is kept. This is normal.
- `!!! BILL-NUMBER WITNESS UNAVAILABLE: …` — the witness folder could not be opened, or it is
  **inside** `edge-data/`. The till still sells and never repeats a bill number, but every restart
  will start a new `ZZ…` prefix until it is fixed. Make sure `till/edge-witness/` exists, is
  writable by the account that runs the till, and is **beside** `edge-data/`, not inside it
  (`EDGE_WITNESS_DIR` in the start script). Head office's health page shows the same warning.
- `… also holds the witness of 1 other store computer(s) …` — two tills point at the same witness
  folder. Give each till its own `edge-witness/` folder. (Each till keeps its own file there, so
  this no longer looks like a restore on every start — but one folder per till is the rule.)
- **In the container set-up** (`infra/compose`), the witness is its own volume, `edge-witness`,
  mounted at `/var/lib/sre-edge-witness` with `EDGE_WITNESS_DIR` set — never inside the
  `edge-data` volume. Back up `edge-data` only.

### One `ZZ…` bill after the witness release (expected, once)

The release that brings the witness volume (r19/r20) meets a store computer that already has
bill-number history but a brand-new, empty witness. On that **first start** the till cannot tell an
ordinary start from a restore, so it numbers under a brand-new `ZZ…` prefix — **only until head
office answers** (a few seconds online), then goes back to its own prefix, above the last bill head
office holds. The same happens **once after a rollback and roll-forward**: a release before the
witness runs without it (a `ZZ…` prefix on each start, as before), and the next start on the
witness release finds a witness written by another run of the box and treats it once as a possible
restore. Both are harmless: no bill number is ever given twice. What to check: ring one test bill
after the update — it may start `ZZ` the very first time; the next must carry the till's own
prefix. Head office lists the `ZZ…` bill as "numbered without an issued prefix" — expected here.

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
- **The seal by QR on a real handheld** — the store PC's own *Handheld seal* page shows the certificate as a QR code, its
  code to compare and a download (OB-424, Step 6 step 4). A stock Android camera reads the QR only as text: installing it
  needs a QR app that saves it as `authority.crt`, or the cable copy. Neither has yet been tried on the shop's own
  handheld model. The door itself has spoken https only since OB-422 (27 Oct 2026).
- **A Windows service** — on Windows the till runs in a window you leave open (or a Task Scheduler
  entry you create for `start-till.cmd`); the Linux start-at-login unit is provided.

**Related:** `pilot-deployment.md` (the all-container quick stand-up) · `store-go-live-checklist.md`
(the in-store human sign-offs) · `pilot-run-sheet.md` (the day-by-day plan) · `backup-and-recovery.md`.
