# Store computer as Windows services (ADR-0032 · CR-01 step 1)

_For the administrator and for CI. The owner will not type any of this: from CR-01 step 2 the setup program runs it._

The shop database, the office API and the till run as three Windows services on the store PC — no Docker. Windows starts
them at boot, restarts them if they stop, and each runs under its own account that nobody can sign in as.

| Service | What it is | Account | Listens on | Depends on |
| --- | --- | --- | --- | --- |
| `SRE-Database` | PostgreSQL 16, data in `<data folder>\database` | `NT SERVICE\SRE-Database` | 127.0.0.1:5432 | nothing |
| `SRE-API` | the office API (runs the database migrations at each start) | `NT SERVICE\SRE-API` | 127.0.0.1:8081 | `SRE-Database` |
| `SRE-Till` | the till's store edge: screens and save socket | `NT SERVICE\SRE-Till` | 127.0.0.1:8091 and :8090 | nothing (P-01) |

## Install (once, as an administrator, on Windows 10 or 11)

The copy must be prepared and the till installed in the data folder first:

```powershell
pnpm run store-computer -- prepare
pnpm run till:install -- --settings C:\SRE-data\.env.real --lane lane-1
pnpm run store-computer -- install-services --pg-bin <folder>\pgsql\bin --service-host <folder>\WinSW-x64.exe
```

`--pg-bin` is the `bin` folder of the PostgreSQL 16 Windows binaries; `--service-host` is WinSW 2.12 (`WinSW-x64.exe`).
Running it again is safe: an existing database is kept, nothing is installed twice.

It refuses, changing nothing, when: the computer is not Windows, or is a Windows Server (OB-282); the copy has no settings
or keeps them inside the release folder; the till is not installed; a port is taken; the folder for the database holds
files that are not a database; or this shop still runs in Docker (moving it across with its data is CR-01 step 2).

## Check

```powershell
pnpm run store-computer -- services-status
```

One line per service (running, starts by itself, its account) and whether the API says ready. Exit 0 when all is well.
Each service's own words are in `<data folder>\logs\<service>`; the database's are in Windows' Event Viewer → Application.

## Remove

```powershell
pnpm run store-computer -- remove-services
```

Stops and removes the three services, the till first. The database folder, the settings file, the till's data and every
log are kept untouched.

## The setup program (CR-01 step 2a)

`SRE-Setup.exe` does all of the above in one run, with nothing typed. It is built by the `store-pc-setup` CI job
(`scripts/build-store-pc-release.mjs` makes the release folder, `infra/windows/sre-setup.iss` makes the setup program) and
kept as that run's artifact. It brings its own Node, PostgreSQL 16 programs and service host, so nothing is downloaded on
the shop's PC. It installs to `C:\Program Files\SRE Retail OS`, then runs `store-computer setup`:

1. this PC's settings: made once with a new tenant id, or kept exactly when the PC already has them;
2. the till, in the data folder (kept when already there);
3. the three Windows services.

Its words are kept in `C:\ProgramData\SRE\setup.log`. Running it again replaces nothing. Uninstalling (Windows Settings →
Apps → SRE Retail OS → Uninstall) removes the program and the three services; the data folder is never touched.

For a technician or a test, silently: `SRE-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DATADRIVE=D:`. Its exit
code is 0 only when the setup said SETUP DONE.

 

## The first-run screens (CR-01 step 2b)

When a person runs `SRE-Setup.exe`, the first-run screens open in the browser once the files are copied (served on this
PC only, at `http://127.0.0.1:8099/setup/`, and only to the page the setup program opened — it carries a one-time key).
On a new PC they ask, in English or Tamil:

1. the disk for the shop's data — only disks inside the PC that are not the one Windows is on (OB-716);
2. the shop's name, legal name (as on the GST certificate), GSTIN (its check character is checked) and short code;
3. the owner's name and own six-digit PIN (staff ID `owner-01`);
4. the accountant's name and own PIN (staff ID `accountant-01`) — a second person (OB-715, OB-659).

Then, with every step shown as it happens: this PC is set up, the two people are recorded, each one's PIN is set (only a
fingerprint is kept), and the shop is prepared by the owner and approved by the accountant. On a PC already set up the
screens say so and keep everything. The screens' server stops by itself ten minutes after the setup has run. By hand:
`pnpm run store-computer -- setup-screens`.

## Moving a shop that runs in Docker (CR-01 step 2c, OI-08)

On a PC set up with Docker (the owner's own store PC, November 2026), `SRE-Setup.exe` (or `store-computer setup`) moves the
shop onto the Windows services, keeping every record, setting and person. Docker Desktop must be running for this one time.

1. The till started at sign-in, then the office (API container), are stopped: nothing writes to the database any more.
2. One snapshot of the database is taken and counted — the hourly backup's own method.
3. The Docker copy is **stopped, never removed**: its storage `sre-real_db-data` stays on the PC as the way back.
4. The three services are installed; before the office starts, the snapshot is restored into the new database and counted
   again: every table's rows, the money in every kind of event, the newest event's number.
5. Only on an exact match: the move is recorded (`run\services\adopted-from-docker.json`), the old sign-in task is removed
   and the plain snapshot deleted. The settings file, the tenant id, the till's data and its PINs are kept as they are.

If anything does not match: the services are removed, the new database folder is moved aside (`database-unfinished-…`,
kept), the Docker copy is started again and the snapshot is kept for a person to look at. Restart the computer to bring
the till back.

After the move the tool reaches the database as a service: `backup` (same one-snapshot guarantee), `restore-check`,
`check` (G4), `status`, `up` and `autostart` work without Docker, and so does the rollback drill (below). `update --from
<folder>` is not used on Windows services: a new version comes from the Software update page (below). Docker Desktop can be uninstalled later; its stopped
copy is the only thing it still holds.

## Desktop shortcuts and the About screen (CR-01 step 2d)

The first-run screens' last page offers three desktop shortcuts once the setup has finished well: **SRE Till** (the till,
`http://127.0.0.1:8091/pos/`), **SRE Office** (the office pages, `/manager/`) and **SRE Import & export** (the import page,
through the data folder's launcher). By hand: `pnpm run store-computer -- shortcuts [--only till,office,import]`.

The **About** screen, `http://127.0.0.1:8091/about/` (this PC only, no sign-in, names only), shows the shop's tenant id
(made by the setup program, never typed), the store, this till and the release.

The owner's step-by-step for his store PC: `docs/runbooks/store-pc-move-checklist.md`.

## One-click update (CR-01 step 3d, OI-05)

**Who:** the owner only, with his own PIN (OB-719), when every till shift is closed (OB-718).

1. Close every till (end every shift).
2. Open **SRE Office** → About → **Software update** (`http://127.0.0.1:8091/update/`), sign in with your own PIN.
3. If it says **A new version is ready**, type your PIN again and press **Update**.
4. Within 5 minutes the store computer starts by itself. The page says what it is doing. The till pauses for a few minutes.
5. The page ends with one of:
   - **Updated** — nothing to do.
   - **The update did not work — the old version was put back by itself** — nothing to do now; send a photo of the page.
   - **The update was not started** — it says why (for example a till was open); nothing was changed.
   - **THE UPDATE FAILED AND THE OLD VERSION COULD NOT BE PUT BACK** (red) — call for help now; the page names the backup
     taken first.

What happens, in order (`scripts/lib/store-pc-updater.mjs`): the request is taken and kept; the till is asked whether any
shift is open; the new version is downloaded from GitHub and checked — signed with the shop's release key, verifying with
this PC's own copy of the public key, the very file that was signed, newer, and the version the owner was shown; an
encrypted backup goes to the backup drive (no backup drive, no update); the running version is kept whole in
`C:\Program Files\SRE Retail OS kept\<version>`; then a second task, run from that kept copy, runs the new SRE-Setup.exe
silently and checks the result with the new program (`services-status`, the till's screens). On any failure the kept copy
is put back over the program, its own setup is run, and the same checks run again.

**Never touched:** the shop's data. Putting the old version back puts back the program only; the old version runs on the
same database, as the rollback drill proves it can. Nothing the updater writes is ever deleted.

**Where it is written down:** `<data>\updates\update-outcomes.log` (every step, append-only), `<data>\updates\<id>\`
(the request, the plan, the setup program and its own log), `<data>\till\edge-data\update-requests.log` (who asked,
and every refusal), `<data>\status\update-progress.json` (what the page shows).

**The two tasks:** `SRE\Software update` (SYSTEM, every 5 minutes, does nothing without a request) is set up by
SRE-Setup.exe; `SRE\Software update - install` is made for each update. If the page says *the updater is not set up*,
run SRE-Setup.exe once more as administrator.

## The rollback drill on Windows services (CR-01 step 3e, G9)

**Who:** the store's IT person or the owner, as administrator, with the owner watching (UAT-53). **When:** a quiet time,
every till closed — the till pauses for a few minutes in steps 3 and 4. **Needs:** the backup drive plugged in, the backup
passphrase, and a previous release on the PC (one is kept by itself at every update; before the first update there is
none, and the drill says so).

1. See what it will do (changes nothing): `store-computer drill --by "Your Name" --to E:\sre-real`
2. Run it: the same command with `--run` at the end. Type the backup passphrase when asked.
3. It backs up and restores into a scratch database and reconciles (you see each time), then says **STARTED** — steps 3
   and 4 run by themselves.
4. After 10–15 minutes: `store-computer drill-result`. It says **G9 PASSED** or **G9 NOT PASSED**, each step with its time
   against its target (database back within 4 hours, service back within 30 minutes).
5. Keep the record with the workbook: `<data>\records\g9-drill-<time>.json` (a read-only copy is on the backup drive).
6. **QG-08 evidence.** When every step worked, the drill also writes `<data>\records\qg08-rollback-<time>.json`, and
   `drill-result` names it: the body of `POST /v1/platform/dr-drills` for the **rollback** rehearsal (data loss 0, the
   rollback's own time). The custodian records it on head office's register in his own sign-in; head office scores it
   against the fixed 30 minutes, so a slow drill is recorded as a miss, never a pass. A drill where a step failed writes
   no such file: record the miss in words, and QG-08 stays HOLD.

If it says **THIS PC MAY NOT BE ON <version> NOW**, restart the PC; if the till does not come back, run that version's
SRE-Setup.exe again, and send a photo. The database is never rolled back by the drill: only the program is put back.

## A new backup passphrase, when the old one is lost (OB-733)

**Why:** every backup is locked; the passphrase is the key, and it is kept nowhere — not on the PC, not with us. If the
paper is lost, nobody can recover it. This step makes a **new** key with a **new** passphrase, so the backups from now on
can be opened again. **Nothing is deleted:** the old key is kept on the PC under a "retired" name, and every old backup
keeps its own key copy on the backup drive — so if the old paper is ever found, the old backups still open with it.

**Who:** the owner, at the store PC's own keyboard (never by remote, never in a chat). **Needs:** the backup drive plugged
in, a pen and a sheet of paper.

1. Open PowerShell **as administrator** and type: `store-computer new-backup-passphrase --by "Your Name"`
2. It explains what will happen, then asks you to type **REPLACE** (nothing shows as you type) and press Enter.
3. Choose the new passphrase — a short sentence you will remember, at least the length it says — and type it twice.
   Nothing shows as you type.
4. It says **DONE — new backup key …** and the name the old key is kept under. **Now write the new passphrase on paper
   and lock it away with the BitLocker key.** Never photograph it, never type it into a message.
5. Make one backup and prove it opens with the new passphrase:
   `store-computer backup --to E:\sre-real`, then `store-computer restore-check --from E:\sre-real\<the new manifest>`
   (type the NEW passphrase). It must say `restored_and_reconciled`.
6. **Send:** a photo of the window after step 5 (it never shows a passphrase).

If you mistype the new passphrase three times, it stops and **puts the old key back exactly as it was** — nothing
changed. Every change is written to `<data>\backup\backup-key-changes.log` (who, when, old key, new key — never a
passphrase). The automatic hourly backup picks up the new key by itself.

